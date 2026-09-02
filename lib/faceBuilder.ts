/**
 * Catalogue de critères pour la création de mannequins sur mesure (onglet Visage).
 *
 * Chaque catégorie = liste d'options { id, label, prompt }.
 *   - `label` : affiché dans l'UI
 *   - `prompt` : fragment anglais injecté dans le prompt Gemini
 */

export type FaceOption = { id: string; label: string; prompt: string }

/* ============================== IDENTITÉ ============================== */

export const GENDERS: FaceOption[] = [
  { id: 'femme',   label: 'Femme',        prompt: 'a female fashion model' },
  { id: 'homme',   label: 'Homme',        prompt: 'a male fashion model' },
  { id: 'androgyne', label: 'Androgyne',  prompt: 'an androgynous fashion model with ambiguous gender features' },
]

export const AGE_RANGES: FaceOption[] = [
  { id: '18-24', label: '18-24 ans', prompt: 'aged 18 to 24, youthful features' },
  { id: '25-32', label: '25-32 ans', prompt: 'aged 25 to 32, mature but fresh features' },
  { id: '33-42', label: '33-42 ans', prompt: 'aged 33 to 42, defined mature features' },
  { id: '43-55', label: '43-55 ans', prompt: 'aged 43 to 55, elegant mature features with natural expression lines' },
  { id: '55+',   label: '55+ ans',   prompt: 'aged 55 or above, distinguished silver-age model with natural wrinkles and character' },
]

export const RANGES: FaceOption[] = [
  { id: 'decontracte', label: 'Décontracté', prompt: 'casual and approachable vibe, relaxed lifestyle brand aesthetic (think COS, Everlane, Uniqlo)' },
  { id: 'raffine',     label: 'Raffiné',     prompt: 'refined and elegant vibe, contemporary premium brand aesthetic (think Sézane, Massimo Dutti, Arket)' },
  { id: 'premium',     label: 'Premium',     prompt: 'luxury high-end vibe, couture house aesthetic (think Toteme, The Row, Celine)' },
]

/* ============================== TEINT ============================== */

export const UNDERTONES: FaceOption[] = [
  { id: 'froid',  label: 'Froid',  prompt: 'cool undertone (pink/blue/rosy base)' },
  { id: 'neutre', label: 'Neutre', prompt: 'neutral undertone (balanced base)' },
  { id: 'chaud',  label: 'Chaud',  prompt: 'warm undertone (golden/peach/yellow base)' },
]

export const SKIN_TONES: FaceOption[] = [
  { id: 'porcelaine',   label: 'Porcelaine (très claire)', prompt: 'very fair porcelain skin' },
  { id: 'claire',       label: 'Claire',                    prompt: 'fair light skin' },
  { id: 'claire-doree', label: 'Claire dorée',              prompt: 'light golden skin' },
  { id: 'medium',       label: 'Medium / olive',            prompt: 'medium olive skin' },
  { id: 'medium-fonce', label: 'Medium foncé',              prompt: 'medium-deep tan skin' },
  { id: 'fonce',        label: 'Foncé',                     prompt: 'deep brown skin' },
  { id: 'ebene',        label: 'Ébène (très foncé)',        prompt: 'very deep rich ebony skin' },
]

/* ============================== VISAGE ============================== */

export const FACE_SHAPES: FaceOption[] = [
  { id: 'ovale',    label: 'Ovale',    prompt: 'oval face shape (balanced, slightly longer than wide)' },
  { id: 'rond',     label: 'Rond',     prompt: 'round face shape (soft full cheeks, similar width and length)' },
  { id: 'carre',    label: 'Carré',    prompt: 'square face shape (strong angular jaw, wide forehead)' },
  { id: 'coeur',    label: 'Cœur',     prompt: 'heart-shaped face (wide forehead, narrow pointed chin)' },
  { id: 'allonge',  label: 'Allongé',  prompt: 'oblong / elongated face shape (notably longer than wide)' },
  { id: 'diamant',  label: 'Diamant',  prompt: 'diamond face shape (narrow forehead and chin, wide cheekbones)' },
  { id: 'triangle', label: 'Triangle inversé', prompt: 'inverted triangle face (broad forehead tapering to narrow chin)' },
]

