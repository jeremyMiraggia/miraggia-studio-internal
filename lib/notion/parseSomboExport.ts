import JSZip from 'jszip'
import Papa from 'papaparse'
import {
  poseToPrompt,
  NOTION_BOILERPLATE_HEADER,
  NOTION_BOILERPLATE_STYLE,
  type PoseLabel,
  type PoseView,
} from '@/lib/poses'
import type { ParsedExport, GenerationTask, ModelDef, FondDef, LookRow } from './parseExport'

/**
 * Parser pour l'export "Notion Internal" — plateforme SOMBO développée par Jeremy.
 *
 * Structure attendue :
 *   - data.json                  (descripteur complet — models, backgrounds, options)
 *   - visuals.csv                (1 ligne = 1 visuel — view + pose séparés)
 *   - looks.csv                  (sommaire — optionnel)
 *   - brief.md                   (lecture humaine — optionnel)
 *   - references/models/*.png    (images des mannequins)
 *   - references/backgrounds/*.png (images des fonds)
 *   - images/Look NN/*           (vêtements du look)
 *
 * On retourne le même type ParsedExport que pour Notion natif, pour que l'UI
 * reste partagée.
 */

// Forme partielle de data.json (on ne lit que ce dont on a besoin)
type SomboData = {
  models?:      { name: string, description?: string | null, image_url?: string }[]
  backgrounds?: { name: string, description?: string | null, image_url?: string }[]
}

