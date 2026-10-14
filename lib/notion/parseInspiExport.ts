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
  for (const c of ignoredInspiColumns(eligibleLooks)) {
    warnings.push(`⚠ Colonne "${c}" remplie mais IGNORÉE par l'onglet Inspiration — renomme-la en "Vue et details", "Background Description" ou "Commentaires" pour qu'elle soit prise en compte.`)
  }

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
  // Pour économiser l'extraction, on collecte d'abord les noms utilisés.
  // La cellule "Model" peut contenir PLUSIEURS mannequins (séparés par virgule,
  // & ou autre) → on split pour ne pas rater les visuels duo/trio.
  const usedModelNames = new Set<string>()
  for (const r of looksRowsToUse) {
    const raw = String(r['Model'] ?? r['Mannequin'] ?? '').trim()
    for (const name of parseModelList(raw)) {
      usedModelNames.add(normName(name))
    }
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

    // Multi-mannequins : la cellule Model peut contenir plusieurs noms
    const modelRaw = String(r['Model'] ?? r['Mannequin'] ?? '').trim()
    const mannequinNames = parseModelList(modelRaw)
    const mannequinName = mannequinNames[0] || undefined

    const filesFrontRaw = String(r['FILES (FRONT)']   ?? '').trim()
    const filesBackRaw  = String(r['FILES (BACK)']    ?? r['FILES (BACK) (1)']?? '').trim()
    const referenceRaw  = String(r['IMAGE DE REFERENCE'] ?? r['Image de référence'] ?? r['REFERENCE'] ?? '').trim()

    // Colonnes texte — noms reconnus sans tenir compte de la casse, des accents ni des espaces
    const bgOverride   = textCol(r, BG_COLS)
    const viewOverride = textCol(r, VIEW_COLS)
    const duoTrioDesc  = textCol(r, DUO_COLS)
    const inspiNotes   = textCol(r, NOTES_COLS)

    const filesFront = await resolveFileListLazy(filesFrontRaw, baseToKey, extractAsFile)
    const filesBack  = await resolveFileListLazy(filesBackRaw,  baseToKey, extractAsFile)
    const refFiles   = await resolveFileListLazy(referenceRaw,  baseToKey, extractAsFile)

    const isFilled = mannequinNames.length > 0 || filesFront.length > 0 || refFiles.length > 0
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

    if (mannequinNames.length === 0) continue

    // Pour les multi-mannequins : on collecte tous les models présents
    const usedModels = mannequinNames
      .map(name => models.get(normName(name)))
      .filter((m): m is ModelDef => !!m)

    const w: string[] = []
    const refs: File[] = []

    // Refs : front model file de chaque mannequin (pour montrer chaque silhouette)
    for (const m of usedModels) {
      if (m.frontModelFile) refs.push(m.frontModelFile)
    }
    if (usedModels.length < mannequinNames.length) {
      const missing = mannequinNames.filter(n => !models.get(normName(n))).join(', ')
      w.push(`Image(s) mannequin introuvable(s) : "${missing}".`)
    }

    for (const f of filesFront) refs.push(f)
    if (filesFront.length === 0) w.push('Aucun vêtement dans FILES (FRONT).')

    // On prend SEULEMENT la première inspiration (ignore les suivantes)
    const inspirationFile = refFiles[0]
    if (!inspirationFile) w.push('Aucune image d\'inspiration dans la colonne REFERENCE.')
    if (refFiles.length > 1) w.push(`${refFiles.length} images dans REFERENCE : en mode « Extracteur » seule la 1re est utilisée — choisis « Envoi direct » pour toutes les envoyer à l'IA.`)

    // Face photo : on prend celle du premier mannequin (utilisée comme ref principale)
    const facePhotoFile = usedModels[0]?.facePhotoFile

    // Descriptions de chaque mannequin (pour le prompt multi-mannequin)
    const modelDescriptions = usedModels.map(m => m.promptModel ?? '').filter(Boolean)

    tasks.push({
      id:                `${id}-inspi`,
      lookId:            id,
      numeroLook:        numLook || id,
      taskType:          'inspi',
      mannequinName:     mannequinName!,
      mannequinNames,
      modelDescriptions,
      fondName:          '',
      prompt:            '',
      refs,
      facePhotoFile,
      inspirationFile,
      extraInspiDetails: [],   // on ignore les inspirations supplémentaires
      outfitFiles:       filesFront,
      modelDescription:  usedModels[0]?.promptModel,
      bgOverride,
      viewOverride,
      duoTrioDesc,
      inspiNotes,
      inspiRefs:         refFiles,
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
  mannequinNames?:  string[]     // si plusieurs mannequins (duo/trio)
  modelDescription?:string
  modelDescriptions?: string[]   // 1 description par mannequin
  outfitCount:      number
  extractedEnv:     string
  extractedPose:    string
  extraDetailCount?:number
  bgOverride?:      string
  viewOverride?:    string
  duoTrioDesc?:     string       // précisions spécifiques pour visuels multi-mannequins
  notes?:           string
}): string {
  const {
    mannequinName, mannequinNames, modelDescription, modelDescriptions,
    outfitCount, extractedEnv, extractedPose, extraDetailCount = 0,
    bgOverride, viewOverride, duoTrioDesc, notes,
  } = args
  const parts: string[] = []
  parts.push(NOTION_BOILERPLATE_HEADER + '.')

  const isMulti = (mannequinNames?.length ?? 0) > 1
  if (isMulti) {
    const names = mannequinNames!.join(', ')
    const count = mannequinNames!.length
    parts.push(
      `Photographie de mode professionnelle ${count === 2 ? 'd\'un DUO' : count === 3 ? 'd\'un TRIO' : `d\'un groupe de ${count}`} de mannequins : ${names}. Les références en image fournissent la silhouette/corps de CHAQUE mannequin (1 par mannequin) + un portrait visage du premier. ⚠ PRÉSERVATION D'IDENTITÉ STRICTE : chaque mannequin doit ressembler à sa propre référence silhouette (morphologie, build, couleur de peau, coiffure). Ils portent la tenue montrée en référence (${outfitCount} fichier${outfitCount > 1 ? 's' : ''}).`
    )
  } else {
    parts.push(
      `Photographie de mode professionnelle du mannequin "${mannequinName}" (deux références en image fournies : silhouette/corps + portrait visage). ⚠ PRÉSERVATION D'IDENTITÉ STRICTE : reproduire EXACTEMENT les traits du visage de la référence portrait (forme du visage, yeux, nez, bouche, sourcils, ligne de mâchoire), la couleur et la coiffure des cheveux, le grain de peau. La silhouette/corps donne la morphologie générale. Le visage doit être instantanément reconnaissable comme le même que celui de la référence portrait. Le mannequin porte la tenue montrée en référence (${outfitCount} fichier${outfitCount > 1 ? 's' : ''}).`,
    )
  }
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

  // Multi-mannequin : descriptions individuelles
  if (isMulti && modelDescriptions && modelDescriptions.length > 0) {
    for (let i = 0; i < modelDescriptions.length; i++) {
      const desc = modelDescriptions[i]
      const name = mannequinNames?.[i] ?? `Mannequin ${i + 1}`
      if (desc) parts.push(`Note mannequin "${name}" : ${desc}.`)
    }
  } else if (modelDescription) {
    parts.push(`Note mannequin : ${modelDescription}.`)
  }

  // Note duo/trio : précisions pour les visuels multi-mannequins (interaction, positionnement, etc.)
  if (duoTrioDesc) {
    parts.push(`⚠ COMPOSITION ${isMulti ? 'DUO/TRIO' : ''} : ${duoTrioDesc}.`)
  }

  if (notes)            parts.push(`⚠ CONSIGNES DU BRIEF (à respecter impérativement, priorité sur les bases extraites) : ${notes}.`)
  parts.push(NOTION_BOILERPLATE_STYLE)
  return parts.join('\n\n')
}

/**
 * Mode « envoi direct » : les images de REFERENCE sont envoyées TELLES QUELLES à l'IA (pas d'Extracteur).
 * Ordre des images envoyées (route free, mode legacy) :
 *   silhouettes des mannequins → tenue → références d'inspiration → portrait visage (dernière image).
 */
export function buildInspiDirectPrompt(args: {
  mannequinNames:     string[]
  modelDescriptions?: string[]
  silhouetteCount:    number
  outfitCount:        number
  referenceCount:     number
  hasFace:            boolean
  bgOverride?:        string
  viewOverride?:      string
  duoTrioDesc?:       string
  notes?:             string
}): string {
  const { mannequinNames, modelDescriptions = [], silhouetteCount, outfitCount, referenceCount, hasFace, bgOverride, viewOverride, duoTrioDesc, notes } = args
  const names = mannequinNames.join(', ')
  const isMulti = mannequinNames.length > 1
  const range = (a: number, n: number) => (n <= 1 ? `IMAGE ${a}` : `IMAGES ${a} à ${a + n - 1}`)
  let i = 1
  const lines: string[] = []
  if (silhouetteCount) { lines.push(`- ${range(i, silhouetteCount)} : silhouette / corps ${isMulti ? `de chaque mannequin (${names}, dans cet ordre)` : `du mannequin "${names}"`} — morphologie, carnation, cheveux. Ne pas copier leur tenue ni leur pose.`); i += silhouetteCount }
  if (outfitCount) { lines.push(`- ${range(i, outfitCount)} : la TENUE à porter (${outfitCount} fichier${outfitCount > 1 ? 's' : ''}) — reproduire chaque pièce fidèlement (coupe, matière, couleur, détails).`); i += outfitCount }
  if (referenceCount) {
    lines.push(`- ${range(i, referenceCount)} : RÉFÉRENCES D'INSPIRATION.${referenceCount > 1
      ? ` La 1re (IMAGE ${i}) donne la POSE et la COMPOSITION principales ; les suivantes apportent les éléments complémentaires décrits dans les consignes (décor, lumière, mobilier, couleur, accessoire…).`
      : ' Elle donne la pose, la composition, le décor et la lumière.'} Ne PAS copier les vêtements ni les visages des personnes présentes sur ces références, ni le texte éventuel.`)
    i += referenceCount
  }
  if (hasFace) lines.push(`- IMAGE ${i} (dernière) : portrait visage de "${mannequinNames[0]}" — identité stricte.`)

  const parts: string[] = [NOTION_BOILERPLATE_HEADER + '.']
  parts.push(isMulti
    ? `Photographie de mode professionnelle d'un ${mannequinNames.length === 2 ? 'DUO' : 'groupe'} de mannequins : ${names}. ⚠ PRÉSERVATION D'IDENTITÉ STRICTE : chaque mannequin ressemble à sa propre silhouette de référence.`
    : `Photographie de mode professionnelle du mannequin "${names}". ⚠ PRÉSERVATION D'IDENTITÉ STRICTE : visage instantanément reconnaissable comme celui du portrait de référence (traits, cheveux, grain de peau).`)
  parts.push(`IMAGES FOURNIES, dans l'ordre :\n${lines.join('\n')}`)
  if (bgOverride)   parts.push(`⚠ DÉCOR / ENVIRONNEMENT (priorité absolue) : ${bgOverride}.`)
  if (viewOverride) parts.push(`⚠ VUE / POSE / CADRAGE (priorité absolue) : ${viewOverride}.`)
  if (notes)        parts.push(`⚠ CONSIGNES DU BRIEF (à respecter impérativement) : ${notes}.`)
  if (duoTrioDesc)  parts.push(`⚠ COMPOSITION ${isMulti ? 'DUO/TRIO' : ''} : ${duoTrioDesc}.`)
  mannequinNames.forEach((n, k) => { if (modelDescriptions[k]) parts.push(`Note mannequin "${n}" : ${modelDescriptions[k]}.`) })
  parts.push(NOTION_BOILERPLATE_STYLE.replace(/⚠ Apply the editorial style ONLY[\s\S]*$/, '').trim())
  return parts.join('\n\n')
}

/* ============================== Colonnes texte ============================== */

// Noms de colonnes acceptés (comparés sans casse, accents ni espaces superflus)
const BG_COLS    = ['Background Description', 'Background details', 'Background', 'Description du fond', 'Fond', 'Décor', 'Decor', 'Décor et lumière']
const VIEW_COLS  = ['Vue et details', 'View details', 'Vue Details', 'Vue et poses', 'Vue et pose', 'Vue & pose', 'Vues et poses', 'Pose', 'Poses', 'Vue', 'Cadrage']
const DUO_COLS   = ['description photos duo/trio', 'Description duo/trio', 'Duo/Trio', 'Description duo']
const NOTES_COLS = ['Description et commentaires', 'Commentaires', 'Commentaire', 'Notes', 'Consignes', 'Description', 'Brief', 'Remarques']
// Colonnes structurelles (non textuelles) lues ailleurs dans le parser
const KNOWN_COLS = ['ID', 'SKU', 'NumLook', 'Numero Look', 'Model', 'Mannequin', 'FILES (FRONT)', 'FILES (BACK)', 'FILES (BACK) (1)',
  'REFERENCE', 'IMAGE DE REFERENCE', 'Image de référence', 'EMPTY']

const normCol = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

/** Valeur de la 1re colonne présente et remplie parmi `names` (sans casse ni accents). */
function textCol(r: any, names: string[]): string | undefined {
  const keys = Object.keys(r)
  for (const n of names) {
    const k = keys.find(x => normCol(x) === normCol(n))
    const v = k ? String(r[k] ?? '').trim() : ''
    if (v) return v
  }
  return undefined
}

/** Colonnes remplies dans au moins une ligne mais que l'onglet n'utilise pas → avertissement explicite. */
export function ignoredInspiColumns(rows: any[]): string[] {
  const used = new Set([...BG_COLS, ...VIEW_COLS, ...DUO_COLS, ...NOTES_COLS, ...KNOWN_COLS].map(normCol))
  const headers = new Set(rows.flatMap(r => Object.keys(r)))
  return [...headers].filter(h => h.trim() && !used.has(normCol(h)) && rows.some(r => String(r[h] ?? '').trim()))
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

function parseModelList(raw: string): string[] {
  if (!raw) return []
  return raw
    .split(/,|&|\+|\n|\bet\b/i)
    .map(s => stripRef(s.trim()))
    .filter(Boolean)
}

function decodeRef(raw: string): string {
  if (!raw) return ''
  try { return decodeURIComponent(raw.replace(/\+/g, '%20')) }
  catch { return raw }
}
