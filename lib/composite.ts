/**
 * Mode Composite — pipeline déterministe pour garantir 100% de fidélité du fond.
 *
 *  1. Gemini génère le visuel mannequin + tenue + scène (avec lumière correcte
 *     car le fond de référence est passé en input → Gemini sait où il est).
 *  2. Segmentation client-side (@imgly/background-removal, modèle BRIA RMBG)
 *     → on extrait le mannequin sur fond transparent.
 *  3. Composite Canvas : on dessine les PIXELS EXACTS du fond de référence,
 *     puis on pose le mannequin extrait par-dessus.
 *     - Pour les close-up haut (sol non visible) : crop le bg aux 30% du haut
 *       AVANT de composer, pour éviter de voir le sol derrière la tête.
 *  4. (côté CompositeTab) — pour les framings où le sol est visible (plein
 *     pied, bas), une 4e passe Gemini ajoute une ombre naturelle sous les
 *     pieds en préservant le reste pixel-pour-pixel.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { cropTopPercent } from '@/lib/imageCrop'

// Lazy-loaded segmenter ; le 1er load télécharge ~80 MB de modèle ONNX.
let _segmenter: ((input: Blob | string | ArrayBuffer) => Promise<Blob>) | null = null

export async function loadSegmenter() {
  if (_segmenter) return _segmenter
  const mod: any = await import('@imgly/background-removal')
  const fn = (mod.removeBackground ?? mod.default?.removeBackground ?? mod.default) as any
  if (typeof fn !== 'function') {
    throw new Error('@imgly/background-removal : fonction removeBackground introuvable.')
  }
  _segmenter = fn
  return fn as (input: Blob | string | ArrayBuffer) => Promise<Blob>
}

/**
 * Segmente l'image : renvoie un PNG avec canal alpha (fond transparent).
 * Premier appel = ~10-30 s (download du modèle), suivants = ~2-5 s.
 */
export async function segmentForeground(
  input: Blob,
  onProgress?: (msg: string) => void,
): Promise<Blob> {
  onProgress?.('Chargement du modèle de segmentation (cache navigateur après le 1er run)...')
  const removeBg = await loadSegmenter()
  onProgress?.('Extraction du mannequin du fond...')
  const result = await removeBg(input)
  return result
}

export type CompositeOptions = {
  /**
   * Si défini sur 'haut' (close-up haut), on crop le fond aux 30% du haut
   * avant le composite — ainsi on ne voit pas le sol derrière la tête.
   */
  framingHint?: string
}

/**
 * Composite : pose le mannequin (PNG transparent) sur le fond de référence.
 * Le canvas final a la résolution du mannequin (= sortie Gemini).
 *
 * Pas d'ombre ajoutée ici — l'ombre est gérée par une passe Gemini
 * supplémentaire côté runner (seulement quand le sol est visible).
 */
export async function compositeOnBackground(
  segmentedPng: Blob,
  backgroundFile: File,
  options: CompositeOptions = {},
): Promise<File> {
  // Pour close-up haut : on coupe le fond pour ne garder que la partie
  // haute (mur), pas de sol visible derrière la tête.
  let bgFile = backgroundFile
  if (options.framingHint === 'haut') {
    try {
      bgFile = await cropTopPercent(backgroundFile, 30)
    } catch (err) {
      console.warn('[composite] cropTopPercent fallback:', err)
    }
  }

  const [modelBmp, bgBmp] = await Promise.all([
    createImageBitmap(segmentedPng),
    createImageBitmap(bgFile),
  ])

  const W = modelBmp.width
  const H = modelBmp.height

  const canvas = document.createElement('canvas')
  canvas.width  = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Impossible d\'obtenir le contexte 2D du canvas.')

  drawCover(ctx, bgBmp, W, H)
  ctx.drawImage(modelBmp, 0, 0)

  return new Promise<File>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('canvas.toBlob a renvoyé null.'))
        resolve(new File([blob], 'composite.jpg', { type: 'image/jpeg' }))
      },
      'image/jpeg',
      0.92,
    )
  })
}

/* ============================== helpers ============================== */

function drawCover(ctx: CanvasRenderingContext2D, bmp: ImageBitmap, W: number, H: number) {
  const ratio = Math.max(W / bmp.width, H / bmp.height)
  const w = bmp.width  * ratio
  const h = bmp.height * ratio
  const x = (W - w) / 2
  const y = (H - h) / 2
  ctx.drawImage(bmp, x, y, w, h)
}

/* ============================== utils ============================== */

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload  = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl)
  return res.blob()
}

/**
 * Prompt pour la passe Gemini "ajoute une ombre naturelle" sur le composite.
 * Utilisé seulement pour plein pied et close-up bas (où le sol est visible).
 */
export const SHADOW_ADD_PROMPT = [
  'You are given a fashion editorial composite where a model has been pasted on a background scene. CURRENTLY THERE IS NO SHADOW under the model\'s feet — she looks like she is floating slightly above the ground, which is not realistic.',
  '',
  'ABSOLUTE TASK: Add ONE natural soft shadow on the floor directly under the model\'s feet.',
  '',
  'PRESERVATION (CRITICAL — pixel-perfect, do NOT alter):',
  '- The model herself : face, hair, skin, outfit, pose, all clothing details → 100 % identical to the input.',
  '- The background : walls, floor texture and color, lighting, all existing scene elements → 100 % identical to the input.',
  '- The framing, the camera angle, the composition → 100 % identical to the input.',
  '',
  'THE ONLY ADDITION (one soft shadow on the floor):',
  '- Shape : follows the model\'s silhouette in her current pose (gap between feet, leg angle, body weight distribution).',
  '- Direction : matches the existing key light visible in the scene.',
  '- Color : tinted by the floor material (NOT pure black — slightly darker version of the floor color).',
  '- Intensity : subtle, editorial, ~20-30 % darker than the floor at the contact points, fading to nothing within ~40-50 cm.',
  '- Style : a real, believable fashion editorial photograph shadow.',
  '',
  'The output must be VISUALLY INDISTINGUISHABLE from the input EXCEPT for the added shadow under the feet. Do NOT regenerate or restyle anything else.',
].join('\n')
