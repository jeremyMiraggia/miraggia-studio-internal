'use client'
/**
 * Onglet Lin — défroissage automatique d'un dossier entier de looks.
 *
 * Workflow :
 *   1. Le user sélectionne un dossier parent (qui contient des sous-dossiers de
 *      looks). On walke récursivement et on collecte toutes les images.
 *   2. Chaque image est envoyée à /api/studio/free avec le prompt de défroissage.
 *   3. Dès qu'une image est défroissée, on l'écrit DIRECTEMENT à côté de
 *      l'originale (même sous-dossier) sous le nom <baseName>-defroisse.<ext>.
 *   4. (Bonus) Bouton de download ZIP à la fin pour les utilisateurs sans
 *      File System Access API.
 */
import { useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'

type TaskStatus = 'pending' | 'running' | 'done' | 'error' | 'saved'

type LinTask = {
  id:            string
  source:        File
  relativePath:  string           // ex "Look 1/IMG_4521.jpg"
  baseName:      string           // ex "IMG_4521"
  ext:           string           // ex "jpg"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parentDir:     any              // FileSystemDirectoryHandle (= le sous-dossier du look)
  status:        TaskStatus
  imageUrl?:     string
  error?:        string
}

const DEFROISSAGE_PROMPT =
  "Retouch this fashion editorial photograph : the garment has been professionally STEAMED and IRONED. " +
  "The fabric is now perfectly smooth, crisp, freshly pressed — wrinkle-free, crease-free, fold-free, NO crumpled areas anywhere. " +
  "Linen and cotton fabrics keep their natural woven texture visible (still recognizable as linen / cotton), but lie flat with a clean natural drape, soft fall, neat lines — like a luxury runway or magazine cover shot. " +
  "Pay special attention to common wrinkle zones : shoulders, sleeves, elbows, armpits, mid-back, waist, lap, hips, behind knees, around buttons and pockets — every single one must be perfectly smooth. " +
  "KEEP STRICTLY IDENTICAL to the reference image : same model, same face, same hair, same skin, same exact pose, same hand and finger position, same camera angle, same crop, same framing, same composition, same background (every pixel), same lighting, same shadows, same garment color, same garment cut, same garment length, same seams, same stitching, same buttons, same logo, same accessories. " +
  "Style keywords : editorial, lookbook, luxury, pristine, crisp, freshly steamed, professionally ironed, wrinkle-free, magazine quality, high-end fashion photography."

const IMAGE_EXTS = /\.(jpe?g|png|webp|heic)$/i

function sanitizeFilename(s: string): string {
  return s
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80) || 'image'
}

async function ensureWritePermission(handle: any): Promise<boolean> {
  try {
    const opts = { mode: 'readwrite' as const }
    const q = await handle.queryPermission?.(opts) ?? 'prompt'
    if (q === 'granted') return true
    const r = await handle.requestPermission?.(opts) ?? 'denied'
    return r === 'granted'
  } catch {
    return false
  }
}

/**
 * Walker récursif d'un FileSystemDirectoryHandle.
 * Collecte toutes les images (jpg, png, webp, heic) avec leur dossier parent.
 */
async function walkDirectory(
  handle: any,
  accumulator: Array<{ file: File; parentDir: any; relativePath: string; originalName: string }>,
  basePath = '',
): Promise<void> {
  for await (const entry of handle.values()) {
    if (entry.kind === 'directory') {
      const subPath = basePath ? `${basePath}/${entry.name}` : entry.name
      await walkDirectory(entry, accumulator, subPath)
    } else if (entry.kind === 'file') {
      if (IMAGE_EXTS.test(entry.name) && !entry.name.includes('-defroisse')) {
        const file = await entry.getFile()
        accumulator.push({
          file,
          parentDir:    handle,
          relativePath: basePath ? `${basePath}/${entry.name}` : entry.name,
          originalName: entry.name,
        })
      }
    }
  }
}

