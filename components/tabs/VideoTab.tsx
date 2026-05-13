'use client'
import { useEffect, useRef, useState } from 'react'
import Dropzone from '@/components/ui/Dropzone'
import { compressImage } from '@/lib/compressImage'

type Mode = 'text2video' | 'image2video' | 'image2video_pair'

const RESOLUTIONS = ['720p', '1080p', '4k'] as const
const ASPECTS     = ['9:16', '16:9', '1:1'] as const
const DURATIONS   = [3, 4, 5, 6, 7, 8, 9, 10] as const

export default function VideoTab() {
  const [mode, setMode]               = useState<Mode>('image2video')
  const [prompt, setPrompt]           = useState('')
  const [negative, setNegative]       = useState('')
  const [start, setStart]             = useState<File[]>([])
  const [end, setEnd]                 = useState<File[]>([])
  const [resolution, setResolution]   = useState<typeof RESOLUTIONS[number]>('1080p')
  const [aspect, setAspect]           = useState<typeof ASPECTS[number]>('9:16')
  const [duration, setDuration]       = useState<number>(5)
  const [audio, setAudio]             = useState<boolean>(false)

  const [submitting, setSubmitting]   = useState(false)
  const [polling, setPolling]         = useState(false)
  const [progress, setProgress]       = useState('')
  const [error, setError]             = useState<string | null>(null)
  const [videoUrl, setVideoUrl]       = useState<string | null>(null)
  const [taskId, setTaskId]           = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)

  // Cleanup polling au démontage
  useEffect(() => () => {
    if (pollRef.current) {
      clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const handleSubmit = async () => {
    setError(null)
    setVideoUrl(null)
    setTaskId(null)
    if (!prompt.trim()) {
      setError('Ajoute un prompt avant de générer.')
      return
    }
    if (mode !== 'text2video' && !start.length) {
      setError('Image de départ requise.')
      return
    }
    if (mode === 'image2video_pair' && !end.length) {
      setError('Image de fin requise pour ce mode.')
      return
    }

    setSubmitting(true)
    try {
      setProgress('Compression des images…')
      const startC = start.length ? await compressImage(start[0], { maxSide: 1920, quality: 0.88 }) : null
      const endC   = end.length   ? await compressImage(end[0],   { maxSide: 1920, quality: 0.88 }) : null

      setProgress('Envoi à Kling…')
      const fd = new FormData()
      fd.append('mode',        mode)
      fd.append('prompt',      prompt)
      if (negative.trim()) fd.append('negative', negative)
      fd.append('duration',    String(duration))
      fd.append('resolution',  resolution)
      fd.append('aspectRatio', aspect)
      fd.append('audio',       audio ? 'on' : 'off')
      if (startC) fd.append('image', startC)
      if (endC)   fd.append('imageTail', endC)

      const res  = await fetch('/api/studio/video/create', { method: 'POST', body: fd })
      let data: any = null
      try { data = await res.json() } catch { /* */ }

      if (!res.ok) {
        setError((data && (data.error || data.message)) || `HTTP ${res.status} ${res.statusText}`)
        setSubmitting(false)
        setProgress('')
        return
      }

      setTaskId(data.taskId)
      setSubmitting(false)
      setPolling(true)
      setProgress('Tâche soumise · attente du rendu…')
      poll(data.taskId, data.endpoint, 0)
    } catch (e: any) {
      setError(e?.message ?? 'Erreur réseau')
      setSubmitting(false)
      setProgress('')
    }
  }

  const poll = (id: string, endpoint: string, tick: number) => {
    pollRef.current = window.setTimeout(async () => {
      try {
        const r = await fetch(`/api/studio/video/status?id=${encodeURIComponent(id)}&endpoint=${endpoint}`)
        const data = await r.json()

        if (!r.ok) {
          setError(data?.error || `HTTP ${r.status}`)
          setPolling(false)
          setProgress('')
          return
        }

        const status = String(data.status ?? '').toLowerCase()
        if (status === 'succeeded' && data.videoUrl) {
          setVideoUrl(data.videoUrl)
          setPolling(false)
          setProgress('')
          return
        }
        if (status === 'failed') {
          setError(data.message || 'Kling a renvoyé un échec.')
          setPolling(false)
          setProgress('')
          return
        }

        // Sinon on continue à poller
        const elapsed = tick * 5
        setProgress(`Rendu en cours · ${elapsed}s écoulé(s) · statut : ${status || 'processing'}`)
        if (tick > 60) { // ~5 min max
          setError('Timeout : Kling met trop de temps. Vérifie le statut côté Kling avec l\'ID copié.')
          setPolling(false)
          setProgress('')
          return
        }
        poll(id, endpoint, tick + 1)
      } catch (e: any) {
        setError(e?.message ?? 'Erreur de polling')
        setPolling(false)
        setProgress('')
      }
    }, 5000)
  }

  const cancelPolling = () => {
    if (pollRef.current) clearTimeout(pollRef.current)
    pollRef.current = null
    setPolling(false)
    setProgress('')
  }

  const loading = submitting || polling

  return (
    <div>
      <h2 style={styles.title}>🎬 Video</h2>
      <p style={styles.sub}>Génération vidéo Kling V3.0 — image de départ, image start+end, ou pur texte. Audio optionnel.</p>

      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 24 }}>
        <div style={styles.card}>
          {/* Mode */}
          <label style={styles.label}>Mode</label>
          <div style={styles.modeGroup}>
            <ModeBtn label="🖼️ Image → vidéo"        active={mode === 'image2video'}      onClick={() => setMode('image2video')} />
            <ModeBtn label="🎞️ Image start + end"    active={mode === 'image2video_pair'} onClick={() => setMode('image2video_pair')} />
            <ModeBtn label="✍️ Texte seul"           active={mode === 'text2video'}        onClick={() => setMode('text2video')} />
          </div>

          {/* Prompt */}
          <label style={styles.label}>Prompt</label>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="Ex : mannequin marchant lentement sur une plage de galets, golden hour, contre-jour, mouvement souple, plan rapproché, ralenti subtil."
            style={styles.textarea}
          />

          <label style={styles.label}>Negative prompt (optionnel)</label>
          <input
            value={negative}
            onChange={e => setNegative(e.target.value)}
            placeholder="Ex : flou excessif, déformation, mains anormales"
            style={styles.input}
          />

          {/* Images */}
          {mode !== 'text2video' && (
            <>
              <label style={styles.label}>Image de départ</label>
              <Dropzone files={start} onChange={setStart} label="Glisse l'image de départ" hint="Format ≥ 1080px conseillé" minHeight={90} />
            </>
          )}
          {mode === 'image2video_pair' && (
            <>
              <label style={styles.label}>Image de fin</label>
              <Dropzone files={end} onChange={setEnd} label="Glisse l'image de fin" hint="Même format que l'image de départ" minHeight={90} />
            </>
          )}

          {/* Réglages */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={styles.label}>Résolution</label>
              <select value={resolution} onChange={e => setResolution(e.target.value as any)} style={styles.select}>
                {RESOLUTIONS.map(r => <option key={r} value={r}>{r.toUpperCase()}</option>)}
              </select>
            </div>
            {mode === 'text2video' && (
              <div>
                <label style={styles.label}>Format</label>
                <select value={aspect} onChange={e => setAspect(e.target.value as any)} style={styles.select}>
                  {ASPECTS.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
            )}
          </div>

          <div>
            <label style={styles.label}>Durée : {duration}s</label>
            <input
              type="range"
              min={3}
              max={10}
              step={1}
              value={duration}
              onChange={e => setDuration(Number(e.target.value))}
              style={{ width: '100%' }}
            />
            <div style={styles.rangeTicks}>
              {DURATIONS.map(d => <span key={d}>{d}s</span>)}
            </div>
          </div>

          <label style={{ ...styles.label, display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0, fontSize: 13, fontWeight: 600, color: '#0D4A5C' }}>
            <input type="checkbox" checked={audio} onChange={e => setAudio(e.target.checked)} />
            Activer le son (sound effects / ambiance)
          </label>

          {error && <p style={styles.errorBox}>⚠ {error}</p>}

          <button onClick={handleSubmit} disabled={loading} style={{ ...styles.btn, opacity: loading ? 0.7 : 1 }}>
            {loading ? progress || 'Génération…' : `✦ Générer la vidéo`}
          </button>

          {polling && (
            <button onClick={cancelPolling} style={styles.btnSecondary}>
              Arrêter le suivi (la tâche continue côté Kling)
            </button>
          )}

          {taskId && (
            <p style={styles.hintSubtle}>
              ID de tâche : <code style={{ background: '#E8F2F5', padding: '1px 5px', borderRadius: 3 }}>{taskId}</code>
            </p>
          )}
        </div>

        {/* Résultat */}
        <div>
          {!videoUrl && !loading && !error && (
            <div style={styles.emptyState}>La vidéo apparaîtra ici une fois générée.</div>
          )}
          {loading && !videoUrl && (
            <div style={styles.emptyState}>⏳ {progress || 'Préparation…'}</div>
          )}

          {videoUrl && (
            <div style={styles.resultCard}>
              <video
                controls
                src={videoUrl}
                style={{ width: '100%', borderRadius: 8, display: 'block', background: '#000' }}
                autoPlay
                loop
              />
              <div style={{ display: 'flex', gap: 8, padding: 10, borderTop: '1px solid rgba(13,74,92,0.08)' }}>
                <a href={videoUrl} download={`miraggia_video_${Date.now()}.mp4`} style={styles.downloadBtn}>⬇ Télécharger</a>
                <a href={videoUrl} target="_blank" rel="noreferrer" style={styles.linkBtn}>↗ Ouvrir</a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ModeBtn({ label, active, onClick }: { label: string, active: boolean, onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      ...modeBtn,
      background: active ? '#0D4A5C' : '#fff',
      color:      active ? '#C8F07D' : '#0D4A5C',
      borderColor: active ? '#0D4A5C' : 'rgba(13,74,92,0.2)',
      fontWeight: active ? 700 : 600,
    }}>{label}</button>
  )
}

const modeBtn: React.CSSProperties = {
  padding: '8px 10px', border: '1px solid rgba(13,74,92,0.2)', borderRadius: 7,
  fontSize: 12, cursor: 'pointer', fontFamily: 'system-ui', textAlign: 'center',
}

const styles: Record<string, React.CSSProperties> = {
  title:       { fontFamily: 'system-ui', fontSize: 22, fontWeight: 700, color: '#0D4A5C', marginBottom: 4 },
  sub:         { fontSize: 13, color: '#6B7A8A', marginBottom: 24 },
  card:        { background: '#fff', borderRadius: 12, padding: 20, border: '1px solid rgba(13,74,92,0.1)', display: 'flex', flexDirection: 'column', gap: 12 },
  label:       { fontSize: 11, fontWeight: 700, color: '#6B7A8A', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: 4 },
  modeGroup:   { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 },
  textarea:    { width: '100%', padding: '10px 12px', border: '1px solid rgba(13,74,92,0.15)', borderRadius: 8, fontSize: 13, fontFamily: 'system-ui', resize: 'vertical', minHeight: 110, boxSizing: 'border-box' as const, lineHeight: 1.45 },
  input:       { width: '100%', padding: '8px 10px', border: '1px solid rgba(13,74,92,0.15)', borderRadius: 7, fontSize: 13, fontFamily: 'system-ui', boxSizing: 'border-box' as const },
  select:      { width: '100%', padding: '8px 10px', border: '1px solid rgba(13,74,92,0.15)', borderRadius: 7, fontSize: 13, fontFamily: 'system-ui', background: '#fff' },
  rangeTicks:  { display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#9BA8B5', marginTop: 2 },
  btn:         { padding: '12px', background: '#0D4A5C', color: '#C8F07D', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'system-ui' },
  btnSecondary:{ padding: '9px', background: '#fff', color: '#0D4A5C', border: '1px solid rgba(13,74,92,0.25)', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'system-ui' },
  emptyState:  { textAlign: 'center', padding: '60px 0', color: '#6B7A8A', fontSize: 14, border: '1px dashed rgba(13,74,92,0.2)', borderRadius: 12, background: '#fff' },
  resultCard:  { background: '#fff', borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(13,74,92,0.1)' },
  downloadBtn: { padding: '7px 12px', fontSize: 12, color: '#fff', background: '#0D4A5C', borderRadius: 6, textDecoration: 'none', fontWeight: 600 },
  linkBtn:     { padding: '7px 12px', fontSize: 12, color: '#0D4A5C', border: '1px solid rgba(13,74,92,0.2)', borderRadius: 6, textDecoration: 'none', fontWeight: 600 },
  errorBox:    { background: '#FDECEC', color: '#9B1C1C', border: '1px solid #F5C2C2', padding: '8px 10px', borderRadius: 7, fontSize: 12, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  hintSubtle:  { fontSize: 11, color: '#6B7A8A', margin: 0, lineHeight: 1.5 },
}
