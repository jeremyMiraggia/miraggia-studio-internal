import JSZip from 'jszip'
import Papa from 'papaparse'
import {
  NOTION_BOILERPLATE_HEADER,
  NOTION_BOILERPLATE_STYLE,
} from '@/lib/poses'
import type { ParsedExport, GenerationTask, ModelDef, LookRow } from './parseExport'

/**
 * Parser pour l'export Notion "LOOK (LIFESTYLE)" — workflow Inspiration.
 *
 * Différences avec le parser Notion standard :
 *   - le CSV principal s'appelle "LOOK (LIFESTYLE) …"
 *   - colonne `REFERENCE` = image d'inspiration lifestyle (1 fichier)
 *   - colonne `Background Description` (texte libre)
 *   - colonne `Vue et poses` (optionnelle, ignorée si vide — c'est l'extraction
 *     depuis l'image d'inspiration qui fournit la vue + la pose)
 *   - pas de CSV "Fonds" — le fond vient de l'image d'inspiration extraite
 *
 * Pour chaque ligne, on crée UNE seule task de type 'inspi'.
 */
export async function parseInspiExport(zipFile: File): Promise<ParsedExport> {
  const buf = await zipFile.arrayBuffer()
  let zip = await JSZip.loadAsync(buf)

  // Double-zip Notion ?
  const nestedZip = Object.keys(zip.files).find(
    name => /Part-\d+\.zip$/i.test(name) && !zip.files[name].dir,
  )
  if (nestedZip) {
    const inner = await zip.files[nestedZip].async('blob')
    zip = await JSZip.loadAsync(await inner.arrayBuffer())
  }

  const fileIndex = new Map<string, File>()
  await Promise.all(
    Object.keys(zip.files).map(async (path) => {
      const entry = zip.files[path]
      if (entry.dir) return
      const base = baseName(path)
      const mime = guessMime(base)
      const blob = await entry.async('blob')
      const file = new File([blob], base, { type: mime })
      fileIndex.set(base, file)
    }),
  )

  const warnings: string[] = []

  const csvLook   = findCsvByPrefix(fileIndex, ['LOOK (LIFESTYLE)', 'LOOK (Lifestyle)', 'LOOK LIFESTYLE'])
  const csvModels = findCsvByPrefix(fileIndex, ['Models Definition', 'Models', 'Modeles'])

  if (!csvLook)   warnings.push('CSV "LOOK (LIFESTYLE) …" introuvable.')
  if (!csvModels) warnings.push('CSV "Models Definition" introuvable.')

  const models = csvModels ? await parseModels(csvModels, fileIndex) : new Map<string, ModelDef>()
  const looks  = csvLook   ? await parseLooks(csvLook,    fileIndex) : []

  // Construction des tasks 'inspi' (1 par look)
  const tasks: GenerationTask[] = []
  for (const look of looks) {
    if (!look.mannequinName) continue

    const model = models.get(normName(look.mannequinName))
    const w: string[] = []
    const refs: File[] = []

    if (model?.frontModelFile) refs.push(model.frontModelFile)
    else                       w.push(`Image du mannequin "${look.mannequinName}" introuvable.`)
    if (model?.facePhotoFile)  refs.push(model.facePhotoFile)

    for (const f of look.filesFront) refs.push(f)
    if (look.filesFront.length === 0) w.push('Aucun vêtement dans FILES (FRONT).')

    // REFERENCE[0] = inspi pour l'extracteur.
    // REFERENCE[1..N] = détails à intégrer dans le visuel final (envoyés à l'image gen).
    const inspirationFile   = look.detailsFiles[0]
    const extraInspiDetails = look.detailsFiles.slice(1)
    if (!inspirationFile) w.push('Aucune image d\'inspiration dans la colonne REFERENCE.')

    // Les détails supplémentaires sont ajoutés aux refs envoyées à l'image gen
    for (const f of extraInspiDetails) refs.push(f)

    tasks.push({
      id:                `${look.id}-inspi`,
      lookId:            look.id,
      numeroLook:        look.numeroLook,
      taskType:          'inspi',
      mannequinName:     look.mannequinName!,
      fondName:          look.fondName ?? '',
      prompt:            '',                    // construit au runtime après extraction
      refs,                                     // [mannequin, face?, ...vêtements, ...extras]
      inspirationFile,
      extraInspiDetails,
      outfitFiles:       look.filesFront,
      modelDescription:  model?.promptModel,
      warnings:          w,
    })
  }

  return { models, fonds: new Map(), looks, tasks, warnings }
}

/* ============================== Inspi prompt builder ============================== */

/**
 * Construit le prompt final d'un visuel inspi, après extraction de
 * l'environnement et de la pose depuis l'image d'inspiration.
 * Exporté pour être utilisé côté UI (au moment où l'extraction termine).
 */
