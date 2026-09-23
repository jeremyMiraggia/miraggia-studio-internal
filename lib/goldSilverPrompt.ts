/**
 * Prompt Golden Silver — sous-onglet BACK.
 *
 *   IMAGE 1        = le visuel de FACE final (mannequin + décor + lumière à CONSERVER)
 *   IMAGES 2…n+1   = la tenue vue de DOS (photos produit / portées)
 *
 * Sortie : le même mannequin, dans le même décor, vu de dos, pose naturelle.
 */
export function buildGoldSilverBackPrompt(opts: {
  ratio: string
  sku?: string
  backCount?: number
  detailText?: string
  modelDescription?: string
}): string {
  const n = Math.max(1, opts.backCount ?? 1)
  const backLabel = n === 1 ? 'IMAGE 2' : `IMAGES 2 to ${n + 1}`
  const lines = [
    'EDITORIAL FASHION PHOTOGRAPH — BACK VIEW OF AN EXISTING SHOT',
    '',
    'REFERENCES (strict):',
    '- IMAGE 1 = the FINAL FRONT photograph of this look. It defines EVERYTHING that must',
    '  stay identical: the SAME model (identity, hair color/texture/length, skin tone,',
    '  build, height), the SAME location and background, the SAME light direction, time',
    '  of day, color palette, film look and grain, and the same photographic style and',
    '  distance to camera. Treat it as the previous frame of the same shoot, taken',
    '  seconds later from behind.',
    `- ${backLabel} = the OUTFIT seen from the BACK. Reproduce the back of the garment`,
    '  exactly: back seams, closure (zip, buttons, ties), straps, neckline, waist, hem',
    '  length, fabric, color, print. No reinterpretation. The front of the garment is',
    '  the one worn in IMAGE 1 — this is the same outfit.',
    '  SHOES: exactly the same shoes as in IMAGE 1.',
  ]
  if (opts.modelDescription?.trim()) {
    lines.push(
      '  MODEL DESCRIPTION (must match IMAGE 1):',
      ...opts.modelDescription.trim().split('\n').map(l => `  ${l.trim()}`).filter(l => l.trim()),
    )
  }
  lines.push(
    '',
    'OUTPUT: ONE photograph of the same model, in the same place, seen from BEHIND',
    '(full back view or a slight three-quarter back). POSE: standing still, relaxed',
    'and composed — a calm, settled posture, weight on one leg, arms loose or one',
    'hand lightly resting; no walking, no mid-step, no dynamic movement, no twisting.',
    'Quiet and natural, never stiff. The back of the garment must be fully readable.',
    'FEET (non-negotiable): feet and shoes',
    'always fully visible, never cut by the frame. Full-length figure, small margin',
    'below the shoes. Same aspect ratio and framing distance as IMAGE 1.',
  )
  if (opts.detailText?.trim()) {
    lines.push('', 'ADDITIONAL DIRECTION (from the brief):', opts.detailText.trim())
  }
  lines.push(
    '---------------',
    'TECHNICAL:',
    `Aspect ratio ${opts.ratio}. High resolution. Photorealistic. Same film stock, grain and color rendering as IMAGE 1.`,
  )
  if (opts.sku) lines.push(`Reference: ${opts.sku}.`)
  // supprime les lignes vides consécutives (les blocs optionnels peuvent en laisser)
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n')
}

