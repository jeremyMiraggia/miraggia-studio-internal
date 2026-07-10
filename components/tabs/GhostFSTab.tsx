'use client'
/**
 * Onglet 👻 Ghost F&S — Style-transfer de packshot pro sur photos iPhone.
 *
 * Principe :
 *   1. Le user uploade UN packshot de référence (composition, pose, lumière, fond)
 *   2. Le user uploade N photos iPhone de vêtements à transformer
 *   3. Pour chaque photo iPhone, Gemini reçoit :
 *      - Image 1 : la photo iPhone du vêtement
 *      - Image 2 : le packshot de référence
 *      - Prompt : "reprends la composition de l'image 2, remplace le vêtement par celui de l'image 1"
 *   4. Résultat : chaque vêtement iPhone devient un packshot pro dans le style de la référence
 */
import { useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import Dropzone from '@/components/ui/Dropzone'
import { compressImage } from '@/lib/compressImage'

type TaskStatus = 'pending' | 'running' | 'done' | 'error' | 'saved'

type Task = {
  id:        string
  source:    File          // photo iPhone du vêtement
  status:    TaskStatus
  imageUrl?: string
  error?:    string
}

// Prompt inspiré de ce que le user tape à la main.
// On garde son style direct + français court + on rend le "vêtement à copier" générique.
const STYLE_TRANSFER_PROMPT = [
  "Recrée exactement le packshot de l'image 2 en conservant :",
  "- la même pose du vêtement",
  "- le même cadrage",
  "- la même lumière (direction, intensité, ambiance)",
  "- le même fond (couleur, texture, uniformité)",
  "- la même composition générale",
  "- le même niveau de qualité (packshot professionnel piqué, netteté élevée)",
  "",
  "Remplace UNIQUEMENT le vêtement par celui présent sur l'image 1.",
  "Reproduis fidèlement le vêtement de l'image 1 : sa forme exacte, ses couleurs, ses matières, sa coupe, ses coutures, ses boutons, ses détails, ses imprimés/motifs si présents.",
  "Le vêtement final doit être identique à celui de l'image 1 mais présenté dans le style pro de l'image 2.",
].join('\n')

function sanitizeFilename(s: string): string {
  return s
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80) || 'ghost'
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

export default function GhostFSTab() {
  const [reference, setReference] = useState<File[]>([])   // 1 seule
  const [sources, setSources]     = useState<File[]>([])   // N images iPhone
  const [tasks, setTasks]         = useState<Task[]>([])
  const tasksRef                  = useRef<Task[]>([])

  const [ratio, setRatio]             = useState('3:4')
  const [quality, setQuality]         = useState('2K')
  const [concurrency, setConcurrency] = useState(2)
  const [customPrompt, setCustomPrompt] = useState(STYLE_TRANSFER_PROMPT)

  const [running, setRunning]     = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [zipping, setZipping]     = useState(false)

  // Dossier sortie
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outputDirHandleRef = useRef<any | null>(null)
  const [outputDirName, setOutputDirName] = useState<string | null>(null)
  const [savedCount, setSavedCount] = useState(0)

  /* ----------- Drop sources ----------- */
  const handleSourcesChange = (files: File[]) => {
    setSources(files)
    const newTasks: Task[] = files.map((f, i) => ({
      id:     `${i}-${f.name}-${f.lastModified}`,
      source: f,
      status: 'pending',
    }))
    setTasks(newTasks)
    tasksRef.current = newTasks
    setError(null)
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

  const writeTaskToOutputDir = async (task: Task): Promise<boolean> => {
    const handle = outputDirHandleRef.current
    if (!handle || !task.imageUrl) return false
    try {
      const resp = await fetch(task.imageUrl)
      if (!resp.ok) throw new Error(`Fetch HTTP ${resp.status}`)
      const blob = await resp.blob()
      const base = sanitizeFilename(task.source.name.replace(/\.[^.]+$/, ''))
      const filename = `${base}_ghost.png`
      const fileHandle = await handle.getFileHandle(filename, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(blob)
      await writable.close()
      return true
    } catch (e: any) {
      console.warn('[Ghost F&S] write failed', e?.message)
      return false
    }
  }

  /* ----------- Génération ----------- */
  const runGeneration = async () => {
    if (running) return
    if (reference.length !== 1) { setError('Ajoute UNE image de référence (packshot pro).'); return }
    if (tasksRef.current.length === 0) { setError('Ajoute au moins 1 photo iPhone à traiter.'); return }
    setRunning(true)
    setError(null)

    // Reset les non terminées
    setTasks(prev => {
      const next = prev.map(t => (t.status === 'done' || t.status === 'saved') ? t
        : { ...t, status: 'pending' as TaskStatus, error: undefined })
      tasksRef.current = next
      return next
    })

    const todo = tasksRef.current
      .map((t, idx) => ({ t, idx }))
      .filter(({ t }) => t.status !== 'done' && t.status !== 'saved')

    // Compresse la référence une fois pour toutes
    let refCompressed: File
    try {
      refCompressed = await compressImage(reference[0], { maxSide: 2048, quality: 0.9 })
    } catch {
      refCompressed = reference[0]
    }

    const runOne = async ({ idx }: { idx: number }) => {
      const task = tasksRef.current[idx]
      if (!task) return
      setTasks(prev => {
        const next = [...prev]
        next[idx] = { ...next[idx], status: 'running', error: undefined }
        tasksRef.current = next
        return next
      })
      try {
        // Compress source iPhone
        let source: File
        try { source = await compressImage(task.source, { maxSide: 2048, quality: 0.9 }) }
        catch { source = task.source }

        const fd = new FormData()
        fd.set('prompt', customPrompt)
        fd.set('ratio', ratio)
        fd.set('quality', quality)
        // ⚠ Ordre important : image 1 = photo iPhone (vêtement à copier), image 2 = référence packshot
        fd.append('refs', source)
        fd.append('refs', refCompressed)

        const resp = await fetch('/api/studio/free', { method: 'POST', body: fd })
        const json = await resp.json()
        if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`)
        const url = json.imageUrl ?? json.url
        if (!url) throw new Error('Réponse sans URL.')

        setTasks(prev => {
          const next = [...prev]
          next[idx] = { ...next[idx], status: 'done', imageUrl: url }
          tasksRef.current = next
          return next
        })

        if (outputDirHandleRef.current) {
          const saved = await writeTaskToOutputDir({ ...task, status: 'done', imageUrl: url })
          if (saved) {
            setSavedCount(c => c + 1)
            setTasks(prev => {
              const next = [...prev]
              next[idx] = { ...next[idx], status: 'saved' }
              tasksRef.current = next
              return next
            })
          }
        }
      } catch (e: any) {
        setTasks(prev => {
          const next = [...prev]
          next[idx] = { ...next[idx], status: 'error', error: e?.message ?? String(e) }
          tasksRef.current = next
          return next
        })
      }
    }

    const pool = Math.max(1, Math.min(concurrency, 6))
    let cursor = 0
    const workers = Array.from({ length: pool }, async () => {
      while (cursor < todo.length) {
        const my = cursor++
        await runOne(todo[my])
      }
    })
    await Promise.all(workers)
    setRunning(false)
  }

  /* ----------- ZIP download ----------- */
  const downloadZip = async () => {
    const doneTasks = tasksRef.current.filter(t => (t.status === 'done' || t.status === 'saved') && t.imageUrl)
    if (doneTasks.length === 0) { setError('Aucun visuel terminé.'); return }
    setZipping(true)
    setError(null)
    try {
      const zip = new JSZip()
      const used = new Set<string>()
      for (const t of doneTasks) {
        try {
          const resp = await fetch(t.imageUrl!)
          const blob = await resp.blob()
          const base = sanitizeFilename(t.source.name.replace(/\.[^.]+$/, ''))
          let name = `${base}_ghost.png`
          let n = 2
          while (used.has(name)) { name = `${base}_ghost_${n}.png`; n++ }
          used.add(name)
          zip.file(name, blob)
        } catch { /* skip */ }
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ghost_fs_${Date.now()}.zip`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (e: any) {
      setError(`ZIP : ${e?.message ?? e}`)
    } finally {
      setZipping(false)
    }
  }

  /* ----------- Stats ----------- */
  const stats = useMemo(() => {
    const done   = tasks.filter(t => t.status === 'done' || t.status === 'saved').length
    const saved  = tasks.filter(t => t.status === 'saved').length
    const errors = tasks.filter(t => t.status === 'error').length
    const runN   = tasks.filter(t => t.status === 'running').length
    return { total: tasks.length, done, saved, errors, running: runN }
  }, [tasks])

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
          <span style={{ fontSize: 22 }}>👻</span>
          <h2 style={{ margin: 0, color: '#0D4A5C', fontSize: 18 }}>
            Ghost F&S — Style transfer packshot
          </h2>
        </div>
        <p style={{ fontSize: 13, color: '#6B7280', margin: 0 }}>
          Uploade un packshot pro en <strong>référence</strong> (composition, lumière, fond) + N photos iPhone de vêtements.
          Chaque photo iPhone sera transformée en packshot pro dans le même style que ta référence, en gardant fidèlement le vêtement.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
        <div style={card}>
          <div style={label}>1 — Packshot de référence</div>
          <Dropzone files={reference} onChange={setReference} multiple={false} accept="image/*"
                    label="Référence" hint="1 image du packshot pro dont on copie la composition" />
        </div>
        <div style={card}>
          <div style={label}>2 — Photos iPhone à transformer</div>
          <Dropzone files={sources} onChange={handleSourcesChange} multiple accept="image/*"
                    label="Photos iPhone" hint="1 ou plusieurs photos des vêtements à passer en packshot" />
        </div>
      </div>

      <div style={card}>
        <div style={label}>3 — Paramètres</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Ratio</div>
            <select value={ratio} onChange={e => setRatio(e.target.value)} style={inp}>
              <option value="3:4">3:4</option>
              <option value="2:3">2:3</option>
              <option value="1:1">1:1</option>
              <option value="9:16">9:16</option>
              <option value="4:3">4:3</option>
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
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>
            Prompt (modifiable) — <em>image 1 = photo iPhone, image 2 = référence packshot</em>
          </div>
          <textarea
            value={customPrompt}
            onChange={e => setCustomPrompt(e.target.value)}
            style={{ ...inp, minHeight: 100, fontFamily: 'monospace', fontSize: 12 }}
          />
        </div>
      </div>

      {tasks.length > 0 && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 8 }}>
            <div style={label}>
              4 — Tâches ({stats.total} · ✓ {stats.done} · 💾 {stats.saved} · ⏳ {stats.running} · ✕ {stats.errors})
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={runGeneration} disabled={running || reference.length !== 1 || stats.total === 0}
                      style={{ ...btn(running || reference.length !== 1 || stats.total === 0 ? '#9CA3AF' : '#0D4A5C'),
                               cursor: running || reference.length !== 1 || stats.total === 0 ? 'not-allowed' : 'pointer' }}>
                {running ? '⏳ Génération…' : '👻 Générer packshots'}
              </button>
              <button onClick={downloadZip} disabled={zipping || stats.done === 0}
                      style={{ ...btn(zipping || stats.done === 0 ? '#9CA3AF' : '#10B981'),
                               cursor: zipping || stats.done === 0 ? 'not-allowed' : 'pointer' }}>
                {zipping ? '⏳ ZIP…' : `📦 ZIP (${stats.done})`}
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
            {tasks.map(t => {
              const srcUrl = URL.createObjectURL(t.source)
              return (
                <div key={t.id} style={{
                  border: '1px solid #E5E7EB', borderRadius: 8, padding: 8, background: '#fff',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    {t.status === 'pending' && <span style={pill('#9CA3AF')}>•</span>}
                    {t.status === 'running' && <span style={pill('#F59E0B')}>⏳</span>}
                    {t.status === 'done'    && <span style={pill('#3B82F6')}>✓</span>}
                    {t.status === 'saved'   && <span style={pill('#10B981')}>💾</span>}
                    {t.status === 'error'   && <span style={pill('#EF4444')}>✕</span>}
                    <span style={{ fontSize: 11, color: '#6B7280',
                                   whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                          title={t.source.name}>
                      {t.source.name}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <div style={{ flex: 1, aspectRatio: '3/4', background: '#F3F4F6',
                                  borderRadius: 4, overflow: 'hidden' }}>
                      <img src={srcUrl} alt="src" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </div>
                    <div style={{ flex: 1, aspectRatio: '3/4', background: '#fff',
                                  border: '1px solid #E5E7EB', borderRadius: 4, overflow: 'hidden',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {t.imageUrl
                        ? <a href={t.imageUrl} target="_blank" rel="noreferrer" style={{ display: 'block', width: '100%', height: '100%' }}>
                            <img src={t.imageUrl} alt="out" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          </a>
                        : <span style={{ fontSize: 10, color: '#9CA3AF' }}>
                            {t.status === 'running' ? '⏳' : t.status === 'error' ? '✕' : '–'}
                          </span>}
                    </div>
                  </div>
                  {t.error && (
                    <div style={{ fontSize: 10, color: '#EF4444', marginTop: 4 }} title={t.error}>
                      {t.error.slice(0, 60)}
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
