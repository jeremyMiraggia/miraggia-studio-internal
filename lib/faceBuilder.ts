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

/* ============================== CORPS ============================== */

export const BODY_TYPES: FaceOption[] = [
  { id: 'mince',       label: 'Mince / élancée',    prompt: 'slim slender build, lean frame' },
  { id: 'athletique',  label: 'Athlétique',         prompt: 'athletic toned build with visible fitness' },
  { id: 'musclee',     label: 'Sportive musclée',   prompt: 'muscular sporty build, well-developed musculature' },
  { id: 'curvy',       label: 'Curvy',              prompt: 'curvy hourglass build with generous curves' },
  { id: 'plus-size',   label: 'Plus size',          prompt: 'plus-size full-figured body, confident and proportionate' },
  { id: 'androgyne',   label: 'Androgyne longiligne',prompt: 'androgynous elongated frame, minimal curves, linear silhouette' },
  { id: 'normale',     label: 'Standard / normale', prompt: 'average natural body type, neither slim nor heavy' },
]

export const HEAD_RATIOS: FaceOption[] = [
  { id: '8',   label: '8 têtes (réaliste)',            prompt: 'body height = 8 heads (realistic well-proportioned adult)' },
  { id: '9',   label: '9 têtes (mannequin)',           prompt: 'body height = 9 heads (professional fashion model proportions, head noticeably small relative to body)' },
  { id: '9.5', label: '9.5 têtes (top model)',         prompt: 'body height = 9.5 heads (elite runway top-model proportions, small head, very long legs, hip line well above the vertical midpoint)' },
  { id: '10',  label: '10 têtes (fashion illustration)',prompt: 'body height = 10 heads (exaggerated fashion illustration proportions, very small head, extremely long legs — Vogue croquis style)' },
]

export const SHOULDERS: FaceOption[] = [
  { id: 'etroites',  label: 'Étroites',   prompt: 'narrow shoulders' },
  { id: 'moyennes',  label: 'Moyennes',   prompt: 'medium balanced shoulders' },
  { id: 'larges',    label: 'Larges',     prompt: 'broad wide shoulders' },
  { id: 'tombantes', label: 'Tombantes',  prompt: 'sloping soft shoulders' },
]

export const MUSCULATURES: FaceOption[] = [
  { id: 'fine',      label: 'Fine',              prompt: 'minimal muscle definition, soft slender limbs' },
  { id: 'tonique',   label: 'Tonique discrète',  prompt: 'subtle muscle tone, naturally fit without visible definition' },
  { id: 'definie',   label: 'Définie',           prompt: 'clearly defined musculature, visible tone in arms and shoulders' },
  { id: 'marquee',   label: 'Marquée',           prompt: 'strongly developed visible musculature' },
]

export const LEG_LENGTHS: FaceOption[] = [
  { id: 'proportionnees', label: 'Proportionnées',   prompt: 'legs proportionate to the torso (~48% of total height)' },
  { id: 'longues',        label: 'Longues',          prompt: 'long legs (~53% of total height), noticeably longer than the torso' },
  { id: 'tres-longues',   label: 'Très longues',     prompt: 'exceptionally long legs (~58% of total height), hip line far above the vertical midpoint of the silhouette' },
]

export const POSTURES: FaceOption[] = [
  { id: 'droite',      label: 'Droite naturelle',    prompt: 'standing straight, natural relaxed posture, arms at sides' },
  { id: 'relachee',    label: 'Relâchée',            prompt: 'loose casual stance, weight slightly shifted' },
  { id: 'dehanchee',   label: 'Hanche déhanchée',    prompt: 'contrapposto stance, weight on one leg, hip pushed out' },
  { id: 'confiante',   label: 'Confiante',           prompt: 'shoulders back, chest open, confident commanding stance' },
]

