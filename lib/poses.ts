/**
 * Bibliothèque de Vues et Poses Miraggia.
 *
 * Chaque cellule "Vue et Pose X" dans le Notion ressemble à :
 *   "Front, simple"   |   "Side, nonchalante"   |   "Close up Haut, mode"  …
 *
 * 👉 Architecture en DEUX dimensions indépendantes :
 *
 *   • VUE  → angle de caméra, type de plan, orientation du sujet
 *            (Front, Side, Back, Close up Haut, Close up Bas)
 *
 *   • POSE → posture du corps, attitude, regard, expression
 *            (simple, nonchalante, mouvement, mode, regard, epaule, reflective, attitude, silhouette)
 *
 *   Le prompt final = VUE_PROMPTS[vue] + ". " + POSE_PROMPTS[pose].
 *
 *   Ajouter une nouvelle VUE ou une nouvelle POSE = 1 ligne dans le bon dico.
 *   Pas besoin de définir toutes les combinaisons à la main.
 */

/* ============================== TYPES ============================== */

export type PoseView = 'Front' | 'Side' | 'Back' | 'CloseUpHaut' | 'CloseUpBas'

export type PoseLabel = {
  view:  PoseView
  style: string  // ex : "simple", "nonchalante", "mouvement", "mode"
  raw:   string  // la cellule d'origine, ex "Front, nonchalante"
}

/* ============================== PARSING ============================== */

/**
 * Alias acceptés pour la VUE (insensible à la casse, espaces / tirets / underscores tolérés).
 */
const VIEW_ALIASES: Record<string, PoseView> = {
  'front':           'Front',
  'face':            'Front',
  'side':            'Side',
  'profil':          'Side',
  'profile':         'Side',
  'back':            'Back',
  'dos':             'Back',
  'close up haut':   'CloseUpHaut',
  'closeup haut':    'CloseUpHaut',
  'close-up haut':   'CloseUpHaut',
  'gros plan haut':  'CloseUpHaut',
  'cu haut':         'CloseUpHaut',
  'close up bas':    'CloseUpBas',
  'closeup bas':     'CloseUpBas',
  'close-up bas':    'CloseUpBas',
  'gros plan bas':   'CloseUpBas',
  'cu bas':          'CloseUpBas',
  'bas':             'CloseUpBas',     // SOMBO platform label
  'haut':            'CloseUpHaut',    // SOMBO platform label
  // Aliases 3/4 (SOMBO) — on les rabat sur Side faute de mieux,
  // tu peux créer un type ThreeQuarter plus tard si tu veux les distinguer.
  '3/4 face droite': 'Side',
  '3/4 face gauche': 'Side',
  '3/4 dos droite':  'Back',
  '3/4 dos gauche':  'Back',
  '3 4 face droite': 'Side',
  '3 4 face gauche': 'Side',
  '3 4 dos droite':  'Back',
  '3 4 dos gauche':  'Back',
}

/**
 * Parse une cellule Notion "Vue, pose" en PoseLabel structuré.
 * Tolère :
 *   - "Front, simple"           (ordre canonique)
 *   - "simple, Front"           (ordre inversé — détecte la vue où qu'elle soit)
 *   - "3/4 face droite, mode"   (vues composées)
 *   - "Side, regard intense"    (pose libre multi-mots)
 *   - "main poche, Front"       (pose libre + vue en 2e)
 * Retourne null si on ne reconnaît aucune vue dans la cellule.
 */
export function parsePoseCell(cell: string | null | undefined): PoseLabel | null {
  if (!cell) return null
  const trimmed = cell.trim()
  if (!trimmed) return null

  const parts = trimmed.split(/[,/|·]/).map(s => s.trim()).filter(Boolean)
  if (parts.length < 2) return null

  // On cherche la vue dans n'importe laquelle des parts (ordre flexible)
  let viewIndex = -1
  let view: PoseView | null = null
  for (let i = 0; i < parts.length; i++) {
    const v = VIEW_ALIASES[normalizeKey(parts[i])]
    if (v) { view = v; viewIndex = i; break }
  }
  if (!view || viewIndex < 0) return null

  // Toutes les autres parts forment la pose (concaténées)
  const styleParts = parts.filter((_, i) => i !== viewIndex)
  const style = styleParts.join(' ').trim().toLowerCase()
  if (!style) return null

  return { view, style, raw: trimmed }
}

