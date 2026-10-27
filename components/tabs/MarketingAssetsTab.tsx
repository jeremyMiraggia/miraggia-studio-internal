'use client'
/**
 * Onglet 📣 Marketing assets — ZIP Notion à 4 colonnes (Dossier, Mannequin(s), Vêtements et produits, Prompt).
 * - Mannequins : rapprochés du catalogue de la plateforme Miraggia (/api/studio/mannequins) → visage + corps envoyés.
 *   Vide, « — (produit) » ou nom inconnu du catalogue = visuel PRODUIT (les fichiers sont le produit).
 * - Prompt : celui de la colonne 4, précédé d'un court en-tête qui dit à l'IA quelle image est quoi.
 * - Sortie rangée par dossier (colonne 1) : ZIP avec sous-dossiers, ou écriture directe dans un dossier local.
 * Génération via /api/studio/free (mode brut) → interrupteur Gemini / ChatGPT de l'onglet.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import { upload } from '@vercel/blob/client'
import Dropzone from '@/components/ui/Dropzone'
import { compressImage } from '@/lib/compressImage'
import { parseMarketingExport, type MarketingExport, type MarketingRow } from '@/lib/notion/parseMarketingExport'

type Mannequin = { id: string; name: string; gender: string; description: string; faceUrl: string; bodyUrl: string }
type Status = 'pending' | 'running' | 'done' | 'error'
type Item = { row: MarketingRow; prompt: string; status: Status; imageUrl?: string; versions: string[]; error?: string; enabled: boolean; showPrompt?: boolean }

const RATIOS = ['auto', '4:5', '3:4', '2:3', '9:16', '1:1', '16:9', '3:2', '4:3', '5:4', '21:9']
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
const safe = (s: string) => s.replace(/[\/\\:*?"<>|]/g, '_').trim() || 'visuel'
/** Ratio écrit dans le prompt (« Vertical 4:5 »…), sinon 4:5. */
const ratioFromPrompt = (p: string) => (p.match(/\b(21:9|16:9|9:16|4:5|5:4|3:4|4:3|2:3|3:2|1:1)\b/)?.[1]) ?? '4:5'

function Thumb({ getFile, zipKey }: { getFile: MarketingExport['getFile']; zipKey: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true, obj: string | null = null
    getFile(zipKey).then(async f => {
      if (!alive || !f) return
      let s: Blob = f
      try { s = await compressImage(f, { maxSide: 400, quality: 0.8 }) } catch { /* brut */ }
      obj = URL.createObjectURL(s); if (alive) setUrl(obj)
    }).catch(() => {})
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj) }
  }, [getFile, zipKey])
  return url ? <img src={url} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6, border: '1px solid #E5E7EB' }} />
             : <div style={{ width: 48, height: 48, borderRadius: 6, background: '#F3F4F6' }} />
}

