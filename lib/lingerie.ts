/**
 * Onglet 🩱 Lingerie — mannequins décrits en TEXTE uniquement (aucune photo de
 * mannequin envoyée : Gemini bloque la lingerie portée par une personne réelle en
 * référence) + cadrage strict par type de produit, coupé à la bouche (pas de regard).
 */

export type LingerieType = 'ensemble' | 'pyjama' | 'haut' | 'bas'

export type LingerieModel = { id: string; name: string; description: string }

export const LINGERIE_TYPES: { id: LingerieType; label: string; hint: string; ratio: string }[] = [
  { id: 'ensemble', label: 'Ensemble lingerie', hint: 'bouche → haut des cuisses', ratio: '3:4' },
  { id: 'pyjama',   label: 'Pyjama',            hint: 'bouche → pieds',            ratio: '2:3' },
  { id: 'haut',     label: 'Lingerie haut',     hint: 'bouche → ventre',           ratio: '4:5' },
  { id: 'bas',      label: 'Lingerie bas',      hint: 'ventre → haut des cuisses', ratio: '4:5' },
]

/** 5 mannequins par défaut — adultes, morphologies variées, décrits pour un cadrage sans les yeux. */
export const DEFAULT_LINGERIE_MODELS: LingerieModel[] = [
  {
    id: 'clara', name: 'Clara',
    description: 'Adult woman, 28 years old, Northern European. Fair skin with a warm neutral undertone and a few light freckles on the shoulders and upper chest. Height 1.77 m, slim and naturally toned silhouette (French size 36 / S): long neck, straight defined shoulders, small-to-medium bust, flat but soft stomach, narrow waist, slim straight hips, long slender legs. Soft oval jaw, natural pink lips with a subtle defined cupid\'s bow, closed-mouth soft neutral expression. Long straight light-brown hair falling behind the shoulders. Short natural nails with a nude polish. No tattoos, no piercings, no jewelry.',
  },
  {
    id: 'amina', name: 'Amina',
    description: 'Adult woman, 30 years old, West African descent. Deep brown skin with a rich warm undertone and an even, natural satin finish. Height 1.79 m, tall and slender with a clearly defined waist (French size 38 / S-M): graceful long neck, rounded shoulders, medium bust, slim toned stomach, gently curved hips, very long legs. Full lips in a natural mauve-brown tone, relaxed closed mouth, strong elegant jawline. Hair pulled back tightly, not visible in the frame. Short natural nails, no polish. No tattoos, no piercings, no jewelry.',
  },
  {
    id: 'lea', name: 'Léa',
    description: 'Adult woman, 32 years old, Mediterranean (Southern French / Italian). Olive skin with a golden undertone. Height 1.72 m, curvy hourglass figure (French size 42 / L): soft rounded shoulders, full bust, defined waist, softly rounded stomach, generous rounded hips and full thighs, natural body with realistic soft skin. Full natural lips in a warm rosy-beige tone, soft rounded chin, calm closed-mouth expression. Dark brown wavy hair, shoulder length, tucked behind the shoulders. Short almond nails with a soft beige polish. No tattoos, no piercings, no jewelry.',
  },
  {
    id: 'mei', name: 'Mei',
    description: 'Adult woman, 27 years old, East Asian. Light skin with a warm peach undertone, smooth even complexion. Height 1.71 m, petite slim frame (French size 34 / XS): delicate collarbones, narrow shoulders, small bust, flat stomach, slim waist, straight narrow hips, slender legs. Small well-defined lips in a natural soft rose tone, fine delicate chin, serene closed-mouth expression. Long straight black hair falling behind the back. Short natural nails with a clear gloss. No tattoos, no piercings, no jewelry.',
  },
  {
    id: 'sofia', name: 'Sofia',
    description: 'Adult woman, 31 years old, Latin American. Light tan skin with a golden-honey undertone. Height 1.75 m, athletic and curvy (French size 38 / M): defined shoulders, medium-full bust, toned stomach with subtle natural muscle definition, marked waist, rounded hips, strong toned thighs. Medium-full lips in a natural caramel-rose tone, softly defined jaw, relaxed closed-mouth expression. Dark brown hair in a sleek low ponytail, kept behind the back. Short natural nails with a nude-pink polish. No tattoos, no piercings, no jewelry.',
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
  'TOP EDGE of the frame cuts horizontally across the model\'s MOUTH: the lips and chin are visible at the very top of the image; the nose, eyes, forehead and hair on top of the head are OUTSIDE the frame. Never show the eyes.'

const FRAMING: Record<LingerieType, string> = {
  ensemble: `${MOUTH_TOP} BOTTOM EDGE of the frame at the UPPER THIGHS, a few centimetres below the bottom of the briefs. Knees and lower legs are OUTSIDE the frame. The complete set — top AND briefs — is entirely visible. Shoulders, arms and hands are in frame.`,
  pyjama:   `${MOUTH_TOP} BOTTOM EDGE of the frame just below the FEET: the model is shown from the mouth down to the feet, both feet entirely visible and standing on the floor with a small margin below them. The complete pyjama — top AND bottom — is entirely visible. Barefoot.`,
  haut:     `${MOUTH_TOP} BOTTOM EDGE of the frame at the BELLY, around navel level, a little below the bottom band of the bra. Hips, briefs and legs are OUTSIDE the frame. The bra is entirely visible, including straps and bottom band. Shoulders and upper arms are in frame.`,
  bas:      'TOP EDGE of the frame at the BELLY, just above the navel. The chest, bust and everything above the stomach are OUTSIDE the frame. BOTTOM EDGE of the frame at the UPPER THIGHS, a few centimetres below the bottom of the briefs. Knees and lower legs are OUTSIDE the frame. The briefs are entirely visible, front view, including waistband and leg openings. Hands may rest lightly at the sides without covering the product.',
}

export function ratioFor(type: LingerieType): string {
  return LINGERIE_TYPES.find(t => t.id === type)?.ratio ?? '3:4'
}

export function buildLingeriePrompt(o: {
  type: LingerieType
  model: LingerieModel
  imageCount: number
  background: string
  direction?: string
  ratio: string
}): string {
  const imgs = o.imageCount > 1 ? `IMAGES 1 to ${o.imageCount}` : 'IMAGE 1'
  return [
    'Professional e-commerce product photograph for a lingerie brand\'s online catalogue. Tasteful, elegant and commercial — the style of a department-store product page. Neutral and non-suggestive: the purpose is to show the product clearly on the body.',
    '',
    `PRODUCT — ${imgs}: product packshot${o.imageCount > 1 ? 's' : ''} of ${PRODUCT_LABEL[o.type]}. ${o.imageCount > 1 ? 'These images show' : 'This image shows'} the product only, with no model. Reproduce the product with absolute fidelity: exact color, fabric, lace pattern, transparency level, cut, coverage, straps, hooks, underwire, seams, trims, elastic bands, prints and logos. Same coverage as the product — do not make it smaller or more revealing, do not add or remove any part. The model wears ONLY this product${o.type === 'haut' || o.type === 'bas' ? ' (anything else stays outside the frame)' : ''}.`,
    '',
    `MODEL — described in text only, there is no reference photo of her. ${o.model.description} Realistic natural skin texture with subtle pores, even skin tone over the whole body, no plastic retouching look.`,
    '',
    `FRAMING (STRICT, non-negotiable) — ${FRAMING[o.type]}`,
    '',
    'POSE — standing, facing the camera, relaxed and natural catalogue pose, weight slightly on one leg. Arms relaxed along the body or one hand lightly on the hip; hands never cover the product. Calm, neutral attitude.',
    '',
    `BACKGROUND & LIGHT — ${o.background.trim() || DEFAULT_LINGERIE_BACKGROUND}`,
    ...(o.direction?.trim() ? ['', `ADDITIONAL DIRECTION — ${o.direction.trim()}`] : []),
    '',
    `TECHNICAL — ${o.ratio} format. Sharp focus on the product, true-to-life colors, high-end catalogue quality. No text, no logo, no watermark, no border.`,
  ].join('\n')
}
