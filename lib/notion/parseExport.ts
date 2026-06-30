import JSZip from 'jszip'
import Papa from 'papaparse'
import { compressImage } from '@/lib/compressImage'
import { readZipIndex, extractEntry, getEntryDataOffset, type ZipEntry } from './zipReader'
import {
  parsePoseCell,
  poseToPrompt,
  viewCropInstruction,
  orientationToPrompt,
  framingToHint,
  NOTION_BOILERPLATE_HEADER,
  NOTION_BOILERPLATE_STYLE,
  type PoseLabel,
  type PoseView,
  type PoseOrientation,
} from '@/lib/poses'

function friendlyZipError(file: File, err: any, nested = false): Error {
  const sizeMB = Math.round(file.size / (1024 * 1024))
  const msg = String(err?.message || err || '')
  let hint = ''
  if (/failed to fetch|networkerror|aborterror/i.test(msg)) {
    hint = ` Le navigateur n'a pas pu lire les ${sizeMB} MB du fichier. Causes probables : (1) le ZIP est sur Google Drive Stream / OneDrive cloud → copie-le en LOCAL d'abord (Bureau / Downloads), (2) le fichier a été déplacé/renommé pendant la lecture, (3) timeout réseau. Solution la plus rapide : décompresse le Part-1.zip avec 7zip et drop directement Part-1.zip.`
  } else if (/permission|could not be read|not readable/i.test(msg)) {
    hint = ` Le ZIP fait ${sizeMB} MB — c'est probablement la RAM navigateur qui sature OU le fichier est sur Drive Stream. Essaie : (1) copier le ZIP en local, (2) fermer les autres onglets, (3) redémarrer le navigateur, (4) découper l'export Notion en plusieurs zips plus petits.`
  } else if (/invalid|corrupted|signature/i.test(msg)) {
    hint = ` Le ZIP semble corrompu — re-télécharge l'export depuis Notion.`
  } else if (/out of memory|allocation failed/i.test(msg)) {
    hint = ` Le navigateur a saturé sa RAM. Décompresse le Part-1.zip avec 7zip et drop directement Part-1.zip pour éviter le double-zip à décompresser en mémoire.`
  }
  const where = nested ? "Lecture du ZIP imbriqué (Part-1.zip)" : "Lecture du ZIP"
  return new Error(`${where} : ${msg || 'erreur inconnue'}.${hint}`)
}

/* ============================== TYPES ============================== */

export type ModelDef = {
  name: string
  promptModel?: string
  frontModelFile?: File   // colonne FRONT-model = silhouette / corps
  facePhotoFile?: File    // colonne FACE PHOTO = portrait visage (optionnelle)
  fondFile?: File         // colonne FOND = fond dédié au mannequin (optionnelle)
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
  posePromptWithBase?: string  // prompt à utiliser quand une autre pose du même look a déjà été générée
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
  bgOverride?:        string     // colonne "Background details" — modifie l'env extrait
  viewOverride?:      string     // colonne "Vue et details"     — modifie la pose extraite
  duoTrioDesc?:       string     // colonne "description photos duo/trio" — précisions pour les visuels multi-mannequins
  mannequinNames?:    string[]   // liste complète des mannequins du visuel (si plusieurs)
  modelDescriptions?: string[]   // descriptions des mannequins (1 par mannequin)
  // Commun
  mannequinName:   string
  fondName:        string
  prompt:          string
  refs:            File[]
  facePhotoFile?:  File          // séparé pour pouvoir le dropper au retry
  warnings:        string[]
  // ----- Refs structurées (qualité optimale, mode "structured") -----
  // Quand ces champs sont remplis, le runner envoie au backend des FormData
  // structurés (mannequinBody, mannequinFace, background, products) plutôt
  // qu'un blob `refs`. Le backend construit alors un prompt façon plateforme
  // principale avec les textes descriptifs collés à chaque image.
  bodyPhotoFile?:    File         // FRONT-model
  backgroundFile?:   File         // fond
  productFiles?:     File[]       // vêtements selon la vue
  framingHint?:      string       // 'plein' | 'mi-corps' | 'haut' | 'bas' | 'detail'
}

export type ParsedExport = {
  models: Map<string, ModelDef>
  fonds:  Map<string, FondDef>
  looks:  LookRow[]
  tasks:  GenerationTask[]
  warnings: string[]
}

