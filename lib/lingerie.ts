/**
 * Onglet 🩱 Lingerie — mannequins décrits en TEXTE uniquement (aucune photo de
 * mannequin envoyée : Gemini bloque la lingerie portée par une personne réelle en
 * référence) + cadrage strict par type de produit, coupé à la bouche (pas de regard).
 *
 * Chaque mannequin = une identité (âge, origine, peau, bouche, ongles) + ses cheveux
 * + 3 morphologies au choix (mince / middle / ronde).
 */

export type LingerieType = 'ensemble' | 'pyjama' | 'haut' | 'bas'
export type Morpho = 'mince' | 'middle' | 'ronde'

export type LingerieModel = {
  id: string
  name: string
  /** Âge, origine, peau, bouche, menton, ongles — commun aux 3 morphologies */
  identity: string
  /** Cheveux : visibles, passés derrière les épaules, dans le dos */
  hair: string
  bodies: Record<Morpho, string>
}

export const LINGERIE_TYPES: { id: LingerieType; label: string; hint: string; ratio: string }[] = [
  { id: 'ensemble', label: 'Ensemble lingerie', hint: 'bouche → haut des cuisses', ratio: '3:4' },
  { id: 'pyjama',   label: 'Pyjama',            hint: 'bouche → pieds',            ratio: '2:3' },
  { id: 'haut',     label: 'Lingerie haut',     hint: 'bouche → ventre',           ratio: '4:5' },
  { id: 'bas',      label: 'Lingerie bas',      hint: 'ventre → haut des cuisses', ratio: '4:5' },
]

export const MORPHOS: { id: Morpho; label: string; size: string }[] = [
  { id: 'mince',  label: 'Mince',  size: '34-36 / XS-S' },
  { id: 'middle', label: 'Middle', size: '38-40 / M' },
  { id: 'ronde',  label: 'Ronde',  size: '44-46 / XL' },
]

