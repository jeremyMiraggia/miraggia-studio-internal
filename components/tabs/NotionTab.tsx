'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import Dropzone from '@/components/ui/Dropzone'
import { compressAll, compressImage } from '@/lib/compressImage'
import { cropTopPercent, createWhiteBackground } from '@/lib/imageCrop'
import { parseNotionExport, type GenerationTask, type ParsedExport } from '@/lib/notion/parseExport'
import { parseInspiExport, buildInspiPrompt } from '@/lib/notion/parseInspiExport'
import { VIEW_CATALOG, POSE_CATALOG } from '@/lib/poses'

type TaskStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error'

type TaskState = {
  task:    GenerationTask
  status:  TaskStatus
  enabled: boolean
  imageUrl?: string
  imageUrlStep1?: string   // step 1 du mode 2-étapes (fond blanc, conservé pour comparaison)
  error?:    string
  extractedEnv?:  string
  extractedPose?: string
  finalAttempt?:     number
  faceUsed?:         boolean
  faceWasAvailable?: boolean
}

type Mode = 'batch' | 'inspi'

export default function NotionTab() {
  const [mode, setMode]               = useState<Mode>('batch')
  const [concurrency, setConcurrency] = useState<number>(2)
  const [coherenceMode, setCoherenceMode] = useState<boolean>(false)
  const [twoStepMode, setTwoStepMode]     = useState<boolean>(false)
  const [lookLimit, setLookLimit] = useState<string>('')
  const [zips, setZips]               = useState<File[]>([])
  const [parsing, setParsing]         = useState(false)
  const [parsed, setParsed]           = useState<ParsedExport | null>(null)
  const [states, setStates]           = useState<TaskState[]>([])
  const statesRef                     = useRef<TaskState[]>([])
  const [globalError, setGlobalError] = useState<string | null>(null)

  const [ratio, setRatio]             = useState('9:16')
  const [quality, setQuality]         = useState('2K')
  const [running, setRunning]         = useState(false)
  const [progress, setProgress]       = useState('')
  const [expanded, setExpanded]       = useState<Record<string, boolean>>({})

  /* ----------- Changement de mode ----------- */
  const switchMode = (m: Mode) => {
    if (m === mode) return
    setMode(m)
    setParsed(null)
    setStates([])
    setZips([])
    setExpanded({})
    setGlobalError(null)
  }

  /* ----------- Parsing zip ----------- */
  const handleZipChange = async (files: File[]) => {
    setZips(files)
    setGlobalError(null)
    setParsed(null)
    setStates([])
    setExpanded({})

    if (files.length === 0) return

    // Pre-check : la lecture lazy supporte jusqu'à ~10 GB. Au-delà, on prévient.
    const sizeGB = files[0].size / (1024 * 1024 * 1024)
    if (sizeGB > 10.0) {
      setGlobalError(
        `Le ZIP fait ${sizeGB.toFixed(1)} GB — au-delà de la limite pratique (~10 GB). Découpe l'export.`,
      )
      setZips([])
      return
    }
    if (sizeGB > 3.0) {
      setProgress(`ZIP volumineux (${sizeGB.toFixed(1)} GB) — utilise "Limiter aux N premiers looks" pour un premier essai rapide.`)
    }

    setParsing(true)
    try {
      const limit = lookLimit.trim() && Number(lookLimit) > 0 ? Number(lookLimit) : undefined
      const result = await (mode === 'inspi'
        ? parseInspiExport(files[0], (msg) => setProgress(msg), limit)
        : parseNotionExport(files[0], (msg) => setProgress(msg), limit))
      setParsed(result)
      setStates(result.tasks.map(t => ({
        task: t,
        status: 'pending',
        enabled: true,
      })))
      setProgress('')
    } catch (e: any) {
      setGlobalError(e?.message ?? 'Impossible de parser le zip.')
    }
    setParsing(false)
  }

  useEffect(() => { statesRef.current = states }, [states])

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

  const toggleTask = (id: string) => {
    setStates(prev => prev.map(s => s.task.id === id ? { ...s, enabled: !s.enabled } : s))
  }
  const toggleLook = (lookId: string, value: boolean) => {
    setStates(prev => prev.map(s => s.task.lookId === lookId ? { ...s, enabled: value } : s))
  }
  const toggleAllStates = (value: boolean) => {
    setStates(prev => prev.map(s => ({ ...s, enabled: value })))
  }

  const setLookExpansion = (lookId: string, open: boolean) =>
    setExpanded(prev => ({ ...prev, [lookId]: open }))

  /* ----------- Génération séquentielle ----------- */
  const handleRunAll = async () => {
    if (!parsed) return
    setGlobalError(null)
    setRunning(true)

    const queue = states.filter(s => s.enabled)
    let done    = 0
    let errors  = 0
    const total = queue.length

    // Traitement d'un seul item — extrait pour pouvoir le run en parallèle
    const processOne = async (item: TaskState): Promise<void> => {
      setLookExpansion(item.task.lookId, true)
      updateState(item.task.id, {
        status: 'running',
        error: undefined,
        imageUrl: undefined,
        imageUrlStep1: undefined,
        extractedEnv: undefined,
        extractedPose: undefined,
        finalAttempt: undefined,
        faceUsed: undefined,
        faceWasAvailable: undefined,
      })

      try {
        let promptToUse = item.task.prompt
        let refsToUse   = item.task.refs

        // ===== INSPI : extract puis generate =====
        if (item.task.taskType === 'inspi' && item.task.inspirationFile) {
          const inspiCompressed = await compressImage(item.task.inspirationFile, { maxSide: 1600, quality: 0.85 })
          const extractFd = new FormData()
          extractFd.append('images', inspiCompressed)
          const exRes = await fetch('/api/studio/extract', { method: 'POST', body: extractFd })
          const exData = await exRes.json().catch(() => null)
          const first  = exData?.results?.[0]
          if (!exRes.ok || !first || first.error) {
            const msg = first?.error || exData?.error || `Extracteur HTTP ${exRes.status}`
            updateState(item.task.id, { status: 'error', error: truncate(msg) })
            errors++
            return
          }
          const env  = String(first.environnement ?? '').trim()
          const pose = String(first.pose          ?? '').trim()
          updateState(item.task.id, { extractedEnv: env, extractedPose: pose })

          promptToUse = buildInspiPrompt({
            mannequinName:    item.task.mannequinName,
            modelDescription: item.task.modelDescription,
            outfitCount:      item.task.outfitFiles?.length ?? 0,
            extractedEnv:     env,
            extractedPose:    pose,
            extraDetailCount: item.task.extraInspiDetails?.length ?? 0,
            bgOverride:       item.task.bgOverride,
            viewOverride:     item.task.viewOverride,
          })
        }

        // ===== POSE COHÉRENCE : poses 2..N d'un même look utilisent la 1re comme base =====
        if (item.task.taskType === 'pose' && coherenceMode && (item.task.vueIndex ?? 0) > 0) {
          // Attend qu'au moins une autre pose du même look soit done (max 3 min)
          const waitStart = Date.now()
          while (Date.now() - waitStart < 180_000) {
            const base = statesRef.current.find(s =>
              s.task.lookId === item.task.lookId &&
              s.task.taskType === 'pose' &&
              s.task.id !== item.task.id &&
              s.status === 'done' &&
              !!s.imageUrl,
            )
            if (base) {
              // Trouvé : on l'utilise comme base
              const baseFile = await dataUrlToFile(base.imageUrl!, `coherence_base_${item.task.lookId}.png`)
              refsToUse   = [baseFile]
              if (item.task.posePromptWithBase) promptToUse = item.task.posePromptWithBase
              break
            }
            // Si aucune autre pose du look n'est en cours ou en attente, on n'attend pas indéfiniment
            const anyOther = statesRef.current.some(s =>
              s.task.lookId === item.task.lookId &&
              s.task.taskType === 'pose' &&
              s.task.id !== item.task.id &&
              (s.status === 'running' || s.status === 'pending'),
            )
            if (!anyOther) break
            await new Promise(r => setTimeout(r, 2000))
          }
        }

        if (item.task.taskType === 'detail') {
          const baseState = statesRef.current.find(s =>
            s.task.lookId === item.task.lookId &&
            s.task.taskType === 'pose' &&
            s.status === 'done' &&
            !!s.imageUrl,
          )
          if (baseState?.imageUrl && item.task.detailFile && item.task.promptWithBase) {
            const baseFile = await dataUrlToFile(baseState.imageUrl, `base_look_${item.task.lookId}.png`)
            refsToUse   = [baseFile, item.task.detailFile]
            promptToUse = item.task.promptWithBase
          }
        }

        const fd = new FormData()
        fd.append('prompt',  promptToUse)
        fd.append('ratio',   ratio)
        fd.append('quality', quality)

        // Mode "structuré" : si la task a séparé body/background/products,
        // on les envoie comme champs dédiés pour que le backend construise
        // un prompt Gemini propre (cf. plateforme principale).
        // Note : on désactive le mode structuré quand on utilise une base
        // image (cohérence ou detail avec base) — dans ce cas le runner a
        // déjà remplacé refsToUse par [baseImage(+detail)].
        const hasOverride = refsToUse !== item.task.refs
        const canStructure = !hasOverride && item.task.taskType !== 'inspi'
                             && !!item.task.bodyPhotoFile && !!item.task.backgroundFile

        // ===== MODE 2 ÉTAPES (test) =====
        // Step 1 : génère le visuel sur fond BLANC.
        // Step 2 : swap le fond blanc avec le fond réel (croppé si close-up haut).
        if (twoStepMode && canStructure && item.task.taskType === 'pose') {
          // ----- STEP 1 : fond blanc -----
          const body  = await compressImage(item.task.bodyPhotoFile!, { maxSide: 2048, quality: 0.90 })
          const white = await createWhiteBackground(1024, 1536)
          const prods = await compressAll(item.task.productFiles ?? [], { maxSide: 2048, quality: 0.85 })
          const fd1 = new FormData()
          fd1.append('prompt',  promptToUse + '\n\n⚠ STEP 1/2 : génère sur fond BLANC PUR uni neutre. Pas de décor. Pas de sol visible. Studio backdrop blanc seamless. Le fond sera changé en étape 2.')
          fd1.append('ratio',   ratio)
          fd1.append('quality', quality)
          fd1.append('mannequinBody', body)
          fd1.append('background',    white)
          for (const p of prods) fd1.append('products', p)
          if (item.task.facePhotoFile) {
            const face = await compressImage(item.task.facePhotoFile, { maxSide: 2048, quality: 0.92 })
            fd1.append('mannequinFace', face)
          }
          fd1.append('framing',        item.task.framingHint ?? 'plein')
          fd1.append('mannequinLabel', item.task.mannequinName)
          fd1.append('decorLabel',     'plain white seamless backdrop')

          setProgress(`Step 1/2 (fond blanc) · look ${item.task.numeroLook} · ${done + errors}/${total} traités`)
          const res1 = await fetch('/api/studio/free', { method: 'POST', body: fd1 })
          const data1: any = await res1.json().catch(() => null)
          if (!res1.ok || !data1?.imageUrl) {
            const msg = (data1 && (data1.error || data1.message)) || `Step 1 HTTP ${res1.status}`
            updateState(item.task.id, { status: 'error', error: truncate('Step 1 : ' + msg) })
            errors++
            return
          }

          // Step 1 OK : on stocke immédiatement le visuel fond blanc pour que l'utilisateur
          // le voie pendant que la step 2 (swap) tourne (~30-60 s de plus).
          updateState(item.task.id, { imageUrlStep1: data1.imageUrl })

          // ----- STEP 2 : swap fond -----
          const step1File = await dataUrlToFile(data1.imageUrl, `step1_look_${item.task.lookId}.png`)
          // Si CloseUpHaut, on crop le fond aux 30% du haut (mur seulement, pas de sol)
          let targetBg = item.task.backgroundFile!
          if (item.task.framingHint === 'haut') {
            targetBg = await cropTopPercent(item.task.backgroundFile!, 30)
          }
          const bgCompressed = await compressImage(targetBg, { maxSide: 2048, quality: 0.92 })
          const step1Compressed = await compressImage(step1File, { maxSide: 2048, quality: 0.92 })

          // Instructions d'ombre adaptées au cadrage de la tâche
          const framing = item.task.framingHint ?? 'plein'
          const isFloorVisible = framing === 'plein' || framing === 'bas'
          const isWallBehind   = framing === 'haut' || framing === 'mi-corps'

          const shadowRule = isWallBehind
            ? 'SHADOW ON WALL: no shadow on the wall behind the model. The model is detached from the wall with normal depth — not pressed against it. The wall stays clean.'
            : isFloorVisible
              ? 'SHADOW ON FLOOR: keep it discreet and natural — a soft contact shadow at the feet, adapted to the scene lighting. No projected body silhouette on the floor. No floor reflection of the model. Nothing dramatic.'
              : 'SHADOW: keep the lighting natural and coherent with REFERENCE #2 — nothing dramatic.'

          const vogueStyle = 'Vogue-style editorial photography. Shot on film, visible grain, subtle blur, slight motion softness. Imperfect focus, organic textures, realistic skin with no heavy retouching. Raw, intimate, spontaneous fashion moment. High-end but not overly polished.'

          const swapPrompt = [
            'You are given TWO images :',
            '- REFERENCE #1 : a fashion photo of a model on a PURE WHITE STUDIO background (flat frontal studio light).',
            '- REFERENCE #2 : a target backdrop / scene with its own lighting and ambient atmosphere.',
            '',
            '⚠ TASK : Composite the model from REFERENCE #1 into the scene of REFERENCE #2, with proper photographic INTEGRATION (not a flat cutout).',
            '',
            'PRESERVE FROM REFERENCE #1 (identity & appearance) :',
            '- Face features, hair shape and color, skin tone, age and morphology — same person.',
            '- Body shape, pose, posture, gesture, orientation.',
            '- Outfit : exact same garments, colors, prints, cut, accessories, shoes — no alteration.',
            '',
            'REPLACE FROM REFERENCE #2 (scene & light) :',
            '- The white background is fully replaced by the EXACT pixel content of REFERENCE #2 — same color, same texture, same gradient, same architectural elements.',
            '- ⚠ RE-LIGHT the model so the light direction, color temperature, intensity, and softness MATCH the scene of REFERENCE #2. The face, the t-shirt, the skirt, the skin, the hair, the shoes must look naturally ILLUMINATED BY the same light source as the background — not by the original flat white-studio light of REFERENCE #1. Add natural skin tone warmth and the ambient color cast of the scene. Add subtle highlights and self-shadowing on the body that come from the new light source direction.',
            '- ' + shadowRule,
            '',
            'KEEP :',
            '- Same framing, same crop, same camera angle as REFERENCE #1.',
            '- Same person — do NOT regenerate the face, do NOT change the outfit.',
            '',
            'PHOTOGRAPHIC STYLE : ' + vogueStyle,
            '',
            'Generate the integrated photograph now — the result must feel like a single coherent fashion editorial shot taken in the scene of REFERENCE #2.',
          ].join('\n')

          const fd2 = new FormData()
          fd2.append('prompt',  swapPrompt)
          fd2.append('ratio',   ratio)
          fd2.append('quality', quality)
          fd2.append('refs',    step1Compressed)
          fd2.append('refs',    bgCompressed)

          setProgress(`Step 2/2 (swap fond) · look ${item.task.numeroLook} · ${done + errors}/${total} traités`)
          const res2 = await fetch('/api/studio/free', { method: 'POST', body: fd2 })
          const data2: any = await res2.json().catch(() => null)
          if (!res2.ok || !data2?.imageUrl) {
            const msg = (data2 && (data2.error || data2.message)) || `Step 2 HTTP ${res2.status}`
            // imageUrlStep1 est déjà set ; on marque la tâche done avec une erreur explicative.
            updateState(item.task.id, {
              status: 'done',
              error: 'Step 2 échouée : ' + truncate(msg) + ' — seul le visuel fond blanc (step 1) est disponible.',
            })
            done++
          } else {
            updateState(item.task.id, {
              status: 'done',
              imageUrl: data2.imageUrl,
              finalAttempt: 2,
              faceUsed: !!item.task.facePhotoFile,
              faceWasAvailable: !!item.task.facePhotoFile,
            })
            done++
          }
          return
        }

        if (canStructure) {
          const body  = await compressImage(item.task.bodyPhotoFile!, { maxSide: 2048, quality: 0.90 })
          // Background ref en haute résolution (3500 px max) pour max de détails à Gemini.
          const bg    = await compressImage(item.task.backgroundFile!, { maxSide: 3500, quality: 0.88 })
          const prods = await compressAll(item.task.productFiles ?? [], { maxSide: 2048, quality: 0.85 })
          fd.append('mannequinBody',  body)
          fd.append('background',     bg)
          for (const p of prods) fd.append('products', p)
          if (item.task.facePhotoFile) {
            const face = await compressImage(item.task.facePhotoFile, { maxSide: 2048, quality: 0.92 })
            fd.append('mannequinFace', face)
          }
          fd.append('framing',        item.task.framingHint ?? 'plein')
          fd.append('mannequinLabel', item.task.mannequinName)
          fd.append('decorLabel',     item.task.fondName)
        } else {
          // Mode legacy : refs en vrac + face séparée
          const refs = await compressAll(refsToUse, { maxSide: 2048, quality: 0.85 })
          let faceCompressed: File | null = null
          if (item.task.facePhotoFile && item.task.taskType !== 'detail') {
            faceCompressed = await compressImage(item.task.facePhotoFile, { maxSide: 2048, quality: 0.92 })
          }
          refs.forEach(f => fd.append('refs', f))
          if (faceCompressed) fd.append('face', faceCompressed)
        }

        const res = await fetch('/api/studio/free', { method: 'POST', body: fd })
        let data: any = null
        try { data = await res.json() } catch { /* */ }

        if (!res.ok) {
          const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`
          updateState(item.task.id, { status: 'error', error: truncate(msg) })
          errors++
          return
        }
        if (data?.imageUrl) {
          updateState(item.task.id, {
            status: 'done',
            imageUrl: data.imageUrl,
            finalAttempt:     typeof data.attempt === 'number' ? data.attempt : undefined,
            faceUsed:         typeof data.faceUsed === 'boolean' ? data.faceUsed : undefined,
            faceWasAvailable: typeof data.faceWasAvailable === 'boolean' ? data.faceWasAvailable : undefined,
          })
          done++
        } else {
          updateState(item.task.id, { status: 'error', error: data?.error ?? 'Aucune image renvoyée' })
          errors++
        }
      } catch (e: any) {
        updateState(item.task.id, { status: 'error', error: e?.message ?? 'Erreur réseau' })
        errors++
      } finally {
        const finished = done + errors
        setProgress(`${finished}/${total} visuels traités · ${done} réussis · ${errors} erreur(s)`)
      }
    }

    // Worker pool : on lance `concurrency` workers qui consomment la queue
    let nextIdx = 0
    const worker = async () => {
      while (true) {
        const i = nextIdx++
        if (i >= queue.length) return
        await processOne(queue[i])
      }
    }

    const workerCount = Math.max(1, Math.min(concurrency, queue.length))
    setProgress(`Lancement de ${workerCount} générations en parallèle…`)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))

    setProgress(`Terminé · ${done}/${total} visuel(s) générés` + (errors > 0 ? ` · ${errors} erreur(s)` : ''))
    setRunning(false)
  }

  const updateState = (id: string, patch: Partial<TaskState>) => {
    setStates(prev => prev.map(s => s.task.id === id ? { ...s, ...patch } : s))
  }

  /* ----------- Export ZIP des résultats ----------- */
  const exportZip = async () => {
    const ok = states.filter(s => s.status === 'done' && s.imageUrl)
    if (!ok.length) return
    const zip = new JSZip()
    for (const s of ok) {
      const blob = await dataUrlToBlob(s.imageUrl!)
      const ext  = blob.type.includes('png') ? 'png' : 'jpg'
      const safeName = s.task.taskType === 'detail'
        ? `look_${s.task.numeroLook}_detail${(s.task.detailIndex ?? 0) + 1}_${slug(s.task.detailName ?? '')}.${ext}`
        : `look_${s.task.numeroLook}_vue${(s.task.vueIndex ?? 0) + 1}_${slug(s.task.vueRaw ?? '')}.${ext}`
      zip.file(safeName, blob)
    }
    const blob = await zip.generateAsync({ type: 'blob' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url
    a.download = `miraggia_notion_${new Date().toISOString().slice(0, 10)}.zip`
    a.click()
    URL.revokeObjectURL(url)
  }

  /* ----------- Render ----------- */
  return (
    <div>
      <h2 style={styles.title}>📥 Notion Batch</h2>
      <p style={styles.sub}>Dépose un export Notion de la base LOOK. L'app résout mannequins, fonds, vêtements, poses, et lance la génération de tous les visuels en un clic.</p>

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 24 }}>
        {/* Panneau contrôle */}
        <div style={styles.card}>
          <label style={styles.label}>Mode</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <button onClick={() => switchMode('batch')} style={{ ...modeBtnStyle(mode === 'batch') }}>📋 Batch</button>
            <button onClick={() => switchMode('inspi')} style={{ ...modeBtnStyle(mode === 'inspi') }}>✨ Inspiration</button>
          </div>

          <label style={styles.label}>{mode === 'inspi' ? 'Export Notion LIFESTYLE (.zip)' : 'Export Notion (.zip)'}</label>
          <Dropzone
            files={zips}
            onChange={handleZipChange}
            accept=".zip,application/zip,application/x-zip-compressed"
            label="Glisse ton export Notion"
            hint={mode === 'inspi' ? "ZIP avec LOOK (LIFESTYLE).csv + Models Definition.csv + images + références" : "ZIP avec LOOK*.csv + Models Definition*.csv + Fonds*.csv + images"}
            minHeight={120}
          />

          <div>
            <label style={styles.label}>Limiter aux N premiers looks (optionnel)</label>
            <input
              type="number"
              min={1}
              value={lookLimit}
              onChange={e => setLookLimit(e.target.value)}
              placeholder="ex. 10 (vide = tout traiter)"
              style={{ ...styles.select, padding: '8px 10px' }}
            />
            <p style={{ ...styles.hintSubtle, marginTop: 4 }}>
              Pratique pour tester un gros ZIP : ne traite que les N premiers looks. Re-dépose le ZIP après avoir changé cette valeur.
            </p>
          </div>

          {parsing && <p style={styles.hintSubtle}>{progress || 'Lecture et indexation du zip…'}</p>}

          {parsed && (
            <div style={styles.statsBox}>
              <div><strong>{parsed.looks.length}</strong> look(s) · <strong>{parsed.models.size}</strong> mannequin(s) · <strong>{parsed.fonds.size}</strong> fond(s)</div>
              <div style={{ marginTop: 4 }}><strong>{parsed.tasks.length}</strong> visuel(s) · <strong>{enabledCount}</strong> sélectionné(s)</div>
              {parsed.warnings.length > 0 && (
                <div style={{ ...styles.warningRow, marginTop: 6 }}>⚠ {parsed.warnings.join(' · ')}</div>
              )}
            </div>
          )}

          {globalError && <p style={styles.errorBox}>⚠ {globalError}</p>}

          {parsed && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={styles.label}>Format</label>
                  <select value={ratio} onChange={e => setRatio(e.target.value)} style={styles.select}>
                    {['9:16','3:4','1:1','16:9','4:3'].map(r => <option key={r}>{r}</option>)}
                  </select>
                </div>
                <div>
                  <label style={styles.label}>Résolution</label>
                  <select value={quality} onChange={e => setQuality(e.target.value)} style={styles.select}>
                    {['1K','2K','4K'].map(q => <option key={q}>{q}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label style={styles.label}>Parallélisme</label>
                <select value={concurrency} onChange={e => setConcurrency(Number(e.target.value))} style={styles.select}>
                  <option value={1}>1 (séquentiel — le plus sûr)</option>
                  <option value={2}>2 en parallèle (recommandé sur Gemini preview)</option>
                  <option value={3}>3 en parallèle</option>
                  <option value={5}>5 en parallèle (risque de rate-limit)</option>
                  <option value={8}>8 en parallèle (agressif)</option>
                </select>
              </div>

              <label style={{ ...styles.label, display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0, fontSize: 13, fontWeight: 600, color: '#0D4A5C', cursor: 'pointer' }}>
                <input type="checkbox" checked={coherenceMode} onChange={e => setCoherenceMode(e.target.checked)} />
                🎯 Cohérence entre poses d'un même look
              </label>
              <p style={styles.hintSubtle}>
                <strong>Désactivé par défaut</strong> : chaque pose est générée indépendamment avec le fond + mannequin envoyés fraîchement (fond toujours fidèle à la référence — comme la plateforme principale).
                <br /><br />
                Si activé : les poses 2/3/4 utilisent la pose 1 comme base, ce qui améliore la cohérence visuelle entre poses mais peut faire dériver le fond.
              </p>

              <label style={{ ...styles.label, display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0, fontSize: 13, fontWeight: 600, color: '#0D4A5C', cursor: 'pointer' }}>
                <input type="checkbox" checked={twoStepMode} onChange={e => setTwoStepMode(e.target.checked)} />
                🧪 Mode 2 étapes (test)
              </label>
              <p style={styles.hintSubtle}>
                Step 1 : génère le mannequin + tenue + pose sur fond BLANC neutre. Step 2 : applique le fond exact de référence par swap Gemini. <strong>2 appels API par visuel</strong> (double coût + double temps) mais le fond final est garanti fidèle.
                <br />
                Pour les close-up haut : le fond est croppé aux 30 % du haut (mur uniquement, pas de sol).
              </p>

              <button onClick={handleRunAll} disabled={running || enabledCount === 0} style={{ ...styles.btn, opacity: running || enabledCount === 0 ? 0.6 : 1 }}>
                {running ? (progress || 'Génération…') : `▶ Tout générer (${enabledCount})`}
              </button>

              {states.some(s => s.status === 'done') && !running && (
                <button onClick={exportZip} style={styles.btnSecondary}>⬇ Télécharger les résultats en ZIP</button>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => toggleAllStates(true)}  style={styles.btnGhost}>Tout cocher</button>
                <button onClick={() => toggleAllStates(false)} style={styles.btnGhost}>Tout décocher</button>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setExpanded(Object.fromEntries(groupedLooks.map(g => [g.lookId, true])))}  style={styles.btnGhost}>Tout déplier</button>
                <button onClick={() => setExpanded({})}                                                          style={styles.btnGhost}>Tout replier</button>
              </div>
            </>
          )}
        </div>

        {/* Liste des looks groupés */}
        <div>
          {!parsed && (
            <div style={styles.catalogBox}>
              <h3 style={styles.catalogTitle}>📥 Comment ça marche</h3>
              <p style={styles.catalogIntro}>
                Dépose ton export Notion à gauche. Dans tes cellules "Vue et Pose X", utilise le format <code style={styles.kbd}>Vue, pose</code> — par exemple <code style={styles.kbd}>Front, nonchalante</code> ou <code style={styles.kbd}>Side, regard</code>.
              </p>

              <h4 style={styles.catalogSection}>Vues disponibles ({VIEW_CATALOG.length})</h4>
              <div style={styles.catalogGrid}>
                {VIEW_CATALOG.map(v => (
                  <div key={v.key} style={styles.catalogItem}>
                    <code style={styles.catalogKey}>{v.label}</code>
                    <div style={styles.catalogDesc}>{v.description}</div>
                  </div>
                ))}
              </div>

              <h4 style={styles.catalogSection}>Poses disponibles ({POSE_CATALOG.length})</h4>
              <div style={styles.catalogGrid}>
                {POSE_CATALOG.map(p => (
                  <div key={p.key} style={styles.catalogItem}>
                    <code style={styles.catalogKey}>{p.key}</code>
                    <div style={styles.catalogDesc}>{p.description}</div>
                  </div>
                ))}
              </div>

              <p style={styles.catalogFooter}>
                💡 <strong>{VIEW_CATALOG.length} × {POSE_CATALOG.length} = {VIEW_CATALOG.length * POSE_CATALOG.length} combinaisons possibles.</strong> Tu peux étendre ce catalogue en éditant <code style={styles.kbd}>lib/poses.ts</code>.
              </p>
            </div>
          )}

          {parsed && groupedLooks.length === 0 && (
            <div style={styles.emptyState}>
              Aucun visuel valide trouvé. Vérifie que les lignes ont bien un Mannequin, un Fond et au moins une "Vue et Pose".
            </div>
          )}

          {groupedLooks.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {groupedLooks.map(g => (
                <LookGroup
                  key={g.lookId}
                  tasks={g.tasks}
                  open={!!expanded[g.lookId]}
                  onToggleOpen={() => setLookExpansion(g.lookId, !expanded[g.lookId])}
                  onToggleLook={(value) => toggleLook(g.lookId, value)}
                  onToggleTask={(id) => toggleTask(id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ============================== LookGroup (accordion par look) ============================== */

function LookGroup({
  tasks, open, onToggleOpen, onToggleLook, onToggleTask,
}: {
  tasks: TaskState[]
  open: boolean
  onToggleOpen: () => void
  onToggleLook: (value: boolean) => void
  onToggleTask: (id: string) => void
}) {
  const first = tasks[0].task
  const enabledN = tasks.filter(t => t.enabled).length
  const doneN    = tasks.filter(t => t.status === 'done').length
  const errN     = tasks.filter(t => t.status === 'error').length
  const runningN = tasks.filter(t => t.status === 'running').length

  // Checkbox 3 états : tout coché / aucun coché / mixte
  const allChecked  = enabledN === tasks.length
  const noneChecked = enabledN === 0
  const indeterminate = !allChecked && !noneChecked

  return (
    <div style={lookCardStyle}>
      {/* Header look */}
      <div style={lookHeader}>
        <Indeterminate3StateCheckbox
          checked={allChecked}
          indeterminate={indeterminate}
          onChange={() => onToggleLook(!allChecked)}
        />
        <div style={{ flex: 1, cursor: 'pointer' }} onClick={onToggleOpen}>
          <div style={{ fontWeight: 700, color: '#0D4A5C', fontSize: 14 }}>
            <span style={{ color: '#6B7A8A', fontWeight: 500 }}>Look #</span>{first.numeroLook} ·{' '}
            <span>{first.mannequinName}</span> ·{' '}
            <span>{first.fondName}</span>
          </div>
          <div style={{ fontSize: 11, color: '#6B7A8A', marginTop: 2 }}>
            {tasks.filter(t => t.task.taskType === 'pose').length} pose(s)
            {tasks.some(t => t.task.taskType === 'detail') && ` · ${tasks.filter(t => t.task.taskType === 'detail').length} détail(s)`}
            {' '}· {enabledN} sélectionnée(s) ·
            {' '}<span style={{ color: '#1F7A35' }}>{doneN} générée(s)</span>
            {runningN > 0 && <span style={{ color: '#0D4A5C' }}> · {runningN} en cours</span>}
            {errN     > 0 && <span style={{ color: '#9B1C1C' }}> · {errN} erreur(s)</span>}
          </div>
        </div>
        <button onClick={onToggleOpen} style={chevron}>{open ? '▾' : '▸'}</button>
      </div>

      {/* Liste des tâches (vues) si déplié */}
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          {tasks.map(t => (
            <TaskRow key={t.task.id} state={t} onToggle={() => onToggleTask(t.task.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

/* ============================== TaskRow ============================== */

function TaskRow({ state, onToggle }: { state: TaskState, onToggle: () => void }) {
  const { task, status, imageUrl, imageUrlStep1, error, enabled } = state
  const color =
    status === 'done'    ? '#1F7A35'
    : status === 'error' ? '#9B1C1C'
    : status === 'running'? '#0D4A5C'
    : '#6B7A8A'

  const isDetail = task.taskType === 'detail'
  const isInspi  = task.taskType === 'inspi'
  const headline = isInspi
    ? `✨ Inspiration — Look ${task.numeroLook}`
    : isDetail
      ? `🔬 Détail ${(task.detailIndex ?? 0) + 1} — ${task.detailName ?? ''}`
      : task.vueRaw ?? ''

  return (
    <div style={taskRowStyle}>
      <input
        type="checkbox"
        checked={enabled}
        onChange={onToggle}
        disabled={status === 'running'}
      />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#0D4A5C' }}>{headline}</div>
        <div style={{ fontSize: 11, color: '#6B7A8A', marginTop: 2 }}>
          ID <code>{task.id}</code> · {task.refs.length} ref(s) image · type <strong>{task.taskType}</strong>
        </div>
        {task.warnings.length > 0 && (
          <div style={{ ...styles.warningRow, marginTop: 4 }}>⚠ {task.warnings.join(' · ')}</div>
        )}
        {error && <div style={{ ...styles.errorBox, marginTop: 4 }}>⚠ {error}</div>}

        {isInspi && (
          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, marginTop: 6, alignItems: 'start' }}>
            {task.inspirationFile && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <InspirationThumb file={task.inspirationFile} />
                <div style={{ fontSize: 9, color: '#6B7A8A', textAlign: 'center' }}>inspi</div>
                {(task.extraInspiDetails ?? []).map((f, i) => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
                    <InspirationThumb file={f} />
                    <div style={{ fontSize: 9, color: '#6B7A8A', textAlign: 'center' }}>détail {i + 1}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {state.extractedEnv && (
                <div style={inspiBox}>
                  <div style={inspiLabel}>Environnement extrait</div>
                  <div style={inspiText}>{state.extractedEnv}</div>
                </div>
              )}
              {state.extractedPose && (
                <div style={inspiBox}>
                  <div style={inspiLabel}>Pose extraite</div>
                  <div style={inspiText}>{state.extractedPose}</div>
                </div>
              )}
              {task.bgOverride && (
                <div style={overrideBox}>
                  <div style={overrideLabel}>🎯 Override background</div>
                  <div style={inspiText}>{task.bgOverride}</div>
                </div>
              )}
              {task.viewOverride && (
                <div style={overrideBox}>
                  <div style={overrideLabel}>🎯 Override vue / pose</div>
                  <div style={inspiText}>{task.viewOverride}</div>
                </div>
              )}
              {!state.extractedEnv && !state.extractedPose && status === 'pending' && (
                <div style={{ fontSize: 11, color: '#6B7A8A', fontStyle: 'italic' }}>
                  L'extraction de l'environnement et de la pose se fera au lancement.
                </div>
              )}
            </div>
          </div>
        )}

        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', fontSize: 10, color: '#6B7A8A', fontWeight: 600 }}>
            Voir le prompt envoyé
          </summary>
          <pre style={styles.promptPre}>{task.prompt}</pre>
        </details>
      </div>

      <span style={{ ...statusPill, color, borderColor: color }}>{labelForStatus(status)}</span>

      {(imageUrl || imageUrlStep1) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
          {imageUrlStep1 && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
              <img src={imageUrlStep1} alt={`${task.id}-step1`} style={{ width: 110, borderRadius: 6, border: '1px solid rgba(13,74,92,0.1)' }} />
              <div style={{ fontSize: 9, color: '#6B7A8A', fontWeight: 600 }}>Step 1 · fond blanc</div>
              <div style={{ display: 'flex', gap: 4 }}>
                <a href={imageUrlStep1} download={`look_${task.numeroLook}_vue${(task.vueIndex ?? 0) + 1}_step1.png`} style={styles.linkBtnDark}>⬇</a>
                <a href={imageUrlStep1} target="_blank" rel="noreferrer" style={styles.linkBtnLight}>↗</a>
              </div>
            </div>
          )}
          {imageUrl && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
              <img src={imageUrl} alt={task.id} style={{ width: 110, borderRadius: 6, border: '1px solid rgba(13,74,92,0.1)' }} />
              {imageUrlStep1 && <div style={{ fontSize: 9, color: '#1F7A35', fontWeight: 700 }}>Step 2 · fond final</div>}
              <div style={{ display: 'flex', gap: 4 }}>
                <a href={imageUrl} download={
                  task.taskType === 'detail'
                    ? `look_${task.numeroLook}_detail${(task.detailIndex ?? 0) + 1}.png`
                    : `look_${task.numeroLook}_vue${(task.vueIndex ?? 0) + 1}.png`
                } style={styles.linkBtnDark}>⬇</a>
                <a href={imageUrl} target="_blank" rel="noreferrer" style={styles.linkBtnLight}>↗</a>
              </div>
            </div>
          )}
          {state.faceWasAvailable && (
            state.faceUsed
              ? <span style={facePreservedBadge} title="La face photo du mannequin a bien été envoyée à Gemini (1re tentative).">✓ visage préservé</span>
              : <span style={faceDroppedBadge} title={`La face photo a été droppée au ${state.finalAttempt ?? '?'}e essai pour passer le filtre IMAGE_SAFETY de Gemini. Le visage généré est cohérent mais peut différer de la référence portrait.`}>⚠ visage régénéré (essai {state.finalAttempt ?? '?'})</span>
          )}
          {state.faceWasAvailable === false && state.imageUrl && (
            <span style={faceNoneBadge} title="Aucune face photo n'était fournie dans le Models Definition pour ce mannequin.">— pas de face photo</span>
          )}
        </div>
      )}
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
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      style={{ width: 16, height: 16, cursor: 'pointer' }}
    />
  )
}

/* ============================== utils ============================== */

function InspirationThumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])
  if (!url) return null
  return (
    <img src={url} alt={file.name} style={{ width: '100%', borderRadius: 6, border: '1px solid rgba(13,74,92,0.1)', display: 'block' }} />
  )
}

const inspiBox: React.CSSProperties = {
  background: '#FAFBFC',
  border: '1px solid rgba(13,74,92,0.1)',
  borderRadius: 7,
  padding: 8,
}
const inspiLabel: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  color: '#6B7A8A',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 4,
}
const inspiText: React.CSSProperties = {
  fontSize: 11,
  color: '#0D4A5C',
  lineHeight: 1.45,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

const overrideBox: React.CSSProperties = {
  background: '#FFF8E1',
  border: '1px solid #F1D78A',
  borderRadius: 7,
  padding: 8,
}
const overrideLabel: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  color: '#7A4F00',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 4,
}

function labelForStatus(s: TaskStatus): string {
  switch (s) {
    case 'pending': return '○ en attente'
    case 'running': return '⏳ en cours'
    case 'done':    return '✓ terminé'
    case 'error':   return '⚠ erreur'
    case 'skipped': return '— sauté'
  }
}

function truncate(s: string, max = 240) {
  if (!s) return ''
  return s.length > max ? s.slice(0, max) + '…' : s
}

function slug(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

function modeBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: '10px',
    background: active ? '#0D4A5C' : '#fff',
    color: active ? '#C8F07D' : '#0D4A5C',
    border: '1px solid',
    borderColor: active ? '#0D4A5C' : 'rgba(13,74,92,0.2)',
    borderRadius: 7,
    fontSize: 13,
    fontWeight: active ? 700 : 600,
    cursor: 'pointer',
    fontFamily: 'system-ui',
  }
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl)
  return await res.blob()
}

async function dataUrlToFile(dataUrl: string, filename: string): Promise<File> {
  const blob = await dataUrlToBlob(dataUrl)
  const ext  = blob.type.includes('png') ? 'png' : 'jpg'
  const safe = filename.endsWith(`.${ext}`) ? filename : `${filename}.${ext}`
  return new File([blob], safe, { type: blob.type || 'image/png' })
}

/* ============================== styles ============================== */

const lookCardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid rgba(13,74,92,0.1)',
  borderRadius: 12,
  padding: 14,
}

const lookHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
}

const chevron: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: 18,
  color: '#0D4A5C',
  padding: '0 6px',
}

const taskRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: 10,
  background: '#F5F7F9',
  border: '1px solid rgba(13,74,92,0.06)',
  borderRadius: 8,
}

const statusPill: React.CSSProperties = {
  display: 'inline-block',
  padding: '3px 8px',
  border: '1px solid',
  borderRadius: 999,
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  whiteSpace: 'nowrap',
}

const styles: Record<string, React.CSSProperties> = {
  title:       { fontFamily: 'system-ui', fontSize: 22, fontWeight: 700, color: '#0D4A5C', marginBottom: 4 },
  sub:         { fontSize: 13, color: '#6B7A8A', marginBottom: 24, lineHeight: 1.5 },
  card:        { background: '#fff', borderRadius: 12, padding: 20, border: '1px solid rgba(13,74,92,0.1)', display: 'flex', flexDirection: 'column', gap: 12 },
  label:       { fontSize: 11, fontWeight: 700, color: '#6B7A8A', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: 4 },
  select:      { width: '100%', padding: '8px 10px', border: '1px solid rgba(13,74,92,0.15)', borderRadius: 7, fontSize: 13, fontFamily: 'system-ui', background: '#fff' },
  btn:         { padding: '12px', background: '#0D4A5C', color: '#C8F07D', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'system-ui' },
  btnSecondary:{ padding: '9px', background: '#fff', color: '#0D4A5C', border: '1px solid rgba(13,74,92,0.25)', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'system-ui' },
  btnGhost:    { flex: 1, padding: '7px', background: 'transparent', color: '#0D4A5C', border: '1px dashed rgba(13,74,92,0.25)', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'system-ui' },
  emptyState:  { textAlign: 'center', padding: '60px 24px', color: '#6B7A8A', fontSize: 14, border: '1px dashed rgba(13,74,92,0.2)', borderRadius: 12, background: '#fff', lineHeight: 1.5 },
  errorBox:    { background: '#FDECEC', color: '#9B1C1C', border: '1px solid #F5C2C2', padding: '8px 10px', borderRadius: 7, fontSize: 12, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  warningRow:  { background: '#FFF8E1', color: '#7A4F00', border: '1px solid #F1D78A', padding: '6px 10px', borderRadius: 6, fontSize: 11 },
  hintSubtle:  { fontSize: 11, color: '#6B7A8A', margin: 0 },
  statsBox:    { background: '#E8F2F5', color: '#0D4A5C', borderRadius: 8, padding: '10px 12px', fontSize: 12, lineHeight: 1.5 },
  promptPre:   { margin: '6px 0 0', background: '#fff', borderRadius: 6, padding: 10, fontSize: 11, color: '#0D4A5C', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 200, overflow: 'auto', border: '1px solid rgba(13,74,92,0.08)' },
  linkBtnDark: { padding: '4px 8px', fontSize: 11, color: '#fff', background: '#0D4A5C', borderRadius: 4, textDecoration: 'none', fontWeight: 600, textAlign: 'center' },
  linkBtnLight:{ padding: '4px 8px', fontSize: 11, color: '#0D4A5C', border: '1px solid rgba(13,74,92,0.2)', borderRadius: 4, textDecoration: 'none', fontWeight: 600, textAlign: 'center' },
  catalogBox:     { background: '#fff', border: '1px solid rgba(13,74,92,0.1)', borderRadius: 12, padding: 24 },
  catalogTitle:   { fontSize: 18, fontWeight: 700, color: '#0D4A5C', margin: '0 0 6px' },
  catalogIntro:   { fontSize: 13, color: '#0D4A5C', margin: '0 0 18px', lineHeight: 1.55 },
  catalogSection: { fontSize: 11, fontWeight: 700, color: '#6B7A8A', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '14px 0 8px' },
  catalogGrid:    { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 },
  catalogItem:    { background: '#F5F7F9', border: '1px solid rgba(13,74,92,0.06)', borderRadius: 8, padding: 10 },
  catalogKey:     { display: 'inline-block', background: '#0D4A5C', color: '#C8F07D', padding: '2px 7px', borderRadius: 4, fontSize: 12, fontWeight: 700, marginBottom: 5, fontFamily: 'monospace' },
  catalogDesc:    { fontSize: 12, color: '#0D4A5C', lineHeight: 1.45 },
  catalogFooter:  { fontSize: 12, color: '#6B7A8A', marginTop: 16, marginBottom: 0, lineHeight: 1.5, padding: '10px 12px', background: '#E8F2F5', borderRadius: 6 },
  kbd:            { background: '#E8F2F5', padding: '1px 6px', borderRadius: 4, fontFamily: 'monospace', fontSize: 12, color: '#0D4A5C', border: '1px solid rgba(13,74,92,0.1)' },
}

const facePreservedBadge: React.CSSProperties = {
  display: 'inline-block', padding: '3px 7px',
  background: '#DCF3E2', color: '#1F7A35', border: '1px solid #B7E4C3',
  borderRadius: 4, fontSize: 10, fontWeight: 700, textAlign: 'center', cursor: 'help',
}
const faceDroppedBadge: React.CSSProperties = {
  display: 'inline-block', padding: '3px 7px',
  background: '#FFF8E1', color: '#7A4F00', border: '1px solid #F1D78A',
  borderRadius: 4, fontSize: 10, fontWeight: 700, textAlign: 'center', cursor: 'help',
}
const faceNoneBadge: React.CSSProperties = {
  display: 'inline-block', padding: '3px 7px',
  background: '#F5F7F9', color: '#6B7A8A', border: '1px solid rgba(13,74,92,0.15)',
  borderRadius: 4, fontSize: 10, fontWeight: 600, textAlign: 'center', cursor: 'help',
}
