import JSZip from 'jszip'
import Papa from 'papaparse'
import {
  parsePoseCell,
  poseToPrompt,
  NOTION_BOILERPLATE_HEADER,
  NOTION_BOILERPLATE_STYLE,
  type PoseLabel,
  type PoseView,
} from '@/lib/poses'

/* ============================== TYPES ============================== */

export type ModelDef = {
  name: string
  promptModel?: string
  frontModelFile?: File   // colonne FRONT-model = silhouette / corps
  facePhotoFile?: File    // colonne FACE PHOTO = portrait visage (optionnelle)
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
  detailsFiles: File[]      // ← maintenant une liste de fichiers
  description?: string
  vues:         PoseLabel[]
}

export type GenerationTask = {
  id:            string
  lookId:        string
  numeroLook:    string
  taskType:      'pose' | 'detail' | 'inspi'
  // Pose tasks
  vueIndex?:     number
  vueRaw?:       string
  pose?:         PoseLabel
  // Detail tasks
  detailIndex?:  number
  detailName?:   string
  detailFile?:   File          // fichier détail brut (utile au runtime)
  promptWithBase?: string      // prompt alternatif quand on a une image de base du look
  // Inspi tasks
  inspirationFile?:   File       // image d'inspiration (envoyée à l'extracteur)
  extraInspiDetails?: File[]     // photos supplémentaires de REFERENCE (détails à intégrer)
  outfitFiles?:       File[]     // tenue brute (utile au runtime pour rebuild le prompt)
  modelDescription?:  string
  bgOverride?:        string     // colonne "Background Description" — modifie l'env extrait
  viewOverride?:      string     // colonne "View Details"          — modifie la pose extraite
  // Commun
  mannequinName:   string
  fondName:        string
  prompt:          string
  refs:            File[]
  facePhotoFile?:  File          // séparé pour pouvoir le dropper au retry
  warnings:        string[]
}

export type ParsedExport = {
  models: Map<string, ModelDef>
  fonds:  Map<string, FondDef>
  looks:  LookRow[]
  tasks:  GenerationTask[]
  warnings: string[]
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

  const csvLook   = findCsvByPrefix(fileIndex, ['LOOK', 'Looks', 'Look '])
  const csvModels = findCsvByPrefix(fileIndex, ['Models Definition', 'Models', 'Modeles'])
  const csvFonds  = findCsvByPrefix(fileIndex, ['Fonds', 'Backgrounds', 'Decors Definition', 'Decors', 'Décors'])

  if (!csvLook)   warnings.push('CSV "LOOK …" introuvable.')
  if (!csvModels) warnings.push('CSV "Models Definition" introuvable.')
  if (!csvFonds)  warnings.push('CSV "Fonds" introuvable.')

  const models = csvModels ? await parseModels(csvModels, fileIndex) : new Map<string, ModelDef>()
  const fonds  = csvFonds  ? await parseFonds(csvFonds,   fileIndex) : new Map<string, FondDef>()
  const looks  = csvLook   ? await parseLooks(csvLook,    fileIndex) : []

  /* ============== Construction des tâches ============== */
  const tasks: GenerationTask[] = []

  for (const look of looks) {
    if (!look.mannequinName) continue
    if (!look.fondName)      continue

    const model = models.get(normName(look.mannequinName))
    const fond  = fonds.get(normName(look.fondName))

    // ---------- 1. Tasks "pose" (1 par vue valide) ----------
    look.vues.forEach((pose, vueIndex) => {
      const w: string[] = []
      const refs: File[] = []

      if (model?.frontModelFile) refs.push(model.frontModelFile)
      else w.push(`Image du mannequin "${look.mannequinName}" introuvable.`)

      if (fond?.fondFile) refs.push(fond.fondFile)
      else w.push(`Image du fond "${look.fondName}" introuvable.`)

      // Choix des fichiers vêtement selon la VUE
      const vueRefs = filesForView(pose.view, look)
      for (const f of vueRefs.files) refs.push(f)
      for (const wmsg of vueRefs.warnings) w.push(wmsg)

      tasks.push({
        id:        `${look.id}-pose-${vueIndex + 1}`,
        lookId:    look.id,
        numeroLook:look.numeroLook,
        taskType:  'pose',
        vueIndex,
        vueRaw:    pose.raw,
        pose,
        mannequinName: look.mannequinName!,
        fondName:      look.fondName!,
        prompt:    buildPosePrompt(look, pose, model),
        refs,
        facePhotoFile: model?.facePhotoFile,
        warnings:  w,
      })
    })

    // ---------- 2. Tasks "detail" (1 par fichier dans DETAILS) ----------
    look.detailsFiles.forEach((detailFile, detailIndex) => {
      const w: string[] = []
      const refs: File[] = []

      if (model?.frontModelFile) refs.push(model.frontModelFile)
      else w.push(`Image du mannequin "${look.mannequinName}" introuvable.`)

      if (fond?.fondFile) refs.push(fond.fondFile)
      else w.push(`Image du fond "${look.fondName}" introuvable.`)

      refs.push(detailFile)

      tasks.push({
        id:        `${look.id}-detail-${detailIndex + 1}`,
        lookId:    look.id,
        numeroLook:look.numeroLook,
        taskType:  'detail',
        detailIndex,
        detailName:detailFile.name,
        detailFile,
        mannequinName: look.mannequinName!,
        fondName:      look.fondName!,
        prompt:         buildDetailPrompt(look, detailFile, model),
        promptWithBase: buildDetailPromptWithBase(look, detailFile),
        refs,
        facePhotoFile: model?.facePhotoFile,
        warnings:  w,
      })
    })
  }

  return { models, fonds, looks, tasks, warnings }
}

