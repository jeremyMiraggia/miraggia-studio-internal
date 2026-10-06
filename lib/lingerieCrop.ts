/**
 * Recadrage des visuels Lingerie générés en cadrage LARGE (pose dynamique / pose libre).
 *
 * Pourquoi : demander à Gemini de cadrer lui-même « de la bouche aux cuisses » le pousse à composer
 * un buste centré, de face, debout → poses figées. On génère donc plus large (tête comprise, jusqu'aux
 * genoux ou aux pieds) avec la pose voulue, puis on recadre ici selon le type :
 *   ensemble : bouche → haut des cuisses     pyjama : bouche → bas de l'image (pieds)
 *   haut     : bouche → ventre (nombril)     bas    : ventre → haut des cuisses
 * Le visage n'apparaît jamais dans le visuel final.
 *
 * 1. Gemini Flash localise (0-1000) : bas du nez, bouche, nombril, bas de la culotte, boîte de la personne.
 * 2. Bords haut/bas selon le type, puis largeur au ratio demandé, centrée sur la personne.
 */
import sharp from 'sharp'

// Testé (oct. 2026) : gemini-2.5-flash se trompe sur le visage ; 3-flash et 3.1-pro donnent des boîtes précises et concordantes.
const LOCATE_MODELS = ['gemini-3-flash-preview', 'gemini-3.1-pro-preview']

export type CropType = 'ensemble' | 'pyjama' | 'haut' | 'bas'
export type BodyLandmarks = {
  noseBottomY: number; mouthY: number; navelY: number; briefsTopY: number; briefsBottomY: number
  personXMin: number; personXMax: number; model?: string
}

type Box2D = { ymin: number; xmin: number; ymax: number; xmax: number }   // 0..1

/**
 * Détection au format NATIF de Gemini (liste de boîtes `box_2d` [ymin, xmin, ymax, xmax] en 0-1000) :
 * nettement plus fiable que de demander des coordonnées ponctuelles.
 */
