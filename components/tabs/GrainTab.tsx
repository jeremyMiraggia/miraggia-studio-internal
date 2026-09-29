'use client'
/**
 * Onglet 🎞️ Grain — applique un grain argentique à un lot de visuels, entièrement
 * dans le navigateur (canvas) : pas d'upload, pas de limite de taille, pas de coût API.
 * Entrée : un visuel, plusieurs, ou un dossier entier (sous-dossiers conservés).
 * Aperçu avant/après pleine résolution sur le visuel sélectionné.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import { applyGrain, decodeFile, grainFile, hashSeed, outputType, DEFAULT_GRAIN, type GrainParams } from '@/lib/grain'

type Status = 'pending' | 'running' | 'done' | 'error'
type Item = { file: File; path: string; thumbUrl: string; status: Status; outBlob?: Blob; error?: string }

const IMAGE_RE = /\.(jpe?g|png|webp|avif|bmp)$/i
const PRESETS: { label: string; p: Partial<GrainParams> }[] = [
  { label: 'Léger',  p: { intensity: 12, size: 1 } },
  { label: 'Moyen',  p: { intensity: 25, size: 1.5 } },
  { label: 'Fort',   p: { intensity: 45, size: 2 } },
]

const isImage = (f: File) => !f.name.startsWith('.') && (IMAGE_RE.test(f.name) || (f.type.startsWith('image/') && f.type !== 'image/gif'))

/** Parcourt un drop (fichiers et/ou dossiers, récursif). webkitGetAsEntry doit être appelé avant tout await. */
async function filesFromDrop(dt: DataTransfer): Promise<{ file: File; path: string }[]> {
  const entries = Array.from(dt.items).map(i => i.webkitGetAsEntry?.()).filter(Boolean) as any[]
  if (!entries.length) return Array.from(dt.files).map(f => ({ file: f, path: f.name }))
  const out: { file: File; path: string }[] = []
  const walk = async (entry: any, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const f: File = await new Promise((res, rej) => entry.file(res, rej))
      out.push({ file: f, path: prefix + f.name })
    } else if (entry.isDirectory) {
      const reader = entry.createReader()
      for (;;) {
        const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej))
        if (!batch.length) break
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`)
      }
    }
  }
  for (const e of entries) await walk(e, '')
  return out
}

function outputPath(it: Item, suffix: boolean) {
  const type = outputType(it.file)
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg'
  const base = it.path.replace(/\.[a-z0-9]+$/i, '')
  const keepExt = it.path.match(/\.(jpe?g|png|webp)$/i)?.[1]
  return `${base}${suffix ? '_grain' : ''}.${keepExt ?? ext}`
}

export default function GrainTab() {
  const [items, setItems]       = useState<Item[]>([])
  const itemsRef                = useRef<Item[]>([])
  const [params, setParams]     = useState<GrainParams>(DEFAULT_GRAIN)
  const [suffix, setSuffix]     = useState(true)
  const [selected, setSelected] = useState(0)
  const [hover, setHover]       = useState(false)
  const [running, setRunning]   = useState(false)
  const [progress, setProgress] = useState('')
  const [zipping, setZipping]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [info, setInfo]         = useState<string | null>(null)
  const [outDirName, setOutDirName] = useState<string | null>(null)
  const outDirRef = useRef<any>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dirInputRef  = useRef<HTMLInputElement>(null)

  // Aperçu
  const [split, setSplit]         = useState(50)
  const [zoom100, setZoom100]     = useState(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewErr, setPreviewErr]   = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const origRef   = useRef<{ key: string; img: ImageData } | null>(null)

  const commit = (next: Item[]) => { itemsRef.current = next; setItems(next) }
  const setItem = (idx: number, patch: Partial<Item>) => {
    const next = [...itemsRef.current]; next[idx] = { ...next[idx], ...patch }; commit(next)
  }

  /* ----------- Entrée ----------- */
  const addFiles = (incoming: { file: File; path: string }[]) => {
    const imgs = incoming.filter(x => isImage(x.file))
    const skipped = incoming.length - imgs.length
    const seen = new Set(itemsRef.current.map(i => `${i.path}:${i.file.size}`))
    const fresh = imgs.filter(x => !seen.has(`${x.path}:${x.file.size}`))
      .map(x => ({ file: x.file, path: x.path, thumbUrl: URL.createObjectURL(x.file), status: 'pending' as Status }))
    if (!fresh.length && !skipped) return
    commit([...itemsRef.current, ...fresh])
    setError(null)
    setInfo(`${fresh.length} visuel${fresh.length > 1 ? 's' : ''} ajouté${fresh.length > 1 ? 's' : ''}${skipped ? ` · ${skipped} fichier(s) ignoré(s) (pas des images)` : ''}`)
  }
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setHover(false)
    try { addFiles(await filesFromDrop(e.dataTransfer)) }
    catch (err: any) { setError(`Lecture du dépôt : ${err?.message ?? err}`) }
  }
  const onPick = (list: FileList | null) => {
    if (!list) return
    addFiles(Array.from(list).map(f => ({ file: f, path: (f as any).webkitRelativePath || f.name })))
  }
  const clearAll = () => {
    itemsRef.current.forEach(i => URL.revokeObjectURL(i.thumbUrl))
    commit([]); setSelected(0); origRef.current = null; setInfo(null); setError(null)
  }
  const removeAt = (idx: number) => {
    URL.revokeObjectURL(itemsRef.current[idx].thumbUrl)
    commit(itemsRef.current.filter((_, i) => i !== idx))
    setSelected(s => Math.max(0, Math.min(s > idx ? s - 1 : s, itemsRef.current.length - 1)))
  }

  // Changer un réglage invalide les sorties déjà calculées
  const updateParams = (patch: Partial<GrainParams>) => {
    if (running) return
    setParams(p => ({ ...p, ...patch }))
    if (itemsRef.current.some(i => i.status !== 'pending'))
      commit(itemsRef.current.map(i => ({ ...i, status: 'pending', outBlob: undefined, error: undefined })))
  }

  /* ----------- Aperçu (pleine résolution, débounce) ----------- */
  const current = items[selected]
  useEffect(() => {
    if (!current) return
    let cancelled = false
    const key = `${current.path}:${current.file.size}`
    const t = setTimeout(async () => {
      setPreviewBusy(true); setPreviewErr(null)
      try {
        if (origRef.current?.key !== key) origRef.current = { key, img: await decodeFile(current.file) }
        if (cancelled) return
        const orig = origRef.current.img
        const img = new ImageData(new Uint8ClampedArray(orig.data), orig.width, orig.height)
        applyGrain(img, params, hashSeed(current.path))
        const c = canvasRef.current
        if (!c || cancelled) return
        c.width = img.width; c.height = img.height
        c.getContext('2d')!.putImageData(img, 0, 0)
      } catch (e: any) {
        if (!cancelled) setPreviewErr(`Aperçu impossible : ${e?.message ?? e}`)
      } finally {
        if (!cancelled) setPreviewBusy(false)
      }
    }, 150)
    return () => { cancelled = true; clearTimeout(t) }
  }, [current?.file, current?.path, params]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ----------- Sortie ----------- */
  const pickOutDir = async () => {
    try {
      // @ts-ignore
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
      outDirRef.current = handle; setOutDirName(handle.name ?? 'dossier')
    } catch (e: any) {
      if (e?.name !== 'AbortError') setError(`Sélection dossier : ${e?.message ?? e}`)
    }
  }
  const writeToDir = async (relPath: string, blob: Blob) => {
    let dir = outDirRef.current
    const parts = relPath.split('/')
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true })
    const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true })
    const w = await fh.createWritable(); await w.write(blob); await w.close()
  }

  const run = async () => {
    if (running) return
    const todo = itemsRef.current.map((_, i) => i).filter(i => itemsRef.current[i].status !== 'done')
    if (!todo.length) return
    setRunning(true); setError(null)
    const p = params
    for (let k = 0; k < todo.length; k++) {
      const idx = todo[k], it = itemsRef.current[idx]
      setProgress(`${k + 1}/${todo.length}`)
      setItem(idx, { status: 'running', error: undefined })
      await new Promise(r => setTimeout(r, 0))   // laisse l'UI respirer
      try {
        const { blob } = await grainFile(it.file, p, hashSeed(it.path))
        if (outDirRef.current) {
          await writeToDir(outputPath(it, suffix), blob)
          setItem(idx, { status: 'done' })          // déjà sur disque : on ne garde pas le blob en mémoire
        } else {
          setItem(idx, { status: 'done', outBlob: blob })
        }
      } catch (e: any) {
        setItem(idx, { status: 'error', error: e?.message ?? String(e) })
      }
    }
    setProgress(''); setRunning(false)
  }

  const downloadZip = async () => {
    const done = itemsRef.current.filter(i => i.outBlob)
    if (!done.length) return
    setZipping(true)
    try {
      const zip = new JSZip()
      for (const it of done) zip.file(outputPath(it, suffix), it.outBlob!)
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `grain_${Date.now()}.zip`; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (e: any) { setError(`ZIP : ${e?.message ?? e}`) }
    finally { setZipping(false) }
  }

  const stats = useMemo(() => ({
    total: items.length,
    done: items.filter(i => i.status === 'done').length,
    inMemory: items.filter(i => i.outBlob).length,
    errors: items.filter(i => i.status === 'error').length,
    toRun: items.filter(i => i.status !== 'done').length,
  }), [items])

  /* ----------- Styles ----------- */
  const card: React.CSSProperties = { border: '1px solid #E5E7EB', borderRadius: 12, padding: 16, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }
  const label: React.CSSProperties = { fontSize: 12, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 6 }
  const btn = (bg: string, color = '#fff'): React.CSSProperties => ({ background: bg, color, border: 'none', borderRadius: 8, padding: '8px 16px', fontWeight: 600, fontSize: 14, cursor: 'pointer' })
  const small = (active = false): React.CSSProperties => ({ ...btn(active ? '#0D4A5C' : '#E5E7EB', active ? '#fff' : '#374151'), padding: '4px 10px', fontSize: 12 })
  const pill = (bg: string): React.CSSProperties => ({ background: bg, color: '#fff', borderRadius: 999, padding: '1px 6px', fontSize: 9, fontWeight: 600 })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 22 }}>🎞️</span>
          <h2 style={{ margin: 0, color: '#0D4A5C', fontSize: 18 }}>Grain — même grain sur N visuels</h2>
        </div>
        <p style={{ fontSize: 13, color: '#6B7280', margin: 0 }}>
          Dépose un visuel, plusieurs ou un dossier entier, règle le grain sur l'aperçu, puis applique à tout le lot.
          Tout se passe dans le navigateur (aucun envoi, pleine résolution, format d'origine conservé).
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) minmax(0, 2fr)', gap: 16, alignItems: 'start' }}>
        {/* ---- Colonne gauche : entrée + réglages ---- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={card}>
            <div style={label}>1 — Visuels</div>
            <div
              onDrop={onDrop}
              onDragOver={e => { e.preventDefault(); setHover(true) }}
              onDragLeave={e => { e.preventDefault(); setHover(false) }}
              style={{
                border: `1.5px dashed ${hover ? '#0D4A5C' : 'rgba(13,74,92,0.25)'}`, background: hover ? '#E8F2F5' : '#FAFBFC',
                borderRadius: 10, padding: 16, textAlign: 'center', transition: 'all 0.15s ease',
              }}
            >
              <div style={{ fontSize: 22, marginBottom: 6 }}>⬆</div>
              <div style={{ fontSize: 13, color: '#0D4A5C', fontWeight: 600 }}>Glisse des visuels ou un dossier</div>
              <div style={{ fontSize: 11, color: '#6B7A8A', margin: '2px 0 10px' }}>JPG, PNG, WebP — sous-dossiers conservés</div>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                <button onClick={() => fileInputRef.current?.click()} style={small()}>📄 Fichiers</button>
                <button onClick={() => dirInputRef.current?.click()} style={small()}>📁 Dossier</button>
              </div>
              <input ref={fileInputRef} type="file" multiple accept="image/*" style={{ display: 'none' }}
                     onChange={e => { onPick(e.target.files); e.target.value = '' }} />
              <input ref={dirInputRef} type="file" multiple style={{ display: 'none' }}
                     // @ts-ignore — attribut non standard, supporté par Chrome/Edge/Firefox
                     webkitdirectory=""
                     onChange={e => { onPick(e.target.files); e.target.value = '' }} />
            </div>
            {info && <div style={{ fontSize: 11, color: '#6B7280', marginTop: 6 }}>{info}</div>}
            {items.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, fontSize: 12, color: '#374151' }}>
                <span>{items.length} visuel{items.length > 1 ? 's' : ''}</span>
                <button onClick={clearAll} disabled={running} style={small()}>Vider</button>
              </div>
            )}
          </div>

          <div style={card}>
            <div style={label}>2 — Réglages</div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              {PRESETS.map(pr => (
                <button key={pr.label} onClick={() => updateParams(pr.p)}
                        style={small(params.intensity === pr.p.intensity && params.size === pr.p.size)}>{pr.label}</button>
              ))}
            </div>

            <div style={{ fontSize: 12, color: '#374151', display: 'flex', justifyContent: 'space-between' }}>
              <span>Intensité</span><b>{params.intensity}</b>
            </div>
            <input type="range" min={0} max={100} step={1} value={params.intensity}
                   onChange={e => updateParams({ intensity: +e.target.value })} style={{ width: '100%' }} />

            <div style={{ fontSize: 12, color: '#374151', display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
              <span>Taille du grain</span><b>{params.size.toFixed(1)} px</b>
            </div>
            <input type="range" min={1} max={4} step={0.5} value={params.size}
                   onChange={e => updateParams({ size: +e.target.value })} style={{ width: '100%' }} />

            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              <button onClick={() => updateParams({ color: false })} style={small(!params.color)}>Monochrome</button>
              <button onClick={() => updateParams({ color: true })} style={small(params.color)}>Couleur</button>
            </div>

            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#374151', marginTop: 12 }}>
              <input type="checkbox" checked={suffix} onChange={e => setSuffix(e.target.checked)} />
              Ajouter <code>_grain</code> au nom des fichiers
            </label>
          </div>

          <div style={card}>
            <div style={label}>3 — Appliquer</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
              <button onClick={pickOutDir} disabled={running} style={small(!!outDirName)}>📂 {outDirName ? `Sortie : ${outDirName}` : 'Dossier de sortie (optionnel)'}</button>
              {outDirName && <button onClick={() => { outDirRef.current = null; setOutDirName(null) }} disabled={running} style={small()}>✕</button>}
            </div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 10 }}>
              {outDirName ? 'Chaque visuel est écrit dans ce dossier dès qu\'il est prêt.' : 'Sans dossier de sortie, les visuels sont gardés en mémoire pour le ZIP.'}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={run} disabled={running || stats.toRun === 0}
                      style={{ ...btn(running || stats.toRun === 0 ? '#9CA3AF' : '#0D4A5C'), cursor: running || stats.toRun === 0 ? 'not-allowed' : 'pointer' }}>
                {running ? `⏳ ${progress}…` : `🎞️ Appliquer à ${stats.toRun} visuel${stats.toRun > 1 ? 's' : ''}`}
              </button>
              <button onClick={downloadZip} disabled={zipping || stats.inMemory === 0}
                      style={{ ...btn(stats.inMemory === 0 ? '#9CA3AF' : '#374151'), cursor: stats.inMemory === 0 ? 'not-allowed' : 'pointer' }}>
                {zipping ? '⏳ ZIP…' : `⬇ ZIP (${stats.inMemory})`}
              </button>
            </div>
            {stats.done > 0 && <div style={{ fontSize: 12, color: '#047857', marginTop: 8 }}>✓ {stats.done}/{stats.total} traité{stats.done > 1 ? 's' : ''}</div>}
            {stats.errors > 0 && <div style={{ fontSize: 12, color: '#B91C1C', marginTop: 4 }}>✕ {stats.errors} erreur(s) — relance « Appliquer » pour réessayer</div>}
            {error && <div style={{ marginTop: 10, background: '#FEF2F2', color: '#991B1B', padding: 8, borderRadius: 6, fontSize: 12 }}>❌ {error}</div>}
          </div>
        </div>

        {/* ---- Colonne droite : aperçu ---- */}
        <div style={{ ...card, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ ...label, marginBottom: 0 }}>Aperçu {current ? `— ${current.path}` : ''} {previewBusy && '⏳'}</div>
            {current && (
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => setZoom100(false)} style={small(!zoom100)}>Ajusté</button>
                <button onClick={() => setZoom100(true)} style={small(zoom100)}>100 %</button>
              </div>
            )}
          </div>

          {!current ? (
            <div style={{ aspectRatio: '4/3', border: '1px dashed #E5E7EB', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9CA3AF', fontSize: 13 }}>
              Dépose des visuels pour voir l'aperçu
            </div>
          ) : (
            <>
              <div style={{ overflow: zoom100 ? 'auto' : 'hidden', maxHeight: zoom100 ? '70vh' : undefined, borderRadius: 8, background: '#F3F4F6' }}>
                <div style={{ position: 'relative', width: zoom100 ? 'max-content' : '100%', lineHeight: 0 }}>
                  {/* Avant (gauche) = original ; après (droite) = canvas avec grain, découpé */}
                  <img src={current.thumbUrl} alt="avant"
                       style={zoom100 ? { display: 'block', maxWidth: 'none' } : { display: 'block', width: '100%', maxHeight: '70vh', objectFit: 'contain' }} />
                  <canvas ref={canvasRef}
                          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', clipPath: `inset(0 0 0 ${split}%)` }} />
                  <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${split}%`, width: 2, background: '#fff', boxShadow: '0 0 4px rgba(0,0,0,0.5)', pointerEvents: 'none' }} />
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 11, color: '#6B7280' }}>
                <span>Avant</span>
                <input type="range" min={0} max={100} value={split} onChange={e => setSplit(+e.target.value)} style={{ flex: 1 }} />
                <span>Après</span>
              </div>
              {previewErr && <div style={{ fontSize: 12, color: '#B91C1C', marginTop: 6 }}>{previewErr}</div>}
            </>
          )}

          {items.length > 0 && (
            <>
              <div style={{ ...label, marginTop: 16 }}>Visuels — clique pour prévisualiser</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
                {items.map((it, idx) => (
                  <div key={`${it.path}:${idx}`} onClick={() => setSelected(idx)} title={it.error ?? it.path}
                       style={{ position: 'relative', borderRadius: 6, overflow: 'hidden', cursor: 'pointer', aspectRatio: '1/1',
                                border: idx === selected ? '2px solid #0D4A5C' : '1px solid rgba(13,74,92,0.1)' }}>
                    <img src={it.thumbUrl} alt={it.path} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    <div style={{ position: 'absolute', top: 3, left: 3 }}>
                      {it.status === 'running' && <span style={pill('#F59E0B')}>⏳</span>}
                      {it.status === 'done'    && <span style={pill('#10B981')}>✓</span>}
                      {it.status === 'error'   && <span style={pill('#EF4444')}>✕</span>}
                    </div>
                    {!running && (
                      <button onClick={e => { e.stopPropagation(); removeAt(idx) }} title="Retirer"
                              style={{ position: 'absolute', top: 3, right: 3, width: 18, height: 18, borderRadius: '50%', border: 'none',
                                       background: 'rgba(13,74,92,0.85)', color: '#fff', fontSize: 13, lineHeight: 1, cursor: 'pointer', padding: 0 }}>×</button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