/* ============================== ENTRY ============================== */

export type ParseOptions = {
  /** Si true, les looks SANS Fond ne sont PAS skippés (E-Com mode : fond global UI) */
  allowMissingFond?: boolean
}

export async function parseNotionExport(
  zipFile: File,
  onProgress?: (msg: string) => void,
  lookRange?: { start: number; end: number } | number,
  options?: ParseOptions,
): Promise<ParsedExport> {
  // Stratégie LAZY : on lit d'abord l'index du ZIP (~64 KB), puis on
  // extrait UNIQUEMENT les fichiers nécessaires pour les premiers N looks.
  // Le fichier source n'est jamais entièrement chargé en RAM.
  onProgress?.('Lecture de l\'index du ZIP…')
  let zipIndex: Map<string, ZipEntry>
  try {
    zipIndex = await readZipIndex(zipFile)
  } catch (e: any) {
    throw friendlyZipError(zipFile, e)
  }

  // Si zip imbriqué Notion (Part-1.zip), on lit son index :
  //  - method 0 (stored) : path rapide offset-based, ZERO RAM
  //  - method 8 (deflate) : décompression complète en Blob (le browser
  //    store les grosses Blobs sur disque, ça marche jusqu'à plusieurs GB)
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

  // Helper : extrait une entrée du ZIP courant et la renvoie comme File compressé si image
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

  // Pour les CSV : on lit le texte (les CSV sont petits, pas besoin de compression)
  const readCsvText = async (key: string): Promise<string | undefined> => {
    const entry = zipIndex.get(key)
    if (!entry) return undefined
    const blob = await extractEntry(workingFile, entry)
    return await blob.text()
  }

  // Index par basename pour les lookups depuis CSV
  const keyByBasename = new Map<string, string>()
  for (const key of zipIndex.keys()) {
    keyByBasename.set(baseName(key), key)
  }

  const fileIndex = new Map<string, File>()

  const warnings: string[] = []

  // Recherche des CSV dans l'index par préfixe sur le basename
  const findCsvKey = (prefixes: string[]): string | undefined => {
    for (const key of zipIndex.keys()) {
      const base = baseName(key).toLowerCase()
      if (!base.endsWith('.csv')) continue
      if (base.includes('_all.csv')) continue
      for (const p of prefixes) {
        if (base.startsWith(p.toLowerCase())) return key
      }
    }
    return undefined
  }

  const csvLookKey   = findCsvKey(['LOOK', 'Looks', 'Look '])
  const csvModelsKey = findCsvKey(['Models Definition', 'Models', 'Modeles'])
  const csvFondsKey  = findCsvKey(['Fonds', 'Backgrounds', 'Decors Definition', 'Decors', 'Décors'])

  if (!csvLookKey)   warnings.push('CSV "LOOK …" introuvable.')
  if (!csvModelsKey) warnings.push('CSV "Models Definition" introuvable.')
  if (!csvFondsKey)  warnings.push('CSV "Fonds" introuvable.')

  // Lis les CSV (petits, immédiats)
  onProgress?.('Parsing des CSV…')
  const csvLookText   = csvLookKey   ? await readCsvText(csvLookKey)   : undefined
  const csvModelsText = csvModelsKey ? await readCsvText(csvModelsKey) : undefined
  const csvFondsText  = csvFondsKey  ? await readCsvText(csvFondsKey)  : undefined

  const modelsRows = csvModelsText ? parseCsvText(csvModelsText) : []
  const fondsRows  = csvFondsText  ? parseCsvText(csvFondsText)  : []
  const looksRows  = csvLookText   ? parseCsvText(csvLookText)   : []

  // 1. Filtre les looks (non vides + limite N premiers)
  const eligibleLookRows: any[] = []
  for (const r of looksRows) {
    const id = String(r['ID'] ?? '').trim()
    if (!id) continue
    eligibleLookRows.push(r)
  }
  warnings.push(`📊 CSV LOOK : ${looksRows.length} lignes au total, ${eligibleLookRows.length} avec ID.`)

  // Normalise lookRange : nombre simple = {1..N}, objet = {start..end}
  let rangeStart: number | null = null
  let rangeEnd: number | null = null
  if (typeof lookRange === 'number' && lookRange > 0) {
    rangeStart = 1
    rangeEnd   = lookRange
  } else if (lookRange && typeof lookRange === 'object' && lookRange.start > 0 && lookRange.end >= lookRange.start) {
    rangeStart = lookRange.start
    rangeEnd   = lookRange.end
  }
  const lookRowsTouse = (rangeStart !== null && rangeEnd !== null)
    ? eligibleLookRows.slice(rangeStart - 1, rangeEnd)
    : eligibleLookRows
  if (rangeStart !== null && rangeEnd !== null && eligibleLookRows.length > 0) {
    if (rangeStart === 1) {
      warnings.push(`Limité aux ${rangeEnd} premiers looks (sur ${eligibleLookRows.length} eligible).`)
    } else {
      warnings.push(`Limité aux looks ${rangeStart}-${rangeEnd} (sur ${eligibleLookRows.length} eligible, ${lookRowsTouse.length} retenus).`)
    }
  }

  // 2. Collecte les mannequins et fonds RÉELLEMENT utilisés par les N looks retenus
  const usedMannequinNames = new Set<string>()
  const usedFondNames      = new Set<string>()
  let mannequinFieldFound = 0
  let fondFieldFound = 0
  for (const r of lookRowsTouse) {
    const mn = stripRef(String(r['Mannequin'] ?? r['Model'] ?? r['Modèle'] ?? r['Modele'] ?? '').trim())
    if (mn) { usedMannequinNames.add(normName(mn)); mannequinFieldFound++ }
    const fn = stripRef(String(r['⬜ Fonds'] ?? r['Fonds'] ?? r['Fond'] ?? r['Décor'] ?? r['Decor'] ?? '').trim())
    if (fn) { usedFondNames.add(normName(fn)); fondFieldFound++ }
  }
  warnings.push(`📊 Sur ${lookRowsTouse.length} looks retenus : ${mannequinFieldFound} avec Mannequin, ${fondFieldFound} avec Fond. Mannequins uniques : ${usedMannequinNames.size}. Fonds uniques : ${usedFondNames.size}.`)
  // Liste des colonnes CSV vues — utile pour debug
  if (lookRowsTouse.length > 0) {
    const cols = Object.keys(lookRowsTouse[0])
    warnings.push(`🔑 Colonnes du CSV LOOK : ${cols.join(' | ')}`)
  }
  if (modelsRows.length > 0) {
    const cols = Object.keys(modelsRows[0])
    warnings.push(`🔑 Colonnes Models Definition : ${cols.join(' | ')}`)
  }
  if (fondsRows.length > 0) {
    const cols = Object.keys(fondsRows[0])
    warnings.push(`🔑 Colonnes Fonds/Decors : ${cols.join(' | ')}`)
  }

  // 3. Construit la liste des fichiers à extraire — uniquement les références utilisées
  const neededBasenames = new Set<string>()
  for (const r of modelsRows) {
    const name = String(r['Name your Model'] ?? r['Name'] ?? '').trim()
    if (!name || !usedMannequinNames.has(normName(name))) continue
    const f1 = decodeRef(String(r['FRONT-model'] ?? '').trim()); if (f1) neededBasenames.add(f1)
    const f2 = decodeRef(String(r['FACE PHOTO'] ?? r['Face Photo'] ?? '').trim()); if (f2) neededBasenames.add(f2)
    const f3 = decodeRef(String(r['FOND'] ?? r['Fond'] ?? '').trim()); if (f3) neededBasenames.add(f3)
  }
  for (const r of fondsRows) {
    const name = String(
      r['Decor name'] ?? r['Decor Name'] ?? r['Décor name']
      ?? r['Name your Model'] ?? r['Name'] ?? r['Fond'] ?? '',
    ).trim()
    if (!name || !usedFondNames.has(normName(name))) continue
    const f = decodeRef(String(r['Reference image'] ?? r['Reference Image'] ?? r['FOND'] ?? r['File'] ?? '').trim())
    if (f) neededBasenames.add(f)
  }
  // Vêtements et détails des N looks retenus
  for (const r of lookRowsTouse) {
    for (const colName of ['FILES (FRONT)', 'FILES (BACK)', 'FILES (BACK) (1)', 'DETAILS']) {
      const raw = String(r[colName] ?? '').trim()
      if (!raw) continue
      for (const piece of raw.split(',').map(s => decodeRef(s.trim())).filter(Boolean)) {
        neededBasenames.add(piece)
      }
    }
  }

  // Extrait les fichiers nécessaires
  onProgress?.(`Extraction de ${neededBasenames.size} image(s) référencée(s)…`)
  let extracted = 0
  for (const base of neededBasenames) {
    const key = keyByBasename.get(base)
    if (!key) continue
    const file = await extractAsFile(key)
    if (file) fileIndex.set(base, file)
    extracted++
    if (onProgress && (extracted % 5 === 0 || extracted === neededBasenames.size)) {
      onProgress(`Extraction ${extracted}/${neededBasenames.size} fichier(s) référencé(s)…`)
    }
  }

  // Construit models/fonds/looks à partir des CSV déjà parsés + fileIndex partiel
  const models = csvModelsText ? await buildModelsFromRows(modelsRows, fileIndex) : new Map<string, ModelDef>()
  const fonds  = csvFondsText  ? await buildFondsFromRows(fondsRows,  fileIndex) : new Map<string, FondDef>()
  let looks  = csvLookText   ? await buildLooksFromRows(lookRowsTouse, fileIndex) : []

  /* ============== Construction des tâches ============== */
  const tasks: GenerationTask[] = []

  for (const look of looks) {
    if (!look.mannequinName) continue

    const model = models.get(normName(look.mannequinName))
    const fond  = look.fondName ? fonds.get(normName(look.fondName)) : undefined

    // Si pas de fond explicite et pas de fond intégré au mannequin → skip
    // En mode E-Com (allowMissingFond), on accepte les looks sans Fond.
    // Le runtime utilisera un fond global fourni par l'UI.
    if (!options?.allowMissingFond && !look.fondName && !model?.fondFile) continue

    // ---------- 1. Tasks "pose" (1 par vue valide) ----------
    look.vues.forEach((pose, vueIndex) => {
      const w: string[] = []
      const refs: File[] = []

      if (model?.frontModelFile) refs.push(model.frontModelFile)
      else w.push(`Image du mannequin "${look.mannequinName}" introuvable.`)

      // Fond : on essaie d'abord le fond du look (CSV Fonds), sinon le fond intégré au mannequin
      const effectiveFondFile  = fond?.fondFile ?? model?.fondFile
      const effectiveFondLabel = look.fondName ?? (model?.fondFile ? `Fond du mannequin ${look.mannequinName}` : 'fond inconnu')
      if (effectiveFondFile) refs.push(effectiveFondFile)
      else w.push(`Aucun fond disponible (ni dans le CSV Fonds, ni associé au mannequin "${look.mannequinName}").`)

      // Choix des fichiers vêtement selon la VUE
      const vueRefs = filesForOrientation(pose.orientation, look)
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
        fondName:      effectiveFondLabel,
        prompt:    buildPosePrompt({ ...look, fondName: effectiveFondLabel }, pose, model),
        posePromptWithBase: buildPosePromptWithBase({ ...look, fondName: effectiveFondLabel }, pose),
        refs,
        facePhotoFile: model?.facePhotoFile,
        // Refs structurées pour qualité optimale
        bodyPhotoFile:   model?.frontModelFile,
        backgroundFile:  effectiveFondFile,
        productFiles:    vueRefs.files,
        framingHint:     framingToHint(pose.framing),
        warnings:  w,
      })
    })

    // ---------- 2. Tasks "detail" (1 par fichier dans DETAILS) ----------
    look.detailsFiles.forEach((detailFile, detailIndex) => {
      const w: string[] = []
      const refs: File[] = []

      if (model?.frontModelFile) refs.push(model.frontModelFile)
      else w.push(`Image du mannequin "${look.mannequinName}" introuvable.`)

      const effectiveFondFile2 = fond?.fondFile ?? model?.fondFile
      if (effectiveFondFile2) refs.push(effectiveFondFile2)
      else w.push(`Aucun fond disponible pour ce détail.`)

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
        bodyPhotoFile:   model?.frontModelFile,
        backgroundFile:  effectiveFondFile2,
        productFiles:    [detailFile],
        framingHint:     'detail',
        warnings:  w,
      })
    })
  }

  // Diagnostic final
  warnings.push(`✅ Résultat : ${looks.length} looks valides, ${tasks.length} task(s) construite(s), ${models.size} mannequin(s) résolu(s), ${fonds.size} fond(s) résolu(s).`)

  return { models, fonds, looks, tasks, warnings }
}