export async function parseSomboExport(zipFile: File): Promise<ParsedExport> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(zipFile)
  } catch (e: any) {
    const sizeMB = Math.round(zipFile.size / (1024 * 1024))
    const msg = String(e?.message || e || '')
    let hint = ''
    if (/permission|could not be read|not readable/i.test(msg)) {
      hint = ` Le ZIP fait ${sizeMB} MB — RAM navigateur saturée. Ferme les autres onglets et réessaie.`
    } else if (/invalid|corrupted|signature/i.test(msg)) {
      hint = ' Le ZIP semble corrompu — re-télécharge l\'export.'
    }
    throw new Error(`Lecture du ZIP : ${msg || 'erreur inconnue'}.${hint}`)
  }

  // ===== Index des fichiers par CHEMIN COMPLET (pas baseName, car la structure
  // est hiérarchique : "images/Look 01/face-02.jpeg", "references/models/X.png")
  const fileIndex      = new Map<string, File>()       // clé = chemin complet
  const fileIndexBase  = new Map<string, File>()       // clé = basename, secours

  await Promise.all(
    Object.keys(zip.files).map(async (path) => {
      const entry = zip.files[path]
      if (entry.dir) return
      const base = baseName(path)
      const mime = guessMime(base)
      const blob = await entry.async('blob')
      const file = new File([blob], base, { type: mime })
      fileIndex.set(path, file)
      fileIndexBase.set(base, file)
    }),
  )

  const warnings: string[] = []

  // ===== Lecture de data.json (optionnel mais utile pour les descriptions)
  let data: SomboData = {}
  const dataJsonFile = fileIndex.get('data.json') ?? fileIndexBase.get('data.json')
  if (dataJsonFile) {
    try { data = JSON.parse(await dataJsonFile.text()) }
    catch { warnings.push('data.json présent mais illisible (JSON invalide).') }
  } else {
    warnings.push('data.json introuvable.')
  }

  // ===== Construction des maps models / backgrounds
  const models = buildModelsMap(data.models ?? [], fileIndex, fileIndexBase)
  const fonds  = buildFondsMap(data.backgrounds ?? [], fileIndex, fileIndexBase)

  // ===== Lecture de visuals.csv (source de vérité)
  const visualsCsv = findCsv(fileIndex, fileIndexBase, ['visuals.csv'])
  if (!visualsCsv) {
    return {
      models, fonds, looks: [], tasks: [],
      warnings: [...warnings, 'visuals.csv introuvable — impossible de construire les visuels.'],
    }
  }

  const rows = await readCsv(visualsCsv)
  if (!rows.length) {
    return {
      models, fonds, looks: [], tasks: [],
      warnings: [...warnings, 'visuals.csv est vide.'],
    }
  }

  // ===== Regroupement des rows par look_reference -> LookRow (pour l'UI)
  // Et construction des GenerationTask en parallèle
  const looksMap = new Map<string, LookRow>()
  const tasks: GenerationTask[] = []
  const poseCounters = new Map<string, number>()
  const detailCounters = new Map<string, number>()

  for (const r of rows) {
    const visualId        = String(r['visual_id']             ?? '').trim()
    const lookRef         = String(r['look_reference']        ?? '').trim()
    const modelNameRaw    = String(r['model_name']            ?? '').trim()
    const modelDescRaw    = String(r['model_description']     ?? '').trim()
    const bgNameRaw       = String(r['background_name']       ?? '').trim()
    const bgDescRaw       = String(r['background_description']?? '').trim()
    const viewRaw         = String(r['view']                  ?? '').trim()
    const poseRaw         = String(r['pose']                  ?? '').trim()
    const faceFilesRaw    = String(r['image_face_files']      ?? '').trim()
    const backFilesRaw    = String(r['image_back_files']      ?? '').trim()
    const otherFilesRaw   = String(r['image_other_files']     ?? '').trim()
    const notes           = String(r['notes']                 ?? '').trim()

    if (!lookRef) continue

    // Construit / réutilise le LookRow agrégé
    if (!looksMap.has(lookRef)) {
      looksMap.set(lookRef, {
        id:         lookRef,
        numeroLook: lookRef.replace(/^look\s*/i, ''), // "Look 01" → "01"
        mannequinName: modelNameRaw || undefined,
        fondName:      bgNameRaw || undefined,
        filesFront:    [],
        filesBack:     [],
        detailsFiles:  [],
        description:   notes || undefined,
        vues:          [],
      })
    }
    const look = looksMap.get(lookRef)!

    // Ajoute les fichiers (uniques)
    for (const f of resolveSomboFileList(faceFilesRaw, fileIndex, fileIndexBase)) {
      if (!look.filesFront.includes(f)) look.filesFront.push(f)
    }
    for (const f of resolveSomboFileList(backFilesRaw, fileIndex, fileIndexBase)) {
      if (!look.filesBack.includes(f)) look.filesBack.push(f)
    }
    const otherFiles = resolveSomboFileList(otherFilesRaw, fileIndex, fileIndexBase)
    for (const f of otherFiles) {
      if (!look.detailsFiles.includes(f)) look.detailsFiles.push(f)
    }

    // Récupère mannequin / fond depuis les maps si disponibles
    const model = modelNameRaw ? models.get(normName(modelNameRaw)) : undefined
    const fond  = bgNameRaw    ? fonds.get(normName(bgNameRaw))     : undefined

    // ===== Construit le PoseLabel (view + pose séparés dans SOMBO)
    const pose = buildPoseLabelFromSomboFields(viewRaw, poseRaw)
    if (pose) look.vues.push(pose)

    // ===== Task POSE
    if (pose) {
      const w: string[] = []
      const refs: File[] = []

      if (model?.frontModelFile) refs.push(model.frontModelFile)
      else if (modelNameRaw)     w.push(`Image du mannequin "${modelNameRaw}" introuvable.`)
      else                       w.push('Aucun mannequin spécifié pour ce visuel.')

      if (fond?.fondFile) refs.push(fond.fondFile)
      else if (bgNameRaw) w.push(`Image du fond "${bgNameRaw}" introuvable.`)
      else                w.push('Aucun fond spécifié pour ce visuel.')

      const { files: vueRefs, warnings: vw } = filesForViewSombo(
        pose.view, look.filesFront, look.filesBack,
      )
      for (const f of vueRefs) refs.push(f)
      for (const wm of vw) w.push(wm)

      const idx = (poseCounters.get(lookRef) ?? 0)
      poseCounters.set(lookRef, idx + 1)

      tasks.push({
        id:            visualId || `${lookRef}-pose-${idx + 1}`,
        lookId:        lookRef,
        numeroLook:    look.numeroLook,
        taskType:      'pose',
        vueIndex:      idx,
        vueRaw:        `${viewRaw}, ${poseRaw}`,
        pose,
        mannequinName: modelNameRaw,
        fondName:      bgNameRaw,
        prompt:        buildSomboPosePrompt(modelNameRaw, modelDescRaw, bgNameRaw, bgDescRaw, pose, notes),
        refs,
        warnings:      w,
      })
    } else if (viewRaw || poseRaw) {
      // On a une view ou une pose mais le PoseLabel n'a pas pu être construit
      // (view non reconnue). On essaie quand même avec un fallback.
      const idx = (poseCounters.get(lookRef) ?? 0)
      poseCounters.set(lookRef, idx + 1)

      const w: string[] = []
      w.push(`Vue "${viewRaw}" non reconnue par lib/poses.ts. Mapping fallback utilisé.`)
      const refs: File[] = []
      if (model?.frontModelFile) refs.push(model.frontModelFile)
      if (fond?.fondFile)        refs.push(fond.fondFile)
      for (const f of look.filesFront) refs.push(f)

      tasks.push({
        id:            visualId || `${lookRef}-pose-${idx + 1}`,
        lookId:        lookRef,
        numeroLook:    look.numeroLook,
        taskType:      'pose',
        vueIndex:      idx,
        vueRaw:        `${viewRaw}, ${poseRaw}`,
        mannequinName: modelNameRaw,
        fondName:      bgNameRaw,
        prompt:        buildSomboFallbackPrompt(modelNameRaw, modelDescRaw, bgNameRaw, bgDescRaw, viewRaw, poseRaw, notes),
        refs,
        warnings:      w,
      })
    }

    // ===== Tasks DETAIL (1 par image_other_files)
    for (const detailFile of otherFiles) {
      const dIdx = (detailCounters.get(lookRef) ?? 0)
      detailCounters.set(lookRef, dIdx + 1)

      const w: string[] = []
      const refs: File[] = []

      if (model?.frontModelFile) refs.push(model.frontModelFile)
      else if (modelNameRaw)     w.push(`Image du mannequin "${modelNameRaw}" introuvable.`)

      if (fond?.fondFile) refs.push(fond.fondFile)
      else if (bgNameRaw) w.push(`Image du fond "${bgNameRaw}" introuvable.`)

      refs.push(detailFile)

      tasks.push({
        id:            `${visualId || lookRef}-detail-${dIdx + 1}`,
        lookId:        lookRef,
        numeroLook:    look.numeroLook,
        taskType:      'detail',
        detailIndex:   dIdx,
        detailName:    detailFile.name,
        detailFile,
        mannequinName: modelNameRaw,
        fondName:      bgNameRaw,
        prompt:         buildSomboDetailPrompt(modelNameRaw, modelDescRaw, bgNameRaw, bgDescRaw, detailFile, notes),
        promptWithBase: buildSomboDetailPromptWithBase(modelNameRaw, bgNameRaw, detailFile, notes),
        refs,
        warnings:      w,
      })
    }
  }

  return {
    models,
    fonds,
    looks: Array.from(looksMap.values()),
    tasks,
    warnings,
  }
}

