/**
 * Parser PAC — export Notion « PAC ».
 *
 * CSV LOOK (LIFESTYLE) : ID, IMAGE (photo avec un placeholder rouge ou blanc), PAC (relation → PAC Definition)
 * CSV PAC Definition   : Name your Model (= nom de la PAC), prompt (= photos de la PAC, séparées par des virgules)
 *
 * Une tâche = une ligne = une photo en sortie, identique avec la PAC posée sur le placeholder.
 * Les images ne sont extraites qu'à la demande (getFile, SANS compression : la sortie garde la taille d'origine).
 */
import Papa from 'papaparse'
import { readZipIndex, extractEntry, getEntryDataOffset, type ZipEntry } from './zipReader'

export type PacDef = { name: string; keys: string[] }
export type PacTask = { id: string; imageKey: string; imageName: string; pacName: string; pacKeys: string[]; warnings: string[] }
export type PacExport = {
  tasks: PacTask[]
  pacs: PacDef[]
  warnings: string[]
  /** Fichier brut du ZIP (aucune compression). */
  getFile: (key: string) => Promise<File | undefined>
}

export async function parsePacExport(zipFile: File, onProgress?: (msg: string) => void): Promise<PacExport> {
  onProgress?.('Lecture de l\'index du ZIP…')
  let zipIndex: Map<string, ZipEntry>
  try { zipIndex = await readZipIndex(zipFile) } catch (e: any) { throw new Error(`Lecture du ZIP impossible : ${e?.message ?? e}`) }

  // ZIP Notion imbriqué (Part-N.zip)
  let working: Blob = zipFile
  const nestedKey = [...zipIndex.keys()].find(k => /Part-\d+\.zip$/i.test(k))
  if (nestedKey) {
    const nested = zipIndex.get(nestedKey)!
    if (nested.method === 0) {
      const { dataOffset, csize } = await getEntryDataOffset(zipFile, nested)
      zipIndex = await readZipIndex(zipFile, { baseOffset: dataOffset, virtualSize: csize })
    } else {
      onProgress?.(`Décompression du ZIP imbriqué (${Math.round(nested.size / 1048576)} Mo)…`)
      working = await extractEntry(zipFile, nested)
      zipIndex = await readZipIndex(working)
    }
  }

  const baseToKey = new Map<string, string>()
  for (const key of zipIndex.keys()) baseToKey.set(baseName(key), key)

  const cache = new Map<string, Promise<File | undefined>>()
  const getFile = (key: string) => {
    let p = cache.get(key)
    if (!p) {
      p = (async () => {
        const entry = zipIndex.get(key)
        if (!entry) return undefined
        const blob = await extractEntry(working, entry)
        const base = baseName(key)
        return new File([blob], base, { type: guessMime(base) })
      })()
      cache.set(key, p)
    }
    return p
  }
  const readCsv = async (key: string) => {
    const entry = zipIndex.get(key)
    const text = entry ? await (await extractEntry(working, entry)).text() : ''
    return Papa.parse(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: true }).data as any[]
  }
  const findCsv = (prefixes: string[]) => {
    for (const key of zipIndex.keys()) {
      const b = norm(baseName(key))
      if (!b.endsWith('.csv') || b.includes('_all.csv')) continue
      if (prefixes.some(p => b.startsWith(norm(p)))) return key
    }
    return undefined
  }
  const col = (r: any, names: string[]) => {
    const keys = Object.keys(r)
    for (const n of names) {
      const k = keys.find(x => norm(x) === norm(n))
      if (k && String(r[k] ?? '').trim()) return String(r[k]).trim()
    }
    return ''
  }
  const files = (cell: string) => cell.split(',').map(s => decodeRef(s.trim())).filter(Boolean)

  const warnings: string[] = []
  const lookKey = findCsv(['LOOK', 'Look '])
  const pacKey = findCsv(['PAC Definition', 'PAC Definitions', 'PAC'])
  if (!lookKey) throw new Error('CSV « LOOK … » introuvable dans le ZIP.')
  if (!pacKey) throw new Error('CSV « PAC Definition » introuvable dans le ZIP.')

  // === PAC Definition ===
  const pacs: PacDef[] = []
  for (const r of await readCsv(pacKey)) {
    const name = col(r, ['Name your Model', 'Name your PAC', 'Name', 'Nom', 'PAC'])
    if (!name) continue
    const refs = files(col(r, ['prompt', 'Images', 'Image', 'Photos', 'PAC', 'Files']))
    const keys = refs.map(f => baseToKey.get(f)).filter(Boolean) as string[]
    for (const f of refs) if (!baseToKey.has(f)) warnings.push(`⚠ PAC « ${name} » : « ${f} » introuvable dans le ZIP.`)
    if (!keys.length) warnings.push(`ℹ PAC « ${name} » : aucune image.`)
    pacs.push({ name, keys })
  }

  // === LOOK ===
  onProgress?.('Lecture des lignes…')
  const tasks: PacTask[] = []
  let i = 0
  for (const r of await readCsv(lookKey)) {
    i++
    const id = col(r, ['ID', 'Numero']) || String(i)
    const imageRef = files(col(r, ['IMAGE', 'Image', 'Photo', 'FILES']))[0]
    const pacName = stripRef(col(r, ['PAC', 'PAC Definition', 'PAC Definitions']))
    if (!imageRef) { warnings.push(`⚠ Ligne ${id} : colonne IMAGE vide — ignorée.`); continue }
    const imageKey = baseToKey.get(imageRef)
    if (!imageKey) { warnings.push(`⚠ Ligne ${id} : « ${imageRef} » introuvable dans le ZIP — ignorée.`); continue }
    const pac = pacs.find(p => norm(p.name) === norm(pacName))
    const w: string[] = []
    if (!pacName) w.push('colonne PAC vide')
    else if (!pac) w.push(`PAC « ${pacName} » absente de PAC Definition`)
    else if (!pac.keys.length) w.push(`PAC « ${pacName} » sans image`)
    tasks.push({ id, imageKey, imageName: baseName(imageKey), pacName, pacKeys: pac?.keys ?? [], warnings: w })
  }
  const ok = tasks.filter(t => t.pacKeys.length).length
  warnings.push(`✅ ${tasks.length} image(s), ${ok} avec une PAC exploitable, ${pacs.length} PAC définie(s).`)
  return { tasks, pacs, warnings, getFile }
}

function baseName(p: string) { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(i + 1) : p }
function norm(s: string) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim() }
function decodeRef(raw: string) { try { return decodeURIComponent(raw.replace(/\+/g, '%20')) } catch { return raw } }
/** "PAC 1 (PAC%201%20df32….md)" → "PAC 1" */
function stripRef(cell: string) {
  const t = cell.trim()
  if (t.endsWith('.md)')) { const k = t.lastIndexOf(' ('); if (k > 0) return t.slice(0, k).trim() }
  return t
}
function guessMime(name: string) {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream'
}
