'use client'
import { useState } from 'react'
import JSZip from 'jszip'
import Dropzone from '@/components/ui/Dropzone'
import { compressAll } from '@/lib/compressImage'
import { parseNotionExport, type GenerationTask, type ParsedExport } from '@/lib/notion/parseExport'

type TaskStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error'

type TaskState = {
  task:   GenerationTask
  status: TaskStatus
  enabled:boolean
  imageUrl?: string
  error?:   string
}

export default function NotionTab() {
  const [zips, setZips]               = useState<File[]>([])
  const [parsing, setParsing]         = useState(false)
  const [parsed, setParsed]           = useState<ParsedExport | null>(null)
  const [states, setStates]           = useState<TaskState[]>([])
  const [globalError, setGlobalError] = useState<string | null>(null)

  const [ratio, setRatio]             = useState('9:16')
  const [quality, setQuality]         = useState('2K')
  const [running, setRunning]         = useState(false)
  const [progress, setProgress]       = useState('')

  /* ----------- Parsing zip ----------- */
  const handleZipChange = async (files: File[]) => {
    setZips(files)
    setGlobalError(null)
    setParsed(null)
    setStates([])

    if (files.length === 0) return
    setParsing(true)
    try {
      const result = await parseNotionExport(files[0])
      setParsed(result)
      setStates(result.tasks.map(t => ({
        task: t,
        status: 'pending',
        enabled: true,
      })))
    } catch (e: any) {
      setGlobalError(e?.message ?? 'Impossible de parser le zip.')
    }
    setParsing(false)
  }

  const enabledCount = states.filter(s => s.enabled).length

  const toggleTask = (id: string) => {
    setStates(prev => prev.map(s => s.task.id === id ? { ...s, enabled: !s.enabled } : s))
  }
  const toggleAll = (value: boolean) => {
    setStates(prev => prev.map(s => ({ ...s, enabled: value })))
  }

  /* ----------- Génération séquentielle ----------- */
  const handleRunAll = async () => {
    if (!parsed) return
    setGlobalError(null)
    setRunning(true)

    const queue = states.filter(s => s.enabled && s.status !== 'done')
    let done = 0

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i]
      setProgress(`Visuel ${i + 1}/${queue.length} · ${item.task.numeroLook} · ${item.task.vueRaw}`)
      updateState(item.task.id, { status: 'running', error: undefined })

      try {
        const refs = await compressAll(item.task.refs, { maxSide: 2048, quality: 0.85 })

        const fd = new FormData()
        fd.append('prompt',  item.task.prompt)
        fd.append('ratio',   ratio)
        fd.append('quality', quality)
        refs.forEach(f => fd.append('refs', f))

        const res = await fetch('/api/studio/free', { method: 'POST', body: fd })
        let data: any = null
        try { data = await res.json() } catch { /* */ }

        if (!res.ok) {
          const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`
          updateState(item.task.id, { status: 'error', error: truncate(msg) })
          continue
        }
        if (data?.imageUrl) {
          updateState(item.task.id, { status: 'done', imageUrl: data.imageUrl })
          done += 1
        } else {
          updateState(item.task.id, { status: 'error', error: data?.error ?? 'Aucune image renvoyée' })
        }
      } catch (e: any) {
        updateState(item.task.id, { status: 'error', error: e?.message ?? 'Erreur réseau' })
      }
    }

    setProgress(`Terminé · ${done}/${queue.length} visuel(s) générés`)
    setRunning(false)
  }

  const updateState = (id: string, patch: Partial<TaskState>) => {
    setStates(prev => prev.map(s => s.task.id === id ? { ...s, ...patch } : s))
  }

  /* ----------- Export ZIP des résultats ----------- */
  const exportZip = async () => {
    const ok = states.filter(s => s.status === 'done' && s.imageUrl)
    if (!ok.length) return
    const zip = new JSZip()
    for (const s of ok) {
      const blob = await dataUrlToBlob(s.imageUrl!)
      const ext  = blob.type.includes('png') ? 'png' : 'jpg'
      const safeName = `look_${s.task.numeroLook}_vue${s.task.vueIndex + 1}_${slug(s.task.vueRaw)}.${ext}`
      zip.file(safeName, blob)
    }
    const blob = await zip.generateAsync({ type: 'blob' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url
    a.download = `miraggia_notion_${new Date().toISOString().slice(0, 10)}.zip`
    a.click()
    URL.revokeObjectURL(url)
  }

  /* ----------- Render ----------- */
  return (
    <div>
      <h2 style={styles.title}>📥 Notion Batch</h2>
      <p style={styles.sub}>Dépose un export Notion de la base LOOK. L'app résout mannequins, fonds, vêtements, poses, et lance la génération de tous les visuels en un clic.</p>

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 24 }}>
        {/* Panneau contrôle */}
        <div style={styles.card}>
          <label style={styles.label}>Export Notion (.zip)</label>
          <Dropzone
            files={zips}
            onChange={handleZipChange}
            accept=".zip,application/zip,application/x-zip-compressed"
            label="Glisse ton export Notion"
            hint="Le ZIP doit contenir LOOK*.csv + Models Definition*.csv + Fonds*.csv + images"
            minHeight={120}
          />

          {parsing && <p style={styles.hintSubtle}>Lecture et indexation du zip…</p>}

          {parsed && (
            <div style={styles.statsBox}>
              <div><strong>{parsed.looks.length}</strong> look(s), <strong>{parsed.models.size}</strong> mannequin(s), <strong>{parsed.fonds.size}</strong> fond(s)</div>
              <div style={{ marginTop: 4 }}><strong>{parsed.tasks.length}</strong> visuel(s) à générer · <strong>{enabledCount}</strong> sélectionné(s)</div>
              {parsed.warnings.length > 0 && (
                <div style={{ ...styles.warningRow, marginTop: 6 }}>
                  ⚠ {parsed.warnings.join(' · ')}
                </div>
              )}
            </div>
          )}

          {globalError && <p style={styles.errorBox}>⚠ {globalError}</p>}

          {/* Réglages génération */}
          {parsed && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={styles.label}>Format</label>
                  <select value={ratio} onChange={e => setRatio(e.target.value)} style={styles.select}>
                    {['9:16','3:4','1:1','16:9','4:3'].map(r => <option key={r}>{r}</option>)}
                  </select>
                </div>
                <div>
                  <label style={styles.label}>Résolution</label>
                  <select value={quality} onChange={e => setQuality(e.target.value)} style={styles.select}>
                    {['1K','2K','4K'].map(q => <option key={q}>{q}</option>)}
                  </select>
                </div>
              </div>

              <button onClick={handleRunAll} disabled={running || enabledCount === 0} style={{ ...styles.btn, opacity: running || enabledCount === 0 ? 0.6 : 1 }}>
                {running ? (progress || 'Génération…') : `▶ Tout générer (${enabledCount})`}
              </button>

              {states.some(s => s.status === 'done') && !running && (
                <button onClick={exportZip} style={styles.btnSecondary}>⬇ Télécharger les résultats en ZIP</button>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => toggleAll(true)}  style={styles.btnGhost}>Tout cocher</button>
                <button onClick={() => toggleAll(false)} style={styles.btnGhost}>Tout décocher</button>
              </div>
            </>
          )}
        </div>

        {/* Liste des tâches */}
        <div>
          {!parsed && (
            <div style={styles.emptyState}>
              Dépose ton export Notion à gauche. Tu verras ici la liste des visuels à générer, avec une preview du prompt et des références.
            </div>
          )}

          {parsed && states.length === 0 && (
            <div style={styles.emptyState}>
              Aucun visuel valide trouvé. Vérifie que les lignes ont bien un Mannequin, un Fond et au moins une "Vue et Pose".
            </div>
          )}

          {states.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {states.map(s => <TaskCard key={s.task.id} state={s} onToggle={() => toggleTask(s.task.id)} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ============================== TaskCard ============================== */

function TaskCard({ state, onToggle }: { state: TaskState, onToggle: () => void }) {
  const { task, status, imageUrl, error, enabled } = state
  const statusColor =
    status === 'done'    ? '#1F7A35'
    : status === 'error' ? '#9B1C1C'
    : status === 'running'? '#0D4A5C'
    : '#6B7A8A'

  return (
    <div style={taskCardStyle}>
      {/* Header ligne */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={onToggle}
          disabled={status === 'running' || status === 'done'}
          style={{ marginTop: 2 }}
        />
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 90px', gap: 10 }}>
          <div>
            <div style={{ fontWeight: 700, color: '#0D4A5C', fontSize: 13 }}>
              Look #{task.numeroLook} · {task.mannequinName} · {task.fondName}
            </div>
            <div style={{ fontSize: 12, color: '#6B7A8A', marginTop: 2 }}>
              Pose : <span style={{ color: '#0D4A5C', fontWeight: 600 }}>{task.vueRaw}</span> · {task.refs.length} ref(s) image
            </div>
            <div style={{ fontSize: 11, color: '#6B7A8A', marginTop: 2 }}>
              ID tâche : <code>{task.id}</code>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <span style={{ ...statusPill, color: statusColor, borderColor: statusColor }}>
              {labelForStatus(status)}
            </span>
          </div>
        </div>
      </div>

      {/* Warnings parser */}
      {task.warnings.length > 0 && (
        <div style={styles.warningRow}>⚠ {task.warnings.join(' · ')}</div>
      )}

      {/* Erreur génération */}
      {error && <div style={styles.errorBox}>⚠ {error}</div>}

      {/* Image résultat */}
      {imageUrl && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <img src={imageUrl} alt={task.id} style={{ width: 160, borderRadius: 8, border: '1px solid rgba(13,74,92,0.1)' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <a href={imageUrl} download={`look_${task.numeroLook}_vue${task.vueIndex + 1}.png`} style={styles.linkBtnDark}>⬇ Télécharger</a>
            <a href={imageUrl} target="_blank" rel="noreferrer" style={styles.linkBtnLight}>↗ Ouvrir</a>
          </div>
        </div>
      )}

      {/* Prompt collapsible */}
      <details style={{ marginTop: 4 }}>
        <summary style={{ cursor: 'pointer', fontSize: 11, color: '#6B7A8A', fontWeight: 600 }}>Voir le prompt envoyé</summary>
        <pre style={styles.promptPre}>{task.prompt}</pre>
      </details>
    </div>
  )
}

function labelForStatus(s: TaskStatus): string {
  switch (s) {
    case 'pending': return '○ en attente'
    case 'running': return '⏳ en cours'
    case 'done':    return '✓ terminé'
    case 'error':   return '⚠ erreur'
    case 'skipped': return '— sauté'
  }
}

/* ============================== utils ============================== */

function truncate(s: string, max = 240) {
  if (!s) return ''
  return s.length > max ? s.slice(0, max) + '…' : s
}

function slug(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl)
  return await res.blob()
}

/* ============================== styles ============================== */

const taskCardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid rgba(13,74,92,0.1)',
  borderRadius: 12,
  padding: 14,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}

const statusPill: React.CSSProperties = {
  display: 'inline-block',
  padding: '3px 8px',
  border: '1px solid',
  borderRadius: 999,
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
}

const styles: Record<string, React.CSSProperties> = {
  title:       { fontFamily: 'system-ui', fontSize: 22, fontWeight: 700, color: '#0D4A5C', marginBottom: 4 },
  sub:         { fontSize: 13, color: '#6B7A8A', marginBottom: 24, lineHeight: 1.5 },
  card:        { background: '#fff', borderRadius: 12, padding: 20, border: '1px solid rgba(13,74,92,0.1)', display: 'flex', flexDirection: 'column', gap: 12 },
  label:       { fontSize: 11, fontWeight: 700, color: '#6B7A8A', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: 4 },
  select:      { width: '100%', padding: '8px 10px', border: '1px solid rgba(13,74,92,0.15)', borderRadius: 7, fontSize: 13, fontFamily: 'system-ui', background: '#fff' },
  btn:         { padding: '12px', background: '#0D4A5C', color: '#C8F07D', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'system-ui' },
  btnSecondary:{ padding: '9px', background: '#fff', color: '#0D4A5C', border: '1px solid rgba(13,74,92,0.25)', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'system-ui' },
  btnGhost:    { flex: 1, padding: '7px', background: 'transparent', color: '#0D4A5C', border: '1px dashed rgba(13,74,92,0.25)', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'system-ui' },
  emptyState:  { textAlign: 'center', padding: '60px 24px', color: '#6B7A8A', fontSize: 14, border: '1px dashed rgba(13,74,92,0.2)', borderRadius: 12, background: '#fff', lineHeight: 1.5 },
  errorBox:    { background: '#FDECEC', color: '#9B1C1C', border: '1px solid #F5C2C2', padding: '8px 10px', borderRadius: 7, fontSize: 12, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  warningRow:  { background: '#FFF8E1', color: '#7A4F00', border: '1px solid #F1D78A', padding: '6px 10px', borderRadius: 6, fontSize: 11 },
  hintSubtle:  { fontSize: 11, color: '#6B7A8A', margin: 0 },
  statsBox:    { background: '#E8F2F5', color: '#0D4A5C', borderRadius: 8, padding: '10px 12px', fontSize: 12, lineHeight: 1.5 },
  promptPre:   { margin: '6px 0 0', background: '#F5F7F9', borderRadius: 6, padding: 10, fontSize: 11, color: '#0D4A5C', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 220, overflow: 'auto' },
  linkBtnDark: { padding: '6px 10px', fontSize: 11, color: '#fff', background: '#0D4A5C', borderRadius: 6, textDecoration: 'none', fontWeight: 600, textAlign: 'center' },
  linkBtnLight:{ padding: '6px 10px', fontSize: 11, color: '#0D4A5C', border: '1px solid rgba(13,74,92,0.2)', borderRadius: 6, textDecoration: 'none', fontWeight: 600, textAlign: 'center' },
}
