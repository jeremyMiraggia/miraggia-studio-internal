/**
 * Prompt Golden Silver — sous-onglet BACK.
 *
 *   IMAGE 1          = le visuel de FACE validé — colonne VISUEL OK FRONT (mannequin + décor + lumière à CONSERVER)
 *   IMAGE 2          = visage du mannequin (FACE PHOTO) — si le mannequin est connu
 *   IMAGES suivantes = la tenue vue de DOS (Files (Back)) — sans Files (Back) : voir buildGoldSilverDetailCloseupPrompt
 *   IMAGES suivantes = chaussures seules (photos de Files (Back) classées « chaussures ») — plein-pied uniquement
 * Prompt construit côté serveur (les nombres dépendent du classement des photos).
 *
 * Sortie : le même mannequin, dans le même décor, vu de dos, pose naturelle.
 */
/** Poses de dos (plein-pied) : une seule par visuel, tirée au hasard. */
export const BACK_POSES = [
  'Three-quarter back view, body turned about 45° away from the camera, walking away slowly, looking back over her shoulder at the camera, one arm swinging naturally.',
  'Three-quarter back view, body slightly angled, weight on one hip, one knee relaxed, one hand lightly touching her hair, face turned in soft profile.',
  'Three-quarter back view, one shoulder leaning on the wall, body angled toward the wall, head turned in profile, arms loose.',
  'Three-quarter back view mid-step, body angled to one side, one foot slightly behind, arms relaxed, shoulders soft, head tilted slightly down and to the side.',
]

