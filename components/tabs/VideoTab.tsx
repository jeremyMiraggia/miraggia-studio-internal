'use client'
/**
 * Onglet 🎬 Video — Kling 3.0 via fal.ai.
 *
 * Modes : image → vidéo, ou image de départ + image de fin (transition).
 * Les images partent en upload direct Blob (pas de limite 4.5 MB), la requête
 * est mise en file chez fal, on poll le statut, la vidéo finale est copiée
 * sur Vercel Blob et listée dans un historique de session.
 */
import { useEffect, useRef, useState } from 'react'
import { upload } from '@vercel/blob/client'
import Dropzone from '@/components/ui/Dropzone'
import { compressImage } from '@/lib/compressImage'
import { VIDEO_PRICE_PER_SEC } from '@/lib/video'

type Mode = 'i2v' | 'i2v_pair'
type Tier = 'standard' | 'pro'

type Job = {
  id:         string
  requestId:  string
  endpoint:   string
  tier:       Tier
  mode:       Mode
  prompt:     string
  duration:   number
  audio:      boolean
  startUrl:   string
  endUrl?:    string
  status:     'pending' | 'succeeded' | 'failed'
  phase?:     string
  position?:  number
  videoUrl?:  string
  error?:     string
  createdAt:  number
  raw?:       any
}

const POLL_INTERVAL_MS = 6_000
const POLL_TIMEOUT_MS  = 20 * 60 * 1000