/* ============================== HELPERS ============================== */

function buildModelsMap(
  models: NonNullable<SomboData['models']>,
  fileIndex: Map<string, File>,
  fileIndexBase: Map<string, File>,
): Map<string, ModelDef> {
  const m = new Map<string, ModelDef>()
  for (const md of models) {
    if (!md?.name) continue
    // image_url est de la forme "brands/<uuid>/models/<filename>.png"
    // mais dans le zip elle est à "references/models/<filename>.png"
    const filename = md.image_url ? baseName(md.image_url) : ''
    let file = filename ? fileIndexBase.get(filename) : undefined
    if (!file && filename) {
      file = fileIndex.get(`references/models/${filename}`)
    }
    m.set(normName(md.name), {
      name: md.name,
      promptModel: md.description || undefined,
      frontModelFile: file,
    })
  }
  return m
}

function buildFondsMap(
  bgs: NonNullable<SomboData['backgrounds']>,
  fileIndex: Map<string, File>,
  fileIndexBase: Map<string, File>,
): Map<string, FondDef> {
  const m = new Map<string, FondDef>()
  for (const bg of bgs) {
    if (!bg?.name) continue
    const filename = bg.image_url ? baseName(bg.image_url) : ''
    let file = filename ? fileIndexBase.get(filename) : undefined
    if (!file && filename) {
      file = fileIndex.get(`references/backgrounds/${filename}`)
    }
    m.set(normName(bg.name), { name: bg.name, fondFile: file })
  }
  return m
}

/**
 * Construit un PoseLabel à partir des champs view/pose séparés du SOMBO.
 * Réutilise les VIEW_ALIASES définis dans lib/poses.ts via parsePoseCell
 * en simulant le format "vue, pose".
 */
