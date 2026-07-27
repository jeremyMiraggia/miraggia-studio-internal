/**
 * Parser Nature Morte — CSV Notion adaptatif.
 *
 * Colonnes attendues du CSV LOOK :
 *   ID, SKU, FILES (produits), REFERENCE (inspiration), Decors definition,
 *   Model, Description et commentaires
 *
 * Toutes les colonnes sauf ID/SKU/FILES sont optionnelles → le prompt Gemini
 * s'adapte selon ce qui est présent.
 */
import Papa from 'papaparse'
import { compressImage } from '@/lib/compressImage'
import { readZipIndex, extractEntry, getEntryDataOffset, type ZipEntry } from './zipReader'

export type NatureMorteTask = {
  id:            string
  sku:           string
  productFiles:  File[]      // FILES — produits (obligatoires)
  referenceFile?: File       // REFERENCE — image d'inspiration (optionnel)
  decorsFile?:   File        // Decors definition → Référence image (optionnel)
  modelBodyFile?: File       // Model → FRONT-model (optionnel)
  modelFaceFile?: File       // Model → FACE PHOTO (optionnel)
  modelName?:    string
  decorsName?:   string
  description?:  string
  warnings:      string[]
}

export type NatureMorteExport = {
  tasks:    NatureMorteTask[]
  warnings: string[]
}

