/**
 * Prompt Golden Silver — bloc REFERENCES fixe + description du décor (Notion) + bloc TECHNICAL.
 *
 * Ordre des images envoyées :
 *   IMAGES 1…n      = photos de la tenue portée (Files (Front)) — n ≥ 1
 *   IMAGE n+1       = visage du mannequin (FACE PHOTO)
 *   IMAGES n+2…     = gros plans du vêtement (Details) — optionnels, guide de fidélité
 *
 * Sortie : UN visuel de FACE.
 */
export function buildGoldSilverPrompt(opts: {
  decorName: string
  decorDescription: string
  ratio: string
  sku?: string
  detailText?: string
  outfitCount?: number
  detailCount?: number
}): string {
  const nOut = Math.max(1, opts.outfitCount ?? 1)
  const nDet = opts.detailCount ?? 0
  const modelIdx = nOut + 1
  const outfitLabel = nOut === 1 ? 'IMAGE 1' : `IMAGES 1 to ${nOut}`
  const detailLabel = nDet === 1 ? `IMAGE ${modelIdx + 1}` : `IMAGES ${modelIdx + 1} to ${modelIdx + nDet}`
  const title = opts.decorName.trim().toUpperCase()

  const lines = [
    `EDITORIAL FASHION PHOTOGRAPH — ${title} SERIES`,
    '',
    'REFERENCES (strict):',
    nOut === 1
      ? '- IMAGE 1 = OUTFIT, front view. Reproduce the garment exactly: same cut,'
      : `- ${outfitLabel} = THE SAME OUTFIT, several photos of it worn. Combine them into ONE faithful garment: same cut,`,
    '  silhouette, fabric texture, drape, color, print, seams, buttons, sleeve and',
    '  hem length. No reinterpretation, no added accessories, no altered color.',
    `  SHOES: the model wears EXACTLY the same shoes as in ${outfitLabel} — same model,`,
    '  same color, same material. Never replace, hide or crop them.',
    `- IMAGE ${modelIdx} = MODEL. Preserve identity exactly: same face, facial structure,`,
    '  eyes, eyebrows, lips, skin tone and undertone, freckles/marks, hair color,',
    '  texture and length, body proportions. She must be unmistakably the same',
    '  person. Keep her natural skin — visible pores and texture, no retouching.',
  ]
  if (nDet > 0) {
    lines.push(
      `- ${detailLabel} = CLOSE-UP DETAIL${nDet > 1 ? 'S' : ''} of the same garment. Use ${nDet > 1 ? 'them' : 'it'} ONLY to`,
      '  reproduce the fabric texture, print, stitching and finishes faithfully.',
      `  Do NOT reproduce ${nDet > 1 ? 'their' : 'its'} framing: the output is a single front-view photograph,`,
      '  not a detail shot.',
    )
  }
  lines.push(
    '',
    'OUTPUT: ONE photograph of the model wearing the outfit, seen from the FRONT,',
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
