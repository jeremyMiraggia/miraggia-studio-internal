'use client'
/**
 * Onglet 🔧 PAC — ZIP Notion : chaque ligne = une photo (colonne IMAGE) avec un placeholder rouge ou blanc
 * + une PAC (relation → PAC Definition, ses photos). Sortie : la même photo, mêmes dimensions, avec la PAC
 * posée sur le placeholder.
 *   Mode « crop » (défaut) : l'IA ne traite qu'une zone autour du placeholder, recollée dans l'original
 *     → reste de l'image identique au pixel, taille d'origine.
 *   Mode « image entière » : l'image complète est envoyée, la sortie IA est remise aux dimensions d'origine.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import { upload } from '@vercel/blob/client'
import Dropzone from '@/components/ui/Dropzone'
import { compressImage } from '@/lib/compressImage'
import { parsePacExport, type PacExport, type PacTask } from '@/lib/notion/parsePacExport'

type Status = 'pending' | 'running' | 'done' | 'error'
type State = { task: PacTask; status: Status; imageUrl?: string; versions: string[]; error?: string; info?: string; enabled: boolean }

/** File d'attente des vignettes : 2 décodages à la fois (les originaux font 15-30 Mo, 34 d'un coup figent la page). */
const thumbQueue: (() => Promise<void>)[] = []
let thumbActive = 0
function enqueueThumb(job: () => Promise<void>) {
  thumbQueue.push(job)
  const pump = () => {
    while (thumbActive < 2 && thumbQueue.length) {
      const j = thumbQueue.shift()!
      thumbActive++
      j().finally(() => { thumbActive--; pump() })
    }
  }
  pump()
}

/** Vignette réduite d'une image du ZIP, décodée seulement quand elle devient visible à l'écran. */
function Thumb({ getFile, zipKey, label }: { getFile: PacExport['getFile']; zipKey: string; label?: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); io.disconnect() } }, { rootMargin: '300px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  useEffect(() => {
    if (!visible) return
    let alive = true, obj: string | null = null
    enqueueThumb(async () => {
      if (!alive) return
      const f = await getFile(zipKey).catch(() => undefined)
      if (!alive || !f) return
      let small: Blob = f
      try { small = await compressImage(f, { maxSide: 900, quality: 0.8 }) } catch { /* brut */ }
      obj = URL.createObjectURL(small); if (alive) setUrl(obj)
    })
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj) }
  }, [visible, getFile, zipKey])
  return (
    <div ref={ref}>
      {url ? <img src={url} alt={label ?? ''} style={{ width: '100%', borderRadius: 4, display: 'block', background: '#F3F4F6' }} />
           : <div style={{ aspectRatio: '4/3', borderRadius: 4, background: '#F3F4F6' }} />}
      {label && <div style={{ fontSize: 9, color: '#6B7280', marginTop: 2 }}>{label}</div>}
    </div>
  )
}

