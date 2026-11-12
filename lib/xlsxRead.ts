/**
 * Lecture minimale d'un .xlsx dans le navigateur (JSZip + DOMParser) : valeurs texte
 * de la 1re feuille + couleur de remplissage de chaque cellule (pour repérer le surlignage).
 */
import JSZip from 'jszip'

export type XlsxCell = { value: string; fill?: string } // fill = RRGGBB (sans alpha) si remplissage plein
export type XlsxSheet = { name: string; rows: XlsxCell[][] }

const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
// Palette Excel « indexed » (les plus courantes)
const INDEXED: Record<number, string> = { 2: 'FFFFFF', 5: 'FFFF00', 13: 'FFFF00', 43: 'FFFF99', 51: 'FFCC00', 26: 'FFFFCC' }

const parse = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml')
const els = (n: Document | Element, tag: string) => Array.from(n.getElementsByTagName(tag))
const textOf = (n: Element) => els(n, 't').map(t => t.textContent ?? '').join('')

const colIndex = (ref: string) => {
  const letters = ref.replace(/\d+/g, '')
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

export async function readXlsx(file: File | Blob): Promise<XlsxSheet> {
  const zip = await JSZip.loadAsync(file)
  const read = async (p: string) => (await zip.file(p)?.async('string')) ?? ''

  // 1re feuille
  const wb = parse(await read('xl/workbook.xml'))
  const sheetEl = els(wb, 'sheet')[0]
  if (!sheetEl) throw new Error('Classeur vide.')
  const rid = sheetEl.getAttributeNS(NS_R, 'id') ?? sheetEl.getAttribute('r:id')
  const rels = parse(await read('xl/_rels/workbook.xml.rels'))
  const target = els(rels, 'Relationship').find(r => r.getAttribute('Id') === rid)?.getAttribute('Target') ?? 'worksheets/sheet1.xml'
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`

  const shared = els(parse(await read('xl/sharedStrings.xml')), 'si').map(textOf)

  // Styles → couleur de remplissage par index de style
  const styles = parse(await read('xl/styles.xml'))
  const fillsEl = els(styles, 'fills')[0]
  const fills = (fillsEl ? els(fillsEl, 'fill') : []).map(f => {
    const pf = els(f, 'patternFill')[0]
    if (!pf || (pf.getAttribute('patternType') ?? 'none') === 'none') return undefined
    const fg = els(pf, 'fgColor')[0]
    if (!fg) return undefined
    const rgb = fg.getAttribute('rgb')
    if (rgb) return rgb.slice(-6).toUpperCase()
    const idx = fg.getAttribute('indexed')
    if (idx != null) return INDEXED[Number(idx)]
    return fg.getAttribute('theme') != null ? `theme${fg.getAttribute('theme')}` : undefined
  })
  const cellXfs = els(styles, 'cellXfs')[0]
  const xfFill = cellXfs ? els(cellXfs, 'xf').map(x => fills[Number(x.getAttribute('fillId') ?? 0)]) : []

  const sheet = parse(await read(sheetPath))
  const rows: XlsxCell[][] = []
  for (const row of els(sheet, 'row')) {
    const r = Number(row.getAttribute('r') ?? rows.length + 1) - 1
    const cells: XlsxCell[] = []
    for (const c of els(row, 'c')) {
      const ci = colIndex(c.getAttribute('r') ?? 'A1')
      const t = c.getAttribute('t')
      const v = els(c, 'v')[0]?.textContent ?? ''
      const value = t === 's' ? (shared[Number(v)] ?? '') : t === 'inlineStr' ? textOf(c) : v
      cells[ci] = { value: value.trim(), fill: xfFill[Number(c.getAttribute('s') ?? 0)] }
    }
    rows[r] = Array.from(cells, x => x ?? { value: '' })
  }
  return { name: sheetEl.getAttribute('name') ?? 'Feuille 1', rows: Array.from(rows, x => x ?? []) }
}

/** Jaune (surligneur) : rouge et vert forts, bleu faible. */
export function isYellow(fill?: string) {
  if (!fill || !/^[0-9A-F]{6}$/.test(fill)) return false
  const r = parseInt(fill.slice(0, 2), 16), g = parseInt(fill.slice(2, 4), 16), b = parseInt(fill.slice(4, 6), 16)
  return r > 200 && g > 180 && b < 140
}
