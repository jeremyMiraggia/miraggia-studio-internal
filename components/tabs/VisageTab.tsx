'use client'
/**
 * Onglet 🎭 Visage — création de mannequins sur mesure (face + profil cohérents).
 */
import { useMemo, useState } from 'react'
import JSZip from 'jszip'
import Dropzone from '@/components/ui/Dropzone'
import { compressImage } from '@/lib/compressImage'
import {
  GENDERS, AGE_RANGES, RANGES, UNDERTONES, SKIN_TONES,
  FACE_SHAPES, BONE_STRUCTURES, TARGETS,
  EYE_COLORS, EYE_SHAPES, EYEBROWS,
  HAIR_COLORS, HAIR_CUTS_F, HAIR_CUTS_M, FACIAL_HAIR,
  SKIN_FINISHES, DISTINCTIVE_FEATURES, TATTOOS, PIERCINGS, ASYMMETRIES,
  GAZES, MOUTHS,
  BODY_TYPES, HEAD_RATIOS, SHOULDERS, MUSCULATURES, LEG_LENGTHS, POSTURES, HANDS, CHEST_SIZES,
  buildFacePrompt, buildProfilePrompt, buildFullBodyPrompt,
  buildAnalysisPrompt, mergeAnalysis,
  randomSelection, defaultSelection,
  type FaceSelection, type FaceOption,
} from '@/lib/faceBuilder'

type Result = {
  id:           string
  faceUrl?:     string
  profileUrl?:  string
  fullBodyUrl?: string
  selection:    FaceSelection
  createdAt:    number
  error?:       string
}