export const BONE_STRUCTURES: FaceOption[] = [
  { id: 'pommettes-saillantes', label: 'Pommettes saillantes',  prompt: 'high prominent sculpted cheekbones' },
  { id: 'joues-douces',         label: 'Joues douces',          prompt: 'soft full cheeks, gentle facial volume' },
  { id: 'machoire-dessinee',    label: 'Mâchoire dessinée',     prompt: 'sharply defined angular jawline' },
  { id: 'machoire-douce',       label: 'Mâchoire douce',        prompt: 'soft rounded jawline' },
  { id: 'nez-delicat',          label: 'Nez délicat',           prompt: 'delicate slim nose with fine bridge' },
  { id: 'nez-droit',            label: 'Nez droit / romain',    prompt: 'straight roman nose with defined bridge' },
  { id: 'nez-large',            label: 'Nez large',             prompt: 'wide nose with broad base' },
  { id: 'nez-retrousse',        label: 'Nez retroussé',         prompt: 'upturned button nose' },
  { id: 'traits-ecartes',       label: 'Traits écartés',        prompt: 'wide-set facial features (eyes notably far apart)' },
  { id: 'traits-rapproches',    label: 'Traits rapprochés',     prompt: 'close-set facial features (eyes close together)' },
  { id: 'front-haut',           label: 'Front haut',            prompt: 'high forehead' },
  { id: 'menton-pointu',        label: 'Menton pointu',         prompt: 'pointed narrow chin' },
  { id: 'menton-carre',         label: 'Menton carré',          prompt: 'square strong chin' },
  { id: 'levres-pleines',       label: 'Lèvres pleines',        prompt: 'full plump lips' },
  { id: 'levres-fines',         label: 'Lèvres fines',          prompt: 'thin delicate lips' },
]

export const TARGETS: FaceOption[] = [
  { id: 'commercial',    label: 'Commercial',     prompt: 'COMMERCIAL casting : conventionally attractive, approachable, friendly face that appeals broadly. Balanced harmonious features, nothing extreme.' },
  { id: 'editorial',     label: 'Éditorial',      prompt: 'EDITORIAL casting : striking distinctive features, strong bone structure, photogenic angles. Interesting rather than simply pretty.' },
  { id: 'haute-couture', label: 'Haute couture',  prompt: 'HAUTE COUTURE casting : extreme, unusual, almost otherworldly features. Very high fashion, sculptural, unconventional beauty that turns heads on a runway.' },
  { id: 'caractere',     label: 'Caractère',      prompt: 'CHARACTER casting : memorable atypical face with strong personality. Real, lived-in, imperfect in an interesting way. Not a classic beauty.' },
]

/* ============================== YEUX & SOURCILS ============================== */

export const EYE_COLORS: FaceOption[] = [
  { id: 'bleu-clair',    label: 'Bleu clair',    prompt: 'pale ice-blue eyes' },
  { id: 'bleu-profond',  label: 'Bleu profond',  prompt: 'deep navy blue eyes' },
  { id: 'vert-emeraude', label: 'Vert émeraude', prompt: 'vivid emerald green eyes' },
  { id: 'vert-gris',     label: 'Vert-gris',     prompt: 'muted grey-green eyes' },
  { id: 'noisette',      label: 'Noisette',      prompt: 'hazel eyes (green-brown with golden flecks)' },
  { id: 'marron-clair',  label: 'Marron clair',  prompt: 'light amber-brown eyes' },
  { id: 'marron-fonce',  label: 'Marron foncé',  prompt: 'deep dark brown eyes' },
  { id: 'ambre',         label: 'Ambre',         prompt: 'striking amber / golden eyes' },
  { id: 'gris',          label: 'Gris',          prompt: 'cool grey eyes' },
  { id: 'noir',          label: 'Noir',          prompt: 'very dark almost black eyes' },
  { id: 'heterochromie', label: 'Hétérochromie', prompt: 'heterochromia : two different eye colors (one blue, one brown)' },
]

