import JSZip from 'jszip'
import Papa from 'papaparse'
import {
  parsePoseCell,
  poseToPrompt,
  NOTION_BOILERPLATE_HEADER,
  NOTION_BOILERPLATE_STYLE,
  type PoseLabel,
} from '@/lib/poses'

/* ============================== TYPES ============================== */

export type ModelDef = {
  name: string
  promptModel?: string
  frontModelFile?: File
}

export type FondDef = {
  name: string
  fondFile?: File
}

export type LookRow = {
  id:           string
  numeroLook:   string
  mannequinName?: string
  fondName?:    string
  filesFront:   File[]
  filesBack:    File[]
  details?:     string
  description?: string
  vues:         PoseLabel[]   // 1..N labels valides (Front/X, Back/X)
}

export type GenerationTask = {
  id:        string            // unique : `${lookId}-${vueIndex}`
  lookId:    string
  numeroLook:string
  vueIndex:  number
  vueRaw:    string            // "Front, nonchalante"
  pose:      PoseLabel
  mannequinName: string
  fondName:  string
  prompt:    string
  refs:      File[]            // [mannequin, fond, ...vetements]
  warnings:  string[]
}

export type ParsedExport = {
  models: Map<string, ModelDef>
  fonds:  Map<string, FondDef>
  looks:  LookRow[]
  tasks:  GenerationTask[]
  warnings: string[]            // problèmes globaux
}

/* ============================== ENTRY ============================== */

export async function parseNotionExport(zipFile: File): Promise<ParsedExport> {
  const buf = await zipFile.arrayBuffer()
  let zip = await JSZip.loadAsync(buf)

  // Notion peut imbriquer un zip dans un zip (ExportBlock…-Part-1.zip)
  const nestedZip = Object.keys(zip.files).find(
    name => /Part-\d+\.zip$/i.test(name) && !zip.files[name].dir,
  )
  if (nestedZip) {
    const inner = await zip.files[nestedZip].async('blob')
    zip = await JSZip.loadAsync(await inner.arrayBuffer())
  }

  // Construit un index de fichiers : nom de fichier (sans dossier) -> File
  const fileIndex = new Map<string, File>()
  await Promise.all(
    Object.keys(zip.files).map(async (path) => {
      const entry = zip.files[path]
      if (entry.dir) return
      const base = baseName(path)
      // Image binaire ou texte ? On encapsule tout en File (utile pour image+csv).
      const mime = guessMime(base)
      const blob = await entry.async('blob')
      const file = new File([blob], base, { type: mime })
      fileIndex.set(base, file)
    }),
  )

  const warnings: string[] = []

  // ---------- Repérer les 3 CSV ----------
  const csvLook   = findCsvByPrefix(fileIndex, ['LOOK', 'Looks', 'Look '])
  const csvModels = findCsvByPrefix(fileIndex, ['Models Definition', 'Models', 'Modeles'])
  const csvFonds  = findCsvByPrefix(fileIndex, ['Fonds', 'Backgrounds'])

  if (!csvLook)   warnings.push('CSV "LOOK …" introuvable.')
  if (!csvModels) warnings.push('CSV "Models Definition" introuvable.')
  if (!csvFonds)  warnings.push('CSV "Fonds" introuvable.')

  const models = csvModels ? await parseModels(csvModels, fileIndex) : new Map<string, ModelDef>()
  const fonds  = csvFonds  ? await parseFonds(csvFonds,   fileIndex) : new Map<string, FondDef>()
  const looks  = csvLook   ? await parseLooks(csvLook,    fileIndex) : []

  // ---------- Construire les tâches ----------
  const tasks: GenerationTask[] = []
  for (const look of looks) {
    if (look.vues.length === 0) continue
    if (!look.mannequinName)    continue
    if (!look.fondName)         continue

    const model = look.mannequinName ? models.get(normName(look.mannequinName)) : undefined
    const fond  = look.fondName      ? fonds.get(normName(look.fondName))       : undefined

    look.vues.forEach((pose, vueIndex) => {
      const w: string[] = []
      const refs: File[] = []

      if (model?.frontModelFile) refs.push(model.frontModelFile)
      else w.push(`Image du mannequin "${look.mannequinName}" introuvable.`)

      if (fond?.fondFile) refs.push(fond.fondFile)
      else w.push(`Image du fond "${look.fondName}" introuvable.`)

      // Vêtements (front uniquement pour l'instant, back ignoré)
      for (const f of look.filesFront) refs.push(f)
      if (look.filesFront.length === 0) w.push('Aucun fichier vêtement trouvé dans FILES (FRONT).')

      const prompt = buildPrompt(look, pose, model, fond)

      tasks.push({
        id:        `${look.id}-${vueIndex + 1}`,
        lookId:    look.id,
        numeroLook:look.numeroLook,
        vueIndex,
        vueRaw:    pose.raw,
        pose,
        mannequinName: look.mannequinName!,
        fondName:      look.fondName!,
        prompt,
        refs,
        warnings:  w,
      })
    })
  }

  return { models, fonds, looks, tasks, warnings }
}

/* ============================== HELPERS ============================== */

