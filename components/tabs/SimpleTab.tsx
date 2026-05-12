'use client'
import { useState, useRef } from 'react'

export default function SimpleTab() {
  const [subjects, setSubjects]   = useState<File[]>([])
  const [bg, setBg]               = useState<File | null>(null)
  const [brief, setBrief]         = useState('')
  const [ratio, setRatio]         = useState('9:16')
  const [quality, setQuality]     = useState('2K')
  const [results, setResults]     = useState<string[]>([])
  const [loading, setLoading]     = useState(false)
  const [progress, setProgress]   = useState('')

  const handleGenerate = async () => {
    if (!subjects.length || !bg) { alert('Images sujet et fond requis.'); return }
    setLoading(true)
    setResults([])

    for (let i = 0; i < subjects.length; i++) {
      setProgress(`Génération ${i + 1}/${subjects.length}...`)
      try {
        const formData = new FormData()
        formData.append('subject', subjects[i])
        formData.append('background', bg)
        formData.append('brief', brief || 'Photographie de mode professionnelle')
        formData.append('ratio', ratio)
        formData.append('quality', quality)

        const res  = await fetch('/api/studio/simple', { method: 'POST', body: formData })
        const data = await res.json()
        if (data.imageUrl) setResults(prev => [...prev, data.imageUrl])
        else console.error('Erreur:', data.error)
      } catch (e) { console.error(e) }
    }

    setProgress('')
    setLoading(false)
  }

  return (
    <div>
      <h2 style={styles.title}>🖼️ Simple</h2>
      <p style={styles.sub}>Fusionnez un sujet avec un fond. Une image par génération.</p>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 24 }}>
        <div style={styles.card}>
          <label style={styles.label}>Sujets (plusieurs possibles)</label>
          <input type="file" multiple accept="image/*" onChange={e => setSubjects(Array.from(e.target.files ?? []))} style={styles.fileInput} />
          {subjects.length > 0 && <p style={styles.hint}>{subjects.length} fichier(s) sélectionné(s)</p>}

          <label style={styles.label}>Image de fond</label>
          <input type="file" accept="image/*" onChange={e => setBg(e.target.files?.[0] ?? null)} style={styles.fileInput} />

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

          <button onClick={handleGenerate} disabled={loading} style={styles.btn}>
            {loading ? progress || 'Génération...' : `✦ Générer ${subjects.length > 1 ? subjects.length + ' images' : ''}`}
          </button>
        </div>

        {/* Résultats */}
        <div>
          {results.length === 0 && !loading && (
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
          </div>
        </div>
      </div>
    </div>
  )
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
  emptyState:  { textAlign: 'center', padding: '60px 0', color: '#6B7A8A', fontSize: 14 },
  resultCard:  { background: '#fff', borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(13,74,92,0.1)' },
  downloadBtn: { display: 'block', textAlign: 'center', padding: '8px', fontSize: 12, color: '#0D4A5C', textDecoration: 'none', fontWeight: 600 },
}