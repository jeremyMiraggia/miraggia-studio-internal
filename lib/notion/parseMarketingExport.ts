/**
 * Parser « Marketing assets » — export Notion à 4 colonnes :
 *   1. Dossier                  → sous-dossier de téléchargement du visuel
 *   2. Mannequin(s)             → nom(s) du catalogue Miraggia (« Garance + Robin » pour un duo) ;
 *                                  vide, « — (produit) » ou nom inconnu = visuel PRODUIT
 *   3. Vêtements et produits    → fichiers : tenue des mannequins, ou le produit
 *   4. Prompt                   → envoyé tel quel à l'IA (Gemini ou ChatGPT)
 * Les noms de colonnes sont reconnus sans casse ni accents ; à défaut, l'ordre des colonnes fait foi.
 */
import Papa from 'papaparse'
import { readZipIndex, extractEntry, getEntryDataOffset, type ZipEntry } from './zipReader'

export type MarketingRow = {
  index: number           // n° de ligne (1…)
  folder: string
  modelNames: string[]    // noms tels qu'écrits (le rapprochement catalogue se fait dans l'onglet)
  productLike: boolean    // « — (produit) », « produit », vide…
  fileKeys: string[]
  missingFiles: string[]
  prompt: string
}
export type MarketingExport = {
  rows: MarketingRow[]
  warnings: string[]
  getFile: (key: string) => Promise<File | undefined>
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

export async function parseMarketingExport(zipFile: File, onProgress?: (m: string) => void): Promise<MarketingExport> {
  onProgress?.('Lecture de l\'index du ZIP…')
  let zipIndex: Map<string, ZipEntry>
  try { zipIndex = await readZipIndex(zipFile) } catch (e: any) { throw new Error(`Lecture du ZIP impossible : ${e?.message ?? e}`) }
  let working: Blob = zipFile
  const nestedKey = [...zipIndex.keys()].find(k => /Part-\d+\.zip$/i.test(k))
  if (nestedKey) {
    const nested = zipIndex.get(nestedKey)!
    if (nested.method === 0) {
      const { dataOffset, csize } = await getEntryDataOffset(zipFile, nested)
      zipIndex = await readZipIndex(zipFile, { baseOffset: dataOffset, virtualSize: csize })
    } else {
      onProgress?.('Décompression du ZIP imbriqué…')
      working = await extractEntry(zipFile, nested)
      zipIndex = await readZipIndex(working)
    }
  }
  const base = (k: string) => k.slice(k.lastIndexOf('/') + 1)
  const baseToKey = new Map<string, string>()
  for (const k of zipIndex.keys()) baseToKey.set(base(k), k)

  const cache = new Map<string, Promise<File | undefined>>()
  const getFile = (key: string) => {
    let p = cache.get(key)
    if (!p) {
      p = (async () => {
        const entry = zipIndex.get(key)
        if (!entry) return undefined
        const b = base(key), ext = b.toLowerCase().split('.').pop() ?? ''
        const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream'
        return new File([await extractEntry(working, entry)], b, { type })
      })()
      cache.set(key, p)
    }
    return p
  }

  // CSV principal = celui dont les en-têtes contiennent une colonne « Prompt »
  const warnings: string[] = []
  let rowsRaw: any[] = [], headers: string[] = []
  for (const key of zipIndex.keys()) {
    const b = base(key).toLowerCase()
    if (!b.endsWith('.csv') || b.includes('_all.csv')) continue
    const text = (await (await extractEntry(working, zipIndex.get(key)!)).text()).replace(/^﻿/, '')
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true })
    const h = parsed.meta.fields ?? []
    if (h.some(x => norm(x) === 'prompt')) { rowsRaw = parsed.data as any[]; headers = h; warnings.push(`📋 Table : « ${base(key).replace(/ [0-9a-f]{32}\.csv$/i, '')} »`); break }
  }
  if (!headers.length) throw new Error('Aucun CSV avec une colonne « Prompt » dans le ZIP.')

  const pick = (cands: string[], fallbackIdx: number) =>
    headers.find(h => cands.some(c => norm(h) === norm(c))) ?? headers.find(h => cands.some(c => norm(h).includes(norm(c)))) ?? headers[fallbackIdx] ?? ''
  const colFolder = pick(['Dossier', 'Folder'], 0)
  const colModels = pick(['Mannequin(s)', 'Mannequins', 'Mannequin', 'Model', 'Models'], 1)
  const colFiles  = pick(['Vetements et produits', 'Vêtements et produits', 'Vetements', 'Produits', 'Fichiers', 'FILES'], 2)
  const colPrompt = pick(['Prompt'], 3)
  warnings.push(`🧭 Colonnes : dossier = « ${colFolder} », mannequins = « ${colModels} », fichiers = « ${colFiles} », prompt = « ${colPrompt} »`)

  const rows: MarketingRow[] = []
  let n = 0
  for (const r of rowsRaw) {
    const prompt = String(r[colPrompt] ?? '').trim()
    if (!prompt) continue
    n++
    const modelsRaw = String(r[colModels] ?? '').trim()
    const productLike = !modelsRaw || /^[—–-]|produit|product|\bnone\b|aucun/i.test(modelsRaw)
    const modelNames = productLike ? [] : modelsRaw.split(/\s*(?:\+|&|,|\/|\bet\b|\band\b)\s*/i).map(s => s.replace(/\s*\(.*\.md\)\s*$/, '').trim()).filter(Boolean)
    const refs = String(r[colFiles] ?? '').split(',').map(s => { try { return decodeURIComponent(s.trim()) } catch { return s.trim() } }).filter(Boolean)
    rows.push({
      index: n,
      folder: String(r[colFolder] ?? '').trim() || 'SANS DOSSIER',
      modelNames, productLike,
      fileKeys: refs.map(f => baseToKey.get(f)).filter(Boolean) as string[],
      missingFiles: refs.filter(f => !baseToKey.has(f)),
      prompt,
    })
  }
  const folders = new Set(rows.map(r => r.folder))
  warnings.push(`✅ ${rows.length} visuel(s) dans ${folders.size} dossier(s).`)
  return { rows, warnings, getFile }
}