export function buildInspiPrompt(args: {
  mannequinName:    string
  modelDescription?:string
  outfitCount:      number
  extractedEnv:     string
  extractedPose:    string
  extraDetailCount?:number    // nombre de photos détail supplémentaires
  notes?:           string
}): string {
  const { mannequinName, modelDescription, outfitCount, extractedEnv, extractedPose, extraDetailCount = 0, notes } = args
  const parts: string[] = []
  parts.push(NOTION_BOILERPLATE_HEADER + '.')
  parts.push(
    `Photographie de mode professionnelle du mannequin "${mannequinName}" (deux références en image fournies : silhouette/corps + portrait visage, à utiliser pour respecter la morphologie ET les traits du visage), portant la tenue montrée en référence (${outfitCount} fichier${outfitCount > 1 ? 's' : ''}).`,
  )
  parts.push(`ENVIRONNEMENT : ${extractedEnv}.`)
  parts.push(`POSE : ${extractedPose}.`)
  if (extraDetailCount > 0) {
    parts.push(
      `Intègre également ${extraDetailCount > 1 ? `les ${extraDetailCount} détails spécifiques montrés` : 'le détail spécifique montré'} en référence supplémentaire — élément de décor, accessoire, prop ou ambiance visuelle à ajouter au cadre.`,
    )
  }
  if (modelDescription) parts.push(`Note mannequin : ${modelDescription}.`)
  if (notes)            parts.push(`Notes : ${notes}.`)
  parts.push(NOTION_BOILERPLATE_STYLE)
  return parts.join('\n\n')
}

/* ============================== CSV helpers (locaux) ============================== */

function findCsvByPrefix(index: Map<string, File>, prefixes: string[]): File | undefined {
  for (const [name, file] of index.entries()) {
    if (!name.toLowerCase().endsWith('.csv')) continue
    if (name.toLowerCase().includes('_all.csv')) continue
    for (const p of prefixes) {
      if (name.toLowerCase().startsWith(p.toLowerCase())) return file
    }
  }
  return undefined
}

async function readCsv(file: File): Promise<any[]> {
  const text = await file.text()
  const cleaned = text.replace(/^﻿/, '')
  const parsed = Papa.parse(cleaned, { header: true, skipEmptyLines: true })
  return parsed.data as any[]
}

async function parseModels(csv: File, index: Map<string, File>): Promise<Map<string, ModelDef>> {
  const rows = await readCsv(csv)
  const m = new Map<string, ModelDef>()
  for (const r of rows) {
    const name = String(r['Name your Model'] ?? r['Name'] ?? '').trim()
    if (!name) continue
    const promptModel  = String(r['Prompt Model'] ?? '').trim() || undefined
    const frontFileRef = decodeRef(String(r['FRONT-model'] ?? '').trim())
    const frontModelFile = frontFileRef ? index.get(frontFileRef) : undefined
    const facePhotoRef = decodeRef(String(r['FACE PHOTO'] ?? r['Face Photo'] ?? '').trim())
    const facePhotoFile = facePhotoRef ? index.get(facePhotoRef) : undefined
    m.set(normName(name), { name, promptModel, frontModelFile, facePhotoFile })
  }
  return m
}

async function parseLooks(csv: File, index: Map<string, File>): Promise<LookRow[]> {
  const rows = await readCsv(csv)
  const out: LookRow[] = []
  for (const r of rows) {
    const id          = String(r['ID'] ?? '').trim()
    const sku         = String(r['SKU'] ?? '').trim()
    if (!id) continue

    const mannequinName = stripRef(String(r['Model'] ?? r['Mannequin'] ?? '').trim()) || undefined
    const filesFrontRaw = String(r['FILES (FRONT)']   ?? '').trim()
    const filesBackRaw  = String(r['FILES (BACK) (1)']?? r['FILES (BACK)'] ?? '').trim()
    const referenceRaw  = String(r['REFERENCE']       ?? '').trim()
    const bgDesc        = String(r['Background Description'] ?? '').trim() || undefined

    const filesFront = resolveFileList(filesFrontRaw, index)
    const filesBack  = resolveFileList(filesBackRaw,  index)
    const refFiles   = resolveFileList(referenceRaw,  index)

    const isFilled = !!mannequinName || filesFront.length > 0 || refFiles.length > 0
    if (!isFilled) continue

    out.push({
      id,
      numeroLook:    sku || id,
      mannequinName,
      fondName:      undefined,
      filesFront,
      filesBack,
      // ⚠ On réutilise detailsFiles pour stocker l'image REFERENCE — le runner
      // lit ça via `inspirationFile = look.detailsFiles[0]`.
      detailsFiles:  refFiles,
      description:   bgDesc,
      vues:          [],
    })
  }
  return out
}

/* ============================== utils ============================== */

function baseName(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}

function guessMime(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'png':  return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'gif':  return 'image/gif'
    case 'csv':  return 'text/csv'
    case 'md':   return 'text/markdown'
    case 'txt':  return 'text/plain'
    default:     return 'application/octet-stream'
  }
}

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

function stripRef(cell: string): string {
  if (!cell) return ''
  const i = cell.indexOf(' (')
  return i >= 0 ? cell.slice(0, i).trim() : cell.trim()
}

function decodeRef(raw: string): string {
  if (!raw) return ''
  try { return decodeURIComponent(raw.replace(/\+/g, '%20')) }
  catch { return raw }
}

function resolveFileList(raw: string, index: Map<string, File>): File[] {
  if (!raw) return []
  return raw
    .split(',')
    .map(s => decodeRef(s.trim()))
    .filter(Boolean)
    .map(name => index.get(name))
    .filter((f): f is File => !!f)
}
