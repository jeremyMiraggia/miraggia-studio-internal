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

/** Parse une cellule Notion "Vue, pose" en PoseLabel structuré. Null si illisible. */
export function parsePoseCell(cell: string | null | undefined): PoseLabel | null {
  if (!cell) return null
  const trimmed = cell.trim()
  if (!trimmed) return null

  // Séparateurs tolérés : virgule, slash, pipe, point médian
  const parts = trimmed.split(/[,/|·]/).map(s => s.trim()).filter(Boolean)
  if (parts.length < 2) return null

  const viewKey = normalizeKey(parts[0])
  const view = VIEW_ALIASES[viewKey]
  if (!view) return null

  const style = parts.slice(1).join(' ').trim().toLowerCase()
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
  { key: 'simple',      description: 'Standing pose neutre, mains au repos, sérénité éditoriale.' },
  { key: 'nonchalante', description: 'Slouch décontracté, mains dans les poches, asymétrie fluide.' },
  { key: 'mouvement',   description: 'Marche figée, torsion du torse, énergie suspendue.' },
  { key: 'mode',        description: 'Pose éditoriale stylisée — peut introduire chapeau/lunettes.' },
  { key: 'regard',      description: 'Tête tournée, gaze hors-caméra ou profil affirmé.' },
  { key: 'epaule',      description: 'Over-the-shoulder, dos ou 3/4 dos regardant la caméra.' },
  { key: 'reflective',  description: 'Introspectif, main au menton, regard légèrement baissé.' },
  { key: 'attitude',    description: 'Stance assertif, mains aux hanches, présence forte.' },
  { key: 'silhouette',  description: 'Sculptural, bras dessinant une ligne, geste de danseur.' },
]

/* ============================== BOILERPLATE ============================== */

export const NOTION_BOILERPLATE_HEADER =
  'Create a 4K HD fashion shooting lifestyle image'

export const NOTION_BOILERPLATE_STYLE =
  'Vogue-style editorial photography. Shot on film, visible grain, subtle blur, slight motion softness. Imperfect focus, organic textures, realistic skin with no heavy retouching. Raw, intimate, spontaneous fashion moment. High-end but not overly polished.'
