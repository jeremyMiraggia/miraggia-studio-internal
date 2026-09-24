'use client'
/**
 * Onglet 📐 Gabarit — N visuels en entrée, le MÊME prompt pour chacun, N visuels en sortie.
 * Passe par /api/studio/free en mode brut (prompt exact + image, sans texte ajouté).
 */
import { useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import { upload } from '@vercel/blob/client'
import Dropzone from '@/components/ui/Dropzone'

type Status = 'pending' | 'running' | 'done' | 'error'
type Item = { file: File; previewUrl: string; status: Status; imageUrl?: string; error?: string }

const PROPOSED_PROMPT = `Transform this garment photo into a minimalist garment template for a flat-lay packshot workflow.

KEEP EXACTLY
- The outer silhouette of the garment: overall outline, width and length, shoulder line, sleeve or leg length, sleeve or leg angle and position, hem shape.
- The same scale and proportions as the input image.

REMOVE COMPLETELY
- All color, fabric texture, pattern, sheen and weave.
- Every internal line and detail, including: buttons, placket, zips, fly, pockets, seams, topstitching, darts, pleats, creases, ribbing, waistband, belt loops, drawstrings, turn-up cuffs, trims, labels, logos, lining, embroidery.
- The collar: replace it with a plain, simple round neckline, with no collar, no opening and no placket.
- Hems and waist edges become plain, straight, clean edges.

RENDERING
- The garment is a solid, flat, matte mid-grey (#9E9E9E) silhouette, like a paper cutout of the garment shape.
- No internal lines at all, except where the shape itself separates (for example the gap between trouser legs or between sleeve and body).
- Only very soft, barely visible shading to give a hint of volume. No wrinkles, no folds.
- Pure white seamless background (#FFFFFF), filling the entire image edge to edge. No shadow, no border, no frame, no vignette.
- Centered, perfectly symmetrical, with even margins on all sides. Output in 3:4 portrait format.
- Nothing else in the image: no text, no hanger, no props.`

function baseName(name: string) {
  return name.replace(/\.[a-z0-9]+$/i, '').replace(/[\/\\:*?"<>|]/g, '_') || 'visuel'
}

export default function GabaritTab() {
  const [items, setItems]     = useState<Item[]>([])
  const itemsRef              = useRef<Item[]>([])
  const [prompt, setPrompt]   = useState(PROPOSED_PROMPT)
  const [ratio, setRatio]     = useState('3:4')
  const [quality, setQuality] = useState('2K')
  const [concurrency, setConcurrency] = useState(3)
  const [running, setRunning] = useState(false)
  const [zipping, setZipping] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError]     = useState<string | null>(null)

  const setItem = (idx: number, patch: Partial<Item>) => setItems(prev => {
    const next = [...prev]; next[idx] = { ...next[idx], ...patch }; itemsRef.current = next; return next
  })

  const handleFiles = (files: File[]) => {
    itemsRef.current.forEach(i => URL.revokeObjectURL(i.previewUrl))
    const next: Item[] = files.map(f => ({ file: f, previewUrl: URL.createObjectURL(f), status: 'pending' }))
    setItems(next); itemsRef.current = next; setError(null)
  }

  const runOne = async (idx: number) => {
    const it = itemsRef.current[idx]
    if (!it) return
    setItem(idx, { status: 'running', error: undefined })
    try {
      const b = await upload(`gabarit-inputs/${Date.now()}-${it.file.name}`, it.file, {
        access: 'public', handleUploadUrl: '/api/blob-upload', contentType: it.file.type || 'application/octet-stream',
      })
      const res = await fetch('/api/studio/free', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, ratio, quality, refUrls: [b.url] }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      if (!j.imageUrl) throw new Error('Réponse sans image.')
      setItem(idx, { status: 'done', imageUrl: j.imageUrl })
    } catch (e: any) {
      setItem(idx, { status: 'error', error: e?.message ?? String(e) })
    }
  }

  const run = async () => {
    if (running) return
    if (!prompt.trim()) { setError('Prompt vide.'); return }
    if (itemsRef.current.length === 0) { setError('Aucun visuel.'); return }
    setRunning(true); setError(null)
    const todo = itemsRef.current.map((it, idx) => idx).filter(idx => itemsRef.current[idx].status !== 'done')
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
    const done = itemsRef.current.filter(i => i.imageUrl)
    if (!done.length) { setError('Rien à exporter.'); return }
    setZipping(true)
    try {
      const zip = new JSZip()
      const used = new Set<string>()
      for (const it of done) {
        const r = await fetch(it.imageUrl!); if (!r.ok) continue
        const blob = await r.blob()
        const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg'
        let name = `${baseName(it.file.name)}-gabarit.${ext}`, n = 2
        while (used.has(name)) name = `${baseName(it.file.name)}-gabarit_${n++}.${ext}`
        used.add(name); zip.file(name, blob)
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `gabarit_${Date.now()}.zip`; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (e: any) { setError(`ZIP : ${e?.message ?? e}`) }
    finally { setZipping(false) }
  }

  const stats = useMemo(() => ({
    total: items.length,
    done: items.filter(i => i.status === 'done').length,
    errors: items.filter(i => i.status === 'error').length,
    toRun: items.filter(i => i.status !== 'done').length,
  }), [items])
  const estCost = (stats.toRun * (quality === '4K' ? 0.24 : 0.13)).toFixed(2)

  const card: React.CSSProperties = { border: '1px solid #E5E7EB', borderRadius: 12, padding: 16, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }
  const label: React.CSSProperties = { fontSize: 12, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 6 }
  const inp: React.CSSProperties = { border: '1px solid #D1D5DB', borderRadius: 8, padding: '6px 10px', fontSize: 14, minHeight: 34, background: '#fff', width: '100%' }
  const btn = (bg: string, color = '#fff'): React.CSSProperties => ({ background: bg, color, border: 'none', borderRadius: 8, padding: '8px 16px', fontWeight: 600, fontSize: 14, cursor: 'pointer' })
  const pill = (bg: string, color = '#fff'): React.CSSProperties => ({ background: bg, color, borderRadius: 999, padding: '2px 8px', fontSize: 10, fontWeight: 600 })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 22 }}>📐</span>
          <h2 style={{ margin: 0, color: '#0D4A5C', fontSize: 18 }}>Gabarit — même prompt sur N visuels</h2>
        </div>
        <p style={{ fontSize: 13, color: '#6B7280', margin: 0 }}>
          Dépose un ou plusieurs visuels : chacun est envoyé à Gemini avec le prompt ci-dessous, tel quel (mode brut, image sans compression). Un visuel de sortie par visuel d'entrée, nommé <code>NOM-gabarit</code>, ZIP à la fin.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={card}>
          <div style={label}>1 — Visuels</div>
          <Dropzone files={items.map(i => i.file)} onChange={handleFiles} multiple accept="image/*"
                    label="Glisse un ou plusieurs visuels" hint="Un visuel de sortie par visuel d'entrée" />
        </div>
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={label}>2 — Prompt (identique pour tous)</div>
            <button onClick={() => setPrompt(PROPOSED_PROMPT)} style={{ ...btn('#E5E7EB', '#374151'), padding: '4px 10px', fontSize: 12 }}>📋 Prompt proposé (gabarit gris)</button>
          </div>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)}
                    style={{ width: '100%', minHeight: 260, fontSize: 12, lineHeight: 1.45, border: '1px solid #D1D5DB', borderRadius: 8, padding: 10, boxSizing: 'border-box', fontFamily: 'system-ui', resize: 'vertical' }} />
        </div>
      </div>

      <div style={card}>
        <div style={label}>3 — Paramètres</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Ratio</div>
            <select value={ratio} onChange={e => setRatio(e.target.value)} style={inp}>
              {['3:4', '4:5', '2:3', '1:1', '9:16', '3:2', '4:3', '16:9'].map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Qualité</div>
            <select value={quality} onChange={e => setQuality(e.target.value)} style={inp}>
              {['1K', '2K', '4K'].map(q => <option key={q} value={q}>{q}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Parallèle</div>
            <select value={concurrency} onChange={e => setConcurrency(parseInt(e.target.value, 10))} style={inp}>
              {[1, 2, 3, 4, 6].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={run} disabled={running || stats.toRun === 0}
                  style={{ ...btn(running || stats.toRun === 0 ? '#9CA3AF' : '#0D4A5C'), cursor: running || stats.toRun === 0 ? 'not-allowed' : 'pointer' }}>
            {running ? `⏳ Génération ${progress}…` : `🚀 Générer ${stats.toRun} visuel${stats.toRun > 1 ? 's' : ''} (≈ ${estCost} $)`}
          </button>
          <button onClick={downloadZip} disabled={zipping || stats.done === 0} style={{ ...btn(stats.done === 0 ? '#9CA3AF' : '#374151'), cursor: stats.done === 0 ? 'not-allowed' : 'pointer' }}>
            {zipping ? '⏳ ZIP…' : `⬇ ZIP (${stats.done})`}
          </button>
          {stats.errors > 0 && <span style={{ fontSize: 12, color: '#B91C1C' }}>✕ {stats.errors} erreur(s) — relance « Générer » pour réessayer</span>}
        </div>
        {error && <div style={{ marginTop: 10, background: '#FEF2F2', color: '#991B1B', padding: 8, borderRadius: 6, fontSize: 12 }}>❌ {error}</div>}
      </div>

      {items.length > 0 && (
        <div style={card}>
          <div style={label}>4 — Résultats ({stats.done}/{stats.total})</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
            {items.map((it, idx) => (
              <div key={idx} style={{ border: '1px solid #E5E7EB', borderRadius: 8, padding: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 11 }}>
                  {it.status === 'pending' && <span style={pill('#9CA3AF')}>•</span>}
                  {it.status === 'running' && <span style={pill('#F59E0B')}>⏳</span>}
                  {it.status === 'done'    && <span style={pill('#10B981')}>✓</span>}
                  {it.status === 'error'   && <span style={pill('#EF4444')}>✕</span>}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#374151' }} title={it.file.name}>{it.file.name}</span>
                  {it.status !== 'running' && !running && (
                    <button onClick={() => runOne(idx)} title="Regénérer" style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 }}>↺</button>
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  <img src={it.previewUrl} alt="in" style={{ width: '100%', borderRadius: 4, aspectRatio: '3/4', objectFit: 'contain', background: '#F3F4F6' }} />
                  {it.imageUrl
                    ? <a href={it.imageUrl} target="_blank" rel="noreferrer"><img src={it.imageUrl} alt="out" style={{ width: '100%', borderRadius: 4, aspectRatio: '3/4', objectFit: 'contain', background: '#F3F4F6' }} /></a>
                    : <div style={{ aspectRatio: '3/4', borderRadius: 4, border: '1px dashed #E5E7EB', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#9CA3AF' }}>—</div>}
                </div>
                {it.error && <div style={{ fontSize: 10, color: '#EF4444', marginTop: 4 }} title={it.error}>{it.error.slice(0, 120)}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
