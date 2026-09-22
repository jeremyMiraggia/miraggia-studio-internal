'use client'
/**
 * Onglet 🥇 Golden Silver — batch lifestyle depuis un ZIP Notion.
 *
 * UN visuel de FACE par look :
 *   IMAGE 1 = Files (Front), IMAGE 2 = FACE PHOTO du mannequin,
 *   IMAGE 3 = Details (optionnel, guide de fidélité du vêtement, pas une sortie).
 *   prompt = REFERENCES fixe (pieds + chaussures identiques) + description du
 *   décor (Notion) + "Detail texte" optionnel + TECHNICAL (ratio).
 * Mannequin et décor : colonnes Model / Décor du LOOK, sinon tirage aléatoire
 * (re-tirable).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import { upload } from '@vercel/blob/client'
import Dropzone from '@/components/ui/Dropzone'
import { compressImage } from '@/lib/compressImage'
import { parseGoldSilverExport, normName, type GSExport, type GSTask, type GSModel } from '@/lib/notion/parseGoldSilverExport'
import { buildGoldSilverPrompt, buildGoldSilverBackPrompt } from '@/lib/goldSilverPrompt'

type SubMode = 'front' | 'back'

type TaskStatus = 'pending' | 'running' | 'done' | 'saved' | 'error' | 'skipped'
type State = {
  task:      GSTask
  status:    TaskStatus
  enabled:   boolean
  imageUrl?: string
  versions:  string[]     // historique des générations (dernière = imageUrl)
  masks?:    Array<{ masked: boolean; maskedUrl?: string; note?: string }>   // état du masquage par photo Front
  error?:    string
}

/** Vignette d'une image du ZIP, extraite à la demande. */
function InputThumb({ getFile, zipKey, label }: { getFile: (k: string) => Promise<File | undefined>; zipKey: string; label: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    let obj: string | null = null
    getFile(zipKey).then(f => {
      if (!alive || !f) return
      obj = URL.createObjectURL(f)
      setUrl(obj)
    }).catch(() => {})
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj) }
  }, [getFile, zipKey])
  return (
    <div>
      <div style={{ fontSize: 9, color: '#9CA3AF' }}>{label}</div>
      {url
        ? <img src={url} alt={label} style={{ width: '100%', borderRadius: 4, display: 'block', aspectRatio: '3/4', objectFit: 'cover' }} />
        : <div style={{ aspectRatio: '3/4', background: '#F3F4F6', borderRadius: 4 }} />}
    </div>
  )
}

function sanitizeFilename(s: string): string {
  return s.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 80) || 'visual'
}
async function ensureWritePermission(handle: any): Promise<boolean> {
  try {
    const opts = { mode: 'readwrite' as const }
    const q = await handle.queryPermission?.(opts) ?? 'prompt'
    if (q === 'granted') return true
    return (await handle.requestPermission?.(opts) ?? 'denied') === 'granted'
  } catch { return false }
}

