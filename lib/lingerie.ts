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
  bas:      'TOP EDGE of the frame at the BELLY, just above the navel. The chest, bust and everything above the stomach are OUTSIDE the frame. BOTTOM EDGE of the frame at the UPPER THIGHS, a few centimetres below the bottom of the briefs. Knees and lower legs are OUTSIDE the frame. The briefs are entirely visible, front view, including waistband and leg openings. Hands may rest lightly at the sides without covering the product.',
}

/* ============================== Poses ============================== */

export type PoseMode = 'neutre' | 'dynamique'

/**
 * Poses « dynamiques » inspirées des shootings lingerie e-commerce (assise au sol en appui,
 * agenouillée main sur le genou, déhanché, main sur la bretelle…). Le cadrage reste coupé à la bouche.
 */
export const DYNAMIC_POSES: { id: string; label: string; types: LingerieType[]; text: string }[] = [
  { id: 'hanche', label: 'Déhanché, main sur la hanche', types: ['ensemble', 'pyjama', 'haut', 'bas'],
    text: 'standing in a relaxed contrapposto, weight on one leg, the hip pushed gently to the side, one hand resting on the hip, the other arm loose along the body, shoulders relaxed and slightly asymmetrical.' },
  { id: 'trois-quarts', label: 'Trois-quarts, genou avancé', types: ['ensemble', 'pyjama', 'haut', 'bas'],
    text: 'body turned three-quarters to the camera, shoulders rotated back toward the lens, one knee bent slightly forward and inward, arms relaxed, a natural S-curve through the body.' },
  { id: 'cheveux', label: 'Main dans les cheveux', types: ['ensemble', 'pyjama', 'haut'],
    text: 'one hand raised to the hair at the side of the neck as if pushing it back over the shoulder, elbow lifted, the other hand resting loosely on the thigh, torso slightly twisted, relaxed and candid.' },
  { id: 'bretelle', label: 'Main sur la bretelle / la ceinture', types: ['ensemble', 'haut', 'bas'],
    text: 'one hand lightly touching the shoulder strap (or the waistband of the briefs), a natural fleeting gesture, fingers relaxed, without pulling or covering the product; the other arm loose, weight on one leg.' },
  { id: 'marche', label: 'En mouvement, un pas en avant', types: ['ensemble', 'pyjama', 'bas'],
    text: 'caught in motion taking a step toward the camera, one leg crossing slightly in front of the other, arms swinging naturally, a sense of movement in the body while the product stays sharp.' },
  { id: 'assise-sol', label: 'Assise au sol, appui sur un bras', types: ['ensemble', 'pyjama', 'haut', 'bas'],
    text: 'seated on the floor, leaning back on one straight arm planted behind her, legs bent and folded to the side, the other hand resting on her knee or thigh, torso upright and open toward the camera.' },
  { id: 'genou', label: 'Agenouillée, main sur le genou', types: ['ensemble', 'haut', 'bas'],
    text: 'half-kneeling, sitting back on one side with one knee raised, one hand resting on the raised knee, the other arm relaxed, torso upright with a slight lean forward, dynamic diagonal line through the body.' },
]

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
}): string {
  const imgs = o.imageCount > 1 ? `IMAGES 1 to ${o.imageCount}` : 'IMAGE 1'
  const dyn = o.poseMode === 'dynamique' ? (DYNAMIC_POSES.find(p => p.id === o.poseId && p.types.includes(o.type)) ?? posesFor(o.type)[0]) : null
  return [
    o.direction?.trim() || o.poseMode === 'dynamique'
      ? 'Professional fashion photograph for a lingerie brand\'s online catalogue, editorial style. Tasteful, elegant and non-suggestive: the product stays clearly visible on the body.'
      : 'Professional e-commerce product photograph for a lingerie brand\'s online catalogue. Tasteful, elegant and commercial — the style of a department-store product page. Neutral and non-suggestive: the purpose is to show the product clearly on the body.',
    '',
    `PRODUCT — ${imgs}: product packshot${o.imageCount > 1 ? 's' : ''} of ${PRODUCT_LABEL[o.type]}. ${o.imageCount > 1 ? 'These images show' : 'This image shows'} the product only, with no model. Reproduce the product with absolute fidelity: exact color, fabric, lace pattern, transparency level, cut, coverage, straps, hooks, underwire, seams, trims, elastic bands, prints and logos. Same coverage as the product — do not make it smaller or more revealing, do not add or remove any part. The product is fitted to the model's body size. The model wears ONLY this product${o.type === 'haut' || o.type === 'bas' ? ' (anything else stays outside the frame)' : ''}.`,
    '',
    `MODEL — described in text only, there is no reference photo of her. ${o.model.identity}`,
    `BODY — ${o.model.bodies[o.morpho]} Respect this body type exactly, do not slim it down or enlarge it.`,
    `HAIR — ${o.model.hair}`,
    'SKIN — realistic natural texture with subtle pores, even skin tone over the whole body, no plastic retouching look.',
    '',
    `FRAMING (STRICT, non-negotiable) — ${FRAMING[o.type]}`,
    '',
    // Direction saisie = elle REMPLACE la pose par défaut (sinon la pose « catalogue » figée, placée avant, l'emporte).
    // Priorité : texte « Pose & attitude » > pose dynamique tirée > pose catalogue neutre
    o.direction?.trim()
      ? `POSE, ATTITUDE & MOOD — follow this art direction closely, it takes priority over any default catalogue pose. Only the framing above and the product fidelity stay mandatory; anything described for parts outside the frame (eyes, gaze, top of the head) is simply not shown. Hands never hide the product.\n${o.direction.trim()}`
      : dyn
        ? `POSE — dynamic lingerie-catalogue pose, natural and alive, never stiff, in the spirit of contemporary lingerie e-commerce shoots: ${dyn.text} Confident and elegant, never vulgar. The product stays fully visible and unobstructed. The framing above is unchanged: the top edge stays at the mouth (a slight head tilt is fine, the eyes are never visible), and the pose is adapted so the whole product fits in the frame.`
        : 'POSE — standing, facing the camera, relaxed and natural catalogue pose, weight slightly on one leg. Arms relaxed along the body or one hand lightly on the hip; hands never cover the product. Calm, neutral attitude.',
    '',
    o.hasBackgroundImage
      ? [
          `BACKGROUND — IMAGE ${o.imageCount + 1} is the BACKGROUND / LOCATION reference (it contains no model and no product). Reproduce this exact place behind the model: same walls, floor, materials, textures, colors, furniture and objects, same light direction, color temperature and ambience. Keep its look exactly — do not redesign, recolor, add or remove elements. Only the viewpoint adapts to the framing above (seen closer, cropped like the shot), with natural perspective and the model placed naturally in the space, lit by the same light, with a soft natural contact shadow where relevant.`,
          // Notes texte seulement si l'utilisateur a écrit autre chose que le fond studio par défaut
          ...(o.background.trim() && o.background.trim() !== DEFAULT_LINGERIE_BACKGROUND ? [`Additional notes on background and light: ${o.background.trim()}`] : []),
        ].join('\n')
      : `BACKGROUND & LIGHT — ${o.background.trim() || DEFAULT_LINGERIE_BACKGROUND}`,
    '',
    `TECHNICAL — ${o.ratio} format. Sharp focus on the product, true-to-life colors, high-end catalogue quality. No text, no logo, no watermark, no border.`,
  ].join('\n')
}