export const EYE_SHAPES: FaceOption[] = [
  { id: 'amande',      label: 'En amande',        prompt: 'almond-shaped eyes' },
  { id: 'ronds',       label: 'Ronds',            prompt: 'large round open eyes' },
  { id: 'tombants',    label: 'Tombants (hooded)',prompt: 'hooded eyes with heavy upper lid' },
  { id: 'releves',     label: 'Relevés (cat eye)',prompt: 'upturned cat-eye shape with lifted outer corners' },
  { id: 'descendants', label: 'Descendants',      prompt: 'downturned eyes with lowered outer corners (soft melancholic look)' },
  { id: 'ecartes',     label: 'Écartés',          prompt: 'wide-set eyes' },
  { id: 'rapproches',  label: 'Rapprochés',       prompt: 'close-set eyes' },
  { id: 'enfonces',    label: 'Profonds/enfoncés',prompt: 'deep-set eyes under a strong brow bone' },
  { id: 'monolid',     label: 'Monolid',          prompt: 'monolid eyes without a visible crease' },
  { id: 'grands',      label: 'Grands',           prompt: 'notably large expressive eyes' },
]

export const EYEBROWS: FaceOption[] = [
  { id: 'epais-naturels',  label: 'Épais naturels',   prompt: 'thick natural untamed eyebrows' },
  { id: 'fins-arques',     label: 'Fins arqués',      prompt: 'thin elegantly arched eyebrows' },
  { id: 'droits',          label: 'Droits',           prompt: 'straight horizontal eyebrows' },
  { id: 'arques-marques',  label: 'Arqués marqués',   prompt: 'strongly arched dramatic eyebrows' },
  { id: 'broussailleux',   label: 'Broussailleux',    prompt: 'bushy unkempt full eyebrows' },
  { id: 'fournis-struct',  label: 'Fournis structurés',prompt: 'full but neatly groomed structured eyebrows' },
  { id: 'clairsemes',      label: 'Clairsemés',       prompt: 'sparse light eyebrows' },
  { id: 'asymetriques',    label: 'Asymétriques',     prompt: 'noticeably asymmetric eyebrows (one higher / differently shaped)' },
]

/* ============================== CHEVEUX ============================== */

export const HAIR_COLORS: FaceOption[] = [
  { id: 'blond-platine',  label: 'Blond platine',    prompt: 'platinum blonde hair' },
  { id: 'blond-dore',     label: 'Blond doré',       prompt: 'warm golden blonde hair' },
  { id: 'blond-cendre',   label: 'Blond cendré',     prompt: 'cool ash blonde hair' },
  { id: 'chatain-clair',  label: 'Châtain clair',    prompt: 'light brown hair' },
  { id: 'chatain',        label: 'Châtain',          prompt: 'medium brown hair' },
  { id: 'brun',           label: 'Brun',             prompt: 'rich dark brown hair' },
  { id: 'noir',           label: 'Noir',             prompt: 'jet black hair' },
  { id: 'roux-cuivre',    label: 'Roux cuivré',      prompt: 'vivid copper red hair' },
  { id: 'roux-venitien',  label: 'Roux vénitien',    prompt: 'soft strawberry blonde / venetian red hair' },
  { id: 'gris',           label: 'Gris / poivre-sel',prompt: 'salt-and-pepper grey hair' },
  { id: 'blanc',          label: 'Blanc',            prompt: 'pure white silver hair' },
  { id: 'colore',         label: 'Coloré (fantaisie)',prompt: 'bold fashion-colored hair (pastel or vivid unnatural shade)' },
]

export const HAIR_CUTS_F: FaceOption[] = [
  { id: 'long-lisse',    label: 'Long lisse',        prompt: 'long straight sleek hair' },
  { id: 'long-ondule',   label: 'Long ondulé',       prompt: 'long wavy hair with natural movement' },
  { id: 'long-boucle',   label: 'Long bouclé',       prompt: 'long defined curly hair' },
  { id: 'bob',           label: 'Carré (bob)',       prompt: 'chin-length blunt bob' },
  { id: 'lob',           label: 'Carré long (lob)',  prompt: 'shoulder-length long bob (lob)' },
  { id: 'pixie',         label: 'Pixie',             prompt: 'short pixie cut' },
  { id: 'garconne',      label: 'Coupe garçonne',    prompt: 'very short boyish crop' },
  { id: 'chignon',       label: 'Chignon',           prompt: 'hair pulled back into a sleek low bun' },
  { id: 'tresses',       label: 'Tresses',           prompt: 'braided hair' },
  { id: 'afro',          label: 'Afro',              prompt: 'natural voluminous afro hair' },
  { id: 'locks',         label: 'Locks',             prompt: 'dreadlocks' },
  { id: 'frange-rideau', label: 'Frange rideau',     prompt: 'long hair with curtain bangs framing the face' },
  { id: 'frange-droite', label: 'Frange droite',     prompt: 'hair with blunt straight bangs' },
  { id: 'buzz',          label: 'Crâne rasé',        prompt: 'shaved buzzcut head' },
]

