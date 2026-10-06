'use client'
/**
 * Onglet 🩱 Lingerie — packshots produit → visuel porté, mannequin décrit en TEXTE
 * (aucune photo de mannequin : sinon Gemini bloque). Cadrage coupé à la bouche selon
 * le type : ensemble (→ haut des cuisses), pyjama (→ pieds), haut (→ ventre), bas (ventre → cuisses).
 * Passe par /api/studio/free en mode brut : le prompt envoyé est exactement celui affiché.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import { upload } from '@vercel/blob/client'
import {
  LINGERIE_TYPES, DEFAULT_LINGERIE_MODELS, DEFAULT_LINGERIE_BACKGROUND,
  MORPHOS, buildLingeriePrompt, ratioFor, posesFor, pickPose,
  type LingerieModel, type LingerieType, type Morpho, type PoseMode,
} from '@/lib/lingerie'

type Status = 'pending' | 'running' | 'done' | 'error'
type Ref = { file: File; thumb: string; url?: string }
type Look = {
  id: string; name: string; refs: Ref[]; type: LingerieType; modelId: string; morpho: Morpho
  /** Pose : neutre (catalogue) ou dynamique (pose tirée dans la bibliothèque, compatible avec le type) */
  poseMode: PoseMode; poseId: string
  status: Status; imageUrl?: string; versions: string[]; error?: string; showPrompt?: boolean
}

const MODELS_KEY = 'lingerie-models-v2'   // v2 : identité + cheveux + 3 morphologies
const RATIOS = ['auto', '3:4', '2:3', '4:5', '1:1', '9:16']