/** 5 mannequins par défaut — adultes, décrits pour un cadrage sans les yeux. */
export const DEFAULT_LINGERIE_MODELS: LingerieModel[] = [
  {
    id: 'clara', name: 'Clara',
    identity: 'Adult woman, 28 years old, Northern European, height 1.77 m. Fair skin with a warm neutral undertone and a few light freckles on the shoulders and upper chest. Soft oval jaw, natural pink lips with a subtle defined cupid\'s bow, closed mouth, soft neutral expression. Short natural nails with a nude polish. No tattoos, no piercings, no jewelry.',
    hair: 'Long straight light-brown hair, clearly visible in the image: it frames both sides of the neck and is swept BEHIND the shoulders, falling down her back. No strand falls in front of the shoulders, over the chest or over the product.',
    bodies: {
      mince:  'SLIM body (French size 34-36 / XS-S): long neck, straight narrow shoulders, visible collarbones, small bust, flat stomach, narrow waist, slim straight hips, long slender legs with slim thighs.',
      middle: 'MEDIUM body (French size 38-40 / M): straight shoulders, medium natural bust, soft flat stomach, defined waist, gently rounded hips, toned natural thighs. Balanced, healthy everyday silhouette.',
      ronde:  'PLUS-SIZE CURVY body (French size 44-46 / XL): soft rounded shoulders and arms, full bust, softly rounded stomach, wide rounded hips, full soft thighs. Natural realistic skin with soft curves, confident healthy plus-size catalogue model.',
    },
  },
  {
    id: 'amina', name: 'Amina',
    identity: 'Adult woman, 30 years old, West African descent, height 1.79 m. Deep brown skin with a rich warm undertone and an even natural satin finish. Strong elegant jawline, full lips in a natural mauve-brown tone, relaxed closed mouth. Short natural nails, no polish. No tattoos, no piercings, no jewelry.',
    hair: 'Long black box braids reaching mid-back, clearly visible in the image: they frame both sides of the neck and are gathered BEHIND the shoulders, falling down her back. No braid falls in front of the shoulders, over the chest or over the product.',
    bodies: {
      mince:  'SLIM body (French size 34-36 / XS-S): graceful long neck, slender shoulders, small high bust, flat toned stomach, narrow waist, slim hips, very long slender legs.',
      middle: 'MEDIUM body (French size 38-40 / M): rounded shoulders, medium bust, slim toned stomach, clearly defined waist, curved hips, long toned legs with natural thighs.',
      ronde:  'PLUS-SIZE CURVY body (French size 44-46 / XL): full rounded shoulders and arms, full generous bust, soft rounded stomach, marked waist, wide curvy hips, full thighs. Natural realistic skin with soft curves, confident healthy plus-size catalogue model.',
    },
  },
  {
    id: 'lea', name: 'Léa',
    identity: 'Adult woman, 32 years old, Mediterranean (Southern French / Italian), height 1.72 m. Olive skin with a golden undertone. Soft rounded chin, full natural lips in a warm rosy-beige tone, calm closed-mouth expression. Short almond nails with a soft beige polish. No tattoos, no piercings, no jewelry.',
    hair: 'Long dark-brown wavy hair reaching the shoulder blades, clearly visible in the image: it frames both sides of the neck and is pushed BEHIND the shoulders, falling down her back. No lock falls in front of the shoulders, over the chest or over the product.',
    bodies: {
      mince:  'SLIM body (French size 34-36 / XS-S): delicate shoulders, small bust, flat stomach, slim waist, slightly curved narrow hips, slender legs.',
      middle: 'MEDIUM HOURGLASS body (French size 38-40 / M): soft rounded shoulders, medium-full bust, defined waist, soft natural stomach, rounded hips, natural full thighs.',
      ronde:  'PLUS-SIZE HOURGLASS body (French size 44-46 / XL): soft rounded shoulders and arms, full bust, defined waist, softly rounded stomach, generous rounded hips and full thighs. Natural realistic skin with soft curves, confident healthy plus-size catalogue model.',
    },
  },
  {
    id: 'mei', name: 'Mei',
    identity: 'Adult woman, 27 years old, East Asian, height 1.71 m. Light skin with a warm peach undertone, smooth even complexion. Fine delicate chin, small well-defined lips in a natural soft rose tone, serene closed-mouth expression. Short natural nails with a clear gloss. No tattoos, no piercings, no jewelry.',
    hair: 'Very long straight black hair reaching the middle of the back, clearly visible in the image: it frames both sides of the neck and falls BEHIND the shoulders, down her back. No strand falls in front of the shoulders, over the chest or over the product.',
    bodies: {
      mince:  'SLIM PETITE body (French size 34 / XS): delicate collarbones, narrow shoulders, small bust, flat stomach, very slim waist, straight narrow hips, slender legs.',
      middle: 'MEDIUM body (French size 38-40 / M): soft shoulders, medium bust, soft flat stomach, defined waist, gently rounded hips, natural soft thighs.',
      ronde:  'PLUS-SIZE CURVY body (French size 44-46 / XL): soft rounded shoulders and arms, full bust, softly rounded stomach, wide rounded hips, full soft thighs. Natural realistic skin with soft curves, confident healthy plus-size catalogue model.',
    },
  },
  {
    id: 'sofia', name: 'Sofia',
    identity: 'Adult woman, 31 years old, Latin American, height 1.75 m. Light tan skin with a golden-honey undertone. Softly defined jaw, medium-full lips in a natural caramel-rose tone, relaxed closed-mouth expression. Short natural nails with a nude-pink polish. No tattoos, no piercings, no jewelry.',
    hair: 'Long dark-brown hair with soft loose waves, reaching below the shoulder blades, clearly visible in the image: it frames both sides of the neck and is swept BEHIND the shoulders, falling down her back. No lock falls in front of the shoulders, over the chest or over the product.',
    bodies: {
      mince:  'SLIM ATHLETIC body (French size 34-36 / XS-S): defined shoulders, small bust, flat toned stomach with subtle muscle definition, narrow waist, slim hips, lean toned legs.',
      middle: 'MEDIUM ATHLETIC-CURVY body (French size 38-40 / M): defined shoulders, medium-full bust, toned stomach, marked waist, rounded hips, strong toned thighs.',
      ronde:  'PLUS-SIZE CURVY body (French size 44-46 / XL): full shoulders and arms, full bust, softly rounded stomach, marked waist, wide rounded hips, full strong thighs. Natural realistic skin with soft curves, confident healthy plus-size catalogue model.',
    },
  },
]