export const HAIR_CUTS_M: FaceOption[] = [
  { id: 'court-classique', label: 'Court classique', prompt: 'classic short tapered haircut' },
  { id: 'buzz',            label: 'Buzz cut',        prompt: 'very short buzz cut' },
  { id: 'undercut',        label: 'Undercut',        prompt: 'undercut with longer top and shaved sides' },
  { id: 'mi-long',         label: 'Mi-long',         prompt: 'medium-length hair reaching the ears' },
  { id: 'long',            label: 'Long',            prompt: 'long shoulder-length hair' },
  { id: 'boucle-court',    label: 'Bouclé court',    prompt: 'short curly hair' },
  { id: 'afro',            label: 'Afro',            prompt: 'natural afro hair' },
  { id: 'locks',           label: 'Locks',           prompt: 'dreadlocks' },
  { id: 'man-bun',         label: 'Man bun',         prompt: 'long hair tied in a man bun' },
  { id: 'rase',            label: 'Crâne rasé',      prompt: 'completely shaved head' },
  { id: 'degrade',         label: 'Dégradé (fade)',  prompt: 'modern fade haircut' },
]

export const FACIAL_HAIR: FaceOption[] = [
  { id: 'aucune',       label: 'Rasé de près',     prompt: 'clean-shaven face' },
  { id: 'barbe-3j',     label: 'Barbe de 3 jours', prompt: 'light stubble (3-day beard)' },
  { id: 'barbe-courte', label: 'Barbe courte',     prompt: 'short well-groomed beard' },
  { id: 'barbe-pleine', label: 'Barbe pleine',     prompt: 'full thick beard' },
  { id: 'moustache',    label: 'Moustache',        prompt: 'moustache only' },
  { id: 'bouc',         label: 'Bouc',             prompt: 'goatee' },
]

/* ============================== PEAU & PARTICULARITÉS ============================== */

export const SKIN_FINISHES: FaceOption[] = [
  { id: 'mate',      label: 'Mate',                 prompt: 'matte skin finish, no shine' },
  { id: 'satinee',   label: 'Satinée',              prompt: 'satin skin finish with subtle sheen' },
  { id: 'glowy',     label: 'Lumineuse / glowy',    prompt: 'dewy glowing luminous skin' },
  { id: 'texturee',  label: 'Texturée naturelle',   prompt: 'natural textured skin with visible pores and real imperfections' },
  { id: 'grain',     label: 'Grain de peau visible',prompt: 'realistic visible skin grain and texture, unretouched look' },
  { id: 'lissee',    label: 'Lissée (retouchée)',   prompt: 'smooth flawless retouched skin' },
]

export const DISTINCTIVE_FEATURES: FaceOption[] = [
  { id: 'freckles-light', label: 'Taches de rousseur légères', prompt: 'light scattered freckles across the nose and cheeks' },
  { id: 'freckles-heavy', label: 'Taches de rousseur marquées',prompt: 'heavy dense freckles covering the face' },
  { id: 'beauty-mark',    label: 'Grain de beauté',            prompt: 'a distinctive beauty mark on the face' },
  { id: 'scar',           label: 'Cicatrice discrète',         prompt: 'a subtle small scar (eyebrow or cheek)' },
  { id: 'dimples',        label: 'Fossettes',                  prompt: 'visible dimples when smiling' },
  { id: 'gap-teeth',      label: 'Dents du bonheur',           prompt: 'a gap between the front teeth (diastema)' },
  { id: 'expression-lines',label:'Rides d\'expression',        prompt: 'natural expression lines around eyes and mouth' },
  { id: 'vitiligo',       label: 'Vitiligo',                   prompt: 'vitiligo depigmentation patches on the skin' },
  { id: 'monobrow',       label: 'Sourcils joints',            prompt: 'slightly joined eyebrows (subtle monobrow)' },
]