function buildPrompt(look: LookRow, pose: PoseLabel, model?: ModelDef, fond?: FondDef): string {
  const parts: string[] = []
  parts.push(NOTION_BOILERPLATE_HEADER + '.')
  parts.push(
    `Photographie de mode professionnelle du mannequin "${look.mannequinName}" (référence en image fournie), portant les vêtements montrés en référence, devant le fond "${look.fondName}" (référence en image fournie).`,
  )
  parts.push(`POSE : ${poseToPrompt(pose)}.`)
  if (model?.promptModel)  parts.push(`Note mannequin : ${model.promptModel}.`)
  if (look.description)    parts.push(`Direction artistique : ${look.description}.`)
  if (look.details)        parts.push(`Détails : ${look.details}.`)
  parts.push(NOTION_BOILERPLATE_STYLE)
  return parts.join('\n\n')
}

function findCsvByPrefix(index: Map<string, File>, prefixes: string[]): File | undefined {
  for (const [name, file] of index.entries()) {
    if (!name.toLowerCase().endsWith('.csv')) continue
    if (name.toLowerCase().includes('_all.csv')) continue // doublon Notion
    for (const p of prefixes) {
      if (name.toLowerCase().startsWith(p.toLowerCase())) return file
    }
  }
  return undefined
}

async function readCsv(file: File): Promise<any[]> {
  const text = await file.text()
  // BOM Notion ?
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
    m.set(normName(name), { name, promptModel, frontModelFile })
  }
  return m
}

async function parseFonds(csv: File, index: Map<string, File>): Promise<Map<string, FondDef>> {
  const rows = await readCsv(csv)
  const m = new Map<string, FondDef>()
  for (const r of rows) {
    const name = String(r['Name your Model'] ?? r['Name'] ?? r['Fond'] ?? '').trim()
    if (!name) continue
    const fileRef = decodeRef(String(r['FOND'] ?? r['File'] ?? '').trim())
    const fondFile = fileRef ? index.get(fileRef) : undefined
    m.set(normName(name), { name, fondFile })
  }
  return m
}

async function parseLooks(csv: File, index: Map<string, File>): Promise<LookRow[]> {
  const rows = await readCsv(csv)
  const out: LookRow[] = []
  for (const r of rows) {
    const id          = String(r['ID'] ?? '').trim()
    const numeroLook  = String(r['Numero Look'] ?? '').trim()
    if (!id) continue

    const mannequinName = stripRef(String(r['Mannequin'] ?? '').trim()) || undefined
    const fondName      = stripRef(String(r['⬜ Fonds'] ?? r['Fonds'] ?? '').trim()) || undefined
    const filesFrontRaw = String(r['FILES (FRONT)'] ?? '').trim()
    const filesBackRaw  = String(r['FILES (BACK)']  ?? '').trim()
    const details       = String(r['DETAILS'] ?? '').trim() || undefined
    const description   = String(r['DESCRIPTION'] ?? '').trim() || undefined

    const filesFront = resolveFileList(filesFrontRaw, index)
    const filesBack  = resolveFileList(filesBackRaw,  index)

    // Détection dynamique : toutes les colonnes qui matchent "Vue et Pose <n>"
    // (insensible à la casse, espaces souples). Triées par numéro croissant.
    const poseColumns = Object.keys(r)
      .filter(k => /^\s*vue\s*et\s*pose\s*\d+\s*$/i.test(k))
      .sort((a, b) => {
        const na = Number(a.match(/\d+/)?.[0] ?? 0)
        const nb = Number(b.match(/\d+/)?.[0] ?? 0)
        return na - nb
      })

    const vues: PoseLabel[] = []
    for (const col of poseColumns) {
      const cell = String(r[col] ?? '').trim()
      const p    = parsePoseCell(cell)
      if (p) vues.push(p)
    }

    // On ne garde que les lignes "vraies" : au moins un mannequin OU au moins une vue valide.
    // Les lignes Notion vides (ID + numéro seuls, sans mannequin/fond/vue) sont ignorées.
    const isFilled = !!mannequinName || !!fondName || filesFront.length > 0 || vues.length > 0
    if (!isFilled) continue

    out.push({
      id, numeroLook, mannequinName, fondName,
      filesFront, filesBack, details, description, vues,
    })
  }
  return out
}

/* ============================== UTILS ============================== */

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

/** Normalise un nom pour les lookups (case-insensitive, espaces) */
function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Une cellule de référence Notion ressemble à :
 *   "ELYSE (ELYSE%203652394957cd81acb5fef6f633fdf8d4.md)"
 * On garde juste la partie avant " (".
 */
function stripRef(cell: string): string {
  if (!cell) return ''
  const i = cell.indexOf(' (')
  return i >= 0 ? cell.slice(0, i).trim() : cell.trim()
}

/**
 * Décode un nom de fichier Notion (URL-encoded) : "EDGY_VINTAGE_1%201.jpg" -> "EDGY_VINTAGE_1 1.jpg"
 */
function decodeRef(raw: string): string {
  if (!raw) return ''
  try {
    return decodeURIComponent(raw.replace(/\+/g, '%20'))
  } catch {
    return raw
  }
}

/**
 * Parse une liste de fichiers séparés par ", " (FILES (FRONT)) et retourne les Files trouvés.
 */
function resolveFileList(raw: string, index: Map<string, File>): File[] {
  if (!raw) return []
  return raw
    .split(',')
    .map(s => decodeRef(s.trim()))
    .filter(Boolean)
    .map(name => index.get(name))
    .filter((f): f is File => !!f)
}