function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // retire les accents
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/* ============================== VUES ============================== */

const VIEW_PROMPTS: Record<PoseView, string> = {
  'Front':
    'eye-level shot, plan américain 50mm, face caméra, sujet de pied jusqu\'aux genoux, composition centrée éditoriale, focus net sur le sujet',

  'Side':
    'eye-level shot, plan américain 50mm, profil gauche caméra strict, sujet vu de côté de pied jusqu\'aux genoux, composition latérale assumée, focus net sur la silhouette',

  'Back':
    'eye-level shot, plan américain 50mm, dos complet caméra, sujet vu de dos de la tête jusqu\'aux genoux, composition centrée éditoriale, focus net sur la silhouette de dos',

  'CloseUpHaut':
    'eye-level shot, gros plan haut du corps 85mm, half-body shot (tête et épaules) ou bust shot, cadrage rapproché poitrine-tête, profondeur de champ très courte (f/1.8 ressenti), focus net sur le visage, fond légèrement flouté',

  'CloseUpBas':
    'low-angle shot léger, gros plan bas du corps 50mm, cadrage rapproché taille-pieds ou genoux-pieds, focus net sur la silhouette basse, perspective allongeante, jambes et chaussures mises en valeur',
}

/* ============================== POSES ============================== */

const POSE_PROMPTS: Record<string, string> = {
  'simple':
    'high-end fashion editorial, Vogue-style standing pose. posture varies randomly between: relaxed contrapposto with one hand near waist, straight with hands behind back, or slight weight shift. narrow elegant leg placement, strictly avoid wide triangle legs. no smiling',

  'nonchalante':
    'high-end fashion editorial, Vogue-style relaxed pose. posture varies randomly between: subtle slouch with arm resting, grounded with hands in front pockets, or fluid asymmetrical stance. natural narrow feet placement, strictly avoid rigid wide triangle legs. no smiling',

  'mouvement':
    'high-end fashion editorial, Vogue-style dynamic pose. posture varies randomly between: offset walking stride, twisting torso looking over shoulder, or expressive backward arch. fluid body language, strictly avoid stiff or wide triangle leg stances. no smiling',

  'mode':
    'high-end fashion editorial, Vogue-style stylized pose. posture varies randomly between: hands clasped behind head with offset hips, hands adjusting hat symmetrically, or one hand touching glasses in contrapposto. elegant narrow stance, strictly avoid wide triangle legs. no smiling',

  // ----- Poses ajoutées pour varier Side / Back -----

  'regard':
    'high-end fashion editorial, Vogue-style gaze-focused pose. posture varies randomly between: head turned 3/4 looking off-camera into the distance with one hand brushing collarbone, strict profile gaze with weight shifted to back leg and free hand by hip, or quarter turn with chin lifted and fingertips grazing jawline. narrow elegant leg placement, strictly avoid wide triangle legs. no smiling',

  'epaule':
    'high-end fashion editorial, Vogue-style over-the-shoulder pose. posture varies randomly between: full back to camera with head turned looking over the right shoulder and hand grazing the nape, 3/4 dos with weight on one leg and torso twisted to glance back at the lens, or back stance with both arms relaxed and gaze cast diagonally over the shoulder. narrow elegant leg placement, strictly avoid wide triangle legs. no smiling',

  'reflective':
    'high-end fashion editorial, Vogue-style introspective pose. posture varies randomly between: hand lightly resting against the chin with eyes cast slightly down, fingertips near the temple with head softly tilted, or palm grazing the collarbone with a quiet downward gaze. narrow elegant leg placement, strictly avoid wide triangle legs. no smiling',

  'attitude':
    'high-end fashion editorial, Vogue-style assertive pose. posture varies randomly between: one hand firmly on hip with shoulders squared and chin slightly up, both hands relaxed but planted at the sides with a grounded stance, or arms crossed elegantly with the weight shifted onto one leg. narrow elegant leg placement, strictly avoid wide triangle legs. no smiling',

  'silhouette':
    'high-end fashion editorial, Vogue-style sculptural pose. posture varies randomly between: one arm raised overhead drawing a clean line with the other resting on the hip, both arms forming a soft frame around the face, or arms extended sideways like a dancer\'s geste with the weight on the back leg. narrow elegant leg placement, strictly avoid wide triangle legs. no smiling',
}

