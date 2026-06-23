/**
 * Parser pour l'onglet Ghost : transforme un ZIP Notion contenant des produits
 * (photos iPhone + descriptions) en une liste de tâches de packshot.
 *
 * Structure du CSV Notion attendue (colonnes) :
 *   ID, Texte (= SKU), Fond, FILES (FRONT), FILES (BACK), DESCRIPTION, Propriété
 *
 * Chaque ligne = un produit. FILES (FRONT) et FILES (BACK) peuvent contenir
 * plusieurs noms d'image séparés par ", ".
 *
 * On extrait les images via OPFS streaming pour supporter de gros ZIPs.
 */
import Papa from 'papaparse'
import { compressImage } from '@/lib/compressImage'
import { readZipIndex, extractEntry, getEntryDataOffset, type ZipEntry } from './zipReader'

export type GhostProduct = {
  id:          string
  sku:         string         // ex "CHAUSSETTE-MM_U635_1"
  description: string         // colonne DESCRIPTION (peut être vide)
  notes:       string         // colonne Propriété (instructions spéciales)
  fondName:    string         // ex "Studio"
  frontFiles:  File[]
  backFiles:   File[]
  warnings:    string[]
}

export type GhostExport = {
  products: GhostProduct[]
  warnings: string[]
}

export async function parseGhostExport(
  zipFile: File,
  onProgress?: (msg: string) => void,
  range?: { start: number; end: number } | number,
): Promise<GhostExport> {
  onProgress?.('Lecture de l\'index du ZIP…')
  let zipIndex: Map<string, ZipEntry>
  try {
    zipIndex = await readZipIndex(zipFile)
  } catch (e: any) {
    throw new Error(`Lecture du ZIP impossible : ${e?.message ?? e}`)
  }

  // Double-zip Notion (Part-1.zip imbriqué)
  let workingFile: Blob = zipFile
  const nestedKey = [...zipIndex.keys()].find(k => /Part-\d+\.zip$/i.test(k))
  if (nestedKey) {
    try {
      const nestedEntry = zipIndex.get(nestedKey)!
      if (nestedEntry.method === 0) {
        onProgress?.('Lecture du ZIP imbriqué (offset)…')
        const { dataOffset, csize } = await getEntryDataOffset(zipFile, nestedEntry)
        zipIndex = await readZipIndex(zipFile, { baseOffset: dataOffset, virtualSize: csize })
      } else {
        const sizeMB = Math.round(nestedEntry.size / (1024 * 1024))
        onProgress?.(`Décompression du ZIP imbriqué (${sizeMB} MB)…`)
        workingFile = await extractEntry(zipFile, nestedEntry)
        zipIndex = await readZipIndex(workingFile)
      }
    } catch (e: any) {
      throw new Error(`Lecture du ZIP imbriqué : ${e?.message ?? e}`)
    }
  }

  // Index basenames pour résolution des refs
  const baseToKey = new Map<string, string>()
  for (const key of zipIndex.keys()) {
    baseToKey.set(baseName(key), key)
  }

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
  const products: GhostProduct[] = []

  // Cherche le CSV principal (= contient "FILES" ou "FRONT" dans son header).
  // Évite les "_all.csv" qui sont des doublons Notion.
  const candidateCsvKeys = [...zipIndex.keys()].filter(k => {
    const base = baseName(k).toLowerCase()
    return base.endsWith('.csv') && !base.includes('_all.csv')
  })

  let csvKey: string | undefined
  let csvText: string | undefined
  for (const k of candidateCsvKeys) {
    const text = await readCsvText(k)
    if (!text) continue
    const head = text.slice(0, 500).toLowerCase()
    if (head.includes('files') || head.includes('front') || head.includes('texte')) {
      csvKey = k
      csvText = text
      break
    }
  }
  // Fallback : prend le premier CSV avec plus de 2 lignes
  if (!csvKey && candidateCsvKeys.length > 0) {
    for (const k of candidateCsvKeys) {
      const text = await readCsvText(k)
      if (text && text.split('\n').length >= 2) {
        csvKey = k
        csvText = text
        break
      }
    }
  }

  if (!csvKey || !csvText) {
    throw new Error('Aucun CSV produit trouvé dans le ZIP. Format Notion attendu : un CSV avec colonnes Texte/FILES.')
  }

  onProgress?.('Lecture du CSV produits…')
  const rows = (Papa.parse(csvText.replace(/^﻿/, ''), { header: true, skipEmptyLines: true }).data as any[])
  warnings.push(`📋 CSV "${baseName(csvKey)}" : ${rows.length} ligne(s).`)
  if (rows.length === 0) return { products: [], warnings }

  // Mapping souple des colonnes (insensible à la casse / aux espaces)
  const findColumn = (row: any, candidates: string[]): string => {
    const headers = Object.keys(row)
    for (const c of candidates) {
      const exact = headers.find(h => h.trim().toLowerCase() === c.toLowerCase())
      if (exact) return exact
    }
    for (const c of candidates) {
      const partial = headers.find(h => h.toLowerCase().includes(c.toLowerCase()))
      if (partial) return partial
    }
    return ''
  }

  const idCol      = findColumn(rows[0], ['ID', 'Id', 'Numero'])
  const skuCol     = findColumn(rows[0], ['Texte', 'SKU', 'Reference', 'Name', 'Nom'])
  const fondCol    = findColumn(rows[0], ['Fond', 'Background'])
  const frontCol   = findColumn(rows[0], ['FILES (FRONT)', 'FRONT', 'Front'])
  const backCol    = findColumn(rows[0], ['FILES (BACK)', 'BACK', 'Back'])
  const descCol    = findColumn(rows[0], ['DESCRIPTION', 'Description', 'Desc'])
  const notesCol   = findColumn(rows[0], ['Propriété', 'Propriete', 'Notes', 'Property'])

  warnings.push(`🔍 Colonnes : sku=${skuCol || '(none)'}, front=${frontCol || '(none)'}, back=${backCol || '(none)'}, desc=${descCol || '(none)'}, notes=${notesCol || '(none)'}`)

  // Range : permet de limiter le nombre de produits à traiter
  let rangeStart: number | null = null
  let rangeEnd: number | null = null
  if (typeof range === 'number' && range > 0) { rangeStart = 1; rangeEnd = range }
  else if (range && typeof range === 'object' && range.start > 0 && range.end >= range.start) {
    rangeStart = range.start; rangeEnd = range.end
  }
  const filteredRows = (rangeStart !== null && rangeEnd !== null)
    ? rows.slice(rangeStart - 1, rangeEnd)
    : rows
  if (rangeStart !== null && rangeEnd !== null) {
    warnings.push(`Limité aux lignes ${rangeStart}-${rangeEnd} (sur ${rows.length}).`)
  }

  let idx = 0
  for (const row of filteredRows) {
    idx++
    if (onProgress && idx % 3 === 0) onProgress(`Extraction produit ${idx}/${filteredRows.length}…`)

    const id = idCol ? String(row[idCol] ?? '').trim() : String(idx)
    const sku = skuCol ? String(row[skuCol] ?? '').trim() : `Produit ${idx}`
    const fondRaw = fondCol ? String(row[fondCol] ?? '').trim() : ''
    // "Studio (Studio%2000xxxxx.md)" → "Studio"
    const fondName = fondRaw.split('(')[0].trim()
    const description = descCol ? String(row[descCol] ?? '').trim() : ''
    const notes = notesCol ? String(row[notesCol] ?? '').trim() : ''

    const frontRaw = frontCol ? String(row[frontCol] ?? '').trim() : ''
    const backRaw  = backCol  ? String(row[backCol]  ?? '').trim() : ''
    const frontFiles = await resolveFileListLazy(frontRaw, baseToKey, extractAsFile)
    const backFiles  = await resolveFileListLazy(backRaw,  baseToKey, extractAsFile)

    if (frontFiles.length === 0 && backFiles.length === 0 && !sku) continue

    const w: string[] = []
    if (frontFiles.length === 0 && backFiles.length === 0) {
      w.push('Aucune image trouvée pour ce produit.')
    }

    products.push({
      id, sku, description, notes, fondName,
      frontFiles, backFiles,
      warnings: w,
    })
  }

  warnings.push(`✅ ${products.length} produit(s) extrait(s).`)
  return { products, warnings }
}