export const HANDS: FaceOption[] = [
  { id: 'fines-longues', label: 'Fines & longues',  prompt: 'slender elegant hands with long fingers' },
  { id: 'moyennes',      label: 'Moyennes',         prompt: 'average proportioned hands' },
  { id: 'larges',        label: 'Larges',           prompt: 'broad strong hands' },
]

export const CHEST_SIZES: FaceOption[] = [
  { id: 'petite',    label: 'Petite',    prompt: 'small bust' },
  { id: 'moyenne',   label: 'Moyenne',   prompt: 'medium bust' },
  { id: 'genereuse', label: 'Généreuse', prompt: 'fuller bust' },
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
  // ===== Corps =====
  bodyType:     string
  headRatio:    string
  shoulders:    string
  musculature:  string
  legLength:    string
  posture:      string
  hands:        string
  chestSize:    string        // femme uniquement
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

/**
 * Prompt pour la vue PLEIN-PIED (silhouette entière), envoyé AVEC l'image de face
 * générée en référence pour garantir la cohérence d'identité.
 */
export function buildFullBodyPrompt(sel: FaceSelection): string {
  const isFemale = sel.gender === 'femme'
  return [
    'PROFESSIONAL MODEL CASTING PHOTOGRAPH — FULL BODY VIEW (digitals / polaroid style).',
    '',
    '⚠ The attached image is the FRONT PORTRAIT of this exact model, shot moments ago in the same casting session.',
    'Produce the FULL BODY standing shot of THE SAME PERSON.',
    '',
    '=== ABSOLUTE IDENTITY CONSISTENCY (critical) ===',
    'The face must be UNMISTAKABLY the same person as the reference : same facial features, same skin tone and texture, same freckles / marks / scars at the SAME positions, same hair color, same haircut and length, same eyebrows, same eye color and shape, same nose, same lips, same piercings and tattoos in the same spots.',
    '',
    '=== BODY SPECIFICATION ===',
    `• Build : ${p(BODY_TYPES, sel.bodyType)}.`,
    `• Proportions : ${p(HEAD_RATIOS, sel.headRatio)}.`,
    `  ⚠ The head must look PROPORTIONALLY SMALL relative to the body. A head that is too large instantly makes the silhouette look short and stocky — this is the most common mistake, avoid it.`,
    `• Legs : ${p(LEG_LENGTHS, sel.legLength)}.`,
    `• Shoulders : ${p(SHOULDERS, sel.shoulders)}.`,
    `• Musculature : ${p(MUSCULATURES, sel.musculature)}.`,
    `• Hands : ${p(HANDS, sel.hands)}.`,
    isFemale ? `• Bust : ${p(CHEST_SIZES, sel.chestSize)}.` : '',
    `• Posture : ${p(POSTURES, sel.posture)}.`,
    '',
    '=== FRAMING / TECHNICAL (identical setup to the portrait) ===',
    '• FRAMING : FULL BODY, head to feet, entire silhouette visible. 4-6% margin above the head and below the feet. The model fills the frame vertically.',
    '• ANGLE : straight-on front view, camera at waist height with a very slight low angle (this optically lengthens the legs, standard casting practice).',
    '• BACKGROUND : the exact same pure white seamless studio backdrop (#FFFFFF), uniform, no gradient, no props.',
    '• LIGHTING : the exact same soft even studio lighting as the portrait.',
    '• STYLING : plain fitted neutral basics that reveal the body line — a simple white or grey tank top / t-shirt and plain shorts or briefs (standard casting digitals outfit). Barefoot. No logos, no accessories beyond the specified piercings.',
    '• EXPRESSION : neutral relaxed, looking straight at the camera.',
    '• RENDERING : photorealistic, sharp, natural skin texture. Real casting digitals look, not a retouched ad.',
    '',
    '⚠ SELF-CHECK before output : count the heads from top of skull to feet. You must find the number specified above. If you find 7-8 when 9.5 was requested, the legs are too short and the head too big — redo with a smaller head and longer legs.',
  ].filter(l => l !== '').join('\n')
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
    // Corps
    bodyType:      pick(BODY_TYPES).id,
    headRatio:     pick(HEAD_RATIOS.slice(1)).id,   // évite le 8 têtes (trop réaliste pour de la mode)
    shoulders:     pick(SHOULDERS).id,
    musculature:   pick(MUSCULATURES).id,
    legLength:     pick(LEG_LENGTHS).id,
    posture:       pick(POSTURES).id,
    hands:         pick(HANDS).id,
    chestSize:     isMale ? 'moyenne' : pick(CHEST_SIZES).id,
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
    asymmetry: 'legere', gaze: 'direct-doux', mouth: 'neutre',
    bodyType: 'mince', headRatio: '9.5', shoulders: 'moyennes',
    musculature: 'tonique', legLength: 'tres-longues', posture: 'droite',
    hands: 'fines-longues', chestSize: 'moyenne',
    extraNotes: '',
  }
}