export default function VisageTab() {
  const [sel, setSel] = useState<FaceSelection>(defaultSelection())
  const [ratio, setRatio]     = useState('3:4')
  const [quality, setQuality] = useState('2K')
  const [onlyFace, setOnlyFace] = useState(false)
  const [withFullBody, setWithFullBody] = useState(true)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError]     = useState<string | null>(null)
  const [results, setResults] = useState<Result[]>([])
  const [showPrompt, setShowPrompt] = useState(false)
  const [zipping, setZipping] = useState(false)

  // Analyse d'un visage de référence
  const [refImage, setRefImage]   = useState<File[]>([])
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzed, setAnalyzed]   = useState(false)

  const isMale = sel.gender === 'homme'
  const hairCuts = isMale ? HAIR_CUTS_M : HAIR_CUTS_F

  const set = <K extends keyof FaceSelection>(key: K, value: FaceSelection[K]) => {
    setSel(prev => {
      const next = { ...prev, [key]: value }
      // Si on change de genre, on remet une coupe valide
      if (key === 'gender') {
        const newCuts = value === 'homme' ? HAIR_CUTS_M : HAIR_CUTS_F
        if (!newCuts.find(c => c.id === next.hairCut)) next.hairCut = newCuts[0].id
      }
      return next
    })
  }

  const toggleMulti = (key: 'boneStructure' | 'distinctive', id: string) => {
    setSel(prev => {
      const cur = prev[key]
      return { ...prev, [key]: cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id] }
    })
  }

  const facePrompt = useMemo(() => buildFacePrompt(sel), [sel])

  /* ----------- Analyse d'un visage de référence ----------- */
  const analyzeReference = async () => {
    if (analyzing || refImage.length === 0) return
    setAnalyzing(true)
    setError(null)
    setAnalyzed(false)
    try {
      let img = refImage[0]
      try { img = await compressImage(img, { maxSide: 1400, quality: 0.85, maxBytes: 400_000 }) } catch { /* */ }

      const fd = new FormData()
      fd.append('image', img)
      fd.set('prompt', buildAnalysisPrompt())

      const resp = await fetch('/api/studio/visage-analyse', { method: 'POST', body: fd })
      const json = await resp.json()
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`)
      if (!json.analysis) throw new Error('Analyse vide.')

      setSel(prev => mergeAnalysis(prev, json.analysis))
      setAnalyzed(true)
    } catch (e: any) {
      setError(`Analyse : ${e?.message ?? e}`)
    } finally {
      setAnalyzing(false)
    }
  }

  /* ----------- Génération ----------- */
  const generate = async () => {
    if (running) return
    setRunning(true)
    setError(null)
    setProgress('Génération de la vue de face…')
    const id = `${Date.now()}`
    try {
      const resp = await fetch('/api/studio/visage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facePrompt,
          profilePrompt:  buildProfilePrompt(),
          fullBodyPrompt: buildFullBodyPrompt(sel),
          ratio, quality, onlyFace,
          withFullBody: withFullBody && !onlyFace,
        }),
      })
      const json = await resp.json()
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`)
      setResults(prev => [{
        id,
        faceUrl:     json.faceUrl,
        profileUrl:  json.profileUrl  ?? undefined,
        fullBodyUrl: json.fullBodyUrl ?? undefined,
        selection:   { ...sel },
        createdAt:   Date.now(),
        error:       json.profileError || json.fullBodyError,
      }, ...prev])
      setProgress('')
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setRunning(false)
      setProgress('')
    }
  }

  const randomize = () => setSel(randomSelection())
  const reset     = () => setSel(defaultSelection())

  /* ----------- Download ----------- */
  const forceDownload = async (url: string, filename: string) => {
    try {
      const resp = await fetch(url)
      const blob = await resp.blob()
      const objUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objUrl; a.download = filename
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(objUrl), 2000)
    } catch { window.open(url, '_blank', 'noopener,noreferrer') }
  }

  const downloadZip = async () => {
    const withImg = results.filter(r => r.faceUrl)
    if (!withImg.length) { setError('Aucun mannequin généré.'); return }
    setZipping(true)
    try {
      const zip = new JSZip()
      for (let i = 0; i < withImg.length; i++) {
        const r = withImg[i]
        const n = withImg.length - i   // le plus récent = numéro le plus haut
        const folder = `mannequin_${String(n).padStart(2, '0')}`
        if (r.faceUrl) {
          const b = await fetch(r.faceUrl).then(x => x.blob())
          zip.file(`${folder}/face.jpg`, b)
        }
        if (r.profileUrl) {
          const b = await fetch(r.profileUrl).then(x => x.blob())
          zip.file(`${folder}/profil.jpg`, b)
        }
        if (r.fullBodyUrl) {
          const b = await fetch(r.fullBodyUrl).then(x => x.blob())
          zip.file(`${folder}/plein-pied.jpg`, b)
        }
        // Fiche technique du mannequin (visage + corps)
        zip.file(`${folder}/fiche.txt`,
          buildFacePrompt(r.selection) + '\n\n\n===== SPÉCIFICATION CORPS =====\n\n' + buildFullBodyPrompt(r.selection))
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `mannequins_${Date.now()}.zip`; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (e: any) {
      setError(`ZIP : ${e?.message ?? e}`)
    } finally { setZipping(false) }
  }

  /* ----------- Styles ----------- */
  const card: React.CSSProperties = {
    border: '1px solid #E5E7EB', borderRadius: 12, padding: 16, background: '#fff',
    boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
  }
  const label: React.CSSProperties = {
    fontSize: 12, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em',
    fontWeight: 600, marginBottom: 8,
  }
  const fieldLabel: React.CSSProperties = { fontSize: 11, color: '#6B7280', marginBottom: 4, fontWeight: 500 }
  const inp: React.CSSProperties = {
    border: '1px solid #D1D5DB', borderRadius: 8, padding: '6px 10px',
    fontSize: 13, minHeight: 34, background: '#fff', width: '100%',
  }
  const btn = (bg: string, color: string = '#fff'): React.CSSProperties => ({
    background: bg, color, border: 'none', borderRadius: 8,
    padding: '9px 18px', fontWeight: 600, fontSize: 14, cursor: 'pointer',
  })
  const chip = (active: boolean): React.CSSProperties => ({
    padding: '4px 10px', borderRadius: 999, fontSize: 11, cursor: 'pointer',
    border: active ? '1.5px solid #0D4A5C' : '1px solid #E5E7EB',
    background: active ? '#E8F2F5' : '#fff',
    color: active ? '#0D4A5C' : '#6B7280',
    fontWeight: active ? 600 : 400,
    userSelect: 'none',
  })

  /** Rendu d'un select simple */
  const Sel = ({ title, options, value, onChange }: {
    title: string; options: FaceOption[]; value: string; onChange: (v: string) => void
  }) => (
    <div>
      <div style={fieldLabel}>{title}</div>
      <select value={value} onChange={e => onChange(e.target.value)} style={inp}>
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </div>
  )

  /** Rendu d'un multi-select en chips */
  const Chips = ({ title, options, values, onToggle }: {
    title: string; options: FaceOption[]; values: string[]; onToggle: (id: string) => void
  }) => (
    <div>
      <div style={fieldLabel}>{title} <span style={{ color: '#9CA3AF' }}>({values.length} sélectionné{values.length > 1 ? 's' : ''})</span></div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {options.map(o => (
          <span key={o.id} onClick={() => onToggle(o.id)} style={chip(values.includes(o.id))}>
            {o.label}
          </span>
        ))}
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 22 }}>🎭</span>
          <h2 style={{ margin: 0, color: '#0D4A5C', fontSize: 18 }}>
            Visage — Création de mannequins sur mesure
          </h2>
        </div>
        <p style={{ fontSize: 13, color: '#6B7280', margin: 0 }}>
          Configure tous les critères, puis génère un mannequin en <strong>2 vues cohérentes</strong> (face + profil, même session).
          Fond blanc studio, style casting polaroid. Utilise <strong>🎲 Aléatoire</strong> pour explorer rapidement.
        </p>
      </div>

      {/* ===== ANALYSE D'UN VISAGE DE RÉFÉRENCE ===== */}
      <div style={{ ...card, borderColor: '#7C3AED', borderWidth: 1.5 }}>
        <div style={{ ...label, color: '#7C3AED' }}>🔍 Optionnel — Partir d'un visage de référence</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 14, alignItems: 'start' }}>
          <Dropzone files={refImage} onChange={f => { setRefImage(f); setAnalyzed(false) }}
                    multiple={false} accept="image/*"
                    label="Visage de référence" hint="Portrait du mannequin dont tu veux t'inspirer" />
          <div>
            <button onClick={analyzeReference} disabled={analyzing || refImage.length === 0}
                    style={{ ...btn(analyzing || refImage.length === 0 ? '#9CA3AF' : '#7C3AED'),
                             cursor: analyzing || refImage.length === 0 ? 'not-allowed' : 'pointer' }}>
              {analyzing ? '⏳ Analyse en cours…' : '🔍 Analyser et pré-remplir'}
            </button>
            {analyzed && (
              <div style={{ marginTop: 8, fontSize: 12, color: '#059669', background: '#ECFDF5',
                            padding: 8, borderRadius: 6 }}>
                ✓ Critères pré-remplis. <strong>Vérifie et ajuste ci-dessous</strong> — le sous-ton, la structure
                osseuse et la cible casting sont les moins fiables à détecter.
              </div>
            )}
            <div style={{ marginTop: 8, fontSize: 11, color: '#6B7280', lineHeight: 1.5 }}>
              Gemini analyse la photo et remplit automatiquement les catégories.
              Fiable sur : genre, peau, yeux, cheveux, pilosité, piercings, taches de rousseur.
              Moins fiable sur : sous-ton (dépend de la lumière de la photo), structure osseuse, gamme/cible.
            </div>
          </div>
        </div>
      </div>

      {/* ===== IDENTITÉ ===== */}
      <div style={card}>
        <div style={label}>1 — Identité & positionnement</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <Sel title="Genre"      options={GENDERS}    value={sel.gender}   onChange={v => set('gender', v)} />
          <Sel title="Âge"        options={AGE_RANGES} value={sel.ageRange} onChange={v => set('ageRange', v)} />
          <Sel title="Gamme"      options={RANGES}     value={sel.range}    onChange={v => set('range', v)} />
          <Sel title="Cible casting" options={TARGETS} value={sel.target}   onChange={v => set('target', v)} />
        </div>
      </div>

      {/* ===== TEINT ===== */}
      <div style={card}>
        <div style={label}>2 — Teint & peau</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <Sel title="Sous-ton"      options={UNDERTONES}    value={sel.undertone}  onChange={v => set('undertone', v)} />
          <Sel title="Couleur de peau" options={SKIN_TONES}  value={sel.skinTone}   onChange={v => set('skinTone', v)} />
          <Sel title="Fini de peau"  options={SKIN_FINISHES} value={sel.skinFinish} onChange={v => set('skinFinish', v)} />
        </div>
      </div>

      {/* ===== VISAGE ===== */}
      <div style={card}>
        <div style={label}>3 — Structure du visage</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <Sel title="Forme du visage" options={FACE_SHAPES} value={sel.faceShape} onChange={v => set('faceShape', v)} />
          <Sel title="Asymétrie"       options={ASYMMETRIES} value={sel.asymmetry} onChange={v => set('asymmetry', v)} />
        </div>
        <Chips title="Structure osseuse (multi)" options={BONE_STRUCTURES}
               values={sel.boneStructure} onToggle={id => toggleMulti('boneStructure', id)} />
      </div>

      {/* ===== YEUX ===== */}
      <div style={card}>
        <div style={label}>4 — Yeux & sourcils</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <Sel title="Couleur des yeux" options={EYE_COLORS} value={sel.eyeColor} onChange={v => set('eyeColor', v)} />
          <Sel title="Forme des yeux"   options={EYE_SHAPES} value={sel.eyeShape} onChange={v => set('eyeShape', v)} />
          <Sel title="Sourcils"         options={EYEBROWS}   value={sel.eyebrows} onChange={v => set('eyebrows', v)} />
        </div>
      </div>

      {/* ===== CHEVEUX ===== */}
      <div style={card}>
        <div style={label}>5 — Cheveux</div>
        <div style={{ display: 'grid', gridTemplateColumns: isMale ? 'repeat(3, 1fr)' : 'repeat(2, 1fr)', gap: 12 }}>
          <Sel title="Couleur" options={HAIR_COLORS} value={sel.hairColor} onChange={v => set('hairColor', v)} />
          <Sel title="Coupe"   options={hairCuts}    value={sel.hairCut}   onChange={v => set('hairCut', v)} />
          {isMale && (
            <Sel title="Pilosité faciale" options={FACIAL_HAIR} value={sel.facialHair} onChange={v => set('facialHair', v)} />
          )}
        </div>
      </div>

      {/* ===== PARTICULARITÉS ===== */}
      <div style={card}>
        <div style={label}>6 — Particularités</div>
        <div style={{ marginBottom: 12 }}>
          <Chips title="Traits distinctifs (multi)" options={DISTINCTIVE_FEATURES}
                 values={sel.distinctive} onToggle={id => toggleMulti('distinctive', id)} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Sel title="Tatouages" options={TATTOOS}   value={sel.tattoo}   onChange={v => set('tattoo', v)} />
          <Sel title="Piercings" options={PIERCINGS} value={sel.piercing} onChange={v => set('piercing', v)} />
        </div>
      </div>

      {/* ===== EXPRESSION ===== */}
      <div style={card}>
        <div style={label}>7 — Expression & regard</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <Sel title="Regard" options={GAZES}  value={sel.gaze}  onChange={v => set('gaze', v)} />
          <Sel title="Bouche" options={MOUTHS} value={sel.mouth} onChange={v => set('mouth', v)} />
        </div>
        <div>
          <div style={fieldLabel}>Notes libres (optionnel)</div>
          <textarea value={sel.extraNotes} onChange={e => set('extraNotes', e.target.value)}
                    placeholder="ex : cicatrice à l'arcade gauche, look scandinave, cheveux légèrement décoiffés…"
                    style={{ ...inp, minHeight: 60, fontFamily: 'inherit' }} />
        </div>
      </div>

      {/* ===== CORPS ===== */}
      <div style={card}>
        <div style={label}>
          8 — Corps & morphologie
          <span style={{ marginLeft: 8, fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: '#9CA3AF' }}>
            (utilisé pour la vue plein-pied)
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
          <Sel title="Morphologie"        options={BODY_TYPES}    value={sel.bodyType}    onChange={v => set('bodyType', v)} />
          <Sel title="Proportions (têtes)" options={HEAD_RATIOS}  value={sel.headRatio}   onChange={v => set('headRatio', v)} />
          <Sel title="Longueur de jambes" options={LEG_LENGTHS}   value={sel.legLength}   onChange={v => set('legLength', v)} />
          <Sel title="Carrure"            options={SHOULDERS}     value={sel.shoulders}   onChange={v => set('shoulders', v)} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: isMale ? 'repeat(3, 1fr)' : 'repeat(4, 1fr)', gap: 12 }}>
          <Sel title="Musculature" options={MUSCULATURES} value={sel.musculature} onChange={v => set('musculature', v)} />
          <Sel title="Posture"     options={POSTURES}     value={sel.posture}     onChange={v => set('posture', v)} />
          <Sel title="Mains"       options={HANDS}        value={sel.hands}       onChange={v => set('hands', v)} />
          {!isMale && (
            <Sel title="Poitrine" options={CHEST_SIZES} value={sel.chestSize} onChange={v => set('chestSize', v)} />
          )}
        </div>
      </div>

      {/* ===== PARAMÈTRES + ACTIONS ===== */}
      <div style={card}>
        <div style={label}>9 — Sortie</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 14 }}>
          <div>
            <div style={fieldLabel}>Ratio</div>
            <select value={ratio} onChange={e => setRatio(e.target.value)} style={inp}>
              <option value="3:4">3:4 (portrait casting)</option>
              <option value="4:5">4:5 (Insta feed)</option>
              <option value="1:1">1:1 (carré)</option>
              <option value="2:3">2:3</option>
              <option value="9:16">9:16</option>
            </select>
          </div>
          <div>
            <div style={fieldLabel}>Qualité</div>
            <select value={quality} onChange={e => setQuality(e.target.value)} style={inp}>
              <option value="1K">1K (rapide)</option>
              <option value="2K">2K (équilibré)</option>
              <option value="4K">4K (max)</option>
            </select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#374151', cursor: 'pointer' }}>
              <input type="checkbox" checked={onlyFace} onChange={e => setOnlyFace(e.target.checked)} />
              Face uniquement
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
                            color: onlyFace ? '#9CA3AF' : '#374151',
                            cursor: onlyFace ? 'not-allowed' : 'pointer' }}>
              <input type="checkbox" checked={withFullBody && !onlyFace} disabled={onlyFace}
                     onChange={e => setWithFullBody(e.target.checked)} />
              + vue plein-pied
            </label>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={generate} disabled={running}
                  style={{ ...btn(running ? '#9CA3AF' : '#0D4A5C'), cursor: running ? 'not-allowed' : 'pointer' }}>
            {running ? `⏳ ${progress || 'Génération…'}` : '🎭 Générer le mannequin'}
          </button>
          <button onClick={randomize} disabled={running} style={btn('#7C3AED')}>🎲 Aléatoire</button>
          <button onClick={reset}     disabled={running} style={btn('#E5E7EB', '#374151')}>↺ Réinitialiser</button>
          <button onClick={() => setShowPrompt(s => !s)} style={btn('#E5E7EB', '#374151')}>
            {showPrompt ? '▲ Masquer le prompt' : '▼ Voir le prompt'}
          </button>
          {results.length > 0 && (
            <button onClick={downloadZip} disabled={zipping}
                    style={{ ...btn(zipping ? '#9CA3AF' : '#10B981'), marginLeft: 'auto' }}>
              {zipping ? '⏳ ZIP…' : `📦 ZIP (${results.length})`}
            </button>
          )}
        </div>

        {showPrompt && (
          <pre style={{ marginTop: 12, fontSize: 10, background: '#F9FAFB', padding: 10,
                        borderRadius: 6, overflow: 'auto', maxHeight: 280, whiteSpace: 'pre-wrap' }}>
            {facePrompt}
          </pre>
        )}
      </div>

      {/* ===== RÉSULTATS ===== */}
      {results.length > 0 && (
        <div style={card}>
          <div style={label}>Mannequins générés ({results.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {results.map((r, i) => {
              const num = results.length - i
              const s = r.selection
              const gLabel = GENDERS.find(o => o.id === s.gender)?.label ?? ''
              const tLabel = TARGETS.find(o => o.id === s.target)?.label ?? ''
              const aLabel = AGE_RANGES.find(o => o.id === s.ageRange)?.label ?? ''
              return (
                <div key={r.id} style={{ border: '1px solid #E5E7EB', borderRadius: 10, padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#0D4A5C' }}>Mannequin #{num}</span>
                    <span style={{ fontSize: 11, color: '#6B7280' }}>{gLabel} · {aLabel} · {tLabel}</span>
                    {r.error && <span style={{ fontSize: 10, color: '#EF4444' }}>⚠ profil : {r.error.slice(0, 60)}</span>}
                  </div>
                  <div style={{ display: 'grid',
                                gridTemplateColumns: r.fullBodyUrl ? '1fr 1fr 1fr' : '1fr 1fr',
                                gap: 10, maxWidth: r.fullBodyUrl ? 880 : 620 }}>
                    {[
                      { url: r.faceUrl,     title: 'Face',       file: `mannequin_${num}_face.jpg` },
                      { url: r.profileUrl,  title: 'Profil',     file: `mannequin_${num}_profil.jpg` },
                      ...(r.fullBodyUrl ? [{ url: r.fullBodyUrl, title: 'Plein-pied', file: `mannequin_${num}_plein-pied.jpg` }] : []),
                    ].map((v, vi) => (
                      <div key={vi}>
                        <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4, fontWeight: 600 }}>{v.title}</div>
                        <div style={{ aspectRatio: v.title === 'Plein-pied' ? '9/16' : '3/4',
                                      background: '#F3F4F6', borderRadius: 6, overflow: 'hidden',
                                      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {v.url
                            ? <a href={v.url} target="_blank" rel="noreferrer" style={{ display: 'block', width: '100%', height: '100%' }}>
                                <img src={v.url} alt={v.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                              </a>
                            : <span style={{ fontSize: 11, color: '#9CA3AF' }}>—</span>}
                        </div>
                        {v.url && (
                          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                            <button onClick={() => forceDownload(v.url!, v.file)}
                                    style={{ ...btn('#0D4A5C'), padding: '3px 10px', fontSize: 11 }}>⬇</button>
                            <a href={v.url} target="_blank" rel="noreferrer"
                               style={{ ...btn('#E5E7EB', '#374151'), padding: '3px 10px', fontSize: 11, textDecoration: 'none' }}>↗</a>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ fontSize: 11, color: '#6B7280', cursor: 'pointer' }}>Fiche technique</summary>
                    <pre style={{ fontSize: 9, background: '#F9FAFB', padding: 8, borderRadius: 6,
                                  overflow: 'auto', maxHeight: 200, whiteSpace: 'pre-wrap', marginTop: 4 }}>
                      {buildFacePrompt(r.selection)}
                    </pre>
                  </details>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {error && (
        <div style={{ ...card, background: '#FEF2F2', color: '#991B1B' }}>❌ {error}</div>
      )}
    </div>
  )
}
