/**
 * Parse un fichier Excel qui dit quels visuels regénérer selon la couleur des cellules.
 *
 * Format attendu :
 *  - Colonne A : numéro du look (entier ou string)
 *  - Colonnes B, C, D, E : VUE 1, VUE 2, VUE 3, VUE 4
 *
 * Règle :
 *  - Cellule VERTE          → visuel déjà OK, NE PAS régénérer
 *  - Cellule ROUGE / JAUNE  → visuel à régénérer (avec ou sans commentaire)
 *  - Cellule VIDE/BLANCHE   → à régénérer (ou n'existe pas, on tente quand même)
 *
 * Lit la couleur via xlsx-js-style (fork SheetJS qui expose les styles de fond).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ExcelSelection = {
  /** Pour chaque numeroLook → indices 0-based des vues à régénérer */
  toRegenerate: Map<string, Set<number>>
  /** Liste des looks présents dans l'Excel (pour différencier "pas dans l'Excel" de "dans l'Excel mais tout vert") */
  looksFound: Set<string>
  /** Avertissements éventuels du parser */
  warnings: string[]
}

export async function parseExcelSelection(file: File): Promise<ExcelSelection> {
  const XLSX: any = (await import('xlsx-js-style')).default ?? (await import('xlsx-js-style'))
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array', cellStyles: true })

  const warnings: string[] = []
  const sheetName = wb.SheetNames[0]
  if (!sheetName) {
    throw new Error('Le fichier Excel ne contient aucune feuille.')
  }
  const sheet = wb.Sheets[sheetName]
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1')

  const toRegenerate = new Map<string, Set<number>>()
  const looksFound = new Set<string>()

  // Skip header row (rangée 0). Démarre à row 1.
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    // Colonne A = numeroLook
    const lookAddr = XLSX.utils.encode_cell({ r, c: 0 })
    const lookCell = sheet[lookAddr]
    if (!lookCell || lookCell.v === undefined || lookCell.v === null) continue

    const numeroLook = String(lookCell.v).trim()
    if (!numeroLook) continue
    looksFound.add(numeroLook)

    const regenVues = new Set<number>()

    // Colonnes B (1), C (2), D (3), E (4) = VUE 1, 2, 3, 4
    for (let c = 1; c <= 4; c++) {
      const vueAddr = XLSX.utils.encode_cell({ r, c })
      const vueCell = sheet[vueAddr]
      const isGreen = detectGreen(vueCell)
      if (!isGreen) {
        // Pas vert (rouge / jaune / vide / autre) → à régénérer
        regenVues.add(c - 1) // vueIndex 0-based
      }
    }

    toRegenerate.set(numeroLook, regenVues)
  }

  if (looksFound.size === 0) {
    warnings.push('Aucun look trouvé dans l\'Excel. Vérifie que la 1re ligne est un header et la colonne A contient les numéros de look.')
  }

  return { toRegenerate, looksFound, warnings }
}

/**
 * Détecte si une cellule a un fond vert.
 *
 * Règle :
 *  - g > r + 15 ET g > b + 15 (vert dominant)
 *  - g >= 100 (pas un noir-verdâtre quasi-noir)
 *
 * Couvre les verts pastel d'Excel (D9EAD3, B6D7A8, 93C47D, 6AA84F...) ainsi
 * que les verts plus saturés (00FF00 etc.).
 */
function detectGreen(cell: any): boolean {
  if (!cell || !cell.s) return false
  const fill = cell.s.fill
  if (!fill) return false

  // La couleur peut être dans fgColor.rgb ou bgColor.rgb. Format hex : "FFRRGGBB" ou "RRGGBB".
  const rgbStr: string =
    (fill.fgColor && (fill.fgColor.rgb || fill.fgColor.argb)) ||
    (fill.bgColor && (fill.bgColor.rgb || fill.bgColor.argb)) ||
    ''
  if (!rgbStr || typeof rgbStr !== 'string') return false

  const hex = rgbStr.length === 8 ? rgbStr.slice(2) : rgbStr
  if (hex.length < 6) return false

  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  if (isNaN(r) || isNaN(g) || isNaN(b)) return false

  return g > r + 15 && g > b + 15 && g >= 100
}
