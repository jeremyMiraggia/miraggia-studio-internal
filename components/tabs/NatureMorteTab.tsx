'use client'
/**
 * Onglet 🍃 Nature Morte — génère des visuels still-life adaptatifs à partir d'un ZIP Notion.
 *
 * Pour chaque ligne du CSV LOOK :
 *   - Envoie à /api/studio/nature-morte les inputs présents (produits + éventuel reference/decors/model)
 *   - Le prompt Gemini s'adapte automatiquement
 */
import { useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import Dropzone from '@/components/ui/Dropzone'
import { compressImage } from '@/lib/compressImage'
import { parseNatureMorteExport, type NatureMorteTask, type NatureMorteExport } from '@/lib/notion/parseNatureMorteExport'

type TaskStatus = 'pending' | 'running' | 'done' | 'saved' | 'error' | 'skipped'

type State = {
  task:      NatureMorteTask
  status:    TaskStatus
  enabled:   boolean
  imageUrl?: string
  error?:    string
}

function sanitizeFilename(s: string): string {
  return s
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80) || 'visual'
}

async function ensureWritePermission(handle: any): Promise<boolean> {
  try {
    const opts = { mode: 'readwrite' as const }
    const q = await handle.queryPermission?.(opts) ?? 'prompt'
    if (q === 'granted') return true
    const r = await handle.requestPermission?.(opts) ?? 'denied'
    return r === 'granted'
  } catch { return false }
}