/* ============================== Builders ============================== */

/**
 * Sélectionne les fichiers vêtement selon l'ORIENTATION du sujet (Front / Side / Back).
 *
 *  - Front → FILES (FRONT) uniquement (le mannequin est de face, on voit le devant des vêtements)
 *  - Back  → FILES (BACK)  uniquement (le mannequin est de dos, on voit le dos des vêtements)
 *  - Side  → FILES (FRONT) + FILES (BACK) (de profil, on voit les deux côtés)
 *
 * ⚠ Indépendant du FRAMING (close-up, plein pied, etc.) : c'est uniquement
 * l'orientation qui dicte quel côté du vêtement est visible et donc quels
 * fichiers de référence envoyer à Gemini.
 */
function filesForOrientation(orientation: PoseOrientation, look: LookRow): { files: File[], warnings: string[] } {
  const w: string[] = []
  let files: File[] = []

  switch (orientation) {
    case 'Back':
      files = look.filesBack
      if (look.filesBack.length === 0) {
        // Fallback : si pas de BACK fourni, on tente quand même avec FRONT
        files = look.filesFront
        if (look.filesFront.length === 0) {
          w.push('Aucun fichier dans FILES (BACK) ni FILES (FRONT) — vue de dos impossible à habiller.')
        } else {
          w.push('FILES (BACK) vide — fallback sur FILES (FRONT) (Gemini doit inférer le dos).')
        }
      }
      break

    case 'Side':
      files = [...look.filesFront, ...look.filesBack]
      if (look.filesFront.length === 0) w.push('FILES (FRONT) vide — vue Side incomplète sans le devant.')
      if (look.filesBack.length  === 0) w.push('FILES (BACK) vide — vue Side incomplète sans le dos.')
      break

    case 'Front':
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
    `Photographie de mode professionnelle du mannequin "${look.mannequinName}" (${modelRefDescription(model)}), portant les vêtements montrés en référence. Le fond est fourni en image de référence — utilise-le tel quel.`,
  )
  parts.push(`⚠ ORIENTATION DU SUJET : ${orientationToPrompt(pose.orientation)}. C'est l'orientation du corps par rapport à la caméra — distincte du cadrage.`)
  parts.push(`POSE : ${poseToPrompt(pose)}.`)
  parts.push(viewCropInstruction(pose.view))
  // ⚠ Volontairement PAS de BACKGROUND_PRESERVATION_INSTRUCTION ici :
  // le bloc BACKGROUND du route.ts s'en charge déjà (et la phrase d'intro
  // ci-dessus suffit côté prompt utilisateur). Évite la répétition x3.
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

function buildPosePromptWithBase(look: LookRow, pose: PoseLabel): string {
  const parts: string[] = []
  parts.push(NOTION_BOILERPLATE_HEADER + '.')
  parts.push(
    `Photographie de mode professionnelle. Une image de RÉFÉRENCE DU LOOK COMPLET DÉJÀ SHOOTÉ est fournie (référence #1) : le mannequin "${look.mannequinName}" porte la tenue complète devant le fond "${look.fondName}".`,
  )
  parts.push(
    `⚠ COHÉRENCE STRICTE — produire une NOUVELLE VUE du MÊME LOOK, cohérente avec la référence : MÊME mannequin, MÊME tenue, MÊME fond (couleur, teinte, luminosité exactes), MÊME lumière, MÊME esthétique.`,
  )
  parts.push(`⚠ ORIENTATION DU SUJET : ${orientationToPrompt(pose.orientation)}.`)
  parts.push(`NOUVELLE POSE : ${poseToPrompt(pose)}.`)
  parts.push(viewCropInstruction(pose.view))
  if (look.description) parts.push(`Direction artistique : ${look.description}.`)
  parts.push(NOTION_BOILERPLATE_STYLE)
  return parts.join('\n\n')
}

function buildDetailPrompt(look: LookRow, detailFile: File, model?: ModelDef): string {
  const parts: string[] = []
  parts.push(NOTION_BOILERPLATE_HEADER + '.')
  parts.push(
    `Photographie de mode professionnelle en PLAN RAPPROCHÉ / GROS PLAN sur un détail de vêtement (broderie, matière, fermeture, finition, accessoire) — détail montré en référence (fichier "${detailFile.name}"), porté par le mannequin "${look.mannequinName}" (${modelRefDescription(model)}). Le fond est fourni en image de référence — utilise-le tel quel.`,
  )
  parts.push(
    'Cadrage serré sur le détail, mise au point très précise sur la matière et le tombé, lumière qui révèle la texture, profondeur de champ très courte (f/2.0 ressenti), composition éditoriale.',
  )
  // ⚠ Pas de BACKGROUND_PRESERVATION_INSTRUCTION : géré par route.ts
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

function parseCsvText(text: string): any[] {
  const cleaned = text.replace(/^﻿/, '')
  const parsed = Papa.parse(cleaned, { header: true, skipEmptyLines: true })
  return parsed.data as any[]
}

async function buildModelsFromRows(rows: any[], index: Map<string, File>): Promise<Map<string, ModelDef>> {
  const m = new Map<string, ModelDef>()
  for (const r of rows) {
    const name = String(r['Name your Model'] ?? r['Name'] ?? '').trim()
    if (!name) continue
    const promptModel  = String(r['Prompt Model'] ?? '').trim() || undefined
    const frontFileRef = decodeRef(String(r['FRONT-model'] ?? '').trim())
    const frontModelFile = frontFileRef ? index.get(frontFileRef) : undefined
    const facePhotoRef = decodeRef(String(r['FACE PHOTO'] ?? r['Face Photo'] ?? '').trim())
    const facePhotoFile = facePhotoRef ? index.get(facePhotoRef) : undefined
    // Fond intégré au mannequin (colonne FOND dans Models Definition)
    const fondRef = decodeRef(String(r['FOND'] ?? r['Fond'] ?? '').trim())
    const fondFile = fondRef ? index.get(fondRef) : undefined
    m.set(normName(name), { name, promptModel, frontModelFile, facePhotoFile, fondFile })
  }
  return m
}

async function buildFondsFromRows(rows: any[], index: Map<string, File>): Promise<Map<string, FondDef>> {
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

async function buildLooksFromRows(rows: any[], index: Map<string, File>): Promise<LookRow[]> {
  const out: LookRow[] = []
  for (const r of rows) {
    const id          = String(r['ID'] ?? '').trim()
    const numeroLook  = String(r['Numero Look'] ?? r['NumLook'] ?? r['SKU'] ?? r['Propriété'] ?? r['Propriete'] ?? '').trim() || id
    if (!id) continue

    const mannequinName = stripRef(String(r['Mannequin'] ?? r['Model'] ?? r['Modèle'] ?? r['Modele'] ?? '').trim()) || undefined
    const fondName      = stripRef(String(r['⬜ Fonds'] ?? r['Fonds'] ?? r['Fond'] ?? r['Décor'] ?? r['Decor'] ?? '').trim()) || undefined
    const filesFrontRaw = String(r['FILES (FRONT)'] ?? '').trim()
    const filesBackRaw  = String(r['FILES (BACK)']  ?? r['FILES (BACK) (1)'] ?? '').trim()
    const detailsRaw    = String(r['DETAILS']       ?? '').trim()
    const description   = String(r['DESCRIPTION']   ?? '').trim() || undefined

    const filesFront   = resolveFileList(filesFrontRaw, index)
    const filesBack    = resolveFileList(filesBackRaw,  index)
    const detailsFiles = resolveFileList(detailsRaw,    index)

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

async function parseModels(csv: File, index: Map<string, File>): Promise<Map<string, ModelDef>> {
  const rows = await readCsv(csv)
  return buildModelsFromRows(rows, index)
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

function stripRef(cell: string): string {
  if (!cell) return ''
  const trimmed = cell.trim()
  // Si la cellule se termine par ".md)", c'est un lien Notion :
  // "Nom du truc (Nom%20du%20truc abc...md)"
  // On coupe au DERNIER " (" pour préserver les noms qui contiennent déjà
  // des parenthèses (ex "TOM (1)").
  if (trimmed.endsWith('.md)')) {
    const i = trimmed.lastIndexOf(' (')
    if (i > 0) return trimmed.slice(0, i).trim()
  }
  return trimmed
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

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}
