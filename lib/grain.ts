/**
 * Grain argentique appliqué côté navigateur (canvas), sans appel serveur.
 *
 * - Bruit gaussien déterministe (graine = nom du fichier) : l'aperçu et l'export
 *   d'un même visuel donnent exactement le même grain.
 * - Taille de grain : bruit blanc par pixel, filtré par un noyau gaussien normalisé.
 *   La variance reste la même à chaque position : pas de motif de grille.
 *   Mémoire O(largeur × noyau).
 * - Réponse en luminance : grain plein dans les tons moyens, atténué (×0.25) dans
 *   les noirs profonds et les blancs purs, comme un vrai film.
 */

export type GrainParams = {
  /** 0–100 */
  intensity: number
  /** Taille du grain en pixels (1 = grain fin au pixel) */
  size: number
  /** true = grain couleur (un bruit par canal), false = grain monochrome */
  color: boolean
}

export const DEFAULT_GRAIN: GrainParams = { intensity: 25, size: 1.5, color: false }

/** Écart-type du bruit (sur 0–255) à intensité 100, dans les tons moyens. */
const MAX_SIGMA = 40
/** Au-delà de 1 px, garde la force de l'ancienne interpolation, pour que les préréglages ne changent pas d'aspect. */
const COARSE_GAIN = 0.72

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

/** Noyau symétrique dont la somme des poids au carré vaut 1, ce qui conserve la variance. */
export function grainKernel(size: number): Float32Array {
  const sigma = 0.4 * Math.max(1, size)
  const radius = Math.max(1, Math.ceil(2.5 * sigma))
  const k = new Float32Array(2 * radius + 1)
  let energy = 0
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma))
    k[i + radius] = w
    energy += w * w
  }
  const norm = Math.sqrt(energy)
  for (let i = 0; i < k.length; i++) k[i] /= norm
  return k
}

/** Applique le grain en place sur les pixels RGBA. */
export function applyGrain(img: ImageData, p: GrainParams, seed: number): void {
  const { width: w, height: h, data } = img
  const sigma = (Math.max(0, Math.min(100, p.intensity)) / 100) * MAX_SIGMA * (p.size > 1 ? COARSE_GAIN : 1)
  if (sigma === 0) return

  const ch = p.color ? 3 : 1
  const kernel = grainKernel(p.size)
  const taps = kernel.length
  const radius = (taps - 1) / 2
  const rand = mulberry32(seed)

  // Gaussienne par Box-Muller (on garde la 2e valeur)
  let spare: number | null = null
  const gauss = () => {
    if (spare !== null) { const v = spare; spare = null; return v }
    let u = 0
    while (u === 0) u = rand()
    const r = Math.sqrt(-2 * Math.log(u)), t = 2 * Math.PI * rand()
    spare = r * Math.sin(t)
    return r * Math.cos(t)
  }

  const raw = new Float32Array((w + 2 * radius) * ch)
  /** Nouvelle ligne de bruit blanc, filtrée horizontalement. */
  const nextRow = (out: Float32Array) => {
    for (let i = 0; i < raw.length; i++) raw[i] = gauss()
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) {
        let sum = 0
        for (let t = 0; t < taps; t++) sum += kernel[t] * raw[(x + t) * ch + c]
        out[x * ch + c] = sum
      }
    }
    return out
  }

  // Anneau de lignes filtrées horizontalement, combinées verticalement ci-dessous
  const ring: Float32Array[] = []
  for (let i = 0; i < taps; i++) ring.push(nextRow(new Float32Array(w * ch)))
  let head = 0

  const noise = new Float32Array(w * ch)
  for (let y = 0; y < h; y++) {
    noise.fill(0)
    for (let t = 0; t < taps; t++) {
      const row = ring[(head + t) % taps]
      const weight = kernel[t]
      for (let i = 0; i < noise.length; i++) noise[i] += weight * row[i]
    }

    let o = y * w * 4
    for (let x = 0; x < w; x++, o += 4) {
      const R = data[o], G = data[o + 1], B = data[o + 2]
      const d = (2 * (0.299 * R + 0.587 * G + 0.114 * B)) / 255 - 1
      const k = sigma * (1 - 0.75 * d * d)
      // Uint8ClampedArray : clamp + arrondi auto
      if (ch === 1) {
        const v = noise[x] * k
        data[o] = R + v; data[o + 1] = G + v; data[o + 2] = B + v
      } else {
        const i = x * 3
        data[o] = R + noise[i] * k; data[o + 1] = G + noise[i + 1] * k; data[o + 2] = B + noise[i + 2] * k
      }
    }

    nextRow(ring[head])
    head = (head + 1) % taps
  }
}

export type GrainOutput = { blob: Blob; width: number; height: number }

/** Décode un fichier image en pixels RGBA (orientation EXIF appliquée). */
export async function decodeFile(file: File): Promise<ImageData> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width; canvas.height = bmp.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 2D indisponible.')
  ctx.drawImage(bmp, 0, 0)
  bmp.close()
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  canvas.width = canvas.height = 0
  return img
}

/** Décode le fichier, applique le grain, ré-encode dans le format d'origine (JPEG 95 %, PNG, WebP 95 %). */
export async function grainFile(file: File, p: GrainParams, seed: number): Promise<GrainOutput> {
  const img = await decodeFile(file)
  applyGrain(img, p, seed)
  const canvas = document.createElement('canvas')
  canvas.width = img.width; canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D indisponible.')
  ctx.putImageData(img, 0, 0)

  const type = outputType(file)
  const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, type, 0.95))
  canvas.width = canvas.height = 0   // libère la mémoire tout de suite
  if (!blob) throw new Error('Encodage impossible.')
  return { blob, width: img.width, height: img.height }
}

export function outputType(file: File): 'image/png' | 'image/webp' | 'image/jpeg' {
  const t = file.type || '', n = file.name.toLowerCase()
  if (t === 'image/png' || n.endsWith('.png')) return 'image/png'
  if (t === 'image/webp' || n.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}