export default function NatureMorteTab() {
  const [zips, setZips]           = useState<File[]>([])
  const [parsing, setParsing]     = useState(false)
  const [parsed, setParsed]       = useState<NatureMorteExport | null>(null)
  const [states, setStates]       = useState<State[]>([])
  const statesRef                 = useRef<State[]>([])
  const [error, setError]         = useState<string | null>(null)
  const [progress, setProgress]   = useState('')

  // Paramètres globaux
  const [ratio, setRatio]         = useState('3:4')
  const [quality, setQuality]     = useState('2K')
  const [concurrency, setConcurrency] = useState(2)
  const [running, setRunning]     = useState(false)
  const [zipping, setZipping]     = useState(false)

  // Dossier sortie
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outputDirHandleRef = useRef<any | null>(null)
  const [outputDirName, setOutputDirName] = useState<string | null>(null)
  const [savedCount, setSavedCount] = useState(0)

  /* ----------- Parse ZIP ----------- */
  const handleZipChange = async (files: File[]) => {
    setZips(files)
    setError(null)
    setParsed(null)
    setStates([])
    if (files.length === 0) return
    setParsing(true)
    setProgress('Lecture du ZIP…')
    try {
      const res = await parseNatureMorteExport(files[0], (msg) => setProgress(msg))
      setParsed(res)
      const newStates: State[] = res.tasks.map(t => ({ task: t, status: 'pending', enabled: true }))
      setStates(newStates)
      statesRef.current = newStates
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setParsing(false)
      setProgress('')
    }
  }

  /* ----------- Dossier sortie ----------- */
  const pickOutputDir = async () => {
    try {
      // @ts-ignore
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
      const ok = await ensureWritePermission(handle)
      if (!ok) { setError('Permission readwrite refusée.'); return }
      outputDirHandleRef.current = handle
      setOutputDirName(handle.name ?? 'dossier')
      setSavedCount(0)
    } catch (e: any) {
      if (e?.name !== 'AbortError') setError(`Sélection dossier : ${e?.message ?? e}`)
    }
  }
  const clearOutputDir = () => {
    outputDirHandleRef.current = null
    setOutputDirName(null)
    setSavedCount(0)
  }

  const writeToOutputDir = async (state: State): Promise<boolean> => {
    const handle = outputDirHandleRef.current
    if (!handle || !state.imageUrl) return false
    try {
      const resp = await fetch(state.imageUrl)
      if (!resp.ok) throw new Error(`Fetch HTTP ${resp.status}`)
      const blob = await resp.blob()
      const ext = (blob.type.match(/^image\/(\w+)/) ?? [])[1]?.replace('jpeg', 'jpg') ?? 'jpg'
      const filename = `${sanitizeFilename(state.task.sku)}_${state.task.id}.${ext}`
      const fileHandle = await handle.getFileHandle(filename, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(blob)
      await writable.close()
      return true
    } catch (e: any) {
      console.warn('[NatureMorte] write failed', e?.message)
      return false
    }
  }

  /* ----------- ZIP download (toutes les images générées) ----------- */
  const downloadZip = async () => {
    const doneStates = statesRef.current.filter(s => (s.status === 'done' || s.status === 'saved') && s.imageUrl)
    if (doneStates.length === 0) {
      setError('Aucun visuel généré à empaqueter.')
      return
    }
    setZipping(true)
    setError(null)
    try {
      const zip = new JSZip()
      const usedNames = new Set<string>()
      for (const s of doneStates) {
        try {
          const resp = await fetch(s.imageUrl!)
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          const blob = await resp.blob()
          const ext = (blob.type.match(/^image\/(\w+)/) ?? [])[1]?.replace('jpeg', 'jpg') ?? 'jpg'
          const baseName = `${sanitizeFilename(s.task.sku)}_${s.task.id}`
          let filename = `${baseName}.${ext}`
          let n = 2
          while (usedNames.has(filename)) {
            filename = `${baseName}_${n}.${ext}`
            n++
          }
          usedNames.add(filename)
          zip.file(filename, blob)
        } catch (e: any) {
          console.warn('[NatureMorte] zip skip', s.task.sku, e)
        }
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `nature_morte_${Date.now()}.zip`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (e: any) {
      setError(`ZIP : ${e?.message ?? e}`)
    } finally {
      setZipping(false)
    }
  }

  /* ----------- Toggles ----------- */
  const toggleTask = (taskId: string) => {
    setStates(prev => {
      const next = prev.map(s => s.task.id === taskId ? { ...s, enabled: !s.enabled } : s)
      statesRef.current = next
      return next
    })
  }
  const setAllEnabled = (value: boolean) => {
    setStates(prev => {
      const next = prev.map(s => ({ ...s, enabled: value }))
      statesRef.current = next
      return next
    })
  }

  /* ----------- Génération ----------- */
  const runGeneration = async () => {
    if (running) return
    if (statesRef.current.length === 0) { setError('Aucune task. Drop un ZIP Notion.'); return }
    setRunning(true)
    setError(null)

    setStates(prev => {
      const next = prev.map(s => (s.status === 'done' || s.status === 'saved') ? s
        : { ...s, status: 'pending' as TaskStatus, error: undefined })
      statesRef.current = next
      return next
    })

    const todo = statesRef.current
      .map((s, idx) => ({ s, idx }))
      .filter(({ s }) => s.enabled && s.status !== 'done' && s.status !== 'saved')

    const runOne = async ({ idx }: { idx: number }) => {
      const state = statesRef.current[idx]
      if (!state) return
      const t = state.task

      setStates(prev => {
        const next = [...prev]
        next[idx] = { ...next[idx], status: 'running', error: undefined }
        statesRef.current = next
        return next
      })

      try {
        // Compression très agressive : Nature Morte envoie parfois 10+ images.
        // Il faut rester SOUS 4.5 MB (limite Vercel non modifiable).
        //   - maxSide 1200px : suffisant pour Gemini (il downscale à 1024 en interne)
        //   - quality 0.75 : JPEG compressé, artefacts invisibles pour la génération
        //   - Résultat : ~100-250 KB par image
        const compress = async (f: File) => {
          try { return await compressImage(f, { maxSide: 1200, quality: 0.75 }) }
          catch { return f }
        }
        const fd = new FormData()
        for (const p of t.productFiles) fd.append('products', await compress(p))

        // Limite à MAX 3 refs (si plus, garde les 3 premières).
        // Au-delà, ça ne change plus la synthèse d'ambiance mais dépasse Vercel.
        const MAX_REFS = 3
        const refsToSend = t.referenceFiles.slice(0, MAX_REFS)
        if (t.referenceFiles.length > MAX_REFS) {
          console.warn(`[NatureMorte] ${t.referenceFiles.length} refs > ${MAX_REFS} — envoi des ${MAX_REFS} premières seulement`)
        }
        for (const r of refsToSend) fd.append('references', await compress(r))
        if (t.decorsFile)     fd.append('decors',     await compress(t.decorsFile))
        if (t.modelBodyFile)  fd.append('modelBody',  await compress(t.modelBodyFile))
        if (t.modelFaceFile)  fd.append('modelFace',  await compress(t.modelFaceFile))

        // Vérif de sécurité : payload > 4.2 MB = quasi-sûr d'échouer côté Vercel.
        // On ne fait pas le call (économie de temps) et on remonte une erreur claire.
        let totalBytes = 0
        for (const [, value] of fd.entries()) {
          if (value instanceof Blob) totalBytes += value.size
        }
        const totalMB = totalBytes / 1024 / 1024
        if (totalMB > 4.2) {
          throw new Error(
            `Payload ${totalMB.toFixed(1)} MB > limite Vercel 4.5 MB. ` +
            `Réduis le nombre de produits (${t.productFiles.length}) ou de références (${refsToSend.length}) dans ce look.`,
          )
        }
        const totalImgs = t.productFiles.length + refsToSend.length + (t.decorsFile ? 1 : 0) + (t.modelBodyFile ? 1 : 0) + (t.modelFaceFile ? 1 : 0)
        console.log(`[NatureMorte] Payload ${totalMB.toFixed(2)} MB, ${totalImgs} images`)
        if (t.modelName)      fd.set('modelName',  t.modelName)
        if (t.decorsName)     fd.set('decorsName', t.decorsName)
        if (t.description)    fd.set('description', t.description)
        fd.set('sku',     t.sku)
        fd.set('ratio',   ratio)
        fd.set('quality', quality)

        const resp = await fetch('/api/studio/nature-morte', { method: 'POST', body: fd })
        // Réponse pas forcément JSON en cas d'erreur Vercel (413, 502, etc.)
        const rawText = await resp.text()
        let json: any
        try { json = JSON.parse(rawText) }
        catch {
          // HTML brut de Vercel : "Request Entity Too Large" (413), "Bad Gateway" (502), etc.
          const shortMsg = rawText.replace(/<[^>]+>/g, ' ').trim().slice(0, 200)
          if (resp.status === 413) throw new Error(`413 Trop volumineux : la requête dépasse 4.5 MB (Vercel). Baisse le nombre d'images ou compresse davantage. ${shortMsg}`)
          throw new Error(`HTTP ${resp.status} : ${shortMsg}`)
        }
        if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`)
        const url = json.imageUrl
        if (!url) throw new Error('Réponse sans URL.')

        setStates(prev => {
          const next = [...prev]
          next[idx] = { ...next[idx], status: 'done', imageUrl: url }
          statesRef.current = next
          return next
        })

        if (outputDirHandleRef.current) {
          const saved = await writeToOutputDir({ ...state, status: 'done', imageUrl: url })
          if (saved) {
            setSavedCount(c => c + 1)
            setStates(prev => {
              const next = [...prev]
              next[idx] = { ...next[idx], status: 'saved' }
              statesRef.current = next
              return next
            })
          }
        }
      } catch (e: any) {
        setStates(prev => {
          const next = [...prev]
          next[idx] = { ...next[idx], status: 'error', error: e?.message ?? String(e) }
          statesRef.current = next
          return next
        })
      }
    }

    const pool = Math.max(1, Math.min(concurrency, 6))
    let cursor = 0
    const workers = Array.from({ length: pool }, async () => {
      while (cursor < todo.length) {
        const my = cursor++
        setProgress(`Génération ${my + 1}/${todo.length}…`)
        await runOne(todo[my])
      }
    })
    await Promise.all(workers)
    setProgress('')
    setRunning(false)
  }

  const stats = useMemo(() => {
    const total   = states.length
    const enabled = states.filter(s => s.enabled).length
    const done    = states.filter(s => s.status === 'done' || s.status === 'saved').length
    const saved   = states.filter(s => s.status === 'saved').length
    const errors  = states.filter(s => s.status === 'error').length
    const runningN= states.filter(s => s.status === 'running').length
    const toRun   = states.filter(s => s.enabled && s.status !== 'done' && s.status !== 'saved').length
    return { total, enabled, done, saved, errors, running: runningN, toRun }
  }, [states])

  /* ----------- Styles ----------- */
  const card: React.CSSProperties = {
    border: '1px solid #E5E7EB', borderRadius: 12, padding: 16, background: '#fff',
    boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
  }
  const label: React.CSSProperties = {
    fontSize: 12, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em',
    fontWeight: 600, marginBottom: 6,
  }
  const inp: React.CSSProperties = {
    border: '1px solid #D1D5DB', borderRadius: 8, padding: '6px 10px',
    fontSize: 14, minHeight: 34, background: '#fff', width: '100%',
  }
  const btn = (bg: string, color: string = '#fff'): React.CSSProperties => ({
    background: bg, color, border: 'none', borderRadius: 8,
    padding: '8px 16px', fontWeight: 600, fontSize: 14, cursor: 'pointer',
  })
  const pill = (bg: string, color: string = '#fff'): React.CSSProperties => ({
    background: bg, color, borderRadius: 999, padding: '2px 8px',
    fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 22 }}>🍃</span>
          <h2 style={{ margin: 0, color: '#0D4A5C', fontSize: 18 }}>
            Nature Morte — Batch Notion adaptatif
          </h2>
        </div>
        <p style={{ fontSize: 13, color: '#6B7280', margin: 0 }}>
          Drop un ZIP Notion "LOOK (LIFESTYLE)". Chaque ligne = 1 nature morte.
          Le prompt s'adapte selon les colonnes remplies : <em>produits (obligatoires) + éventuel(le) REFERENCE, Decors, Model, Description</em>.
        </p>
      </div>

      <div style={card}>
        <div style={label}>1 — ZIP Notion</div>
        <Dropzone files={zips} onChange={handleZipChange} accept=".zip" multiple={false}
                  label="Drop le ZIP Notion ici" hint="Export complet avec Decors + Models Definition" />
        {parsing && <div style={{ marginTop: 8, fontSize: 13, color: '#0D4A5C' }}>⏳ {progress}</div>}
        {parsed && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#374151',
                        background: '#F9FAFB', padding: 8, borderRadius: 6 }}>
            ✓ {parsed.tasks.length} nature morte(s) prête(s).
            {parsed.warnings.length > 0 && (
              <details style={{ marginTop: 4 }}>
                <summary style={{ cursor: 'pointer', fontSize: 11 }}>{parsed.warnings.length} info(s)</summary>
                <ul style={{ fontSize: 11, color: '#6B7280', margin: '4px 0', paddingLeft: 16 }}>
                  {parsed.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>

      <div style={card}>
        <div style={label}>2 — Paramètres globaux</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Ratio</div>
            <select value={ratio} onChange={e => setRatio(e.target.value)} style={inp}>
              <option value="3:4">3:4</option>
              <option value="4:5">4:5 (Insta feed)</option>
              <option value="2:3">2:3</option>
              <option value="1:1">1:1</option>
              <option value="9:16">9:16</option>
              <option value="4:3">4:3</option>
              <option value="16:9">16:9</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Qualité</div>
            <select value={quality} onChange={e => setQuality(e.target.value)} style={inp}>
              <option value="1K">1K</option>
              <option value="2K">2K</option>
              <option value="4K">4K</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Parallèle</div>
            <select value={concurrency} onChange={e => setConcurrency(parseInt(e.target.value, 10))} style={inp}>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
            </select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
            <button onClick={pickOutputDir} style={btn('#0D4A5C')}>
              📁 {outputDirName ? outputDirName : 'Dossier sortie'}
            </button>
            {outputDirName && (
              <button onClick={clearOutputDir} style={{ ...btn('#F3F4F6', '#374151'), marginTop: 4, fontSize: 11, padding: '4px 8px' }}>
                ✕ Retirer · {savedCount} sauvé(s)
              </button>
            )}
          </div>
        </div>
      </div>

      {states.length > 0 && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
            <div style={label}>
              3 — Tâches ({stats.enabled}/{stats.total} · ✓ {stats.done} · 💾 {stats.saved} · ⏳ {stats.running} · ✕ {stats.errors})
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setAllEnabled(true)}  style={btn('#E5E7EB', '#374151')}>☑ Tout cocher</button>
              <button onClick={() => setAllEnabled(false)} style={btn('#E5E7EB', '#374151')}>☐ Tout décocher</button>
              <button onClick={runGeneration} disabled={running || stats.toRun === 0}
                      style={{ ...btn(running || stats.toRun === 0 ? '#9CA3AF' : '#0D4A5C'),
                               cursor: running || stats.toRun === 0 ? 'not-allowed' : 'pointer' }}>
                {running ? `⏳ ${progress || 'Génération…'}` : `🍃 Générer ${stats.toRun}`}
              </button>
              <button onClick={downloadZip} disabled={zipping || stats.done === 0}
                      style={{ ...btn(zipping || stats.done === 0 ? '#9CA3AF' : '#10B981'),
                               cursor: zipping || stats.done === 0 ? 'not-allowed' : 'pointer' }}>
                {zipping ? '⏳ ZIP…' : `📦 ZIP (${stats.done})`}
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
            {states.map(s => {
              const t = s.task
              return (
                <div key={t.id} style={{
                  border: '1px solid #E5E7EB', borderRadius: 8, padding: 10,
                  background: s.enabled ? '#fff' : '#F9FAFB',
                  opacity: s.enabled ? 1 : 0.55,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <input type="checkbox" checked={s.enabled}
                           onChange={() => toggleTask(t.id)}
                           style={{ width: 14, height: 14, cursor: 'pointer' }} />
                    {s.status === 'pending' && <span style={pill('#9CA3AF')}>•</span>}
                    {s.status === 'running' && <span style={pill('#F59E0B')}>⏳</span>}
                    {s.status === 'done'    && <span style={pill('#3B82F6')}>✓</span>}
                    {s.status === 'saved'   && <span style={pill('#10B981')}>💾</span>}
                    {s.status === 'error'   && <span style={pill('#EF4444')}>✕</span>}
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#0D4A5C' }}>
                      #{t.id} · {t.sku}
                    </span>
                  </div>

                  {/* Indicateurs de ce qui est présent */}
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
                    <span style={pill('#0D4A5C')}>{t.productFiles.length} prod</span>
                    {t.referenceFiles.length > 0 && <span style={pill('#7C3AED')}>{t.referenceFiles.length} ref</span>}
                    {t.decorsFile    && <span style={pill('#059669')}>decor</span>}
                    {t.modelBodyFile && <span style={pill('#DC2626')}>model</span>}
                    {t.description   && <span style={pill('#F59E0B')}>desc</span>}
                  </div>

                  {t.description && (
                    <div style={{ fontSize: 10, color: '#92400E', background: '#FEF3C7',
                                  padding: '2px 6px', borderRadius: 4, marginBottom: 6 }}>
                      📝 {t.description.slice(0, 80)}
                    </div>
                  )}

                  {/* Preview mini : 1ère reference + result */}
                  <div style={{ display: 'flex', gap: 4 }}>
                    {t.referenceFiles[0] && (
                      <div style={{ flex: 1, aspectRatio: '3/4', background: '#F3F4F6', borderRadius: 4, overflow: 'hidden', position: 'relative' }}>
                        <img src={URL.createObjectURL(t.referenceFiles[0])} alt="ref"
                             style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        {t.referenceFiles.length > 1 && (
                          <span style={{ position: 'absolute', top: 2, right: 2, background: 'rgba(124,58,237,0.9)',
                                         color: '#fff', fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 3 }}>
                            +{t.referenceFiles.length - 1}
                          </span>
                        )}
                      </div>
                    )}
                    <div style={{ flex: 1, aspectRatio: '3/4', background: '#fff',
                                  border: '1px solid #E5E7EB', borderRadius: 4, overflow: 'hidden',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {s.imageUrl
                        ? <a href={s.imageUrl} target="_blank" rel="noreferrer" style={{ display: 'block', width: '100%', height: '100%' }}>
                            <img src={s.imageUrl} alt="out" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          </a>
                        : <span style={{ fontSize: 10, color: '#9CA3AF' }}>
                            {s.status === 'running' ? '⏳' : s.status === 'error' ? '✕' : '–'}
                          </span>}
                    </div>
                  </div>

                  {s.error && (
                    <div style={{ fontSize: 10, color: '#EF4444', marginTop: 4 }} title={s.error}>
                      {s.error.slice(0, 60)}
                    </div>
                  )}
                  {t.warnings.length > 0 && (
                    <div style={{ fontSize: 10, color: '#92400E', marginTop: 4 }}>
                      ⚠ {t.warnings[0]}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {error && (
        <div style={{ ...card, background: '#FEF2F2', color: '#991B1B' }}>
          ❌ {error}
        </div>
      )}
    </div>
  )
}