export async function locateLandmarks(buf: Buffer, mime: string, apiKey: string): Promise<BodyLandmarks> {
  const prompt = [
    'Detect the following items in this fashion photo of one woman (standing, seated or kneeling).',
    'Return a JSON list of objects {"label": string, "box_2d": [ymin, xmin, ymax, xmax]} with coordinates normalized to 0-1000.',
    'Labels (use exactly these): "face" (forehead to chin), "lips", "navel", "briefs" (the underwear bottom / pants bottom garment), "person" (the whole woman including hair, arms and legs).',
    'Omit an item only if it is not visible.',
  ].join('\n')
  const payload = JSON.stringify({
    contents: [{ parts: [{ inlineData: { mimeType: mime, data: buf.toString('base64') } }, { text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  })
  let lastErr = ''
  for (const model of LOCATE_MODELS) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
    }).catch(e => { lastErr = `${model}: ${e?.message ?? e}`; return null })
    if (!res) continue
    const json: any = await res.json().catch(() => null)
    if (!res.ok) {
      lastErr = `${model}: ${json?.error?.message ?? `HTTP ${res.status}`}`
      continue   // modèle indisponible / quota → modèle suivant
    }
    try {
      const text = (json?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('').trim()
      const list = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
      const boxes = new Map<string, Box2D>()
      for (const it of Array.isArray(list) ? list : []) {
        const b = it?.box_2d, label = String(it?.label ?? '').toLowerCase().trim()
        if (!Array.isArray(b) || b.length !== 4 || boxes.has(label)) continue
        const [ymin, xmin, ymax, xmax] = b.map((v: any) => Math.max(0, Math.min(1000, Number(v))) / 1000)
        if (ymax > ymin && xmax > xmin) boxes.set(label, { ymin, xmin, ymax, xmax })
      }
      const face = boxes.get('face'), lips = boxes.get('lips'), navel = boxes.get('navel'), briefs = boxes.get('briefs'), person = boxes.get('person')
      if (!face) throw new Error('visage non détecté')
      if (!briefs) throw new Error('culotte / bas non détecté')

      // Bouche : haut des lèvres (léger retrait) ; garde-fou : jamais au-dessus de 60 % du visage → nez et yeux toujours coupés
      const faceH = face.ymax - face.ymin
      const lipsTop = lips && lips.ymin > face.ymin && lips.ymax <= face.ymax + 0.02 ? lips.ymin - 0.2 * (lips.ymax - lips.ymin) : face.ymin + 0.68 * faceH
      const mouthY = Math.max(lipsTop, face.ymin + 0.6 * faceH)
      // Nombril : centre de sa boîte, sinon un peu au-dessus de la ceinture de la culotte
      const navelY = navel ? (navel.ymin + navel.ymax) / 2 : briefs.ymin - 0.04
      const lm: BodyLandmarks = {
        noseBottomY: mouthY, mouthY, navelY, briefsTopY: briefs.ymin, briefsBottomY: briefs.ymax,
        personXMin: person?.xmin ?? 0, personXMax: person?.xmax ?? 1, model,
      }
      if (!(lm.mouthY < lm.navelY && lm.navelY < lm.briefsBottomY)) {
        throw new Error(`repères incohérents (bouche ${lm.mouthY.toFixed(2)}, nombril ${lm.navelY.toFixed(2)}, culotte ${lm.briefsBottomY.toFixed(2)})`)
      }
      return lm
    } catch (e: any) {
      lastErr = `${model}: ${e?.message ?? e}`
    }
  }
  throw new Error(`Repères du corps non localisés : ${lastErr || 'détection impossible'}`)
}

/** Recadre selon le type (bords haut/bas), puis au ratio voulu, centré sur la personne. */
export async function cropForType(buf: Buffer, type: CropType, ratio: string, lm: BodyLandmarks) {
  const img = sharp(buf).rotate()
  const meta = await img.metadata()
  const W = meta.width ?? 0, H = meta.height ?? 0
  if (!W || !H) throw new Error('image illisible')
  const [a, b] = ratio.split(':').map(Number)
  const r = a > 0 && b > 0 ? a / b : 3 / 4

  const mouthTop = lm.mouthY                                                // juste au-dessus des lèvres (cf. locateLandmarks)
  // Échelle du corps = distance bouche → nombril (stable, même avec une culotte taille basse)
  const s = lm.navelY - lm.mouthY
  const thighs = Math.min(1, lm.briefsBottomY + 0.14 * s)                  // « haut des cuisses »
  const [y0, y1] = {
    ensemble: [mouthTop, thighs],
    pyjama:   [mouthTop, 1],
    // haut : la culotte neutre (hors produit) ne doit jamais apparaître → on s'arrête juste au-dessus de sa ceinture
    haut:     [mouthTop, Math.min(1, lm.navelY + 0.06 * s, lm.briefsTopY - 0.01)],
    bas:      [Math.max(0, lm.navelY - 0.12 * s), thighs],
  }[type]

  let top = Math.round(y0 * H)
  let outH = Math.round(y1 * H) - top
  let outW = Math.round(outH * r)
  if (outW > W) {   // trop étroit : on garde toute la largeur et on réduit la hauteur autour du centre
    outW = W
    const h = Math.round(W / r)
    top = Math.min(H - h, Math.max(0, Math.round(top + (outH - h) / 2)))
    outH = h
  }

  // Centré sur la personne, sans sortir de l'image ; si la personne tient dans la largeur, elle est entière
  const pxMin = lm.personXMin * W, pxMax = lm.personXMax * W
  let left = Math.round((pxMin + pxMax) / 2 - outW / 2)
  if (pxMax - pxMin <= outW) left = Math.min(Math.max(left, Math.round(pxMax) - outW), Math.round(pxMin))
  left = Math.max(0, Math.min(W - outW, left))

  const out = await sharp(buf).rotate().extract({ left, top, width: outW, height: outH }).jpeg({ quality: 93 }).toBuffer()
  return { buf: out, box: { left, top, width: outW, height: outH }, source: { W, H } }
}