/* ============================== ANALYSE D'IMAGE ============================== */

/**
 * Construit le prompt d'analyse envoyé à Gemini Vision avec une photo de référence.
 * Gemini doit retourner un JSON dont les valeurs sont les IDs de nos options.
 */
export function buildAnalysisPrompt(): string {
  const listOf = (name: string, opts: FaceOption[]) =>
    `"${name}": one of [${opts.map(o => `"${o.id}"`).join(', ')}]`

  return [
    'Analyse la photo de visage fournie et retourne UNIQUEMENT un objet JSON valide (aucun texte avant ou après, pas de bloc markdown).',
    '',
    'Le JSON doit avoir exactement ces clés, chaque valeur étant l\'un des IDs listés :',
    '{',
    `  ${listOf('gender', GENDERS)},`,
    `  ${listOf('ageRange', AGE_RANGES)},`,
    `  ${listOf('range', RANGES)},`,
    `  ${listOf('undertone', UNDERTONES)},`,
    `  ${listOf('skinTone', SKIN_TONES)},`,
    `  ${listOf('faceShape', FACE_SHAPES)},`,
    `  "boneStructure": array of 1 to 4 ids from [${BONE_STRUCTURES.map(o => `"${o.id}"`).join(', ')}],`,
    `  ${listOf('target', TARGETS)},`,
    `  ${listOf('eyeColor', EYE_COLORS)},`,
    `  ${listOf('eyeShape', EYE_SHAPES)},`,
    `  ${listOf('eyebrows', EYEBROWS)},`,
    `  ${listOf('hairColor', HAIR_COLORS)},`,
    `  "hairCut": one of [${[...HAIR_CUTS_F, ...HAIR_CUTS_M].map(o => `"${o.id}"`).filter((v, i, a) => a.indexOf(v) === i).join(', ')}],`,
    `  ${listOf('facialHair', FACIAL_HAIR)},`,
    `  ${listOf('skinFinish', SKIN_FINISHES)},`,
    `  "distinctive": array of 0 to 3 ids from [${DISTINCTIVE_FEATURES.map(o => `"${o.id}"`).join(', ')}],`,
    `  ${listOf('tattoo', TATTOOS)},`,
    `  ${listOf('piercing', PIERCINGS)},`,
    `  ${listOf('asymmetry', ASYMMETRIES)},`,
    `  ${listOf('gaze', GAZES)},`,
    `  ${listOf('mouth', MOUTHS)},`,
    `  ${listOf('bodyType', BODY_TYPES)},`,
    `  ${listOf('shoulders', SHOULDERS)},`,
    `  ${listOf('musculature', MUSCULATURES)},`,
    `  ${listOf('chestSize', CHEST_SIZES)}`,
    '}',
    '',
    '⚠ Consignes :',
    '  • Choisis TOUJOURS une valeur pour chaque clé, même si tu n\'es pas certain — prends l\'option la plus proche.',
    '  • Si le corps n\'est pas visible sur la photo (portrait seul), déduis bodyType / shoulders / musculature / chestSize de la morphologie du visage, du cou et des épaules visibles.',
    '  • "range" et "target" sont des interprétations marketing : juge le style général et l\'énergie du visage.',
    '  • "undertone" : observe la nuance sous la peau (rosée = froid, dorée = chaud, équilibrée = neutre).',
    '  • "distinctive" : ne liste QUE ce qui est réellement visible (taches de rousseur, grain de beauté, fossettes…). Tableau vide si rien de notable.',
    '  • Réponds avec le JSON brut uniquement.',
  ].join('\n')
}

