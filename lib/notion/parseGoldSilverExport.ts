/**
 * Parser Gold&Silver — export Notion "Lookbook Lifestyle".
 *
 * CSV LOOK (LIFESTYLE) : ID, SKU, FILES (FRONT), FILES (BACK), DETAILS, Model, Décor, REFERENCE
 *   → 1 task par VUE présente (front / back / details). L'image de la vue = l'outfit porté.
 * CSV Models Definition : Name your Model, FACE PHOTO, FRONT-model
 * CSV Decors Definition : Name your Model (ou Name…), Decor Description (texte = bloc de prompt)
 *
 * Les colonnes Model et Décor du LOOK sont optionnelles : l'onglet fournit un
 * mannequin et un décor par défaut. Les images ne sont extraites qu'à la demande
 * (getFile) pour ne pas charger tout le ZIP en mémoire.
 */
import Papa from 'papaparse'
import { compressImage } from '@/lib/compressImage'
import { readZipIndex, extractEntry, getEntryDataOffset, type ZipEntry } from './zipReader'

export type GSView = 'front' | 'back' | 'details'

export type GSModel = { name: string; faceKey?: string; bodyKey?: string }
export type GSDecor = { name: string; description: string }

export type GSTask = {
  id:         string      // `${lookId}-${view}`
  lookId:     string
  sku:        string
  view:       GSView
  outfitKey:  string      // clé ZIP de l'image de la vue
  modelName?: string      // colonne Model du LOOK (peut être vide)
  decorName?: string      // colonne Décor du LOOK (peut être vide)
  warnings:   string[]
}

export type GSExport = {
  tasks:    GSTask[]
  models:   GSModel[]
  decors:   GSDecor[]
  warnings: string[]
  /** Extrait un fichier du ZIP par clé (compressé si image > 1.5 MB). */
  getFile:  (key: string) => Promise<File | undefined>
}