export const TATTOOS: FaceOption[] = [
  { id: 'aucun',     label: 'Aucun',            prompt: 'no visible tattoos' },
  { id: 'cou-subtil',label: 'Discret (cou)',    prompt: 'a small discreet tattoo partially visible on the neck' },
  { id: 'cou-visible',label:'Visible (cou)',    prompt: 'a prominent visible neck tattoo' },
  { id: 'visage',    label: 'Visage (micro)',   prompt: 'a tiny minimalist face tattoo (small symbol near temple or cheekbone)' },
]

export const PIERCINGS: FaceOption[] = [
  { id: 'aucun',        label: 'Aucun',            prompt: 'no piercings' },
  { id: 'lobe-simple',  label: 'Lobe simple',      prompt: 'simple stud earrings in the earlobes' },
  { id: 'lobes-multi',  label: 'Lobes multiples',  prompt: 'multiple ear piercings (stacked earlobe and helix)' },
  { id: 'septum',       label: 'Septum',           prompt: 'a septum nose ring' },
  { id: 'narine',       label: 'Narine',           prompt: 'a small nostril stud piercing' },
  { id: 'arcade',       label: 'Arcade',           prompt: 'an eyebrow piercing' },
  { id: 'labret',       label: 'Labret',           prompt: 'a labret lip piercing' },
]

export const ASYMMETRIES: FaceOption[] = [
  { id: 'aucune',  label: 'Symétrique',        prompt: 'a highly symmetrical face' },
  { id: 'legere',  label: 'Légère (naturelle)',prompt: 'natural subtle facial asymmetry (as every real human has)' },
  { id: 'marquee', label: 'Marquée (caractère)',prompt: 'noticeable facial asymmetry that adds character and memorability' },
]

/* ============================== EXPRESSION ============================== */

export const GAZES: FaceOption[] = [
  { id: 'direct-intense', label: 'Direct intense',  prompt: 'intense direct gaze straight into the camera lens' },
  { id: 'direct-doux',    label: 'Direct doux',     prompt: 'soft warm gaze into the camera' },
  { id: 'neutre',         label: 'Neutre / impassible',prompt: 'neutral impassive expression, blank model stare' },
  { id: 'reveur',         label: 'Rêveur / lointain',prompt: 'dreamy distant gaze slightly off-camera' },
  { id: 'confiant',       label: 'Confiant',        prompt: 'confident self-assured look' },
  { id: 'mysterieux',     label: 'Mystérieux',      prompt: 'enigmatic mysterious expression' },
  { id: 'chaleureux',     label: 'Chaleureux',      prompt: 'warm friendly inviting expression' },
]

export const MOUTHS: FaceOption[] = [
  { id: 'neutre',      label: 'Neutre fermée',      prompt: 'relaxed closed mouth, neutral' },
  { id: 'leger-sourire',label:'Léger sourire',      prompt: 'subtle closed-lip smile' },
  { id: 'sourire',     label: 'Sourire franc',      prompt: 'genuine open smile showing teeth' },
  { id: 'entrouverte', label: 'Lèvres entrouvertes',prompt: 'lips slightly parted' },
  { id: 'moue',        label: 'Moue naturelle',     prompt: 'natural soft pout' },
  { id: 'pincees',     label: 'Lèvres pincées',     prompt: 'lips lightly pressed together' },
]

/* ============================== SÉLECTION COMPLÈTE ============================== */

export type FaceSelection = {
  gender:       string
  ageRange:     string
  range:        string
  undertone:    string
  skinTone:     string
  faceShape:    string
  boneStructure: string[]     // multi-select
  target:       string
  eyeColor:     string
  eyeShape:     string
  eyebrows:     string
  hairColor:    string
  hairCut:      string
  facialHair:   string        // homme uniquement
  skinFinish:   string
  distinctive:  string[]      // multi-select
  tattoo:       string
  piercing:     string
  asymmetry:    string
  gaze:         string
  mouth:        string
  extraNotes:   string        // texte libre
}

/** Retourne le prompt d'une option par son id (ou '' si non trouvée). */
function p(list: FaceOption[], id: string): string {
  return list.find(o => o.id === id)?.prompt ?? ''
}
function pMulti(list: FaceOption[], ids: string[]): string[] {
  return ids.map(id => p(list, id)).filter(Boolean)
}

/**
 * Construit le prompt Gemini pour la vue de FACE (casting mannequin, fond blanc).
 */
