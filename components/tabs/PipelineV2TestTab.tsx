'use client'
/**
 * Onglet 🧪 Pipeline V2 Test — POC pour la cohérence de lumière.
 *
 * Workflow utilisateur :
 *   1. Drop fond + mannequin body + face + 1-2 vêtements
 *   2. Sélectionne framing (plein / mi / haut / bas)
 *   3. "Générer" → endpoint /api/studio/pipeline-v2-test
 *   4. Compare : composite brut (avant IC-Light) vs résultat final (après IC-Light)
 */
import { useState } from 'react'
import { upload } from '@vercel/blob/client'
import Dropzone from '@/components/ui/Dropzone'
import { compressImage } from '@/lib/compressImage'

type Result = {
  imageUrl?:    string
  compositeUrl?: string
  cutoutUrl?:   string
  error?:       string
  debug?:       any
  icLightError?: string
}

export default function PipelineV2TestTab() {
  const [background, setBackground]       = useState<File[]>([])
  const [mannequinBody, setMannequinBody] = useState<File[]>([])
  const [mannequinFace, setMannequinFace] = useState<File[]>([])
  const [products, setProducts]           = useState<File[]>([])

  const [framing, setFraming]     = useState('plein')
  const [ratio, setRatio]         = useState('9:16')
  const [quality, setQuality]     = useState('2K')
  const [prompt, setPrompt]       = useState('')
  const [horizonPct, setHorizonPct] = useState(80)   // % de la hauteur du fond où est la ligne du sol
  // Default = custom (BiRefNet + soft drop shadow) — ~10× moins cher que Photoroom
  const [shadowMode, setShadowMode] = useState<'photoroom-soft' | 'photoroom-hard' | 'custom'>('custom')
  // Raffinement du matte (anti-liseré) — mode custom uniquement
  const [matteDecontaminate, setMatteDecontaminate] = useState(true)
  const [matteErode, setMatteErode]     = useState(1)
  const [matteFeather, setMatteFeather] = useState(0.8)

  const [running, setRunning] = useState(false)
  const [result, setResult]   = useState<Result | null>(null)

  const canRun = background.length === 1 && mannequinBody.length === 1 && !running

  const runOne = async () => {
    if (!canRun) return
    setRunning(true)
    setResult(null)
    try {
      // Compress côté client pour rester sous 4.5 MB Vercel
      const compress = async (f: File) => {
        try { return await compressImage(f, { maxSide: 2048, quality: 0.9 }) }
        catch { return f }
      }
      // ⚠ Le FOND n'est JAMAIS compressé : il doit rester pixel-exact.
      // Upload direct vers Blob (contourne la limite 4.5 MB de Vercel).
      const bgFile = background[0]
      const bgBlob = await upload(`pipeline-v2-inputs/${Date.now()}-${bgFile.name}`, bgFile, {
        access: 'public',
        handleUploadUrl: '/api/blob-upload',
        contentType: bgFile.type || 'application/octet-stream',
      })
      // Les références (mannequin, produits) ne servent qu'à Gemini → compression OK
      const body = await compress(mannequinBody[0])
      const face = mannequinFace[0] ? await compress(mannequinFace[0]) : null
      const prods = await Promise.all(products.map(compress))

      const fd = new FormData()
      fd.set('backgroundUrl', bgBlob.url)
      fd.append('mannequinBody', body)
      if (face) fd.append('mannequinFace', face)
      for (const p of prods) fd.append('products', p)
      fd.set('framing', framing)
      fd.set('ratio', ratio)
      fd.set('quality', quality)
      fd.set('prompt', prompt)
      fd.set('horizonPct', String(horizonPct / 100))
      fd.set('shadowMode', shadowMode)
      fd.set('matteDecontaminate', matteDecontaminate ? '1' : '0')
      fd.set('matteErode', String(matteErode))
      fd.set('matteFeather', String(matteFeather))

      const resp = await fetch('/api/studio/pipeline-v2-test', { method: 'POST', body: fd })
      const json = await resp.json()
      if (!resp.ok) {
        setResult({ error: json.error || `HTTP ${resp.status}` })
      } else {
        setResult(json)
      }
    } catch (e: any) {
      setResult({ error: e?.message ?? String(e) })
    } finally {
      setRunning(false)
    }
  }

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
    fontSize: 14, minHeight: 34, background: '#fff', width: '100%',
  }
  const btn = (bg: string, color: string = '#fff'): React.CSSProperties => ({
    background: bg, color, border: 'none', borderRadius: 8,
    padding: '10px 18px', fontWeight: 600, fontSize: 14, cursor: 'pointer',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 22 }}>🧪</span>
          <h2 style={{ margin: 0, color: '#0D4A5C', fontSize: 18 }}>
            Pipeline V2 Test — POC cohérence lumière
          </h2>
        </div>
        <p style={{ fontSize: 13, color: '#6B7280', margin: 0 }}>
          Pipeline : Gemini draft → BiRefNet → composite sur ton fond → <strong>IC-Light</strong> (ré-illumination).
          Tu reçois 2 visuels : le composite brut (avant IC-Light) et le rendu final (après IC-Light).
          Compare entre plusieurs runs si la lumière est bien cohérente.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
        <div style={card}>
          <div style={label}>1 — Fond studio (sera préservé)</div>
          <Dropzone files={background} onChange={setBackground} accept="image/*" multiple={false}
                    label="Fond" hint="Le décor qui restera identique entre tous les visuels" />
        </div>
        <div style={card}>
          <div style={label}>2 — Mannequin body (silhouette)</div>
          <Dropzone files={mannequinBody} onChange={setMannequinBody} accept="image/*" multiple={false}
                    label="Body" hint="Photo pleine du mannequin" />
        </div>
        <div style={card}>
          <div style={label}>3 — Mannequin face (optionnel)</div>
          <Dropzone files={mannequinFace} onChange={setMannequinFace} accept="image/*" multiple={false}
                    label="Face" hint="Portrait visage" />
        </div>
        <div style={card}>
          <div style={label}>4 — Vêtements (1 ou plusieurs)</div>
          <Dropzone files={products} onChange={setProducts} accept="image/*" multiple
                    label="Vêtements" hint="Haut, bas, etc." />
        </div>
      </div>

      <div style={card}>
        <div style={label}>5 — Paramètres</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Framing</div>
            <select value={framing} onChange={e => setFraming(e.target.value)} style={input}>
              <option value="plein">Plein pied</option>
              <option value="mi">Mi-corps</option>
              <option value="haut">Close-up haut (buste)</option>
              <option value="bas">Close-up bas (jambes)</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Ratio</div>
            <select value={ratio} onChange={e => setRatio(e.target.value)} style={input}>
              <option value="9:16">9:16</option>
              <option value="3:4">3:4</option>
              <option value="4:5">4:5 (Insta feed)</option>
              <option value="2:3">2:3</option>
              <option value="1:1">1:1</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Qualité</div>
            <select value={quality} onChange={e => setQuality(e.target.value)} style={input}>
              <option value="1K">1K (rapide)</option>
              <option value="2K">2K (équilibré)</option>
              <option value="4K">4K (max)</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Prompt additionnel</div>
            <input type="text" value={prompt} onChange={e => setPrompt(e.target.value)} style={input}
                   placeholder='ex "main dans la poche"' />
          </div>
        </div>
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>
            Ombre & détourage <strong style={{ color: '#0D4A5C' }}>(important)</strong>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[
              { id: 'photoroom-soft', label: '✨ Photoroom AI soft (recommandé)', desc: 'Ombre subtile naturelle, qualité pro' },
              { id: 'photoroom-hard', label: '🌑 Photoroom AI hard',              desc: 'Ombre plus marquée' },
              { id: 'custom',         label: '⚙ Custom (BiRefNet + ellipse)',    desc: 'Ombre artisanale (test)' },
            ].map(m => (
              <label key={m.id} style={{
                flex: 1, padding: 10, borderRadius: 8, cursor: 'pointer',
                border: shadowMode === m.id ? '2px solid #0D4A5C' : '1px solid #E5E7EB',
                background: shadowMode === m.id ? '#E8F2F5' : '#fff',
              }}>
                <input type="radio" name="shadowMode" checked={shadowMode === m.id}
                       onChange={() => setShadowMode(m.id as any)} style={{ marginRight: 6 }} />
                <strong style={{ fontSize: 12, color: '#0D4A5C' }}>{m.label}</strong>
                <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>{m.desc}</div>
              </label>
            ))}
          </div>
        </div>
        <div style={{ marginTop: 16, opacity: shadowMode === 'custom' ? 1 : 0.5 }}>
          <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>
            Hauteur du sol dans le fond : <strong style={{ color: '#0D4A5C' }}>{horizonPct}%</strong>
            <span style={{ marginLeft: 8, fontSize: 10, color: '#9CA3AF' }}>
              {shadowMode === 'custom'
                ? '(actif : pieds du mannequin posés à cette ligne, ex 85% pour BON_FOND_OFFICIEL)'
                : '(ignoré en mode Photoroom — Photoroom centre auto le sujet sur le fond)'}
            </span>
          </div>
          <input
            type="range"
            min={50} max={95} step={1}
            value={horizonPct}
            onChange={e => setHorizonPct(parseInt(e.target.value, 10))}
            style={{ width: '100%' }}
          />
        </div>

        {/* ===== Raffinement du matte (anti-liseré) ===== */}
        <div style={{ marginTop: 16, opacity: shadowMode === 'custom' ? 1 : 0.5 }}>
          <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 6 }}>
            <strong style={{ color: '#0D4A5C' }}>Détourage — anti-liseré</strong>
            <span style={{ marginLeft: 8, fontSize: 10, color: '#9CA3AF' }}>
              (mode custom — décontamine les bords avec la couleur de fond Gemini mesurée, puis érode + adoucit)
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: 12, alignItems: 'center' }}>
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={matteDecontaminate} onChange={e => setMatteDecontaminate(e.target.checked)} />
              Décontamination
            </label>
            <div>
              <div style={{ fontSize: 11, color: '#6B7280' }}>Érosion : <strong>{matteErode} px</strong></div>
              <input type="range" min={0} max={4} step={1} value={matteErode}
                     onChange={e => setMatteErode(parseInt(e.target.value, 10))} style={{ width: '100%' }} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#6B7280' }}>Feather : <strong>{matteFeather.toFixed(1)}</strong></div>
              <input type="range" min={0} max={3} step={0.1} value={matteFeather}
                     onChange={e => setMatteFeather(parseFloat(e.target.value))} style={{ width: '100%' }} />
            </div>
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <button onClick={runOne} disabled={!canRun}
                  style={{ ...btn(canRun ? '#0D4A5C' : '#9CA3AF'), cursor: canRun ? 'pointer' : 'not-allowed' }}>
            {running ? '⏳ Génération… (~30-50s)' : '🧪 Générer un visuel'}
          </button>
          {!canRun && !running && (
            <span style={{ marginLeft: 12, fontSize: 12, color: '#6B7280' }}>
              Drop au minimum un fond + un mannequin body.
            </span>
          )}
        </div>
      </div>

      {result && (
        <div style={card}>
          <div style={label}>Résultat</div>
          {result.error && (
            <div style={{ background: '#FEF2F2', color: '#991B1B', padding: 12, borderRadius: 8 }}>
              ❌ {result.error}
            </div>
          )}
          {result.icLightError && (
            <div style={{ background: '#FFFBEB', color: '#92400E', padding: 10, borderRadius: 8,
                          fontSize: 12, marginBottom: 12 }}>
              ⚠ IC-Light : {result.icLightError}
            </div>
          )}
          {result.debug?.steps && (
            <div style={{ marginBottom: 12, fontSize: 11, color: '#374151',
                          background: '#F3F4F6', padding: 8, borderRadius: 6 }}>
              <strong>Pipeline utilisée :</strong>{' '}
              {result.debug.steps.photoroom?.ok
                ? `✨ Photoroom ${result.debug.steps.photoroom.mode || ''} OK`
                : result.debug.steps.photoroom?.error
                  ? `❌ Photoroom ÉCHEC : ${result.debug.steps.photoroom.error.slice(0, 100)}`
                  : `⚙ Mode custom (BiRefNet + ombre sharp)`}
              {result.debug.steps.qualityAutoUpgrade && (
                <span style={{ marginLeft: 10 }}>· 🔼 Gemini passé en 4K ({result.debug.steps.qualityAutoUpgrade.reason})</span>
              )}
              {result.debug.steps.matte && !result.debug.steps.matte.error && (
                <span style={{ marginLeft: 10 }}>
                  · 🧹 Matte : fond Gemini mesuré{' '}
                  <span style={{
                    display: 'inline-block', width: 10, height: 10, borderRadius: 2, verticalAlign: 'middle',
                    background: `rgb(${result.debug.steps.matte.bgEstimated.r},${result.debug.steps.matte.bgEstimated.g},${result.debug.steps.matte.bgEstimated.b})`,
                    border: '1px solid #9CA3AF',
                  }} />{' '}
                  {result.debug.steps.matte.decontaminatedPixels.toLocaleString('fr-FR')} px décontaminés,
                  érosion {result.debug.steps.matte.erodePx}px, feather {result.debug.steps.matte.featherSigma}
                </span>
              )}
              {result.debug.steps.matte?.error && (
                <span style={{ marginLeft: 10, color: '#B45309' }}>· ⚠ Matte non raffiné : {result.debug.steps.matte.error}</span>
              )}
            </div>
          )}
          {result.cutoutUrl && (
            <details style={{ marginBottom: 12 }}>
              <summary style={{ fontSize: 12, color: '#6B7280', cursor: 'pointer' }}>
                🔍 Cutout raffiné (sur damier — pour inspecter le bord)
              </summary>
              <a href={result.cutoutUrl} target="_blank" rel="noreferrer">
                <img src={result.cutoutUrl} alt="cutout" style={{
                  maxWidth: 360, marginTop: 8, borderRadius: 8,
                  backgroundImage: 'linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%)',
                  backgroundSize: '16px 16px', backgroundPosition: '0 0,0 8px,8px -8px,-8px 0',
                }} />
              </a>
            </details>
          )}
          {(result.imageUrl || result.compositeUrl) && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {result.compositeUrl && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#6B7280', marginBottom: 4 }}>
                    Étape 3 : Composite brut (avant IC-Light)
                  </div>
                  <a href={result.compositeUrl} target="_blank" rel="noreferrer">
                    <img src={result.compositeUrl} alt="composite" style={{ width: '100%', borderRadius: 8 }} />
                  </a>
                </div>
              )}
              {result.imageUrl && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#10B981', marginBottom: 4 }}>
                    Étape 4 : Final (après IC-Light) ⭐
                  </div>
                  <a href={result.imageUrl} target="_blank" rel="noreferrer">
                    <img src={result.imageUrl} alt="final" style={{ width: '100%', borderRadius: 8 }} />
                  </a>
                </div>
              )}
            </div>
          )}
          {result.debug && (
            <details style={{ marginTop: 12 }}>
              <summary style={{ fontSize: 12, color: '#6B7280', cursor: 'pointer' }}>Debug</summary>
              <pre style={{ fontSize: 10, background: '#F9FAFB', padding: 8, borderRadius: 6, overflow: 'auto' }}>
                {JSON.stringify(result.debug, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
