/**
 * PAC — intégration d'une pompe à chaleur (unité murale) à l'emplacement d'un placeholder
 * (rectangle ROUGE ou BLANC) dans une photo, le reste de l'image devant rester identique.
 *
 * Mode « crop » (défaut) : on n'envoie à l'IA qu'une zone autour du placeholder, puis on recolle
 *   cette zone dans l'original (masque adouci) → reste de l'image identique au pixel, taille d'origine.
 * Mode « full » : on envoie l'image entière ; la sortie IA (4K max) est remise aux dimensions d'origine.
 */
import sharp from 'sharp'

export type Box = { left: number; top: number; width: number; height: number }   // pixels
export type Placeholder = { box: Box; color: 'red' | 'white'; method: 'couleur' | 'detection IA' }

const GEMINI_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
const rv = (r: string) => { const [a, b] = r.split(':').map(Number); return a / b }
export const nearestRatio = (w: number, h: number) =>
  GEMINI_RATIOS.reduce((best, r) => (Math.abs(Math.log(rv(r) / (w / h))) < Math.abs(Math.log(rv(best) / (w / h))) ? r : best), '1:1')

/* ============================== Détection ============================== */

/** Rectangle rouge pur : composante connexe la plus grande, bien rectangulaire. */
async function detectRed(buf: Buffer, W: number, H: number): Promise<Box | null> {
  const sw = Math.min(1200, W), sh = Math.round(H * sw / W)
  const { data } = await sharp(buf).rotate().resize(sw, sh, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const mask = new Uint8Array(sw * sh)
  for (let i = 0, p = 0; i < mask.length; i++, p += 3) {
    const r = data[p], g = data[p + 1], b = data[p + 2]
    if (r > 190 && g < 70 && b < 70 && r - Math.max(g, b) > 140) mask[i] = 1
  }
  // composantes connexes (4-voisinage), on garde la plus grande
  const seen = new Uint8Array(mask.length)
  let best: { n: number; x0: number; y0: number; x1: number; y1: number } | null = null
  const stack: number[] = []
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue
    let n = 0, x0 = sw, y0 = sh, x1 = 0, y1 = 0
    stack.push(s); seen[s] = 1
    while (stack.length) {
      const k = stack.pop()!, x = k % sw, y = (k - x) / sw
      n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
      for (const nb of [k - 1, k + 1, k - sw, k + sw]) {
        if (nb < 0 || nb >= mask.length || seen[nb] || !mask[nb]) continue
        if ((nb === k - 1 && x === 0) || (nb === k + 1 && x === sw - 1)) continue
        seen[nb] = 1; stack.push(nb)
      }
    }
    if (!best || n > best.n) best = { n, x0, y0, x1, y1 }
  }
  if (!best) return null
  const bw = best.x1 - best.x0 + 1, bh = best.y1 - best.y0 + 1
  const fill = best.n / (bw * bh)
  if (best.n < sw * sh * 0.0015 || fill < 0.8) return null   // trop petit ou pas rectangulaire (vêtement rouge…)
  const k = W / sw
  return { left: Math.floor(best.x0 * k), top: Math.floor(best.y0 * k), width: Math.ceil(bw * k), height: Math.ceil(bh * k) }
}