export default function VideoTab() {
  const [mode, setMode]         = useState<Mode>('i2v')
  const [tier, setTier]         = useState<Tier>('standard')
  const [prompt, setPrompt]     = useState('')
  const [start, setStart]       = useState<File[]>([])
  const [end, setEnd]           = useState<File[]>([])
  const [duration, setDuration] = useState(5)
  const [audio, setAudio]       = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress]     = useState('')
  const [error, setError]           = useState<string | null>(null)
  const [jobs, setJobs]             = useState<Job[]>([])
  const jobsRef                     = useRef<Job[]>([])
  const timersRef                   = useRef<Map<string, number>>(new Map())
  const [showRaw, setShowRaw]       = useState<string | null>(null)

  useEffect(() => () => { timersRef.current.forEach(t => clearTimeout(t)); timersRef.current.clear() }, [])

  const updateJob = (id: string, patch: Partial<Job>) => {
    setJobs(prev => {
      const next = prev.map(j => j.id === id ? { ...j, ...patch } : j)
      jobsRef.current = next
      return next
    })
  }

  const estCost = (() => {
    const p = VIDEO_PRICE_PER_SEC[tier]
    return ((audio ? p.audio : p.noAudio) * duration).toFixed(2)
  })()

  /* ----------- Soumission ----------- */
  const handleSubmit = async () => {
    setError(null)
    if (!prompt.trim())               { setError('Ajoute un prompt de mouvement.'); return }
    if (!start.length)                { setError('Image de départ requise.'); return }
    if (mode === 'i2v_pair' && !end.length) { setError('Image de fin requise pour ce mode.'); return }

    setSubmitting(true)
    try {
      setProgress('Upload des images…')
      const up = async (f: File) => {
        // Compression légère : Kling accepte 720-1920 px, inutile d'envoyer du 4K
        let file = f
        try { file = await compressImage(f, { maxSide: 1920, quality: 0.92 }) } catch { /* brut */ }
        const b = await upload(`video-inputs/${Date.now()}-${file.name}`, file, {
          access: 'public', handleUploadUrl: '/api/blob-upload',
          contentType: file.type || 'application/octet-stream',
        })
        return b.url
      }
      const startUrl = await up(start[0])
      const endUrl   = mode === 'i2v_pair' ? await up(end[0]) : undefined

      setProgress('Mise en file chez fal…')
      const res = await fetch('/api/studio/video/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier, prompt, startImageUrl: startUrl, endImageUrl: endUrl, duration, audio }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error([data.error, data.detail].filter(Boolean).join(' — ') || `HTTP ${res.status}`)

      const job: Job = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        requestId: data.requestId, endpoint: data.endpoint, tier, mode, prompt, duration, audio,
        startUrl, endUrl, status: 'pending', phase: 'queue', createdAt: Date.now(),
      }
      setJobs(prev => { const next = [job, ...prev]; jobsRef.current = next; return next })
      schedulePoll(job.id, 1500)
      setProgress('')
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setSubmitting(false)
      setProgress('')
    }
  }

  /* ----------- Polling ----------- */
  const schedulePoll = (jobId: string, delay = POLL_INTERVAL_MS) => {
    const t = window.setTimeout(() => pollOnce(jobId), delay)
    timersRef.current.set(jobId, t)
  }

  const pollOnce = async (jobId: string) => {
    const job = jobsRef.current.find(j => j.id === jobId)
    if (!job || job.status !== 'pending') return
    if (Date.now() - job.createdAt > POLL_TIMEOUT_MS) {
      updateJob(jobId, { status: 'failed', error: 'Délai dépassé (20 min). Relance le suivi si besoin.' })
      return
    }
    try {
      const r = await fetch(`/api/studio/video/status?requestId=${encodeURIComponent(job.requestId)}&endpoint=${encodeURIComponent(job.endpoint)}`)
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error([d.error, d.detail].filter(Boolean).join(' — ') || `HTTP ${r.status}`)
      if (d.status === 'succeeded') {
        updateJob(jobId, { status: 'succeeded', videoUrl: d.videoUrl, raw: d.raw, error: d.blobError ? `Copie Blob échouée (URL fal temporaire) : ${d.blobError}` : undefined })
        return
      }
      if (d.status === 'failed') {
        updateJob(jobId, { status: 'failed', error: d.message || 'Échec fal.', raw: d.raw })
        return
      }
      updateJob(jobId, { phase: d.phase, position: d.position, raw: d.raw })
      schedulePoll(jobId)
    } catch (e: any) {
      // Erreur réseau ponctuelle : on réessaie
      updateJob(jobId, { phase: `retry (${(e?.message ?? '').slice(0, 60)})` })
      schedulePoll(jobId)
    }
  }

  const resume = (jobId: string) => {
    updateJob(jobId, { status: 'pending', error: undefined, createdAt: Date.now() })
    schedulePoll(jobId, 500)
  }

  const download = async (job: Job) => {
    if (!job.videoUrl) return
    try {
      const r = await fetch(job.videoUrl)
      const b = await r.blob()
      const u = URL.createObjectURL(b)
      const a = document.createElement('a')
      a.href = u; a.download = `miraggia_video_${job.duration}s_${job.createdAt}.mp4`
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(u), 5000)
    } catch { window.open(job.videoUrl, '_blank') }
  }

  const busy = submitting

  return (
    <div>
      <h2 style={styles.title}>🎬 Video</h2>
      <p style={styles.sub}>Kling 3.0 via fal.ai — anime un visuel, ou fait la transition entre deux visuels (face → dos). ≈ {VIDEO_PRICE_PER_SEC.standard.noAudio} $/s sans audio.</p>

      <div style={{ display: 'grid', gridTemplateColumns: '400px 1fr', gap: 24 }}>
        <div style={styles.card}>
          <label style={styles.label}>Mode</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <ModeBtn label="🖼️ Image → vidéo"     active={mode === 'i2v'}      onClick={() => setMode('i2v')} />
            <ModeBtn label="🎞️ Start → End frame" active={mode === 'i2v_pair'} onClick={() => setMode('i2v_pair')} />
          </div>

          <label style={styles.label}>Image de départ</label>
          <Dropzone files={start} onChange={setStart} label="Glisse le visuel de départ" hint="Ton visuel validé (720-1920 px)" minHeight={90} />

          {mode === 'i2v_pair' && (
            <>
              <label style={styles.label}>Image de fin</label>
              <Dropzone files={end} onChange={setEnd} label="Glisse le visuel d'arrivée" hint="Même mannequin, même fond — ex. vue de dos" minHeight={90} />
            </>
          )}

          <label style={styles.label}>Prompt de mouvement</label>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder={mode === 'i2v_pair'
              ? 'Ex : the model turns slowly on the spot from front to back, natural walking rhythm, fabric follows the motion, camera fixed, studio lighting unchanged.'
              : 'Ex : the model shifts her weight and takes one slow step toward the camera, hair and fabric move naturally, subtle camera push-in, studio lighting unchanged.'}
            style={styles.textarea}
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={styles.label}>Qualité</label>
              <select value={tier} onChange={e => setTier(e.target.value as Tier)} style={styles.select}>
                <option value="standard">Kling 3.0 Standard</option>
                <option value="pro">Kling 3.0 Pro</option>
              </select>
            </div>
            <div>
              <label style={styles.label}>Durée : {duration}s · ≈ {estCost} $</label>
              <input type="range" min={3} max={15} step={1} value={duration}
                     onChange={e => setDuration(Number(e.target.value))} style={{ width: '100%', marginTop: 8 }} />
            </div>
          </div>

          <label style={{ ...styles.label, display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0, fontSize: 13, fontWeight: 600, color: '#0D4A5C' }}>
            <input type="checkbox" checked={audio} onChange={e => setAudio(e.target.checked)} />
            Audio natif (+50 % du coût)
          </label>

          {error && <p style={styles.errorBox}>⚠ {error}</p>}

          <button onClick={handleSubmit} disabled={busy} style={{ ...styles.btn, opacity: busy ? 0.7 : 1 }}>
            {busy ? progress || 'Envoi…' : '✦ Générer la vidéo'}
          </button>
          <p style={styles.hintSubtle}>Le format de sortie suit l'image de départ. Rendu : 1 à 4 min selon la file fal. Tu peux lancer plusieurs vidéos en parallèle.</p>
        </div>

        {/* ----------- Historique / résultats ----------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {jobs.length === 0 && (
            <div style={styles.emptyState}>Les vidéos apparaîtront ici. Historique de session (perdu au rechargement).</div>
          )}
          {jobs.map(job => (
            <div key={job.id} style={styles.resultCard}>
              <div style={{ display: 'grid', gridTemplateColumns: job.videoUrl ? '1fr 1fr' : '1fr', gap: 12, padding: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <img src={job.startUrl} alt="start" style={{ width: 64, borderRadius: 6, objectFit: 'cover', aspectRatio: '3/4' }} />
                  {job.endUrl && <img src={job.endUrl} alt="end" style={{ width: 64, borderRadius: 6, objectFit: 'cover', aspectRatio: '3/4' }} />}
                  <div style={{ fontSize: 12, color: '#374151', flex: 1 }}>
                    <div style={{ fontWeight: 600, color: '#0D4A5C' }}>
                      {job.mode === 'i2v_pair' ? 'Start → End' : 'Image → vidéo'} · Kling 3.0 {job.tier} · {job.duration}s{job.audio ? ' · audio' : ''}
                    </div>
                    <div style={{ color: '#6B7A8A', marginTop: 2, maxHeight: 48, overflow: 'hidden' }} title={job.prompt}>{job.prompt}</div>
                    <div style={{ marginTop: 6 }}>
                      {job.status === 'pending' && (
                        <span style={{ color: '#B45309' }}>
                          ⏳ {job.phase === 'queue' ? `en file${job.position != null ? ` (position ${job.position})` : ''}` : job.phase === 'rendering' ? 'rendu en cours' : job.phase ?? '…'} · {formatDuration(Date.now() - job.createdAt)}
                        </span>
                      )}
                      {job.status === 'succeeded' && <span style={{ color: '#10B981' }}>✓ prête</span>}
                      {job.status === 'failed' && (
                        <span style={{ color: '#B91C1C' }}>✕ {job.error} <button onClick={() => resume(job.id)} style={styles.copyChip}>↺ reprendre</button></span>
                      )}
                      {job.status === 'succeeded' && job.error && <div style={{ color: '#B45309', fontSize: 11 }}>⚠ {job.error}</div>}
                    </div>
                    <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {job.videoUrl && <button onClick={() => download(job)} style={styles.downloadBtn}>⬇ Télécharger</button>}
                      {job.videoUrl && <a href={job.videoUrl} target="_blank" rel="noreferrer" style={styles.linkBtn}>↗ Ouvrir</a>}
                      {job.raw && <button onClick={() => setShowRaw(showRaw === job.id ? null : job.id)} style={styles.linkBtn}>🔧 brut</button>}
                    </div>
                  </div>
                </div>
                {job.videoUrl && (
                  <video controls src={job.videoUrl} style={{ width: '100%', borderRadius: 8, background: '#000' }} loop />
                )}
              </div>
              {showRaw === job.id && job.raw && (
                <pre style={styles.rawPre}>{JSON.stringify(job.raw, null, 2)}</pre>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ModeBtn({ label, active, onClick }: { label: string, active: boolean, onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: '8px 10px', border: '1px solid', borderRadius: 7, fontSize: 12, cursor: 'pointer', fontFamily: 'system-ui', textAlign: 'center',
      background: active ? '#0D4A5C' : '#fff', color: active ? '#C8F07D' : '#0D4A5C',
      borderColor: active ? '#0D4A5C' : 'rgba(13,74,92,0.2)', fontWeight: active ? 700 : 600,
    }}>{label}</button>
  )
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60), s = total % 60
  return m === 0 ? `${s}s` : `${m}m ${String(s).padStart(2, '0')}s`
}

const styles: Record<string, React.CSSProperties> = {
  title:       { fontFamily: 'system-ui', fontSize: 22, fontWeight: 700, color: '#0D4A5C', marginBottom: 4 },
  sub:         { fontSize: 13, color: '#6B7A8A', marginBottom: 24 },
  card:        { background: '#fff', borderRadius: 12, padding: 20, border: '1px solid rgba(13,74,92,0.1)', display: 'flex', flexDirection: 'column', gap: 12, alignSelf: 'start' },
  label:       { fontSize: 11, fontWeight: 700, color: '#6B7A8A', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: 4 },
  textarea:    { width: '100%', padding: '10px 12px', border: '1px solid rgba(13,74,92,0.15)', borderRadius: 8, fontSize: 13, fontFamily: 'system-ui', resize: 'vertical', minHeight: 100, boxSizing: 'border-box' as const, lineHeight: 1.45 },
  select:      { width: '100%', padding: '8px 10px', border: '1px solid rgba(13,74,92,0.15)', borderRadius: 7, fontSize: 13, fontFamily: 'system-ui', background: '#fff' },
  btn:         { padding: '12px', background: '#0D4A5C', color: '#C8F07D', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'system-ui' },
  emptyState:  { textAlign: 'center', padding: '60px 0', color: '#6B7A8A', fontSize: 14, border: '1px dashed rgba(13,74,92,0.2)', borderRadius: 12, background: '#fff' },
  resultCard:  { background: '#fff', borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(13,74,92,0.1)' },
  downloadBtn: { padding: '6px 10px', fontSize: 12, color: '#fff', background: '#0D4A5C', borderRadius: 6, border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'system-ui' },
  linkBtn:     { padding: '6px 10px', fontSize: 12, color: '#0D4A5C', border: '1px solid rgba(13,74,92,0.2)', borderRadius: 6, textDecoration: 'none', fontWeight: 600, background: '#fff', cursor: 'pointer', fontFamily: 'system-ui' },
  errorBox:    { background: '#FDECEC', color: '#9B1C1C', border: '1px solid #F5C2C2', padding: '8px 10px', borderRadius: 7, fontSize: 12, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  hintSubtle:  { fontSize: 11, color: '#6B7A8A', margin: 0, lineHeight: 1.5 },
  copyChip:    { background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 12, color: '#0D4A5C', textDecoration: 'underline' },
  rawPre:      { margin: 0, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: '#1B2A33', color: '#C8F07D', fontSize: 11, padding: 12 },
}
