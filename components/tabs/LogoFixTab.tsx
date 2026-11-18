'use client'
/**
 * Onglet 🏷 Logo — Logo Fix, option C hybride (spec zulo_logo_fix_spec.json v1.0).
 * La forme du logo vient TOUJOURS du fichier fourni (collage déterministe) ; l'IA (OpenAI images/edits + masque)
 * ne sert qu'à la matière et à la lumière, sur un recadrage agrandi ; seule une ellipse autour du logo est recollée.
 */
import { useEffect, useRef, useState } from 'react'
import { upload } from '@vercel/blob/client'
import Dropzone from '@/components/ui/Dropzone'
import {
  buildLogoPrompt, canvasBlob, collerLogo, cropResize, effacerAncienLogo, expandBox, fileToImg, harmoniser, IA_H, IA_W,
  imgToCanvas, localiserLogo, masqueIA, preparerLogo, qa, RENDUS, zoneRecadrage,
  type Box, type Img, type Placed, type PreparedLogo, type QA, type Rendu,
} from '@/lib/logoFix'

type Variant = { img: Img; qa: QA; url: string }
type Result = {
  bbox: Box; hintUsed: boolean; A: Img; qaA: QA; placed: Placed; crop?: Box
  variants: Variant[]; chosen: number | 'A'; started: number; duree: number; cost: number; note?: string
}

const BADGE: Record<QA['statut'], [string, string]> = { ok: ['#DCFCE7', '#166534'], a_verifier: ['#FEF3C7', '#92400E'], rejet: ['#FEE2E2', '#991B1B'] }
const LABEL: Record<QA['statut'], string> = { ok: 'OK', a_verifier: 'À vérifier', rejet: 'Rejet' }

/** Affiche une zone d'une image, agrandie (pixels nets). */
function View({ img, box, zoom, title }: { img: Img; box: Box; zoom: number; title: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current; if (!c) return
    c.width = box.w; c.height = box.h
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.d), img.w, img.h), -box.x, -box.y, box.x, box.y, box.w, box.h)
  }, [img, box])
  return (
    <div>
      <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 2 }}>{title}</div>
      <canvas ref={ref} style={{ width: box.w * zoom, maxWidth: '100%', imageRendering: zoom > 1 ? 'pixelated' : 'auto', borderRadius: 4, background: '#F3F4F6' }} />
    </div>
  )
}