/* ============================== Builders ============================== */

function filesForView(view: PoseView, look: LookRow): { files: File[], warnings: string[] } {
  const w: string[] = []
  let files: File[] = []

  switch (view) {
    case 'Back':
      files = look.filesBack
      if (look.filesBack.length === 0) w.push('Aucun fichier dans FILES (BACK) — vue Back impossible à habiller.')
      break

    case 'Side':
      files = [...look.filesFront, ...look.filesBack]
      if (look.filesFront.length === 0) w.push('FILES (FRONT) vide — vue Side incomplète.')
      if (look.filesBack.length  === 0) w.push('FILES (BACK) vide — vue Side incomplète.')
      break

    case 'Front':
    case 'CloseUpHaut':
    case 'CloseUpBas':
    default:
      files = look.filesFront
      if (look.filesFront.length === 0) w.push('Aucun fichier dans FILES (FRONT).')
      break
  }

  return { files, warnings: w }
}

function modelRefDescription(model?: ModelDef): string {
  if (model?.facePhotoFile) {
    return 'deux références en image fournies : silhouette/corps + portrait visage. ⚠ PRÉSERVATION D\'IDENTITÉ STRICTE : reproduire EXACTEMENT les traits du visage de la référence portrait (forme du visage, yeux, nez, bouche, sourcils, ligne de mâchoire), la couleur et la coiffure des cheveux, le grain de peau. La silhouette/corps donne la morphologie générale. Le visage généré doit être instantanément reconnaissable comme le même que celui de la référence portrait, sous tous les angles'
  }
  return 'référence en image fournie. ⚠ PRÉSERVATION D\'IDENTITÉ : reproduire fidèlement les traits du mannequin de référence'
}

function buildPosePrompt(look: LookRow, pose: PoseLabel, model?: ModelDef): string {
  const parts: string[] = []
  parts.push(NOTION_BOILERPLATE_HEADER + '.')
  parts.push(
    `Photographie de mode professionnelle du mannequin "${look.mannequinName}" (${modelRefDescription(model)}), portant les vêtements montrés en référence, devant le fond "${look.fondName}" (référence en image fournie).`,
  )
  parts.push(`POSE : ${poseToPrompt(pose)}.`)
  if (model?.promptModel) parts.push(`Note mannequin : ${model.promptModel}.`)
  if (look.description)   parts.push(`Direction artistique : ${look.description}.`)
  parts.push(NOTION_BOILERPLATE_STYLE)
  return parts.join('\n\n')
}