export function buildFacePrompt(sel: FaceSelection): string {
  const isMale = sel.gender === 'homme'
  const hairCuts = isMale ? HAIR_CUTS_M : HAIR_CUTS_F

  const bone = pMulti(BONE_STRUCTURES, sel.boneStructure)
  const distinct = pMulti(DISTINCTIVE_FEATURES, sel.distinctive)

  const lines: string[] = [
    'PROFESSIONAL MODEL CASTING PHOTOGRAPH — FRONT VIEW (polaroid / digitals style).',
    '',
    'Create a photorealistic head-and-shoulders portrait of a fashion model for a casting book.',
    '',
    '=== SUBJECT ===',
    `• ${p(GENDERS, sel.gender)}, ${p(AGE_RANGES, sel.ageRange)}.`,
    `• Brand positioning : ${p(RANGES, sel.range)}.`,
    `• Casting type : ${p(TARGETS, sel.target)}`,
    '',
    '=== SKIN ===',
    `• ${p(SKIN_TONES, sel.skinTone)} with ${p(UNDERTONES, sel.undertone)}.`,
    `• Skin finish : ${p(SKIN_FINISHES, sel.skinFinish)}.`,
    distinct.length ? `• Distinctive features : ${distinct.join(' ; ')}.` : '',
    `• ${p(ASYMMETRIES, sel.asymmetry)}.`,
    '',
    '=== FACE STRUCTURE ===',
    `• Face shape : ${p(FACE_SHAPES, sel.faceShape)}.`,
    bone.length ? `• Bone structure : ${bone.join(' ; ')}.` : '',
    '',
    '=== EYES & BROWS ===',
    `• Eye color : ${p(EYE_COLORS, sel.eyeColor)}.`,
    `• Eye shape : ${p(EYE_SHAPES, sel.eyeShape)}.`,
    `• Eyebrows : ${p(EYEBROWS, sel.eyebrows)}.`,
    '',
    '=== HAIR ===',
    `• ${p(HAIR_COLORS, sel.hairColor)}, ${p(hairCuts, sel.hairCut)}.`,
    isMale && sel.facialHair ? `• Facial hair : ${p(FACIAL_HAIR, sel.facialHair)}.` : '',
    '',
    '=== ACCESSORIES ===',
    `• Tattoos : ${p(TATTOOS, sel.tattoo)}.`,
    `• Piercings : ${p(PIERCINGS, sel.piercing)}.`,
    '',
    '=== EXPRESSION ===',
    `• Gaze : ${p(GAZES, sel.gaze)}.`,
    `• Mouth : ${p(MOUTHS, sel.mouth)}.`,
    '',
    sel.extraNotes ? `=== ADDITIONAL NOTES ===\n${sel.extraNotes}\n` : '',
    '=== TECHNICAL / SHOOTING SPEC (non-negotiable) ===',
    '• FRAMING : head and shoulders, centered, face fully visible. Top of head with 5-8% headroom. Crop at upper chest.',
    '• ANGLE : straight-on FRONT view, eyes level with the camera, face directly facing the lens (no tilt, no 3/4).',
    '• BACKGROUND : pure clean WHITE seamless studio backdrop (#FFFFFF), completely uniform, no gradient, no shadow on the wall, no props.',
    '• LIGHTING : soft even frontal studio lighting (large softbox), no harsh shadows on the face, natural skin rendering.',
    '• STYLING : NO makeup or minimal natural makeup only. Hair natural, not styled for a shoot. Plain neutral top (white or grey t-shirt / tank top), no logo, no jewelry beyond the specified piercings.',
    '• RENDERING : photorealistic, ultra sharp, high detail on skin texture and eyes. This must look like a REAL casting polaroid, not a glossy retouched ad.',
    '• The model is a SYNTHETIC AI-generated person, not a real identifiable individual.',
  ]

  return lines.filter(l => l !== '').join('\n')
}

/**
 * Prompt pour la vue de PROFIL, envoyé AVEC l'image de face générée en référence
 * pour garantir la cohérence d'identité.
 */
