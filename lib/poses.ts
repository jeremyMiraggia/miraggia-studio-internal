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
 *            (simple, nonchalante, mouvement, mode, …)
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

/**
 * Mapping VUE → angle de caméra, type de plan, orientation du sujet.
 * Édite librement.
 */
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

/**
 * Mapping POSE → posture du corps, attitude, regard, expression.
 * Édite librement. Les clés sont en lowercase.
 */
const POSE_PROMPTS: Record<string, string> = {
  'simple':
    'debout symétrique, poids équilibré sur les deux jambes, bras détendus le long du corps, mains relâchées, épaules ouvertes, dos droit, tête neutre, regard caméra direct, mâchoire détendue, expression neutre intense, sérénité maîtrisée, posture éditoriale épurée',

  'nonchalante':
    'debout en contrapposto marqué, poids sur une jambe, hanche décalée, épaules relâchées, une main enfoncée dans la poche, l\'autre bras pendant doigts détendus, jambe avant fléchie genou souple, tête légèrement inclinée, regard hors-cadre à mi-hauteur, mâchoire détendue, lèvres closes, sourire absent, attitude désinvolte',

  'mouvement':
    'marche figée en transition mid-step, jambe arrière levée mi-hauteur, bras en balanciers naturels, hanches en rotation, torse engagé, cheveux animés par le mouvement, dynamique suspendue, regard caméra direct, expression vivante et concentrée, énergie figée',

  'mode':
    'posture éditoriale assurée, hanches projetées légèrement vers l\'avant, épaules ouvertes et redressées, menton légèrement relevé, un bras placé sur la hanche, l\'autre en arc gracieux, jambe avant fléchie en angle, regard caméra intense et défiant, expression haute couture, attitude vogue, présence affirmée, statique sculptural',
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

/* ============================== BOILERPLATE ============================== */

/**
 * Phrases boilerplate collées automatiquement à CHAQUE prompt généré depuis
 * l'onglet Notion (cf. demande Jeremy 19/05/2026).
 */
export const NOTION_BOILERPLATE_HEADER =
  'Create a 4K HD fashion shooting lifestyle image'

export const NOTION_BOILERPLATE_STYLE =
  'Vogue-style editorial photography. Shot on film, visible grain, subtle blur, slight motion softness. Imperfect focus, organic textures, realistic skin with no heavy retouching. Raw, intimate, spontaneous fashion moment. High-end but not overly polished.'