function buildPoseLabelFromSomboFields(view: string, pose: string): PoseLabel | null {
  if (!view || !pose) return null
  // On crée une cellule virtuelle pour réutiliser parsePoseCell
  const cell = `${view}, ${pose}`
  // import statique de parsePoseCell pas dispo ici, on duplique la logique :
  const viewKey = normalizeKey(view)
  const viewMapped = VIEW_ALIASES_INTERNAL[viewKey]
  if (!viewMapped) return null
  const style = pose.toLowerCase().trim()
  if (!style) return null
  return { view: viewMapped, style, raw: cell }
}

/**
 * Copie locale des aliases (on aurait pu exporter VIEW_ALIASES depuis poses.ts
 * mais cette duplication minimaliste évite un cycle d'import et garde la
 * portée focalisée sur les vues SOMBO. Reste synchronisée avec poses.ts.)
 */
const VIEW_ALIASES_INTERNAL: Record<string, PoseView> = {
  'front':           'Front',
  'face':            'Front',
  'side':            'Side',
  'profil':          'Side',
  'profile':         'Side',
  'back':            'Back',
  'dos':             'Back',
  'close up haut':   'CloseUpHaut',
  'closeup haut':    'CloseUpHaut',
  'close-up haut':   'CloseUpHaut',
  'gros plan haut':  'CloseUpHaut',
  'cu haut':         'CloseUpHaut',
  'close up bas':    'CloseUpBas',
  'closeup bas':     'CloseUpBas',
  'close-up bas':    'CloseUpBas',
  'gros plan bas':   'CloseUpBas',
  'cu bas':          'CloseUpBas',
  'bas':             'CloseUpBas',
  'haut':            'CloseUpHaut',
  '3/4 face droite': 'Side',
  '3/4 face gauche': 'Side',
  '3/4 dos droite':  'Back',
  '3/4 dos gauche':  'Back',
  '3 4 face droite': 'Side',
  '3 4 face gauche': 'Side',
  '3 4 dos droite':  'Back',
  '3 4 dos gauche':  'Back',
}

function filesForViewSombo(
  view: PoseView, front: File[], back: File[],
): { files: File[], warnings: string[] } {
  const w: string[] = []
  let files: File[] = []
  switch (view) {
    case 'Back':
      files = back
      if (back.length === 0) w.push('Aucun fichier dans image_back_files — vue Back impossible à habiller.')
      break
    case 'Side':
      files = [...front, ...back]
      if (front.length === 0) w.push('image_face_files vide — vue Side incomplète.')
      if (back.length  === 0) w.push('image_back_files vide — vue Side incomplète.')
      break
    case 'Front':
    case 'CloseUpHaut':
    case 'CloseUpBas':
    default:
      files = front
      if (front.length === 0) w.push('Aucun fichier dans image_face_files.')
      break
  }
  return { files, warnings: w }
}

function buildSomboPosePrompt(
  modelName: string, modelDesc: string,
  bgName: string, bgDesc: string,
  pose: PoseLabel, notes: string,
): string {
  const parts: string[] = []
  parts.push(NOTION_BOILERPLATE_HEADER + '.')
  const modelLabel = modelName || 'le mannequin'
  const bgLabel    = bgName    || 'le fond fourni'
  parts.push(
    `Photographie de mode professionnelle du mannequin "${modelLabel}" (référence en image fournie), portant les vêtements montrés en référence, devant le fond "${bgLabel}" (référence en image fournie).`,
  )
  parts.push(`POSE : ${poseToPrompt(pose)}.`)
  if (modelDesc) parts.push(`Note mannequin : ${modelDesc}.`)
  if (bgDesc)    parts.push(`Note fond : ${bgDesc}.`)
  if (notes)     parts.push(`Notes : ${notes}.`)
  parts.push(NOTION_BOILERPLATE_STYLE)
  return parts.join('\n\n')
}

function buildSomboFallbackPrompt(
  modelName: string, modelDesc: string,
  bgName: string, bgDesc: string,
  viewRaw: string, poseRaw: string, notes: string,
): string {
  const parts: string[] = []
  parts.push(NOTION_BOILERPLATE_HEADER + '.')
  const modelLabel = modelName || 'le mannequin'
  const bgLabel    = bgName    || 'le fond fourni'
  parts.push(
    `Photographie de mode professionnelle du mannequin "${modelLabel}" (référence en image fournie), portant les vêtements montrés en référence, devant le fond "${bgLabel}" (référence en image fournie).`,
  )
  parts.push(`VUE : ${viewRaw || 'face caméra'}. POSE : ${poseRaw || 'pose naturelle'}.`)
  if (modelDesc) parts.push(`Note mannequin : ${modelDesc}.`)
  if (bgDesc)    parts.push(`Note fond : ${bgDesc}.`)
  if (notes)     parts.push(`Notes : ${notes}.`)
  parts.push(NOTION_BOILERPLATE_STYLE)
  return parts.join('\n\n')
}