export default function LogoFixTab() {
  const [srcFiles, setSrcFiles] = useState<File[]>([])
  const [logoFiles, setLogoFiles] = useState<File[]>([])
  const [src, setSrc] = useState<Img | null>(null)
  const [srcName, setSrcName] = useState('visuel')
  const [srcType, setSrcType] = useState('image/jpeg')
  const [hint, setHint] = useState<Box | null>(null)
  const [exact, setExact] = useState(false)
  const [rendu, setRendu] = useState<Rendu>('broderie')
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>('high')
  const [n, setN] = useState(1)
  const [vetement, setVetement] = useState('')
  const [texte, setTexte] = useState('')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [res, setRes] = useState<Result | null>(null)
  const logoRef = useRef<{ file: File; prepared: PreparedLogo; png: Blob; url?: string } | null>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)

  /* ----------- chargement ----------- */
  const loadSource = async (files: File[]) => {
    setSrcFiles(files); setRes(null); setHint(null); setError(null)
    if (!files[0]) { setSrc(null); return }
    try {
      setSrc(await fileToImg(files[0]))
      setSrcName(files[0].name.replace(/\.[^.]+$/, ''))
      setSrcType(/png/i.test(files[0].type) ? 'image/png' : /webp/i.test(files[0].type) ? 'image/webp' : 'image/jpeg')
    } catch (e: any) { setError(`Visuel : ${e?.message ?? e}`) }
  }
  const loadLogo = async (files: File[]) => {
    setLogoFiles(files); logoRef.current = null; setError(null)
    if (!files[0]) return
    try {
      const im = await fileToImg(files[0], { svgWidth: 2000, maxSide: 1200 })
      const prepared = preparerLogo(im)
      logoRef.current = { file: files[0], prepared, png: await canvasBlob(imgToCanvas(im)) }
      setStep(`Logo : ${prepared.colors.length} couleur(s) détectée(s), ${prepared.w}×${prepared.h} px`)
    } catch (e: any) { setError(`Logo : ${e?.message ?? e}`) }
  }

  /* ----------- aperçu + rectangle ----------- */
  useEffect(() => {
    const c = previewRef.current
    if (!c || !src) return
    const base = imgToCanvas(src)
    c.width = src.w; c.height = src.h
    const ctx = c.getContext('2d')!
    ctx.drawImage(base, 0, 0)
    const lw = Math.max(2, src.w / 400)
    if (hint) { ctx.strokeStyle = '#22D3EE'; ctx.lineWidth = lw; ctx.setLineDash([lw * 3, lw * 2]); ctx.strokeRect(hint.x, hint.y, hint.w, hint.h); ctx.setLineDash([]) }
    if (res) { ctx.strokeStyle = '#F43F5E'; ctx.lineWidth = lw; ctx.strokeRect(res.bbox.x, res.bbox.y, res.bbox.w, res.bbox.h) }
  }, [src, hint, res])
  const toImg = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: Math.round(((e.clientX - r.left) / r.width) * (src?.w ?? 1)), y: Math.round(((e.clientY - r.top) / r.height) * (src?.h ?? 1)) }
  }
  const onDown = (e: React.MouseEvent<HTMLCanvasElement>) => { drag.current = toImg(e) }
  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drag.current) return
    const p = toImg(e), a = drag.current
    setHint({ x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) })
  }
  const onUp = () => { drag.current = null; setHint(h => (h && h.w > 3 && h.h > 3 ? h : null)) }

  /* ----------- upload ----------- */
  const up = async (b: Blob, name: string) => (await upload(`logo-fix-inputs/${Date.now()}-${name}`, b, { access: 'public', handleUploadUrl: '/api/blob-upload', contentType: b.type || 'image/png' })).url

  /* ----------- passe IA (étapes 5 à 8) ----------- */
  const passeIA = async (base: { src: Img; bbox: Box; A: Img; placed: Placed }, logo: NonNullable<typeof logoRef.current>) => {
    const crop = zoneRecadrage(base.bbox, base.src.w, base.src.h)
    setStep('Recadrage agrandi + masque…')
    const cropImg = cropResize(base.A, crop, IA_W, IA_H)
    const [cropUrl, maskUrl, logoUrl] = await Promise.all([
      canvasBlob(imgToCanvas(cropImg)).then(b => up(b, 'crop.png')),
      canvasBlob(imgToCanvas(masqueIA(base.bbox, crop))).then(b => up(b, 'mask.png')),
      logo.url ? Promise.resolve(logo.url) : up(logo.png, 'logo.png').then(u => (logo.url = u)),
    ])
    setStep(`Passe IA (OpenAI, qualité ${quality}, ${n} variante${n > 1 ? 's' : ''})…`)
    const r = await fetch('/api/studio/logo-fix', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cropUrl, maskUrl, logoUrl, quality, n, prompt: buildLogoPrompt({ rendu: rendu as keyof typeof RENDUS, vetement, texte }) }),
    })
    const text = await r.text()
    let j: any
    try { j = JSON.parse(text) } catch { throw new Error(`HTTP ${r.status} : ${text.replace(/<[^>]+>/g, ' ').trim().slice(0, 160)}`) }
    if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { kind: j.kind })
    setStep('Harmonisation + recollage + QA…')
    const variants: Variant[] = []
    for (const url of j.images as string[]) {
      const iaFull = await fileToImg(await fetch(url).then(x => x.blob()))
      const iaSmall = cropResize(iaFull, { x: 0, y: 0, w: iaFull.w, h: iaFull.h }, crop.w, crop.h)
      const img = harmoniser(base.A, base.src, iaSmall, crop, base.placed)
      variants.push({ img, url, qa: qa(img, base.bbox, logo.prepared, base.placed.colors) })
    }
    return { crop, variants, cost: typeof j.cost === 'number' ? j.cost : 0 }
  }

  const run = async (opts?: { onlyIA?: boolean }) => {
    const logo = logoRef.current
    if (!src || !logo) return
    setBusy(true); setError(null)
    const started = Date.now()
    try {
      let base: Result
      if (opts?.onlyIA && res) {
        base = { ...res, variants: [], chosen: 'A', started, cost: res.cost, note: undefined }
      } else {
        setStep('Localisation du logo…')
        const bbox = exact && hint ? hint : localiserLogo(src, logo.prepared, hint ?? undefined)
        if (!bbox) throw new Error('Logo introuvable : dessine la zone du logo sur l’aperçu (cliquer-glisser), puis relance.')
        setStep('Effacement de l’ancien logo…')
        const e = effacerAncienLogo(src, bbox, logo.prepared)
        setStep('Collage du vrai logo (option A)…')
        const A = collerLogo(e.clean, bbox, logo.prepared, e.measured)
        base = { bbox, hintUsed: !!hint, A: A.image, placed: A.placed, qaA: qa(A.image, bbox, logo.prepared, A.placed.colors), variants: [], chosen: 'A', started, duree: 0, cost: 0 }
      }
      if (rendu === 'aucun' || base.bbox.w < 20) {
        setRes({ ...base, duree: (Date.now() - started) / 1000, note: base.bbox.w < 20 && rendu !== 'aucun' ? 'Logo de moins de 20 px : option A seule (l’IA n’apporte rien à cette taille).' : undefined })
        return
      }
      const prev = opts?.onlyIA && res ? res.variants : []
      let all: Variant[] = [], cost = base.cost, crop: Box | undefined, note: string | undefined
      for (let attempt = 0; attempt < 3; attempt++) { // 1 passe + 2 relances max si rejet
        try {
          const p = await passeIA({ src, bbox: base.bbox, A: base.A, placed: base.placed }, logo)
          all = [...all, ...p.variants]; cost += p.cost; crop = p.crop
        } catch (e: any) {
          if (e?.kind === 'moderation' || e?.kind === 'quota' || attempt > 0 || all.length) { note = `${e?.message ?? e} — version sans IA (option A) proposée.`; break }
          throw e
        }
        if (all.some(v => v.qa.statut !== 'rejet')) break
        if (attempt < 2) setStep(`QA en rejet (IoU ${Math.max(...all.map(v => v.qa.score)).toFixed(2)}) : relance ${attempt + 1}/2…`)
        else note = 'La passe IA reste en rejet après 2 relances : garde la version sans IA (option A).'
      }
      all = [...prev, ...all]
      const bestIdx = all.length ? all.reduce((b, v, i) => (v.qa.score > all[b].qa.score ? i : b), 0) : -1
      const chosen: number | 'A' = bestIdx >= 0 && all[bestIdx].qa.statut !== 'rejet' ? bestIdx : 'A'
      setRes({ ...base, crop, variants: all, chosen, cost, note, duree: (Date.now() - started) / 1000 })
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally { setBusy(false); setStep('') }
  }

  /* ----------- sorties ----------- */
  const ext = srcType === 'image/png' ? 'png' : srcType === 'image/webp' ? 'webp' : 'jpg'
  const save = (b: Blob, name: string) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000) }
  const finalImg = res ? (res.chosen === 'A' ? res.A : res.variants[res.chosen].img) : null
  const finalQA = res ? (res.chosen === 'A' ? res.qaA : res.variants[res.chosen].qa) : null
  const zoomBox = res && src ? expandBox(res.bbox, Math.max(res.bbox.w, res.bbox.h) * 0.5, src.w, src.h) : null
  const realBox = res && src ? (res.crop ?? expandBox(res.bbox, res.bbox.w * 1.5, src.w, src.h)) : null
  const downloadAll = async () => {
    if (!res || !src || !finalImg || !zoomBox) return
    const q = srcType === 'image/png' ? undefined : 0.95
    save(await canvasBlob(imgToCanvas(finalImg), srcType, q), `${srcName}_logo_fixed.${ext}`)
    save(await canvasBlob(imgToCanvas(res.A), srcType, q), `${srcName}_logo_A.${ext}`)
    // planche zoom ×6 avant / après
    const z = 6, c = document.createElement('canvas')
    c.width = zoomBox.w * z * 2 + 12; c.height = zoomBox.h * z
    const ctx = c.getContext('2d')!; ctx.imageSmoothingEnabled = false
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(imgToCanvas(src), zoomBox.x, zoomBox.y, zoomBox.w, zoomBox.h, 0, 0, zoomBox.w * z, zoomBox.h * z)
    ctx.drawImage(imgToCanvas(finalImg), zoomBox.x, zoomBox.y, zoomBox.w, zoomBox.h, zoomBox.w * z + 12, 0, zoomBox.w * z, zoomBox.h * z)
    save(await canvasBlob(c), `${srcName}_logo_compare.png`)
    const meta = {
      bbox_logo: res.bbox, zone_hint_utilisee: res.hintUsed, modele_ia: res.variants.length ? 'OpenAI images/edits' : 'aucun (option A)',
      qualite: res.variants.length ? quality : 'n/a', rendu, score_qa: Number(finalQA!.score.toFixed(3)), statut: finalQA!.statut,
      version: res.chosen === 'A' ? 'A' : `IA ${res.chosen + 1}`, duree_s: Number(res.duree.toFixed(1)), cout_usd: Number(res.cost.toFixed(4)),
    }
    save(new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' }), `${srcName}_logo_meta.json`)
  }
  const continueOnResult = () => { if (finalImg) { setSrc(finalImg); setRes(null); setHint(null) } }

  /* ----------- rendu ----------- */
  const box: React.CSSProperties = { background: '#fff', borderRadius: 12, padding: 16, marginBottom: 16, border: '1px solid rgba(13,74,92,0.1)' }
  const inp: React.CSSProperties = { padding: '6px 8px', borderRadius: 6, border: '1px solid #D1D5DB', fontSize: 13 }
  const btn = (bg: string): React.CSSProperties => ({ background: bg, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' })
  const small: React.CSSProperties = { ...inp, cursor: 'pointer', background: '#fff', fontSize: 12 }
  const Badge = ({ q }: { q: QA }) => <span style={{ background: BADGE[q.statut][0], color: BADGE[q.statut][1], borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 600 }}>{LABEL[q.statut]} · IoU {q.score.toFixed(2)}</span>

  return (
    <div style={{ maxWidth: 1200 }}>
      <h2 style={{ margin: '0 0 4px', color: '#0D4A5C' }}>🏷 Logo</h2>
      <p style={{ fontSize: 13, color: '#6B7280', margin: '0 0 16px' }}>
        Corrige un logo déformé sur un visuel généré : l&apos;ancien logo est effacé, le <strong>vrai logo est collé</strong> (sa forme vient toujours du fichier fourni),
        puis l&apos;IA (OpenAI, avec masque) ne fait que la <strong>matière et la lumière</strong> (broderie, impression…) sur un recadrage agrandi. Seule une ellipse autour du logo est recollée ; le reste de l&apos;image ne bouge pas.
        Score de fidélité : IoU par couleur (OK ≥ 0,80, à vérifier ≥ 0,65, sinon relance automatique ×2 puis option A).
      </p>

      <div style={{ ...box, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Dropzone files={srcFiles} onChange={loadSource} accept="image/jpeg,image/png,image/webp" label="Visuel source" hint="JPG, PNG, WEBP" minHeight={90} />
        <Dropzone files={logoFiles} onChange={loadLogo} accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg" label="Logo HD" hint="Packshot zoomé — PNG transparent ou SVG idéal" minHeight={90} />
      </div>

      {src && (
        <div style={box}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
            <div><div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Rendu</div>
              <select value={rendu} onChange={e => setRendu(e.target.value as Rendu)} style={inp} disabled={busy}>
                <option value="broderie">Broderie</option><option value="impression">Impression</option>
                <option value="transfert/flex">Transfert / flex</option><option value="aucun">Aucun (collage seul = option A)</option>
              </select></div>
            <div><div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Qualité IA</div>
              <select value={quality} onChange={e => setQuality(e.target.value as any)} style={inp} disabled={busy || rendu === 'aucun'}>
                <option value="high">high</option><option value="medium">medium</option><option value="low">low</option>
              </select></div>
            <div><div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Variantes</div>
              <select value={n} onChange={e => setN(Number(e.target.value))} style={inp} disabled={busy || rendu === 'aucun'}>
                {[1, 2, 3, 4].map(k => <option key={k} value={k}>{k}</option>)}
              </select></div>
            <div><div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Vêtement (optionnel)</div>
              <input value={vetement} onChange={e => setVetement(e.target.value)} placeholder="black zip sweatshirt" style={{ ...inp, width: 170 }} disabled={busy} /></div>
            <div><div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Texte du logo (optionnel)</div>
              <input value={texte} onChange={e => setTexte(e.target.value)} placeholder="AKAMMAK" style={{ ...inp, width: 130 }} disabled={busy} /></div>
            <div style={{ flex: 1 }} />
            <button onClick={() => run()} style={btn('#0D4A5C')} disabled={busy || !logoRef.current}>{busy ? '⏳ …' : '▶ Corriger le logo'}</button>
          </div>
          <div style={{ fontSize: 12, color: '#374151', marginBottom: 6 }}>
            Zone du logo (optionnel) : <strong>cliquer-glisser</strong> sur l&apos;aperçu pour limiter la recherche.
            {hint && <> {hint.w}×{hint.h} px <label style={{ marginLeft: 8 }}><input type="checkbox" checked={exact} onChange={e => setExact(e.target.checked)} /> la zone dessinée = position exacte du logo</label>
              <button onClick={() => setHint(null)} style={{ ...small, marginLeft: 8, padding: '2px 6px' }}>✕ zone</button></>}
            {!logoRef.current && <span style={{ color: '#92400E' }}> · ajoute le logo HD</span>}
          </div>
          <canvas ref={previewRef} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
                  style={{ width: '100%', maxWidth: 700, cursor: 'crosshair', borderRadius: 6, display: 'block' }} />
          {(step || error) && <div style={{ marginTop: 8, fontSize: 13, color: error ? '#991B1B' : '#0D4A5C' }}>{error ? `⚠ ${error}` : `⏳ ${step}`}</div>}
          <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 6 }}>Logo vu de biais ou sur un pli marqué : la correction de perspective (4 coins) n&apos;est pas encore disponible — dessine une zone serrée et coche « position exacte ». Plusieurs logos : corrige-en un, puis « Continuer sur ce résultat ».</div>
        </div>
      )}

      {res && src && finalImg && finalQA && zoomBox && realBox && (
        <div style={box}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
            <strong style={{ color: '#0D4A5C' }}>Résultat — {res.chosen === 'A' ? 'option A (sans IA)' : `variante IA ${res.chosen + 1}`}</strong>
            <Badge q={finalQA} />
            <span style={{ fontSize: 12, color: '#6B7280' }}>logo {res.bbox.w}×{res.bbox.h} px à ({res.bbox.x}, {res.bbox.y}) · {res.duree.toFixed(1)} s{res.cost ? ` · ${res.cost.toFixed(3)} $` : ''}</span>
          </div>
          {res.note && <div style={{ fontSize: 12, color: '#92400E', marginBottom: 8 }}>⚠ {res.note}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <View img={src} box={zoomBox} zoom={6} title="Avant — zoom ×6" />
            <View img={finalImg} box={zoomBox} zoom={6} title="Après — zoom ×6" />
            <View img={src} box={realBox} zoom={1} title="Avant — taille réelle" />
            <View img={finalImg} box={realBox} zoom={1} title="Après — taille réelle" />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#6B7280' }}>Versions :</span>
            <button onClick={() => setRes({ ...res, chosen: 'A' })} style={{ ...small, outline: res.chosen === 'A' ? '2px solid #0D4A5C' : 'none' }}>A (sans IA) · {res.qaA.score.toFixed(2)}</button>
            {res.variants.map((v, i) => (
              <button key={v.url} onClick={() => setRes({ ...res, chosen: i })} style={{ ...small, outline: res.chosen === i ? '2px solid #0D4A5C' : 'none', color: BADGE[v.qa.statut][1] }}>IA {i + 1} · {v.qa.score.toFixed(2)}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <button onClick={downloadAll} style={btn('#0D4A5C')}>⬇ Télécharger (final + A + planche + JSON)</button>
            <button onClick={() => run({ onlyIA: true })} style={small} disabled={busy || rendu === 'aucun'}>↻ Relancer la passe IA</button>
            <button onClick={() => { setHint(res.bbox); setExact(true); setRes(null) }} style={small} disabled={busy}>✎ Ajuster la zone</button>
            <button onClick={() => setRes({ ...res, chosen: 'A' })} style={small}>Garder la version sans IA (option A)</button>
            <button onClick={continueOnResult} style={small} disabled={busy}>→ Continuer sur ce résultat (autre logo)</button>
          </div>
        </div>
      )}
    </div>
  )
}