function buildDetailPromptWithBase(look: LookRow, detailFile: File): string {
  const parts: string[] = []
  parts.push(NOTION_BOILERPLATE_HEADER + '.')
  parts.push(
    `Photographie de mode professionnelle en PLAN RAPPROCHÉ / GROS PLAN sur un détail du look déjà shooté (image complète montrée en référence #1 : le mannequin "${look.mannequinName}" porte la tenue complète devant le fond "${look.fondName}").`,
  )
  parts.push(
    `Le détail à mettre en valeur est précisément celui montré en référence #2 (fichier "${detailFile.name}") — broderie, matière, fermeture, finition ou accessoire spécifique.`,
  )
  parts.push(
    'Recadrer serré sur ce détail tel qu\'il apparaît dans le look déjà shooté : même mannequin, même tenue, même fond, même lumière. Mise au point très précise sur la matière et le tombé, profondeur de champ très courte (f/2.0 ressenti), texture révélée, composition éditoriale.',
  )
  if (look.description) parts.push(`Direction artistique : ${look.description}.`)
  parts.push(NOTION_BOILERPLATE_STYLE)
  return parts.join('\n\n')
}

function buildDetailPrompt(look: LookRow, detailFile: File, model?: ModelDef): string {
  const parts: string[] = []
  parts.push(NOTION_BOILERPLATE_HEADER + '.')
  parts.push(
    `Photographie de mode professionnelle en PLAN RAPPROCHÉ / GROS PLAN sur un détail de vêtement (broderie, matière, fermeture, finition, accessoire) — détail montré en référence (fichier "${detailFile.name}"), porté par le mannequin "${look.mannequinName}" (${modelRefDescription(model)}), devant le fond "${look.fondName}" (référence en image fournie).`,
  )
  parts.push(
    'Cadrage serré sur le détail, mise au point très précise sur la matière et le tombé, lumière qui révèle la texture, profondeur de champ très courte (f/2.0 ressenti), composition éditoriale.',
  )
  if (model?.promptModel) parts.push(`Note mannequin : ${model.promptModel}.`)
  if (look.description)   parts.push(`Direction artistique : ${look.description}.`)
  parts.push(NOTION_BOILERPLATE_STYLE)
  return parts.join('\n\n')
}

/* ============================== CSV parsers ============================== */

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

async function parseFonds(csv: File, index: Map<string, File>): Promise<Map<string, FondDef>> {
  const rows = await readCsv(csv)
  const m = new Map<string, FondDef>()
  for (const r of rows) {
    const name = String(
      r['Decor name'] ?? r['Decor Name'] ?? r['Décor name']
      ?? r['Name your Model'] ?? r['Name'] ?? r['Fond']
      ?? '',
    ).trim()
    if (!name) continue
    const fileRef = decodeRef(String(
      r['Reference image'] ?? r['Reference Image']
      ?? r['FOND'] ?? r['File']
      ?? '',
    ).trim())
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
    const fondName      = stripRef(String(r['⬜ Fonds'] ?? r['Fonds'] ?? r['Fond'] ?? r['Décor'] ?? r['Decor'] ?? '').trim()) || undefined
    const filesFrontRaw = String(r['FILES (FRONT)'] ?? '').trim()
    const filesBackRaw  = String(r['FILES (BACK)']  ?? '').trim()
    const detailsRaw    = String(r['DETAILS']       ?? '').trim()
    const description   = String(r['DESCRIPTION']   ?? '').trim() || undefined

    const filesFront   = resolveFileList(filesFrontRaw, index)
    const filesBack    = resolveFileList(filesBackRaw,  index)
    const detailsFiles = resolveFileList(detailsRaw,    index)

    // Détection dynamique des colonnes Vue et Pose
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

    const isFilled = !!mannequinName || !!fondName ||
                     filesFront.length > 0 || filesBack.length > 0 ||
                     detailsFiles.length > 0 || vues.length > 0
    if (!isFilled) continue

    out.push({
      id, numeroLook, mannequinName, fondName,
      filesFront, filesBack, detailsFiles, description, vues,
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
  try {
    return decodeURIComponent(raw.replace(/\+/g, '%20'))
  } catch {
    return raw
  }
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