/* ============================== utils ============================== */

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
    case 'csv':  return 'text/csv'
    case 'md':   return 'text/markdown'
    case 'txt':  return 'text/plain'
    default:     return 'application/octet-stream'
  }
}

function decodeRef(raw: string): string {
  if (!raw) return ''
  try { return decodeURIComponent(raw.replace(/\+/g, '%20')) }
  catch { return raw }
}

/**
 * Construit le prompt packshot envoyé à Gemini pour un produit donné.
 * Le prompt est centré sur : fond blanc neutre, packshot piqué, e-commerce style.
 */
export function buildGhostPrompt(p: GhostProduct, viewLabel: 'front' | 'back' = 'front'): string {
  const parts: string[] = []
  parts.push(
    `Create a high-quality professional product PACKSHOT for e-commerce / catalogue use.`,
  )
  parts.push(
    `BACKGROUND : pure WHITE (#FFFFFF), perfectly clean, no texture, no gradient, no shadows on the background itself.`,
  )
  parts.push(
    `Subtle soft contact shadow only directly underneath the product (very light, professional).`,
  )
  parts.push(
    `Sharpness : extremely SHARP and crisp focus on the entire product (very "piqué"). Every detail of the fabric/material/stitching must be perfectly visible.`,
  )
  parts.push(
    `Studio lighting : soft, even, diffuse — no harsh highlights, no overexposure, no underexposed shadows. Colours of the product must be faithful to the reference.`,
  )
  parts.push(
    `Composition : product perfectly centered with comfortable margins on all sides. Professional e-commerce style.`,
  )
  parts.push(
    `View : ${viewLabel === 'back' ? 'BACK view of the product' : 'FRONT view of the product'}.`,
  )
  parts.push(
    `⚠ CRITICAL : reproduce the EXACT same product as shown in the reference photo. Do NOT invent variations, do NOT change colours, materials, or shapes. The reference photos are taken with an iPhone — improve only lighting/background/sharpness, keep the product identical.`,
  )

  if (p.sku) parts.push(`Product reference (SKU) : ${p.sku}.`)
  if (p.description) parts.push(`Product description : ${p.description}.`)
  if (p.notes) parts.push(`Special instructions : ${p.notes}.`)

  return parts.join(' ')
}
