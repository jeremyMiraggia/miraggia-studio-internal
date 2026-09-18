/**
 * Prompt Golden Silver — bloc REFERENCES fixe + description du décor (Notion) + bloc TECHNICAL.
 *
 * IMAGE 1 = outfit porté, vue de face (Files (Front))
 * IMAGE 2 = visage du mannequin (FACE PHOTO)
 * IMAGE 3 = gros plan du même vêtement (Details) — optionnel, guide de fidélité seulement
 *
 * Sortie : UN visuel de FACE.
 */
export function buildGoldSilverPrompt(opts: {
  decorName: string
  decorDescription: string
  ratio: string
  sku?: string
  detailText?: string
  hasDetail?: boolean
  detailCount?: number
}): string {
  const nDetail = opts.detailCount ?? (opts.hasDetail ? 1 : 0)
  const title = opts.decorName.trim().toUpperCase()
  const lines = [
    `EDITORIAL FASHION PHOTOGRAPH — ${title} SERIES`,
    '',
    'REFERENCES (strict):',
    '- IMAGE 1 = OUTFIT, front view. Reproduce the garment exactly: same cut,',
    '  silhouette, fabric texture, drape, color, print, seams, buttons, sleeve and',
    '  hem length. No reinterpretation, no added accessories, no altered color.',
    '  SHOES: the model wears EXACTLY the same shoes as in IMAGE 1 — same model,',
    '  same color, same material. Never replace, hide or crop them.',
    '- IMAGE 2 = MODEL. Preserve identity exactly: same face, facial structure,',
    '  eyes, eyebrows, lips, skin tone and undertone, freckles/marks, hair color,',
    '  texture and length, body proportions. She must be unmistakably the same',
    '  person. Keep her natural skin — visible pores and texture, no retouching.',
  ]
  if (nDetail > 0) {
    const label = nDetail === 1 ? 'IMAGE 3' : `IMAGES 3 to ${2 + nDetail}`
    lines.push(
      `- ${label} = CLOSE-UP DETAIL${nDetail > 1 ? 'S' : ''} of the same garment as IMAGE 1. Use ${nDetail > 1 ? 'them' : 'it'} ONLY to`,
      '  reproduce the fabric texture, print, stitching and finishes faithfully.',
      `  Do NOT reproduce ${nDetail > 1 ? 'their' : 'its'} framing: the output is a single front-view photograph,`,
      '  not a detail shot.',
    )
  }
  lines.push(
    '',
    'OUTPUT: one photograph of the model wearing the outfit, seen from the FRONT,',
    'garment fully readable. FEET (non-negotiable): the model\'s feet and shoes are',
    'ALWAYS fully visible in the frame, never cut by the bottom edge, never hidden',
    'behind an object or the foreground. Small margin below the shoes.',
  )
  if (opts.detailText?.trim()) {
    lines.push('', 'ADDITIONAL DIRECTION (from the brief):', opts.detailText.trim())
  }
  lines.push(
    '-----------------',
    opts.decorDescription.trim(),
    '---------------',
    'TECHNICAL:',
    `Aspect ratio ${opts.ratio}. High resolution. Photorealistic.`,
  )
  if (opts.sku) lines.push(`Reference: ${opts.sku}.`)
  return lines.join('\n')
}