export async function parseNatureMorteExport(
  zipFile: File,
  onProgress?: (msg: string) => void,
  range?: { start: number; end: number } | number,
): Promise<NatureMorteExport> {
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
      const sizeMB = Math.round(nestedEntry.size / (1024 * 1024))
      onProgress?.(`Décompression ZIP imbriqué (${sizeMB} MB)…`)
      workingFile = await extractEntry(zipFile, nestedEntry)
      zipIndex = await readZipIndex(workingFile)
    }
  }

  // Index basenames pour résoudre les refs de fichiers
  const baseToKey = new Map<string, string>()
  for (const key of zipIndex.keys()) baseToKey.set(baseName(key), key)

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

  const warnings: string[] = []

  // === Cherche les 3 CSVs ===
  const findCsvByPrefix = (prefixes: string[]): string | undefined => {
    for (const key of zipIndex.keys()) {
      const base = baseName(key).toLowerCase()
      if (!base.endsWith('.csv') || base.includes('_all.csv')) continue
      for (const p of prefixes) {
        if (base.startsWith(p.toLowerCase())) return key
      }
    }
    return undefined
  }
  const lookKey   = findCsvByPrefix(['LOOK', 'Look '])
  const modelsKey = findCsvByPrefix(['Models Definition', 'Models'])
  const decorsKey = findCsvByPrefix(['Decors definition', 'Decors Definition', 'Decors', 'Décors', 'Fonds'])

  if (!lookKey) throw new Error('CSV "LOOK …" introuvable dans le ZIP.')
  warnings.push(`📋 CSV trouvés : LOOK${modelsKey ? ' + Models' : ''}${decorsKey ? ' + Decors' : ''}`)

  const lookText   = await readCsvText(lookKey)
  const modelsText = modelsKey ? await readCsvText(modelsKey) : undefined
  const decorsText = decorsKey ? await readCsvText(decorsKey) : undefined

  // === Parse Models Definition ===
  const models = new Map<string, { name: string; bodyKey?: string; faceKey?: string }>()
  if (modelsText) {
    const rows = Papa.parse(modelsText.replace(/^﻿/, ''), { header: true, skipEmptyLines: true }).data as any[]
    for (const r of rows) {
      const name = String(r['Name your Model'] ?? r['Name'] ?? '').trim()
      if (!name) continue
      const bodyRef = decodeRef(String(r['FRONT-model'] ?? r['FRONT-Model'] ?? r['Body'] ?? '').trim())
      const faceRef = decodeRef(String(r['FACE PHOTO'] ?? r['FACE'] ?? r['Face'] ?? '').trim())
      models.set(normName(name), {
        name,
        bodyKey: bodyRef ? baseToKey.get(bodyRef) : undefined,
        faceKey: faceRef ? baseToKey.get(faceRef) : undefined,
      })
    }
  }

  // === Parse Decors Definition ===
  const decors = new Map<string, { name: string; imageKey?: string }>()
  if (decorsText) {
    const rows = Papa.parse(decorsText.replace(/^﻿/, ''), { header: true, skipEmptyLines: true }).data as any[]
    for (const r of rows) {
      // Nom du décor peut être "Name your Model" (copy-paste template) OU "Name your Background"
      const name = String(r['Name your Model'] ?? r['Name your Background'] ?? r['Name'] ?? '').trim()
      if (!name) continue
      const imgRef = decodeRef(String(r['Référence image'] ?? r['Reference image'] ?? r['Reference Image'] ?? r['File'] ?? '').trim())
      decors.set(normName(name), {
        name,
        imageKey: imgRef ? baseToKey.get(imgRef) : undefined,
      })
    }
  }

  // === Parse LOOK ===
  onProgress?.('Parsing des looks…')
  const lookRows = (Papa.parse(lookText!.replace(/^﻿/, ''), { header: true, skipEmptyLines: true }).data as any[])
  warnings.push(`📊 ${lookRows.length} ligne(s) LOOK.`)

  // Range
  let rangeStart: number | null = null
  let rangeEnd: number | null = null
  if (typeof range === 'number' && range > 0) { rangeStart = 1; rangeEnd = range }
  else if (range && typeof range === 'object' && range.start > 0 && range.end >= range.start) {
    rangeStart = range.start; rangeEnd = range.end
  }
  const filteredRows = (rangeStart !== null && rangeEnd !== null)
    ? lookRows.slice(rangeStart - 1, rangeEnd)
    : lookRows

  // Trouve les colonnes (insensible aux espaces/casse)
  const findCol = (row: any, candidates: string[]): string => {
    const headers = Object.keys(row)
    for (const c of candidates) {
      const m = headers.find(h => h.trim().toLowerCase() === c.toLowerCase())
      if (m) return m
    }
    for (const c of candidates) {
      const m = headers.find(h => h.trim().toLowerCase().includes(c.toLowerCase()))
      if (m) return m
    }
    return ''
  }
  if (filteredRows.length === 0) return { tasks: [], warnings }
  const idCol       = findCol(filteredRows[0], ['ID', 'Numero'])
  const skuCol      = findCol(filteredRows[0], ['SKU', 'Nom', 'Name'])
  const filesCol    = findCol(filteredRows[0], ['FILES'])
  const refCol      = findCol(filteredRows[0], ['REFERENCE', 'Reference'])
  const decorsCol   = findCol(filteredRows[0], ['Decors definition', 'Decors', 'Fond'])
  const modelCol    = findCol(filteredRows[0], ['Model', 'Mannequin'])
  const descCol     = findCol(filteredRows[0], ['Description et commentaires', 'Description', 'Commentaires'])

  const tasks: NatureMorteTask[] = []
  let idx = 0
  for (const row of filteredRows) {
    idx++
    if (onProgress && idx % 3 === 0) onProgress(`Extraction ${idx}/${filteredRows.length}…`)

    const id  = idCol  ? String(row[idCol]  ?? '').trim() : String(idx)
    const sku = skuCol ? String(row[skuCol] ?? '').trim() : `Look ${idx}`
    if (!id) continue

    const w: string[] = []

    // Produits (FILES) — obligatoire
    const filesRaw = filesCol ? String(row[filesCol] ?? '').trim() : ''
    const productFiles = await resolveFileList(filesRaw, baseToKey, extractAsFile)
    if (productFiles.length === 0) {
      w.push('Aucun produit trouvé dans FILES — visuel ignoré.')
      continue
    }

    // REFERENCE (image d'inspiration) — optionnel
    const refRaw = refCol ? String(row[refCol] ?? '').trim() : ''
    const refFiles = await resolveFileList(refRaw, baseToKey, extractAsFile)
    const referenceFile = refFiles[0]

    // Decors — optionnel
    let decorsFile: File | undefined
    let decorsName: string | undefined
    const decorsRaw = decorsCol ? stripRef(String(row[decorsCol] ?? '').trim()) : ''
    if (decorsRaw) {
      decorsName = decorsRaw
      const decorDef = decors.get(normName(decorsRaw))
      if (decorDef?.imageKey) decorsFile = await extractAsFile(decorDef.imageKey)
      else w.push(`Décor "${decorsRaw}" référencé mais pas trouvé dans Decors Definition.`)
    }

    // Model — optionnel
    let modelBodyFile: File | undefined
    let modelFaceFile: File | undefined
    let modelName: string | undefined
    const modelRaw = modelCol ? stripRef(String(row[modelCol] ?? '').trim()) : ''
    if (modelRaw) {
      modelName = modelRaw
      const modelDef = models.get(normName(modelRaw))
      if (modelDef) {
        if (modelDef.bodyKey) modelBodyFile = await extractAsFile(modelDef.bodyKey)
        if (modelDef.faceKey) modelFaceFile = await extractAsFile(modelDef.faceKey)
      } else {
        w.push(`Mannequin "${modelRaw}" référencé mais pas trouvé dans Models Definition.`)
      }
    }

    const description = descCol ? String(row[descCol] ?? '').trim() : ''

    tasks.push({
      id, sku,
      productFiles,
      referenceFile,
      decorsFile,
      modelBodyFile,
      modelFaceFile,
      modelName,
      decorsName,
      description: description || undefined,
      warnings: w,
    })
  }

  warnings.push(`✅ ${tasks.length} task(s) Nature Morte prêt(es).`)
  return { tasks, warnings }
}

/* ============================== helpers ============================== */

async function resolveFileList(
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
function stripRef(cell: string): string {
  if (!cell) return ''
  const trimmed = cell.trim()
  if (trimmed.endsWith('.md)')) {
    const i = trimmed.lastIndexOf(' (')
    if (i > 0) return trimmed.slice(0, i).trim()
  }
  return trimmed
}
function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}