/**
 * Prompt Golden Silver — bloc REFERENCES fixe + description du décor (Notion) + bloc TECHNICAL.
 *
 * Ordre des images envoyées :
 *   IMAGES 1…n      = photos de la tenue portée (Files (Front)) — n ≥ 1
 *   IMAGE n+1       = visage du mannequin (FACE PHOTO)
 *   IMAGE n+2       = corps du mannequin (FRONT-model) — optionnel
 *   IMAGES suivantes = gros plans du vêtement (Details) — optionnels, guide de fidélité
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
  hasBody?: boolean
  detailCount?: number
  modelDescription?: string   // description courte du mannequin (générée une fois, réutilisée)
  framing?: 'full' | 'closeup'   // closeup = gros plan / mi-corps haut, chaussures ignorées
}): string {
  const closeup = opts.framing === 'closeup'
  const nOut = Math.max(1, opts.outfitCount ?? 1)
  const nDet = opts.detailCount ?? 0
  const modelIdx = nOut + 1
  const bodyIdx = opts.hasBody ? modelIdx + 1 : null
  const firstDetail = (bodyIdx ?? modelIdx) + 1
  const outfitLabel = nOut === 1 ? 'IMAGE 1' : `IMAGES 1 to ${nOut}`
  const detailLabel = nDet === 1 ? `IMAGE ${firstDetail}` : `IMAGES ${firstDetail} to ${firstDetail + nDet - 1}`
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
    ...(closeup
      ? ['  SHOES: not part of this shot — the framing stops well above the feet.']
      : [`  SHOES: the model wears EXACTLY the same shoes as in ${outfitLabel} — same model,`,
         '  same color, same material. Never replace, hide or crop them.']),
    `- IMAGE ${modelIdx} = MODEL FACE. Preserve identity exactly: same face, facial structure,`,
    '  eyes, eyebrows, lips, skin tone and undertone, freckles/marks, hair color,',
    '  texture and length. She must be unmistakably the same person. Keep her',
    '  natural skin — visible pores and texture, no retouching.',
  ]
  if (opts.modelDescription?.trim()) {
    lines.push(
      `  MODEL DESCRIPTION (must match IMAGE ${modelIdx} — if the generated face deviates from this, it is wrong):`,
      ...opts.modelDescription.trim().split('\n').map(l => `  ${l.trim()}`).filter(l => l.trim()),
    )
  }
  if (bodyIdx) {
    lines.push(
      `- IMAGE ${bodyIdx} = MODEL BODY, the same person. Use it for skin tone, build and`,
      '  overall silhouette. Do not copy its pose, framing or background.',
    )
  }
  lines.push(
    '- STATURE: she is a TALL fashion model — long legs, long neck, elongated',
    '  silhouette, head small relative to the body (about 9 heads tall). Never',
    '  short or stocky.',
  )
  if (nDet > 0) {
    lines.push(
      `- ${detailLabel} = CLOSE-UP DETAIL${nDet > 1 ? 'S' : ''} of the same garment. Use ${nDet > 1 ? 'them' : 'it'} ONLY to`,
      '  reproduce the fabric texture, print, stitching and finishes faithfully.',
      `  Do NOT reproduce ${nDet > 1 ? 'their' : 'its'} framing: the output is a single front-view photograph,`,
      '  not a detail shot.',
    )
  }
  if (closeup) {
    lines.push(
      '',
      'OUTPUT — CLOSE-UP: ONE photograph of the model wearing the outfit, seen from the',
      'FRONT, framed as a CLOSE-UP or UPPER MID-BODY shot: from the top of the head down',
      'to the hips/waist at most. The face and the upper part of the garment (neckline,',
      'shoulders, sleeves, chest, print) must be sharp and fully readable. Legs, feet and',
      'shoes are OUT of frame — do not show them. 85-105 mm portrait feel, natural',
      'headroom, garment and face given equal importance.',
    )
  } else {
    lines.push(
      '',
      'OUTPUT: ONE photograph of the model wearing the outfit, seen from the FRONT,',
      'garment fully readable. FEET (non-negotiable): the model\'s feet and shoes are',
      'ALWAYS fully visible in the frame, never cut by the bottom edge, never hidden',
      'behind an object or the foreground. Small margin below the shoes.',
    )
  }
  if (opts.detailText?.trim()) {
    lines.push('', 'ADDITIONAL DIRECTION (from the brief):', opts.detailText.trim())
  }
  lines.push(
    '-----------------',
    closeup
      ? 'SCENE (the framing instructions above take precedence over any framing mentioned below):'
      : '',
    opts.decorDescription.trim(),
    '---------------',
    'TECHNICAL:',
    `Aspect ratio ${opts.ratio}. High resolution. Photorealistic.`,
  )
  if (opts.sku) lines.push(`Reference: ${opts.sku}.`)
  // supprime les lignes vides consécutives (les blocs optionnels peuvent en laisser)
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n')
}
