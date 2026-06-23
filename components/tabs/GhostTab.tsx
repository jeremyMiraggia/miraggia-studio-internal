'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import Dropzone from '@/components/ui/Dropzone'
import { parseGhostExport, buildGhostPrompt, type GhostProduct } from '@/lib/notion/parseGhostExport'

type TaskStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error'

type GhostTask = {
  productId:   string
  productIdx:  number
  product:     GhostProduct
  view:        'front' | 'back'   // FRONT ou BACK
  enabled:     boolean
  status:      TaskStatus
  imageUrl?:   string
  error?:      string
}

function sanitizeFilename(s: string): string {
  return s
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80)
    || 'unnamed'
}

function parseRange(input: string): { start: number; end: number } | null {
  const s = (input ?? '').trim()
  if (!s) return null
  const rangeMatch = s.match(/^(\d+)\s*-\s*(\d+)$/)
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10)
    const end   = parseInt(rangeMatch[2], 10)
    if (start > 0 && end >= start) return { start, end }
    return null
  }
  const n = parseInt(s, 10)
  if (!Number.isNaN(n) && n > 0) return { start: 1, end: n }
  return null
}

export default function GhostTab() {
  const [zips, setZips]               = useState<File[]>([])
  const [parsing, setParsing]         = useState(false)
  const [parseProgress, setParseProgress] = useState('')
  const [products, setProducts]       = useState<GhostProduct[]>([])
  const [parseWarnings, setParseWarnings] = useState<string[]>([])
  const [tasks, setTasks]             = useState<GhostTask[]>([])
  const tasksRef                      = useRef<GhostTask[]>([])

  const [productLimit, setProductLimit] = useState<string>('')
  const [ratio, setRatio]             = useState('1:1')
  const [quality, setQuality]         = useState('2K')
  const [concurrency, setConcurrency] = useState<number>(2)

  const [running, setRunning]         = useState(false)
  const [globalError, setGlobalError] = useState<string | null>(null)

  // 📁 Dossier de sortie
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outputDirHandleRef = useRef<any | null>(null)
  const [outputDirName, setOutputDirName] = useState<string | null>(null)
  const writtenTaskIdsRef  = useRef<Set<string>>(new Set())
  const [savedCount, setSavedCount] = useState(0)
  const [saveError, setSaveError]   = useState<string | null>(null)

  /* ----------------- Parse ZIP ----------------- */
  const handleZipChange = async (files: File[]) => {
    setZips(files)
    setGlobalError(null)
    setProducts([])
    setTasks([])
    setParseWarnings([])
    if (files.length === 0) return
    setParsing(true)
    setParseProgress('Démarrage…')
    try {
      const range = parseRange(productLimit) ?? undefined
      const res = await parseGhostExport(files[0], setParseProgress, range)
      setProducts(res.products)
      setParseWarnings(res.warnings)
      // Construit les tâches : 1 FRONT par produit + 1 BACK si présent
      const newTasks: GhostTask[] = []
      res.products.forEach((p, i) => {
        if (p.frontFiles.length > 0) {
          newTasks.push({
            productId: p.id, productIdx: i, product: p,
            view: 'front', enabled: true, status: 'pending',
          })
        }
        if (p.backFiles.length > 0) {
          newTasks.push({
            productId: p.id, productIdx: i, product: p,
            view: 'back', enabled: true, status: 'pending',
          })
        }
      })
      setTasks(newTasks)
      tasksRef.current = newTasks
    } catch (e: any) {
      setGlobalError(e?.message ?? String(e))
    } finally {
      setParsing(false)
      setParseProgress('')
    }
  }

  /* ----------------- Dossier sortie ----------------- */
  // Vérifie/demande la permission readwrite sur le handle de dossier.
  // Sans ça, getFileHandle({create:true}) plante silencieusement sur certains navigateurs.
  const ensureWritePermission = async (handle: any): Promise<boolean> => {
    try {
      const opts = { mode: 'readwrite' as const }
      // queryPermission peut renvoyer 'granted' | 'denied' | 'prompt'
      const q = await handle.queryPermission?.(opts) ?? 'prompt'
      if (q === 'granted') return true
      const r = await handle.requestPermission?.(opts) ?? 'denied'
      return r === 'granted'
    } catch (e) {
      console.warn('[Ghost] ensureWritePermission failed', e)
      return false
    }
  }

  const pickOutputDir = async () => {
    try {
      // @ts-ignore – File System Access API
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
      // Demande explicitement la permission readwrite tout de suite (sinon elle est
      // perdue entre 2 user gestures et l'écriture échoue plus tard)
      const ok = await ensureWritePermission(handle)
      if (!ok) {
        setGlobalError('Permission d\'écriture refusée pour ce dossier.')
        return
      }
      outputDirHandleRef.current = handle
      setOutputDirName(handle.name ?? 'dossier')
      writtenTaskIdsRef.current = new Set()
      setSavedCount(0)
      setSaveError(null)
    } catch (e: any) {
      if (e?.name !== 'AbortError') setGlobalError(`Sélection dossier : ${e?.message ?? e}`)
    }
  }
  const clearOutputDir = () => {
    outputDirHandleRef.current = null
    setOutputDirName(null)
    setSavedCount(0)
    setSaveError(null)
  }

  const writeTaskToOutputDir = async (task: GhostTask) => {
    const handle = outputDirHandleRef.current
    if (!handle || !task.imageUrl) return
    const key = `${task.productId}-${task.view}`
    if (writtenTaskIdsRef.current.has(key)) return
    writtenTaskIdsRef.current.add(key)
    try {
      // Re-check la permission au cas où elle aurait été révoquée
      const ok = await ensureWritePermission(handle)
      if (!ok) throw new Error('Permission readwrite refusée')

      // Fetch le PNG (peut être une URL Vercel Blob ou un data URI)
      const resp = await fetch(task.imageUrl)
      if (!resp.ok) throw new Error(`Fetch image HTTP ${resp.status}`)
      const blob = await resp.blob()

      const base = sanitizeFilename(task.product.sku || `product_${task.productIdx + 1}`)
      const suffix = task.view === 'back' ? '_back' : ''
      const filename = `${base}${suffix}.png`
      const fileHandle = await handle.getFileHandle(filename, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(blob)
      await writable.close()
      console.log(`[Ghost] Saved ${filename}`)
      setSavedCount(c => c + 1)
      setSaveError(null)
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      console.warn('[Ghost] Write failed', msg, e)
      writtenTaskIdsRef.current.delete(key)  // permet retry plus tard
      setSaveError(`Sauvegarde échouée : ${msg.slice(0, 120)}`)
    }
  }

  /* ----------------- Toggle ----------------- */
  const toggleTask = (productId: string, view: 'front' | 'back') => {
    setTasks(prev => {
      const next = prev.map(t => (t.productId === productId && t.view === view)
        ? { ...t, enabled: !t.enabled }
        : t)
      tasksRef.current = next
      return next
    })
  }
  const setAllEnabled = (enabled: boolean) => {
    setTasks(prev => {
      const next = prev.map(t => ({ ...t, enabled }))
      tasksRef.current = next
      return next
    })
  }

  /* ----------------- Génération ----------------- */
  const runGeneration = async () => {
    if (running) return
    setRunning(true)
    setGlobalError(null)

    const todo = tasksRef.current
      .map((t, idx) => ({ t, idx }))
      .filter(({ t }) => t.enabled && t.status !== 'done')

    if (todo.length === 0) {
      setRunning(false)
      setGlobalError('Aucune tâche activée à générer.')
      return
    }

    // Marque toutes les tâches comme pending
    setTasks(prev => {
      const next = prev.map(t => (t.enabled && t.status !== 'done')
        ? { ...t, status: 'pending' as TaskStatus, error: undefined }
        : t)
      tasksRef.current = next
      return next
    })

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
        const prompt = buildGhostPrompt(task.product, task.view)
        fd.set('prompt', prompt)
        fd.set('ratio', ratio)
        fd.set('quality', quality)
        // On envoie les images du produit en refs legacy
        const refs = task.view === 'back' ? task.product.backFiles : task.product.frontFiles
        for (const f of refs) fd.append('refs', f)

        const resp = await fetch('/api/studio/ghost', { method: 'POST', body: fd })
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

        // Write to output dir if configured.
        // Await pour qu'on sache si ça a échoué (sinon erreur silencieuse).
        const updatedTask = tasksRef.current[idx]
        if (outputDirHandleRef.current && updatedTask?.imageUrl) {
          await writeTaskToOutputDir(updatedTask)
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

  /* ----------------- Stats ----------------- */
  const stats = useMemo(() => {
    const enabled = tasks.filter(t => t.enabled).length
    const done    = tasks.filter(t => t.status === 'done').length
    const errors  = tasks.filter(t => t.status === 'error').length
    return { enabled, done, errors, total: tasks.length }
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
          <span style={{ fontSize: 22 }}>👻</span>
          <h2 style={{ margin: 0, color: '#0D4A5C', fontSize: 18 }}>Ghost — Packshots fond blanc</h2>
        </div>
        <p style={{ fontSize: 13, color: '#6B7280', margin: 0 }}>
          Drop un export ZIP Notion contenant les produits (photos iPhone + descriptions).
          Chaque produit sera transformé en packshot professionnel sur fond blanc neutre, piqué.
        </p>
      </div>

      {/* Dropzone */}
      <div style={card}>
        <div style={label}>1 — ZIP Notion produits</div>
        <Dropzone
          files={zips}
          onChange={handleZipChange}
          accept=".zip"
          multiple={false}
          label="Drop le ZIP Notion ici"
          hint="Export Notion contenant le CSV produits + les photos iPhone"
        />
        {parsing && (
          <div style={{ marginTop: 8, fontSize: 13, color: '#0D4A5C' }}>
            ⏳ {parseProgress || 'Lecture…'}
          </div>
        )}
        {parseWarnings.length > 0 && (
          <div style={{ marginTop: 12, fontSize: 12, color: '#374151',
                        background: '#F9FAFB', padding: 10, borderRadius: 8,
                        whiteSpace: 'pre-wrap' }}>
            {parseWarnings.join('\n')}
          </div>
        )}
      </div>

      {/* Paramètres */}
      <div style={card}>
        <div style={label}>2 — Paramètres</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Ratio</div>
            <select value={ratio} onChange={e => setRatio(e.target.value)} style={input}>
              <option value="1:1">1:1 (carré)</option>
              <option value="4:3">4:3</option>
              <option value="3:4">3:4</option>
              <option value="2:3">2:3</option>
              <option value="9:16">9:16</option>
              <option value="16:9">16:9</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Qualité</div>
            <select value={quality} onChange={e => setQuality(e.target.value)} style={input}>
              <option value="1K">1K</option>
              <option value="2K">2K</option>
              <option value="4K">4K</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Parallèle</div>
            <select value={concurrency} onChange={e => setConcurrency(parseInt(e.target.value, 10))} style={input}>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Limite produits (ex 1-10)</div>
            <input
              type="text"
              value={productLimit}
              onChange={e => setProductLimit(e.target.value)}
              placeholder="vide = tout"
              style={input}
            />
          </div>
        </div>

        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={pickOutputDir} style={btn('#0D4A5C')}>
            📁 {outputDirName ? `Dossier : ${outputDirName}` : 'Choisir dossier de sortie'}
          </button>
          {outputDirName && (
            <button onClick={clearOutputDir} style={btn('#E5E7EB', '#374151')}>
              ✕ Retirer
            </button>
          )}
          {outputDirName && (
            <span style={{ fontSize: 12, color: '#6B7280' }}>
              Chaque packshot sera sauvé en .png sous le nom du SKU.
              {savedCount > 0 && <strong style={{ color: '#10B981', marginLeft: 8 }}>✓ {savedCount} sauvé(s)</strong>}
            </span>
          )}
        </div>
        {saveError && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#991B1B',
                        background: '#FEF2F2', padding: 8, borderRadius: 6 }}>
            ❌ {saveError}
          </div>
        )}
      </div>

      {/* Produits / Tâches */}
      {tasks.length > 0 && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={label}>3 — Produits ({stats.enabled} actifs / {stats.total} · {stats.done} faits · {stats.errors} erreurs)</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setAllEnabled(true)} style={btn('#E5E7EB', '#374151')}>Tout cocher</button>
              <button onClick={() => setAllEnabled(false)} style={btn('#E5E7EB', '#374151')}>Tout décocher</button>
              <button
                onClick={runGeneration}
                disabled={running || stats.enabled === 0}
                style={{ ...btn(running || stats.enabled === 0 ? '#9CA3AF' : '#0D4A5C'),
                         cursor: running || stats.enabled === 0 ? 'not-allowed' : 'pointer' }}
              >
                {running ? '⏳ Génération…' : '🎨 Générer'}
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            {tasks.map((t, idx) => {
              const refs = t.view === 'back' ? t.product.backFiles : t.product.frontFiles
              const refUrl = refs[0] ? URL.createObjectURL(refs[0]) : null
              return (
                <div key={`${t.productId}-${t.view}`} style={{
                  border: '1px solid #E5E7EB', borderRadius: 10, padding: 10,
                  background: t.enabled ? '#fff' : '#F9FAFB',
                  opacity: t.enabled ? 1 : 0.5,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <input
                      type="checkbox"
                      checked={t.enabled}
                      onChange={() => toggleTask(t.productId, t.view)}
                    />
                    <span style={pill(t.view === 'back' ? '#7C3AED' : '#0D4A5C')}>{t.view}</span>
                    {t.status === 'done' && <span style={pill('#10B981')}>✓</span>}
                    {t.status === 'error' && <span style={pill('#EF4444')}>✕</span>}
                    {t.status === 'running' && <span style={pill('#F59E0B')}>…</span>}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#0D4A5C',
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                marginBottom: 4 }}
                       title={t.product.sku}>
                    {t.product.sku}
                  </div>
                  {t.product.notes && (
                    <div style={{ fontSize: 11, color: '#92400E', background: '#FEF3C7',
                                  padding: '2px 6px', borderRadius: 4, marginBottom: 4 }}>
                      📝 {t.product.notes}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6 }}>
                    {refUrl && (
                      <div style={{ flex: 1, aspectRatio: '1/1', background: '#F3F4F6',
                                    borderRadius: 6, overflow: 'hidden' }}>
                        <img src={refUrl} alt="ref" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      </div>
                    )}
                    {t.imageUrl && (
                      <div style={{ flex: 1, aspectRatio: '1/1', background: '#fff',
                                    border: '1px solid #E5E7EB', borderRadius: 6, overflow: 'hidden' }}>
                        <img src={t.imageUrl} alt="result" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                      </div>
                    )}
                  </div>
                  {t.error && (
                    <div style={{ fontSize: 11, color: '#EF4444', marginTop: 4 }}
                         title={t.error}>
                      {t.error.slice(0, 60)}
                    </div>
                  )}
                  {t.imageUrl && (
                    <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                      <a
                        href={t.imageUrl}
                        download={`${sanitizeFilename(t.product.sku)}${t.view === 'back' ? '_back' : ''}.png`}
                        style={{ ...btn('#0D4A5C'), padding: '4px 8px', fontSize: 11,
                                 textDecoration: 'none', display: 'inline-block' }}
                        onClick={async (e) => {
                          // Fetch + Blob pour forcer le download
                          e.preventDefault()
                          try {
                            const resp = await fetch(t.imageUrl!)
                            const blob = await resp.blob()
                            const url = URL.createObjectURL(blob)
                            const a = document.createElement('a')
                            a.href = url
                            a.download = `${sanitizeFilename(t.product.sku)}${t.view === 'back' ? '_back' : ''}.png`
                            a.click()
                            setTimeout(() => URL.revokeObjectURL(url), 1000)
                          } catch { window.open(t.imageUrl, '_blank') }
                        }}
                      >
                        ⬇
                      </a>
                      <a
                        href={t.imageUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ ...btn('#E5E7EB', '#374151'), padding: '4px 8px', fontSize: 11,
                                 textDecoration: 'none', display: 'inline-block' }}
                      >
                        ↗
                      </a>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {globalError && (
        <div style={{ ...card, background: '#FEF2F2', color: '#991B1B' }}>
          ❌ {globalError}
        </div>
      )}
    </div>
  )
}
