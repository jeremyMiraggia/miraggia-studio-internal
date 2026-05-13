'use client'
import { useState } from 'react'
import Dropzone from '@/components/ui/Dropzone'
import { compressAll } from '@/lib/compressImage'

type Row = {
  index: number
  filename: string
  thumbnail?: string
  environnement?: string
  pose?: string
  error?: string
}

export default function ExtractTab() {
  const [images, setImages]   = useState<File[]>([])
  const [rows, setRows]       = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError]     = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const handleExtract = async () => {
    setError(null)
    setRows([])
    if (!images.length) {
      setError('Ajoute au moins une image à analyser.')
      return
    }
    setLoading(true)

    try {
      setProgress('Compression des images…')
      const compressed = await compressAll(images, { maxSide: 1600, quality: 0.85 })

      // Vignettes data-URL en parallèle pour l'affichage
      setProgress('Création des vignettes…')
      const thumbs = await Promise.all(compressed.map(fileToDataUrl))

      setProgress(`Analyse Gemini de ${compressed.length} image(s)…`)
      const formData = new FormData()
      compressed.forEach(f => formData.append('images', f))

      const res  = await fetch('/api/studio/extract', { method: 'POST', body: formData })
      let data: any = null
      try { data = await res.json() } catch { /* */ }

      if (!res.ok) {
        const msg = (data && (data.error || data.message)) || `HTTP ${res.status} ${res.statusText}`
        setError(msg)
        setLoading(false)
        setProgress('')
        return
      }

      const results: Row[] = (data?.results ?? []).map((r: any) => ({
        ...r,
        thumbnail: thumbs[r.index],
      }))
      setRows(results.sort((a, b) => a.index - b.index))
    } catch (e: any) {
      setError(e?.message ?? 'Erreur réseau')
    }

    setProgress('')
    setLoading(false)
  }

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(prev => (prev === key ? null : prev)), 1200)
    } catch {
      /* ignore */
    }
  }

  const exportCSV = () => {
    if (!rows.length) return
    const esc = (s: string) => `"${(s ?? '').replaceAll('"', '""')}"`
    const lines = [
      ['fichier', 'environnement', 'pose'].map(esc).join(','),
      ...rows.map(r => [r.filename, r.environnement ?? r.error ?? '', r.pose ?? ''].map(esc).join(',')),
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url
    a.download = `miraggia_extracteur_${new Date().toISOString().slice(0,10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      <h2 style={styles.title}>🔍 Extracteur</h2>
      <p style={styles.sub}>
        Charge une ou plusieurs photos. L'IA renvoie pour chacune <strong>l'environnement</strong> et <strong>la pose</strong>, en jargon mode — sans décrire la tenue ni le mannequin.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 24 }}>
        {/* Panneau contrôle */}
        <div style={styles.card}>
          <label style={styles.label}>Photos à analyser</label>
          <Dropzone
            multiple
            files={images}
            onChange={setImages}
            label="Glisse tes photos"
            hint="Lookbook, shooting, références… plusieurs possibles"
          />

          {error && <p style={styles.errorBox}>⚠ {error}</p>}

          <button onClick={handleExtract} disabled={loading || images.length === 0} style={{ ...styles.btn, opacity: loading || images.length === 0 ? 0.6 : 1 }}>
            {loading ? progress || 'Analyse…' : `✦ Extraire${images.length > 1 ? ` ${images.length} prompts` : ''}`}
          </button>

          {rows.length > 0 && !loading && (
            <button onClick={exportCSV} style={styles.btnSecondary}>
              ⬇ Exporter CSV
            </button>
          )}

          <p style={styles.hintSubtle}>
            Décrit : décor, lumière, ambiance, posture, regard, cadrage.<br />
            Ignore : tenue, accessoires, physique, marque.
          </p>
        </div>

        {/* Résultats */}
        <div>
          {rows.length === 0 && !loading && !error && (
            <div style={styles.emptyState}>Le tableau de prompts apparaîtra ici.</div>
          )}
          {loading && rows.length === 0 && (
            <div style={styles.emptyState}>⏳ {progress}</div>
          )}

          {rows.length > 0 && (
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={{ ...styles.th, width: 90 }}>Image</th>
                    <th style={styles.th}>Environnement</th>
                    <th style={styles.th}>Pose</th>
                    <th style={{ ...styles.th, width: 90 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const envKey  = `env-${r.index}`
                    const poseKey = `pose-${r.index}`
                    const bothKey = `both-${r.index}`
                    return (
                      <tr key={r.index} style={styles.tr}>
                        <td style={styles.td}>
                          {r.thumbnail
                            ? <img src={r.thumbnail} alt={r.filename} style={styles.thumb} title={r.filename} />
                            : <div style={styles.thumbPlaceholder}>—</div>}
                          <div style={styles.filename} title={r.filename}>{r.filename}</div>
                        </td>
                        {r.error ? (
                          <td colSpan={2} style={{ ...styles.td, color: '#9B1C1C', background: '#FDECEC' }}>
                            ⚠ {r.error}
                          </td>
                        ) : (
                          <>
                            <td style={styles.td}>
                              <div style={styles.cellText}>{r.environnement}</div>
                              <button onClick={() => copy(r.environnement ?? '', envKey)} style={styles.copyBtn}>
                                {copiedKey === envKey ? '✓ copié' : '📋 copier'}
                              </button>
                            </td>
                            <td style={styles.td}>
                              <div style={styles.cellText}>{r.pose}</div>
                              <button onClick={() => copy(r.pose ?? '', poseKey)} style={styles.copyBtn}>
                                {copiedKey === poseKey ? '✓ copié' : '📋 copier'}
                              </button>
                            </td>
                          </>
                        )}
                        <td style={styles.td}>
                          {!r.error && (
                            <button
                              onClick={() => copy(`${r.environnement}\n\n${r.pose}`, bothKey)}
                              style={styles.copyBtn}
                              title="Copier environnement + pose"
                            >
                              {copiedKey === bothKey ? '✓ tout' : '📋 tout'}
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

const styles: Record<string, React.CSSProperties> = {
  title:       { fontFamily: 'system-ui', fontSize: 22, fontWeight: 700, color: '#0D4A5C', marginBottom: 4 },
  sub:         { fontSize: 13, color: '#6B7A8A', marginBottom: 24, lineHeight: 1.5 },
  card:        { background: '#fff', borderRadius: 12, padding: 20, border: '1px solid rgba(13,74,92,0.1)', display: 'flex', flexDirection: 'column', gap: 12 },
  label:       { fontSize: 11, fontWeight: 700, color: '#6B7A8A', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: 4 },
  btn:         { padding: '11px', background: '#0D4A5C', color: '#C8F07D', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'system-ui' },
  btnSecondary:{ padding: '9px', background: '#fff', color: '#0D4A5C', border: '1px solid rgba(13,74,92,0.25)', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'system-ui' },
  emptyState:  { textAlign: 'center', padding: '60px 0', color: '#6B7A8A', fontSize: 14, border: '1px dashed rgba(13,74,92,0.2)', borderRadius: 12, background: '#fff' },
  errorBox:    { background: '#FDECEC', color: '#9B1C1C', border: '1px solid #F5C2C2', padding: '8px 10px', borderRadius: 7, fontSize: 12, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  hintSubtle:  { fontSize: 11, color: '#6B7A8A', margin: 0, lineHeight: 1.5 },
  tableWrap:   { background: '#fff', borderRadius: 12, border: '1px solid rgba(13,74,92,0.1)', overflow: 'hidden' },
  table:       { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th:          { textAlign: 'left', padding: '10px 12px', background: '#F5F7F9', color: '#0D4A5C', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid rgba(13,74,92,0.1)' },
  tr:          { borderBottom: '1px solid rgba(13,74,92,0.06)', verticalAlign: 'top' },
  td:          { padding: '12px', verticalAlign: 'top', lineHeight: 1.5, color: '#0D4A5C' },
  cellText:    { whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: 6 },
  thumb:       { width: 72, height: 72, objectFit: 'cover', borderRadius: 6, display: 'block', border: '1px solid rgba(13,74,92,0.1)' },
  thumbPlaceholder: { width: 72, height: 72, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, background: '#F5F7F9', color: '#9BA8B5' },
  filename:    { fontSize: 10, color: '#6B7A8A', marginTop: 6, maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  copyBtn:     { padding: '4px 8px', background: '#E8F2F5', color: '#0D4A5C', border: 'none', borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'system-ui' },
}
