/**
 * Prompt Gold&Silver — bloc REFERENCES fixe + description du décor (Notion) + bloc TECHNICAL.
 *
 * IMAGE 1 = outfit porté (photo de la vue dans le LOOK)
 * IMAGE 2 = visage du mannequin (FACE PHOTO)
 */
import type { GSView } from '@/lib/notion/parseGoldSilverExport'

const VIEW_HINT: Record<GSView, string> = {
  front:   'This is the FRONT view of the outfit. Show the garment from the front; the composition may be full-length or three-quarter but the front of the garment must be fully readable.',
  back:    'This is the BACK view of the outfit. The model is seen from behind or in a three-quarter back angle so that the back of the garment (back seams, closure, back hem) is clearly visible. Her face may be turned away or in profile.',
  details: 'This is a DETAIL view of the outfit. Frame tighter on the part of the garment shown in IMAGE 1 (fabric, print, closure, neckline, cuff…). The model may be partially out of frame; the detail must be sharp and readable.',
}

export function buildGoldSilverPrompt(opts: {
  decorName: string
  decorDescription: string
  ratio: string
  view: GSView
  sku?: string
}): string {
  const title = opts.decorName.trim().toUpperCase()
  return [
    `EDITORIAL FASHION PHOTOGRAPH — ${title} SERIES`,
    '',
    'REFERENCES (strict):',
    '- IMAGE 1 = OUTFIT. Reproduce the garment exactly: same cut, silhouette,',
    '  fabric texture, drape, color, print, seams, buttons, sleeve and hem length.',
    '  No reinterpretation, no added accessories, no altered color.',
    '- IMAGE 2 = MODEL. Preserve identity exactly: same face, facial structure,',
    '  eyes, eyebrows, lips, skin tone and undertone, freckles/marks, hair color,',
    '  texture and length, body proportions. She must be unmistakably the same',
    '  person. Keep her natural skin — visible pores and texture, no retouching.',
    '',
    `VIEW: ${VIEW_HINT[opts.view]}`,
    '-----------------',
    opts.decorDescription.trim(),
    '---------------',
    'TECHNICAL:',
    `Aspect ratio ${opts.ratio}. High resolution. Photorealistic.`,
    opts.sku ? `Reference: ${opts.sku}.` : '',
  ].filter(l => l !== undefined).join('\n')
}