export default function PacTab() {
  const [zips, setZips] = useState<File[]>([])
  const [parsing, setParsing] = useState(false)
  const [progress, setProgress] = useState('')
  const [parsed, setParsed] = useState<PacExport | null>(null)
  const [states, setStates] = useState<State[]>([])
  const statesRef = useRef<State[]>([])
  const [mode, setMode] = useState<'crop' | 'full'>('crop')
  const [quality, setQuality] = useState('4K')
  const [concurrency, setConcurrency] = useState(2)
  const [running, setRunning] = useState(false)
  const [zipping, setZipping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outDirName, setOutDirName] = useState<string | null>(null)
  const outDirRef = useRef<any>(null)
  const urlCache = useRef(new Map<string, Promise<string>>())

  const commit = (next: State[]) => { statesRef.current = next; setStates(next) }
  const patch = (idx: number, p: Partial<State>) => { const n = [...statesRef.current]; n[idx] = { ...n[idx], ...p }; commit(n) }

  const handleZip = async (files: File[]) => {
    setZips(files); setError(null); setParsed(null); commit([]); urlCache.current.clear()
    if (!files[0]) return
    setParsing(true)
    try {
      const res = await parsePacExport(files[0], m => setProgress(m))
      setParsed(res)
      commit(res.tasks.map(t => ({ task: t, status: 'pending', versions: [], enabled: t.pacKeys.length > 0 })))
    } catch (e: any) { setError(e?.message ?? String(e)) }
    finally { setParsing(false); setProgress('') }
  }

  /** Upload direct navigateur → Blob. Originaux SANS compression ; photos de PAC réduites à 2048 px. */
  const uploadKey = (key: string, original: boolean): Promise<string> => {
    const ck = `${original ? 'o' : 'r'}:${key}`
    let p = urlCache.current.get(ck)
    if (!p) {
      p = (async () => {
        const f = await parsed!.getFile(key)
        if (!f) throw new Error(`Fichier introuvable dans le ZIP : ${key}`)
        let file: File = f
        if (!original) { try { file = await compressImage(f, { maxSide: 2048, quality: 0.92 }) } catch { /* brut */ } }
        const b = await upload(`pac-inputs/${Date.now()}-${file.name}`, file, { access: 'public', handleUploadUrl: '/api/blob-upload', contentType: file.type || 'image/jpeg' })
        return b.url
      })()
      p.catch(() => urlCache.current.delete(ck))
      urlCache.current.set(ck, p)
    }
    return p
  }

  const outName = (s: State, v: number) => `${s.task.imageName.replace(/\.[a-z0-9]+$/i, '')}${v > 1 ? `_${v}` : ''}.jpg`

  const runOne = async (idx: number) => {
    const s = statesRef.current[idx]
    if (!s || !parsed) return
    if (!s.task.pacKeys.length) { patch(idx, { status: 'error', error: 'Aucune image de PAC pour cette ligne.' }); return }
    patch(idx, { status: 'running', error: undefined, info: 'Envoi des images…' })
    try {
      const [imageUrl, pacUrls] = await Promise.all([uploadKey(s.task.imageKey, true), Promise.all(s.task.pacKeys.map(k => uploadKey(k, false)))])
      patch(idx, { info: mode === 'crop' ? 'Détection du placeholder + génération de la zone…' : 'Génération de l\'image entière…' })
      const res = await fetch('/api/studio/pac', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl, pacUrls, mode, quality }),
      })
      const text = await res.text()
      let j: any
      try { j = JSON.parse(text) } catch { throw new Error(`HTTP ${res.status} : ${text.replace(/<[^>]+>/g, ' ').trim().slice(0, 160)}`) }
      if (!res.ok || !j.imageUrl) throw new Error(j.error || `HTTP ${res.status}`)
      const cur = statesRef.current[idx]
      const versions = [...cur.versions, j.imageUrl]
      const ph = j.placeholder
      patch(idx, {
        status: 'done', imageUrl: j.imageUrl, versions,
        info: `${j.size.W}×${j.size.H} px · placeholder ${ph?.color === 'red' ? 'rouge' : 'blanc'} (${ph?.method})${j.mode === 'crop' ? ` · zone ${j.crop.box.width}×${j.crop.box.height}` : ' · image entière'}`,
      })
      if (outDirRef.current) {
        try {
          const blob = await (await fetch(j.imageUrl)).blob()
          const fh = await outDirRef.current.getFileHandle(outName(cur, versions.length), { create: true })
          const w = await fh.createWritable(); await w.write(blob); await w.close()
        } catch (e: any) { patch(idx, { info: `${statesRef.current[idx].info} · ⚠ écriture dossier : ${e?.message ?? e}` }) }
      }
    } catch (e: any) {
      patch(idx, { status: 'error', error: e?.message ?? String(e), info: undefined })
    }
  }

  const run = async () => {
    if (running) return
    const todo = statesRef.current.map((s, i) => i).filter(i => statesRef.current[i].enabled && statesRef.current[i].status !== 'done')
    if (!todo.length) return
    setRunning(true); setError(null)
    let cursor = 0
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 4)) }, async () => {
      while (cursor < todo.length) await runOne(todo[cursor++])
    }))
    setRunning(false)
  }

  const pickOutDir = async () => {
    try {
      // @ts-ignore
      const h = await window.showDirectoryPicker({ mode: 'readwrite' })
      outDirRef.current = h; setOutDirName(h.name ?? 'dossier')
    } catch (e: any) { if (e?.name !== 'AbortError') setError(`Dossier : ${e?.message ?? e}`) }
  }

  const downloadZip = async () => {
    const done = statesRef.current.filter(s => s.versions.length)
    if (!done.length) return
    setZipping(true)
    try {
      const zip = new JSZip()
      for (const s of done) for (let v = 0; v < s.versions.length; v++) {
        const r = await fetch(s.versions[v]); if (r.ok) zip.file(outName(s, v + 1), await r.blob())
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `pac_${Date.now()}.zip`; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (e: any) { setError(`ZIP : ${e?.message ?? e}`) }
    finally { setZipping(false) }
  }

  const stats = useMemo(() => ({
    total: states.length,
    done: states.filter(s => s.status === 'done').length,
    errors: states.filter(s => s.status === 'error').length,
    toRun: states.filter(s => s.enabled && s.status !== 'done').length,
    withResult: states.filter(s => s.versions.length).length,
  }), [states])
  const estCost = (stats.toRun * (quality === '4K' ? 0.24 : 0.134)).toFixed(2)

  const card: React.CSSProperties = { border: '1px solid #E5E7EB', borderRadius: 12, padding: 16, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }
  const label: React.CSSProperties = { fontSize: 12, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 6 }
  const inp: React.CSSProperties = { border: '1px solid #D1D5DB', borderRadius: 8, padding: '6px 10px', fontSize: 14, minHeight: 34, background: '#fff', width: '100%' }
  const btn = (bg: string, color = '#fff'): React.CSSProperties => ({ background: bg, color, border: 'none', borderRadius: 8, padding: '8px 16px', fontWeight: 600, fontSize: 14, cursor: 'pointer' })
  const small = (on = false): React.CSSProperties => ({ ...btn(on ? '#0D4A5C' : '#E5E7EB', on ? '#fff' : '#374151'), padding: '6px 12px', fontSize: 13 })
  const pill = (bg: string): React.CSSProperties => ({ background: bg, color: '#fff', borderRadius: 999, padding: '2px 8px', fontSize: 10, fontWeight: 600 })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 22 }}>🔧</span>
          <h2 style={{ margin: 0, color: '#0D4A5C', fontSize: 18 }}>PAC — pose de la pompe à chaleur sur le placeholder</h2>
        </div>
        <p style={{ fontSize: 13, color: '#6B7280', margin: 0 }}>
          ZIP Notion : chaque ligne = une photo (<code>IMAGE</code>) avec un rectangle <strong>rouge</strong> ou <strong>blanc</strong>, et une <code>PAC</code> (relation → <code>PAC Definition</code>, ses photos).
          Sortie : la même photo, mêmes dimensions et même nom, avec la PAC posée à l'emplacement du placeholder (coupée si le placeholder l'est).
        </p>
      </div>

      <div style={card}>
        <div style={label}>1 — ZIP Notion</div>
        <Dropzone files={zips} onChange={handleZip} accept=".zip" multiple={false} label="Glisse le ZIP Notion" hint="LOOK (LIFESTYLE) + PAC Definition — taille illimitée" />
        {parsing && <div style={{ marginTop: 8, fontSize: 13, color: '#0D4A5C' }}>⏳ {progress}</div>}
        {parsed && (
          <details style={{ marginTop: 8, fontSize: 12, color: '#374151', background: '#F9FAFB', padding: 8, borderRadius: 6 }}>
            <summary style={{ cursor: 'pointer' }}>✓ {parsed.tasks.length} image(s) · {parsed.pacs.map(p => `${p.name} (${p.keys.length} photo${p.keys.length > 1 ? 's' : ''})`).join(' · ')}</summary>
            <ul style={{ fontSize: 11, color: '#6B7280', margin: '4px 0', paddingLeft: 16 }}>{parsed.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </details>
        )}
      </div>

      <div style={card}>
        <div style={label}>2 — Paramètres</div>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Méthode</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setMode('crop')} disabled={running} style={small(mode === 'crop')} title="Seule la zone autour du placeholder passe par l'IA, puis est recollée : le reste reste identique au pixel">✂ Zone recollée (recommandé)</button>
              <button onClick={() => setMode('full')} disabled={running} style={small(mode === 'full')} title="L'image entière est envoyée et régénérée (4K max), puis remise aux dimensions d'origine">🖼 Image entière</button>
            </div>
            <div style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>
              {mode === 'crop'
                ? 'Le reste de la photo reste identique au pixel, à la taille d\'origine ; toute la résolution de l\'IA va à la zone de la PAC.'
                : 'Toute la photo est régénérée (visages, textures peuvent légèrement changer), sortie 4K agrandie aux dimensions d\'origine.'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Qualité IA</div>
            <select value={quality} onChange={e => setQuality(e.target.value)} style={inp}><option value="4K">4K</option><option value="2K">2K</option></select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Parallèle</div>
            <select value={concurrency} onChange={e => setConcurrency(parseInt(e.target.value, 10))} style={inp}>{[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}</select>
          </div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={pickOutDir} disabled={running} style={small(!!outDirName)}>📁 {outDirName ? `Dossier : ${outDirName}` : 'Dossier de sortie (optionnel)'}</button>
          {outDirName && <button onClick={() => { outDirRef.current = null; setOutDirName(null) }} style={small()}>✕</button>}
          <button onClick={run} disabled={running || !stats.toRun}
                  style={{ ...btn(running || !stats.toRun ? '#9CA3AF' : '#0D4A5C'), cursor: running || !stats.toRun ? 'not-allowed' : 'pointer' }}>
            {running ? `⏳ ${stats.done}/${stats.total}…` : `🚀 Poser la PAC sur ${stats.toRun} image${stats.toRun > 1 ? 's' : ''} (≈ ${estCost} $)`}
          </button>
          <button onClick={downloadZip} disabled={zipping || !stats.withResult} style={{ ...btn(stats.withResult ? '#374151' : '#9CA3AF'), cursor: stats.withResult ? 'pointer' : 'not-allowed' }}>
            {zipping ? '⏳ ZIP…' : `⬇ ZIP (${stats.withResult})`}
          </button>
          {stats.errors > 0 && <span style={{ fontSize: 12, color: '#B91C1C' }}>✕ {stats.errors} erreur(s) — relance pour réessayer</span>}
        </div>
        {error && <div style={{ marginTop: 10, background: '#FEF2F2', color: '#991B1B', padding: 8, borderRadius: 6, fontSize: 12 }}>❌ {error}</div>}
      </div>

      {parsed && states.length > 0 && (
        <div style={card}>
          <div style={label}>3 — Images ({stats.done}/{stats.total})</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
            {states.map((s, idx) => (
              <div key={s.task.id + s.task.imageKey} style={{ border: '1px solid #E5E7EB', borderRadius: 10, padding: 10, opacity: s.enabled ? 1 : 0.55 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 12 }}>
                  <input type="checkbox" checked={s.enabled} disabled={running} onChange={e => patch(idx, { enabled: e.target.checked })} />
                  {s.status === 'running' && <span style={pill('#F59E0B')}>⏳</span>}
                  {s.status === 'done' && <span style={pill('#10B981')}>✓</span>}
                  {s.status === 'error' && <span style={pill('#EF4444')}>✕</span>}
                  <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.task.imageName}>#{s.task.id} · {s.task.imageName}</strong>
                  <span style={{ marginLeft: 'auto', color: '#6B7280', whiteSpace: 'nowrap' }}>{s.task.pacName || '—'}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  <Thumb getFile={parsed.getFile} zipKey={s.task.imageKey} label="Original" />
                  <div>
                    {s.imageUrl
                      ? <a href={s.imageUrl} target="_blank" rel="noreferrer" title="Ouvrir en pleine résolution"><img src={s.imageUrl} alt="sortie" style={{ width: '100%', borderRadius: 4, display: 'block' }} /></a>
                      : <div style={{ aspectRatio: '4/3', borderRadius: 4, border: '1px dashed #E5E7EB', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#9CA3AF' }}>{s.status === 'running' ? '⏳' : '—'}</div>}
                    <div style={{ fontSize: 9, color: '#10B981', marginTop: 2 }}>Avec PAC</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                  {s.task.pacKeys.map(k => <div key={k} style={{ width: 56 }}><Thumb getFile={parsed.getFile} zipKey={k} /></div>)}
                </div>
                {s.versions.length > 1 && (
                  <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                    {s.versions.map((v, i) => (
                      <button key={i} onClick={() => patch(idx, { imageUrl: v })} style={{ ...small(v === s.imageUrl), padding: '2px 8px', fontSize: 11 }}>v{i + 1}</button>
                    ))}
                  </div>
                )}
                {s.info && <div style={{ fontSize: 10, color: '#6B7280', marginTop: 4 }}>{s.info}</div>}
                {s.task.warnings.length > 0 && <div style={{ fontSize: 10, color: '#B45309', marginTop: 4 }}>⚠ {s.task.warnings.join(' · ')}</div>}
                {s.error && <div style={{ fontSize: 11, color: '#EF4444', marginTop: 4 }}>{s.error.slice(0, 220)}</div>}
                {s.status !== 'running' && !running && s.enabled && (
                  <button onClick={() => runOne(idx)} style={{ ...small(), marginTop: 6, fontSize: 12, padding: '4px 10px' }}>{s.versions.length ? '↺ Regénérer' : '▶ Générer'}</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
