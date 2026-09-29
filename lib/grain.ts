/**
 * Grain argentique appliqué côté navigateur (canvas), sans appel serveur.
 *
 * - Bruit gaussien déterministe (graine = nom du fichier) : l'aperçu et l'export
 *   d'un même visuel donnent exactement le même grain.
 * - Taille de grain : bruit tiré sur une grille de pas `size` px puis interpolé
 *   (bilinéaire). Les lignes de la grille sont générées au fil de l'eau → mémoire O(largeur).
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

/** Applique le grain en place sur les pixels RGBA. */
export function applyGrain(img: ImageData, p: GrainParams, seed: number): void {
  const { width: w, height: h, data } = img
  const sigma = (Math.max(0, Math.min(100, p.intensity)) / 100) * MAX_SIGMA
  if (sigma === 0) return

  const size = Math.max(1, p.size)
  const ch = p.color ? 3 : 1
  const gw = Math.ceil((w - 1) / size) + 2          // points de grille par ligne
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
  const newRow = () => {
    const row = new Float32Array(gw * ch)
    for (let i = 0; i < row.length; i++) row[i] = gauss()
    return row
  }

  // Deux lignes de grille glissantes
  let rowIdx = 0
  let r0 = newRow(), r1 = newRow()

  // Pré-calcul horizontal : indice de grille et poids pour chaque x
  const gx0 = new Int32Array(w), fx = new Float32Array(w)
  for (let x = 0; x < w; x++) { const g = x / size; gx0[x] = Math.floor(g); fx[x] = g - gx0[x] }

  const n = new Float32Array(3)
  for (let y = 0; y < h; y++) {
    const gy = y / size
    const gyi = Math.floor(gy), fy = gy - gyi
    while (rowIdx < gyi) { r0 = r1; r1 = newRow(); rowIdx++ }

    let o = y * w * 4
    for (let x = 0; x < w; x++, o += 4) {
      const i0 = gx0[x] * ch, i1 = i0 + ch, a = fx[x]
      for (let c = 0; c < ch; c++) {
        const top = r0[i0 + c] + (r0[i1 + c] - r0[i0 + c]) * a
        const bot = r1[i0 + c] + (r1[i1 + c] - r1[i0 + c]) * a
        n[c] = top + (bot - top) * fy
      }
      const R = data[o], G = data[o + 1], B = data[o + 2]
      const L = (0.299 * R + 0.587 * G + 0.114 * B) / 255
      const d = 2 * L - 1
      const k = sigma * (1 - 0.75 * d * d)
      if (ch === 1) {
        const v = n[0] * k
        data[o] = R + v; data[o + 1] = G + v; data[o + 2] = B + v   // Uint8ClampedArray : clamp + arrondi auto
      } else {
        data[o] = R + n[0] * k; data[o + 1] = G + n[1] * k; data[o + 2] = B + n[2] * k
      }
    }
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
