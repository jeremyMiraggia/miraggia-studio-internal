/**
 * Onglet 🎁 Brief + instructions : lit n'importe quel ZIP (export Notion simple ou imbriqué, dossier zippé…)
 * et un fichier d'instructions JSON. Le ZIP ne fournit QUE les images ; tout le reste est dans le JSON.
 */
import { readZipIndex, extractEntry, getEntryDataOffset, type ZipEntry } from './zipReader'

export type PackImage = { file: string; role: string }
export type PackItem = {
  id: string
  sku: string
  formats: string[]                       // 1er = format à valider en premier (modifiable dans l'onglet)
  images: PackImage[]                     // envoyées dans cet ordre : IMAGE 1, IMAGE 2…
  prompt: string                          // {{1}}, {{2}}… = rang dans « images »
  formatNotes?: Record<string, string>    // cadrage propre à chaque format
  brief?: string                          // commentaire du client (affichage)
  alerts?: string[]                       // points à vérifier (affichage)
}
export type PackInstructions = { project: string; rules?: string; items: PackItem[] }

const RATIOS = new Set(['4:5', '3:4', '2:3', '9:16', '1:1', '16:9', '3:2', '4:3', '5:4', '21:9'])

export function parseInstructions(text: string): PackInstructions {
  let j: any
  try { j = JSON.parse(text.replace(/^﻿/, '')) } catch (e: any) { throw new Error(`Fichier d'instructions illisible (JSON) : ${e?.message ?? e}`) }
  if (!Array.isArray(j?.items) || !j.items.length) throw new Error('Fichier d\'instructions : liste « items » absente ou vide.')
  const ids = new Set<string>()
  const items: PackItem[] = j.items.map((it: any, n: number) => {
    const name = it?.sku || it?.id || `n°${n + 1}`
    const id = String(it?.id ?? n + 1)
    if (ids.has(id)) throw new Error(`Instructions : identifiant « ${id} » en double.`)
    ids.add(id)
    if (typeof it?.prompt !== 'string' || !it.prompt.trim()) throw new Error(`Instructions : prompt manquant pour « ${name} ».`)
    const formats: string[] = Array.isArray(it.formats) ? [...new Set<string>(it.formats.map(String))] : []
    if (!formats.length || formats.some(f => !RATIOS.has(f))) throw new Error(`Instructions : format absent ou inconnu pour « ${name} » (${formats.join(', ') || 'vide'}).`)
    const images: PackImage[] = (Array.isArray(it.images) ? it.images : []).map((im: any) => ({ file: String(im?.file ?? ''), role: String(im?.role ?? '') }))
    if (images.some(im => !im.file)) throw new Error(`Instructions : nom de fichier manquant pour « ${name} ».`)
    return { id, sku: String(it.sku ?? id), formats, images, prompt: it.prompt.trim(), formatNotes: it.formatNotes ?? {}, brief: it.brief, alerts: Array.isArray(it.alerts) ? it.alerts.map(String) : [] }
  })
  return { project: String(j.project ?? 'projet'), rules: j.rules ? String(j.rules) : undefined, items }
}

export type PackZip = { has: (name: string) => boolean; getFile: (name: string) => Promise<File | undefined> }

export async function openPackZip(zipFile: File): Promise<PackZip> {
  let index: Map<string, ZipEntry>
  try { index = await readZipIndex(zipFile) } catch (e: any) { throw new Error(`Lecture du ZIP impossible : ${e?.message ?? e}`) }
  let working: Blob = zipFile
  const nestedKey = [...index.keys()].find(k => /Part-\d+\.zip$/i.test(k))
  if (nestedKey) {
    const nested = index.get(nestedKey)!
    if (nested.method === 0) {
      const { dataOffset, csize } = await getEntryDataOffset(zipFile, nested)
      index = await readZipIndex(zipFile, { baseOffset: dataOffset, virtualSize: csize })
    } else {
      working = await extractEntry(zipFile, nested)
      index = await readZipIndex(working)
    }
  }
  const norm = (s: string) => s.normalize('NFC')
  const byName = new Map<string, string>()
  for (const k of index.keys()) { byName.set(norm(k.slice(k.lastIndexOf('/') + 1)), k); byName.set(norm(k), k) }

  const cache = new Map<string, Promise<File | undefined>>()
  const getFile = (name: string) => {
    let p = cache.get(name)
    if (!p) {
      p = (async () => {
        const key = byName.get(norm(name))
        if (!key) return undefined
        return toWebImage(new File([await extractEntry(working, index.get(key)!)], name.slice(name.lastIndexOf('/') + 1)))
      })()
      p.catch(() => cache.delete(name))
      cache.set(name, p)
    }
    return p
  }
  return { has: n => byName.has(norm(n)), getFile }
}

/** HEIC (iPhone) → JPEG dans le navigateur ; sinon type MIME déduit de l'extension. */
export async function toWebImage(file: File): Promise<File> {
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'heic' || ext === 'heif') {
    const { heicTo } = await import('heic-to')
    const jpg = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.92 })
    return new File([jpg], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' })
  }
  const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : file.type || 'application/octet-stream'
  return new File([file], file.name, { type })
}
