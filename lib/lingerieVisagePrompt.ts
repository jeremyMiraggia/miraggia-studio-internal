/**
 * Onglet 👙 Lingerie Visage — prompt Seedream 5 Pro (fal : bytedance/seedream/v5/pro/edit).
 *
 * ZIP Notion habituel (parseNotionExport) : SKU, Mannequin (→ tableau mannequins : FACE PHOTO + FRONT-model),
 * Fond (→ tableau fonds), produits (FILES (FRONT) / FILES (BACK) / DETAILS), colonnes « Vue et pose N ».
 *
 * Ordre des images envoyées (Seedream : 10 images max) :
 *   visage du mannequin → corps du mannequin → fond → produit(s)
 * Le prompt numérote les images dans cet ordre (« Image 1 », « Image 2 »…).
 */
import { poseToPrompt, type PoseOrientation } from '@/lib/poses'
import type { GenerationTask } from '@/lib/notion/parseExport'

export const SEEDREAM_MAX_IMAGES = 10

export type LVImageSet = { face?: File; body?: File; background?: File; products: File[] }

/** Images d'une tâche, dans l'ordre d'envoi (produits tronqués pour rester sous 10 images). */
export function lvImages(task: GenerationTask): LVImageSet {
  const face = task.facePhotoFile
  const body = task.bodyPhotoFile
  const background = task.backgroundFile
  const room = SEEDREAM_MAX_IMAGES - [face, body, background].filter(Boolean).length
  return { face, body, background, products: (task.productFiles ?? []).slice(0, Math.max(1, room)) }
}

export function lvImageList(s: LVImageSet): { label: string; file: File }[] {
  const out: { label: string; file: File }[] = []
  if (s.face) out.push({ label: 'Visage', file: s.face })
  if (s.body) out.push({ label: 'Corps', file: s.body })
  if (s.background) out.push({ label: 'Fond', file: s.background })
  s.products.forEach((f, i) => out.push({ label: s.products.length > 1 ? `Produit ${i + 1}` : 'Produit', file: f }))
  return out
}

const ORIENTATION: Record<PoseOrientation, string> = {
  Front: 'facing the camera',
  Side: 'in strict side profile',
  Back: 'seen from behind, back to the camera',
  Back3Q: 'rear three-quarter view, back dominant, only a hint of the face profile',
}

const FRAMING: Record<string, string> = {
  plein: 'Full-length shot: the whole body from head to feet is in frame, with a small margin.',
  'mi-corps': 'Mid-body shot: from the top of the head to mid-thigh.',
  haut: 'Upper-body shot: from just above the head down to the waist; the face is fully visible; legs out of frame.',
  bas: 'Lower-body shot: from the waist down to the feet; the face is out of frame.',
  detail: 'Tight close-up on a detail of the product as worn (lace, straps, clasp, seams, fabric texture), shallow depth of field.',
}

export function buildLingerieVisagePrompt(task: GenerationTask, s: LVImageSet, notes?: string): string {
  let n = 0
  const ref: string[] = []
  const faceIdx = s.face ? ++n : 0
  const bodyIdx = s.body ? ++n : 0
  const bgIdx = s.background ? ++n : 0
  const firstProd = n + 1
  n += s.products.length
  const prodLabel = s.products.length > 1 ? `Images ${firstProd} to ${n}` : `Image ${firstProd}`

  if (faceIdx) ref.push(`Image ${faceIdx}: the model's face. Keep exactly this identity: face shape, eyes, eyebrows, nose, lips, skin tone, freckles, hair color, texture and length. Natural skin with visible texture.`)
  if (bodyIdx) ref.push(`Image ${bodyIdx}: the same model's body. Keep her skin tone, build and silhouette. Do not copy its pose, outfit or background.`)
  if (bgIdx) ref.push(`Image ${bgIdx}: the background. Use it as the setting and keep it identical: color, light, texture. Add nothing to it.`)
  ref.push(`${prodLabel}: the product (lingerie or swimwear)${s.products.length > 1 ? ', several photos of the same set' : ''}. The model wears exactly this product: same cut, coverage, color, fabric, lace, straps, trims, print and fit. No reinterpretation, nothing added.`)

  const lines = [
    'Professional fashion catalogue photograph of lingerie / swimwear, elegant and tasteful.',
    '',
    ...ref,
    '',
  ]
  const isDetail = task.taskType === 'detail' || task.framingHint === 'detail'
  if (task.pose && !isDetail) {
    lines.push(`Orientation: the model is ${ORIENTATION[task.pose.orientation] ?? 'facing the camera'}.`)
    lines.push(`Pose: ${poseToPrompt(task.pose)}.`)
  }
  lines.push(`Framing: ${FRAMING[task.framingHint ?? 'plein'] ?? FRAMING.plein}`)
  if (notes?.trim()) lines.push(`Art direction: ${notes.trim()}`)
  lines.push(
    '',
    'Soft natural light consistent with the background, realistic skin, no heavy retouching, sharp focus on the product.',
    'One single photograph, no text, no collage.',
  )
  return lines.join('\n')
}

/** Formats proposés (largeur:hauteur). */
export const LV_RATIOS = ['3:4', '2:3', '4:5', '9:16', '1:1', '4:3', '3:2', '16:9'] as const

/** Qualités Seedream 5 Pro : surface de sortie (le modèle plafonne à ~4,6 MP, pas de 4K). */
export const LV_QUALITIES: Record<string, { area: number; price: number; hint: string }> = {
  '1K':   { area: 1024 * 1024, price: 0.0675, hint: '≈ 1 MP, brouillon' },
  '1.5K': { area: 1536 * 1536, price: 0.0675, hint: '≈ 2,4 MP, même prix que 1K' },
  '2K':   { area: 2048 * 2048, price: 0.135,  hint: '≈ 4,2 MP, qualité finale' },
}

/** Dimensions de sortie (multiples de 16) pour un format et une qualité. */
export function lvSize(ratio: string, quality: string): { width: number; height: number } {
  const [rw, rh] = ratio.split(':').map(Number)
  const area = (LV_QUALITIES[quality] ?? LV_QUALITIES['2K']).area
  const r = rw > 0 && rh > 0 ? rw / rh : 3 / 4
  const width = Math.round(Math.sqrt(area * r) / 16) * 16
  const height = Math.floor(area / width / 16) * 16
  return { width, height }
}

/** Prix fal indicatif d'un visuel : tarif de la qualité + 0,0045 $ par image d'entrée au-delà de la première. */
export const lvPrice = (quality: string, nImages: number) => (LV_QUALITIES[quality] ?? LV_QUALITIES['2K']).price + 0.0045 * Math.max(0, nImages - 1)
