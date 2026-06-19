import Papa from 'papaparse'
import { compressImage } from '@/lib/compressImage'
import {
  NOTION_BOILERPLATE_HEADER,
  NOTION_BOILERPLATE_STYLE,
} from '@/lib/poses'
import { readZipIndex, extractEntry, getEntryDataOffset, type ZipEntry } from './zipReader'
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
 *
 * IMPLÉMENTATION : utilise readZipIndex + extractEntry (OPFS streaming) pour
 * supporter les ZIPs de plusieurs GB sans saturer la RAM. Lazy extraction :
 * on ne lit que les CSVs au début + les fichiers des looks retenus.
 */
export async function parseInspiExport(
  zipFile: File,
  onProgress?: (msg: string) => void,
  lookRange?: { start: number; end: number } | number,
): Promise<ParsedExport> {
  onProgress?.('Lecture de l\'index du ZIP…')
  let zipIndex: Map<string, ZipEntry>
  try {
    zipIndex = await readZipIndex(zipFile)
  } catch (e: any) {
    throw friendlyZipError(zipFile, e)
  }

  // Notion exporte un ZIP qui contient parfois un Part-1.zip (double-zip)
  let workingFile: Blob = zipFile
  const nestedKey = [...zipIndex.keys()].find(k => /Part-\d+\.zip$/i.test(k))
  if (nestedKey) {
    try {
      const nestedEntry = zipIndex.get(nestedKey)!
      if (nestedEntry.method === 0) {
        onProgress?.('Lecture du ZIP imbriqué (Part-1.zip) en mode offset…')
        const { dataOffset, csize } = await getEntryDataOffset(zipFile, nestedEntry)
        zipIndex = await readZipIndex(zipFile, { baseOffset: dataOffset, virtualSize: csize })
      } else {
        const sizeMB = Math.round(nestedEntry.size / (1024 * 1024))
        onProgress?.(`Décompression du ZIP imbriqué (${sizeMB} MB)… (peut prendre 30-90s sans progress)`)
        workingFile = await extractEntry(zipFile, nestedEntry)
        onProgress?.('Lecture de l\'index du ZIP imbriqué…')
        zipIndex = await readZipIndex(workingFile)
      }
    } catch (e: any) {
      throw friendlyZipError(zipFile, e, true)
    }
  }

  // Helpers d'extraction lazy
  const extractAsFile = async (key: string): Promise<File | undefined> => {
    const entry = zipIndex.get(key)
    if (!entry) return undefined
    const blob = await extractEntry(workingFile, entry)
    const base = baseName(key)
    const mime = guessMime(base)
    let file = new File([blob], base, { type: mime })
    if (mime.startsWith('image/') && file.size > 1_500_000) {
      try { file = await compressImage(file, { maxSide: 2048, quality: 0.85 }) } catch { /* */ }
    }
    return file
  }
  const readCsvText = async (key: string): Promise<string | undefined> => {
    const entry = zipIndex.get(key)
    if (!entry) return undefined
    const blob = await extractEntry(workingFile, entry)
    return await blob.text()
  }

  // Index des basenames de fichiers (pour résoudre les références CSV)
  const baseToKey = new Map<string, string>()
  for (const key of zipIndex.keys()) {
    baseToKey.set(baseName(key), key)
  }

  // Cherche les CSVs LOOK LIFESTYLE et Models Definition
  const csvLookKey   = findCsvKeyByPrefix(zipIndex, ['LOOK (LIFESTYLE)', 'LOOK (Lifestyle)', 'LOOK LIFESTYLE'])
  const csvModelsKey = findCsvKeyByPrefix(zipIndex, ['Models Definition', 'Models', 'Modeles'])

  const warnings: string[] = []
  if (!csvLookKey)   warnings.push('CSV "LOOK (LIFESTYLE) …" introuvable.')
  if (!csvModelsKey) warnings.push('CSV "Models Definition" introuvable.')

  onProgress?.('Lecture des CSVs…')
  const csvLookText   = csvLookKey   ? await readCsvText(csvLookKey)   : undefined
  const csvModelsText = csvModelsKey ? await readCsvText(csvModelsKey) : undefined

  // Parse les CSVs
  const looksRowsAll = csvLookText
    ? (Papa.parse(csvLookText.replace(/^﻿/, ''), { header: true, skipEmptyLines: true }).data as any[])
    : []

  // Normalise la sélection range
  let rangeStart: number | null = null
  let rangeEnd:   number | null = null
  if (typeof lookRange === 'number' && lookRange > 0) {
    rangeStart = 1
    rangeEnd   = lookRange
  } else if (lookRange && typeof lookRange === 'object' && lookRange.start > 0 && lookRange.end >= lookRange.start) {
    rangeStart = lookRange.start
    rangeEnd   = lookRange.end
  }

  // Eligible = lignes qui ont au moins un ID (filtrage de base)
  const eligibleLooks = looksRowsAll.filter((r: any) => String(r['ID'] ?? '').trim())
  warnings.push(`📊 CSV LOOK : ${looksRowsAll.length} lignes au total, ${eligibleLooks.length} avec ID.`)

  // Applique la range
  const looksRowsToUse = (rangeStart !== null && rangeEnd !== null)
    ? eligibleLooks.slice(rangeStart - 1, rangeEnd)
    : eligibleLooks
  if (rangeStart !== null && rangeEnd !== null && eligibleLooks.length > 0) {
    if (rangeStart === 1) {
      warnings.push(`Limité aux ${rangeEnd} premiers looks (sur ${eligibleLooks.length} eligible).`)
    } else {
      warnings.push(`Limité aux looks ${rangeStart}-${rangeEnd} (sur ${eligibleLooks.length} eligible, ${looksRowsToUse.length} retenus).`)
    }
  }

  // ----- Parse models (uniquement ceux utilisés par les looks retenus) -----
  // Pour économiser l'extraction, on collecte d'abord les noms utilisés
  const usedModelNames = new Set<string>()
  for (const r of looksRowsToUse) {
    const name = stripRef(String(r['Model'] ?? r['Mannequin'] ?? '').trim())
    if (name) usedModelNames.add(normName(name))
  }

  const modelsRowsAll = csvModelsText
    ? (Papa.parse(csvModelsText.replace(/^﻿/, ''), { header: true, skipEmptyLines: true }).data as any[])
    : []

  const models = new Map<string, ModelDef>()
  for (const r of modelsRowsAll) {
    const name = String(r['Name your Model'] ?? r['Name'] ?? '').trim()
    if (!name) continue
    const key = normName(name)
    if (!usedModelNames.has(key)) continue
    const promptModel  = String(r['Prompt Model'] ?? '').trim() || undefined
    const frontFileRef = decodeRef(String(r['FRONT-model'] ?? '').trim())
    const facePhotoRef = decodeRef(String(r['FACE PHOTO'] ?? r['Face Photo'] ?? '').trim())
    const frontModelFile = frontFileRef ? await extractAsFile(baseToKey.get(frontFileRef) ?? '') : undefined
    const facePhotoFile  = facePhotoRef ? await extractAsFile(baseToKey.get(facePhotoRef) ?? '') : undefined
    models.set(key, { name, promptModel, frontModelFile, facePhotoFile })
  }

  // ----- Construire les looks (avec extraction lazy des fichiers refs) -----
  onProgress?.(`Extraction des fichiers pour ${looksRowsToUse.length} looks…`)
  const looks: LookRow[] = []
  const tasks: GenerationTask[] = []
  let lookIdx = 0
  for (const r of looksRowsToUse) {
    lookIdx++
    if (onProgress && lookIdx % 3 === 0) {
      onProgress(`Extraction des fichiers ${lookIdx}/${looksRowsToUse.length}…`)
    }

    const id = String(r['ID'] ?? '').trim()
    if (!id) continue
    const numLook = String(r['NumLook'] ?? r['SKU'] ?? r['Numero Look'] ?? '').trim()
    const mannequinName = stripRef(String(r['Model'] ?? r['Mannequin'] ?? '').trim()) || undefined

    const filesFrontRaw = String(r['FILES (FRONT)']   ?? '').trim()
    const filesBackRaw  = String(r['FILES (BACK)']    ?? r['FILES (BACK) (1)']?? '').trim()
    const referenceRaw  = String(r['IMAGE DE REFERENCE'] ?? r['Image de référence'] ?? r['REFERENCE'] ?? '').trim()

    const bgOverride   = String(r['Background Description'] ?? r['Background description'] ?? '').trim() || undefined
    const viewOverride = String(r['View Details'] ?? r['View details'] ?? r['Vue Details'] ?? '').trim() || undefined

    const filesFront = await resolveFileListLazy(filesFrontRaw, baseToKey, extractAsFile)
    const filesBack  = await resolveFileListLazy(filesBackRaw,  baseToKey, extractAsFile)
    const refFiles   = await resolveFileListLazy(referenceRaw,  baseToKey, extractAsFile)

    const isFilled = !!mannequinName || filesFront.length > 0 || refFiles.length > 0
    if (!isFilled) continue

    const lookRow: LookRow = {
      id,
      numeroLook:    numLook || id,
      mannequinName,
      fondName:      undefined,
      filesFront,
      filesBack,
      detailsFiles:  refFiles,
      description:   undefined,
      vues:          [],
      ...({ bgOverride, viewOverride } as any),
    }
    looks.push(lookRow)

    if (!mannequinName) continue

    const model = models.get(normName(mannequinName))
    const w: string[] = []
    const refs: File[] = []

    if (model?.frontModelFile) refs.push(model.frontModelFile)
    else                       w.push(`Image du mannequin "${mannequinName}" introuvable.`)

    for (const f of filesFront) refs.push(f)
    if (filesFront.length === 0) w.push('Aucun vêtement dans FILES (FRONT).')

    const inspirationFile   = refFiles[0]
    const extraInspiDetails = refFiles.slice(1)
    if (!inspirationFile) w.push('Aucune image d\'inspiration dans la colonne REFERENCE.')

    for (const f of extraInspiDetails) refs.push(f)

    tasks.push({
      id:                `${id}-inspi`,
      lookId:            id,
      numeroLook:        numLook || id,
      taskType:          'inspi',
      mannequinName,
      fondName:          '',
      prompt:            '',
      refs,
      facePhotoFile:     model?.facePhotoFile,
      inspirationFile,
      extraInspiDetails,
      outfitFiles:       filesFront,
      modelDescription:  model?.promptModel,
      bgOverride,
      viewOverride,
      warnings:          w,
    })
  }

  return { models, fonds: new Map(), looks, tasks, warnings }
}

