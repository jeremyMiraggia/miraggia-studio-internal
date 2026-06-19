'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import Dropzone from '@/components/ui/Dropzone'
import { compressAll, compressImage } from '@/lib/compressImage'
import { parseNotionExport, type GenerationTask, type ParsedExport } from '@/lib/notion/parseExport'
import { dataUrlToBlob } from '@/lib/composite'
import { cropTopPercent } from '@/lib/imageCrop'
import { parseExcelSelection, type ExcelSelection } from '@/lib/excelSelection'
import { VIEW_CATALOG, POSE_CATALOG } from '@/lib/poses'

type TaskStatus = 'pending' | 'running' | 'done' | 'error'

type TaskState = {
  task:    GenerationTask
  status:  TaskStatus
  enabled: boolean
  imageUrl?:          string   // visuel final (= sortie Gemini directe)
  error?: string
  faceUsed?:         boolean
  faceWasAvailable?: boolean
  progressStep?: 'gemini' | 'done'
}

/**
 * Récupère le Blob de l'image quel que soit le format de l'URL :
 *   - data URL (data:image/jpeg;base64,...) → décodage local
 *   - HTTPS URL (Vercel Blob) → fetch direct sur le CDN Blob (= ZERO Fast Origin Transfer)
 */
async function imageUrlToBlob(url: string): Promise<Blob> {
  if (url.startsWith('data:')) return dataUrlToBlob(url)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch image ${url.slice(0, 80)} → HTTP ${res.status}`)
  return await res.blob()
}

/**
 * Devine l'extension de fichier (jpg/webp/png) depuis l'URL :
 *   - data URL → on lit le mime
 *   - HTTPS URL → on lit l'extension de la querystring/path
 */
function extFromUrl(url: string): string {
  if (url.startsWith('data:')) {
    const m = url.match(/^data:image\/(\w+)/)
    return m ? m[1].replace('jpeg', 'jpg') : 'jpg'
  }
  const path = url.split('?')[0]
  const m = path.match(/\.(jpg|jpeg|webp|png)$/i)
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg'
}

/**
 * Parse le champ "Limite looks" en une plage [start, end] (1-indexée, inclusive).
 *   - "10"        → { start: 1,   end: 10  }  (les 10 premiers)
 *   - "100-150"   → { start: 100, end: 150 }  (du 100ème au 150ème inclus)
 *   - ""/"abc"    → null (= tous les looks)
 */
function parseLookRange(input: string): { start: number; end: number } | null {
  const s = (input ?? '').trim()
  if (!s) return null
  const rangeMatch = s.match(/^(\d+)\s*-\s*(\d+)$/)
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10)
    const end   = parseInt(rangeMatch[2], 10)
    if (start > 0 && end >= start) return { start, end }
    return null
  }
  const n = parseInt(s, 10)
  if (!Number.isNaN(n) && n > 0) return { start: 1, end: n }
  return null
}

function sanitizeFilename(s: string): string {
  return s
    .replace(/[\/\\:*?"<>|]/g, '_')   // caractères interdits Windows
    .replace(/\s+/g, '_')                 // espaces -> _
    .replace(/_+/g, '_')                   // _ multiples -> 1 seul
    .replace(/^_|_$/g, '')                 // pas de _ au début/fin
    .slice(0, 80)                          // limite à 80 chars
    || 'unnamed'
}

export default function CompositeTab() {
  const [concurrency, setConcurrency]   = useState<number>(2)
  const [autoZipEnabled, setAutoZipEnabled] = useState<boolean>(false) // 💾 auto-export ZIP tous les N looks
  const [autoZipEvery, setAutoZipEvery]     = useState<number>(10)     // N = 10 looks par ZIP par défaut

  // Refs pour suivre l'auto-export ZIP
  const exportedLookIdsRef    = useRef<Set<string>>(new Set())
  const zipExportInFlightRef  = useRef<boolean>(false)
  const autoZipEnabledRef     = useRef<boolean>(false)
  const autoZipEveryRef       = useRef<number>(10)

  // 📁 Dossier de sortie (File System Access API) — alternative au ZIP : écrit
  // les visuels directement look par look dans un dossier local choisi.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outputDirHandleRef    = useRef<any | null>(null)
  const [outputDirName, setOutputDirName] = useState<string | null>(null)
  const writtenLookIdsRef     = useRef<Set<string>>(new Set())
  const writeInFlightRef      = useRef<Set<string>>(new Set())
  const [lookLimit, setLookLimit] = useState<string>('')

  // Sélection via Excel
  const [excelFile, setExcelFile]               = useState<File[]>([])
  const [excelSelection, setExcelSelection]     = useState<ExcelSelection | null>(null)
  const [excelError, setExcelError]             = useState<string | null>(null)
  const [useExcel, setUseExcel]                 = useState<boolean>(false)
  const [excludePlein, setExcludePlein]         = useState<boolean>(false)

  const [zips, setZips]               = useState<File[]>([])
  // Fond dédié aux close-up haut (1 fichier optionnel) : utilisé à la place
  // du fond plein-pied + crop top 50% (qui contenait le sol et donnait des faux fonds).
  const [closeUpHautBg, setCloseUpHautBg] = useState<File[]>([])
  const [parsing, setParsing]         = useState(false)
  const [parsed, setParsed]           = useState<ParsedExport | null>(null)
  const [states, setStates]           = useState<TaskState[]>([])
  const statesRef                     = useRef<TaskState[]>([])
  const [globalError, setGlobalError] = useState<string | null>(null)

  const [ratio, setRatio]       = useState('9:16')
  const [quality, setQuality]   = useState('2K')
  const [running, setRunning]   = useState(false)
  const [progress, setProgress] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  /* ----------- Parsing zip (réutilise parseNotionExport) ----------- */
  const handleZipChange = async (files: File[]) => {
    setZips(files)
    setGlobalError(null)
    setParsed(null)
    setStates([])
    setExpanded({})

    if (files.length === 0) return

    const sizeGB = files[0].size / (1024 * 1024 * 1024)
    if (sizeGB > 10.0) {
      setGlobalError(`Le ZIP fait ${sizeGB.toFixed(1)} GB — au-delà de la limite pratique (~10 GB). Découpe l'export.`)
      setZips([])
      return
    }
    if (sizeGB > 3.0) {
      const range = parseLookRange(lookLimit)
      const rangeLabel = range
        ? (range.start === 1 ? `aux ${range.end} premiers looks` : `aux looks ${range.start}-${range.end}`)
        : null
      setProgress(
        `ZIP volumineux (${sizeGB.toFixed(1)} GB)` +
        (rangeLabel ? ` — limité ${rangeLabel} ✓` : ' — pense à remplir "Limite looks" pour un premier essai rapide (ex : 3 ou 100-150)'),
      )
    }

    setParsing(true)
    try {
      const range = parseLookRange(lookLimit) ?? undefined
      const result = await parseNotionExport(files[0], (msg) => setProgress(msg), range)
      setParsed(result)
      setStates(result.tasks.map(t => ({ task: t, status: 'pending', enabled: true })))
      setProgress('')
    } catch (e: any) {
      setGlobalError(e?.message ?? 'Impossible de parser le zip.')
    }
    setParsing(false)
  }

  // Ref pour accéder au fond close-up haut depuis le runner async
  const closeUpHautBgRef = useRef<File | null>(null)

  useEffect(() => { statesRef.current = states }, [states])
  useEffect(() => { autoZipEnabledRef.current = autoZipEnabled }, [autoZipEnabled])
  useEffect(() => { autoZipEveryRef.current = autoZipEvery }, [autoZipEvery])
  useEffect(() => { closeUpHautBgRef.current = closeUpHautBg[0] ?? null }, [closeUpHautBg])

  /* ----------- 📁 File System Access : dossier de sortie ----------- */
  const handleChooseOutputDir = async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any
    if (!w || typeof w.showDirectoryPicker !== 'function') {
      alert('API File System non supportée par ton navigateur. Utilise Chrome 86+ ou Edge 86+.')
      return
    }
    try {
      const handle = await w.showDirectoryPicker({ mode: 'readwrite' })
      outputDirHandleRef.current = handle
      setOutputDirName(handle.name as string)
      console.log('[outputDir] dossier choisi :', handle.name)
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.warn('[outputDir] échec :', err)
        alert('Impossible de choisir le dossier : ' + (err?.message ?? err))
      }
    }
  }

  const clearOutputDir = () => {
    outputDirHandleRef.current = null
    setOutputDirName(null)
    writtenLookIdsRef.current = new Set()
  }

  /**
   * Écrit les visuels d'un look dans le dossier choisi.
   * Structure : {lookId}_{numeroLook}/{filename}.jpg
   */
  const writeLookToOutputDir = async (lookId: string) => {
    const dir = outputDirHandleRef.current
    if (!dir) return
    if (writtenLookIdsRef.current.has(lookId)) return
    if (writeInFlightRef.current.has(lookId)) return

    writeInFlightRef.current.add(lookId)
    try {
      const tasks = statesRef.current.filter(s =>
        s.task.lookId === lookId && s.status === 'done' && s.imageUrl,
      )
      if (tasks.length === 0) return

      const folderName = sanitizeFilename(`${tasks[0].task.lookId}_${tasks[0].task.numeroLook}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lookDir: any = await dir.getDirectoryHandle(folderName, { create: true })


      for (const s of tasks) {
        const vueNum     = (s.task.vueIndex ?? 0) + 1
        const orientation = (s.task.pose?.orientation ?? 'front').toString().toLowerCase()
        const framing    = (s.task.framingHint ?? 'plein').toString().toLowerCase()
        const baseName = s.task.taskType === 'detail'
          ? `detail${(s.task.detailIndex ?? 0) + 1}_${sanitizeFilename(s.task.detailName ?? 'unnamed')}`
          : `vue${vueNum}_${orientation}_${framing}`
        const fileName = `${baseName}.${extFromUrl(s.imageUrl!)}`
        const blob = await imageUrlToBlob(s.imageUrl!)
        const fileHandle = await lookDir.getFileHandle(fileName, { create: true })
        const w = await fileHandle.createWritable()
        await w.write(blob)
        await w.close()

        // DEBUG : sauve le fond effectivement donné à Gemini (= override close-up haut si applicable)
        const debugBg: File | undefined = (s.task.framingHint === 'haut' && closeUpHautBgRef.current)
          ? closeUpHautBgRef.current
          : s.task.backgroundFile
        if (debugBg) {
          try {
            const fondExt = (debugBg.type.match(/^image\/(\w+)/) ?? [])[1]?.replace('jpeg', 'jpg') ?? 'jpg'
            const fondName = `_FOND_${baseName}.${fondExt}`
            const fondHandle = await lookDir.getFileHandle(fondName, { create: true })
            const fw = await fondHandle.createWritable()
            await fw.write(debugBg)
            await fw.close()
          } catch (err) { console.warn('[outputDir] failed to write debug fond:', err) }
        }
      }
      writtenLookIdsRef.current.add(lookId)
      console.log(`[outputDir] ✓ écrit look ${folderName} (${tasks.length} fichier(s) × 2 steps)`)
    } catch (err) {
      console.warn(`[outputDir] échec écriture look ${lookId}:`, err)
    } finally {
      writeInFlightRef.current.delete(lookId)
    }
  }

  /**
   * Vérifie si on doit écrire des looks dans le dossier de sortie.
   * Appelé après chaque task done.
   */
  const tryWriteCompletedLooks = async () => {
    if (!outputDirHandleRef.current) return

    const lookIdToTasks = new Map<string, TaskState[]>()
    for (const s of statesRef.current) {
      const arr = lookIdToTasks.get(s.task.lookId) ?? []
      arr.push(s)
      lookIdToTasks.set(s.task.lookId, arr)
    }
    for (const [lookId, tasks] of lookIdToTasks) {
      if (writtenLookIdsRef.current.has(lookId)) continue
      if (writeInFlightRef.current.has(lookId)) continue
      const enabledTasks = tasks.filter(t => t.enabled)
      if (enabledTasks.length === 0) continue
      const allDone = enabledTasks.every(t => t.status === 'done' || t.status === 'error')
      if (allDone) {
        // Fire-and-forget : on n'attend pas pour ne pas bloquer le runner
        void writeLookToOutputDir(lookId)
      }
    }
  }

  /* ----------- Excel upload + parsing ----------- */
  const handleExcelChange = async (files: File[]) => {
    setExcelFile(files)
    setExcelError(null)
    if (files.length === 0) {
      setExcelSelection(null)
      return
    }
    try {
      const sel = await parseExcelSelection(files[0])
      setExcelSelection(sel)
      // Les warnings sont des infos (pas des erreurs)
      // ex : "Onglet ANAIS : 99 look(s) parsé(s)"
    } catch (e: any) {
      setExcelError(e?.message ?? 'Impossible de parser l\'Excel.')
      setExcelSelection(null)
    }
  }

  /* ----------- Apply Excel / excludePlein selection ----------- */
  // Recoche/décoche les tasks en fonction de l'Excel + checkbox "exclure plein pied"
  // Logique :
  //   - useExcel=true → seuls les visuels "non verts" sont cochés
  //   - excludePlein=true → tous les plein pied décochés
  //   - les deux peuvent se combiner
  useEffect(() => {
    if (!useExcel && !excludePlein) return
    if (!parsed) return

    setStates(prev => prev.map(s => {
      let enabled = s.enabled

      if (useExcel && excelSelection) {
        const t = s.task
        // Matching direct par lookId : la colonne A "NUMERO DU LOOK" de l'Excel
        // = ID du CSV Notion = t.lookId. Pas d'index séquentiel pour éviter
        // les décalages si le Notion a un saut.
        const key = String(t.lookId).trim()
        // Normalise "1.0" → "1" au cas où le Notion stocke en float
        const numVal = Number(key)
        const normalizedKey = (!isNaN(numVal) && Number.isInteger(numVal))
          ? String(numVal)
          : key

        if (!excelSelection.looksFound.has(normalizedKey)) {
          // Look pas listé dans l'Excel → skip (non demandé)
          enabled = false
        } else {
          const regenVues = excelSelection.toRegenerate.get(normalizedKey)
          if (t.taskType === 'pose') {
            enabled = regenVues ? regenVues.has(t.vueIndex ?? 0) : false
          } else if (t.taskType === 'detail') {
            // Détail : colonne F de l'Excel. Vert = skip, sinon = regen.
            enabled = excelSelection.detailsToRegenerate.has(normalizedKey)
          }
        }
      }

      if (excludePlein && s.task.framingHint === 'plein') {
        enabled = false
      }

      return { ...s, enabled }
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useExcel, excludePlein, excelSelection, parsed])

  /* ----------- Grouping par look ----------- */
  const groupedLooks = useMemo(() => {
    const map = new Map<string, TaskState[]>()
    const order: string[] = []
    for (const s of states) {
      const key = s.task.lookId
      if (!map.has(key)) { map.set(key, []); order.push(key) }
      map.get(key)!.push(s)
    }
    return order.map(lookId => ({ lookId, tasks: map.get(lookId)! }))
  }, [states])

  const enabledCount = states.filter(s => s.enabled).length

  const toggleTask = (id: string) =>
    setStates(prev => prev.map(s => s.task.id === id ? { ...s, enabled: !s.enabled } : s))
  const toggleLook = (lookId: string, value: boolean) =>
    setStates(prev => prev.map(s => s.task.lookId === lookId ? { ...s, enabled: value } : s))
  const toggleAllStates = (value: boolean) =>
    setStates(prev => prev.map(s => ({ ...s, enabled: value })))

  // Sélection rapide : ne coche QUE les close-up haut/bas + les détails
  const selectCloseUpAndDetails = () =>
    setStates(prev => prev.map(s => ({
      ...s,
      enabled: s.task.framingHint === 'haut' || s.task.framingHint === 'bas' || s.task.taskType === 'detail',
    })))

  const setLookExpansion = (lookId: string, open: boolean) =>
    setExpanded(prev => ({ ...prev, [lookId]: open }))

  /* ----------- Runner ----------- */
  const handleRunAll = async () => {
    if (!parsed) return
    setGlobalError(null)
    setRunning(true)

    // Reset des refs auto-zip + écriture dossier pour ce batch
    exportedLookIdsRef.current = new Set()
    zipExportInFlightRef.current = false
    writtenLookIdsRef.current = new Set()
    writeInFlightRef.current = new Set()

    const queue = states.filter(s => s.enabled)
    let done = 0
    let errors = 0
    const total = queue.length

    const processOne = async (item: TaskState): Promise<void> => {
      setLookExpansion(item.task.lookId, true)
      updateState(item.task.id, {
        status: 'running',
        error: undefined,
        imageUrl: undefined,
        progressStep: 'gemini',
      })

      try {
        // ===== BRANCHE DÉTAIL : appel Gemini direct avec base + fichier détail =====
        if (item.task.taskType === 'detail') {
          // Attend qu'une pose du même look soit done (max 3 min)
          setProgress(`Détail · attente d'une pose base du look ${item.task.numeroLook}…`)
          const waitStart = Date.now()
          let baseState: TaskState | undefined
          while (Date.now() - waitStart < 180_000) {
            baseState = statesRef.current.find(s =>
              s.task.lookId === item.task.lookId &&
              s.task.taskType === 'pose' &&
              s.status === 'done' &&
              !!s.imageUrl,
            )
            if (baseState) break
            const anyOther = statesRef.current.some(s =>
              s.task.lookId === item.task.lookId &&
              s.task.taskType === 'pose' &&
              (s.status === 'running' || s.status === 'pending'),
            )
            if (!anyOther) break
            await new Promise(r => setTimeout(r, 2000))
          }

          if (!baseState?.imageUrl || !item.task.detailFile || !item.task.promptWithBase) {
            updateState(item.task.id, { status: 'error', error: 'Pas de pose base disponible pour ce détail (aucune pose du même look n\'a réussi).' })
            errors++
            return
          }

          setProgress(`Détail · look ${item.task.numeroLook} · ${done + errors}/${total}`)
          const baseBlob = await imageUrlToBlob(baseState.imageUrl)
          const baseFile = new File([baseBlob], `base_look_${item.task.lookId}.png`, { type: 'image/png' })
          const baseCompressed   = await compressImage(baseFile,             { maxSide: 2048, quality: 0.92 })
          const detailCompressed = await compressImage(item.task.detailFile, { maxSide: 2048, quality: 0.92 })

          const fdDetail = new FormData()
          fdDetail.append('prompt',  item.task.promptWithBase)
          fdDetail.append('ratio',   ratio)
          fdDetail.append('quality', quality)
          fdDetail.append('refs',    baseCompressed)
          fdDetail.append('refs',    detailCompressed)

          const resDetail = await fetch('/api/studio/free', { method: 'POST', body: fdDetail })
          const dataDetail: any = await resDetail.json().catch(() => null)
          if (!resDetail.ok || !dataDetail?.imageUrl) {
            const msg = (dataDetail && (dataDetail.error || dataDetail.message)) || `Gemini HTTP ${resDetail.status}`
            updateState(item.task.id, { status: 'error', error: truncate(msg) })
            errors++
            return
          }

          // Détail : pas de pipeline composite. Le résultat Gemini est directement final.
          updateState(item.task.id, {
            imageUrl:       dataDetail.imageUrl,
            status:         'done',
            progressStep:   'done',
          })
          done++
          // Auto-écriture dossier + auto-zip
          void tryWriteCompletedLooks()
          void tryAutoZipExport()
          return
        }

        // ===== Génération unique Gemini (pipeline simplifié) =====
        if (!item.task.bodyPhotoFile || !item.task.backgroundFile) {
          updateState(item.task.id, { status: 'error', error: 'Pas de bodyPhotoFile ou backgroundFile.' })
          errors++
          return
        }

        const body  = await compressImage(item.task.bodyPhotoFile,  { maxSide: 2048, quality: 0.90 })
        const prods = await compressAll(item.task.productFiles ?? [], { maxSide: 2048, quality: 0.85 })

        const taskFraming = item.task.framingHint ?? 'plein'

        // Pour close-up haut :
        //   1) si l'utilisateur a fourni un fond dédié close-up haut → on l'utilise tel quel
        //      (fond pensé pour cadrage buste, sans sol parasite)
        //   2) sinon fallback : on crop le fond plein-pied aux 50% du HAUT
        //      → Gemini ne voit pas le sol → pas de risque qu'il en génère un.
        let bgSource: File = item.task.backgroundFile
        if (taskFraming === 'haut') {
          if (closeUpHautBgRef.current) {
            bgSource = closeUpHautBgRef.current
          } else {
            try {
              bgSource = await cropTopPercent(item.task.backgroundFile, 50)
            } catch (err) {
              console.warn('[runner] cropTopPercent(50) failed, fallback fond entier:', err)
            }
          }
        }
        // Background ref en haute résolution (3500 px max) pour max de détails à Gemini.
        const bg = await compressImage(bgSource, { maxSide: 3500, quality: 0.88 })

        const fd = new FormData()
        fd.append('prompt',  item.task.prompt)
        fd.append('ratio',   ratio)
        fd.append('quality', quality)
        fd.append('mannequinBody', body)
        fd.append('background',    bg)
        for (const p of prods) fd.append('products', p)
        if (item.task.facePhotoFile) {
          const face = await compressImage(item.task.facePhotoFile, { maxSide: 2048, quality: 0.92 })
          fd.append('mannequinFace', face)
        }
        fd.append('framing',        taskFraming)
        fd.append('mannequinLabel', item.task.mannequinName)
        // Si on a remplacé le fond plein-pied par le fond close-up dédié,
        // on aligne aussi le label pour éviter le mismatch "label parle de X, image montre Y"
        const effectiveDecorLabel = (taskFraming === 'haut' && closeUpHautBgRef.current)
          ? `${item.task.fondName} (fond close-up haut dédié)`
          : item.task.fondName
        fd.append('decorLabel',     effectiveDecorLabel)

        setProgress(`Gemini · look ${item.task.numeroLook} · ${done + errors}/${total}`)
        const res = await fetch('/api/studio/free', { method: 'POST', body: fd })
        const data: any = await res.json().catch(() => null)
        if (!res.ok || !data?.imageUrl) {
          const msg = (data && (data.error || data.message)) || `Gemini HTTP ${res.status}`
          updateState(item.task.id, { status: 'error', error: truncate(msg) })
          errors++
          return
        }

        // Log diagnostic Blob : si blobError présent, on est en fallback data URL → on saura pourquoi
        if (data.blobError) {
          console.warn('[blob] Server fell back to data URL. Reason: ' + data.blobError)
        } else if (typeof data.imageUrl === 'string' && data.imageUrl.startsWith('https://')) {
          // 1ère fois seulement (= 1 confirmation visible)
          if (!(window as any).__blobOk) {
            (window as any).__blobOk = true
            console.log('[blob] ✓ Blob storage actif (URL HTTPS). Fast Origin Transfer minimisé.')
          }
        }

        // 1 appel Gemini → c'est le visuel final, point.
        updateState(item.task.id, {
          imageUrl:         data.imageUrl,
          status:           'done',
          progressStep:     'done',
          faceUsed:         typeof data.faceUsed === 'boolean' ? data.faceUsed : undefined,
          faceWasAvailable: typeof data.faceWasAvailable === 'boolean' ? data.faceWasAvailable : undefined,
        })
        done++
        // Auto-écriture dossier + auto-zip
        void tryWriteCompletedLooks()
        void tryAutoZipExport()
      } catch (e: any) {
        updateState(item.task.id, { status: 'error', error: truncate(e?.message ?? 'Erreur') })
        errors++
      } finally {
        const finished = done + errors
        setProgress(`${finished}/${total} composites traités · ${done} ok · ${errors} erreur(s)`)
      }
    }

    let nextIdx = 0
    const worker = async () => {
      while (true) {
        const i = nextIdx++
        if (i >= queue.length) return
        await processOne(queue[i])
      }
    }
    const workerCount = Math.max(1, Math.min(concurrency, queue.length))
    setProgress(`Lancement de ${workerCount} workers en parallèle…`)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))

    // Force flush : écrit les derniers looks dans le dossier
    if (outputDirHandleRef.current) {
      setProgress(`Écriture finale dans le dossier…`)
      await tryWriteCompletedLooks()
      // Attend que les writes en cours se terminent
      while (writeInFlightRef.current.size > 0) {
        await new Promise(r => setTimeout(r, 200))
      }
    }
    // Force flush du dernier batch ZIP (les < N looks restants qui n'ont pas
    // atteint le seuil de l'auto-zip)
    if (autoZipEnabledRef.current) {
      setProgress(`Auto-export du dernier ZIP partiel…`)
      await tryAutoZipExport(true)
    }

    setProgress(`Terminé · ${done}/${total} composite(s) générés` + (errors > 0 ? ` · ${errors} erreur(s)` : ''))
    setRunning(false)
  }

  /* ----------- Auto-export ZIP partiel tous les N looks ----------- */
  // Vérifie si on a au moins N looks complets non encore exportés, et si oui
  // crée un ZIP partiel avec ces looks puis le télécharge.
  // forceAll = true → exporte aussi si moins de N looks (utilisé à la fin du batch)
  const tryAutoZipExport = async (forceAll = false) => {
    if (!autoZipEnabledRef.current) return
    if (zipExportInFlightRef.current) return

    // Identifie tous les looks complétés (toutes leurs tasks enabled = done ou error)
    // qui ne sont pas encore exportés
    const lookIdToTasks = new Map<string, TaskState[]>()
    for (const s of statesRef.current) {
      const arr = lookIdToTasks.get(s.task.lookId) ?? []
      arr.push(s)
      lookIdToTasks.set(s.task.lookId, arr)
    }
    const completedNotExported: string[] = []
    for (const [lookId, tasks] of lookIdToTasks) {
      if (exportedLookIdsRef.current.has(lookId)) continue
      const enabledTasks = tasks.filter(t => t.enabled)
      if (enabledTasks.length === 0) continue
      const allDone = enabledTasks.every(t => t.status === 'done' || t.status === 'error')
      if (allDone) completedNotExported.push(lookId)
    }

    if (completedNotExported.length === 0) return
    const threshold = autoZipEveryRef.current
    if (!forceAll && completedNotExported.length < threshold) return

    // Lock + mark exported AVANT de générer le ZIP (évite double-export)
    zipExportInFlightRef.current = true
    const lookIdsToExport = new Set(completedNotExported)
    lookIdsToExport.forEach(id => exportedLookIdsRef.current.add(id))

    try {
      const ok = statesRef.current.filter(s =>
        lookIdsToExport.has(s.task.lookId) && s.status === 'done' && s.imageUrl,
      )
      if (ok.length === 0) {
        console.log('[autoZip] aucun visuel à exporter pour ces looks')
        return
      }

      const zip = new JSZip()

      for (const s of ok) {
        const folder = sanitizeFilename(`${s.task.lookId}_${s.task.numeroLook}`)
        const vueNum     = (s.task.vueIndex ?? 0) + 1
        const orientation = (s.task.pose?.orientation ?? 'front').toString().toLowerCase()
        const framing    = (s.task.framingHint ?? 'plein').toString().toLowerCase()
        const baseName = s.task.taskType === 'detail'
          ? `detail${(s.task.detailIndex ?? 0) + 1}_${sanitizeFilename(s.task.detailName ?? 'unnamed')}`
          : `vue${vueNum}_${orientation}_${framing}`

        const blob = await imageUrlToBlob(s.imageUrl!)
        zip.file(`${folder}/${baseName}.${extFromUrl(s.imageUrl!)}`, blob)
        // DEBUG : fond effectivement donné à Gemini (override close-up haut si applicable)
        const debugBg = (s.task.framingHint === 'haut' && closeUpHautBgRef.current)
          ? closeUpHautBgRef.current
          : s.task.backgroundFile
        if (debugBg) {
          const fondExt = (debugBg.type.match(/^image\/(\w+)/) ?? [])[1]?.replace('jpeg', 'jpg') ?? 'jpg'
          zip.file(`${folder}/_FOND_${baseName}.${fondExt}`, debugBg)
        }
      }

      const out = await zip.generateAsync({ type: 'blob' })
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const filename = `composite_partial_${ts}_${lookIdsToExport.size}looks.zip`
      const url = URL.createObjectURL(out)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 5000)
      console.log(`[autoZip] ✓ exporté ${lookIdsToExport.size} look(s) dans ${filename}`)
    } catch (err) {
      console.warn('[autoZip] export failed:', err)
    } finally {
      zipExportInFlightRef.current = false
    }
  }

  const updateState = (id: string, patch: Partial<TaskState>) =>
    setStates(prev => prev.map(s => s.task.id === id ? { ...s, ...patch } : s))

  /* ----------- Export ZIP — un dossier par look ----------- */
  const exportZip = async () => {
    const ok = states.filter(s => s.status === 'done' && s.imageUrl)
    if (!ok.length) return
    const zip = new JSZip()

    // Helper pour extraire l'extension à partir d'un data URL

    for (const s of ok) {
      // Nom du dossier look : "{lookId}_{numeroLook}" (sanitisé)
      const folder = sanitizeFilename(`${s.task.lookId}_${s.task.numeroLook}`)

      // Base du nom de fichier
      let baseName: string
      if (s.task.taskType === 'detail') {
        baseName = `detail${(s.task.detailIndex ?? 0) + 1}_${sanitizeFilename(s.task.detailName ?? 'unnamed')}`
      } else {
        const vueNum     = (s.task.vueIndex ?? 0) + 1
        const orientation = (s.task.pose?.orientation ?? 'front').toString().toLowerCase()
        const framing    = (s.task.framingHint ?? 'plein').toString().toLowerCase()
        baseName = `vue${vueNum}_${orientation}_${framing}`
      }

      const blob = await imageUrlToBlob(s.imageUrl!)
      zip.file(`${folder}/${baseName}.${extFromUrl(s.imageUrl!)}`, blob)
      // DEBUG : fond effectivement donné à Gemini (override close-up haut si applicable)
      const debugBg = (s.task.framingHint === 'haut' && closeUpHautBgRef.current)
        ? closeUpHautBgRef.current
        : s.task.backgroundFile
      if (debugBg) {
        const fondExt = (debugBg.type.match(/^image\/(\w+)/) ?? [])[1]?.replace('jpeg', 'jpg') ?? 'jpg'
        zip.file(`${folder}/_FOND_${baseName}.${fondExt}`, debugBg)
      }
    }

    const out = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(out)
    const a = document.createElement('a')
    a.href = url
    a.download = `composite_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`
    document.body.appendChild(a); a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }



  const hasResults = states.some(s => s.status === 'done')

  return (
    <div style={styles.wrap}>
      <h2 style={styles.title}>Composite — fond exact garanti</h2>
      <p style={styles.subtitle}>
        Pipeline déterministe : Gemini génère le mannequin + scène → segmentation client-side
        → composite sur les <strong>pixels exacts</strong> du fond de référence → ombre synthétique soft.
        <br />
        <em>Premier run : ~30 s de download du modèle de segmentation (cache navigateur après).</em>
        <br />
        💡 <strong>Gros ZIP (5 GB+) ?</strong> Remplis "Limite looks" <em>avant</em> de drop le ZIP (ex : 3) pour ne parser/extraire que les premiers looks.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: 12, alignItems: 'end', marginBottom: 8 }}>
        <Dropzone files={zips} onChange={handleZipChange} accept=".zip" multiple={false}
          label="Glisse-dépose ton export Notion (.zip)" />
        <div>
          <label style={styles.label}>Limite looks (avant le drop)</label>
          <input value={lookLimit} onChange={e => setLookLimit(e.target.value)} placeholder="ex : 3 ou 100-150"
            style={styles.input} type="text" inputMode="text" />
          <div style={{ fontSize: 10, color: '#6B7A8A', marginTop: 4 }}>
            "N" = les N premiers looks · "M-N" = du Mème au Nème (inclus). Vide = tous.
          </div>
        </div>
      </div>

      {/* Fond dédié close-up haut (1 image optionnelle) */}
      <div style={{ marginTop: 8, marginBottom: 8 }}>
        <label style={styles.label}>
          🖼 Fond pour close-up haut (optionnel, 1 image)
        </label>
        <Dropzone files={closeUpHautBg} onChange={setCloseUpHautBg} accept="image/*" multiple={false}
          label="Glisse-dépose le fond à utiliser pour tous les close-up haut (sinon : crop top 50% du fond plein-pied)" />
        <div style={{ fontSize: 11, color: '#6B7A8A', marginTop: 4 }}>
          Si fourni, ce fond remplacera le fond plein-pied pour TOUTES les tasks framing=haut. Idéal pour éviter que Gemini invente un sol.
        </div>
      </div>

      {parsing && <div style={styles.info}>📦 Parsing en cours… {progress}</div>}
      {globalError && <div style={styles.errorBox}>⚠ {globalError}</div>}

      {parsed && !parsing && (
        <>
          <div style={styles.panel}>
            <div style={styles.panelGrid}>
              <div>
                <label style={styles.label}>Ratio</label>
                <select value={ratio} onChange={e => setRatio(e.target.value)} style={styles.select}>
                  <option value="9:16">9:16</option>
                  <option value="3:4">3:4</option>
                  <option value="1:1">1:1</option>
                  <option value="16:9">16:9</option>
                  <option value="4:3">4:3</option>
                </select>
              </div>
              <div>
                <label style={styles.label}>Qualité</label>
                <select value={quality} onChange={e => setQuality(e.target.value)} style={styles.select}>
                  <option value="1K">1K</option>
                  <option value="2K">2K</option>
                  <option value="4K">4K</option>
                </select>
              </div>
              <div>
                <label style={styles.label}>Parallélisme</label>
                <select value={concurrency} onChange={e => setConcurrency(Number(e.target.value))} style={styles.select}>
                  {[1, 2, 3, 5, 7, 10].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div>
                <label style={styles.label}>Limite looks</label>
                <input value={lookLimit} onChange={e => setLookLimit(e.target.value)} placeholder="ex : 3 ou 100-150"
                  style={styles.input} type="text" inputMode="text" />
              </div>
            </div>

            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid rgba(13,74,92,0.08)' }}>
              <div style={{ marginTop: 0, padding: 12, background: '#E8F2F5', border: '1px solid rgba(13,74,92,0.15)', borderRadius: 8 }}>
                <label style={{ ...styles.label, display: 'block', textTransform: 'none', letterSpacing: 0, fontSize: 13, fontWeight: 700, color: '#0D4A5C', marginBottom: 6 }}>
                  📁 Sauvegarde directe dans un dossier (recommandé)
                </label>
                <p style={{ fontSize: 11, color: '#6B7A8A', margin: '0 0 8px', lineHeight: 1.5 }}>
                  Au lieu de télécharger des ZIPs, écrit chaque look directement dans un dossier local <strong>au fur et à mesure</strong>.
                  Pas de manipulation post-batch, structure de dossiers déjà en place. Chrome/Edge 86+ uniquement.
                </p>
                {outputDirName ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <span style={{ color: '#1F7A35', fontWeight: 600 }}>✓ Dossier : {outputDirName}</span>
                    <button onClick={clearOutputDir} style={{ ...styles.btnLight, padding: '4px 8px', fontSize: 11 }}>✗ retirer</button>
                  </div>
                ) : (
                  <button onClick={handleChooseOutputDir} style={{ ...styles.btnLight, padding: '6px 10px', fontSize: 12 }}>
                    📂 Choisir le dossier de sortie
                  </button>
                )}
              </div>

              <label style={{ ...styles.label, display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0, fontSize: 13, fontWeight: 700, color: '#1F7A35', cursor: 'pointer', marginTop: 10 }}>
                <input type="checkbox" checked={autoZipEnabled} onChange={e => setAutoZipEnabled(e.target.checked)} />
                💾 Auto-export ZIP tous les N looks <em style={{ color: '#6B7A8A', fontSize: 10, fontWeight: 400 }}>(fallback : si pas de dossier choisi)</em>
              </label>
              {autoZipEnabled && (
                <div style={{ marginLeft: 24, marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: '#6B7A8A' }}>N looks par ZIP :</span>
                  <input
                    type="number" min="1" max="100"
                    value={autoZipEvery}
                    onChange={e => setAutoZipEvery(Math.max(1, Number(e.target.value) || 10))}
                    style={{ width: 60, padding: '4px 6px', fontSize: 12, border: '1px solid rgba(13,74,92,0.2)', borderRadius: 4 }}
                  />
                </div>
              )}
              <p style={{ fontSize: 11, color: '#6B7A8A', marginTop: 4, lineHeight: 1.5, marginLeft: 24 }}>
                Toutes les {autoZipEvery} look(s) complétés → 1 ZIP téléchargé automatiquement avec 1 sous-dossier par look.<br />
                À la fin du batch, le dernier ZIP partiel (peut être &lt; {autoZipEvery} looks) est aussi téléchargé.<br />
                ⚠ Au 1er téléchargement, Chrome demande d&apos;autoriser les téléchargements multiples — clique &quot;Autoriser&quot;.
              </p>

              {/* Excel-based selection */}
              <div style={{ marginTop: 16, padding: 12, background: '#fff', border: '1px solid rgba(13,74,92,0.15)', borderRadius: 8 }}>
                <label style={{ ...styles.label, display: 'block', textTransform: 'none', letterSpacing: 0, fontSize: 13, fontWeight: 700, color: '#0D4A5C', marginBottom: 8 }}>
                  📋 Sélection par fichier Excel (optionnel)
                </label>
                <Dropzone files={excelFile} onChange={handleExcelChange} accept=".xlsx" multiple={false}
                  label="Drop ton Excel (.xlsx)" minHeight={70} />
                {excelError && <div style={{ ...styles.errorBox, marginTop: 6 }}>⚠ {excelError}</div>}
                {excelSelection && (
                  <>
                    {excelSelection.warnings.length > 0 && (
                      <div style={{ ...styles.info, marginTop: 6, fontSize: 11 }}>
                        {excelSelection.warnings.map((w, i) => (<div key={i}>📋 {w}</div>))}
                      </div>
                    )}
                    <div style={{ ...styles.info, marginTop: 6, fontSize: 11 }}>
                      ✓ {excelSelection.looksFound.size} look(s) parsé(s) — {Array.from(excelSelection.toRegenerate.values()).reduce((sum, s) => sum + s.size, 0)} vue(s) à régénérer (non vertes)
                      <br />
                      🔗 Matching par <strong>position séquentielle</strong> : ligne 2 Excel = 1er look du ZIP, ligne 3 Excel = 2e look, etc.
                    </div>
                  </>
                )}
                <label style={{ ...styles.label, display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0, fontSize: 13, fontWeight: 600, color: '#0D4A5C', cursor: 'pointer', marginTop: 10 }}>
                  <input type="checkbox" checked={useExcel} onChange={e => setUseExcel(e.target.checked)} disabled={!excelSelection} />
                  Sélectionner en fonction de l&apos;Excel <em style={{ color: '#6B7A8A', fontSize: 10 }}>(décoche les vues vertes = déjà OK)</em>
                </label>
                <label style={{ ...styles.label, display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0, fontSize: 13, fontWeight: 600, color: '#0D4A5C', cursor: 'pointer', marginTop: 6 }}>
                  <input type="checkbox" checked={excludePlein} onChange={e => setExcludePlein(e.target.checked)} />
                  🚫 Ne pas générer les plein pied
                </label>
              </div>
              <p style={{ fontSize: 11, color: '#6B7A8A', marginTop: 4, lineHeight: 1.5 }}>
                Pour les <strong>plein pied</strong> et <strong>close-up bas</strong>, on envoie le mannequin segmenté + le fond seul
                à <code>/api/studio/simple</code> qui fusionne via Gemini avec une lumière et une ombre naturelles
                (comme dans l&apos;onglet Simple).
                <br />
                Pour les <strong>close-up haut</strong>, on garde le composite Canvas (bg croppé aux 30 % du haut).
                <br />
                Coût : <strong>+1 appel Gemini</strong> par visuel concerné.
              </p>
            </div>

            <div style={styles.statsBox}>
              📊 {parsed.tasks.length} visuels (poses) · {enabledCount} sélectionnés
              {parsed.warnings.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 11, color: '#7A4F00' }}>
                  ⚠ {parsed.warnings.length} avertissement(s) du parser Notion.
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={() => toggleAllStates(true)}  style={styles.btnLight}>✓ tout cocher</button>
              <button onClick={() => toggleAllStates(false)} style={styles.btnLight}>✗ tout décocher</button>
              <button onClick={selectCloseUpAndDetails}      style={styles.btnLight}>📐 close-up + détails uniquement</button>
              <button onClick={handleRunAll} disabled={running || enabledCount === 0} style={styles.btnPrimary}>
                {running ? '⏳ génération en cours…' : `🚀 lancer le composite (${enabledCount})`}
              </button>
              {hasResults && (
                <button onClick={exportZip} style={styles.btnLight}>⬇ Export ZIP</button>
              )}
            </div>

            {progress && <div style={{ ...styles.info, marginTop: 12 }}>{progress}</div>}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {groupedLooks.map(({ lookId, tasks }) => {
              const open    = expanded[lookId] ?? false
              const doneN   = tasks.filter(t => t.status === 'done').length
              const errN    = tasks.filter(t => t.status === 'error').length
              const runN    = tasks.filter(t => t.status === 'running').length
              const allOn   = tasks.every(t => t.enabled)
              const anyOn   = tasks.some(t => t.enabled)
              const numero  = tasks[0].task.numeroLook
              return (
                <div key={lookId} style={styles.lookCard}>
                  <div style={styles.lookHead} onClick={() => setLookExpansion(lookId, !open)}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: '#0D4A5C' }}>{open ? '▼' : '▶'} Look {numero}</span>
                    <span style={{ fontSize: 11, color: '#6B7A8A', marginLeft: 8 }}>
                      ({tasks.length} pose(s) · ✓ {doneN} · ⚠ {errN} · ⏳ {runN})
                    </span>
                    <span style={{ marginLeft: 'auto' }}>
                      <Indeterminate3StateCheckbox
                        checked={allOn} indeterminate={anyOn && !allOn}
                        onChange={() => toggleLook(lookId, !allOn)} />
                    </span>
                  </div>
                  {open && (
                    <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {tasks.map(s => (
                        <TaskRow key={s.task.id} state={s} onToggle={() => toggleTask(s.task.id)} />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {!parsed && !parsing && (
        <div style={styles.emptyState}>
          📦 Drop ton export Notion (.zip) pour commencer.<br />
          <span style={{ fontSize: 11 }}>Le runner ne traite que les poses (pas les détails) en mode Composite.</span>

          <div style={{ marginTop: 20, padding: 14, background: '#FFF8E1', border: '1px solid #F1D78A', borderRadius: 8, textAlign: 'left', color: '#7A4F00', fontSize: 12, lineHeight: 1.5 }}>
            💡 <strong>Gros ZIP (3-10 GB) ?</strong> Renseigne le champ <strong>"Limite looks"</strong> (à droite du Dropzone) <em>avant</em> de drop le fichier.
            Le parseur lit alors le ZIP en lazy et n'extrait que les images des N premiers looks — pas besoin de tout charger pour tester.
            <br />Exemple : pour un test rapide, mets <code>2</code> ou <code>3</code>.
          </div>

          <div style={{ marginTop: 16, fontSize: 11, color: '#6B7A8A', textAlign: 'left' }}>
            <strong>Vues supportées</strong> : {VIEW_CATALOG.map(v => v.label ?? v.key).join(', ')}<br />
            <strong>Poses supportées</strong> : {POSE_CATALOG.map(p => p.key).join(', ')}
          </div>
        </div>
      )}
    </div>
  )
}

/* ============================== TaskRow ============================== */

function TaskRow({ state, onToggle }: { state: TaskState, onToggle: () => void }) {
  const { task, status, imageUrl, error, enabled } = state
  const color =
    status === 'done'    ? '#1F7A35'
    : status === 'error' ? '#9B1C1C'
    : status === 'running'? '#0D4A5C'
    : '#6B7A8A'

  const stepLabel: Record<string, string> = {
    gemini:    '⏳ Génération…',
    done:      '✓ Done',
  }

  return (
    <div style={taskRowStyle}>
      <input type="checkbox" checked={enabled} onChange={onToggle} disabled={status === 'running'} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#0D4A5C' }}>
          {task.taskType === 'detail'
            ? `🔬 Détail ${(task.detailIndex ?? 0) + 1} — ${task.detailName ?? ''}`
            : task.vueRaw ?? task.id}
        </div>
        <div style={{ fontSize: 11, color: '#6B7A8A', marginTop: 2 }}>
          ID <code>{task.id}</code> · type <strong>{task.taskType}</strong>
          {state.progressStep && status === 'running' && (
            <span style={{ marginLeft: 8, color: '#0D4A5C', fontWeight: 600 }}>· {stepLabel[state.progressStep]}</span>
          )}
        </div>
        {error && <div style={{ ...errorBoxStyle, marginTop: 4 }}>⚠ {error}</div>}
      </div>

      <span style={{ ...statusPill, color, borderColor: color }}>{status}</span>

      <div style={{ display: 'flex', gap: 8 }}>
        {imageUrl && (
          <ImgThumb label="Visuel" url={imageUrl} highlight />
        )}
      </div>
    </div>
  )
}

function ImgThumb({ label, url, highlight }: { label: string, url: string, highlight?: boolean }) {
  const handleDownload = async (e: React.MouseEvent) => {
    e.preventDefault()
    try {
      const res = await fetch(url)
      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = `${label.replace(/\W+/g, '_')}.jpg`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000)
    } catch (err) {
      console.warn('[download] failed, fallback open in new tab:', err)
      window.open(url, '_blank')
    }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
      <img src={url} alt={label} style={{
        width: 90, borderRadius: 6,
        border: highlight ? '2px solid #1F7A35' : '1px solid rgba(13,74,92,0.1)',
        background: '#f4f6f8',
      }} />
      <div style={{ fontSize: 9, color: highlight ? '#1F7A35' : '#6B7A8A', fontWeight: highlight ? 700 : 600 }}>{label}</div>
      <div style={{ display: 'flex', gap: 3 }}>
        <a href={url} onClick={handleDownload}
           style={highlight ? linkBtnDark : linkBtnLight} title="Télécharger">⬇</a>
        <a href={url} target="_blank" rel="noreferrer"
           onClick={async (e) => {
             if (url.startsWith('data:')) {
               e.preventDefault()
               try {
                 const res = await fetch(url)
                 const blob = await res.blob()
                 const blobUrl = URL.createObjectURL(blob)
                 window.open(blobUrl, '_blank')
                 setTimeout(() => URL.revokeObjectURL(blobUrl), 60000)
               } catch (err) { console.warn('[open] failed:', err) }
             }
           }}
           style={highlight ? linkBtnDark : linkBtnLight} title="Ouvrir dans un nouvel onglet">↗</a>
      </div>
    </div>
  )
}

/* ============================== Checkbox 3 états ============================== */

function Indeterminate3StateCheckbox({
  checked, indeterminate, onChange,
}: { checked: boolean, indeterminate: boolean, onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return <input ref={ref} type="checkbox" checked={checked} onChange={onChange} onClick={e => e.stopPropagation()} />
}

/* ============================== utils ============================== */

function truncate(s: string, max = 240): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

/* ============================== styles ============================== */

const styles: Record<string, React.CSSProperties> = {
  wrap:      { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1400 },
  title:     { fontSize: 22, fontWeight: 700, color: '#0D4A5C', margin: 0 },
  subtitle:  { fontSize: 13, color: '#6B7A8A', lineHeight: 1.5, margin: '0 0 6px' },
  panel:     { background: '#F5F7F9', borderRadius: 12, padding: 16, border: '1px solid rgba(13,74,92,0.08)' },
  panelGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 },
  label:     { fontSize: 10, fontWeight: 600, color: '#6B7A8A', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: 4 },
  select:    { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid rgba(13,74,92,0.15)', background: '#fff', fontSize: 13, color: '#0D4A5C' },
  input:     { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid rgba(13,74,92,0.15)', background: '#fff', fontSize: 13, color: '#0D4A5C' },
  btnPrimary:{ padding: '10px 16px', background: '#0D4A5C', color: '#fff', borderRadius: 8, border: 0, fontWeight: 700, fontSize: 13, cursor: 'pointer' },
  btnLight:  { padding: '10px 14px', background: '#fff', color: '#0D4A5C', borderRadius: 8, border: '1px solid rgba(13,74,92,0.2)', fontWeight: 600, fontSize: 12, cursor: 'pointer' },
  info:      { fontSize: 12, color: '#0D4A5C', background: '#E8F2F5', borderRadius: 6, padding: '8px 10px' },
  errorBox:  { background: '#FDECEC', color: '#9B1C1C', border: '1px solid #F5C2C2', padding: '8px 10px', borderRadius: 7, fontSize: 12, whiteSpace: 'pre-wrap' },
  statsBox:  { background: '#E8F2F5', color: '#0D4A5C', borderRadius: 8, padding: '10px 12px', fontSize: 12, lineHeight: 1.5, marginTop: 12 },
  emptyState:{ textAlign: 'center', padding: '60px 24px', color: '#6B7A8A', fontSize: 14, border: '1px dashed rgba(13,74,92,0.2)', borderRadius: 12, background: '#fff', lineHeight: 1.5 },
  lookHead:  { padding: '10px 14px', background: '#F5F7F9', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', borderBottom: '1px solid rgba(13,74,92,0.08)' },
}

const taskRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 10, padding: 10,
  background: '#fff', borderRadius: 8, border: '1px solid rgba(13,74,92,0.08)',
}
const statusPill: React.CSSProperties = {
  padding: '3px 8px', borderRadius: 12, fontSize: 10, fontWeight: 700,
  textTransform: 'uppercase', border: '1px solid', alignSelf: 'flex-start',
}
const errorBoxStyle: React.CSSProperties = {
  background: '#FDECEC', color: '#9B1C1C', border: '1px solid #F5C2C2',
  padding: '6px 8px', borderRadius: 6, fontSize: 11, whiteSpace: 'pre-wrap',
}
const linkBtnDark: React.CSSProperties = {
  padding: '3px 7px', fontSize: 10, color: '#fff', background: '#0D4A5C',
  borderRadius: 4, textDecoration: 'none', fontWeight: 600, textAlign: 'center',
}
const linkBtnLight: React.CSSProperties = {
  padding: '3px 7px', fontSize: 10, color: '#0D4A5C',
  border: '1px solid rgba(13,74,92,0.2)', borderRadius: 4,
  textDecoration: 'none', fontWeight: 600, textAlign: 'center',
}
