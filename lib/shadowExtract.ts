/**
 * shadowExtract.ts — récupère l'ombre produite par Gemini et l'exprime comme
 * un MULTIPLICATEUR sur le fond original.
 *
 * Principe : Gemini a généré le mannequin dans la vraie scène. Sa sortie
 * contient une ombre de contact plausible pour cette pose et cette lumière.
 * On ne garde PAS ses pixels (fond repeint) ; on mesure seulement de combien
 * il a assombri le sol par rapport au fond original, et on applique ce
 * rapport au fond client : résultat = fond × ratio.
 *
 * Étapes :
 *   1. Bande de recherche autour du point de contact des pieds (hors sujet).
 *   2. ratio = lum(gemini) / lum(fond). Ombre si ratio < 1 − seuil.
 *   3. Nettoyage : ouverture morphologique, puis on ne garde que les composantes
 *      connexes qui touchent le sujet (dilaté) — le reste est du bruit de repeinte.
 *   4. Feather du masque + lissage du ratio.
 *
 * Sortie : carte de ratio (Float32, 1 = intact) pleine image + rapport.
 */
import sharp from 'sharp'

export type ShadowExtractOptions = {
  /** Assombrissement minimal pour compter comme ombre (défaut 0.06 = 6 %) */
  threshold?: number
  /** Extension latérale de la bande, en fraction de la largeur du sujet (défaut 0.6) */
  bandSideFrac?: number
  /** Extension de la bande au-dessus des pieds, fraction de la hauteur du sujet (défaut 0.10) */
  bandUpFrac?: number
  /** Extension de la bande sous les pieds, fraction de la hauteur du sujet (défaut 0.28) */
  bandDownFrac?: number
  /** Feather du masque d'ombre (sigma px). Défaut : 1 % de la largeur du sujet, min 4 */
  featherSigma?: number
  /** Ratio minimal (plancher d'assombrissement) — évite les trous noirs (défaut 0.35) */
  minRatio?: number
}

export type ShadowExtractReport = {
  band: { left: number; top: number; width: number; height: number }
  feet: { x: number; y: number }
  candidatePixels: number
  keptPixels: number
  touchesSubject: boolean
  meanDarkening: number      // 0..1, moyenne de (1 − ratio) sur les pixels gardés
  globalGain?: number        // dérive globale Gemini/fond mesurée loin des pieds (1 = aucune)
  threshold: number
  featherSigma: number
}

export type SubjectBox = { left: number; top: number; width: number; height: number }

/**
 * @param geminiRgb  raw RGB (w*h*3) de la sortie Gemini mise à l'échelle du fond
 * @param bgRgb      raw RGB (w*h*3) du fond original
 * @param alpha      alpha du sujet (w*h), pleine image, aux coordonnées finales
 */
