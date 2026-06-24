'use client'
/**
 * Onglet Lin — défroissage automatique d'une série d'images.
 *
 * Workflow :
 *   1. Le user drop un dossier d'images (ou multi-sélection)
 *   2. Chaque image est envoyée à /api/studio/free avec le prompt de défroissage
 *   3. Au fur et à mesure, les résultats s'affichent en grille
 *   4. À la fin, bouton "Télécharger ZIP" qui empaquette tous les visuels
 */
import { useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import Dropzone from '@/components/ui/Dropzone'

type TaskStatus = 'pending' | 'running' | 'done' | 'error'

type LinTask = {
  id:       string
  source:   File
  status:   TaskStatus
  imageUrl?: string
  error?:    string
}

function sanitizeFilename(s: string): string {
  return s
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80) || 'image'
}

export default function LinTab() {
  const [files, setFiles]       = useState<File[]>([])
  const [tasks, setTasks]       = useState<LinTask[]>([])
  const tasksRef                = useRef<LinTask[]>([])

  const [concurrency, setConcurrency] = useState<number>(2)

  const [running, setRunning]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [zipping, setZipping]   = useState(false)

  /* ----------------- Drop ----------------- */
  const handleFilesChange = (newFiles: File[]) => {
    setFiles(newFiles)
    const newTasks: LinTask[] = newFiles.map((f, i) => ({
      id:     `${i}-${f.name}-${f.lastModified}`,
      source: f,
      status: 'pending',
    }))
    setTasks(newTasks)
    tasksRef.current = newTasks
    setError(null)
  }

  /* ----------------- Génération ----------------- */
  const runGeneration = async () => {
    if (running) return
    if (tasksRef.current.length === 0) {
      setError('Aucune image à traiter.')
      return
    }
    setRunning(true)
    setError(null)

    // Reset les tâches non terminées
    setTasks(prev => {
      const next = prev.map(t => t.status === 'done' ? t : { ...t, status: 'pending' as TaskStatus, error: undefined })
      tasksRef.current = next
      return next
    })

    const todo = tasksRef.current
      .map((t, idx) => ({ t, idx }))
      .filter(({ t }) => t.status !== 'done')

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
        const fd = new FormData()
        // Flux Kontext conserve le ratio / la taille de l'image source.
        // Les options ratio/quality ne sont donc pas utilisées par /lin.
        fd.append('source', task.source)

        const resp = await fetch('/api/studio/lin', { method: 'POST', body: fd })
        if (!resp.ok) {
          let detail = `HTTP ${resp.status}`
          try { detail = (await resp.json()).error ?? detail } catch {}
          throw new Error(detail)
        }
        const json = await resp.json()
        const url = json.imageUrl ?? json.url
        if (!url) throw new Error('Réponse sans URL.')

        setTasks(prev => {
          const next = [...prev]
          next[idx] = { ...next[idx], status: 'done', imageUrl: url }
          tasksRef.current = next
          return next
        })
      } catch (e: any) {
        setTasks(prev => {
          const next = [...prev]
          next[idx] = { ...next[idx], status: 'error', error: e?.message ?? String(e) }
          tasksRef.current = next
          return next
        })
      }
    }

    // Pool de concurrence
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

  /* ----------------- ZIP download ----------------- */
  const downloadZip = async () => {
    const doneTasks = tasksRef.current.filter(t => t.status === 'done' && t.imageUrl)
    if (doneTasks.length === 0) {
      setError('Aucun visuel terminé à empaqueter.')
      return
    }
    setZipping(true)
    setError(null)
    try {
      const zip = new JSZip()
      // En cas de doublons de noms dans la sélection, on suffixe avec _2, _3, …
      const usedNames = new Set<string>()
      for (const t of doneTasks) {
        try {
          const resp = await fetch(t.imageUrl!)
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          const blob = await resp.blob()
          // Garde STRICTEMENT le même nom que l'original (juste sanitisé pour
          // virer les caractères interdits par les filesystems Windows).
          let name = sanitizeFilename(t.source.name.replace(/\.[^.]+$/, ''))
          const origExt = (t.source.name.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase()
          const ext = origExt || (blob.type === 'image/jpeg' ? 'jpg' : 'png')
          let finalName = `${name}.${ext}`
          let n = 2
          while (usedNames.has(finalName)) {
            finalName = `${name}_${n}.${ext}`
            n++
          }
          usedNames.add(finalName)
          zip.file(finalName, blob)
        } catch (e: any) {
          console.warn('[Lin] zip skip', t.source.name, e)
        }
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })  // STORE = pas de compression (images sont déjà compressées)
      const url = URL.createObjectURL(blob)
      const a   = document.createElement('a')
      a.href    = url
      a.download = `lin_defroisse_${Date.now()}.zip`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (e: any) {
      setError(`ZIP : ${e?.message ?? e}`)
    } finally {
      setZipping(false)
    }
  }

  /* ----------------- Stats ----------------- */
  const stats = useMemo(() => {
    const done    = tasks.filter(t => t.status === 'done').length
    const errors  = tasks.filter(t => t.status === 'error').length
    const running = tasks.filter(t => t.status === 'running').length
    return { done, errors, running, total: tasks.length }
  }, [tasks])

  /* ----------------- Styles ----------------- */
  const card: React.CSSProperties = {
    border: '1px solid #E5E7EB', borderRadius: 12, padding: 16, background: '#fff',
    boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
  }
  const label: React.CSSProperties = {
    fontSize: 12, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em',
    fontWeight: 600, marginBottom: 6,
  }
  const input: React.CSSProperties = {
    border: '1px solid #D1D5DB', borderRadius: 8, padding: '6px 10px',
    fontSize: 14, minHeight: 34, background: '#fff',
  }
  const btn = (bg: string, color: string = '#fff'): React.CSSProperties => ({
    background: bg, color, border: 'none', borderRadius: 8,
    padding: '8px 16px', fontWeight: 600, fontSize: 14, cursor: 'pointer',
    transition: 'transform 0.06s', userSelect: 'none',
  })
  const pill = (bg: string, color: string = '#fff'): React.CSSProperties => ({
    background: bg, color, borderRadius: 999, padding: '2px 10px',
    fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 22 }}>🧺</span>
          <h2 style={{ margin: 0, color: '#0D4A5C', fontSize: 18 }}>Lin — Défroissage automatique</h2>
        </div>
        <p style={{ fontSize: 13, color: '#6B7280', margin: 0 }}>
          Drop tes images : chacune sera retravaillée pour défroisser le vêtement, en gardant
          tout le reste (mannequin, pose, cadrage, fond) strictement identique.
        </p>
      </div>

      <div style={card}>
        <div style={label}>1 — Images à défroisser</div>
        <Dropzone
          files={files}
          onChange={handleFilesChange}
          multiple
          accept="image/*"
          label="Drop tes images ici (multi)"
          hint="Tu peux aussi drop un dossier — toutes les images seront ajoutées"
        />
      </div>

      <div style={card}>
        <div style={label}>2 — Paramètres</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(1, 1fr)', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Parallèle</div>
            <select value={concurrency} onChange={e => setConcurrency(parseInt(e.target.value, 10))} style={input}>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
            </select>
          </div>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: '#6B7280', background: '#F9FAFB',
                      padding: 8, borderRadius: 6 }}>
          💡 Le défroissage utilise <strong>Flux Kontext</strong> (FAL.ai), un modèle d'édition locale
          qui garde fidèlement l'image source (mannequin, pose, fond) — bien plus fidèle que Gemini pour ce type de retouche.
          Le ratio et la résolution de la source sont conservés tels quels.
        </div>
      </div>

      {tasks.length > 0 && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 8 }}>
            <div style={label}>
              3 — Tâches ({stats.total} · ✓ {stats.done} · ⏳ {stats.running} · ✕ {stats.errors})
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={runGeneration}
                disabled={running || stats.total === 0}
                style={{ ...btn(running || stats.total === 0 ? '#9CA3AF' : '#0D4A5C'),
                         cursor: running || stats.total === 0 ? 'not-allowed' : 'pointer' }}
              >
                {running ? '⏳ Défroissage…' : '🧺 Défroisser'}
              </button>
              <button
                onClick={downloadZip}
                disabled={zipping || stats.done === 0}
                style={{ ...btn(zipping || stats.done === 0 ? '#9CA3AF' : '#10B981'),
                         cursor: zipping || stats.done === 0 ? 'not-allowed' : 'pointer' }}
              >
                {zipping ? '⏳ ZIP…' : `📦 Télécharger ZIP (${stats.done})`}
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {tasks.map(t => {
              const srcUrl = URL.createObjectURL(t.source)
              return (
                <div key={t.id} style={{
                  border: '1px solid #E5E7EB', borderRadius: 10, padding: 8, background: '#fff',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    {t.status === 'pending' && <span style={pill('#9CA3AF')}>•</span>}
                    {t.status === 'running' && <span style={pill('#F59E0B')}>⏳</span>}
                    {t.status === 'done'    && <span style={pill('#10B981')}>✓</span>}
                    {t.status === 'error'   && <span style={pill('#EF4444')}>✕</span>}
                    <span style={{ fontSize: 11, color: '#6B7280',
                                   whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                          title={t.source.name}>
                      {t.source.name}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <div style={{ flex: 1, aspectRatio: '3/4', background: '#F3F4F6',
                                  borderRadius: 6, overflow: 'hidden' }}>
                      <img src={srcUrl} alt="source" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </div>
                    <div style={{ flex: 1, aspectRatio: '3/4', background: '#fff',
                                  border: '1px solid #E5E7EB', borderRadius: 6, overflow: 'hidden',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {t.imageUrl
                        ? <img src={t.imageUrl} alt="result" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : <span style={{ fontSize: 11, color: '#9CA3AF' }}>
                            {t.status === 'running' ? '⏳' : t.status === 'error' ? '✕' : '–'}
                          </span>}
                    </div>
                  </div>
                  {t.error && (
                    <div style={{ fontSize: 10, color: '#EF4444', marginTop: 4 }}
                         title={t.error}>
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