export async function parseGoldSilverExport(
  zipFile: File,
  onProgress?: (msg: string) => void,
): Promise<GSExport> {
  onProgress?.('Lecture de l\'index du ZIP…')
  let zipIndex: Map<string, ZipEntry>
  try {
    zipIndex = await readZipIndex(zipFile)
  } catch (e: any) {
    throw new Error(`Lecture du ZIP impossible : ${e?.message ?? e}`)
  }

  // Double-zip Notion imbriqué
  let workingFile: Blob = zipFile
  const nestedKey = [...zipIndex.keys()].find(k => /Part-\d+\.zip$/i.test(k))
  if (nestedKey) {
    const nestedEntry = zipIndex.get(nestedKey)!
    if (nestedEntry.method === 0) {
      const { dataOffset, csize } = await getEntryDataOffset(zipFile, nestedEntry)
      zipIndex = await readZipIndex(zipFile, { baseOffset: dataOffset, virtualSize: csize })
    } else {
      onProgress?.(`Décompression ZIP imbriqué (${Math.round(nestedEntry.size / 1048576)} MB)…`)
      workingFile = await extractEntry(zipFile, nestedEntry)
      zipIndex = await readZipIndex(workingFile)
    }
  }

  const baseToKey = new Map<string, string>()
  for (const key of zipIndex.keys()) baseToKey.set(baseName(key), key)

  const fileCache = new Map<string, Promise<File | undefined>>()
  const getFile = (key: string): Promise<File | undefined> => {
    let p = fileCache.get(key)
    if (!p) {
      p = (async () => {
        const entry = zipIndex.get(key)
        if (!entry) return undefined
        const blob = await extractEntry(workingFile, entry)
        const base = baseName(key)
        const mime = guessMime(base)
        let file = new File([blob], base, { type: mime })
        if (mime.startsWith('image/') && file.size > 1_500_000) {
          try { file = await compressImage(file, { maxSide: 2048, quality: 0.88 }) } catch { /* brut */ }
        }
        return file
      })()
      fileCache.set(key, p)
    }
    return p
  }
  const readCsvText = async (key: string): Promise<string | undefined> => {
    const entry = zipIndex.get(key)
    if (!entry) return undefined
    return await (await extractEntry(workingFile, entry)).text()
  }

  const warnings: string[] = []

  const findCsvByPrefix = (prefixes: string[]): string | undefined => {
    for (const key of zipIndex.keys()) {
      const base = baseName(key).toLowerCase()
      if (!base.endsWith('.csv') || base.includes('_all.csv')) continue
      for (const p of prefixes) if (base.startsWith(p.toLowerCase())) return key
    }
    return undefined
  }
  const lookKey   = findCsvByPrefix(['LOOK', 'Look '])
  const modelsKey = findCsvByPrefix(['Models Definition', 'Models'])
  const decorsKey = findCsvByPrefix(['Decors Definition', 'Decors definition', 'Decors', 'Décors'])
  if (!lookKey) throw new Error('CSV "LOOK …" introuvable dans le ZIP.')
  warnings.push(`📋 CSV : LOOK${modelsKey ? ' + Models' : ' (⚠ pas de Models Definition)'}${decorsKey ? ' + Decors' : ' (⚠ pas de Decors Definition)'}`)

  const parseCsv = (text: string) =>
    Papa.parse(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: true }).data as any[]

  // === Models ===
  const models: GSModel[] = []
  if (modelsKey) {
    for (const r of parseCsv((await readCsvText(modelsKey)) ?? '')) {
      const name = String(r['Name your Model'] ?? r['Name'] ?? '').trim()
      if (!name) continue
      const faceRef = decodeRef(String(r['FACE PHOTO'] ?? r['FACE'] ?? r['Face'] ?? '').trim())
      const bodyRef = decodeRef(String(r['FRONT-model'] ?? r['FRONT-Model'] ?? r['Body'] ?? '').trim())
      const m: GSModel = { name, faceKey: faceRef ? baseToKey.get(faceRef) : undefined, bodyKey: bodyRef ? baseToKey.get(bodyRef) : undefined }
      if (!m.faceKey) warnings.push(`⚠ Mannequin "${name}" : FACE PHOTO introuvable dans le ZIP.`)
      models.push(m)
    }
  }

  // === Decors (texte) ===
  const decors: GSDecor[] = []
  if (decorsKey) {
    for (const r of parseCsv((await readCsvText(decorsKey)) ?? '')) {
      const name = String(r['Name your Model'] ?? r['Name your Decor'] ?? r['Name your Background'] ?? r['Name'] ?? '').trim()
      if (!name) continue
      const description = String(r['Decor Description'] ?? r['Description'] ?? r['Prompt'] ?? '').trim()
      if (!description) { warnings.push(`⚠ Décor "${name}" : description vide — ignoré.`); continue }
      decors.push({ name, description })
    }
  }

  // === LOOK ===
  onProgress?.('Parsing des looks…')
  const rows = parseCsv((await readCsvText(lookKey)) ?? '')
  warnings.push(`📊 ${rows.length} ligne(s) LOOK.`)
  if (rows.length === 0) return { tasks: [], models, decors, warnings, getFile }

  const headers = Object.keys(rows[0])
  const findCol = (candidates: string[], exclude: string[] = []): string => {
    const ok = (h: string) => !exclude.some(x => h.toLowerCase().includes(x.toLowerCase()))
    for (const c of candidates) {
      const m = headers.find(h => ok(h) && h.trim().toLowerCase() === c.toLowerCase())
      if (m) return m
    }
    for (const c of candidates) {
      const m = headers.find(h => ok(h) && h.trim().toLowerCase().includes(c.toLowerCase()))
      if (m) return m
    }
    return ''
  }
  const idCol      = findCol(['ID', 'Numero'])
  const skuCol     = findCol(['SKU', 'Nom', 'Name'])
  const frontCol   = findCol(['FILES (FRONT)', 'FRONT'], ['model'])
  const backCol    = findCol(['FILES (BACK)', 'BACK'])
  const detailsCol = findCol(['DETAILS', 'DETAIL'])
  const modelCol   = findCol(['Model', 'Mannequin'], ['front-model'])
  const decorCol   = findCol(['Décor', 'Decor', 'Decors definition', 'Decors Definition', 'Fond'])
  warnings.push(`🧭 Colonnes : front="${frontCol || '—'}" back="${backCol || '—'}" details="${detailsCol || '—'}" model="${modelCol || '—'}" décor="${decorCol || '—'}"`)

  const tasks: GSTask[] = []
  let idx = 0
  for (const row of rows) {
    idx++
    const lookId = idCol ? String(row[idCol] ?? '').trim() : String(idx)
    const sku    = skuCol ? String(row[skuCol] ?? '').trim() : `Look ${idx}`
    if (!lookId && !sku) continue
    const modelName = modelCol ? stripRef(String(row[modelCol] ?? '').trim()) || undefined : undefined
    const decorName = decorCol ? stripRef(String(row[decorCol] ?? '').trim()) || undefined : undefined

    const views: Array<[GSView, string]> = [
      ['front',   frontCol   ? String(row[frontCol]   ?? '').trim() : ''],
      ['back',    backCol    ? String(row[backCol]    ?? '').trim() : ''],
      ['details', detailsCol ? String(row[detailsCol] ?? '').trim() : ''],
    ]
    let found = 0
    for (const [view, raw] of views) {
      if (!raw) continue
      // une cellule peut contenir plusieurs fichiers séparés par des virgules → on prend le premier
      const first = decodeRef(raw.split(',')[0].trim())
      const key = baseToKey.get(first)
      if (!key) { warnings.push(`⚠ Look ${lookId} (${sku}) vue ${view} : "${first}" introuvable dans le ZIP.`); continue }
      const w: string[] = []
      if (!modelName) w.push('Colonne Model vide.')
      else if (!models.some(m => normName(m.name) === normName(modelName))) w.push(`Mannequin "${modelName}" absent de Models Definition.`)
      if (!decorName) w.push('Colonne Décor vide.')
      else if (!decors.some(d => normName(d.name) === normName(decorName))) w.push(`Décor "${decorName}" absent de Decors Definition.`)
      tasks.push({ id: `${lookId}-${view}`, lookId, sku, view, outfitKey: key, modelName, decorName, warnings: w })
      found++
    }
    if (found === 0) warnings.push(`⚠ Look ${lookId} (${sku}) : aucune vue (FRONT/BACK/DETAILS) — ignoré.`)
  }

  const incomplete = tasks.filter(t => t.warnings.length > 0).length
  warnings.push(`✅ ${tasks.length} visuel(s), ${models.length} mannequin(s), ${decors.length} décor(s).${incomplete ? ` ⚠ ${incomplete} visuel(s) sans mannequin/décor valide — ils seront ignorés.` : ''}`)
  return { tasks, models, decors, warnings, getFile }
}

/* ============================== helpers ============================== */

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
    case 'heic': return 'image/heic'
    default:     return 'application/octet-stream'
  }
}
function decodeRef(raw: string): string {
  if (!raw) return ''
  try { return decodeURIComponent(raw.replace(/\+/g, '%20')) } catch { return raw }
}
/** "LOUISE (LOUISE%20e8c2….md)" → "LOUISE" */
function stripRef(cell: string): string {
  if (!cell) return ''
  const trimmed = cell.trim()
  if (trimmed.endsWith('.md)')) {
    const i = trimmed.lastIndexOf(' (')
    if (i > 0) return trimmed.slice(0, i).trim()
  }
  return trimmed
}
export function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}