export async function extractShadowRatio(
  geminiRgb: Buffer, bgRgb: Buffer, alpha: Uint8Array,
  w: number, h: number, subject: SubjectBox, opts: ShadowExtractOptions = {},
): Promise<{ ratio: Float32Array; mask: Uint8Array; report: ShadowExtractReport }> {
  const threshold    = opts.threshold ?? 0.06
  const bandSideFrac = opts.bandSideFrac ?? 0.6
  const bandUpFrac   = opts.bandUpFrac ?? 0.10
  const bandDownFrac = opts.bandDownFrac ?? 0.28
  const minRatio     = opts.minRatio ?? 0.35
  const featherSigma = opts.featherSigma ?? Math.max(4, Math.round(subject.width * 0.01))

  const feetY = subject.top + subject.height
  const feetX = subject.left + Math.round(subject.width / 2)

  // ---------- 1. Bande ----------
  const bl = Math.max(0, Math.round(subject.left - subject.width * bandSideFrac))
  const br = Math.min(w, Math.round(subject.left + subject.width * (1 + bandSideFrac)))
  const bt = Math.max(0, Math.round(feetY - subject.height * bandUpFrac))
  const bb = Math.min(h, Math.round(feetY + subject.height * bandDownFrac))
  const bw = br - bl, bh = bb - bt
  const band = { left: bl, top: bt, width: bw, height: bh }

  const ratio = new Float32Array(w * h).fill(1)
  const mask  = new Uint8Array(w * h)
  if (bw <= 0 || bh <= 0) {
    return { ratio, mask, report: emptyReport(band, feetX, feetY, threshold, featherSigma) }
  }

  // ---------- 2. Ratio de luminance dans la bande, hors sujet ----------
  const lum = (buf: Buffer, i: number) => 0.299 * buf[i * 3] + 0.587 * buf[i * 3 + 1] + 0.114 * buf[i * 3 + 2]
  const rawR = new Float32Array(bw * bh).fill(NaN)
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const gi = (bt + y) * w + (bl + x)
      if (alpha[gi] > 10) continue                    // sujet : on ne mesure pas
      const lb = lum(bgRgb, gi)
      if (lb < 12) continue                           // fond déjà noir : rien à mesurer
      rawR[y * bw + x] = lum(geminiRgb, gi) / lb
    }
  }
  // Dérive globale : Gemini repeint le fond un peu plus clair/sombre partout.
  // On l'estime sur les colonnes extérieures de la bande (loin des pieds) et on la retire.
  const edgeCols = Math.max(2, Math.round(bw * 0.15))
  const edgeVals: number[] = []
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    if (x >= edgeCols && x < bw - edgeCols) continue
    const v = rawR[y * bw + x]; if (!Number.isNaN(v)) edgeVals.push(v)
  }
  edgeVals.sort((a, b) => a - b)
  const gain = edgeVals.length ? edgeVals[Math.floor(edgeVals.length / 2)] : 1
  const gainSafe = gain > 0.5 && gain < 1.5 ? gain : 1

  const cand = new Uint8Array(bw * bh)
  const rBand = new Float32Array(bw * bh).fill(1)
  const measured = new Uint8Array(bw * bh)
  for (let i = 0; i < bw * bh; i++) {
    const v = rawR[i]
    if (Number.isNaN(v)) continue
    rBand[i] = Math.min(1, v / gainSafe)
    measured[i] = 1
  }

  // ---------- 2b. Propagation SOUS le bord du sujet ----------
  // Les pixels du bord adouci (alpha 10..250) et le sujet lui-même n'ont pas de
  // mesure. Sans ça, le sol sous le bord reste clair alors qu'il est ombré
  // tout autour → anneau clair autour des pieds. On remplit par convolution
  // normalisée des ratios mesurés voisins.
  {
    const fillSigma = Math.max(4, Math.round(subject.width * 0.012))
    const wR = new Uint8Array(bw * bh), wW = new Uint8Array(bw * bh)
    for (let i = 0; i < bw * bh; i++) if (measured[i]) { wR[i] = Math.round(rBand[i] * 255); wW[i] = 255 }
    const bR = await blur8(wR, bw, bh, fillSigma)
    const bW = await blur8(wW, bw, bh, fillSigma)
    for (let i = 0; i < bw * bh; i++) {
      if (measured[i]) continue
      if (bW[i] < 4) continue                     // trop loin du fond : reste 1 (couvert par le sujet)
      rBand[i] = Math.min(1, (bR[i] / bW[i]))
    }
  }

  let candidatePixels = 0
  for (let i = 0; i < bw * bh; i++) {
    if (rBand[i] < 1 - threshold) { cand[i] = 1; candidatePixels++ }
  }

  // ---------- 3. Nettoyage : ouverture puis composantes connexes touchant le sujet ----------
  const opened = dilate(erode(cand, bw, bh, 1), bw, bh, 1)
  // Sujet dilaté (≈ 2 % de sa hauteur) restreint à la bande → zone de "contact"
  const subjBand = new Uint8Array(bw * bh)
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    if (alpha[(bt + y) * w + (bl + x)] > 128) subjBand[y * bw + x] = 1
  }
  const contact = dilate(subjBand, bw, bh, Math.max(3, Math.round(subject.height * 0.02)))

  const kept = new Uint8Array(bw * bh)
  const visited = new Uint8Array(bw * bh)
  let keptPixels = 0
  let touchesSubject = false
  const stack: number[] = []
  for (let s = 0; s < bw * bh; s++) {
    if (!opened[s] || visited[s]) continue
    // BFS composante
    const comp: number[] = []
    let touches = false
    stack.push(s); visited[s] = 1
    while (stack.length) {
      const i = stack.pop()!
      comp.push(i)
      if (contact[i]) touches = true
      const y = (i / bw) | 0, x = i - y * bw
      const nb = [i - 1, i + 1, i - bw, i + bw]
      if (x === 0) nb[0] = -1
      if (x === bw - 1) nb[1] = -1
      for (const n of nb) {
        if (n < 0 || n >= bw * bh || visited[n] || !opened[n]) continue
        visited[n] = 1; stack.push(n)
      }
    }
    if (touches) {
      touchesSubject = true
      for (const i of comp) { kept[i] = 1; keptPixels++ }
    }
  }

  if (keptPixels === 0) {
    return { ratio, mask, report: { ...emptyReport(band, feetX, feetY, threshold, featherSigma), candidatePixels } }
  }

  // ---------- 4. Feather du masque + lissage du ratio ----------
  const kept255 = new Uint8Array(bw * bh)
  for (let i = 0; i < bw * bh; i++) kept255[i] = kept[i] ? 255 : 0
  const maskBlur = await blur8(kept255, bw, bh, featherSigma)
  // ratio lissé (sigma 1.5) pour gommer le grain de Gemini
  const r8 = new Uint8Array(bw * bh)
  for (let i = 0; i < bw * bh; i++) r8[i] = Math.round(Math.max(minRatio, rBand[i]) * 255)
  const rBlur = await blur8(r8, bw, bh, 1.5)

  let darkSum = 0
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = y * bw + x
      const m = maskBlur[i] / 255
      if (m <= 0) continue
      const rr = rBlur[i] / 255
      const finalR = 1 - m * (1 - rr)
      const gi = (bt + y) * w + (bl + x)
      ratio[gi] = finalR
      mask[gi] = maskBlur[i]
      if (kept[i]) darkSum += 1 - rr
    }
  }

  return {
    ratio, mask,
    report: {
      band, feet: { x: feetX, y: feetY },
      candidatePixels, keptPixels, touchesSubject,
      meanDarkening: keptPixels ? darkSum / keptPixels : 0,
      globalGain: gainSafe,
      threshold, featherSigma,
    },
  }
}

