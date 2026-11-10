'use client'
/**
 * Onglet 👙 Lingerie Visage — ZIP Notion habituel → visuels portés AVEC visage, générés par Seedream 5 Pro (fal).
 * Gemini bloque la lingerie et les maillots de bain ; Seedream non.
 *
 * Colonnes : SKU (ou Référence produit), Mannequin (→ tableau mannequins : FACE PHOTO, FRONT-model),
 * Fond (→ tableau fonds), Produits / FILES (FRONT) / FILES (BACK) / DETAILS, « Vue et pose N ».
 * Un visuel par vue (+ un gros plan par fichier DETAILS).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { upload } from '@vercel/blob/client'
import Dropzone from '@/components/ui/Dropzone'
import { parseNotionExport, type GenerationTask, type ParsedExport } from '@/lib/notion/parseExport'
import { buildLingerieVisagePrompt, lvImages, lvImageList, lvPrice, lvSize, LV_QUALITIES, LV_RATIOS } from '@/lib/lingerieVisagePrompt'

type Status = 'pending' | 'running' | 'done' | 'error'
type Item = {
  task: GenerationTask
  enabled: boolean
  status: Status
  imageUrl?: string
  versions: string[]
  error?: string
  showPrompt?: boolean
  saved?: boolean
}

const sanitize = (s: string) => s.replace(/[\/\\:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim() || 'look'

function Thumb({ file, label }: { file: File; label: string }) {
  const [url, setUrl] = useState('')
  useEffect(() => { const u = URL.createObjectURL(file); setUrl(u); return () => URL.revokeObjectURL(u) }, [file])
  return (
    <div style={{ textAlign: 'center' }}>
      {url && <img src={url} alt={label} style={{ width: '100%', aspectRatio: '3/4', objectFit: 'cover', borderRadius: 4, background: '#F3F4F6' }} />}
      <div style={{ fontSize: 9, color: '#6B7280', marginTop: 1 }}>{label}</div>
    </div>
  )
}

export default function LingerieVisageTab() {
  const [zips, setZips] = useState<File[]>([])
  const [parsed, setParsed] = useState<ParsedExport | null>(null)
  const [parsing, setParsing] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const itemsRef = useRef<Item[]>([])
  const [ratio, setRatio] = useState('3:4')
  const [quality, setQuality] = useState('2K')
  const [concurrency, setConcurrency] = useState(2)
  const [running, setRunning] = useState(false)
  const stopRef = useRef(false)
  const [spent, setSpent] = useState(0)
  const dirRef = useRef<any>(null)
  const [dirName, setDirName] = useState('')

  useEffect(() => {
    try {
      const r = localStorage.getItem('lv-ratio'); if (r && (LV_RATIOS as readonly string[]).includes(r)) setRatio(r)
      const q = localStorage.getItem('lv-quality'); if (q && LV_QUALITIES[q]) setQuality(q)
    } catch { /* */ }
  }, [])
  const changeRatio = (r: string) => { setRatio(r); try { localStorage.setItem('lv-ratio', r) } catch { /* */ } }
  const changeQuality = (q: string) => { setQuality(q); try { localStorage.setItem('lv-quality', q) } catch { /* */ } }

  const update = (idx: number, patch: Partial<Item>) => setItems(prev => {
    const next = [...prev]; next[idx] = { ...next[idx], ...patch }; itemsRef.current = next; return next
  })

  /* ----------- ZIP ----------- */
  const handleZip = async (files: File[]) => {
    setZips(files); setParsed(null); setItems([]); itemsRef.current = []; setError(null); uploads.current = new WeakMap()
    if (!files.length) return
    setParsing(true); setProgress('Lecture du ZIP…')
    try {
      const res = await parseNotionExport(files[0], msg => setProgress(msg))
      setParsed(res)
      const list: Item[] = res.tasks.map(task => ({ task, enabled: !!lvImages(task).products.length, status: 'pending', versions: [] }))
      setItems(list); itemsRef.current = list
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setParsing(false); setProgress('')
    }
  }

  const artDirection = (t: GenerationTask) => parsed?.looks.find(l => l.id === t.lookId)?.description
  const promptFor = (t: GenerationTask) => buildLingerieVisagePrompt(t, lvImages(t), artDirection(t))
  const fileNameFor = (t: GenerationTask, version: number) => {
    const view = t.taskType === 'detail' ? `detail-${(t.detailIndex ?? 0) + 1}` : sanitize(t.vueRaw ?? `vue-${(t.vueIndex ?? 0) + 1}`)
    return `${sanitize(t.numeroLook)}_${view}${version > 1 ? `_${version}` : ''}.jpg`
  }

  /* ----------- Upload Blob (une fois par fichier) ----------- */
  const uploads = useRef(new WeakMap<File, Promise<string>>())
  const uploadFile = (f: File): Promise<string> => {
    let p = uploads.current.get(f)
    if (!p) {
      p = upload(`lingerie-visage-inputs/${Date.now()}-${f.name}`, f, {
        access: 'public', handleUploadUrl: '/api/blob-upload', contentType: f.type || 'image/jpeg',
      }).then(b => b.url)
      uploads.current.set(f, p)
      p.catch(() => uploads.current.delete(f))
    }
    return p
  }

  /* ----------- Dossier de sortie ----------- */
  const pickDir = async () => {
    try {
      // @ts-ignore
      const h = await window.showDirectoryPicker({ mode: 'readwrite' })
      dirRef.current = h; setDirName(h.name ?? 'dossier')
    } catch (e: any) { if (e?.name !== 'AbortError') setError(`Dossier : ${e?.message ?? e}`) }
  }
  const saveToDir = async (url: string, name: string) => {
    if (!dirRef.current) return false
    try {
      const blob = await fetch(url).then(r => r.blob())
      const fh = await dirRef.current.getFileHandle(name, { create: true })
      const w = await fh.createWritable(); await w.write(blob); await w.close()
      return true
    } catch { return false }
  }
  const download = async (url: string, name: string) => {
    const blob = await fetch(url).then(r => r.blob())
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }

  /* ----------- Génération ----------- */
  const generateOne = async (idx: number) => {
    const it = itemsRef.current[idx]
    if (!it) return
    const t = it.task
    const imgs = lvImageList(lvImages(t))
    if (!imgs.some(i => i.label.startsWith('Produit'))) return update(idx, { status: 'error', error: 'aucune photo produit pour cette vue' })
    update(idx, { status: 'running', error: undefined })
    try {
      const imageUrls = await Promise.all(imgs.map(i => uploadFile(i.file)))
      const size = lvSize(ratio, quality)
      const resp = await fetch('/api/studio/seedream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: promptFor(t), imageUrls, ...size, sku: t.numeroLook }),
      })
      const text = await resp.text()
      let json: any
      try { json = JSON.parse(text) } catch { throw new Error(`HTTP ${resp.status} : ${text.replace(/<[^>]+>/g, ' ').trim().slice(0, 160)}`) }
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`)
      if (typeof json.cost === 'number') setSpent(s => s + json.cost)
      const versions = [...(itemsRef.current[idx]?.versions ?? []), json.imageUrl]
      update(idx, { status: 'done', imageUrl: json.imageUrl, versions, saved: false })
      if (dirRef.current && await saveToDir(json.imageUrl, fileNameFor(t, versions.length))) update(idx, { saved: true })
    } catch (e: any) {
      update(idx, { status: 'error', error: e?.message ?? String(e) })
    }
  }

  const runAll = async () => {
    const queue = itemsRef.current.map((it, i) => ({ it, i })).filter(x => x.it.enabled && x.it.status !== 'done').map(x => x.i)
    if (!queue.length) return
    setRunning(true); stopRef.current = false
    const worker = async () => { while (queue.length && !stopRef.current) await generateOne(queue.shift()!) }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
    setRunning(false)
  }

  const stats = useMemo(() => {
    const on = items.filter(i => i.enabled)
    const todo = on.filter(i => i.status !== 'done')
    return {
      on: on.length, done: items.filter(i => i.status === 'done').length, todo: todo.length,
      est: todo.reduce((s, i) => s + lvPrice(quality, lvImageList(lvImages(i.task)).length), 0),
    }
  }, [items, quality])

  const setAll = (v: boolean) => setItems(prev => { const next = prev.map(i => ({ ...i, enabled: v })); itemsRef.current = next; return next })

  /* ----------- Rendu ----------- */
  const box: React.CSSProperties = { background: '#fff', borderRadius: 12, padding: 16, marginBottom: 16, border: '1px solid rgba(13,74,92,0.1)' }
  const inp: React.CSSProperties = { padding: '6px 8px', borderRadius: 6, border: '1px solid #D1D5DB', fontSize: 13 }
  const btn = (bg: string): React.CSSProperties => ({ background: bg, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' })

  return (
    <div style={{ maxWidth: 1200 }}>
      <h2 style={{ margin: '0 0 4px', color: '#0D4A5C' }}>👙 Lingerie Visage</h2>
      <p style={{ fontSize: 13, color: '#6B7280', margin: '0 0 16px' }}>
        Lingerie et maillots de bain portés, <strong>visage visible</strong>, générés par <strong>Seedream 5 Pro</strong> (fal), qui ne bloque pas les sous-vêtements.
        Images envoyées dans l'ordre : <strong>visage</strong> (<code>FACE PHOTO</code>) → <strong>corps</strong> (<code>FRONT-model</code>) → <strong>fond</strong> → <strong>produit(s)</strong> (10 images max).
        Un visuel par colonne <code>Vue et pose N</code>, plus un gros plan par fichier <code>DETAILS</code>. Format et qualité réglables (1K, 1,5K ou 2K — Seedream ne fait pas de 4K) : ≈ 0,07 $ en 1K / 1,5K, ≈ 0,14 $ en 2K par visuel.
      </p>

      <div style={box}>
        <Dropzone files={zips} onChange={handleZip} accept=".zip" multiple={false}
                  label="Drop le ZIP Notion ici" hint="LOOK + Models Definition + Fonds — colonnes SKU / Mannequin / Fond / Produits / Vue et pose N" />
        {parsing && <div style={{ marginTop: 8, fontSize: 13, color: '#0D4A5C' }}>⏳ {progress}</div>}
        {error && <div style={{ marginTop: 8, fontSize: 13, color: '#991B1B' }}>⚠ {error}</div>}
        {parsed && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#374151', background: '#F9FAFB', padding: 8, borderRadius: 6 }}>
            ✓ {parsed.looks.length} look(s) → {parsed.tasks.length} visuel(s), {parsed.models.size} mannequin(s), {parsed.fonds.size} fond(s).
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer' }}>Détails de lecture</summary>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{parsed.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </details>
          </div>
        )}
      </div>

      {items.length > 0 && (
        <div style={{ ...box, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 2 }}>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Format</div>
            <select value={ratio} onChange={e => changeRatio(e.target.value)} style={inp} disabled={running}>
              {LV_RATIOS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Qualité</div>
            <select value={quality} onChange={e => changeQuality(e.target.value)} style={inp} disabled={running}>
              {Object.entries(LV_QUALITIES).map(([q, v]) => <option key={q} value={q}>{q} — {v.hint}</option>)}
            </select>
            <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 2 }}>{(() => { const z = lvSize(ratio, quality); return `${z.width} × ${z.height} px` })()}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Parallèle</div>
            <select value={concurrency} onChange={e => setConcurrency(parseInt(e.target.value, 10))} style={inp} disabled={running}>
              {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <button onClick={pickDir} style={{ ...btn('#6B7A8A') }} disabled={running}>📁 {dirName || 'Dossier de sortie'}</button>
          <button onClick={() => setAll(true)} style={{ ...inp, cursor: 'pointer', background: '#fff' }} disabled={running}>Tout cocher</button>
          <button onClick={() => setAll(false)} style={{ ...inp, cursor: 'pointer', background: '#fff' }} disabled={running}>Tout décocher</button>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 12, color: '#374151', textAlign: 'right' }}>
            {stats.done}/{stats.on} faits · reste {stats.todo} ≈ {stats.est.toFixed(2)} $<br />
            <span style={{ color: '#6B7280' }}>dépensé cette session : {spent.toFixed(2)} $</span>
          </div>
          {running
            ? <button onClick={() => { stopRef.current = true }} style={btn('#991B1B')}>■ Arrêter après les visuels en cours</button>
            : <button onClick={runAll} style={btn('#0D4A5C')} disabled={!stats.todo}>▶ Générer {stats.todo} visuel{stats.todo > 1 ? 's' : ''}</button>}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
        {items.map((it, idx) => {
          const t = it.task
          const imgs = lvImageList(lvImages(t))
          const noProduct = !imgs.some(i => i.label.startsWith('Produit'))
          return (
            <div key={t.id} style={{ ...box, marginBottom: 0, opacity: it.enabled ? 1 : 0.55 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <input type="checkbox" checked={it.enabled} disabled={running || noProduct} onChange={e => update(idx, { enabled: e.target.checked })} />
                <strong style={{ fontSize: 14, color: '#0D4A5C' }}>{t.numeroLook}</strong>
                <span style={{ fontSize: 12, color: '#374151' }}>{t.taskType === 'detail' ? `🔍 détail ${(t.detailIndex ?? 0) + 1}` : t.vueRaw}</span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: it.status === 'error' ? '#991B1B' : it.status === 'done' ? '#166534' : '#6B7280' }}>
                  {it.status === 'running' ? '⏳ en cours' : it.status === 'done' ? (it.saved ? '✓ enregistré' : '✓') : it.status === 'error' ? '✗ erreur' : ''}
                </span>
              </div>
              <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 6 }}>
                👤 {t.mannequinName || '—'}{!t.facePhotoFile && <span style={{ color: '#92400E' }}> (pas de FACE PHOTO)</span>} · 🏞 {t.fondName || '—'}
                {noProduct && <span style={{ color: '#991B1B' }}> · aucune photo produit</span>}
              </div>
              {t.warnings.length > 0 && <div style={{ fontSize: 10, color: '#92400E', marginBottom: 6 }}>⚠ {t.warnings.join(' · ')}</div>}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, alignContent: 'start' }}>
                  {imgs.map((im, i) => <Thumb key={i} file={im.file} label={`${i + 1}. ${im.label}`} />)}
                </div>
                <div>
                  {it.imageUrl
                    ? <a href={it.imageUrl} target="_blank" rel="noreferrer"><img src={it.imageUrl} alt="" style={{ width: '100%', borderRadius: 6 }} /></a>
                    : <div style={{ aspectRatio: ratio.replace(':', '/'), background: '#F3F4F6', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#9CA3AF' }}>
                        {it.status === 'running' ? 'Seedream travaille…' : 'pas encore généré'}
                      </div>}
                  {it.error && <div style={{ fontSize: 11, color: '#991B1B', marginTop: 4 }}>{it.error}</div>}
                  <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                    <button onClick={() => generateOne(idx)} disabled={it.status === 'running' || noProduct} style={{ ...inp, cursor: 'pointer', background: '#fff', fontSize: 11 }}>
                      {it.versions.length ? '↻ Régénérer' : '▶ Générer'}
                    </button>
                    {it.imageUrl && <button onClick={() => download(it.imageUrl!, fileNameFor(t, it.versions.length))} style={{ ...inp, cursor: 'pointer', background: '#fff', fontSize: 11 }}>⬇ {fileNameFor(t, it.versions.length)}</button>}
                    <button onClick={() => update(idx, { showPrompt: !it.showPrompt })} style={{ ...inp, cursor: 'pointer', background: '#fff', fontSize: 11 }}>{it.showPrompt ? 'Masquer' : 'Voir'} le prompt</button>
                  </div>
                  {it.versions.length > 1 && (
                    <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                      {it.versions.map((v, i) => (
                        <img key={v} src={v} alt="" onClick={() => update(idx, { imageUrl: v })}
                             style={{ width: 36, height: 48, objectFit: 'cover', borderRadius: 3, cursor: 'pointer', outline: v === it.imageUrl ? '2px solid #0D4A5C' : 'none' }} title={`Version ${i + 1}`} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {it.showPrompt && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 10, background: '#F9FAFB', padding: 8, borderRadius: 6, marginTop: 8 }}>{promptFor(t)}</pre>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