export default function LinTab() {
  const [tasks, setTasks]       = useState<LinTask[]>([])
  const tasksRef                = useRef<LinTask[]>([])

  const [rootDirName, setRootDirName] = useState<string | null>(null)
  const [scanning, setScanning]       = useState(false)

  const [ratio, setRatio]             = useState('9:16')
  const [quality, setQuality]         = useState('4K')
  const [concurrency, setConcurrency] = useState<number>(2)

  const [running, setRunning]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [zipping, setZipping]   = useState(false)

  /* ----------------- Pick root directory + walk ----------------- */
  const pickRootDir = async () => {
    try {
      // @ts-ignore – File System Access API
      const root = await window.showDirectoryPicker({ mode: 'readwrite' })
      // ⚠ Demande la permission TOUT DE SUITE dans le user gesture (sinon plus
      // tard ça échoue silencieusement car requestPermission exige un user
      // gesture). Cette permission est récursive : tous les sous-dossiers et
      // fichiers obtenus via values() en hériteront.
      const ok = await ensureWritePermission(root)
      if (!ok) {
        setError('Permission d\'écriture refusée pour ce dossier. Re-sélectionne-le et clique "Autoriser".')
        return
      }
      setRootDirName(root.name ?? 'dossier')
      setError(null)
      setScanning(true)

      const collected: Array<{ file: File; parentDir: any; relativePath: string; originalName: string }> = []
      await walkDirectory(root, collected)

      // Test d'écriture : on essaie d'écrire un fichier temporaire DANS LE
      // ROOT pour s'assurer que la permission marche réellement. Si ça plante,
      // on remonte tout de suite au lieu d'attendre les 1ers défroissages.
      try {
        const testHandle = await root.getFileHandle('.lin-perm-check', { create: true })
        const writable = await testHandle.createWritable()
        await writable.write(new Blob(['ok']))
        await writable.close()
        await root.removeEntry('.lin-perm-check').catch(() => {})
      } catch (e: any) {
        setScanning(false)
        setError(`Test d'écriture échoué dans "${root.name}" : ${e?.message ?? e}. Vérifie que le dossier n'est pas read-only / synchronisé OneDrive.`)
        return
      }

      const newTasks: LinTask[] = collected.map((c, i) => {
        const m = c.originalName.match(/^(.*)\.([^.]+)$/)
        const baseName = m ? m[1] : c.originalName
        const ext      = m ? m[2].toLowerCase() : 'png'
        return {
          id:           `${i}-${c.relativePath}-${c.file.lastModified}`,
          source:       c.file,
          relativePath: c.relativePath,
          baseName,
          ext,
          parentDir:    c.parentDir,
          status:       'pending',
        }
      })
      setTasks(newTasks)
      tasksRef.current = newTasks
      setScanning(false)
    } catch (e: any) {
      setScanning(false)
      if (e?.name !== 'AbortError') setError(`Sélection : ${e?.message ?? e}`)
    }
  }

  /* ----------------- Write defroisse file in original folder ----------------- */
  // Retourne { saved: boolean, error?: string }
  const writeDefroisseToFolder = async (task: LinTask): Promise<{ saved: boolean; error?: string }> => {
    if (!task.parentDir) return { saved: false, error: 'parentDir manquant' }
    if (!task.imageUrl)  return { saved: false, error: 'imageUrl manquant' }
    try {
      // ⚠ Ne PAS re-appeler requestPermission ici : on est en dehors d'un user
      // gesture (worker async, des dizaines de secondes après le click).
      // La permission readwrite a déjà été accordée sur le root au pickRootDir
      // — elle s'applique récursivement aux sous-dossiers/handles obtenus via
      // values(). Si elle a vraiment été révoquée, l'erreur remontera via
      // getFileHandle / createWritable qu'on attrape ci-dessous.

      const resp = await fetch(task.imageUrl)
      if (!resp.ok) throw new Error(`Fetch image HTTP ${resp.status}`)
      const blob = await resp.blob()

      // Nom : "<baseName>-defroisse.<ext>" (ext d'origine conservée)
      const safeBase = sanitizeFilename(task.baseName)
      const filename = `${safeBase}-defroisse.${task.ext}`
      const fileHandle = await task.parentDir.getFileHandle(filename, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(blob)
      await writable.close()
      console.log(`[Lin] Saved ${task.relativePath.replace(/\/[^/]+$/, '')}/${filename}`)
      return { saved: true }
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      console.warn('[Lin] write failed', task.relativePath, msg, e)
      return { saved: false, error: msg }
    }
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
      const next = prev.map(t => (t.status === 'done' || t.status === 'saved')
        ? t
        : { ...t, status: 'pending' as TaskStatus, error: undefined })
      tasksRef.current = next
      return next
    })

    const todo = tasksRef.current
      .map((t, idx) => ({ t, idx }))
      .filter(({ t }) => t.status !== 'done' && t.status !== 'saved')

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
        fd.set('prompt', DEFROISSAGE_PROMPT)
        fd.set('ratio', ratio)
        fd.set('quality', quality)
        fd.append('refs', task.source)

        const resp = await fetch('/api/studio/free', { method: 'POST', body: fd })
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

        // Write immediately to the original folder.
        // ⚠ On ne relit PAS tasksRef.current[idx] ici : si plusieurs workers
        // parallèles font setTasks au même moment, le snapshot peut perdre
        // l'imageUrl qu'on vient juste de set (race condition). On construit
        // un objet local immutable avec les données qu'on a sous la main.
        if (task.parentDir) {
          const taskForSave: LinTask = { ...task, status: 'done', imageUrl: url }
          const result = await writeDefroisseToFolder(taskForSave)
          setTasks(prev => {
            const next = [...prev]
            if (result.saved) {
              next[idx] = { ...next[idx], status: 'saved' }
            } else {
              // Garde status 'done' (le visuel est généré) mais ajoute l'erreur de save
              next[idx] = { ...next[idx], error: `Save : ${result.error ?? '?'}` }
            }
            tasksRef.current = next
            return next
          })
          if (!result.saved) {
            setError(`Sauvegarde échouée pour ${task.relativePath} : ${result.error}`)
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

  /* ----------------- ZIP download (bonus) ----------------- */
  const downloadZip = async () => {
    const doneTasks = tasksRef.current.filter(t => (t.status === 'done' || t.status === 'saved') && t.imageUrl)
    if (doneTasks.length === 0) {
      setError('Aucun visuel terminé à empaqueter.')
      return
    }
    setZipping(true)
    setError(null)
    try {
      const zip = new JSZip()
      const usedNames = new Set<string>()
      for (const t of doneTasks) {
        try {
          const resp = await fetch(t.imageUrl!)
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          const blob = await resp.blob()
          const safeBase = sanitizeFilename(t.baseName)
          // Garde la hiérarchie du dossier dans le ZIP
          const folderPart = t.relativePath.replace(/\/[^/]+$/, '')
          let basePath = folderPart
            ? `${folderPart}/${safeBase}-defroisse.${t.ext}`
            : `${safeBase}-defroisse.${t.ext}`
          let final = basePath
          let n = 2
          while (usedNames.has(final)) {
            final = basePath.replace(/(\.[^.]+)$/, `_${n}$1`)
            n++
          }
          usedNames.add(final)
          zip.file(final, blob)
        } catch (e: any) {
          console.warn('[Lin] zip skip', t.relativePath, e)
        }
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
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
    const done    = tasks.filter(t => t.status === 'done' || t.status === 'saved').length
    const saved   = tasks.filter(t => t.status === 'saved').length
    const errors  = tasks.filter(t => t.status === 'error').length
    const runningN= tasks.filter(t => t.status === 'running').length
    return { done, saved, errors, running: runningN, total: tasks.length }
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

  // Group tasks by folder for display
  const grouped = useMemo(() => {
    const byFolder = new Map<string, LinTask[]>()
    for (const t of tasks) {
      const folder = t.relativePath.includes('/')
        ? t.relativePath.replace(/\/[^/]+$/, '')
        : '(racine)'
      const arr = byFolder.get(folder) ?? []
      arr.push(t)
      byFolder.set(folder, arr)
    }
    return Array.from(byFolder.entries())
  }, [tasks])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 22 }}>🧺</span>
          <h2 style={{ margin: 0, color: '#0D4A5C', fontSize: 18 }}>Lin — Défroissage par dossier</h2>
        </div>
        <p style={{ fontSize: 13, color: '#6B7280', margin: 0 }}>
          Sélectionne un dossier parent contenant tes sous-dossiers de looks. Chaque image
          défroissée sera écrite à côté de l'originale, dans le MÊME sous-dossier, sous le nom
          <code style={{ background: '#F3F4F6', padding: '1px 5px', borderRadius: 4, margin: '0 4px' }}>
            NOMDUVISUEL-defroisse.ext
          </code>
          au fur et à mesure.
        </p>
      </div>

      <div style={card}>
        <div style={label}>1 — Dossier parent (avec sous-dossiers de looks)</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={pickRootDir} style={btn('#0D4A5C')} disabled={scanning}>
            📁 {scanning ? 'Scan en cours…' : rootDirName ? `Dossier : ${rootDirName}` : 'Choisir un dossier'}
          </button>
          {rootDirName && !scanning && (
            <span style={{ fontSize: 12, color: '#6B7280' }}>
              {tasks.length} image(s) détectée(s) dans {grouped.length} sous-dossier(s).
            </span>
          )}
        </div>
      </div>

      <div style={card}>
        <div style={label}>2 — Paramètres</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Ratio</div>
            <select value={ratio} onChange={e => setRatio(e.target.value)} style={input}>
              <option value="9:16">9:16</option>
              <option value="3:4">3:4</option>
              <option value="2:3">2:3</option>
              <option value="1:1">1:1 (carré)</option>
              <option value="4:3">4:3</option>
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
        </div>
      </div>

      {tasks.length > 0 && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 8 }}>
            <div style={label}>
              3 — Tâches ({stats.total} · ✓ {stats.done} · 💾 {stats.saved} sauvés · ⏳ {stats.running} · ✕ {stats.errors})
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
                {zipping ? '⏳ ZIP…' : `📦 ZIP (${stats.done})`}
              </button>
            </div>
          </div>

          {/* Liste groupée par sous-dossier */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {grouped.map(([folder, items]) => (
              <div key={folder}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#0D4A5C', marginBottom: 6 }}>
                  📁 {folder} ({items.length})
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
                  {items.map(t => {
                    const srcUrl = URL.createObjectURL(t.source)
                    return (
                      <div key={t.id} style={{
                        border: '1px solid #E5E7EB', borderRadius: 10, padding: 6, background: '#fff',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                          {t.status === 'pending' && <span style={pill('#9CA3AF')}>•</span>}
                          {t.status === 'running' && <span style={pill('#F59E0B')}>⏳</span>}
                          {t.status === 'done'    && <span style={pill('#3B82F6')}>✓</span>}
                          {t.status === 'saved'   && <span style={pill('#10B981')}>💾</span>}
                          {t.status === 'error'   && <span style={pill('#EF4444')}>✕</span>}
                          <span style={{ fontSize: 10, color: '#6B7280',
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
                              ? <img src={t.imageUrl} alt="out" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                              : <span style={{ fontSize: 10, color: '#9CA3AF' }}>
                                  {t.status === 'running' ? '⏳' : t.status === 'error' ? '✕' : '–'}
                                </span>}
                          </div>
                        </div>
                        {t.error && (
                          <div style={{ fontSize: 10, color: '#EF4444', marginTop: 4 }}
                               title={t.error}>
                            {t.error.slice(0, 50)}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
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