export const DEFAULT_LINGERIE_BACKGROUND =
  'Seamless light warm-grey studio backdrop (#E9E6E2), plain and uniform, no props, no furniture. Soft, even, diffused front lighting from a large softbox, gentle natural shadows that model the body, no harsh contrast, no colored light.'

const PRODUCT_LABEL: Record<LingerieType, string> = {
  ensemble: 'a lingerie set (bra / top AND matching briefs)',
  pyjama:   'a pyjama / sleepwear set',
  haut:     'a bra (top only)',
  bas:      'briefs (bottom only)',
}

const MOUTH_TOP =
  'TOP EDGE of the frame cuts horizontally across the model\'s MOUTH: the lips and chin are visible at the very top of the image; the nose, eyes, forehead and top of the head are OUTSIDE the frame. Never show the eyes. The hair IS visible on both sides of the neck, going behind the shoulders into the back.'

const FRAMING: Record<LingerieType, string> = {
  ensemble: `${MOUTH_TOP} BOTTOM EDGE of the frame at the UPPER THIGHS, a few centimetres below the bottom of the briefs. Knees and lower legs are OUTSIDE the frame. The complete set — top AND briefs — is entirely visible. Shoulders, arms and hands are in frame.`,
  pyjama:   `${MOUTH_TOP} BOTTOM EDGE of the frame just below the FEET: the model is shown from the mouth down to the feet, both feet entirely visible (standing on, or resting on, the floor) with a small margin around them. The complete pyjama — top AND bottom — is entirely visible. Barefoot.`,
  haut:     `${MOUTH_TOP} BOTTOM EDGE of the frame at the BELLY, around navel level, a little below the bottom band of the bra. Hips, briefs and legs are OUTSIDE the frame. The bra is entirely visible, including straps and bottom band. Shoulders and upper arms are in frame.`,
  bas:      'TOP EDGE of the frame at the BELLY, just above the navel. The chest, bust and everything above the stomach are OUTSIDE the frame. BOTTOM EDGE of the frame at the UPPER THIGHS, a few centimetres below the bottom of the briefs. Knees and lower legs are OUTSIDE the frame. The briefs are entirely visible, including waistband and leg openings; hands never cover them.',
}

/**
 * Cadrage LARGE (pose dynamique / pose libre) : Gemini génère tête comprise, le Studio coupe
 * ensuite sous le nez (lib/lingerieCrop.ts). Pas pour « bas » : il faudrait générer le buste nu.
 */
const WIDE_HEAD =
  'Her whole head, face and hair are INSIDE the frame, with a little space above the head: the image will be cropped afterwards, so do not crop it yourself. Natural relaxed face, mouth closed.'

const WIDE_BODY = 'from slightly above the top of her head down to just below the knees (if she is seated or kneeling: down to the floor)'

const WIDE_FRAMING: Record<LingerieType, string> = {
  ensemble: `Show the model ${WIDE_BODY}. ${WIDE_HEAD} The complete set — top AND briefs — is entirely visible. The body fills the frame, with only a small margin on the sides.`,
  pyjama:   `Full figure, from slightly above the top of her head down to below the feet, both feet entirely visible with a small margin. ${WIDE_HEAD} The complete pyjama — top AND bottom — is entirely visible. Barefoot. The body fills the frame, with only a small margin on the sides.`,
  haut:     `Show the model ${WIDE_BODY}. ${WIDE_HEAD} The bra is entirely visible, including straps and bottom band. The body fills the frame, with only a small margin on the sides.`,
  bas:      `Show the model ${WIDE_BODY}. ${WIDE_HEAD} The briefs are entirely visible, including waistband and leg openings. The body fills the frame, with only a small margin on the sides.`,
}

/**
 * En cadrage large, la partie NON vendue doit être couverte (sinon Gemini génère le corps nu) :
 * vêtement neutre couleur peau, toujours supprimé par le recadrage (ventre / cuisses).
 */
const COVER: Partial<Record<LingerieType, string>> = {
  haut: 'Below the bra she also wears plain, seamless, skin-tone briefs. They are NOT part of the product and will be cropped out of the final visual.',
  bas:  'Above the briefs she also wears a plain, seamless, skin-tone bralette. It is NOT part of the product and will be cropped out of the final visual.',
}