/** Rectangle blanc / gris clair : détection Gemini Flash (format natif box_2d). */
async function detectWhite(buf: Buffer, W: number, H: number, apiKey: string): Promise<Box> {
  const small = await sharp(buf).rotate().resize({ width: 1600, height: 1600, fit: 'inside' }).jpeg({ quality: 88 }).toBuffer()
  const prompt = [
    'This interior photo contains a PLACEHOLDER: a flat, plain, uniform rectangle (white or very light grey, no texture, no shading — a digital mock-up shape pasted onto the image) marking where a wall-mounted air-conditioning unit will be installed.',
    'It may be cut by the image edge. It is NOT a window, a painting, a frame, a door, a radiator, a vent or a lamp.',
    'Return a JSON list with ONE object: {"label": "placeholder", "box_2d": [ymin, xmin, ymax, xmax]} normalized to 0-1000, tight around the rectangle. If there is none, return [].',
  ].join('\n')
  const payload = JSON.stringify({
    contents: [{ parts: [{ inlineData: { mimeType: 'image/jpeg', data: small.toString('base64') } }, { text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  })
  let lastErr = ''
  for (const model of ['gemini-3-flash-preview', 'gemini-3.1-pro-preview']) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
    }).catch(e => { lastErr = String(e?.message ?? e); return null })
    if (!res) continue
    const json: any = await res.json().catch(() => null)
    if (!res.ok) { lastErr = `${model}: ${json?.error?.message ?? res.status}`; continue }
    try {
      const text = (json?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('')
      const list = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
      const b = Array.isArray(list) ? list[0]?.box_2d : null
      if (!Array.isArray(b) || b.length !== 4) throw new Error('aucun placeholder trouvé')
      const [y0, x0, y1, x1] = b.map((v: any) => Math.max(0, Math.min(1000, Number(v))) / 1000)
      if (!(x1 > x0 && y1 > y0)) throw new Error('boîte invalide')
      return { left: Math.floor(x0 * W), top: Math.floor(y0 * H), width: Math.ceil((x1 - x0) * W), height: Math.ceil((y1 - y0) * H) }
    } catch (e: any) { lastErr = `${model}: ${e?.message ?? e}` }
  }
  throw new Error(`Placeholder non trouvé : ${lastErr}`)
}

export async function detectPlaceholder(buf: Buffer, W: number, H: number, apiKey: string): Promise<Placeholder> {
  const red = await detectRed(buf, W, H)
  if (red) return { box: red, color: 'red', method: 'couleur' }
  return { box: await detectWhite(buf, W, H, apiKey), color: 'white', method: 'detection IA' }
}

/* ============================== Zone envoyée à l'IA ============================== */

/**
 * Zone autour du placeholder, au ratio Gemini le plus proche : assez large pour la perspective et la
 * lumière (≈ 2,4× la largeur du placeholder, au moins 40 % de l'image), sans sortir de l'image.
 */
export function chooseCrop(ph: Box, W: number, H: number): { box: Box; ratio: string } {
  const cx = ph.left + ph.width / 2, cy = ph.top + ph.height / 2
  const want = Math.max(ph.width * 2.4, ph.height * 3, Math.min(W, H) * 0.4)
  let best: { box: Box; ratio: string } | null = null
  for (const ratio of ['4:3', '3:2', '1:1', '5:4', '16:9', '3:4', '4:5', '2:3']) {
    const r = rv(ratio)
    let w = Math.min(want, W), h = w / r
    if (h > H) { h = H; w = h * r }
    if (w > W) continue
    if (w < ph.width * 1.15 || h < Math.min(H, ph.height * 1.6)) continue   // le placeholder doit tenir avec de la marge
    const left = Math.round(Math.max(0, Math.min(W - w, cx - w / 2)))
    const top = Math.round(Math.max(0, Math.min(H - h, cy - h / 2)))
    best = { box: { left, top, width: Math.round(w), height: Math.round(h) }, ratio }
    break
  }
  // repli : image entière (placeholder très grand)
  return best ?? { box: { left: 0, top: 0, width: W, height: H }, ratio: nearestRatio(W, H) }
}

/* ============================== Prompt ============================== */

export function buildPacPrompt(o: { color: 'red' | 'white'; isCrop: boolean; pacCount: number; posX: number; posY: number; edgeCut: boolean }): string {
  const pacLabel = o.pacCount > 1 ? `IMAGES 2 to ${o.pacCount + 1}` : 'IMAGE 2'
  return [
    'PHOTO RETOUCHING — INSERT A REAL PRODUCT INTO AN EXISTING PHOTOGRAPH.',
    '',
    `IMAGE 1 is ${o.isCrop ? 'a crop of ' : ''}a real interior photograph. On the wall there is a flat ${o.color === 'red' ? 'RED' : 'plain WHITE / light-grey'} rectangle, around ${Math.round(o.posX * 100)} % from the left and ${Math.round(o.posY * 100)} % from the top of IMAGE 1. It is a PLACEHOLDER: it marks exactly where the product must be installed.`,
    `${pacLabel} show the product to install${o.pacCount > 1 ? ' (the same unit seen from different angles)' : ''}: a wall-mounted heat-pump / air-conditioning indoor unit.`,
    '',
    'TASK: replace the placeholder with this exact unit, mounted flush on the wall at the placeholder position. The unit is centered on the placeholder and has roughly its size, keeping the unit\'s real proportions.' +
      (o.edgeCut ? ' The placeholder is cut by the image edge: the unit is cut by the edge in exactly the same way — do not move or shrink it to make it fully visible.' : ' If the placeholder is cut by the image edge, the unit is cut the same way.'),
    'Match the photograph: wall perspective and camera angle, the scene lighting and its direction, color temperature, a soft natural contact shadow on the wall, depth of field, sharpness, noise and grain.',
    'Reproduce the unit faithfully, as in the product photos: shape, proportions, white color, front panel, air outlet flap (closed), logo and its position, display / sensor area.',
    '',
    'KEEP EVERYTHING ELSE IDENTICAL: same framing and composition, pixel-aligned with IMAGE 1. Do not change, move, recolor, relight or re-render anything else — people, faces, hands, furniture, walls, objects, plants, lights. No trace of the placeholder remains. No text, no watermark.',
  ].join('\n')
}

/* ============================== Recollage ============================== */

/**
 * Recolle la zone générée dans l'original : seule une zone autour du placeholder (unité + ombre)
 * est reprise, avec un bord adouci ; le reste de la zone et de l'image reste l'original.
 */
export async function pasteBack(original: Buffer, generated: Buffer, crop: Box, ph: Box): Promise<Buffer> {
  const gen = await sharp(generated).rotate().resize(crop.width, crop.height, { fit: 'fill' }).removeAlpha().toBuffer()
  // Masque : placeholder élargi (l'unité est souvent plus haute qu'un placeholder allongé, + ombre en dessous)
  const s = Math.max(ph.width, ph.height)
  const mx0 = Math.max(0, ph.left - crop.left - 0.1 * s), mx1 = Math.min(crop.width, ph.left - crop.left + ph.width + 0.1 * s)
  const my0 = Math.max(0, ph.top - crop.top - 0.1 * s), my1 = Math.min(crop.height, ph.top - crop.top + ph.height + 0.16 * s)
  const feather = Math.max(4, Math.round(0.03 * s))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${crop.width}" height="${crop.height}"><rect width="100%" height="100%" fill="black"/>` +
    `<rect x="${mx0}" y="${my0}" width="${mx1 - mx0}" height="${my1 - my0}" fill="white"/></svg>`
  const mask = await sharp(Buffer.from(svg)).blur(feather / 2).extractChannel(0).raw().toBuffer()
  const genAlpha = await sharp(gen).joinChannel(mask, { raw: { width: crop.width, height: crop.height, channels: 1 } }).png().toBuffer()
  return sharp(original).rotate()
    .composite([{ input: genAlpha, left: crop.left, top: crop.top }])
    .withMetadata()
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer()
}
