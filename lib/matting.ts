/**
 * matting.ts — raffinement d'un matte RGBA (sortie BiRefNet) avant paste-back.
 *
 * Problème traité : le « fil » / liseré autour du sujet après compositing.
 * Sur les pixels de bord semi-transparents (cheveux, contours), BiRefNet donne
 * un alpha correct mais la couleur RGB reste le MÉLANGE sujet + fond d'origine
 * (C = α·F + (1−α)·B). Recollé sur un autre fond, ce mélange forme un liseré.
 *
 * Solution (matting classique, tout en Node) :
 *   1. Estimer B, la couleur réelle du fond d'origine autour du sujet
 *      (anneau de pixels transparents adjacents au sujet — on ne fait PAS
 *      confiance à la couleur demandée à Gemini, on mesure ce qu'il a produit).
 *   2. Décontaminer : F = (C − (1−α)·B) / α, clampé [0,255].
 *   3. Éroder l'alpha de N px (min-filter séparable) pour retirer la frange
 *      la plus contaminée.
 *   4. Feather : léger flou gaussien sur l'alpha pour un bord doux.
 *
 * Tout est paramétrable, sans GPU, sans dépendance hors sharp.
 */
import sharp from 'sharp'

export type MatteOptions = {
  /** Décontamination de couleur avec fond estimé (défaut true) */
  decontaminate?: boolean
  /** Érosion de l'alpha en pixels (défaut 1). 0 = désactivé. */
  erodePx?: number
  /** Feather : sigma du flou gaussien sur l'alpha (défaut 0.8). 0 = désactivé. */
  featherSigma?: number
  /** En dessous de cet alpha (0-1), le pixel est jeté (frange bruitée) (défaut 0.06) */
  minAlpha?: number
  /** Couleur de fond imposée. Si absente, estimée depuis l'image. */
  bgColor?: { r: number; g: number; b: number }
  /**
   * Estimation LOCALE du fond (défaut true) : au lieu d'une couleur unique,
   * chaque pixel de bord est décontaminé avec la couleur des pixels transparents
   * voisins (convolution normalisée). Indispensable quand le fond n'est pas uni
   * (mur clair en haut, sol + ombre aux pieds).
   */
  localBg?: boolean
  /** Rayon (sigma px) de l'estimation locale. Défaut : 2.5 % de la largeur du sujet, min 8. */
  localBgSigma?: number
}

export type MatteReport = {
  bgEstimated: { r: number; g: number; b: number; samples: number }
  decontaminatedPixels: number
  erodePx: number
  featherSigma: number
  featherChannels: number
  localBg: boolean
  localBgSigma: number
  width: number
  height: number
}

/**
 * Raffine un PNG RGBA (sujet détouré sur transparent).
 * Renvoie un PNG RGBA + rapport.
 */