export function buildProfilePrompt(): string {
  return [
    'PROFESSIONAL MODEL CASTING PHOTOGRAPH — SIDE PROFILE VIEW (same model, same session).',
    '',
    '⚠ The attached image is the FRONT VIEW of this exact model, shot moments ago in the same casting session.',
    'Produce the SIDE PROFILE (90° left profile) of THE SAME PERSON.',
    '',
    '=== ABSOLUTE IDENTITY CONSISTENCY (critical) ===',
    'Keep STRICTLY IDENTICAL to the reference : the exact same person, same age, same skin tone and undertone, same skin texture and finish, same freckles / beauty marks / scars / distinctive features at the SAME positions, same hair color, same haircut and hair length, same eyebrow shape and thickness, same nose shape and size, same lip shape and fullness, same jawline, same cheekbone height, same ear shape, same piercings and tattoos in the same spots, same neutral top.',
    'This must be UNMISTAKABLY the same individual — a casting director comparing both images must have zero doubt.',
    '',
    '=== VIEW ===',
    '• Strict 90° SIDE PROFILE (left profile), head turned fully to the side, only one eye visible in profile silhouette.',
    '• Same framing scale as the reference : head and shoulders, same headroom, crop at upper chest.',
    '• Eyes level with the camera, head straight (no tilt up or down).',
    '',
    '=== TECHNICAL (identical to the front shot) ===',
    '• BACKGROUND : the exact same pure white seamless studio backdrop (#FFFFFF), uniform, no gradient.',
    '• LIGHTING : the exact same soft even studio lighting, same intensity and color temperature.',
    '• EXPRESSION : neutral relaxed, mouth closed, calm — standard casting profile shot.',
    '• RENDERING : photorealistic, ultra sharp, same skin texture rendering as the front view.',
    '',
    'Output : one side-profile casting photograph, same person, same session, same setup.',
  ].join('\n')
}

/* ============================== ALÉATOIRE ============================== */

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}
function pickMulti<T>(arr: T[], min: number, max: number): T[] {
  const n = min + Math.floor(Math.random() * (max - min + 1))
  const shuffled = [...arr].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, n)
}

/** Génère une sélection aléatoire cohérente. */
export function randomSelection(): FaceSelection {
  const gender = pick(GENDERS).id
  const isMale = gender === 'homme'
  const hairCuts = isMale ? HAIR_CUTS_M : HAIR_CUTS_F

  return {
    gender,
    ageRange:      pick(AGE_RANGES).id,
    range:         pick(RANGES).id,
    undertone:     pick(UNDERTONES).id,
    skinTone:      pick(SKIN_TONES).id,
    faceShape:     pick(FACE_SHAPES).id,
    boneStructure: pickMulti(BONE_STRUCTURES, 2, 4).map(o => o.id),
    target:        pick(TARGETS).id,
    eyeColor:      pick(EYE_COLORS).id,
    eyeShape:      pick(EYE_SHAPES).id,
    eyebrows:      pick(EYEBROWS).id,
    hairColor:     pick(HAIR_COLORS).id,
    hairCut:       pick(hairCuts).id,
    facialHair:    isMale ? pick(FACIAL_HAIR).id : 'aucune',
    skinFinish:    pick(SKIN_FINISHES).id,
    distinctive:   Math.random() > 0.4 ? pickMulti(DISTINCTIVE_FEATURES, 1, 2).map(o => o.id) : [],
    tattoo:        Math.random() > 0.75 ? pick(TATTOOS).id : 'aucun',
    piercing:      Math.random() > 0.5  ? pick(PIERCINGS).id : 'aucun',
    asymmetry:     pick(ASYMMETRIES).id,
    gaze:          pick(GAZES).id,
    mouth:         pick(MOUTHS).id,
    extraNotes:    '',
  }
}

/** Sélection par défaut (valeurs neutres). */
export function defaultSelection(): FaceSelection {
  return {
    gender: 'femme', ageRange: '25-32', range: 'raffine',
    undertone: 'neutre', skinTone: 'claire',
    faceShape: 'ovale', boneStructure: ['pommettes-saillantes'], target: 'editorial',
    eyeColor: 'marron-fonce', eyeShape: 'amande', eyebrows: 'fournis-struct',
    hairColor: 'brun', hairCut: 'long-ondule', facialHair: 'aucune',
    skinFinish: 'texturee', distinctive: [], tattoo: 'aucun', piercing: 'aucun',
    asymmetry: 'legere', gaze: 'direct-doux', mouth: 'neutre', extraNotes: '',
  }
}