function friendlyZipError(file: File, err: any, nested = false): Error {
  const sizeMB = Math.round(file.size / (1024 * 1024))
  const msg = String(err?.message || err || '')
  let hint = ''
  if (/failed to fetch|networkerror|aborterror/i.test(msg)) {
    hint = ` Le navigateur n'a pas pu lire les ${sizeMB} MB du fichier. Causes probables : (1) le ZIP est sur Google Drive Stream / OneDrive cloud → copie-le en LOCAL d'abord, (2) le fichier a été déplacé/renommé pendant la lecture, (3) timeout réseau.`
  } else if (/permission|could not be read|not readable/i.test(msg)) {
    hint = ` Le ZIP fait ${sizeMB} MB — probablement la RAM navigateur qui sature. Découpe l'export Notion en plusieurs zips plus petits.`
  } else if (/invalid|corrupted|signature/i.test(msg)) {
    hint = ` Le ZIP semble corrompu — re-télécharge l'export depuis Notion.`
  } else if (/out of memory|allocation failed/i.test(msg)) {
    hint = ` RAM saturée. Décompresse le Part-1.zip avec 7zip et drop directement Part-1.zip.`
  }
  const where = nested ? "Lecture du ZIP imbriqué (Part-1.zip)" : "Lecture du ZIP"
  return new Error(`${where} : ${msg || 'erreur inconnue'}.${hint}`)
}

