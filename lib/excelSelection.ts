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
 * Gère les couleurs RGB directes ET les couleurs de thème Office (avec tint).
 *
 * Parcourt TOUS les onglets et fusionne les sélections par union.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ExcelSelection = {
  /** Pour chaque numeroLook → indices 0-based des vues à régénérer */
  toRegenerate: Map<string, Set<number>>
  /** Liste des looks présents dans l'Excel */
  looksFound: Set<string>
  /** Avertissements / infos du parser */
  warnings: string[]
}

export async function parseExcelSelection(file: File): Promise<ExcelSelection> {
  const XLSX: any = (await import('xlsx-js-style')).default ?? (await import('xlsx-js-style'))
  const buf = await file.arrayBuffer()
  // sheetStubs: true → garde les cellules vides MAIS colorées (sinon SheetJS
  // les ignore complètement et on perd les fonds verts D9EAD3 sans texte).
  const wb = XLSX.read(buf, { type: 'array', cellStyles: true, sheetStubs: true })

  const warnings: string[] = []
  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    throw new Error('Le fichier Excel ne contient aucune feuille.')
  }

  const toRegenerate = new Map<string, Set<number>>()
  const looksFound = new Set<string>()

  let totalGreen = 0
  let totalCells = 0
  let firstCellLogged = false

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName]
    if (!sheet || !sheet['!ref']) continue
    const range = XLSX.utils.decode_range(sheet['!ref'])

    let sheetLooks = 0
    for (let r = range.s.r + 1; r <= range.e.r; r++) {
      const lookAddr = XLSX.utils.encode_cell({ r, c: 0 })
      const lookCell = sheet[lookAddr]
      if (!lookCell || lookCell.v === undefined || lookCell.v === null) continue

      const numeroLook = String(lookCell.v).trim()
      if (!numeroLook) continue
      looksFound.add(numeroLook)
      sheetLooks++

      let regenVues = toRegenerate.get(numeroLook)
      if (!regenVues) {
        regenVues = new Set<number>()
        toRegenerate.set(numeroLook, regenVues)
      }

      for (let c = 1; c <= 4; c++) {
        const vueAddr = XLSX.utils.encode_cell({ r, c })
        const vueCell = sheet[vueAddr]
        totalCells++

        // Log le 1er cellule non-vide pour debug (structure du fill)
        if (!firstCellLogged && vueCell && vueCell.s && vueCell.s.fill) {
          console.log(`[excelSelection] DEBUG - 1re cellule analysée (${vueAddr}):`, JSON.stringify(vueCell.s, null, 2))
          firstCellLogged = true
        }

        const isGreen = detectGreen(vueCell)
        if (isGreen) {
          totalGreen++
        } else {
          regenVues.add(c - 1)
        }
      }
    }
    if (sheetLooks > 0) {
      warnings.push(`Onglet "${sheetName}" : ${sheetLooks} look(s) parsé(s).`)
    }
  }

  if (looksFound.size === 0) {
    warnings.push('Aucun look trouvé. Vérifie que chaque onglet a un header en ligne 1 et la colonne A avec les numéros de look.')
  }

  console.log(`[excelSelection] ${totalGreen} cellule(s) vert(es) détectée(s) sur ${totalCells} cellule(s) analysée(s)`)
  if (totalGreen === 0 && totalCells > 0) {
    warnings.push(`⚠ Aucun vert détecté ! Ouvre la console développeur (F12) pour voir la structure d'une cellule. Le fichier utilise peut-être des couleurs personnalisées non standard.`)
  }

  return { toRegenerate, looksFound, warnings }
}

/* ============================== Color helpers ============================== */

/**
 * Couleurs du thème Office par défaut.
 *   0: light 1 (white), 1: dark 1 (black)
 *   2: light 2, 3: dark 2
 *   4-9: accent 1 à 6 (accent 6 = 70AD47 = VERT)
 */
const DEFAULT_THEME_COLORS = [
  'FFFFFF', '000000', 'E7E6E6', '44546A',
  '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47',
]

/** Applique le tint Excel : >0 vers blanc, <0 vers noir. */
function applyTint(channel: number, tint: number): number {
  if (!tint) return channel
  if (tint > 0) return Math.round(channel + (255 - channel) * Math.min(1, tint))
  return Math.max(0, Math.round(channel * (1 + Math.max(-1, tint))))
}

/** Critère "vert" : G dominant. */
function isGreenRGB(r: number, g: number, b: number): boolean {
  if (isNaN(r) || isNaN(g) || isNaN(b)) return false
  return g > r + 15 && g > b + 15 && g >= 100
}

/**
 * Détecte si une cellule a un fond vert.
 *
 * Tente plusieurs sources de couleur dans cet ordre :
 *  1. RGB direct      : fill.fgColor.rgb / .argb (formats "FFRRGGBB" ou "RRGGBB")
 *  2. RGB sur bgColor : fill.bgColor.rgb / .argb
 *  3. Thème + tint    : fill.fgColor.theme = N (0-9) + fill.fgColor.tint = T
 *  4. Thème sur bg    : fill.bgColor.theme = N + .tint = T
 *
 * Si aucune source ne donne du vert → considéré non-vert (= à régénérer).
 */
function detectGreen(cell: any): boolean {
  if (!cell || !cell.s) return false
  const fill = cell.s.fill
  if (!fill) return false

  const sources = [fill.fgColor, fill.bgColor, fill.color]

  // Path 1 : RGB direct
  for (const src of sources) {
    if (!src) continue
    const rgbField = src.rgb || src.argb
    if (typeof rgbField === 'string' && rgbField.length >= 6) {
      const hex = rgbField.length === 8 ? rgbField.slice(2) : rgbField
      const r = parseInt(hex.slice(0, 2), 16)
      const g = parseInt(hex.slice(2, 4), 16)
      const b = parseInt(hex.slice(4, 6), 16)
      if (isGreenRGB(r, g, b)) return true
    }
  }

  // Path 2 : Thème Office (avec tint éventuel)
  for (const src of sources) {
    if (!src) continue
    if (typeof src.theme === 'number' && src.theme >= 0 && src.theme < DEFAULT_THEME_COLORS.length) {
      const baseHex = DEFAULT_THEME_COLORS[src.theme]
      const tint = typeof src.tint === 'number' ? src.tint : 0
      const r = applyTint(parseInt(baseHex.slice(0, 2), 16), tint)
      const g = applyTint(parseInt(baseHex.slice(2, 4), 16), tint)
      const b = applyTint(parseInt(baseHex.slice(4, 6), 16), tint)
      if (isGreenRGB(r, g, b)) return true
    }
  }

  return false
}
