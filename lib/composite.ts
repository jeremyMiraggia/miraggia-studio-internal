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
 *
 * Objectif : une ombre EXTRÊMEMENT subtile, à peine visible, comme dans une
 * vraie photo éditoriale tournée dans un cyclorama avec lumière diffuse douce.
 * On insiste lourdement sur la subtilité pour contrebalancer la tendance de
 * Gemini à over-draw les ombres.
 */
export const SHADOW_ADD_PROMPT = [
  'You are given a fashion editorial photograph of a model standing on a floor. The model currently has NO floor shadow under her feet, making her look slightly disconnected from the ground.',
  '',
  '⚠ ABSOLUTE TASK : add ONE VERY SUBTLE, BARELY VISIBLE soft shadow just at the contact points where the feet meet the floor. Think of editorial fashion photography shot in a studio with soft diffuse window light — the shadow is delicate, gentle, almost a whisper.',
  '',
  'PRESERVATION (CRITICAL — pixel-perfect, do NOT touch ANYTHING else):',
  '- Model : face, hair, skin, outfit, pose, all garment details → 100 % identical to input.',
  '- Background : walls, floor, lighting, ambiance, all existing elements → 100 % identical to input.',
  '- Framing, crop, camera angle, composition → 100 % identical to input.',
  '',
  'THE SHADOW — STRICT GUIDELINES :',
  '- INTENSITY : EXTREMELY LIGHT. Just barely darker than the floor — like 5 to 10 % darker at the strongest point. The viewer should almost NOT notice the shadow on first look ; it should feel like it has always been there.',
  '- EXTENT : VERY LOCAL. Hugs the immediate footprint of the shoes / feet. Fades to invisible within 10 to 20 cm around the feet. Do NOT extend behind, in front, or sideways further than necessary.',
  '- SHAPE : a small soft contact shadow at the feet (NOT a large oval, NOT a projected silhouette of the body, NOT a dark patch, NOT a halo around the entire base).',
  '- COLOR : a tinted version of the floor color (slightly darker), NEVER pure black, NEVER gray that contrasts with the floor.',
  '- DIRECTION : matches the existing scene\'s lighting if visible ; otherwise stays compact under the feet.',
  '- LIGHTING REFERENCE : soft diffuse light from a large overhead softbox or a north-facing window — gentle, low contrast.',
  '',
  'FORBIDDEN PATTERNS (these are what AI typically over-does — DO NOT do them) :',
  '- ❌ A big dark oval around the model.',
  '- ❌ A long cast shadow stretching meters away.',
  '- ❌ A dark patch competing visually with the model.',
  '- ❌ A pure black or gray shadow that doesn\'t match the floor color.',
  '- ❌ Any reflection of the model on the floor (even if floor is shiny).',
  '',
  'The output should be VISUALLY 99 % identical to the input ; the only difference is a delicate, whisper-soft contact shadow at the feet that grounds the model naturally.',
].join('\n')