/* ============================== Inspi prompt builder ============================== */

export function buildInspiPrompt(args: {
  mannequinName:    string
  modelDescription?:string
  outfitCount:      number
  extractedEnv:     string
  extractedPose:    string
  extraDetailCount?:number
  bgOverride?:      string
  viewOverride?:    string
  notes?:           string
}): string {
  const {
    mannequinName, modelDescription, outfitCount,
    extractedEnv, extractedPose, extraDetailCount = 0,
    bgOverride, viewOverride, notes,
  } = args
  const parts: string[] = []
  parts.push(NOTION_BOILERPLATE_HEADER + '.')
  parts.push(
    `Photographie de mode professionnelle du mannequin "${mannequinName}" (deux références en image fournies : silhouette/corps + portrait visage). ⚠ PRÉSERVATION D'IDENTITÉ STRICTE : reproduire EXACTEMENT les traits du visage de la référence portrait (forme du visage, yeux, nez, bouche, sourcils, ligne de mâchoire), la couleur et la coiffure des cheveux, le grain de peau. La silhouette/corps donne la morphologie générale. Le visage doit être instantanément reconnaissable comme le même que celui de la référence portrait. Le mannequin porte la tenue montrée en référence (${outfitCount} fichier${outfitCount > 1 ? 's' : ''}).`,
  )
  parts.push(`ENVIRONNEMENT (base extraite de l\'image d\'inspiration) : ${extractedEnv}.`)
  if (bgOverride) {
    parts.push(
      `⚠ MODIFICATIONS IMPÉRATIVES À APPLIQUER SUR L\'ENVIRONNEMENT (priorité absolue sur la base extraite) : ${bgOverride}.`,
    )
  }
  parts.push(`POSE (base extraite de l\'image d\'inspiration) : ${extractedPose}.`)
  if (viewOverride) {
    parts.push(
      `⚠ MODIFICATIONS IMPÉRATIVES À APPLIQUER SUR LA VUE / POSE / CADRAGE (priorité absolue sur la base extraite) : ${viewOverride}.`,
    )
  }
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

/* ============================== CSV helpers ============================== */

function findCsvKeyByPrefix(zipIndex: Map<string, ZipEntry>, prefixes: string[]): string | undefined {
  for (const key of zipIndex.keys()) {
    const base = baseName(key)
    if (!base.toLowerCase().endsWith('.csv')) continue
    if (base.toLowerCase().includes('_all.csv')) continue
    for (const p of prefixes) {
      if (base.toLowerCase().startsWith(p.toLowerCase())) return key
    }
  }
  return undefined
}

async function resolveFileListLazy(
  raw: string,
  baseToKey: Map<string, string>,
  extractAsFile: (key: string) => Promise<File | undefined>,
): Promise<File[]> {
  if (!raw) return []
  const names = raw.split(',').map(s => decodeRef(s.trim())).filter(Boolean)
  const out: File[] = []
  for (const name of names) {
    const key = baseToKey.get(name)
    if (!key) continue
    const file = await extractAsFile(key)
    if (file) out.push(file)
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