function buildSomboDetailPrompt(
  modelName: string, modelDesc: string,
  bgName: string, bgDesc: string,
  detailFile: File, notes: string,
): string {
  const parts: string[] = []
  parts.push(NOTION_BOILERPLATE_HEADER + '.')
  const modelLabel = modelName || 'le mannequin'
  const bgLabel    = bgName    || 'le fond fourni'
  parts.push(
    `Photographie de mode professionnelle en PLAN RAPPROCHÉ / GROS PLAN sur un détail de vêtement (broderie, matière, fermeture, finition, accessoire) — détail montré en référence (fichier "${detailFile.name}"), porté par le mannequin "${modelLabel}" (référence en image fournie), devant le fond "${bgLabel}" (référence en image fournie).`,
  )
  parts.push(
    'Cadrage serré sur le détail, mise au point très précise sur la matière et le tombé, lumière qui révèle la texture, profondeur de champ très courte (f/2.0 ressenti), composition éditoriale.',
  )
  if (modelDesc) parts.push(`Note mannequin : ${modelDesc}.`)
  if (bgDesc)    parts.push(`Note fond : ${bgDesc}.`)
  if (notes)     parts.push(`Notes : ${notes}.`)
  parts.push(NOTION_BOILERPLATE_STYLE)
  return parts.join('\n\n')
}

function buildSomboDetailPromptWithBase(
  modelName: string, bgName: string, detailFile: File, notes: string,
): string {
  const parts: string[] = []
  parts.push(NOTION_BOILERPLATE_HEADER + '.')
  const modelLabel = modelName || 'le mannequin'
  const bgLabel    = bgName    || 'le fond fourni'
  parts.push(
    `Photographie de mode professionnelle en PLAN RAPPROCHÉ / GROS PLAN sur un détail du look déjà shooté (image complète montrée en référence #1 : le mannequin "${modelLabel}" porte la tenue complète devant le fond "${bgLabel}").`,
  )
  parts.push(
    `Le détail à mettre en valeur est précisément celui montré en référence #2 (fichier "${detailFile.name}") — broderie, matière, fermeture, finition ou accessoire spécifique.`,
  )
  parts.push(
    'Recadrer serré sur ce détail tel qu\'il apparaît dans le look déjà shooté : même mannequin, même tenue, même fond, même lumière. Mise au point très précise sur la matière et le tombé, profondeur de champ très courte (f/2.0 ressenti), texture révélée, composition éditoriale.',
  )
  if (notes) parts.push(`Notes : ${notes}.`)
  parts.push(NOTION_BOILERPLATE_STYLE)
  return parts.join('\n\n')
}

/* ============================== UTILS ============================== */

function findCsv(
  index: Map<string, File>, indexBase: Map<string, File>, names: string[],
): File | undefined {
  for (const n of names) {
    const f = index.get(n) ?? indexBase.get(n)
    if (f) return f
  }
  // Fallback : n'importe quel CSV qui commence par "visuals"
  for (const [path, file] of index.entries()) {
    if (path.toLowerCase().endsWith('.csv') && baseName(path).toLowerCase().startsWith('visuals')) {
      return file
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

function resolveSomboFileList(
  raw: string, index: Map<string, File>, indexBase: Map<string, File>,
): File[] {
  if (!raw) return []
  return raw
    .split(/[,;|]/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(p => {
      // 1) lookup direct sur le chemin complet
      const direct = index.get(p)
      if (direct) return direct
      // 2) lookup sur basename
      return indexBase.get(baseName(p))
    })
    .filter((f): f is File => !!f)
}

function baseName(path: string): string {
  const cleaned = path.replace(/\\/g, '/')
  const i = cleaned.lastIndexOf('/')
  return i >= 0 ? cleaned.slice(i + 1) : cleaned
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
    case 'json': return 'application/json'
    case 'txt':  return 'text/plain'
    default:     return 'application/octet-stream'
  }
}

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