/** Parse la réponse JSON de Gemini et la fusionne avec une sélection existante. */
export function mergeAnalysis(current: FaceSelection, raw: any): FaceSelection {
  const validId = (list: FaceOption[], v: any, fallback: string): string =>
    (typeof v === 'string' && list.some(o => o.id === v)) ? v : fallback
  const validMulti = (list: FaceOption[], v: any): string[] =>
    Array.isArray(v) ? v.filter((x: any) => typeof x === 'string' && list.some(o => o.id === x)) : []

  const gender = validId(GENDERS, raw?.gender, current.gender)
  const cuts = gender === 'homme' ? HAIR_CUTS_M : HAIR_CUTS_F

  return {
    gender,
    ageRange:      validId(AGE_RANGES,   raw?.ageRange,   current.ageRange),
    range:         validId(RANGES,       raw?.range,      current.range),
    undertone:     validId(UNDERTONES,   raw?.undertone,  current.undertone),
    skinTone:      validId(SKIN_TONES,   raw?.skinTone,   current.skinTone),
    faceShape:     validId(FACE_SHAPES,  raw?.faceShape,  current.faceShape),
    boneStructure: validMulti(BONE_STRUCTURES, raw?.boneStructure).length
                     ? validMulti(BONE_STRUCTURES, raw?.boneStructure) : current.boneStructure,
    target:        validId(TARGETS,      raw?.target,     current.target),
    eyeColor:      validId(EYE_COLORS,   raw?.eyeColor,   current.eyeColor),
    eyeShape:      validId(EYE_SHAPES,   raw?.eyeShape,   current.eyeShape),
    eyebrows:      validId(EYEBROWS,     raw?.eyebrows,   current.eyebrows),
    hairColor:     validId(HAIR_COLORS,  raw?.hairColor,  current.hairColor),
    hairCut:       validId(cuts,         raw?.hairCut,    cuts[0].id),
    facialHair:    validId(FACIAL_HAIR,  raw?.facialHair, current.facialHair),
    skinFinish:    validId(SKIN_FINISHES,raw?.skinFinish, current.skinFinish),
    distinctive:   validMulti(DISTINCTIVE_FEATURES, raw?.distinctive),
    tattoo:        validId(TATTOOS,      raw?.tattoo,     'aucun'),
    piercing:      validId(PIERCINGS,    raw?.piercing,   'aucun'),
    asymmetry:     validId(ASYMMETRIES,  raw?.asymmetry,  current.asymmetry),
    gaze:          validId(GAZES,        raw?.gaze,       current.gaze),
    mouth:         validId(MOUTHS,       raw?.mouth,      current.mouth),
    bodyType:      validId(BODY_TYPES,   raw?.bodyType,   current.bodyType),
    headRatio:     current.headRatio,     // non analysable depuis un portrait → on garde le choix user
    shoulders:     validId(SHOULDERS,    raw?.shoulders,  current.shoulders),
    musculature:   validId(MUSCULATURES, raw?.musculature,current.musculature),
    legLength:     current.legLength,     // non analysable depuis un portrait
    posture:       current.posture,       // choix artistique, pas une donnée du visage
    hands:         current.hands,
    chestSize:     validId(CHEST_SIZES,  raw?.chestSize,  current.chestSize),
    extraNotes:    current.extraNotes,
  }
}