export async function refineMatte(rgbaPng: Buffer, opts: MatteOptions = {}): Promise<{ png: Buffer; report: MatteReport }> {
  const decontaminate = opts.decontaminate !== false
  const erodePx       = Math.max(0, Math.round(opts.erodePx ?? 1))
  const featherSigma  = Math.max(0, opts.featherSigma ?? 0.8)
  const minAlpha      = Math.max(0, Math.min(0.5, opts.minAlpha ?? 0.06))

  const { data, info } = await sharp(rgbaPng)
    .toColourspace('srgb').ensureAlpha()
    .raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
  const w = info.width, h = info.height
  if (info.channels !== 4) throw new Error(`refineMatte: expected 4 channels, got ${info.channels}`)
  if (data.length !== w * h * 4) throw new Error(`refineMatte: buffer ${data.length} ≠ ${w}×${h}×4 (profondeur ≠ 8 bits ?)`)

  const N = w * h
  const alpha = new Uint8Array(N)
  for (let i = 0; i < N; i++) alpha[i] = data[i * 4 + 3]

  // ---------- 1. Estimation de B : anneau de pixels transparents adjacents au sujet ----------
  let bg = opts.bgColor
  let samples = 0
  if (!bg) {
    // dilate le masque opaque de ~6 px, garde les pixels α≈0 dans cette zone
    const ring = dilateMask(alpha, w, h, 6, 200)
    let sr = 0, sg = 0, sb = 0
    for (let i = 0; i < N; i++) {
      if (ring[i] && alpha[i] < 8) {
        sr += data[i * 4]; sg += data[i * 4 + 1]; sb += data[i * 4 + 2]; samples++
      }
    }
    if (samples > 50) {
      bg = { r: Math.round(sr / samples), g: Math.round(sg / samples), b: Math.round(sb / samples) }
    } else {
      // fallback : moyenne globale des pixels transparents
      sr = sg = sb = 0; samples = 0
      for (let i = 0; i < N; i++) {
        if (alpha[i] < 8) { sr += data[i * 4]; sg += data[i * 4 + 1]; sb += data[i * 4 + 2]; samples++ }
      }
      bg = samples > 0
        ? { r: Math.round(sr / samples), g: Math.round(sg / samples), b: Math.round(sb / samples) }
        : { r: 255, g: 255, b: 255 }
    }
  }

  // ---------- 1b. Fond LOCAL : convolution normalisée des pixels transparents ----------
  // B_local(p) = Σ w·C / Σ w, avec w = 1 sur les pixels de fond (α<8), 0 ailleurs,
  // lissé par un flou gaussien. Là où Σw ≈ 0 (profond dans le sujet), on retombe
  // sur la couleur globale — ces pixels ont α=255 et ne sont pas décontaminés de toute façon.
  const localBg = opts.localBg !== false
  let localRgb: Uint8Array | null = null     // RGB par pixel (w*h*3)
  let localSigma = 0
  if (decontaminate && localBg) {
    // largeur du sujet ≈ largeur de la bbox α>128
    let minX = w, maxX = -1
    for (let i = 0; i < N; i++) if (alpha[i] > 128) { const x = i % w; if (x < minX) minX = x; if (x > maxX) maxX = x }
    const subjW = maxX >= minX ? maxX - minX + 1 : w
    localSigma = Math.max(8, opts.localBgSigma ?? Math.round(subjW * 0.025))

    const wRgb = Buffer.alloc(N * 3)     // C × w
    const wW   = Buffer.alloc(N)         // w × 255
    for (let i = 0; i < N; i++) {
      if (alpha[i] < 8) {
        wRgb[i * 3] = data[i * 4]; wRgb[i * 3 + 1] = data[i * 4 + 1]; wRgb[i * 3 + 2] = data[i * 4 + 2]
        wW[i] = 255
      }
    }
    const bRgb = await blurRaw(wRgb, w, h, 3, localSigma)
    const bW   = await blurRaw(wW,   w, h, 1, localSigma)
    localRgb = new Uint8Array(N * 3)
    for (let i = 0; i < N; i++) {
      const ww = bW[i]
      if (ww < 4) {            // pas assez de fond autour → couleur globale
        localRgb[i * 3] = bg.r; localRgb[i * 3 + 1] = bg.g; localRgb[i * 3 + 2] = bg.b
      } else {
        const k = 255 / ww
        localRgb[i * 3]     = clamp255(bRgb[i * 3]     * k)
        localRgb[i * 3 + 1] = clamp255(bRgb[i * 3 + 1] * k)
        localRgb[i * 3 + 2] = clamp255(bRgb[i * 3 + 2] * k)
      }
    }
  }

  // ---------- 2. Décontamination ----------
  const out = Buffer.from(data)
  let decontaminated = 0
  if (decontaminate) {
    const minA = Math.round(minAlpha * 255)
    for (let i = 0; i < N; i++) {
      const a8 = alpha[i]
      if (a8 === 0 || a8 === 255) continue
      if (a8 < minA) { alpha[i] = 0; continue }
      const a = a8 / 255
      const ia = 1 - a
      const o = i * 4
      const br = localRgb ? localRgb[i * 3]     : bg.r
      const bgc = localRgb ? localRgb[i * 3 + 1] : bg.g
      const bb = localRgb ? localRgb[i * 3 + 2] : bg.b
      out[o]     = clamp255((data[o]     - ia * br)  / a)
      out[o + 1] = clamp255((data[o + 1] - ia * bgc) / a)
      out[o + 2] = clamp255((data[o + 2] - ia * bb)  / a)
      decontaminated++
    }
  }

  // ---------- 3. Érosion (min-filter séparable) ----------
  let alphaOut: Uint8Array = alpha
  if (erodePx > 0) alphaOut = erodeAlpha(alpha, w, h, erodePx)

  // ---------- 4. Feather (flou gaussien sur l'alpha seul) ----------
  let featherChannels = 1
  if (featherSigma > 0) {
    // ⚠ sharp ne garantit PAS 1 canal en sortie d'une image raw 1 canal
    // (il peut renvoyer gris+alpha ou RGB). On lit info.channels et on
    // ré-échantillonne avec le bon stride — sinon l'alpha est lu décalé
    // (silhouette étirée ×2, rectangle semi-opaque, sujet translucide).
    const { data: bl, info: bi } = await sharp(Buffer.from(alphaOut), { raw: { width: w, height: h, channels: 1 } })
      .blur(featherSigma)
      .raw().toBuffer({ resolveWithObject: true })
    featherChannels = bi.channels
    if (bi.width !== w || bi.height !== h) throw new Error(`feather: dimensions inattendues ${bi.width}x${bi.height}`)
    if (bi.channels === 1) {
      alphaOut = new Uint8Array(bl)
    } else {
      const stride = bi.channels
      const a = new Uint8Array(N)
      for (let i = 0; i < N; i++) a[i] = bl[i * stride]
      alphaOut = a
    }
  }

  // ---------- Réassemblage ----------
  for (let i = 0; i < N; i++) out[i * 4 + 3] = alphaOut[i]

  const png = await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()
  return {
    png,
    report: {
      bgEstimated: { ...bg, samples },
      decontaminatedPixels: decontaminated,
      erodePx, featherSigma, featherChannels,
      localBg: localRgb !== null, localBgSigma: localSigma,
      width: w, height: h,
    },
  }
}