export default function MarketingAssetsTab() {
  const [catalog, setCatalog] = useState<Mannequin[] | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [zips, setZips] = useState<File[]>([])
  const [parsing, setParsing] = useState(false)
  const [progress, setProgress] = useState('')
  const [parsed, setParsed] = useState<MarketingExport | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const itemsRef = useRef<Item[]>([])
  const [ratioMode, setRatioMode] = useState('auto')
  const [quality, setQuality] = useState('2K')
  const [concurrency, setConcurrency] = useState(3)
  const [withHeader, setWithHeader] = useState(true)
  const [running, setRunning] = useState(false)
  const stopRef = useRef(false)
  const [zipping, setZipping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outDirName, setOutDirName] = useState<string | null>(null)
  const outDirRef = useRef<any>(null)
  const urlCache = useRef(new Map<string, Promise<string>>())

  useEffect(() => {
    fetch('/api/studio/mannequins').then(r => r.json()).then(j => {
      if (j.error) setCatalogError(j.error); else setCatalog(j.mannequins)
    }).catch(e => setCatalogError(String(e)))
  }, [])
  const byName = useMemo(() => new Map((catalog ?? []).map(m => [norm(m.name), m])), [catalog])

  const commit = (n: Item[]) => { itemsRef.current = n; setItems(n) }
  const patch = (i: number, p: Partial<Item>) => { const n = [...itemsRef.current]; n[i] = { ...n[i], ...p }; commit(n) }

  const handleZip = async (files: File[]) => {
    setZips(files); setError(null); setParsed(null); commit([]); urlCache.current.clear()
    if (!files[0]) return
    setParsing(true)
    try {
      const res = await parsePacked(files[0])
      setParsed(res)
      commit(res.rows.map(row => ({ row, prompt: row.prompt, status: 'pending', versions: [], enabled: true })))
    } catch (e: any) { setError(e?.message ?? String(e)) }
    finally { setParsing(false); setProgress('') }
  }
  const parsePacked = (f: File) => parseMarketingExport(f, m => setProgress(m))

  /** Mannequins reconnus / noms inconnus (→ produit) pour une ligne. */
  const resolve = (row: MarketingRow) => {
    const found = row.modelNames.map(n => byName.get(norm(n))).filter(Boolean) as Mannequin[]
    const unknown = row.modelNames.filter(n => !byName.has(norm(n)))
    return { found, unknown, isProduct: row.productLike || found.length === 0 }
  }

  /** En-tête ajouté au prompt : rôle de chaque image, dans l'ordre d'envoi. */
  const headerFor = (row: MarketingRow, found: Mannequin[], isProduct: boolean) => {
    const lines: string[] = []
    let i = 1
    if (!isProduct) for (const m of found) {
      const who = m.gender === 'h' ? 'man' : m.gender === 'f' ? 'woman' : 'model'
      lines.push(`- IMAGE ${i}: face of the model "${m.name}" (${who}) — keep this exact face and hair.`); i++
      if (m.bodyUrl && m.bodyUrl !== m.faceUrl) { lines.push(`- IMAGE ${i}: full body of "${m.name}" — body shape, height and skin tone (ignore the clothing).`); i++ }
    }
    const nf = row.fileKeys.length
    if (nf) lines.push(`- ${nf > 1 ? `IMAGES ${i} to ${i + nf - 1}` : `IMAGE ${i}`}: ${isProduct ? 'the PRODUCT(S) to feature — reproduce them exactly (shape, color, material, details).' : 'the garments / products to wear or show — reproduce them faithfully.'}`)
    if (!lines.length) return ''
    return `REFERENCE IMAGES, in this order:\n${lines.join('\n')}${found.length > 1 ? `\nThere are ${found.length} models: ${found.map(m => m.name).join(' and ')} — each keeps their own face.` : ''}\n\n---\n\n`
  }

  const uploadZip = (key: string) => {
    let p = urlCache.current.get(key)
    if (!p) {
      p = (async () => {
        const f = await parsed!.getFile(key)
        if (!f) throw new Error(`Fichier introuvable : ${key}`)
        let file: File = f
        try { file = await compressImage(f, { maxSide: 2048, quality: 0.92 }) } catch { /* brut */ }
        return (await upload(`marketing-inputs/${Date.now()}-${file.name}`, file, { access: 'public', handleUploadUrl: '/api/blob-upload', contentType: file.type || 'image/jpeg' })).url
      })()
      p.catch(() => urlCache.current.delete(key))
      urlCache.current.set(key, p)
    }
    return p
  }

  const fileName = (it: Item, v: number) => {
    const { found, isProduct } = resolve(it.row)
    const who = isProduct ? 'produit' : found.map(m => m.name).join('-')
    return `${safe(it.row.folder)}/${String(it.row.index).padStart(2, '0')}_${safe(who)}${v > 1 ? `_v${v}` : ''}.jpg`
  }

  const runOne = async (idx: number) => {
    const it = itemsRef.current[idx]
    if (!it) return
    const { found, isProduct } = resolve(it.row)
    patch(idx, { status: 'running', error: undefined })
    try {
      const modelUrls = isProduct ? [] : found.flatMap(m => [m.faceUrl, ...(m.bodyUrl && m.bodyUrl !== m.faceUrl ? [m.bodyUrl] : [])]).filter(Boolean)
      const fileUrls = await Promise.all(it.row.fileKeys.map(uploadZip))
      const prompt = (withHeader ? headerFor(it.row, found, isProduct) : '') + it.prompt
      const ratio = ratioMode === 'auto' ? ratioFromPrompt(it.prompt) : ratioMode
      const res = await fetch('/api/studio/free', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, ratio, quality, refUrls: [...modelUrls, ...fileUrls] }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.imageUrl) throw new Error(j.error || `HTTP ${res.status}`)
      const versions = [...itemsRef.current[idx].versions, j.imageUrl]
      patch(idx, { status: 'done', imageUrl: j.imageUrl, versions })
      if (outDirRef.current) {
        try {
          const blob = await (await fetch(j.imageUrl)).blob()
          const [dir, name] = fileName(itemsRef.current[idx], versions.length).split('/')
          const sub = await outDirRef.current.getDirectoryHandle(dir, { create: true })
          const fh = await sub.getFileHandle(name, { create: true })
          const w = await fh.createWritable(); await w.write(blob); await w.close()
        } catch (e: any) { patch(idx, { error: `Visuel OK mais écriture dossier impossible : ${e?.message ?? e}` }) }
      }
    } catch (e: any) {
      patch(idx, { status: 'error', error: e?.message ?? String(e) })
    }
  }

  const run = async () => {
    if (running) return
    const todo = itemsRef.current.map((_, i) => i).filter(i => itemsRef.current[i].enabled && itemsRef.current[i].status !== 'done')
    if (!todo.length) return
    stopRef.current = false; setRunning(true); setError(null)
    let cursor = 0
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 6)) }, async () => {
      while (cursor < todo.length && !stopRef.current) await runOne(todo[cursor++])
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
    const done = itemsRef.current.filter(i => i.versions.length)
    if (!done.length) return
    setZipping(true)
    try {
      const zip = new JSZip()
      for (const it of done) for (let v = 0; v < it.versions.length; v++) {
        const r = await fetch(it.versions[v]); if (r.ok) zip.file(fileName(it, v + 1), await r.blob())
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `marketing_assets_${Date.now()}.zip`; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (e: any) { setError(`ZIP : ${e?.message ?? e}`) }
    finally { setZipping(false) }
  }

  const folders = useMemo(() => [...new Set(items.map(i => i.row.folder))], [items])
  const stats = useMemo(() => ({
    total: items.length,
    done: items.filter(i => i.status === 'done').length,
    errors: items.filter(i => i.status === 'error').length,
    toRun: items.filter(i => i.enabled && i.status !== 'done').length,
    withResult: items.filter(i => i.versions.length).length,
    unknown: [...new Set(items.flatMap(i => resolve(i.row).unknown))],
  }), [items, byName]) // eslint-disable-line react-hooks/exhaustive-deps
  const estCost = (stats.toRun * (quality === '4K' ? 0.24 : 0.134)).toFixed(2)

  const card: React.CSSProperties = { border: '1px solid #E5E7EB', borderRadius: 12, padding: 16, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }
  const label: React.CSSProperties = { fontSize: 12, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 6 }
  const inp: React.CSSProperties = { border: '1px solid #D1D5DB', borderRadius: 8, padding: '6px 10px', fontSize: 14, minHeight: 34, background: '#fff', width: '100%' }
  const btn = (bg: string, color = '#fff'): React.CSSProperties => ({ background: bg, color, border: 'none', borderRadius: 8, padding: '8px 16px', fontWeight: 600, fontSize: 14, cursor: 'pointer' })
  const small = (on = false): React.CSSProperties => ({ ...btn(on ? '#0D4A5C' : '#E5E7EB', on ? '#fff' : '#374151'), padding: '4px 10px', fontSize: 12 })
  const pill = (bg: string, color = '#fff'): React.CSSProperties => ({ background: bg, color, borderRadius: 999, padding: '2px 8px', fontSize: 10, fontWeight: 600 })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 22 }}>📣</span>
          <h2 style={{ margin: 0, color: '#0D4A5C', fontSize: 18 }}>Marketing assets — batch de prompts depuis Notion</h2>
        </div>
        <p style={{ fontSize: 13, color: '#6B7280', margin: 0 }}>
          ZIP Notion à 4 colonnes : <strong>Dossier</strong> (sous-dossier de sortie) · <strong>Mannequin(s)</strong> (noms du catalogue Miraggia, « Garance + Robin » pour un duo ; vide, « — (produit) » ou nom inconnu = visuel produit) · <strong>Vêtements et produits</strong> (fichiers) · <strong>Prompt</strong>.
        </p>
        <div style={{ fontSize: 12, marginTop: 6, color: catalogError ? '#B91C1C' : '#047857' }}>
          {catalogError ? `⚠ Catalogue mannequins : ${catalogError}` : catalog ? `✓ Catalogue Miraggia : ${catalog.length} mannequins` : '⏳ Chargement du catalogue mannequins…'}
        </div>
      </div>

      <div style={card}>
        <div style={label}>1 — ZIP Notion</div>
        <Dropzone files={zips} onChange={handleZip} accept=".zip" multiple={false} label="Glisse l'export Notion" hint="Dossier · Mannequin(s) · Vêtements et produits · Prompt" />
        {parsing && <div style={{ marginTop: 8, fontSize: 13, color: '#0D4A5C' }}>⏳ {progress}</div>}
        {parsed && (
          <details style={{ marginTop: 8, fontSize: 12, color: '#374151', background: '#F9FAFB', padding: 8, borderRadius: 6 }}>
            <summary style={{ cursor: 'pointer' }}>✓ {items.length} visuel(s) · {folders.length} dossier(s){stats.unknown.length ? ` · ⚠ ${stats.unknown.length} nom(s) hors catalogue → traités comme produit` : ''}</summary>
            <ul style={{ fontSize: 11, color: '#6B7280', margin: '4px 0', paddingLeft: 16 }}>
              {parsed.warnings.map((w, i) => <li key={i}>{w}</li>)}
              {stats.unknown.length > 0 && <li style={{ color: '#B45309' }}>Hors catalogue (→ produit) : {stats.unknown.join(', ')}</li>}
            </ul>
          </details>
        )}
      </div>

      <div style={card}>
        <div style={label}>2 — Paramètres</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Format</div>
            <select value={ratioMode} onChange={e => setRatioMode(e.target.value)} style={inp}>
              {RATIOS.map(r => <option key={r} value={r}>{r === 'auto' ? 'Auto (lu dans le prompt, sinon 4:5)' : r}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Qualité</div>
            <select value={quality} onChange={e => setQuality(e.target.value)} style={inp}>{['1K', '2K', '4K'].map(q => <option key={q}>{q}</option>)}</select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Parallèle</div>
            <select value={concurrency} onChange={e => setConcurrency(+e.target.value)} style={inp}>{[1, 2, 3, 4, 6].map(n => <option key={n} value={n}>{n}</option>)}</select>
          </div>
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: '#0D4A5C', marginTop: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={withHeader} onChange={e => setWithHeader(e.target.checked)} style={{ marginTop: 2 }} />
          <span><strong>Ajouter l'en-tête « quelle image est quoi »</strong> avant le prompt
            <span style={{ display: 'block', fontSize: 11, color: '#6B7A8A' }}>Indique à l'IA quel visage / corps appartient à quel mannequin et quels fichiers sont la tenue ou le produit. Recommandé, surtout pour les duos.</span></span>
        </label>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={pickOutDir} disabled={running} style={small(!!outDirName)}>📁 {outDirName ? `Sortie : ${outDirName} (sous-dossiers par Dossier)` : 'Dossier de sortie (optionnel)'}</button>
          {outDirName && <button onClick={() => { outDirRef.current = null; setOutDirName(null) }} style={small()}>✕</button>}
          <button onClick={run} disabled={running || !stats.toRun || !catalog}
                  style={{ ...btn(running || !stats.toRun || !catalog ? '#9CA3AF' : '#0D4A5C'), cursor: running || !stats.toRun ? 'not-allowed' : 'pointer' }}>
            {running ? `⏳ ${stats.done}/${stats.total}…` : `🚀 Générer ${stats.toRun} visuel${stats.toRun > 1 ? 's' : ''} (≈ ${estCost} $)`}
          </button>
          {running && <button onClick={() => { stopRef.current = true }} style={btn('#DC2626')}>⏹ Stop</button>}
          <button onClick={downloadZip} disabled={zipping || !stats.withResult} style={{ ...btn(stats.withResult ? '#374151' : '#9CA3AF'), cursor: stats.withResult ? 'pointer' : 'not-allowed' }}>
            {zipping ? '⏳ ZIP…' : `⬇ ZIP par dossier (${stats.withResult})`}
          </button>
          {stats.errors > 0 && <span style={{ fontSize: 12, color: '#B91C1C' }}>✕ {stats.errors} erreur(s) — relance pour réessayer</span>}
        </div>
        {error && <div style={{ marginTop: 10, background: '#FEF2F2', color: '#991B1B', padding: 8, borderRadius: 6, fontSize: 12 }}>❌ {error}</div>}
      </div>

      {parsed && folders.map(folder => (
        <div key={folder} style={card}>
          <div style={{ ...label, display: 'flex', alignItems: 'center', gap: 8 }}>
            📁 {folder}
            <span style={{ textTransform: 'none', fontWeight: 400 }}>· {items.filter(i => i.row.folder === folder).length} visuel(s)</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
            {items.map((it, idx) => {
              if (it.row.folder !== folder) return null
              const { found, unknown, isProduct } = resolve(it.row)
              return (
                <div key={idx} style={{ border: '1px solid #E5E7EB', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 6, opacity: it.enabled ? 1 : 0.55 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <input type="checkbox" checked={it.enabled} disabled={running} onChange={e => patch(idx, { enabled: e.target.checked })} />
                    {it.status === 'running' && <span style={pill('#F59E0B')}>⏳</span>}
                    {it.status === 'done' && <span style={pill('#10B981')}>✓</span>}
                    {it.status === 'error' && <span style={pill('#EF4444')}>✕</span>}
                    <strong>#{String(it.row.index).padStart(2, '0')}</strong>
                    {isProduct
                      ? <span style={pill('#EDE9FE', '#5B21B6')}>📦 produit</span>
                      : found.map(m => <span key={m.id} style={pill('#E0F2FE', '#075985')}>{m.name}</span>)}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {!isProduct && found.map(m => <img key={m.id} src={m.faceUrl} alt={m.name} title={m.name} style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6, border: '1px solid #E5E7EB' }} />)}
                    {it.row.fileKeys.map(k => <Thumb key={k} getFile={parsed.getFile} zipKey={k} />)}
                  </div>
                  {unknown.length > 0 && <div style={{ fontSize: 10, color: '#B45309' }}>⚠ « {unknown.join(', ')} » hors catalogue{found.length ? ' — ignoré' : ' → visuel produit'}</div>}
                  {it.row.missingFiles.length > 0 && <div style={{ fontSize: 10, color: '#B91C1C' }}>⚠ fichier(s) introuvable(s) : {it.row.missingFiles.join(', ')}</div>}
                  {isProduct && !it.row.fileKeys.length && <div style={{ fontSize: 10, color: '#6B7280' }}>Aucun fichier produit : prompt seul.</div>}
                  {it.imageUrl
                    ? <a href={it.imageUrl} target="_blank" rel="noreferrer"><img src={it.imageUrl} alt="" style={{ width: '100%', borderRadius: 6, display: 'block' }} /></a>
                    : <div style={{ aspectRatio: (ratioMode === 'auto' ? ratioFromPrompt(it.prompt) : ratioMode).replace(':', '/'), maxHeight: 220, borderRadius: 6, border: '1px dashed #E5E7EB', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#9CA3AF' }}>{it.status === 'running' ? '⏳ génération…' : '—'}</div>}
                  {it.versions.length > 1 && (
                    <div style={{ display: 'flex', gap: 4 }}>{it.versions.map((v, i) => <button key={i} onClick={() => patch(idx, { imageUrl: v })} style={{ ...small(v === it.imageUrl), padding: '2px 8px', fontSize: 11 }}>v{i + 1}</button>)}</div>
                  )}
                  {it.error && <div style={{ fontSize: 11, color: '#EF4444' }}>{it.error.slice(0, 220)}</div>}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => runOne(idx)} disabled={it.status === 'running'} style={small()}>{it.versions.length ? '↺ Regénérer' : '▶ Générer'}</button>
                    <button onClick={() => patch(idx, { showPrompt: !it.showPrompt })} style={small(it.showPrompt)}>Prompt</button>
                  </div>
                  {it.showPrompt && (
                    <>
                      <textarea value={it.prompt} onChange={e => patch(idx, { prompt: e.target.value })}
                                style={{ width: '100%', minHeight: 140, fontSize: 11, lineHeight: 1.4, border: '1px solid #D1D5DB', borderRadius: 6, padding: 6, boxSizing: 'border-box', fontFamily: 'system-ui', resize: 'vertical' }} />
                      {withHeader && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 10, color: '#6B7280', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 6, padding: 6, margin: 0 }}>{headerFor(it.row, found, isProduct) || '(aucune image : pas d\'en-tête)'}</pre>}
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