const baseName = (name: string) => name.replace(/\.[a-z0-9]+$/i, '').replace(/[\/\\:*?"<>|]/g, '_') || 'look'
const uid = () => Math.random().toString(36).slice(2, 10)

function loadModels(): LingerieModel[] {
  try {
    const raw = localStorage.getItem(MODELS_KEY)
    const arr = raw ? JSON.parse(raw) : null
    if (Array.isArray(arr) && arr.length && arr.every(m => m?.id && typeof m.identity === 'string' && typeof m.hair === 'string' && MORPHOS.every(x => typeof m.bodies?.[x.id] === 'string'))) return arr
  } catch { /* stockage indisponible */ }
  return DEFAULT_LINGERIE_MODELS
}

export default function LingerieTab() {
  const [looks, setLooks]           = useState<Look[]>([])
  const looksRef                    = useRef<Look[]>([])
  const [models, setModels]         = useState<LingerieModel[]>(DEFAULT_LINGERIE_MODELS)
  const [showModels, setShowModels] = useState(false)
  const [dropType, setDropType]     = useState<LingerieType | null>(null)
  const [defaultModel, setDefaultModel] = useState('random')
  const [defaultMorpho, setDefaultMorpho] = useState<Morpho>('middle')
  const [defaultPoseMode, setDefaultPoseMode] = useState<PoseMode>('neutre')
  const [grouping, setGrouping]     = useState<'per-file' | 'single'>('per-file')
  const [background, setBackground] = useState(DEFAULT_LINGERIE_BACKGROUND)
  // Image de fond (optionnelle, commune à tous les looks) — envoyée après les photos produit, jamais compressée
  const [bgImage, setBgImage] = useState<Ref | null>(null)
  const bgImageRef = useRef<Ref | null>(null)
  const bgUploadRef = useRef<{ file: File; url: Promise<string> } | null>(null)
  const bgInputRef = useRef<HTMLInputElement>(null)
  const [bgHover, setBgHover] = useState(false)
  const [direction, setDirection]   = useState('')
  const [ratioMode, setRatioMode]   = useState('auto')
  const [quality, setQuality]       = useState('2K')
  const [concurrency, setConcurrency] = useState(3)
  const [running, setRunning]       = useState(false)
  const [progress, setProgress]     = useState('')
  const [zipping, setZipping]       = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const [hover, setHover]           = useState(false)
  const newInputRef = useRef<HTMLInputElement>(null)
  const addToRef    = useRef<string | null>(null)
  const addInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setModels(loadModels()) }, [])
  const saveModels = (next: LingerieModel[]) => {
    setModels(next)
    try { localStorage.setItem(MODELS_KEY, JSON.stringify(next)) } catch { /* ignore */ }
  }

  const commit = (next: Look[]) => { looksRef.current = next; setLooks(next) }
  const patchLook = (id: string, patch: Partial<Look>) =>
    commit(looksRef.current.map(l => (l.id === id ? { ...l, ...patch } : l)))

  const pickModel = (exclude?: string) => {
    if (defaultModel !== 'random' && models.some(m => m.id === defaultModel)) return defaultModel
    const pool = models.length > 1 ? models.filter(m => m.id !== exclude) : models
    return pool[Math.floor(Math.random() * pool.length)]?.id ?? models[0]?.id
  }
  const modelOf = (l: Look) => models.find(m => m.id === l.modelId) ?? models[0]
  const ratioOf = (l: Look) => (ratioMode === 'auto' ? ratioFor(l.type) : ratioMode)
  const promptOf = (l: Look) => buildLingeriePrompt({
    type: l.type, model: modelOf(l), morpho: l.morpho, imageCount: l.refs.length, background, direction, ratio: ratioOf(l),
    poseMode: l.poseMode, poseId: l.poseId,
    hasBackgroundImage: !!bgImage,
  })

  /* ----------- Entrée ----------- */
  const toRefs = (files: File[]) => files.filter(f => f.type.startsWith('image/')).map(f => ({ file: f, thumb: URL.createObjectURL(f) }))
  const addLooks = (files: File[]) => {
    if (!dropType) { setError('Choisis d\'abord le type de produit (ensemble, pyjama, haut ou bas).'); return }
    const refs = toRefs(files)
    if (!refs.length) return
    const make = (r: Ref[]): Look => ({
      id: uid(), name: baseName(r[0].file.name), refs: r,
      type: dropType, modelId: pickModel(), morpho: defaultMorpho,
      poseMode: defaultPoseMode, poseId: pickPose(dropType),
      status: 'pending', versions: [],
    })
    const fresh = grouping === 'single' ? [make(refs)] : refs.map(r => make([r]))
    commit([...looksRef.current, ...fresh]); setError(null)
  }
  const addRefsTo = (id: string, files: File[]) => {
    const refs = toRefs(files)
    const l = looksRef.current.find(x => x.id === id)
    if (!refs.length || !l) return
    patchLook(id, { refs: [...l.refs, ...refs], status: l.status === 'running' ? 'running' : 'pending' })
  }
  const removeRef = (id: string, idx: number) => {
    const l = looksRef.current.find(x => x.id === id)
    if (!l) return
    URL.revokeObjectURL(l.refs[idx].thumb)
    const refs = l.refs.filter((_, i) => i !== idx)
    if (!refs.length) removeLook(id)
    else patchLook(id, { refs, status: 'pending' })
  }
  const removeLook = (id: string) => {
    looksRef.current.find(l => l.id === id)?.refs.forEach(r => URL.revokeObjectURL(r.thumb))
    commit(looksRef.current.filter(l => l.id !== id))
  }
  const clearAll = () => {
    looksRef.current.forEach(l => l.refs.forEach(r => URL.revokeObjectURL(r.thumb)))
    commit([])
  }

  /* ----------- Image de fond ----------- */
  const setBackgroundImage = (f: File | null) => {
    if (f && !f.type.startsWith('image/')) return
    if (bgImageRef.current) URL.revokeObjectURL(bgImageRef.current.thumb)
    const next = f ? { file: f, thumb: URL.createObjectURL(f) } : null
    bgImageRef.current = next; setBgImage(next); bgUploadRef.current = null
    // le texte « studio gris » par défaut n'a pas de sens avec une photo de fond → vidé, et remis si on retire la photo
    setBackground(prev => (next && prev.trim() === DEFAULT_LINGERIE_BACKGROUND ? '' : !next && !prev.trim() ? DEFAULT_LINGERIE_BACKGROUND : prev))
    // le fond change le visuel → les looks déjà faits repassent en attente (versions conservées)
    commit(looksRef.current.map(l => (l.status === 'done' ? { ...l, status: 'pending' } : l)))
  }
  /** Upload unique du fond (partagé par les générations parallèles), relancé si échec. */
  const backgroundUrl = (): Promise<string> | undefined => {
    const bg = bgImageRef.current
    if (!bg) return undefined
    if (bgUploadRef.current?.file !== bg.file) {
      const url = upload(`lingerie-backgrounds/${Date.now()}-${bg.file.name}`, bg.file, {
        access: 'public', handleUploadUrl: '/api/blob-upload', contentType: bg.file.type || 'application/octet-stream',
      }).then(b => b.url)
      url.catch(() => { if (bgUploadRef.current?.url === url) bgUploadRef.current = null })
      bgUploadRef.current = { file: bg.file, url }
    }
    return bgUploadRef.current.url
  }

  /* ----------- Génération ----------- */
  const runOne = async (id: string) => {
    const l = looksRef.current.find(x => x.id === id)
    if (!l) return
    patchLook(id, { status: 'running', error: undefined })
    try {
      // Upload direct navigateur → Blob (une seule fois par image, réutilisé pour ↺)
      const refs = [...l.refs]
      for (let i = 0; i < refs.length; i++) {
        if (refs[i].url) continue
        const f = refs[i].file
        const b = await upload(`lingerie-inputs/${Date.now()}-${f.name}`, f, {
          access: 'public', handleUploadUrl: '/api/blob-upload', contentType: f.type || 'application/octet-stream',
        })
        refs[i] = { ...refs[i], url: b.url }
      }
      patchLook(id, { refs })
      const bgUrl = await backgroundUrl()
      const cur = looksRef.current.find(x => x.id === id)!
      const res = await fetch('/api/studio/free', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: promptOf(cur), ratio: ratioOf(cur), quality, refUrls: [...refs.map(r => r.url), ...(bgUrl ? [bgUrl] : [])] }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      if (!j.imageUrl) throw new Error('Réponse sans image.')
      const now = looksRef.current.find(x => x.id === id)
      patchLook(id, { status: 'done', imageUrl: j.imageUrl, versions: [...(now?.versions ?? []), j.imageUrl] })
    } catch (e: any) {
      patchLook(id, { status: 'error', error: e?.message ?? String(e) })
    }
  }

  const run = async () => {
    if (running) return
    const todo = looksRef.current.filter(l => l.status !== 'done').map(l => l.id)
    if (!todo.length) return
    setRunning(true); setError(null)
    let cursor = 0
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 6)) }, async () => {
      while (cursor < todo.length) {
        const my = cursor++
        setProgress(`${my + 1}/${todo.length}`)
        await runOne(todo[my])
      }
    }))
    setProgress(''); setRunning(false)
  }

  const downloadZip = async () => {
    const done = looksRef.current.filter(l => l.versions.length)
    if (!done.length) return
    setZipping(true)
    try {
      const zip = new JSZip()
      const used = new Set<string>()
      for (const l of done) {
        for (let v = 0; v < l.versions.length; v++) {
          const r = await fetch(l.versions[v]); if (!r.ok) continue
          const blob = await r.blob()
          const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg'
          let name = `${l.name}-lingerie${v ? `_${v + 1}` : ''}.${ext}`, n = 2
          while (used.has(name)) name = `${l.name}-lingerie${v ? `_${v + 1}` : ''}-${n++}.${ext}`
          used.add(name); zip.file(name, blob)
        }
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `lingerie_${Date.now()}.zip`; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (e: any) { setError(`ZIP : ${e?.message ?? e}`) }
    finally { setZipping(false) }
  }

  const stats = useMemo(() => ({
    total: looks.length,
    done: looks.filter(l => l.status === 'done').length,
    errors: looks.filter(l => l.status === 'error').length,
    toRun: looks.filter(l => l.status !== 'done').length,
    withResult: looks.filter(l => l.versions.length).length,
  }), [looks])
  const estCost = (stats.toRun * (quality === '4K' ? 0.24 : 0.13)).toFixed(2)

  /* ----------- Mannequins ----------- */
  const updateModel = (id: string, patch: Partial<LingerieModel>) => saveModels(models.map(m => (m.id === id ? { ...m, ...patch } : m)))
  const addModel = () => saveModels([...models, {
    id: uid(), name: `Mannequin ${models.length + 1}`,
    identity: 'Adult woman, … years old, … (origin), height … m. Skin: … Jaw / chin …, lips …, closed mouth, neutral expression. Nails … No tattoos, no piercings, no jewelry.',
    hair: 'Long … hair, clearly visible in the image: it frames both sides of the neck and is swept BEHIND the shoulders, falling down her back. No strand falls in front of the shoulders, over the chest or over the product.',
    bodies: {
      mince:  'SLIM body (French size 34-36 / XS-S): shoulders …, small bust, flat stomach, narrow waist, slim hips, slender legs.',
      middle: 'MEDIUM body (French size 38-40 / M): shoulders …, medium bust, soft flat stomach, defined waist, rounded hips, natural thighs.',
      ronde:  'PLUS-SIZE CURVY body (French size 44-46 / XL): soft rounded shoulders and arms, full bust, softly rounded stomach, wide rounded hips, full thighs. Confident healthy plus-size catalogue model.',
    },
  }])
  const updateBody = (id: string, morpho: Morpho, text: string) => {
    const m = models.find(x => x.id === id)
    if (m) updateModel(id, { bodies: { ...m.bodies, [morpho]: text } })
  }
  const deleteModel = (id: string) => {
    if (models.length <= 1) return
    saveModels(models.filter(m => m.id !== id))
    if (defaultModel === id) setDefaultModel('random')
  }
  const resetModels = () => {
    if (!confirm('Revenir aux 5 mannequins par défaut ? Tes modifications et ajouts seront perdus.')) return
    saveModels(DEFAULT_LINGERIE_MODELS); setDefaultModel('random')
  }

  /* ----------- Styles ----------- */
  const card: React.CSSProperties = { border: '1px solid #E5E7EB', borderRadius: 12, padding: 16, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }
  const label: React.CSSProperties = { fontSize: 12, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 6 }
  const sub: React.CSSProperties = { fontSize: 11, color: '#6B7280', marginBottom: 4 }
  const inp: React.CSSProperties = { border: '1px solid #D1D5DB', borderRadius: 8, padding: '6px 10px', fontSize: 13, minHeight: 32, background: '#fff', width: '100%', boxSizing: 'border-box' }
  const area: React.CSSProperties = { ...inp, fontFamily: 'system-ui', lineHeight: 1.45, resize: 'vertical' }
  const btn = (bg: string, color = '#fff'): React.CSSProperties => ({ background: bg, color, border: 'none', borderRadius: 8, padding: '8px 16px', fontWeight: 600, fontSize: 14, cursor: 'pointer' })
  const small = (active = false): React.CSSProperties => ({ ...btn(active ? '#0D4A5C' : '#E5E7EB', active ? '#fff' : '#374151'), padding: '4px 10px', fontSize: 12 })
  const pill = (bg: string): React.CSSProperties => ({ background: bg, color: '#fff', borderRadius: 999, padding: '2px 8px', fontSize: 10, fontWeight: 600 })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 22 }}>🩱</span>
          <h2 style={{ margin: 0, color: '#0D4A5C', fontSize: 18 }}>Lingerie — packshot → porté, mannequin décrit en texte</h2>
        </div>
        <p style={{ fontSize: 13, color: '#6B7280', margin: 0 }}>
          Aucune photo de mannequin n'est envoyée (sinon Gemini bloque) : seulement les photos produit et une description détaillée du mannequin (identité, cheveux passés dans le dos, morphologie mince / middle / ronde au choix par look).
          Cadrage coupé à la bouche selon le type — ensemble : jusqu'en haut des cuisses · pyjama : jusqu'aux pieds · haut : jusqu'au ventre · bas : du ventre au haut des cuisses.
        </p>
      </div>

      {/* ---- 1. Produits ---- */}
      <div style={card}>
        <div style={label}>1 — Type de produit, puis photos</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 10 }}>
          {LINGERIE_TYPES.map(t => (
            <button key={t.id} onClick={() => { setDropType(t.id); setError(null) }}
                    style={{ ...btn(dropType === t.id ? '#0D4A5C' : '#F3F4F6', dropType === t.id ? '#fff' : '#374151'),
                             padding: '10px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                             border: dropType === t.id ? '1px solid #0D4A5C' : '1px solid #E5E7EB' }}>
              <span>{t.label}</span>
              <span style={{ fontSize: 10, fontWeight: 400, opacity: 0.8 }}>✂ {t.hint}</span>
            </button>
          ))}
        </div>
        <div
          onClick={() => dropType ? newInputRef.current?.click() : setError('Choisis d\'abord le type de produit (ensemble, pyjama, haut ou bas).')}
          onDrop={e => { e.preventDefault(); setHover(false); addLooks(Array.from(e.dataTransfer.files)) }}
          onDragOver={e => { e.preventDefault(); setHover(true) }}
          onDragLeave={e => { e.preventDefault(); setHover(false) }}
          style={{ border: `1.5px dashed ${hover ? '#0D4A5C' : 'rgba(13,74,92,0.25)'}`, background: hover ? '#E8F2F5' : '#FAFBFC',
                   borderRadius: 10, padding: 16, textAlign: 'center', cursor: dropType ? 'pointer' : 'not-allowed', opacity: dropType ? 1 : 0.55 }}
        >
          <div style={{ fontSize: 22, marginBottom: 6 }}>⬆</div>
          <div style={{ fontSize: 13, color: '#0D4A5C', fontWeight: 600 }}>
            {dropType ? `Glisse les packshots — ${LINGERIE_TYPES.find(t => t.id === dropType)!.label}` : 'Sélectionne un type ci-dessus pour déposer'}
          </div>
          <div style={{ fontSize: 11, color: '#6B7A8A' }}>
            {grouping === 'per-file' ? '1 photo = 1 look (ajoute d\'autres vues avec « + vue » sur la carte)' : 'toutes les photos déposées = 1 seul look'}
          </div>
          <input ref={newInputRef} type="file" multiple accept="image/*" style={{ display: 'none' }}
                 onChange={e => { addLooks(Array.from(e.target.files ?? [])); e.target.value = '' }} />
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => setGrouping('per-file')} style={small(grouping === 'per-file')}>1 photo = 1 look</button>
          <button onClick={() => setGrouping('single')} style={small(grouping === 'single')}>Tout = 1 look</button>
          <span style={{ fontSize: 11, color: '#9CA3AF', marginLeft: 6 }}>Le type reste modifiable sur chaque carte.</span>
        </div>
      </div>

      {/* ---- 2. Réglages ---- */}
      <div style={card}>
        <div style={label}>2 — Réglages</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <div>
            <div style={sub}>Mannequin par défaut</div>
            <select value={defaultModel} onChange={e => setDefaultModel(e.target.value)} style={inp}>
              <option value="random">🎲 Aléatoire</option>
              {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div>
            <div style={sub}>Morphologie par défaut</div>
            <select value={defaultMorpho} onChange={e => setDefaultMorpho(e.target.value as Morpho)} style={inp}>
              {MORPHOS.map(x => <option key={x.id} value={x.id}>{x.label} ({x.size})</option>)}
            </select>
          </div>
          <div>
            <div style={sub}>Pose par défaut</div>
            <select value={defaultPoseMode} onChange={e => setDefaultPoseMode(e.target.value as PoseMode)} style={inp}>
              <option value="neutre">🧍 Neutre (catalogue)</option>
              <option value="dynamique">💃 Dynamique (pose tirée par look)</option>
            </select>
          </div>
          <div>
            <div style={sub}>Ratio</div>
            <select value={ratioMode} onChange={e => setRatioMode(e.target.value)} style={inp}>
              {RATIOS.map(r => <option key={r} value={r}>{r === 'auto' ? 'Auto selon le type' : r}</option>)}
            </select>
          </div>
          <div>
            <div style={sub}>Qualité</div>
            <select value={quality} onChange={e => setQuality(e.target.value)} style={inp}>
              {['1K', '2K', '4K'].map(q => <option key={q} value={q}>{q}</option>)}
            </select>
          </div>
          <div>
            <div style={sub}>Parallèle</div>
            <select value={concurrency} onChange={e => setConcurrency(parseInt(e.target.value, 10))} style={inp}>
              {[1, 2, 3, 4, 6].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
          <div>
            <div style={sub}>Image de fond (optionnel, tous les looks) — reproduite derrière le mannequin</div>
            <div onDrop={e => { e.preventDefault(); setBgHover(false); setBackgroundImage(e.dataTransfer.files[0] ?? null) }}
                 onDragOver={e => { e.preventDefault(); setBgHover(true) }}
                 onDragLeave={e => { e.preventDefault(); setBgHover(false) }}
                 style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 8, borderRadius: 8, marginBottom: 8,
                          border: `1.5px dashed ${bgHover ? '#0D4A5C' : 'rgba(13,74,92,0.25)'}`, background: bgHover ? '#E8F2F5' : '#FAFBFC' }}>
              {bgImage
                ? <img src={bgImage.thumb} alt="fond" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 6, border: '1px solid #E5E7EB' }} />
                : <div style={{ width: 72, height: 72, borderRadius: 6, border: '1px dashed #D1D5DB', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, color: '#9CA3AF' }}>🖼</div>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: '#6B7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {bgImage ? bgImage.file.name : 'Glisse une photo du lieu / décor, ou clique'}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => bgInputRef.current?.click()} disabled={running} style={small()}>{bgImage ? 'Changer' : '＋ Ajouter un fond'}</button>
                  {bgImage && <button onClick={() => setBackgroundImage(null)} disabled={running} style={small()}>Retirer</button>}
                </div>
              </div>
              <input ref={bgInputRef} type="file" accept="image/*" style={{ display: 'none' }}
                     onChange={e => { setBackgroundImage(e.target.files?.[0] ?? null); e.target.value = '' }} />
            </div>
            <div style={{ ...sub, display: 'flex', justifyContent: 'space-between' }}>
              <span>{bgImage ? 'Notes fond & lumière (optionnel — la photo de fond fait foi)' : 'Fond & lumière'}</span>
              <button onClick={() => setBackground(bgImage ? '' : DEFAULT_LINGERIE_BACKGROUND)} style={{ ...small(), padding: '1px 8px', fontSize: 11 }}>{bgImage ? 'Vider' : '↺ défaut'}</button>
            </div>
            <textarea value={background} onChange={e => setBackground(e.target.value)} style={{ ...area, minHeight: 70 }}
                      placeholder={bgImage ? 'ex. lumière de fin de journée venant de la gauche' : ''} />
          </div>
          <div>
            <div style={sub}>Pose & attitude (optionnel, tous les looks) — remplace la pose catalogue par défaut</div>
            <textarea value={direction} onChange={e => setDirection(e.target.value)} placeholder="ex. légère rotation de trois-quarts, main gauche sur la hanche"
                      style={{ ...area, minHeight: 70 }} />
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <button onClick={() => setShowModels(s => !s)} style={small(showModels)}>
            👤 Mannequins ({models.length}) {showModels ? '▲' : '▼'}
          </button>
        </div>
        {showModels && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 11, color: '#6B7280' }}>
              Descriptions envoyées telles quelles à Gemini (en anglais, c'est mieux compris). Enregistrées dans ce navigateur.
            </div>
            {models.map(m => (
              <div key={m.id} style={{ border: '1px solid #E5E7EB', borderRadius: 8, padding: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                  <input value={m.name} onChange={e => updateModel(m.id, { name: e.target.value })} style={{ ...inp, width: 200, fontWeight: 600 }} />
                  <span style={{ fontSize: 11, color: '#9CA3AF' }}>mince · middle · ronde</span>
                  <button onClick={() => deleteModel(m.id)} disabled={models.length <= 1} style={{ ...small(), marginLeft: 'auto' }}>🗑 Supprimer</button>
                </div>
                <div style={sub}>Identité (âge, origine, peau, bouche, ongles)</div>
                <textarea value={m.identity} onChange={e => updateModel(m.id, { identity: e.target.value })} style={{ ...area, minHeight: 60, fontSize: 12 }} />
                <div style={{ ...sub, marginTop: 6 }}>Cheveux (visibles, passés derrière dans le dos)</div>
                <textarea value={m.hair} onChange={e => updateModel(m.id, { hair: e.target.value })} style={{ ...area, minHeight: 50, fontSize: 12 }} />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 6 }}>
                  {MORPHOS.map(x => (
                    <div key={x.id}>
                      <div style={sub}>Morphologie {x.label} ({x.size})</div>
                      <textarea value={m.bodies[x.id]} onChange={e => updateBody(m.id, x.id, e.target.value)} style={{ ...area, minHeight: 90, fontSize: 12 }} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={addModel} style={small()}>＋ Ajouter un mannequin</button>
              <button onClick={resetModels} style={small()}>↺ Revenir aux 5 par défaut</button>
            </div>
          </div>
        )}
      </div>

      {/* ---- 3. Looks ---- */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: looks.length ? 12 : 0 }}>
          <div style={{ ...label, marginBottom: 0 }}>3 — Looks ({stats.done}/{stats.total})</div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {stats.errors > 0 && <span style={{ fontSize: 12, color: '#B91C1C' }}>✕ {stats.errors} erreur(s) — relance pour réessayer</span>}
            {looks.length > 0 && <button onClick={clearAll} disabled={running} style={small()}>Vider</button>}
            <button onClick={downloadZip} disabled={zipping || stats.withResult === 0}
                    style={{ ...btn(stats.withResult === 0 ? '#9CA3AF' : '#374151'), cursor: stats.withResult === 0 ? 'not-allowed' : 'pointer' }}>
              {zipping ? '⏳ ZIP…' : `⬇ ZIP (${stats.withResult})`}
            </button>
            <button onClick={run} disabled={running || stats.toRun === 0}
                    style={{ ...btn(running || stats.toRun === 0 ? '#9CA3AF' : '#0D4A5C'), cursor: running || stats.toRun === 0 ? 'not-allowed' : 'pointer' }}>
              {running ? `⏳ Génération ${progress}…` : `🚀 Générer ${stats.toRun} look${stats.toRun > 1 ? 's' : ''} (≈ ${estCost} $)`}
            </button>
          </div>
        </div>
        {error && <div style={{ marginBottom: 10, background: '#FEF2F2', color: '#991B1B', padding: 8, borderRadius: 6, fontSize: 12 }}>❌ {error}</div>}

        <input ref={addInputRef} type="file" multiple accept="image/*" style={{ display: 'none' }}
               onChange={e => { if (addToRef.current) addRefsTo(addToRef.current, Array.from(e.target.files ?? [])); e.target.value = '' }} />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
          {looks.map(l => {
            const busy = l.status === 'running'
            const typeInfo = LINGERIE_TYPES.find(t => t.id === l.type)!
            return (
              <div key={l.id} style={{ border: '1px solid #E5E7EB', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {l.status === 'pending' && <span style={pill('#9CA3AF')}>•</span>}
                  {l.status === 'running' && <span style={pill('#F59E0B')}>⏳</span>}
                  {l.status === 'done'    && <span style={pill('#10B981')}>✓</span>}
                  {l.status === 'error'   && <span style={pill('#EF4444')}>✕</span>}
                  <input value={l.name} onChange={e => patchLook(l.id, { name: e.target.value.replace(/[\/\\:*?"<>|]/g, '_') })}
                         style={{ ...inp, minHeight: 26, padding: '2px 8px', fontWeight: 600 }} title="Nom du fichier de sortie" />
                  <button onClick={() => removeLook(l.id)} disabled={busy} title="Retirer le look"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, color: '#6B7280' }}>×</button>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  <div>
                    <select value={l.type} disabled={busy} style={{ ...inp, minHeight: 28, fontSize: 12 }}
                            onChange={e => {
                              const type = e.target.value as LingerieType
                              // pose incompatible avec le nouveau type → nouvelle pose tirée
                              const poseId = posesFor(type).some(p => p.id === l.poseId) ? l.poseId : pickPose(type)
                              patchLook(l.id, { type, poseId, status: 'pending' })
                            }}>
                      {LINGERIE_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                    <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 2 }}>✂ {typeInfo.hint} · {ratioOf(l)}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <select value={l.modelId} disabled={busy} onChange={e => patchLook(l.id, { modelId: e.target.value, status: 'pending' })} style={{ ...inp, minHeight: 28, fontSize: 12 }}>
                      {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                    <button onClick={() => {
                              const pool = models.filter(m => m.id !== l.modelId)
                              if (pool.length) patchLook(l.id, { modelId: pool[Math.floor(Math.random() * pool.length)].id, status: 'pending' })
                            }}
                            disabled={busy} title="Tirer un autre mannequin" style={{ ...small(), padding: '2px 8px' }}>🎲</button>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
                  {MORPHOS.map(x => (
                    <button key={x.id} disabled={busy} title={x.size}
                            onClick={() => { if (l.morpho !== x.id) patchLook(l.id, { morpho: x.id, status: 'pending' }) }}
                            style={{ ...small(l.morpho === x.id), padding: '3px 6px' }}>{x.label}</button>
                  ))}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                  {(['neutre', 'dynamique'] as PoseMode[]).map(m => (
                    <button key={m} disabled={busy}
                            onClick={() => { if (l.poseMode !== m) patchLook(l.id, { poseMode: m, status: 'pending' }) }}
                            style={{ ...small(l.poseMode === m), padding: '3px 6px' }}>{m === 'neutre' ? '🧍 Pose neutre' : '💃 Pose dynamique'}</button>
                  ))}
                </div>
                {l.poseMode === 'dynamique' && (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <select value={l.poseId} disabled={busy} onChange={e => patchLook(l.id, { poseId: e.target.value, status: 'pending' })}
                            style={{ ...inp, minHeight: 28, fontSize: 12 }} title={direction.trim() ? 'Le champ « Pose & attitude » est rempli : il remplace cette pose' : undefined}>
                      {posesFor(l.type).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                    <button onClick={() => patchLook(l.id, { poseId: pickPose(l.type, l.poseId), status: 'pending' })}
                            disabled={busy} title="Tirer une autre pose" style={{ ...small(), padding: '2px 8px' }}>🎲</button>
                  </div>
                )}

                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {l.refs.map((r, i) => (
                    <div key={i} style={{ position: 'relative', width: 56, height: 56 }}>
                      <img src={r.thumb} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid #E5E7EB' }} />
                      {!busy && (
                        <button onClick={() => removeRef(l.id, i)} title="Retirer cette vue"
                                style={{ position: 'absolute', top: 2, right: 2, width: 16, height: 16, borderRadius: '50%', border: 'none', background: 'rgba(13,74,92,0.85)', color: '#fff', fontSize: 11, lineHeight: 1, cursor: 'pointer', padding: 0 }}>×</button>
                      )}
                    </div>
                  ))}
                  {!busy && (
                    <button onClick={() => { addToRef.current = l.id; addInputRef.current?.click() }} title="Ajouter une vue (dos, détail, autre pièce de l'ensemble)"
                            style={{ width: 56, height: 56, borderRadius: 6, border: '1px dashed #D1D5DB', background: '#FAFBFC', cursor: 'pointer', fontSize: 11, color: '#6B7280' }}>+ vue</button>
                  )}
                </div>

                {l.imageUrl ? (
                  <a href={l.imageUrl} target="_blank" rel="noreferrer">
                    <img src={l.imageUrl} alt="résultat" style={{ width: '100%', borderRadius: 6, background: '#F3F4F6', display: 'block' }} />
                  </a>
                ) : (
                  <div style={{ aspectRatio: ratioOf(l).replace(':', '/'), borderRadius: 6, border: '1px dashed #E5E7EB', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#9CA3AF' }}>
                    {busy ? '⏳ génération…' : '—'}
                  </div>
                )}
                {l.versions.length > 1 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {l.versions.map((v, i) => (
                      <img key={i} src={v} alt={`v${i + 1}`} onClick={() => patchLook(l.id, { imageUrl: v })} title={`Version ${i + 1}`}
                           style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 4, cursor: 'pointer', border: v === l.imageUrl ? '2px solid #0D4A5C' : '1px solid #E5E7EB' }} />
                    ))}
                  </div>
                )}
                {l.error && <div style={{ fontSize: 11, color: '#EF4444' }} title={l.error}>{l.error.slice(0, 200)}</div>}

                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => runOne(l.id)} disabled={busy} style={small()}>{l.versions.length ? '↺ Regénérer' : '▶ Générer'}</button>
                  <button onClick={() => patchLook(l.id, { showPrompt: !l.showPrompt })} style={small(l.showPrompt)}>Prompt</button>
                </div>
                {l.showPrompt && (
                  <pre style={{ whiteSpace: 'pre-wrap', fontSize: 10.5, lineHeight: 1.4, background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 6, padding: 8, margin: 0, maxHeight: 260, overflowY: 'auto' }}>
                    {promptOf(l)}
                  </pre>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
