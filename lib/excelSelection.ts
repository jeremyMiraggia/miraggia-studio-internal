/**
 * Parse un fichier Excel pour identifier quels visuels regénérer selon la
 * couleur de fond des cellules.
 *
 * Implémentation = parsing XML direct du XLSX (= ZIP) via JSZip, sans
 * dépendance à une lib lourde de styles. C'est plus robuste que SheetJS qui
 * a du mal avec les cellules vides MAIS colorées (cas typique du fichier user).
 *
 * Structure XLSX :
 *  - xl/styles.xml         → définit les <fill>, <cellXfs> (mapping style → fillId)
 *  - xl/workbook.xml       → liste des sheets avec rId
 *  - xl/_rels/workbook.xml.rels → rId → target path
 *  - xl/worksheets/sheet*.xml   → cellules avec attribut s="N" (= cellXf index)
 */

export type ExcelSelection = {
  /** Pour chaque numeroLook → indices 0-based des vues à régénérer */
  toRegenerate: Map<string, Set<number>>
  /** Liste des looks présents dans l'Excel */
  looksFound: Set<string>
  /** Avertissements / infos du parser */
  warnings: string[]
}

export async function parseExcelSelection(file: File): Promise<ExcelSelection> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(file)
  const warnings: string[] = []

  // ===== 1. Parse styles.xml : build fillId → rgb hex map, cellXfIdx → fillId map =====
  const stylesXml = await zip.file('xl/styles.xml')?.async('string')
  if (!stylesXml) throw new Error('xl/styles.xml introuvable — fichier XLSX invalide ?')

  const parser = new DOMParser()
  const stylesDoc = parser.parseFromString(stylesXml, 'application/xml')

  // Build fillId → rgb (hex string, with or without alpha prefix)
  const fillRgbById: (string | null)[] = []
  const fillNodes = Array.from(stylesDoc.getElementsByTagName('fill'))
  for (const fillNode of fillNodes) {
    const patternFill = fillNode.getElementsByTagName('patternFill')[0]
    if (!patternFill) { fillRgbById.push(null); continue }
    const fgColor = patternFill.getElementsByTagName('fgColor')[0]
    const bgColor = patternFill.getElementsByTagName('bgColor')[0]
    const rgb = fgColor?.getAttribute('rgb') ?? bgColor?.getAttribute('rgb') ?? null
    fillRgbById.push(rgb)
  }

  // Build cellXfIdx → fillId map
  const cellXfFillIdByIdx: (number | null)[] = []
  const cellXfsNode = stylesDoc.getElementsByTagName('cellXfs')[0]
  if (cellXfsNode) {
    const xfNodes = Array.from(cellXfsNode.getElementsByTagName('xf'))
    for (const xfNode of xfNodes) {
      const fillIdStr = xfNode.getAttribute('fillId')
      const applyFill = xfNode.getAttribute('applyFill')
      // Si applyFill="0" ou pas défini, le fill peut être hérité du style parent.
      // Pour simplifier, on garde quand même la fillId si elle existe.
      cellXfFillIdByIdx.push(fillIdStr !== null ? parseInt(fillIdStr, 10) : null)
      void applyFill
    }
  }

  // ===== 2. Lire workbook.xml pour la liste des sheets + leurs rels =====
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string')
  if (!workbookXml) throw new Error('xl/workbook.xml introuvable')

  const wbDoc = parser.parseFromString(workbookXml, 'application/xml')
  const sheetNodes = Array.from(wbDoc.getElementsByTagName('sheet'))

  const wbRelsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string')
  if (!wbRelsXml) throw new Error('xl/_rels/workbook.xml.rels introuvable')
  const wbRelsDoc = parser.parseFromString(wbRelsXml, 'application/xml')
  const relsByRid = new Map<string, string>()
  Array.from(wbRelsDoc.getElementsByTagName('Relationship')).forEach(rel => {
    const rid = rel.getAttribute('Id')
    const target = rel.getAttribute('Target')
    if (rid && target) relsByRid.set(rid, target)
  })

  // Read shared strings (pour cells de type "s")
  const sharedStringsXml = await zip.file('xl/sharedStrings.xml')?.async('string')
  const sharedStrings: string[] = []
  if (sharedStringsXml) {
    const ssDoc = parser.parseFromString(sharedStringsXml, 'application/xml')
    Array.from(ssDoc.getElementsByTagName('si')).forEach(si => {
      // <si><t>text</t></si> ou <si><r><t>...</t></r></si>
      const tNodes = si.getElementsByTagName('t')
      let text = ''
      for (const t of Array.from(tNodes)) text += t.textContent ?? ''
      sharedStrings.push(text)
    })
  }

  // ===== 3. Pour chaque sheet, parser les cellules =====
  const toRegenerate = new Map<string, Set<number>>()
  const looksFound = new Set<string>()

  let totalGreen = 0
  let totalCells = 0

  for (const sheetNode of sheetNodes) {
    const sheetName = sheetNode.getAttribute('name') ?? 'Sheet'
    const rid = sheetNode.getAttribute('r:id') ?? sheetNode.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
    if (!rid) continue
    const target = relsByRid.get(rid)
    if (!target) continue
    const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`

    const sheetXml = await zip.file(sheetPath)?.async('string')
    if (!sheetXml) continue
    const sheetDoc = parser.parseFromString(sheetXml, 'application/xml')

    let sheetLooks = 0
    const rowNodes = Array.from(sheetDoc.getElementsByTagName('row'))
    for (const rowNode of rowNodes) {
      const rNum = parseInt(rowNode.getAttribute('r') ?? '0', 10)
      if (rNum < 2) continue // skip header

      // Cellules de la row, indexées par lettre de colonne
      const cellsByCol = new Map<string, Element>()
      Array.from(rowNode.getElementsByTagName('c')).forEach(cellNode => {
        const ref = cellNode.getAttribute('r') ?? ''
        const colLetters = ref.replace(/\d+/g, '')
        cellsByCol.set(colLetters, cellNode)
      })

      // Colonne A : numeroLook
      const aCell = cellsByCol.get('A')
      if (!aCell) continue
      const aValue = readCellValue(aCell, sharedStrings)
      if (!aValue) continue
      const numeroLook = String(aValue).trim()
      if (!numeroLook) continue
      looksFound.add(numeroLook)
      sheetLooks++

      let regenVues = toRegenerate.get(numeroLook)
      if (!regenVues) {
        regenVues = new Set<number>()
        toRegenerate.set(numeroLook, regenVues)
      }

      // Colonnes B, C, D, E
      const cols = ['B', 'C', 'D', 'E']
      cols.forEach((col, idx) => {
        const cell = cellsByCol.get(col)
        totalCells++
        const isGreen = cell ? isCellGreen(cell, cellXfFillIdByIdx, fillRgbById) : false
        if (isGreen) {
          totalGreen++
        } else {
          regenVues.add(idx)
        }
      })
    }
    if (sheetLooks > 0) {
      warnings.push(`Onglet "${sheetName}" : ${sheetLooks} look(s) parsé(s).`)
    }
  }

  console.log(`[excelSelection] ${totalGreen}/${totalCells} cellules vertes détectées`)
  if (totalGreen === 0 && totalCells > 0) {
    warnings.push('⚠ Aucun vert détecté. Le format des couleurs est inconnu — partage le fichier pour debug.')
  }

  return { toRegenerate, looksFound, warnings }
}

/** Lit la valeur d'une cellule (string ou numeric, gère les sharedStrings). */
function readCellValue(cell: Element, sharedStrings: string[]): string | null {
  const type = cell.getAttribute('t') ?? 'n'
  const v = cell.getElementsByTagName('v')[0]?.textContent ?? null
  if (!v) return null
  if (type === 's') {
    const idx = parseInt(v, 10)
    return sharedStrings[idx] ?? null
  }
  return v
}

/** Détecte si une cellule a un fond vert en remontant style → cellXf → fillId → rgb. */
function isCellGreen(cell: Element, cellXfFillIdByIdx: (number | null)[], fillRgbById: (string | null)[]): boolean {
  const sStr = cell.getAttribute('s')
  if (sStr === null) return false
  const sIdx = parseInt(sStr, 10)
  if (isNaN(sIdx)) return false
  const fillId = cellXfFillIdByIdx[sIdx]
  if (fillId === null || fillId === undefined) return false
  const rgb = fillRgbById[fillId]
  if (!rgb) return false
  return isGreenHex(rgb)
}

/** Teste si une couleur hex (avec ou sans alpha) est verte (G dominant). */
function isGreenHex(rgb: string): boolean {
  const hex = rgb.length === 8 ? rgb.slice(2) : rgb
  if (hex.length < 6) return false
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  if (isNaN(r) || isNaN(g) || isNaN(b)) return false
  return g > r + 15 && g > b + 15 && g >= 100
}