const GEMINI_RATIOS = ['9:16', '2:3', '3:4', '4:5', '1:1', '5:4', '4:3', '3:2', '16:9', '21:9']
const rv = (r: string) => { const [a, b] = r.split(':').map(Number); return a / b }

/** Cadrage large = pose dynamique ou pose libre : Gemini génère tête comprise, le Studio recadre. */
export const isWideFraming = (_type: LingerieType, poseMode: PoseMode | undefined, direction?: string) =>
  poseMode === 'dynamique' || !!direction?.trim()

/**
 * Ratio de génération en cadrage large. Pyjama : la coupe ne retire que la tête (~10 %) → ratio un peu
 * plus haut que la cible. Autres types : on garde une petite partie de l'image → 2:3 laisse toute la marge.
 */
export function generationRatio(target: string, type: LingerieType): string {
  const need = type === 'pyjama' ? rv(target) * 0.9 : Math.min(rv(target), 2 / 3)
  return GEMINI_RATIOS.filter(r => rv(r) >= need).sort((a, b) => rv(a) - rv(b))[0] ?? target
}

/* ============================== Poses ============================== */

export type PoseMode = 'neutre' | 'dynamique'

/**
 * Poses « dynamiques » inspirées des shootings lingerie e-commerce (assise au sol en appui,
 * agenouillée main sur le genou, déhanché, main sur la bretelle…). Le cadrage reste coupé à la bouche.
 */
export const DYNAMIC_POSES: { id: string; label: string; types: LingerieType[]; text: string }[] = [
  // Textes = mécanique du corps précise (poids, angles, genoux/coudes pliés) : une description vague donne une pose droite.
  { id: 'hanche', label: 'Déhanché marqué, main sur la hanche', types: ['ensemble', 'pyjama', 'haut', 'bas'],
    text: 'Strong contrapposto: ALL her weight on the back leg, the hip pushed clearly out to the side; the free leg bent, knee turned inward, heel lifted. Shoulders tilted the opposite way to the hips (one shoulder clearly lower), torso leaning slightly toward the dropped shoulder. One hand on the pushed-out hip with the elbow pointing outward; the other arm bent, hand resting on the front of the upper thigh. A clear S-curve runs through the whole body.' },
  { id: 'trois-quarts', label: 'Trois-quarts, regard par-dessus l\'épaule', types: ['ensemble', 'pyjama', 'haut', 'bas'],
    text: 'Body rotated about 45° away from the camera, then the shoulders twisted back toward the lens; the near knee bent and crossing in front of the other leg, back gently arched, chin turned toward the camera over the near shoulder. Arms bent: one hand resting on the opposite thigh, the other hand at the waist. The twist between hips and shoulders must be clearly visible.' },
  { id: 'cheveux', label: 'Bras levés, mains dans les cheveux', types: ['ensemble', 'pyjama', 'haut'],
    text: 'Both arms raised: one hand lifting the hair at the back of the neck with the elbow high and pointing out to the side, the other hand touching the hair near the opposite shoulder. Ribcage lifted, torso slightly twisted, hips shifted to one side, one knee bent and turned inward. Relaxed and candid, as if caught fixing her hair.' },
  { id: 'bretelle', label: 'Doigt sous la bretelle / la ceinture', types: ['ensemble', 'haut', 'bas'],
    text: 'One finger hooked lightly under the shoulder strap (or the side of the briefs\' waistband), lifting it a few millimetres — a playful, fleeting gesture; the product stays intact and fully visible. The shoulder on that side raised and rolled slightly forward, the other hand on the waist with the elbow out, hips angled away from the camera, weight on one leg, opposite knee bent.' },
  { id: 'marche', label: 'En marche, pas en avant', types: ['ensemble', 'pyjama', 'bas'],
    text: 'Mid-stride, walking toward the camera: the front leg crossing slightly in front of the back leg, front knee bent, back heel lifted off the floor; hips swinging to one side, arms in natural opposite motion (one forward, one back, elbows soft), hair moving slightly. A visible sense of movement, the product still sharp.' },
  { id: 'assise-sol', label: 'Assise au sol, en appui sur un bras', types: ['ensemble', 'pyjama', 'haut', 'bas'],
    text: 'Sitting on the floor, the camera at her chest height: she props herself on one straight arm placed on the floor beside and slightly behind her hip, the other hand resting on her raised knee. One knee up, the other leg folded to the side on the floor, knees together. Torso upright with a slight diagonal, shoulders at an angle, torso turned toward the camera. Relaxed, casual sitting pose.' },
  { id: 'genou', label: 'Un genou au sol, main sur le genou levé', types: ['ensemble', 'haut', 'bas'],
    text: 'Kneeling on one knee with the other leg bent forward, foot flat on the floor; sitting back slightly. One hand resting on the raised knee, the other hand on the hip or touching the hair. Torso leaning forward a little, shoulders angled, a strong diagonal line from the shoulder to the knee.' },
  { id: 'assise-talons', label: 'Assise de côté sur les talons', types: ['ensemble', 'pyjama', 'bas'],
    text: 'Sitting sideways on her heels on the floor, both legs folded to one side, hips turned three-quarters; one hand placed on the floor beside her for support, the other hand on her thigh. Torso twisted back toward the camera, one shoulder lower than the other, a soft curve through the waist.' },
]

