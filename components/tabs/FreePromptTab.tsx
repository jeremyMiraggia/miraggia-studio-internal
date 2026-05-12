'use client'
import { useState } from 'react'
import Dropzone from '@/components/ui/Dropzone'

export default function FreePromptTab() {
  const [prompt, setPrompt]   = useState('')
  const [refs, setRefs]       = useState<File[]>([])
  const [ratio, setRatio]     = useState('9:16')
  const [quality, setQuality] = useState('2K')
  const [count, setCount]     = useState(1)

  const [results, setResults] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError]     = useState<string | null>(null)

  const handleGenerate = async () => {
    setError(null)
    if (!prompt.trim()) {
      setError('Ajoute un prompt avant de générer.')
      return
    }

    setLoading(true)
    setResults([])

    for (let i = 0; i < count; i++) {
      setProgress(`Génération ${i + 1}/${count}…`)
      try {
        const formData = new FormData()
        formData.append('prompt',  prompt)
        formData.append('ratio',   ratio)
        formData.append('quality', quality)
        refs.forEach(f => formData.append('refs', f))

        const res  = await fetch('/api/studio/free', { method: 'POST', body: formData })
        const data = await res.json()

        if (data.imageUrl) {
          setResults(prev => [...prev, data.imageUrl])
        } else {
          setError(data.error ?? 'Erreur inconnue')
          break
        }
      } catch (e: any) {
        setError(e?.message ?? 'Erreur réseau')
        break
      }
    }

    setProgress('')
    setLoading(false)
  }

  return (
    <div>
      <h2 style={styles.title}>🧠 Free Prompt</h2>
      <p style={styles.sub}>
        Prompt 100 % libre vers Gemini 3 Pro Image Preview. Ajoute des références si tu veux guider le style ou réutiliser un produit.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 24 }}>
        {/* Panneau contrôle */}
        <div style={styles.card}>
          <label style={styles.label}>Prompt</label>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder={
              'Ex : Photographie de mode éditoriale, mannequin en robe lin écru, lumière dorée de fin de journée, plage de galets méditerranéenne, grain argentique léger, ambiance Miraggia.'
            }
            style={styles.textareaLarge}
          />

          <label style={styles.label}>Images de référence (optionnel)</label>
          <Dropzone
            multiple
            files={refs}
            onChange={setRefs}
            label="Glisse des références"
            hint="Style, mannequin, packshot… · clique ou colle aussi"
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <div>
              <label style={styles.label}>Format</label>
              <select value={ratio} onChange={e => setRatio(e.target.value)} style={styles.select}>
                {['9:16', '3:4', '4:3', '1:1', '16:9'].map(r => <option key={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label style={styles.label}>Résolution</label>
              <select value={quality} onChange={e => setQuality(e.target.value)} style={styles.select}>
                {['1K', '2K', '4K'].map(q => <option key={q}>{q}</option>)}
              </select>
            </div>
            <div>
              <label style={styles.label}>Variations</label>
              <select value={count} onChange={e => setCount(Number(e.target.value))} style={styles.select}>
                {[1, 2, 3, 4, 6].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>

          {error && <p style={styles.errorBox}>{error}</p>}

          <button onClick={handleGenerate} disabled={loading} style={{ ...styles.btn, opacity: loading ? 0.7 : 1 }}>
            {loading ? progress || 'Génération…' : `✦ Générer${count > 1 ? ` ${count} images` : ''}`}
          </button>

          <p style={styles.hintSubtle}>
            Astuce : pour un visuel mode pro, précise toujours <em>lumière</em>, <em>lieu</em>, <em>tenue</em>, <em>cadrage</em> et <em>ambiance</em>.
          </p>
        </div>

        {/* Résultats */}
        <div>
          {results.length === 0 && !loading && (
            <div style={styles.emptyState}>
              Les images générées apparaîtront ici.
            </div>
          )}
          {loading && results.length === 0 && (
            <div style={styles.emptyState}>⏳ {progress}</div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            {results.map((url, i) => (
              <div key={i} style={styles.resultCard}>
                <img src={url} alt={`résultat ${i + 1}`} style={{ width: '100%', borderRadius: 8, display: 'block' }} />
                <a href={url} download={`free_prompt_${i + 1}.png`} style={styles.downloadBtn}>⬇ Télécharger</a>
              </div>
            ))}
            {loading && results.length > 0 && (
              <div style={{ ...styles.resultCard, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 200, color: '#6B7A8A', fontSize: 13 }}>
                ⏳ {progress}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  title:        { fontFamily: 'system-ui', fontSize: 22, fontWeight: 700, color: '#0D4A5C', marginBottom: 4 },
  sub:          { fontSize: 13, color: '#6B7A8A', marginBottom: 24 },
  card:         { background: '#fff', borderRadius: 12, padding: 20, border: '1px solid rgba(13,74,92,0.1)', display: 'flex', flexDirection: 'column', gap: 12 },
  label:        { fontSize: 11, fontWeight: 700, color: '#6B7A8A', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: 4 },
  textareaLarge:{ width: '100%', padding: '10px 12px', border: '1px solid rgba(13,74,92,0.15)', borderRadius: 8, fontSize: 13, fontFamily: 'system-ui', resize: 'vertical', minHeight: 160, boxSizing: 'border-box' as const, lineHeight: 1.45 },
  select:       { width: '100%', padding: '8px 10px', border: '1px solid rgba(13,74,92,0.15)', borderRadius: 7, fontSize: 13, fontFamily: 'system-ui', background: '#fff' },
  btn:          { padding: '12px', background: '#0D4A5C', color: '#C8F07D', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'system-ui' },
  emptyState:   { textAlign: 'center', padding: '60px 0', color: '#6B7A8A', fontSize: 14, border: '1px dashed rgba(13,74,92,0.2)', borderRadius: 12, background: '#fff' },
  resultCard:   { background: '#fff', borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(13,74,92,0.1)' },
  downloadBtn:  { display: 'block', textAlign: 'center', padding: '8px', fontSize: 12, color: '#0D4A5C', textDecoration: 'none', fontWeight: 600, borderTop: '1px solid rgba(13,74,92,0.08)' },
  hintSubtle:   { fontSize: 11, color: '#6B7A8A', margin: 0, lineHeight: 1.5 },
  errorBox:     { background: '#FDECEC', color: '#9B1C1C', border: '1px solid #F5C2C2', padding: '8px 10px', borderRadius: 7, fontSize: 12, margin: 0 },
}
