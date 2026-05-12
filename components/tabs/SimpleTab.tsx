'use client'
import { useState } from 'react'
import Dropzone from '@/components/ui/Dropzone'
import { compressImage } from '@/lib/compressImage'

export default function SimpleTab() {
  const [subjects, setSubjects]   = useState<File[]>([])
  const [bg, setBg]               = useState<File[]>([])
  const [brief, setBrief]         = useState('')
  const [ratio, setRatio]         = useState('9:16')
  const [quality, setQuality]     = useState('2K')
  const [results, setResults]     = useState<string[]>([])
  const [loading, setLoading]     = useState(false)
  const [progress, setProgress]   = useState('')
  const [error, setError]         = useState<string | null>(null)
  const [failures, setFailures]   = useState<string[]>([])

  const handleGenerate = async () => {
    setError(null)
    setFailures([])
    if (!subjects.length || !bg.length) {
      setError('Sélectionne au moins un sujet et une image de fond.')
      return
    }
    setLoading(true)
    setResults([])

    const N = subjects.length
    const localFailures: string[] = []

    try {
      setProgress('Préparation du fond…')
      const bgCompressed = await compressImage(bg[0])

      for (let i = 0; i < N; i++) {
        const label = `Sujet ${i + 1}/${N}`
        try {
          setProgress(`${label} · compression`)
          const subjectCompressed = await compressImage(subjects[i])

          setProgress(`${label} · génération`)
          const formData = new FormData()
          formData.append('subject',    subjectCompressed)
          formData.append('background', bgCompressed)
          formData.append('brief', brief || 'Photographie de mode professionnelle')
          formData.append('ratio', ratio)
          formData.append('quality', quality)

          const res = await fetch('/api/studio/simple', { method: 'POST', body: formData })
          let data: any = null
          try { data = await res.json() } catch { /* corps non-JSON */ }

          if (!res.ok) {
            const msg = (data && (data.error || data.message)) || `HTTP ${res.status} ${res.statusText}`
            localFailures.push(`${label} → ${truncate(msg)}`)
            continue
          }
          if (data?.imageUrl) {
            setResults(prev => [...prev, data.imageUrl])
          } else {
            localFailures.push(`${label} → aucune image renvoyée (${truncate(data?.error ?? 'réponse vide')})`)
          }
        } catch (e: any) {
          localFailures.push(`${label} → ${e?.message ?? 'erreur réseau'}`)
        }
      }
    } catch (e: any) {
      setError(e?.message ?? 'Erreur inattendue')
    }

    setProgress('')
    setLoading(false)
    if (localFailures.length) setFailures(localFailures)
  }

  return (
    <div>
      <h2 style={styles.title}>🖼️ Simple</h2>
      <p style={styles.sub}>
        Plusieurs sujets + 1 fond + 1 prompt → une image générée par sujet (même fond, même direction).
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 24 }}>
        <div style={styles.card}>
          <label style={styles.label}>Sujets (plusieurs possibles)</label>
          <Dropzone
            multiple
            files={subjects}
            onChange={setSubjects}
            label="Glisse tes sujets ici"
            hint="Une image générée par sujet · clique ou colle aussi"
          />

          <label style={styles.label}>Image de fond</label>
          <Dropzone
            files={bg}
            onChange={setBg}
            label="Glisse l'image de fond"
            hint="Une seule image · réutilisée pour chaque sujet"
            minHeight={90}
          />

          <label style={styles.label}>Direction artistique</label>
          <textarea value={brief} onChange={e => setBrief(e.target.value)} placeholder="Ex: Photographie lifestyle, lumière naturelle dorée..." style={styles.textarea} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={styles.label}>Format</label>
              <select value={ratio} onChange={e => setRatio(e.target.value)} style={styles.select}>
                {['9:16','3:4','1:1','16:9'].map(r => <option key={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label style={styles.label}>Résolution</label>
              <select value={quality} onChange={e => setQuality(e.target.value)} style={styles.select}>
                {['1K','2K','4K'].map(q => <option key={q}>{q}</option>)}
              </select>
            </div>
          </div>

          {error && <p style={styles.errorBox}>⚠ {error}</p>}

          <button onClick={handleGenerate} disabled={loading} style={{ ...styles.btn, opacity: loading ? 0.7 : 1 }}>
            {loading
              ? progress || 'Génération…'
              : subjects.length > 1
                ? `✦ Générer ${subjects.length} images`
                : '✦ Générer'}
          </button>

          {!loading && results.length > 0 && (
            <p style={styles.hintSubtle}>
              {results.length} / {subjects.length} image(s) générée(s).
            </p>
          )}
        </div>

        {/* Résultats */}
        <div>
          {results.length === 0 && !loading && !error && failures.length === 0 && (
            <div style={styles.emptyState}>Les images générées apparaîtront ici</div>
          )}
          {loading && results.length === 0 && (
            <div style={styles.emptyState}>⏳ {progress}</div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {results.map((url, i) => (
              <div key={i} style={styles.resultCard}>
                <img src={url} alt="" style={{ width: '100%', borderRadius: 8, display: 'block' }} />
                <a href={url} download={`simple_${i+1}.png`} style={styles.downloadBtn}>⬇ Télécharger</a>
              </div>
            ))}
            {loading && (
              <div style={{ ...styles.resultCard, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 200, color: '#6B7A8A', fontSize: 13 }}>
                ⏳ {progress}
              </div>
            )}
          </div>

          {failures.length > 0 && (
            <div style={styles.failuresBox}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>⚠ {failures.length} sujet(s) en échec :</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {failures.map((f, i) => <li key={i} style={{ marginBottom: 2 }}>{f}</li>)}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function truncate(s: string, max = 240) {
  if (!s) return ''
  return s.length > max ? s.slice(0, max) + '…' : s
}

const styles: Record<string, React.CSSProperties> = {
  title:       { fontFamily: 'system-ui', fontSize: 22, fontWeight: 700, color: '#0D4A5C', marginBottom: 4 },
  sub:         { fontSize: 13, color: '#6B7A8A', marginBottom: 24 },
  card:        { background: '#fff', borderRadius: 12, padding: 20, border: '1px solid rgba(13,74,92,0.1)', display: 'flex', flexDirection: 'column', gap: 12 },
  label:       { fontSize: 11, fontWeight: 700, color: '#6B7A8A', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: 4 },
  hint:        { fontSize: 11, color: '#0D4A5C', margin: 0 },
  fileInput:   { width: '100%', fontSize: 12, color: '#0D4A5C' },
  textarea:    { width: '100%', padding: '8px 10px', border: '1px solid rgba(13,74,92,0.15)', borderRadius: 7, fontSize: 13, fontFamily: 'system-ui', resize: 'vertical', minHeight: 72, boxSizing: 'border-box' as const },
  select:      { width: '100%', padding: '8px 10px', border: '1px solid rgba(13,74,92,0.15)', borderRadius: 7, fontSize: 13, fontFamily: 'system-ui', background: '#fff' },
  btn:         { padding: '11px', background: '#0D4A5C', color: '#C8F07D', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'system-ui' },
  emptyState:  { textAlign: 'center', padding: '60px 0', color: '#6B7A8A', fontSize: 14, border: '1px dashed rgba(13,74,92,0.2)', borderRadius: 12, background: '#fff' },
  resultCard:  { background: '#fff', borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(13,74,92,0.1)' },
  downloadBtn: { display: 'block', textAlign: 'center', padding: '8px', fontSize: 12, color: '#0D4A5C', textDecoration: 'none', fontWeight: 600 },
  errorBox:    { background: '#FDECEC', color: '#9B1C1C', border: '1px solid #F5C2C2', padding: '8px 10px', borderRadius: 7, fontSize: 12, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  failuresBox: { marginTop: 16, background: '#FFF8E1', color: '#7A4F00', border: '1px solid #F1D78A', padding: '10px 12px', borderRadius: 8, fontSize: 12 },
  hintSubtle:  { fontSize: 11, color: '#6B7A8A', margin: 0, lineHeight: 1.5 },
}