/** Règles communes à toutes les poses dynamiques (ce qui fait la différence avec une pose droite). */
const DYNAMIC_RULES =
  'BODY LANGUAGE RULES (mandatory): asymmetry everywhere — the shoulders are NOT level, the hips are NOT level, the weight is clearly on one side; at least one knee and one elbow are bent; the torso is angled, leaning or twisted relative to the camera, never square to the lens. Natural, relaxed and confident, as if the photographer caught her between two movements. ' +
  'AVOID: standing straight and stiff, a symmetrical stance, arms hanging straight along the body, feet side by side, torso facing the camera squarely, mannequin-like rigidity.'

export function posesFor(type: LingerieType) { return DYNAMIC_POSES.filter(p => p.types.includes(type)) }

/** Tire une pose dynamique compatible avec le type (différente de `exclude` si possible). */
export function pickPose(type: LingerieType, exclude?: string): string {
  const pool = posesFor(type)
  const choices = pool.length > 1 ? pool.filter(p => p.id !== exclude) : pool
  return choices[Math.floor(Math.random() * choices.length)].id
}

export function ratioFor(type: LingerieType): string {
  return LINGERIE_TYPES.find(t => t.id === type)?.ratio ?? '3:4'
}

export function buildLingeriePrompt(o: {
  type: LingerieType
  model: LingerieModel
  morpho: Morpho
  imageCount: number
  background: string
  /** Une image de fond est envoyée APRÈS les photos produit (IMAGE imageCount+1) */
  hasBackgroundImage?: boolean
  direction?: string
  ratio: string
  poseMode?: PoseMode
  poseId?: string
  /** Un croquis de pose (bonhomme bâton) est envoyé en DERNIÈRE image */
  hasPoseSketch?: boolean
}): string {
  const imgs = o.imageCount > 1 ? `IMAGES 1 to ${o.imageCount}` : 'IMAGE 1'
  const dyn = o.poseMode === 'dynamique' ? (DYNAMIC_POSES.find(p => p.id === o.poseId && p.types.includes(o.type)) ?? posesFor(o.type)[0]) : null
  const custom = o.direction?.trim()
  const wide = isWideFraming(o.type, o.poseMode, o.direction)
  const sketchIdx = o.imageCount + (o.hasBackgroundImage ? 1 : 0) + 1
  const sketchLine = dyn && !custom && o.hasPoseSketch
    ? `\nPOSE DIAGRAM — IMAGE ${sketchIdx} is a stick-figure diagram of this pose (a drawing, not a person, not a style reference). Reproduce its body pose closely: torso angle, head tilt, where the weight is, the positions of arms, hands, legs and feet, which knees and elbows bend. A mirrored version is fine. Ignore its proportions, line style and white background.`
    : ''

  // Priorité : texte « Pose & attitude » > pose dynamique tirée > pose catalogue neutre.
  // La pose (texte libre ou dynamique) est placée AVANT le cadrage : placée après, Gemini garde la pose droite.
  const poseBlock = custom
    ? `POSE, ATTITUDE & MOOD — follow this art direction closely, it takes priority over any default catalogue pose. Only the framing and the product fidelity stay mandatory; ${wide ? 'the image will be cropped just below the nose afterwards, so the eyes and gaze will not appear in the final visual' : 'anything described for parts outside the frame (eyes, gaze, top of the head) is simply not shown'}. Hands never hide the product.\n${custom}`
    : dyn
      ? `POSE (essential to this image) — a DYNAMIC lingerie-campaign pose like contemporary lingerie e-commerce shoots, NOT a static catalogue stance:\n${dyn.text}${sketchLine}\n${DYNAMIC_RULES}\nConfident and elegant, never vulgar; the product stays fully visible and unobstructed.`
      : null

  return [
    custom || dyn
      ? 'Professional lingerie campaign photograph for a brand\'s online catalogue, editorial e-commerce style with a natural, dynamic pose. Tasteful, elegant and non-suggestive: the product stays clearly visible on the body.'
      : 'Professional e-commerce product photograph for a lingerie brand\'s online catalogue. Tasteful, elegant and commercial — the style of a department-store product page. Neutral and non-suggestive: the purpose is to show the product clearly on the body.',
    '',
    `PRODUCT — ${imgs}: product packshot${o.imageCount > 1 ? 's' : ''} of ${PRODUCT_LABEL[o.type]}. ${o.imageCount > 1 ? 'These images show' : 'This image shows'} the product only, with no model. Reproduce the product with absolute fidelity: exact color, fabric, lace pattern, transparency level, cut, coverage, straps, hooks, underwire, seams, trims, elastic bands, prints and logos. Same coverage as the product — do not make it smaller or more revealing, do not add or remove any part. The product is fitted to the model's body size. ${wide && COVER[o.type] ? COVER[o.type] : `The model wears ONLY this product${o.type === 'haut' || o.type === 'bas' ? ' (anything else stays outside the frame)' : ''}.`}`,
    '',
    ...(poseBlock ? [poseBlock, ''] : []),
    `MODEL — described in text only, there is no reference photo of her. ${o.model.identity}`,
    `BODY — ${o.model.bodies[o.morpho]} Respect this body type exactly, do not slim it down or enlarge it.`,
    `HAIR — ${o.model.hair}`,
    'SKIN — realistic natural texture with subtle pores, even skin tone over the whole body, no plastic retouching look.',
    '',
    wide
      ? `FRAMING — ${WIDE_FRAMING[o.type]} The framing follows the pose (standing, twisted, seated or kneeling): it never forces a frontal, upright stance.`
      : `FRAMING (STRICT, non-negotiable) — ${FRAMING[o.type]}` +
        (poseBlock ? ' The crop is defined on her body and follows the pose (standing, twisted, seated or kneeling): it does not force a frontal, upright stance. A slight head tilt is fine; the eyes are never visible.' : ''),
    '',
    ...(poseBlock ? [] : ['POSE — standing, facing the camera, relaxed and natural catalogue pose, weight slightly on one leg. Arms relaxed along the body or one hand lightly on the hip; hands never cover the product. Calm, neutral attitude.', '']),
    o.hasBackgroundImage
      ? [
          `BACKGROUND — IMAGE ${o.imageCount + 1} is the BACKGROUND / LOCATION reference (it contains no model and no product). Reproduce this exact place behind the model: same walls, floor, materials, textures, colors, furniture and objects, same light direction, color temperature and ambience. Keep its look exactly — do not redesign, recolor, add or remove elements. Only the viewpoint adapts to the framing above (seen closer, cropped like the shot), with natural perspective and the model placed naturally in the space, lit by the same light, with a soft natural contact shadow where relevant.`,
          // Notes texte seulement si l'utilisateur a écrit autre chose que le fond studio par défaut
          ...(o.background.trim() && o.background.trim() !== DEFAULT_LINGERIE_BACKGROUND ? [`Additional notes on background and light: ${o.background.trim()}`] : []),
        ].join('\n')
      : `BACKGROUND & LIGHT — ${o.background.trim() || DEFAULT_LINGERIE_BACKGROUND}`,
    '',
    `TECHNICAL — ${o.ratio} format. Sharp focus on the product, true-to-life colors, high-end catalogue quality. No text, no logo, no watermark, no border.`,
    ...(dyn && !custom ? ['', 'FINAL POSE CHECK — before rendering, verify the body is NOT upright and symmetrical: weight on one side, shoulders and hips tilted, knee(s) and elbow(s) bent, torso angled or twisted. If the pose looks like a straight standing catalogue stance, it is wrong.'] : []),
  ].join('\n')
}