/** Applique la carte de ratio au fond : out = bg × ratio (RGB raw). */
export function applyRatio(bgRgb: Buffer, ratio: Float32Array): Buffer {
  const out = Buffer.from(bgRgb)
  const N = ratio.length
  for (let i = 0; i < N; i++) {
    const r = ratio[i]
    if (r >= 1) continue
    out[i * 3]     = Math.round(bgRgb[i * 3]     * r)
    out[i * 3 + 1] = Math.round(bgRgb[i * 3 + 1] * r)
    out[i * 3 + 2] = Math.round(bgRgb[i * 3 + 2] * r)
  }
  return out
}

/* ------------------------------ helpers ------------------------------ */

function emptyReport(band: SubjectBox, x: number, y: number, threshold: number, featherSigma: number): ShadowExtractReport {
  return { band, feet: { x, y }, candidatePixels: 0, keptPixels: 0, touchesSubject: false, meanDarkening: 0, threshold, featherSigma }
}

async function blur8(src: Uint8Array, w: number, h: number, sigma: number): Promise<Uint8Array> {
  if (sigma <= 0) return src
  const { data, info } = await sharp(Buffer.from(src), { raw: { width: w, height: h, channels: 1 } })
    .blur(Math.max(0.3, sigma)).raw().toBuffer({ resolveWithObject: true })
  if (info.channels === 1) return new Uint8Array(data)
  const out = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) out[i] = data[i * info.channels]
  return out
}

function erode(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h), dst = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 1
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) if (!src[y * w + k]) { m = 0; break }
    tmp[y * w + x] = m
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let m = 1
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) if (!tmp[k * w + x]) { m = 0; break }
    dst[y * w + x] = m
  }
  return dst
}

function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h), dst = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) if (src[y * w + k]) { m = 1; break }
    tmp[y * w + x] = m
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let m = 0
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) if (tmp[k * w + x]) { m = 1; break }
    dst[y * w + x] = m
  }
  return dst
}