/* ============================== MATRICE VIEW × POSE (overrides) ============================== */

/**
 * Mapping fin : `<View>/<pose>` → prompt complet pour cette combinaison précise.
 * Quand un override existe ici, il prend le pas sur la composition
 * VIEW_PROMPTS + POSE_PROMPTS. Idéal pour caler le rendu exact d'une
 * pose dans une vue particulière.
 *
 * Source : tableau Léa Medioni (Notion / Sheets).
 * Vues : face → Front, profil → Side, dos → Back.
 * Si la pose n'a pas d'override pour la vue demandée (ex : Close up Haut),
 * on retombe sur la composition générique.
 */
const VIEW_POSE_PROMPTS: Record<string, string> = {
  // ----- droit -----
  'Front/droit': 'standing pose, straight posture, arms relaxed, head turned to the side, legs slightly apart, relaxed stance',
  'Side/droit':  'profile view, side shot, standing pose, straight posture, arms relaxed down the side, looking straight ahead, legs slightly apart, side profile stance',
  'Back/droit':  'back view, shot from behind, standing pose, straight posture, arms relaxed, facing away from camera, legs slightly apart, relaxed stance',

  // ----- relax -----
  'Front/relax': 'standing pose, relaxed posture, weight on one hip, one leg slightly bent, arms relaxed, casual stance',
  'Side/relax':  'side view, profile shot, standing pose, relaxed posture, weight on back hip, one leg slightly bent, arms relaxed, casual stance',
  'Back/relax':  'back view, shot from behind, standing pose, relaxed posture, weight on one hip, one leg slightly bent, arms relaxed, casual stance',

  // ----- bras croisé side -----
  'Front/bras croisé side': 'standing pose, arms crossed over chest, head turned looking to the side, relaxed stance with legs slightly apart',
  'Side/bras croisé side':  'profile view, standing pose, arms crossed over chest, looking to the camera, relaxed stance with legs slightly apart',
  'Back/bras croisé side':  'back view, shot from behind, standing pose, arms crossed in front, head turned slightly visible from behind, relaxed stance with legs slightly apart',

  // ----- bras croisé face -----
  'Front/bras croisé face': 'standing pose, arms crossed over chest, relaxed stance with legs slightly apart',
  'Side/bras croisé face':  'side view, standing pose, arms crossed over chest, relaxed stance with legs slightly apart',
  'Back/bras croisé face':  'back view, shot from behind, standing pose, arms crossed in front, relaxed stance with legs slightly apart, looking forward away from camera',

  // ----- main poche -----
  'Front/main poche': 'standing straight, one hand tucked into back pockets, shoulders slightly pulled back, feet close together, looking forward',
  'Side/main poche':  'profile view, side angle, standing straight, one hand tucked into back pocket clearly visible on the side, shoulders slightly pulled back, feet close together, looking ahead',
  'Back/main poche':  'back view, shot from behind, standing straight, one hand tucked into back pockets, shoulders slightly pulled back, feet close together, looking forward away from camera',

  // ----- une main derrière le dos -----
  'Front/une main derrière le dos': 'standing straight, one hand clasped behind back, arms hidden behind torso, upright and confident posture, legs slightly apart',
  'Side/une main derrière le dos':  'side view, standing straight, one hand clasped behind back, arm extending backwards, upright and confident posture, legs slightly apart',
  'Back/une main derrière le dos':  'back view, shot from behind, standing straight, one hand clasped behind back clearly visible to camera, upright and confident posture, legs slightly apart',

  // ----- mains derrière le dos -----
  'Front/mains derrière le dos': 'standing straight, both hands clasped behind back, arms hidden behind torso, upright and confident posture, legs slightly apart',
  'Side/mains derrière le dos':  'profile view, standing straight, both hands clasped behind back, arm extending backwards, upright and confident posture, legs slightly apart',
  'Back/mains derrière le dos':  'back view, shot from behind, standing straight, both hands clasped behind back clearly visible to camera, upright and confident posture, legs slightly apart',

  // ----- main derrière la tête -----
  'Front/main derrière la tête': 'standing pose, one hand resting gently behind the neck naturally, raised elbow pointing outward, opposite arm hanging straight down at the side, straight upright posture',
  'Side/main derrière la tête':  'side view, standing pose, one hand resting gently behind the neck, raised elbow pointing forward, opposite arm hanging straight down at the side, straight upright posture',
  'Back/main derrière la tête':  'back view, shot from behind, standing pose, one hand resting gently behind the neck clearly visible, raised elbow pointing outward, opposite arm hanging straight down, straight upright posture',

  // ----- main au visage -----
  'Front/main au visage': 'standing pose, one arm folded horizontally across waist, opposite arm raised with hand gently touching chin, raised elbow resting on the folded arm, confident relaxed posture',
  'Side/main au visage':  'profile view, standing pose, one arm folded horizontally across waist, opposite arm raised with hand gently touching chin, raised elbow resting on the folded arm, confident relaxed side posture',
  'Back/main au visage':  'back view, shot from behind, standing pose, one arm folded across front waist, opposite hand reaching to touch chin, side of face slightly visible from behind, confident relaxed posture',

  // ----- assise -----
  'Front/assise': 'deep crouching pose, full squat, arms folded and resting on bent knees, torso leaning slightly forward, compact posture',
  'Side/assise':  'side view, profile shot, deep crouching pose, full squat, arms folded and resting on bent knees, torso leaning slightly forward, compact posture',
  'Back/assise':  'back view, shot from behind, deep crouching pose, full squat, back facing camera, torso leaning slightly forward, compact posture',
}

