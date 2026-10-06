/**
 * Croquis de pose (bonhomme bâton) pour les poses dynamiques Lingerie.
 * Envoyé à Gemini comme image de référence de POSE : un dessin, pas une personne
 * → aucun risque de blocage, et Gemini suit une image bien mieux qu'une description.
 *
 * Coordonnées dans un repère 100 × 125 (x vers la droite du spectateur, y vers le bas).
 * L = côté gauche de l'image, R = côté droit.
 */
type P = [number, number]
type Skeleton = {
  head: P; neck: P
  sL: P; sR: P; eL: P; eR: P; wL: P; wR: P
  hL: P; hR: P; kL: P; kR: P; aL: P; aR: P
  floor?: number
}

const SKELETONS: Record<string, Skeleton> = {
  // Poses debout volontairement exagérées (colonne inclinée, bassin décalé, genou croisé) : un croquis droit donne une pose droite.
  'hanche':        { head: [58, 10], neck: [55, 19], sL: [45, 26], sR: [65, 20], eL: [24, 40], wL: [36, 54], eR: [74, 40], wR: [61, 62], hL: [35, 56], hR: [50, 63], kL: [40, 85], aL: [47, 113], kR: [45, 88], aR: [57, 108] },
  'trois-quarts':  { head: [60, 11], neck: [56, 19], sL: [46, 25], sR: [63, 20], eL: [34, 40], wL: [44, 52], eR: [70, 40], wR: [48, 66], hL: [42, 58], hR: [54, 60], kL: [51, 86], aL: [45, 113], kR: [42, 84], aR: [55, 111] },
  'cheveux':       { head: [55, 12], neck: [53, 20], sL: [43, 26], sR: [63, 23], eL: [30, 8],  wL: [48, 6],  eR: [74, 8],  wR: [60, 5],  hL: [38, 58], hR: [53, 54], kL: [42, 86], aL: [48, 113], kR: [60, 81], aR: [52, 109] },
  'bretelle':      { head: [46, 11], neck: [48, 19], sL: [37, 22], sR: [58, 20], eL: [24, 44], wL: [38, 50], eR: [70, 34], wR: [57, 22], hL: [44, 58], hR: [60, 55], kL: [47, 86], aL: [42, 113], kR: [60, 83], aR: [54, 110] },
  'marche':        { head: [52, 9],  neck: [51, 17], sL: [41, 22], sR: [61, 23], eL: [37, 40], wL: [30, 55], eR: [66, 37], wR: [62, 53], hL: [44, 56], hR: [57, 59], kL: [54, 80], aL: [46, 109], kR: [56, 86], aR: [66, 104] },
  'assise-sol':    { head: [44, 44], neck: [47, 52], sL: [39, 56], sR: [56, 54], eL: [33, 68], wL: [36, 80], eR: [67, 72], wR: [76, 110], hL: [50, 96], hR: [62, 94], kL: [36, 78], aL: [34, 110], kR: [80, 106], aR: [58, 111], floor: 112 },
  'genou':         { head: [47, 30], neck: [48, 38], sL: [40, 42], sR: [56, 42], eL: [32, 58], wL: [38, 74], eR: [66, 58], wR: [58, 72], hL: [46, 74], hR: [58, 76], kL: [38, 80], aL: [38, 111], kR: [60, 110], aR: [74, 111], floor: 112 },
  'assise-talons': { head: [50, 44], neck: [50, 52], sL: [41, 56], sR: [59, 56], eL: [36, 72], wL: [40, 90], eR: [68, 76], wR: [74, 110], hL: [48, 92], hR: [60, 94], kL: [30, 104], aL: [62, 111], kR: [36, 108], aR: [70, 110], floor: 112 },
}

export const hasPoseSketch = (poseId?: string) => !!poseId && poseId in SKELETONS

/** SVG 800 × 1000 du bonhomme bâton (fond blanc, traits noirs épais). */
export function poseSketchSvg(poseId: string): string {
  const s = SKELETONS[poseId]
  if (!s) throw new Error(`Pose inconnue : ${poseId}`)
  const k = 8   // 100 × 125 → 800 × 1000
  const pt = (p: P) => `${p[0] * k},${p[1] * k}`
  const mid = (a: P, b: P): P => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const pelvis = mid(s.hL, s.hR)
  const lines: [P, P][] = [
    [s.sL, s.sR], [s.hL, s.hR], [s.neck, pelvis],                    // épaules, bassin, colonne
    [s.sL, s.eL], [s.eL, s.wL], [s.sR, s.eR], [s.eR, s.wR],          // bras
    [s.hL, s.kL], [s.kL, s.aL], [s.hR, s.kR], [s.kR, s.aR],          // jambes
  ]
  const joints = [s.neck, s.sL, s.sR, s.eL, s.eR, s.wL, s.wR, s.hL, s.hR, s.kL, s.kR, s.aL, s.aR]
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000" viewBox="0 0 800 1000">`,
    `<rect width="800" height="1000" fill="#ffffff"/>`,
    s.floor ? `<line x1="40" y1="${s.floor * k}" x2="760" y2="${s.floor * k}" stroke="#bbbbbb" stroke-width="6"/>` : '',
    `<line x1="${s.head[0] * k}" y1="${s.head[1] * k + 44}" x2="${s.neck[0] * k}" y2="${s.neck[1] * k}" stroke="#111" stroke-width="22" stroke-linecap="round"/>`,
    ...lines.map(([a, b]) => `<line x1="${a[0] * k}" y1="${a[1] * k}" x2="${b[0] * k}" y2="${b[1] * k}" stroke="#111" stroke-width="22" stroke-linecap="round"/>`),
    ...joints.map(j => `<circle cx="${j[0] * k}" cy="${j[1] * k}" r="15" fill="#d33"/>`),
    `<circle cx="${pt(s.head).split(',')[0]}" cy="${pt(s.head).split(',')[1]}" r="46" fill="#111"/>`,
    `</svg>`,
  ].join('')
}