export function buildGoldSilverBackPrompt(opts: {
  ratio: string
  sku?: string
  backCount?: number
  detailText?: string
  modelDescription?: string
  framing?: 'full' | 'closeup'   // closeup = gros plan de dos / mi-corps haut, jambes et chaussures hors cadre
  poseDirection?: string         // texte libre de l'onglet : REMPLACE la pose par défaut
  hasFace?: boolean              // IMAGE 2 = photo visage du mannequin
  poseIndex?: number             // plein-pied : index dans BACK_POSES (sinon pose 1)
  shoesCount?: number            // photos de chaussures seules (après la tenue)
}): string {
  const closeup = opts.framing === 'closeup'
  const pose = opts.poseDirection?.trim()
  const n = Math.max(1, opts.backCount ?? 1)
  const first = opts.hasFace ? 3 : 2
  const backLabel = n === 1 ? `IMAGE ${first}` : `IMAGES ${first} to ${first + n - 1}`
  const nShoes = closeup ? 0 : (opts.shoesCount ?? 0)
  const shoesLabel = nShoes === 1 ? `IMAGE ${first + n}` : `IMAGES ${first + n} to ${first + n + nShoes - 1}`
  const lines = [
    'EDITORIAL FASHION PHOTOGRAPH — BACK VIEW OF AN EXISTING SHOT',
    '',
    'REFERENCES (strict):',
    '- IMAGE 1 = the VALIDATED FRONT photograph of this look. It defines EVERYTHING that must',
    '  stay identical: the SAME model (identity, hair color/texture/length, skin tone,',
    '  build, height), the SAME location and background, the SAME light direction, time',
    '  of day, color palette, film look and grain, and the same photographic style and',
    '  distance to camera. Treat it as the previous frame of the same shoot, taken',
    '  seconds later from behind.',
    ...(opts.hasFace ? [
      '- IMAGE 2 = the MODEL FACE (front view), the same person as in IMAGE 1. Use it only to',
      '  keep her identity, hair color, texture and length exact. Not its light or background.',
    ] : []),
    `- ${backLabel} = the OUTFIT seen from the BACK. Reproduce the back of the garment`,
    '  exactly: back seams, closure (zip, buttons, ties), straps, neckline, waist, hem',
    '  length, fabric, color, print. No reinterpretation. The front of the garment is',
    '  the one worn in IMAGE 1 — this is the same outfit. Whoever wears it there is NOT',
    '  the model — take only the garment.',
    closeup
      ? '  SHOES: not part of this shot — the framing stops well above the legs.'
      : nShoes > 0
        ? `- ${shoesLabel} = the SHOES, the same pair as in IMAGE 1, here seen alone — use ${nShoes > 1 ? 'them' : 'it'} for the heel and back of the shoes.`
        : '  SHOES: exactly the same shoes as in IMAGE 1.',
  ]
  if (opts.modelDescription?.trim()) {
    lines.push(
      '  MODEL DESCRIPTION (must match IMAGE 1):',
      ...opts.modelDescription.trim().split('\n').map(l => `  ${l.trim()}`).filter(l => l.trim()),
    )
  }
  if (closeup) {
    lines.push(
      '',
      'OUTPUT — CLOSE-UP BACK: ONE photograph of the same model, in the same place, seen',
      'from BEHIND (full back view or a slight three-quarter back), framed as a CLOSE-UP /',
      'UPPER MID-BODY shot: from just above the head down to the waist/hips at most. The',
      'upper back of the garment (back neckline, collar, shoulders, back yoke, closure,',
      'print, fabric texture) is sharp and fully readable. Her hair is seen from behind,',
      'same color, texture and length as in IMAGE 1. Legs, feet and shoes are OUT of frame.',
      'The background is the SAME location as IMAGE 1, seen closer — same walls, materials,',
      'light direction and color palette; slight natural depth of field allowed. 85-105 mm',
      'portrait feel, natural headroom.',
    )
  } else {
    lines.push(
      '',
      'OUTPUT: ONE photograph of the same model, in the same place, seen from BEHIND',
      '(full back view or a slight three-quarter back). The back of the garment must be',
      'fully readable. FEET (non-negotiable): feet and shoes always fully visible, never',
      'cut by the frame. Full-length figure, small margin below the shoes. Same aspect',
      'ratio and framing distance as IMAGE 1.',
    )
  }
  // Pose : le texte saisi REMPLACE la pose par défaut (sinon la consigne « immobile » l'emporte)
  if (pose) {
    lines.push('', 'POSE & ADJUSTMENTS (art direction — takes priority over any default pose; the framing and garment fidelity above stay mandatory):', pose)
  } else {
    lines.push(
      '',
      closeup
        ? 'POSE: still, relaxed shoulders, head facing away or turned very slightly to the side (a hint of profile at most), arms loose. Calm and natural, never stiff.'
        : `POSE: ${BACK_POSES[Math.abs(opts.poseIndex ?? 0) % BACK_POSES.length]} Natural and alive, never stiff.`,
    )
  }
  if (opts.detailText?.trim()) {
    lines.push('', 'GARMENT DESCRIPTION (from the brief — follow it exactly, especially the lengths; it takes precedence over how the garment falls in the outfit photos):', opts.detailText.trim())
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
 * Prompt Golden Silver — sous-onglet BACK, ligne SANS Files (Back) mais avec DETAILS :
 * pas de dos possible → CLOSE-UP DE FACE du visuel validé, le gros plan DETAILS (détail de face) en guide de fidélité.
 *
 *   IMAGE 1          = le visuel de FACE validé (VISUEL OK FRONT)
 *   IMAGE 2          = visage du mannequin (si connu)
 *   IMAGES suivantes = gros plans DETAILS du même vêtement
 */
export function buildGoldSilverDetailCloseupPrompt(opts: {
  ratio: string
  sku?: string
  detailCount?: number
  detailText?: string
  modelDescription?: string
  poseDirection?: string
  hasFace?: boolean
}): string {
  const n = Math.max(1, opts.detailCount ?? 1)
  const first = opts.hasFace ? 3 : 2
  const detLabel = n === 1 ? `IMAGE ${first}` : `IMAGES ${first} to ${first + n - 1}`
  const pose = opts.poseDirection?.trim()
  const lines = [
    'EDITORIAL FASHION PHOTOGRAPH — FRONT CLOSE-UP OF AN EXISTING SHOT',
    '',
    'REFERENCES (strict):',
    '- IMAGE 1 = the VALIDATED FRONT photograph of this look. It defines EVERYTHING that',
    '  must stay identical: the SAME model (identity, hair, skin tone, makeup), the SAME',
    '  outfit, the SAME location and background, the SAME light direction, color palette,',
    '  film look and grain. Treat it as the same shoot: the photographer has simply',
    '  stepped closer.',
    ...(opts.hasFace ? [
      '- IMAGE 2 = the MODEL FACE (front view), the same person as in IMAGE 1. Use it only to',
      '  keep her identity exact and sharp at close range. Not its light or background.',
    ] : []),
    `- ${detLabel} = CLOSE-UP DETAIL${n > 1 ? 'S' : ''} of the front of the same garment. Use ${n > 1 ? 'them' : 'it'} to`,
    '  reproduce the fabric texture, color, print, stitching, buttons and finishes',
    '  faithfully at close range. Do not copy its framing or background.',
  ]
  if (opts.modelDescription?.trim()) {
    lines.push('  MODEL DESCRIPTION (must match IMAGE 1):', ...opts.modelDescription.trim().split('\n').map(l => `  ${l.trim()}`).filter(l => l.trim()))
  }
  lines.push(
    '',
    'OUTPUT — CLOSE-UP FRONT: ONE photograph of the same model, in the same place, seen',
    'from the FRONT, framed as a CLOSE-UP / UPPER MID-BODY shot: from just above the head',
    'down to the waist/hips at most. The face and the upper part of the garment (neckline,',
    'shoulders, sleeves, chest, print, finishes) are sharp and fully readable. Legs, feet',
    'and shoes are OUT of frame. Same background as IMAGE 1, seen closer; slight natural',
    'depth of field allowed. 85-105 mm portrait feel, natural headroom.',
    '',
    pose
      ? `POSE & ADJUSTMENTS (art direction — the framing and garment fidelity above stay mandatory):\n${pose}`
      : 'POSE: relaxed, shoulders soft, calm gaze to camera, mouth closed — consistent with IMAGE 1.',
  )
  if (opts.detailText?.trim()) {
    lines.push('', 'GARMENT DESCRIPTION (from the brief — follow it exactly):', opts.detailText.trim())
  }
  lines.push(
    '---------------',
    'TECHNICAL:',
    `Aspect ratio ${opts.ratio}. High resolution. Photorealistic. Same film stock, grain and color rendering as IMAGE 1.`,
  )
  if (opts.sku) lines.push(`Reference: ${opts.sku}.`)
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n')
}

/**
 * Prompt Golden Silver — sous-onglet PROFIL → FACE.
 *
 *   IMAGE 1        = le visuel de PROFIL validé — colonne VISUELS OK (mannequin + décor + lumière à CONSERVER)
 *   IMAGE 2        = visage du mannequin (FACE PHOTO) — si le mannequin est connu (colonne Model ou choix manuel)
 *   IMAGES suivantes = la tenue portée par une autre personne — Files (Front) puis PROFIL (chaussures seules retirées :
 *                    le mannequin garde celles de l'IMAGE 1). Prompt construit côté serveur (n dépend du classement).
 *
 * Sortie : le même mannequin, dans le même décor, vu de face.
 */
export function buildGoldSilverProfileToFrontPrompt(opts: {
  ratio: string
  sku?: string
  outfitCount?: number
  detailText?: string
  modelDescription?: string
  framing?: 'full' | 'closeup'
  poseDirection?: string         // texte libre de l'onglet : REMPLACE la pose par défaut
  hasFace?: boolean              // IMAGE 2 = photo visage du mannequin (FACE PHOTO)
}): string {
  const closeup = opts.framing === 'closeup'
  const pose = opts.poseDirection?.trim()
  const n = Math.max(1, opts.outfitCount ?? 1)
  const first = opts.hasFace ? 3 : 2
  const outfitLabel = n === 1 ? `IMAGE ${first}` : `IMAGES ${first} to ${first + n - 1}`
  const lines = [
    'EDITORIAL FASHION PHOTOGRAPH — FRONT VIEW OF AN EXISTING SHOT',
    '',
    'REFERENCES (strict):',
    '- IMAGE 1 = the VALIDATED PROFILE photograph of this look. It defines EVERYTHING that',
    '  must stay identical: the SAME model (face, identity, hair color/texture/length, skin',
    '  tone, build, height), the SAME location and background, the SAME light direction,',
    '  time of day, color palette, film look and grain, and the same photographic style and',
    '  distance to camera. Treat it as the previous frame of the same shoot: she has just',
    '  turned to face the camera.',
    ...(opts.hasFace ? [
      '- IMAGE 2 = the MODEL FACE, seen from the front: the SAME person as in IMAGE 1. Use it',
      '  for her exact facial features now that she faces the camera — face shape, eyes and eye',
      '  color, eyebrows, nose, lips, freckles/marks, hairline. Do not copy its light, background',
      '  or framing: light, hair styling and scene come from IMAGE 1.',
    ] : []),
    `- ${outfitLabel} = the OUTFIT, worn by ANOTHER person (front view${n > 1 ? ', plus other angles of the same pieces' : ''}). Reproduce the`,
    '  front of the garment exactly: neckline, closure, buttons, pockets, seams, waist,',
    '  sleeve and hem length, fabric, color, print. No reinterpretation. It is the same',
    '  garment as the one worn in IMAGE 1. Take ONLY the garment: that person is NOT the',
    '  model — ignore her face, hair, skin tone, arms, hands, legs and body. All visible',
    '  skin is the model’s own, as in IMAGE 1.',
    closeup
      ? '  SHOES: not part of this shot — the framing stops well above the legs.'
      : '  SHOES: exactly the same shoes as in IMAGE 1.',
  ]
  if (opts.modelDescription?.trim()) {
    lines.push(
      `  MODEL DESCRIPTION (must match IMAGE 1${opts.hasFace ? ' and IMAGE 2' : ''}):`,
      ...opts.modelDescription.trim().split('\n').map(l => `  ${l.trim()}`).filter(l => l.trim()),
    )
  }
  if (closeup) {
    lines.push(
      '',
      'OUTPUT — CLOSE-UP FRONT: ONE photograph of the same model, in the same place, seen',
      'from the FRONT, framed as a CLOSE-UP / UPPER MID-BODY shot: from just above the head',
      'down to the waist/hips at most. Her face is sharp, fully visible and unmistakably the',
      `model of IMAGE 1${opts.hasFace ? ', with the facial features of IMAGE 2' : ''}. The upper front of the garment (neckline, shoulders, chest, print,`,
      'fabric texture) is sharp and fully readable. Legs, feet and shoes are OUT of frame.',
      'The background is the SAME location as IMAGE 1 — same walls, materials, light',
      'direction and color palette. 85-105 mm portrait feel, natural headroom.',
    )
  } else {
    lines.push(
      '',
      'OUTPUT: ONE photograph of the same model, in the same place, seen from the FRONT,',
      `face fully visible and unmistakably the model of IMAGE 1${opts.hasFace ? ' (features of IMAGE 2)' : ''}. The front of the garment`,
      'must be fully readable. FEET: feet and shoes fully visible, never cut by the frame.',
      'Full-length figure, small margin below the shoes. Same aspect ratio and framing',
      'distance as IMAGE 1.',
    )
  }
  if (pose) {
    lines.push('', 'POSE & ADJUSTMENTS (art direction — takes priority over any default pose; the framing and garment fidelity above stay mandatory):', pose)
  } else {
    lines.push(
      '',
      'POSE: facing the camera, relaxed and composed — weight on one leg, shoulders relaxed, arms loose or one hand lightly resting, calm gaze to camera, mouth closed. Natural, never stiff.',
    )
  }
  if (opts.detailText?.trim()) {
    lines.push('', 'GARMENT DESCRIPTION (from the brief — follow it exactly, especially the lengths; it takes precedence over how the garment falls in the outfit photos):', opts.detailText.trim())
  }
  lines.push(
    '---------------',
    'TECHNICAL:',
    `Aspect ratio ${opts.ratio}. High resolution. Photorealistic. Same film stock, grain and color rendering as IMAGE 1.`,
  )
  if (opts.sku) lines.push(`Reference: ${opts.sku}.`)
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n')
}

/**
 * Texte du décor Notion envoyé TEL QUEL : seuls les numéros d'image sont adaptés.
 * Convention Notion : « image 1 » = la tenue, « image 2 » = le mannequin.
 * Dans Zulo : IMAGE 1 = visage du mannequin, (IMAGE 2 = corps), puis la tenue.
 * Les autres numéros (« image 3 »…) ne sont pas touchés.
 */
export function renumberDecor(decor: string, labels: { model: string; outfit: string }): string {
  return decor.replace(/\bimages?\s*(\d+)\b/gi, (m, n: string) => n === '1' ? labels.outfit : n === '2' ? labels.model : m)
}

/**
 * MODE BRUT (vue de face) : le texte du décor Notion seul, numéros d'image adaptés,
 * + la colonne Description. Aucun bloc ajouté par Zulo (les légendes d'image sont ajoutées par la route).
 */
export function buildGoldSilverRawPrompt(opts: {
  decorDescription: string
  outfitLabel: string   // ex. « IMAGE 3 » ou « IMAGES 3 à 4 »
  detailText?: string
  closeup?: boolean
}): string {
  const lines = [renumberDecor(opts.decorDescription, { model: 'IMAGE 1', outfit: opts.outfitLabel }).trim()]
  if (opts.detailText?.trim()) lines.push('', `DESCRIPTION DU VÊTEMENT : ${opts.detailText.trim()}`)
  if (opts.closeup) lines.push('', 'CADRAGE : gros plan, de la tête à la taille, jambes et chaussures hors cadre.')
  return lines.join('\n')
}

/**
 * Prompt Golden Silver — bloc REFERENCES fixe + description du décor (Notion) + bloc TECHNICAL.
 *
 * Ordre des images envoyées (le mannequin toujours en premier) :
 *   IMAGE 1          = visage du mannequin (FACE PHOTO)
 *   IMAGE 2          = corps du mannequin (FRONT-model) — optionnel, décale la suite s'il manque
 *   IMAGES suivantes = photos de la tenue (Files (Front)) — n ≥ 1
 *   IMAGES suivantes = chaussures à porter (photo de Files (Front) classée « chaussures seules ») — optionnel
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
  shoesCount?: number   // photos de chaussures seules, séparées de la tenue
  hasBody?: boolean
  detailCount?: number
  modelDescription?: string   // description courte du mannequin (générée une fois, réutilisée)
  framing?: 'full' | 'closeup'   // closeup = gros plan / mi-corps haut, chaussures ignorées
}): string {
  const closeup = opts.framing === 'closeup'
  const nOut = Math.max(1, opts.outfitCount ?? 1)
  const nDet = opts.detailCount ?? 0
  const bodyIdx = opts.hasBody ? 2 : null
  const firstOutfit = (bodyIdx ?? 1) + 1
  const nShoes = closeup ? 0 : (opts.shoesCount ?? 0)
  const firstShoes = firstOutfit + nOut
  const shoesLabel = nShoes === 1 ? `IMAGE ${firstShoes}` : `IMAGES ${firstShoes} to ${firstShoes + nShoes - 1}`
  const firstDetail = firstShoes + nShoes
  const outfitLabel = nOut === 1 ? `IMAGE ${firstOutfit}` : `IMAGES ${firstOutfit} to ${firstOutfit + nOut - 1}`
  const detailLabel = nDet === 1 ? `IMAGE ${firstDetail}` : `IMAGES ${firstDetail} to ${firstDetail + nDet - 1}`
  const title = opts.decorName.trim().toUpperCase()

  const lines = [
    `EDITORIAL FASHION PHOTOGRAPH — ${title} SERIES`,
    '',
    'REFERENCES (strict):',
    '- IMAGE 1 = MODEL FACE. Preserve identity exactly: same face, facial structure,',
    '  eyes, eyebrows, lips, skin tone and undertone, freckles/marks, hair color,',
    '  texture and length. She must be unmistakably the same person. Keep her',
    '  natural skin — visible pores and texture, no retouching.',
  ]
  if (opts.modelDescription?.trim()) {
    lines.push(
      '  MODEL DESCRIPTION (must match IMAGE 1 — if the generated face deviates from this, it is wrong):',
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
    `- STATURE: she is a tall fashion model with natural, realistic human proportions${bodyIdx ? `, as in IMAGE ${bodyIdx}` : ''}.`,
    nOut === 1
      ? `- ${outfitLabel} = OUTFIT, front view. Reproduce the garment exactly: same cut,`
      : `- ${outfitLabel} = THE SAME OUTFIT, several photos of it. Combine them into ONE faithful garment: same cut,`,
    '  silhouette, fabric texture, drape, color, print, seams, buttons, sleeve and',
    '  hem length. No reinterpretation, no added accessories, no altered color.',
    '  Take ONLY the garment from it: whoever wears it there is NOT the model — ignore her skin',
    '  tone, arms, hands, legs and body. All visible skin is the model’s own, as in IMAGE 1.',
    ...(closeup
      ? ['  SHOES: not part of this shot — the framing stops well above the feet.']
      : nShoes > 0
        ? [`- ${shoesLabel} = SHOES. The model wears EXACTLY these shoes — same model, color and`,
           '  material — whatever shoes or bare feet appear in the outfit photos. Never replace them.']
        : [`  SHOES: the model wears EXACTLY the same shoes as in ${outfitLabel} — same model,`,
           '  same color, same material. Never replace them.']),
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
      'garment fully readable. Framing and pose: as described in the scene below.',
    )
  }
  if (opts.detailText?.trim()) {
    lines.push('', 'GARMENT DESCRIPTION (from the brief — follow it exactly, especially the lengths; it takes precedence over how the garment falls in the outfit photos):', opts.detailText.trim())
  }
  lines.push(
    '-----------------',
    closeup
      ? 'SCENE (the framing instructions above take precedence over any framing mentioned below):'
      : '',
    renumberDecor(opts.decorDescription, { model: 'IMAGE 1', outfit: outfitLabel.replace(' to ', ' à ') }),
    '---------------',
    'TECHNICAL:',
    `Aspect ratio ${opts.ratio}. High resolution. Photorealistic.`,
  )
  if (opts.sku) lines.push(`Reference: ${opts.sku}.`)
  // supprime les lignes vides consécutives (les blocs optionnels peuvent en laisser)
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n')
}
