'use client'
/**
 * Onglet 🛍 E-Com New Tech — batch via ZIP Notion, pipeline V2 (Photoroom AI soft).
 *
 * Pour chaque pose du ZIP Notion :
 *   1. Lit body / face / vêtements / fond depuis le ZIP (parseur existant)
 *   2. Déduit le framing depuis la colonne "Vue et Pose" :
 *      - "front" / "side" / "back" / "3/4" → plein-pied
 *      - "close up haut" / "buste" → haut
 *      - "close up bas" / "jambes" → bas
 *      - "mi-corps" → mi
 *   3. Envoie à /api/studio/pipeline-v2-test (Gemini + Photoroom AI soft)
 *   4. Affiche les résultats, sauvegarde au fil de l'eau dans le dossier de sortie
 */
import { useMemo, useRef, useState } from 'react'
import Dropzone from '@/components/ui/Dropzone'
import { compressImage } from '@/lib/compressImage'
import { parseNotionExport, type GenerationTask, type ParsedExport } from '@/lib/notion/parseExport'

type TaskStatus = 'pending' | 'running' | 'done' | 'saved' | 'error' | 'skipped'

type State = {
  task:       GenerationTask
  status:     TaskStatus
  imageUrl?:  string
  error?:     string
}

/** Extrait le framing depuis le texte brut de la colonne "Vue et Pose". */
function extractFraming(poseRaw: string): 'plein' | 'mi' | 'haut' | 'bas' | 'detail' {
  const p = (poseRaw || '').toLowerCase()
  if (p.includes('close up bas')  || p.includes('close-up bas')  || p.includes('lower') || p.includes('jambes')) return 'bas'
  if (p.includes('close up haut') || p.includes('close-up haut') || p.includes('upper') || p.includes('buste'))  return 'haut'
  if (p.includes('mi corps')      || p.includes('mi-corps')      || p.includes('mid'))                            return 'mi'
  if (p.includes('detail')        || p.includes('détail')        || p.includes('macro'))                          return 'detail'
  return 'plein'
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

export default function ECommerceNewTechTab() {
  const [zips, setZips]           = useState<File[]>([])
  const [parsing, setParsing]     = useState(false)
  const [parsed, setParsed]       = useState<ParsedExport | null>(null)
  const [states, setStates]       = useState<State[]>([])
  const statesRef                 = useRef<State[]>([])
  const [error, setError]         = useState<string | null>(null)
  const [progress, setProgress]   = useState('')

  // Paramètres globaux
  const [ratio, setRatio]         = useState('9:16')
  const [quality, setQuality]     = useState('2K')
  const [shadowMode, setShadowMode] = useState<'photoroom-soft' | 'photoroom-hard' | 'custom'>('photoroom-soft')
  const [concurrency, setConcurrency] = useState(2)
  const [running, setRunning]     = useState(false)

  // Dossier sortie
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outputDirHandleRef = useRef<any | null>(null)
  const [outputDirName, setOutputDirName] = useState<string | null>(null)
  const [savedCount, setSavedCount] = useState(0)

  /* ----------- Parsing ZIP ----------- */
  const handleZipChange = async (files: File[]) => {
    setZips(files)
    setError(null)
    setParsed(null)
    setStates([])
    if (files.length === 0) return
    setParsing(true)
    setProgress('Lecture du ZIP…')
    try {
      const res = await parseNotionExport(files[0], (msg) => setProgress(msg))
      setParsed(res)
      // Garde uniquement les pose tasks (skip detail + inspi pour ce mode E-Com)
      const poseTasks = res.tasks.filter(t => t.taskType === 'pose')
      const newStates: State[] = poseTasks.map(t => ({ task: t, status: 'pending' }))
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
      const framing = extractFraming(state.task.vueRaw ?? '')
      const sku = state.task.numeroLook || state.task.lookId
      const vue = (state.task.vueIndex ?? 0) + 1
      const filename = `${sanitizeFilename(sku)}_vue${vue}_${framing}.png`
      const fileHandle = await handle.getFileHandle(filename, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(blob)
      await writable.close()
      console.log(`[E-Com] Saved ${filename}`)
      return true
    } catch (e: any) {
      console.warn('[E-Com] write failed', e?.message)
      return false
    }
  }

  /* ----------- Génération ----------- */
  const runGeneration = async () => {
    if (running) return
    if (statesRef.current.length === 0) { setError('Aucune task. Drop un ZIP Notion.'); return }
    setRunning(true)
    setError(null)

    // Reset les non-terminées
    setStates(prev => {
      const next = prev.map(s => (s.status === 'done' || s.status === 'saved') ? s
        : { ...s, status: 'pending' as TaskStatus, error: undefined })
      statesRef.current = next
      return next
    })

    const todo = statesRef.current
      .map((s, idx) => ({ s, idx }))
      .filter(({ s }) => s.status !== 'done' && s.status !== 'saved')

    const runOne = async ({ idx }: { idx: number }) => {
      const state = statesRef.current[idx]
      if (!state) return
      const t = state.task

      // Vérifie qu'on a les fichiers minimum
      if (!t.bodyPhotoFile || !t.backgroundFile) {
        setStates(prev => {
          const next = [...prev]
          next[idx] = { ...next[idx], status: 'skipped', error: 'bodyPhotoFile ou backgroundFile manquant' }
          statesRef.current = next
          return next
        })
        return
      }

      setStates(prev => {
        const next = [...prev]
        next[idx] = { ...next[idx], status: 'running', error: undefined }
        statesRef.current = next
        return next
      })

      try {
        const framing = extractFraming(t.vueRaw ?? '')
        const fd = new FormData()

        // Compress côté client (4.5 MB limit Vercel)
        const compress = async (f: File) => {
          try { return await compressImage(f, { maxSide: 2048, quality: 0.9 }) }
          catch { return f }
        }
        fd.append('background', await compress(t.backgroundFile))
        fd.append('mannequinBody', await compress(t.bodyPhotoFile))
        if (t.facePhotoFile) fd.append('mannequinFace', await compress(t.facePhotoFile))
        for (const p of (t.productFiles ?? [])) fd.append('products', await compress(p))

        fd.set('framing', framing)
        fd.set('ratio', ratio)
        fd.set('quality', quality)
        fd.set('shadowMode', shadowMode)
        // Prompt = description de la pose (depuis CSV Notion)
        const promptText = t.posePromptWithBase || t.prompt || t.vueRaw || ''
        fd.set('prompt', promptText)

        const resp = await fetch('/api/studio/pipeline-v2-test', { method: 'POST', body: fd })
        const json = await resp.json()
        if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`)
        const url = json.imageUrl
        if (!url) throw new Error('Réponse sans URL.')

        setStates(prev => {
          const next = [...prev]
          next[idx] = { ...next[idx], status: 'done', imageUrl: url }
          statesRef.current = next
          return next
        })

        // Sauvegarde immédiate dans le dossier si configuré
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

    // Pool concurrence
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

  /* ----------- Stats ----------- */
  const stats = useMemo(() => {
    const total   = states.length
    const done    = states.filter(s => s.status === 'done' || s.status === 'saved').length
    const saved   = states.filter(s => s.status === 'saved').length
    const errors  = states.filter(s => s.status === 'error').length
    const runningN= states.filter(s => s.status === 'running').length
    return { total, done, saved, errors, running: runningN }
  }, [states])

  // Group by look pour l'affichage
  const groupedByLook = useMemo(() => {
    const map = new Map<string, State[]>()
    for (const s of states) {
      const arr = map.get(s.task.lookId) ?? []
      arr.push(s)
      map.set(s.task.lookId, arr)
    }
    return Array.from(map.entries())
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
          <span style={{ fontSize: 22 }}>🛍</span>
          <h2 style={{ margin: 0, color: '#0D4A5C', fontSize: 18 }}>
            E-Com New Tech — Batch Notion via Pipeline V2 (Photoroom AI)
          </h2>
        </div>
        <p style={{ fontSize: 13, color: '#6B7280', margin: 0 }}>
          Drop un ZIP Notion. Chaque pose est générée via la pipeline V2 (Gemini → Photoroom AI soft) avec
          ton fond, mannequin, vêtements, ratio cohérents. Le framing est lu depuis la colonne <code>Vue et Pose</code> :
          <em> Front/Side/Back → plein-pied, "close up haut" → buste, "close up bas" → jambes</em>.
        </p>
      </div>

      <div style={card}>
        <div style={label}>1 — ZIP Notion</div>
        <Dropzone files={zips} onChange={handleZipChange} accept=".zip" multiple={false}
                  label="Drop le ZIP Notion ici" hint="Export complet avec Models / Decors / Looks" />
        {parsing && <div style={{ marginTop: 8, fontSize: 13, color: '#0D4A5C' }}>⏳ {progress}</div>}
        {parsed && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#374151',
                        background: '#F9FAFB', padding: 8, borderRadius: 6 }}>
            ✓ {parsed.looks.length} look(s), {states.length} pose task(s).
            {parsed.warnings.length > 0 && (
              <details style={{ marginTop: 4 }}>
                <summary style={{ cursor: 'pointer', fontSize: 11 }}>{parsed.warnings.length} warning(s)</summary>
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
              <option value="9:16">9:16</option>
              <option value="3:4">3:4</option>
              <option value="2:3">2:3</option>
              <option value="1:1">1:1</option>
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
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Mode ombre</div>
            <select value={shadowMode} onChange={e => setShadowMode(e.target.value as any)} style={inp}>
              <option value="photoroom-soft">Photoroom AI soft (recommandé)</option>
              <option value="photoroom-hard">Photoroom AI hard</option>
              <option value="custom">Custom (BiRefNet + ellipse)</option>
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
        </div>
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={pickOutputDir} style={btn('#0D4A5C')}>
            📁 {outputDirName ? `Dossier : ${outputDirName}` : 'Choisir dossier de sortie'}
          </button>
          {outputDirName && (
            <button onClick={clearOutputDir} style={btn('#E5E7EB', '#374151')}>✕ Retirer</button>
          )}
          {outputDirName && (
            <span style={{ fontSize: 12, color: '#6B7280' }}>
              Sauvegarde live : <strong style={{ color: '#10B981' }}>{savedCount}</strong> fichier(s)
            </span>
          )}
        </div>
      </div>

      {states.length > 0 && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={label}>
              3 — Tâches ({stats.total} · ✓ {stats.done} · 💾 {stats.saved} · ⏳ {stats.running} · ✕ {stats.errors})
            </div>
            <button onClick={runGeneration} disabled={running || stats.total === 0}
                    style={{ ...btn(running || stats.total === 0 ? '#9CA3AF' : '#0D4A5C'),
                             cursor: running || stats.total === 0 ? 'not-allowed' : 'pointer' }}>
              {running ? `⏳ ${progress || 'Génération…'}` : `🚀 Générer ${stats.total - stats.done} tâches`}
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {groupedByLook.map(([lookId, items]) => {
              const numero = items[0]?.task.numeroLook || lookId
              return (
                <div key={lookId} style={{ border: '1px solid #E5E7EB', borderRadius: 8, padding: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#0D4A5C', marginBottom: 8 }}>
                    <span style={{ color: '#6B7280', fontWeight: 500 }}>#{lookId}</span> · Look {numero}
                    <span style={{ fontSize: 11, color: '#6B7280', marginLeft: 8 }}>
                      ({items.length} vue{items.length > 1 ? 's' : ''})
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
                    {items.map(s => {
                      const framing = extractFraming(s.task.vueRaw ?? '')
                      return (
                        <div key={s.task.id} style={{
                          border: '1px solid #E5E7EB', borderRadius: 6, padding: 6, background: '#fff',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                            {s.status === 'pending' && <span style={pill('#9CA3AF')}>•</span>}
                            {s.status === 'running' && <span style={pill('#F59E0B')}>⏳</span>}
                            {s.status === 'done'    && <span style={pill('#3B82F6')}>✓</span>}
                            {s.status === 'saved'   && <span style={pill('#10B981')}>💾</span>}
                            {s.status === 'error'   && <span style={pill('#EF4444')}>✕</span>}
                            {s.status === 'skipped' && <span style={pill('#6B7280')}>⊘</span>}
                            <span style={{ fontSize: 10, color: '#0D4A5C', fontWeight: 600 }}>
                              vue {(s.task.vueIndex ?? 0) + 1}
                            </span>
                            <span style={pill('#E5E7EB', '#374151')}>{framing}</span>
                          </div>
                          <div style={{ fontSize: 10, color: '#6B7280',
                                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                               title={s.task.vueRaw}>
                            {s.task.vueRaw || '(no pose)'}
                          </div>
                          {s.imageUrl && (
                            <div style={{ marginTop: 4, aspectRatio: '3/4', overflow: 'hidden', borderRadius: 4 }}>
                              <a href={s.imageUrl} target="_blank" rel="noreferrer">
                                <img src={s.imageUrl} alt="result"
                                     style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                              </a>
                            </div>
                          )}
                          {s.error && (
                            <div style={{ fontSize: 10, color: '#EF4444', marginTop: 4 }} title={s.error}>
                              {s.error.slice(0, 60)}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
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