/* ------------------------------ helpers ------------------------------ */

/** Flou gaussien sur un buffer raw (1 ou 3 canaux), robuste au nombre de canaux renvoyé par sharp. */
async function blurRaw(src: Buffer, w: number, h: number, channels: 1 | 3, sigma: number): Promise<Uint8Array> {
  const { data, info } = await sharp(src, { raw: { width: w, height: h, channels } })
    .blur(Math.max(0.3, sigma))
    .raw().toBuffer({ resolveWithObject: true })
  if (info.channels === channels) return new Uint8Array(data)
  // Ré-échantillonnage si sharp a ajouté/retiré des canaux
  const out = new Uint8Array(w * h * channels)
  for (let i = 0; i < w * h; i++) for (let c = 0; c < channels; c++) out[i * channels + c] = data[i * info.channels + Math.min(c, info.channels - 1)]
  return out
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}

/** Min-filter séparable (érosion) sur un canal 8 bits. */
function erodeAlpha(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h)
  const dst = new Uint8Array(w * h)
  // horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let m = 255
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r)
      for (let k = x0; k <= x1; k++) { const v = src[row + k]; if (v < m) m = v }
      tmp[row + x] = m
    }
  }
  // vertical
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 255
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r)
      for (let k = y0; k <= y1; k++) { const v = tmp[k * w + x]; if (v < m) m = v }
      dst[y * w + x] = m
    }
  }
  return dst
}

/** Dilate un masque binaire (alpha > thr) de r px (max-filter séparable). Renvoie 0/1. */
function dilateMask(alpha: Uint8Array, w: number, h: number, r: number, thr: number): Uint8Array {
  const bin = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) bin[i] = alpha[i] > thr ? 1 : 0
  const tmp = new Uint8Array(w * h)
  const dst = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let m = 0
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r)
      for (let k = x0; k <= x1; k++) { if (bin[row + k]) { m = 1; break } }
      tmp[row + x] = m
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 0
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r)
      for (let k = y0; k <= y1; k++) { if (tmp[k * w + x]) { m = 1; break } }
      dst[y * w + x] = m
    }
  }
  return dst
}