/* ============================== COMBINAISON ============================== */

export function viewToPrompt(view: PoseView): string {
  return VIEW_PROMPTS[view]
}

export function styleToPrompt(style: string): string {
  return POSE_PROMPTS[style] ||
    `pose "${style}" (à définir précisément dans lib/poses.ts pour un meilleur rendu)`
}

/** Renvoie le prompt complet pour une PoseLabel = VUE + POSE. */
export function poseToPrompt(label: PoseLabel): string {
  // 1) Override view+pose exact si dispo (depuis le tableau Léa Medioni)
  const exactKey = `${label.view}/${label.style.toLowerCase()}`
  if (VIEW_POSE_PROMPTS[exactKey]) return VIEW_POSE_PROMPTS[exactKey]
  // 2) Sinon composition générique
  const vuePart  = viewToPrompt(label.view)
  const posePart = styleToPrompt(label.style)
  return `${vuePart}. ${posePart}.`
}

/* ============================== CATALOGUE (UI) ============================== */

/**
 * Catalogues exportés pour l'UI : permet à NotionTab de lister toutes les
 * vues et poses disponibles dans son écran d'accueil.
 */

export type ViewCatalogItem = {
  key:        PoseView
  label:      string          // libellé exact à utiliser dans Notion
  description:string          // description courte pour l'utilisateur
}

export type PoseCatalogItem = {
  key:        string          // clé exacte à utiliser dans Notion (lowercase)
  description:string
}

export const VIEW_CATALOG: ViewCatalogItem[] = [
  { key: 'Front',       label: 'Front',         description: 'Sujet face caméra, plan américain (genoux à tête).' },
  { key: 'Side',        label: 'Side',          description: 'Profil strict, plan américain latéral.' },
  { key: 'Back',        label: 'Back',          description: 'Dos complet caméra, plan américain.' },
  { key: 'CloseUpHaut', label: 'Close up Haut', description: 'Gros plan tête et épaules, fond légèrement flouté.' },
  { key: 'CloseUpBas',  label: 'Close up Bas',  description: 'Gros plan bas du corps (jambes, chaussures), low-angle léger.' },
]