export default function GoldSilverTab() {
  // Sous-onglet : 'front' = tenue + mannequin + décor → visuel de face
  //               'back'  = visuel de face final + tenue de dos → visuel de dos
  const [subMode, setSubMode]   = useState<SubMode>('front')
  const [zips, setZips]         = useState<File[]>([])
  const [parsing, setParsing]   = useState(false)
  const [parsed, setParsed]     = useState<GSExport | null>(null)
  const [states, setStates]     = useState<State[]>([])
  const statesRef               = useRef<State[]>([])
  const [error, setError]       = useState<string | null>(null)
  const [progress, setProgress] = useState('')

  const [ratio, setRatio]       = useState('2:3')
  const [quality, setQuality]   = useState('2K')
  const [concurrency, setConcurrency] = useState(2)
  // Masquer visage + cheveux du mannequin d'origine sur les photos de tenue portée
  const [maskFaces, setMaskFaces] = useState(true)

  // Descriptions courtes des mannequins (générées UNE fois, cache localStorage, éditables)
  type ModelDesc = { text: string; status: 'pending' | 'running' | 'done' | 'error'; error?: string; fromCache?: boolean }
  const [modelDescs, setModelDescs] = useState<Record<string, ModelDesc>>({})
  const modelDescsRef = useRef<Record<string, ModelDesc>>({})
  const setDesc = (name: string, patch: Partial<ModelDesc>) => {
    setModelDescs(prev => {
      const next = { ...prev, [name]: { ...(prev[name] ?? { text: '', status: 'pending' as const }), ...patch } }
      modelDescsRef.current = next
      return next
    })
  }
  const descCacheKey = (m: GSModel) => `gs-model-desc:${normName(m.name)}:${(m.faceKey ?? '').split('/').pop()}`
  const describeModel = async (m: GSModel, force = false) => {
    if (!m.faceKey) return
    const key = descCacheKey(m)
    if (!force) {
      try {
        const cached = localStorage.getItem(key)
        if (cached) { setDesc(m.name, { text: cached, status: 'done', fromCache: true }); return }
      } catch { /* pas de localStorage */ }
    }
    setDesc(m.name, { status: 'running', error: undefined })
    try {
      const [faceUrl, bodyUrl] = await Promise.all([uploadKey(m.faceKey), m.bodyKey ? uploadKey(m.bodyKey) : Promise.resolve('')])
      const r = await fetch('/api/studio/gold-silver/describe-model', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ faceUrl, bodyUrl: bodyUrl || undefined, name: m.name }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setDesc(m.name, { text: j.description, status: 'done', fromCache: false })
      try { localStorage.setItem(key, j.description) } catch { /* ignore */ }
    } catch (e: any) {
      setDesc(m.name, { status: 'error', error: e?.message ?? String(e) })
    }
  }
  const editDesc = (m: GSModel, text: string) => {
    setDesc(m.name, { text, status: 'done' })
    try { localStorage.setItem(descCacheKey(m), text) } catch { /* ignore */ }
  }
  // Au chargement d'un ZIP : décrit chaque mannequin (cache localStorage sinon Gemini Flash)
  useEffect(() => {
    if (!parsed) return
    setModelDescs({}); modelDescsRef.current = {}
    for (const m of parsed.models) if (m.faceKey) describeModel(m)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed])
  const [running, setRunning]   = useState(false)
  const [zipping, setZipping]   = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)

  const outputDirHandleRef = useRef<any | null>(null)
  const [outputDirName, setOutputDirName] = useState<string | null>(null)
  const [savedCount, setSavedCount] = useState(0)

  // Tirages aléatoires par look (quand la colonne est vide ou introuvable), re-tirables
  const [randomPick, setRandomPick] = useState<Record<string, { model?: string; decor?: string }>>({})
  const pickRandom = <T extends { name: string }>(arr: T[]): T | undefined =>
    arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined
  const rollLook = (t: GSTask, res: GSExport) => {
    const modelOk = !!t.modelName && res.models.some(m => normName(m.name) === normName(t.modelName!) && m.faceKey)
    const decorOk = !!t.decorName && res.decors.some(d => normName(d.name) === normName(t.decorName!))
    return {
      model: modelOk ? undefined : pickRandom(res.models.filter(m => m.faceKey))?.name,
      decor: decorOk ? undefined : pickRandom(res.decors)?.name,
    }
  }
  const rerollLook = (lookId: string) => {
    if (!parsed) return
    const t = parsed.tasks.find(x => x.lookId === lookId)
    if (t) {
      setRandomPick(prev => ({ ...prev, [lookId]: rollLook(t, parsed) }))
      setOverrides(prev => { const n = { ...prev }; delete n[lookId]; return n })
      invalidateLook(lookId)
    }
  }

  // Cache des uploads Blob (clé ZIP → URL) : un visage sert à toutes les vues
  const urlCacheRef = useRef<Map<string, Promise<string>>>(new Map())
  const uploadKey = (key: string): Promise<string> => {
    const cache = urlCacheRef.current
    let p = cache.get(key)
    if (!p) {
      p = (async () => {
        const f = await parsed!.getFile(key)
        if (!f) throw new Error(`Fichier ZIP introuvable : ${key}`)
        let file = f
        try { file = await compressImage(f, { maxSide: 2048, quality: 0.9 }) } catch { /* brut */ }
        const b = await upload(`gold-silver-inputs/${Date.now()}-${file.name}`, file, {
          access: 'public', handleUploadUrl: '/api/blob-upload', contentType: file.type || 'application/octet-stream',
        })
        return b.url
      })()
      cache.set(key, p)
      p.catch(() => cache.delete(key))
    }
    return p
  }

  /* ----------- Parse ZIP ----------- */
  const handleZipChange = async (files: File[]) => {
    setZips(files); setError(null); setParsed(null); setStates([]); urlCacheRef.current.clear()
    if (files.length === 0) return
    setParsing(true); setProgress('Lecture du ZIP…')
    try {
      const res = await parseGoldSilverExport(files[0], msg => setProgress(msg))
      setParsed(res)
      const ns: State[] = res.tasks.map(t => ({ task: t, status: 'pending', enabled: true, versions: [] }))
      setStates(ns); statesRef.current = ns
      // Tirages aléatoires initiaux
      const picks: Record<string, { model?: string; decor?: string }> = {}
      for (const t of res.tasks) picks[t.lookId] = rollLook(t, res)
      setRandomPick(picks)
      setOverrides({})
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setParsing(false); setProgress('')
    }
  }

  /* ----------- Résolution mannequin / décor : choix manuel > colonne du LOOK > tirage aléatoire ----------- */
  const [overrides, setOverrides] = useState<Record<string, { model?: string; decor?: string }>>({})
  /** Le mannequin / décor d'un look a changé → la carte repasse en attente (les versions sont gardées). */
  const invalidateLook = (lookId: string) => setStates(prev => {
    const next = prev.map(s => s.task.lookId === lookId && s.status !== 'running'
      ? { ...s, status: 'pending' as TaskStatus, enabled: true, error: undefined, imageUrl: undefined, masks: undefined }
      : s)
    statesRef.current = next
    return next
  })
  const setOverride = (lookId: string, patch: { model?: string; decor?: string }) => {
    setOverrides(prev => ({ ...prev, [lookId]: { ...(prev[lookId] ?? {}), ...patch } }))
    invalidateLook(lookId)
  }
  const effectiveModelName = (t: GSTask) => overrides[t.lookId]?.model ?? randomPick[t.lookId]?.model ?? t.modelName
  const effectiveDecorName = (t: GSTask) => overrides[t.lookId]?.decor ?? randomPick[t.lookId]?.decor ?? t.decorName
  type Source = 'manuel' | 'aléatoire' | 'colonne' | 'aucun'
  const modelSource = (t: GSTask): Source => overrides[t.lookId]?.model ? 'manuel' : randomPick[t.lookId]?.model ? 'aléatoire' : t.modelName ? 'colonne' : 'aucun'
  const decorSource = (t: GSTask): Source => overrides[t.lookId]?.decor ? 'manuel' : randomPick[t.lookId]?.decor ? 'aléatoire' : t.decorName ? 'colonne' : 'aucun'
  const resolveModel = (t: GSTask) => {
    const n = effectiveModelName(t)
    return n ? parsed?.models.find(m => normName(m.name) === normName(n)) : undefined
  }
  const resolveDecor = (t: GSTask) => {
    const n = effectiveDecorName(t)
    return n ? parsed?.decors.find(d => normName(d.name) === normName(n)) : undefined
  }

  /* ----------- Dossier sortie ----------- */
  const pickOutputDir = async () => {
    try {
      // @ts-ignore
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
      if (!(await ensureWritePermission(handle))) { setError('Permission readwrite refusée.'); return }
      outputDirHandleRef.current = handle
      setOutputDirName(handle.name ?? 'dossier'); setSavedCount(0)
    } catch (e: any) {
      if (e?.name !== 'AbortError') setError(`Sélection dossier : ${e?.message ?? e}`)
    }
  }
  const fileNameFor = (s: State, version: number) =>
    `${sanitizeFilename(s.task.sku)}${subMode === 'back' ? '_back' : ''}${version > 1 ? `_${version}` : ''}.jpg`

  // Changer de sous-onglet remet toutes les cartes en attente (les visuels sont d'un autre type)
  const switchSubMode = (m: SubMode) => {
    if (m === subMode || running) return
    setSubMode(m)
    setStates(prev => {
      const next = prev.map(s => ({ ...s, status: 'pending' as TaskStatus, enabled: true, error: undefined, imageUrl: undefined, versions: [], masks: undefined }))
      statesRef.current = next
      return next
    })
    setSavedCount(0)
  }

  const writeToOutputDir = async (s: State, url: string, version: number): Promise<boolean> => {
    const handle = outputDirHandleRef.current
    if (!handle) return false
    try {
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`Fetch HTTP ${resp.status}`)
      const blob = await resp.blob()
      const fh = await handle.getFileHandle(fileNameFor(s, version), { create: true })
      const w = await fh.createWritable(); await w.write(blob); await w.close()
      return true
    } catch (e: any) {
      console.warn('[Gold&Silver] write failed', e?.message)
      return false
    }
  }

  /* ----------- Génération ----------- */
  const generateOne = async (idx: number) => {
    const state = statesRef.current[idx]
    if (!state || !parsed) return
    const t = state.task
    const model = resolveModel(t)
    const decor = resolveDecor(t)
    const fail = (msg: string, status: TaskStatus = 'skipped') => setStates(prev => {
      const next = [...prev]; next[idx] = { ...next[idx], status, error: msg }; statesRef.current = next; return next
    })

    // ===== Sous-onglet BACK : image 1 = visuel de face final, images 2.. = tenue de dos =====
    if (subMode === 'back') {
      if (t.outfitKeys.length === 0) return fail('Files (Front) vide — il faut le visuel de face final.')
      if (t.backKeys.length === 0)   return fail('Files (Back) vide — aucune photo de la tenue de dos.')
      setStates(prev => { const next = [...prev]; next[idx] = { ...next[idx], status: 'running', error: undefined }; statesRef.current = next; return next })
      try {
        const [frontVisualUrl, backUrls] = await Promise.all([
          uploadKey(t.outfitKeys[0]),                 // le visuel de face FINAL (première image de Files (Front))
          Promise.all(t.backKeys.map(uploadKey)),
        ])
        const mName = model?.name
        if (mName) for (let i = 0; i < 40 && modelDescsRef.current[mName]?.status === 'running'; i++) await new Promise(r => setTimeout(r, 500))
        const modelDescription = mName && modelDescsRef.current[mName]?.status === 'done' ? modelDescsRef.current[mName].text : undefined
        const prompt = buildGoldSilverBackPrompt({ ratio, sku: t.sku, backCount: backUrls.length, detailText: t.detailText, modelDescription })
        const resp = await fetch('/api/studio/gold-silver', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'back', frontVisualUrl, outfitUrls: backUrls, prompt, ratio, quality, sku: `${t.sku}_back`, maskFaces }),
        })
        const text = await resp.text()
        let json: any
        try { json = JSON.parse(text) } catch { throw new Error(`HTTP ${resp.status} : ${text.replace(/<[^>]+>/g, ' ').trim().slice(0, 160)}`) }
        if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`)
        const url: string = json.imageUrl
        if (!url) throw new Error('Réponse sans URL.')
        const version = (statesRef.current[idx]?.versions.length ?? 0) + 1
        setStates(prev => {
          const next = [...prev]
          next[idx] = { ...next[idx], status: 'done', imageUrl: url, versions: [...next[idx].versions, url], masks: Array.isArray(json.masks) ? json.masks : undefined }
          statesRef.current = next; return next
        })
        if (outputDirHandleRef.current) {
          const saved = await writeToOutputDir(statesRef.current[idx], url, version)
          if (saved) {
            setSavedCount(c => c + 1)
            setStates(prev => { const next = [...prev]; next[idx] = { ...next[idx], status: 'saved' }; statesRef.current = next; return next })
          }
        }
      } catch (e: any) {
        fail(e?.message ?? String(e), 'error')
      }
      return
    }

    if (!model)          return fail('Aucun mannequin disponible (colonne vide et Models Definition vide).')
    if (!model.faceKey)  return fail(`Mannequin "${model.name}" sans FACE PHOTO dans le ZIP.`)
    if (!decor)          return fail('Aucun décor disponible (colonne vide et Decors Definition vide).')

    setStates(prev => { const next = [...prev]; next[idx] = { ...next[idx], status: 'running', error: undefined }; statesRef.current = next; return next })
    try {
      const [outfitUrls, faceUrl, bodyUrl, detailUrls] = await Promise.all([
        Promise.all(t.outfitKeys.map(uploadKey)),
        uploadKey(model.faceKey),
        model.bodyKey ? uploadKey(model.bodyKey) : Promise.resolve(''),
        Promise.all(t.detailKeys.map(uploadKey)),
      ])
      // Description du mannequin : on attend si elle est encore en cours (max ~20 s)
      for (let i = 0; i < 40 && modelDescsRef.current[model.name]?.status === 'running'; i++) {
        await new Promise(r => setTimeout(r, 500))
      }
      const modelDescription = modelDescsRef.current[model.name]?.status === 'done' ? modelDescsRef.current[model.name].text : undefined
      const prompt = buildGoldSilverPrompt({
        decorName: decor.name, decorDescription: decor.description, ratio, sku: t.sku, detailText: t.detailText,
        outfitCount: outfitUrls.length, hasBody: !!bodyUrl, detailCount: detailUrls.length, modelDescription,
      })
      const resp = await fetch('/api/studio/gold-silver', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outfitUrls, faceUrl, bodyUrl: bodyUrl || undefined, detailUrls, prompt, ratio, quality, sku: t.sku, maskFaces }),
      })
      const text = await resp.text()
      let json: any
      try { json = JSON.parse(text) } catch { throw new Error(`HTTP ${resp.status} : ${text.replace(/<[^>]+>/g, ' ').trim().slice(0, 160)}`) }
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`)
      const url: string = json.imageUrl
      if (!url) throw new Error('Réponse sans URL.')

      const version = (statesRef.current[idx]?.versions.length ?? 0) + 1
      setStates(prev => {
        const next = [...prev]
        next[idx] = { ...next[idx], status: 'done', imageUrl: url, versions: [...next[idx].versions, url], masks: Array.isArray(json.masks) ? json.masks : undefined }
        statesRef.current = next; return next
      })
      if (outputDirHandleRef.current) {
        const saved = await writeToOutputDir(statesRef.current[idx], url, version)
        if (saved) {
          setSavedCount(c => c + 1)
          setStates(prev => { const next = [...prev]; next[idx] = { ...next[idx], status: 'saved' }; statesRef.current = next; return next })
        }
      }
    } catch (e: any) {
      fail(e?.message ?? String(e), 'error')
    }
  }

  const runGeneration = async () => {
    if (running || !parsed) return
    if (statesRef.current.length === 0) { setError('Aucune tâche. Drop un ZIP Notion.'); return }
    setRunning(true); setError(null)
    setStates(prev => {
      const next = prev.map(s => (s.status === 'done' || s.status === 'saved') ? s : { ...s, status: 'pending' as TaskStatus, error: undefined })
      statesRef.current = next; return next
    })
    const todo = statesRef.current.map((s, idx) => ({ s, idx })).filter(({ s }) => s.enabled && s.status !== 'done' && s.status !== 'saved')
    const pool = Math.max(1, Math.min(concurrency, 6))
    let cursor = 0
    await Promise.all(Array.from({ length: pool }, async () => {
      while (cursor < todo.length) {
        const my = cursor++
        setProgress(`Génération ${my + 1}/${todo.length}…`)
        await generateOne(todo[my].idx)
      }
    }))
    setProgress(''); setRunning(false)
  }

  const regenerate = async (taskId: string) => {
    const idx = statesRef.current.findIndex(s => s.task.id === taskId)
    if (idx < 0 || running) return
    await generateOne(idx)
  }

  /* ----------- ZIP ----------- */
  const downloadZip = async () => {
    const done = statesRef.current.filter(s => s.versions.length > 0)
    if (done.length === 0) { setError('Aucun visuel généré.'); return }
    setZipping(true); setError(null)
    try {
      const zip = new JSZip()
      for (const s of done) {
        for (let v = 0; v < s.versions.length; v++) {
          try {
            const resp = await fetch(s.versions[v]); if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
            zip.file(fileNameFor(s, v + 1), await resp.blob())
          } catch (e) { console.warn('[Gold&Silver] zip skip', s.task.id, e) }
        }
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `gold_silver_${Date.now()}.zip`; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (e: any) { setError(`ZIP : ${e?.message ?? e}`) }
    finally { setZipping(false) }
  }

  /* ----------- Toggles / stats ----------- */
  const toggleTask = (id: string) => setStates(prev => { const next = prev.map(s => s.task.id === id ? { ...s, enabled: !s.enabled } : s); statesRef.current = next; return next })
  const setAllEnabled = (v: boolean) => setStates(prev => { const next = prev.map(s => ({ ...s, enabled: v })); statesRef.current = next; return next })

  const stats = useMemo(() => ({
    total: states.length,
    enabled: states.filter(s => s.enabled).length,
    done: states.filter(s => s.status === 'done' || s.status === 'saved').length,
    saved: states.filter(s => s.status === 'saved').length,
    errors: states.filter(s => s.status === 'error' || s.status === 'skipped').length,
    running: states.filter(s => s.status === 'running').length,
    toRun: states.filter(s => s.enabled && s.status !== 'done' && s.status !== 'saved').length,
  }), [states])

  const [previewDecor, setPreviewDecor] = useState('')
  const previewPrompt = useMemo(() => {
    if (subMode === 'back') {
      return buildGoldSilverBackPrompt({ ratio, sku: 'SKU', backCount: 2, modelDescription: '(description du mannequin, générée ci-dessus)' })
    }
    const decor = parsed?.decors.find(d => normName(d.name) === normName(previewDecor)) ?? parsed?.decors[0]
    if (!decor) return ''
    return buildGoldSilverPrompt({ decorName: decor.name, decorDescription: decor.description, ratio, sku: 'SKU', outfitCount: 2, hasBody: true, detailCount: 1, modelDescription: '(description du mannequin choisi, générée ci-dessus)' })
  }, [parsed, previewDecor, ratio, subMode])

  const estCost = (stats.toRun * (quality === '4K' ? 0.24 : quality === '1K' ? 0.13 : 0.13)).toFixed(2)

  /* ----------- Styles ----------- */
  const card: React.CSSProperties = { border: '1px solid #E5E7EB', borderRadius: 12, padding: 16, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }
  const label: React.CSSProperties = { fontSize: 12, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 6 }
  const inp: React.CSSProperties = { border: '1px solid #D1D5DB', borderRadius: 8, padding: '6px 10px', fontSize: 14, minHeight: 34, background: '#fff', width: '100%' }
  const btn = (bg: string, color = '#fff'): React.CSSProperties => ({ background: bg, color, border: 'none', borderRadius: 8, padding: '8px 16px', fontWeight: 600, fontSize: 14, cursor: 'pointer' })
  const pill = (bg: string, color = '#fff'): React.CSSProperties => ({ background: bg, color, borderRadius: 999, padding: '2px 8px', fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 22 }}>🥇</span>
          <h2 style={{ margin: 0, color: '#0D4A5C', fontSize: 18 }}>Golden Silver — Lifestyle depuis Notion</h2>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, background: '#F3F4F6', padding: 3, borderRadius: 8 }}>
            {(['front', 'back'] as SubMode[]).map(m => (
              <button key={m} onClick={() => switchSubMode(m)} disabled={running} style={{
                padding: '6px 14px', border: 'none', borderRadius: 6, cursor: running ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600,
                background: subMode === m ? '#0D4A5C' : 'transparent', color: subMode === m ? '#C8F07D' : '#374151',
              }}>{m === 'front' ? '🧍 Face' : '🔄 Back'}</button>
            ))}
          </div>
        </div>
        {subMode === 'front' ? (
          <p style={{ fontSize: 13, color: '#6B7280', margin: 0 }}>
            Un visuel <strong>de face</strong> par ligne. Entrées : toutes les photos <code>Files (Front)</code> (la tenue portée), puis <code>FACE PHOTO</code> + <code>FRONT-model</code> du mannequin, puis <code>Details</code> si présents — uniquement pour guider la fidélité du vêtement.
            Prompt = REFERENCES (pieds et chaussures identiques toujours visibles, mannequin grande et élancée) + description du décor + ratio. Mannequin et décor : colonnes <code>Model</code> / <code>Décor</code> du look, sinon <strong>tirage aléatoire 🎲</strong>. Colonne <code>Detail texte</code> ajoutée au prompt si présente.
          </p>
        ) : (
          <p style={{ fontSize: 13, color: '#6B7280', margin: 0 }}>
            Un visuel <strong>de dos</strong> par ligne. <strong>Image 1</strong> = <code>Files (Front)</code> = le visuel de face <strong>final</strong> (mannequin, décor, lumière et style à conserver). <strong>Images 2…</strong> = <code>Files (Back)</code> = la tenue vue de dos (une ou plusieurs photos).
            Prompt : même mannequin, même lieu, même lumière, vue de dos, pose naturelle et décontractée, pieds et chaussures visibles. Les tableaux Mannequin / Décor ne servent qu'à la description du mannequin.
          </p>
        )}
      </div>

      <div style={card}>
        <div style={label}>1 — ZIP Notion</div>
        <Dropzone files={zips} onChange={handleZipChange} accept=".zip" multiple={false}
                  label="Drop le ZIP Notion ici" hint="Export complet : LOOK (LIFESTYLE) + Models Definition + Decors Definition — taille illimitée" />
        {parsing && <div style={{ marginTop: 8, fontSize: 13, color: '#0D4A5C' }}>⏳ {progress}</div>}
        {parsed && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#374151', background: '#F9FAFB', padding: 8, borderRadius: 6 }}>
            ✓ {states.length} look(s) → {states.length} visuel(s) de face, {parsed.models.length} mannequin(s), {parsed.decors.length} décor(s).
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer', fontSize: 11 }}>{parsed.warnings.length} note(s) de lecture</summary>
              <ul style={{ fontSize: 11, color: '#6B7280', margin: '4px 0', paddingLeft: 16 }}>{parsed.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </details>
          </div>
        )}
      </div>

      {parsed && parsed.models.length > 0 && (
        <div style={card}>
          <div style={label}>Mannequins — description courte (générée une fois, réutilisée dans chaque prompt)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10 }}>
            {parsed.models.map(m => {
              const d = modelDescs[m.name]
              return (
                <div key={m.name} style={{ border: '1px solid #E5E7EB', borderRadius: 8, padding: 8, display: 'grid', gridTemplateColumns: '64px 1fr', gap: 8 }}>
                  <div>
                    {m.faceKey ? <InputThumb getFile={parsed.getFile} zipKey={m.faceKey} label="" /> : <div style={{ fontSize: 10, color: '#991B1B' }}>sans visage</div>}
                  </div>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <strong style={{ fontSize: 12, color: '#0D4A5C' }}>{m.name}</strong>
                      {d?.status === 'running' && <span style={pill('#F59E0B')}>⏳ analyse</span>}
                      {d?.status === 'done' && <span style={pill(d.fromCache ? '#E5E7EB' : '#DCFCE7', d.fromCache ? '#374151' : '#166534')}>{d.fromCache ? 'cache' : 'généré'}</span>}
                      {d?.status === 'error' && <span style={pill('#FEE2E2', '#991B1B')} title={d.error}>✕ {d.error?.slice(0, 40)}</span>}
                      {m.faceKey && d?.status !== 'running' && (
                        <button onClick={() => describeModel(m, true)} style={{ marginLeft: 'auto', background: 'none', border: '1px solid #E5E7EB', borderRadius: 6, cursor: 'pointer', fontSize: 11, padding: '2px 6px' }}>↺ regénérer</button>
                      )}
                    </div>
                    <textarea value={d?.text ?? ''} onChange={e => editDesc(m, e.target.value)} placeholder={d?.status === 'running' ? 'Analyse en cours…' : 'Description (éditable)'}
                              style={{ width: '100%', minHeight: 88, fontSize: 11, lineHeight: 1.4, border: '1px solid #E5E7EB', borderRadius: 6, padding: 6, boxSizing: 'border-box', fontFamily: 'system-ui', resize: 'vertical' }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div style={card}>
        <div style={label}>2 — Paramètres</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Ratio</div>
            <select value={ratio} onChange={e => setRatio(e.target.value)} style={inp}>
              <option value="2:3">2:3 (éditorial)</option>
              <option value="3:4">3:4</option>
              <option value="4:5">4:5 (Insta feed)</option>
              <option value="9:16">9:16</option>
              <option value="1:1">1:1</option>
              <option value="3:2">3:2 (paysage)</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Qualité</div>
            <select value={quality} onChange={e => setQuality(e.target.value)} style={inp}>
              <option value="1K">1K</option><option value="2K">2K</option><option value="4K">4K</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Parallèle</div>
            <select value={concurrency} onChange={e => setConcurrency(parseInt(e.target.value, 10))} style={inp}>
              {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
        <label style={{ marginTop: 12, fontSize: 12, color: '#0D4A5C', display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={maskFaces} onChange={e => setMaskFaces(e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            <strong>Masquer visage + cheveux du mannequin d'origine</strong> sur les photos de tenue portée{subMode === 'back' ? ' (photos de dos — souvent pas de visage détecté, c\'est normal)' : ''}
            <span style={{ display: 'block', fontSize: 11, color: '#6B7A8A' }}>
              Détection par Gemini Flash (~0,001 $/photo), pixelisation de la tête, vêtement intact. Vêtement non porté (à plat, packshot) → rien n'est masqué. Les photos masquées telles qu'envoyées s'affichent sous chaque résultat.
            </span>
          </span>
        </label>
        {previewPrompt && (
          <details style={{ marginTop: 10 }} open={showPrompt} onToggle={e => setShowPrompt((e.target as HTMLDetailsElement).open)}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: '#0D4A5C' }}>
              Voir le prompt assemblé{subMode === 'back' ? ' (dos)' : ''}
              {subMode === 'front' && (
                <>
                  {' — '}
                  <select value={previewDecor || parsed?.decors[0]?.name || ''} onChange={e => setPreviewDecor(e.target.value)}
                          onClick={e => e.stopPropagation()} style={{ fontSize: 12 }}>
                    {parsed?.decors.map(d => <option key={d.name} value={d.name}>{d.name}</option>)}
                  </select>
                </>
              )}
            </summary>
            <pre style={{ fontSize: 11, background: '#F9FAFB', padding: 10, borderRadius: 6, whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' }}>{previewPrompt}</pre>
          </details>
        )}
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button onClick={pickOutputDir} style={btn('#0D4A5C')}>📁 {outputDirName ? `Dossier : ${outputDirName}` : 'Choisir dossier de sortie'}</button>
          {outputDirName && <button onClick={() => { outputDirHandleRef.current = null; setOutputDirName(null); setSavedCount(0) }} style={btn('#E5E7EB', '#374151')}>✕ Retirer</button>}
          {outputDirName && <span style={{ fontSize: 12, color: '#6B7280' }}>Sauvegarde live : <strong style={{ color: '#10B981' }}>{savedCount}</strong></span>}
        </div>
      </div>

      {states.length > 0 && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
            <div style={label}>3 — Visuels ({stats.enabled}/{stats.total} cochés · ✓ {stats.done} · 💾 {stats.saved} · ⏳ {stats.running} · ✕ {stats.errors})</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button onClick={() => setAllEnabled(true)} style={btn('#E5E7EB', '#374151')}>☑ Tout</button>
              <button onClick={() => setAllEnabled(false)} style={btn('#E5E7EB', '#374151')}>☐ Rien</button>
              <button onClick={downloadZip} disabled={zipping || stats.done === 0} style={{ ...btn(stats.done === 0 ? '#9CA3AF' : '#374151'), cursor: stats.done === 0 ? 'not-allowed' : 'pointer' }}>
                {zipping ? '⏳ ZIP…' : '⬇ ZIP'}
              </button>
              <button onClick={runGeneration} disabled={running || stats.toRun === 0}
                      style={{ ...btn(running || stats.toRun === 0 ? '#9CA3AF' : '#0D4A5C'), cursor: running || stats.toRun === 0 ? 'not-allowed' : 'pointer' }}>
                {running ? `⏳ ${progress || 'Génération…'}` : `🚀 Générer ${stats.toRun} visuel${stats.toRun > 1 ? 's' : ''} (≈ ${estCost} $)`}
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
            {states.map(s => {
              const t0 = s.task
              const lookId = t0.lookId
              const modelOk = !!resolveModel(t0)?.faceKey
              const decorOk = !!resolveDecor(t0)
              const modelLbl = effectiveModelName(t0) ?? ''
              const decorLbl = effectiveDecorName(t0) ?? ''
              const mSrc = modelSource(t0), dSrc = decorSource(t0)
              const srcStyle = (s: Source) => s === 'manuel' ? '#DBEAFE' : s === 'aléatoire' ? '#FEF3C7' : s === 'colonne' ? '#E8F2F5' : '#FEE2E2'
              const selStyle: React.CSSProperties = { fontSize: 11, padding: '2px 4px', border: '1px solid #D1D5DB', borderRadius: 6, background: '#fff', maxWidth: 140 }
              return (
                <div key={s.task.id} style={{ border: '1px solid #E5E7EB', borderRadius: 8, padding: 10, background: s.enabled ? '#fff' : '#F9FAFB', opacity: s.enabled ? 1 : 0.55 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                    <input type="checkbox" checked={s.enabled} onChange={() => toggleTask(s.task.id)} style={{ width: 16, height: 16, cursor: 'pointer' }} />
                    {s.status === 'pending' && <span style={pill('#9CA3AF')}>•</span>}
                    {s.status === 'running' && <span style={pill('#F59E0B')}>⏳</span>}
                    {s.status === 'done'    && <span style={pill('#3B82F6')}>✓</span>}
                    {s.status === 'saved'   && <span style={pill('#10B981')}>💾</span>}
                    {s.status === 'error'   && <span style={pill('#EF4444')}>✕</span>}
                    {s.status === 'skipped' && <span style={pill('#6B7280')}>⊘</span>}
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#0D4A5C' }}>
                      <span style={{ color: '#6B7280', fontWeight: 500 }}>#{lookId}</span> · {t0.sku}
                    </div>
                    {s.versions.length > 1 && <span style={{ fontSize: 10, color: '#6B7280' }}>v{s.versions.length}</span>}
                    {(s.status === 'done' || s.status === 'saved' || s.status === 'error') && !running && (
                      <button onClick={() => regenerate(s.task.id)} title="Regénérer (nouvelle version, l'ancienne est gardée)"
                              style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14 }}>↺</button>
                    )}
                  </div>
                  {subMode === 'back' ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                    <span style={pill(t0.outfitKeys.length ? '#E8F2F5' : '#FEE2E2', t0.outfitKeys.length ? '#0D4A5C' : '#991B1B')}>🧍 {t0.outfitKeys.length ? 'visuel face final' : 'pas de visuel face'}</span>
                    <span style={pill(t0.backKeys.length ? '#DCFCE7' : '#FEE2E2', t0.backKeys.length ? '#166534' : '#991B1B')}>🔄 {t0.backKeys.length ? `${t0.backKeys.length} photo${t0.backKeys.length > 1 ? 's' : ''} de dos` : 'pas de photo de dos'}</span>
                    {t0.detailText && <span style={pill('#EDE9FE', '#5B21B6')} title={t0.detailText}>📝 détail texte</span>}
                  </div>
                  ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: srcStyle(mSrc), borderRadius: 999, padding: '2px 6px 2px 8px' }} title={`Mannequin : ${mSrc}`}>
                      <span style={{ fontSize: 11 }}>👤</span>
                      <select value={modelLbl} onChange={e => setOverride(lookId, { model: e.target.value || undefined })} disabled={running} style={selStyle}>
                        {!modelLbl && <option value="">— aucun —</option>}
                        {parsed!.models.filter(m => m.faceKey).map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
                      </select>
                      <span style={{ fontSize: 9, color: '#6B7280' }}>{mSrc === 'manuel' ? '✎' : mSrc === 'aléatoire' ? '🎲' : mSrc === 'colonne' ? '📋' : '⚠'}</span>
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: srcStyle(dSrc), borderRadius: 999, padding: '2px 6px 2px 8px' }} title={`Décor : ${dSrc}`}>
                      <span style={{ fontSize: 11 }}>🏞</span>
                      <select value={decorLbl} onChange={e => setOverride(lookId, { decor: e.target.value || undefined })} disabled={running} style={selStyle}>
                        {!decorLbl && <option value="">— aucun —</option>}
                        {parsed!.decors.map(d => <option key={d.name} value={d.name}>{d.name}</option>)}
                      </select>
                      <span style={{ fontSize: 9, color: '#6B7280' }}>{dSrc === 'manuel' ? '✎' : dSrc === 'aléatoire' ? '🎲' : dSrc === 'colonne' ? '📋' : '⚠'}</span>
                    </span>
                    {(mSrc === 'aléatoire' || dSrc === 'aléatoire' || mSrc === 'manuel' || dSrc === 'manuel') && !running && (
                      <button onClick={() => rerollLook(lookId)} title="Re-tirer au sort (efface le choix manuel)"
                              style={{ background: 'none', border: '1px solid #E5E7EB', borderRadius: 6, cursor: 'pointer', fontSize: 11, padding: '2px 6px' }}>
                        🎲
                      </button>
                    )}
                    {(!modelOk || !decorOk) && <span style={pill('#FEE2E2', '#991B1B')}>{!modelOk ? 'mannequin invalide' : 'décor invalide'}</span>}
                    {t0.detailText && <span style={pill('#EDE9FE', '#5B21B6')} title={t0.detailText}>📝 détail texte</span>}
                    <span style={pill('#E5E7EB', '#374151')}>🧥 {t0.outfitKeys.length} front</span>
                    <span style={pill(t0.detailKeys.length ? '#DCFCE7' : '#F3F4F6', t0.detailKeys.length ? '#166534' : '#6B7280')}>
                      {t0.detailKeys.length ? `🔍 ${t0.detailKeys.length} détail${t0.detailKeys.length > 1 ? 's' : ''} en guide` : 'sans détail'}
                    </span>
                  </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8 }}>
                    <div style={{ fontSize: 10, color: '#6B7280' }}>
                      <div style={{ marginBottom: 2 }}>Entrées → 1 sortie</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                        {subMode === 'back' ? (
                          <>
                            {t0.outfitKeys[0] && <InputThumb key={t0.outfitKeys[0]} getFile={parsed!.getFile} zipKey={t0.outfitKeys[0]} label="Face final" />}
                            {t0.backKeys.map((k, i) => <InputThumb key={k} getFile={parsed!.getFile} zipKey={k} label={t0.backKeys.length > 1 ? `Dos ${i + 1}` : 'Dos'} />)}
                          </>
                        ) : (
                          <>
                            {t0.outfitKeys.map((k, i) => <InputThumb key={k} getFile={parsed!.getFile} zipKey={k} label={t0.outfitKeys.length > 1 ? `Front ${i + 1}` : 'Front'} />)}
                            {resolveModel(t0)?.faceKey && <InputThumb key={resolveModel(t0)!.faceKey} getFile={parsed!.getFile} zipKey={resolveModel(t0)!.faceKey!} label="Visage" />}
                            {resolveModel(t0)?.bodyKey && <InputThumb key={resolveModel(t0)!.bodyKey} getFile={parsed!.getFile} zipKey={resolveModel(t0)!.bodyKey!} label="Corps" />}
                            {t0.detailKeys.map((k, i) => <InputThumb key={k} getFile={parsed!.getFile} zipKey={k} label={`Détail ${i + 1}`} />)}
                          </>
                        )}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: '#10B981', marginBottom: 2 }}>Sortie ({subMode === 'back' ? 'dos' : 'face'})</div>
                      {s.imageUrl ? (
                        <a href={s.imageUrl} target="_blank" rel="noreferrer">
                          <img src={s.imageUrl} alt={s.task.id} style={{ width: '100%', borderRadius: 4, display: 'block' }} />
                        </a>
                      ) : (
                        <div style={{ fontSize: 10, color: '#9CA3AF', padding: '28px 0', textAlign: 'center', border: '1px dashed #E5E7EB', borderRadius: 4 }}>—</div>
                      )}
                    </div>
                  </div>
                  {s.masks && s.masks.length > 0 && (
                    <div style={{ marginTop: 6, fontSize: 10, color: '#6B7280' }}>
                      <div style={{ marginBottom: 2 }}>
                        Tenue envoyée à Gemini : {s.masks.filter(m => m.masked).length}/{s.masks.length} tête(s) masquée(s)
                      </div>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {s.masks.map((m, i) => m.maskedUrl
                          ? <a key={i} href={m.maskedUrl} target="_blank" rel="noreferrer"><img src={m.maskedUrl} alt={`masked ${i + 1}`} style={{ height: 72, borderRadius: 4 }} /></a>
                          : <span key={i} style={pill('#F3F4F6', '#6B7280')} title={m.note}>front {i + 1} : {m.note ?? 'non masqué'}</span>)}
                      </div>
                    </div>
                  )}
                  {s.error && <div style={{ fontSize: 10, color: '#EF4444', marginTop: 4 }} title={s.error}>{s.error.slice(0, 120)}</div>}
                  {s.task.warnings.map((w, i) => <div key={i} style={{ fontSize: 10, color: '#B45309', marginTop: 2 }}>⚠ {w}</div>)}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {error && <div style={{ ...card, background: '#FEF2F2', color: '#991B1B' }}>❌ {error}</div>}
    </div>
  )
}