export const POSE_CATALOG: PoseCatalogItem[] = [
  // Poses originales Vogue-style
  { key: 'simple',      description: 'Standing pose neutre, mains au repos, sérénité éditoriale.' },
  { key: 'nonchalante', description: 'Slouch décontracté, mains dans les poches, asymétrie fluide.' },
  { key: 'mouvement',   description: 'Marche figée, torsion du torse, énergie suspendue.' },
  { key: 'mode',        description: 'Pose éditoriale stylisée — peut introduire chapeau/lunettes.' },
  { key: 'regard',      description: 'Tête tournée, gaze hors-caméra ou profil affirmé.' },
  { key: 'epaule',      description: 'Over-the-shoulder, dos ou 3/4 dos regardant la caméra.' },
  { key: 'reflective',  description: 'Introspectif, main au menton, regard légèrement baissé.' },
  { key: 'attitude',    description: 'Stance assertif, mains aux hanches, présence forte.' },
  { key: 'silhouette',  description: 'Sculptural, bras dessinant une ligne, geste de danseur.' },
  // Poses Léa Medioni (matrice view × pose détaillée)
  { key: 'droit',                       description: 'Standing droit, bras relâchés, tête tournée sur le côté.' },
  { key: 'relax',                       description: 'Poids sur une hanche, une jambe légèrement pliée.' },
  { key: 'bras croisé side',            description: 'Bras croisés sur la poitrine, regard de côté.' },
  { key: 'bras croisé face',            description: 'Bras croisés sur la poitrine, face caméra.' },
  { key: 'main poche',                  description: 'Une main dans la poche arrière, épaules redressées.' },
  { key: 'une main derrière le dos',    description: 'Une main jointe derrière le dos, posture confiante.' },
  { key: 'mains derrière le dos',       description: 'Deux mains jointes derrière le dos, posture confiante.' },
  { key: 'main derrière la tête',       description: 'Une main détendue derrière la nuque, coude levé.' },
  { key: 'main au visage',              description: 'Un bras plié à la taille, autre main effleurant le menton.' },
  { key: 'assise',                      description: 'Squat / accroupi profond, bras pliés sur les genoux.' },
]

/* ============================== HARD CONSTRAINTS ============================== */

/**
 * Instruction de cadrage stricte selon la vue.
 * À insérer DANS le prompt envoyé à Gemini pour forcer la composition.
 * Sinon Gemini "déborde" souvent et montre tout (pieds quand on demande
 * close-up haut, visage quand on demande close-up bas, etc.).
 */
export function viewCropInstruction(view: PoseView): string {
  switch (view) {
    case 'CloseUpHaut':
      return '⚠ CADRAGE STRICT (priorité absolue) : la photo finale doit montrer UNIQUEMENT la tête, les épaules et le haut de la poitrine (half-body / bust shot). Ne montre JAMAIS les hanches, les jambes, les pieds, ni les chaussures. Si une chaussure ou un détail de jambe est visible dans les images de référence vêtement, IGNORE-le complètement. Crop au-dessus de la poitrine. C\'est NON-NÉGOCIABLE.'
    case 'CloseUpBas':
      return '⚠ CADRAGE STRICT (priorité absolue) : la photo finale doit montrer UNIQUEMENT le bas du corps (de la taille aux pieds, ou des genoux aux pieds). Ne montre JAMAIS le visage, la tête, ni le haut du buste. Crop sous la taille. Les chaussures et les jambes sont la star de la composition. C\'est NON-NÉGOCIABLE.'
    case 'Front':
      return '⚠ CADRAGE : plan américain face caméra, sujet visible de pied jusqu\'aux genoux (ou pieds compris si l\'inclut naturellement). Reste fidèle au cadrage demandé.'
    case 'Side':
      return '⚠ CADRAGE : plan américain en profil strict, sujet visible de pied jusqu\'aux genoux. Reste fidèle au cadrage demandé.'
    case 'Back':
      return '⚠ CADRAGE : plan américain dos complet caméra, sujet visible de la tête jusqu\'aux genoux. Reste fidèle au cadrage demandé.'
  }
}

/**
 * Instruction de préservation du fond.
 * Gemini a tendance à modifier la teinte / couleur du fond pour "harmoniser"
 * avec le sujet. On le force à respecter EXACTEMENT le fond de référence.
 */
export const BACKGROUND_PRESERVATION_INSTRUCTION =
  '⚠ FOND STRICT (priorité absolue) : utilise EXACTEMENT le fond montré en image de référence. Conserve à l\'identique la couleur du fond, sa teinte, sa luminosité, sa température (chaud/froid), sa texture, ses zones d\'ombre et de lumière, et toute marque visible (transitions sol/mur, props, plinthes, etc.). N\'ajuste PAS la colorimétrie du fond pour l\'harmoniser avec la tenue. Le fond doit être visuellement IDENTIQUE au fichier de référence fourni.'

/* ============================== BOILERPLATE ============================== */

export const NOTION_BOILERPLATE_HEADER =
  'Create a 4K HD fashion shooting lifestyle image'

export const NOTION_BOILERPLATE_STYLE =
  'Vogue-style editorial photography. Shot on film, visible grain, subtle blur, slight motion softness. Imperfect focus, organic textures, realistic skin with no heavy retouching. Raw, intimate, spontaneous fashion moment. High-end but not overly polished.'
