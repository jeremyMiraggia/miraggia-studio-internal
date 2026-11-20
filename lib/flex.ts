/**
 * 🧩 FLEX — n'importe quel ZIP Notion (export « Markdown & CSV ») → diagnostic → recette → visuels.
 *
 *  1. ouvrirZipNotion   : index du ZIP (ZIP imbriqué Part-1.zip compris), sans tout charger en RAM
 *  2. diagnostiquer     : tables (CSV), colonnes typées (fichiers, lien, pose, texte long, texte), problèmes
 *  3. Recette           : table principale, colonnes de poses (1 ligne = 1 visuel par pose remplie, sinon 1),
 *                         images envoyées (rôle + source), textes ajoutés, prompt artistique à variables, nom de sortie
 *  4. construireVisuels : liste des visuels à générer, avec images (noms de fichiers ZIP / catalogue) et prompt final
 */
import Papa from 'papaparse'
import { readZipIndex, extractEntry, getEntryDataOffset, type ZipEntry } from '@/lib/notion/zipReader'
import { parsePoseCell, poseToPrompt } from '@/lib/poses'

/* ============================== ZIP ============================== */

export type NotionZip = {
  name: string
  keys: string[]
  byBase: Map<string, string>          // nom de fichier (décodé) → clé ZIP
  extract: (key: string) => Promise<Blob>
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const decodeRef = (raw: string) => { try { return decodeURIComponent(raw.replace(/\+/g, '%20')) } catch { return raw } }
export const norm = (s: string) => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ')
const IMG_RE = /\.(jpe?g|png|webp|gif|heic|heif|tiff?|avif)$/i

export async function ouvrirZipNotion(zip: File, onProgress?: (m: string) => void): Promise<NotionZip> {
  onProgress?.('Lecture de l’index du ZIP…')
  let index: Map<string, ZipEntry> = await readZipIndex(zip)
  let working: Blob = zip
  const nested = [...index.keys()].find(k => /Part-\d+\.zip$/i.test(k) || (/\.zip$/i.test(k) && index.size <= 3))
  if (nested) {
    const e = index.get(nested)!
    if (e.method === 0) {
      onProgress?.('ZIP imbriqué (lecture directe)…')
      const { dataOffset, csize } = await getEntryDataOffset(zip, e)
      index = await readZipIndex(zip, { baseOffset: dataOffset, virtualSize: csize })
    } else {
      onProgress?.(`Décompression du ZIP imbriqué (${Math.round(e.size / 1048576)} Mo)…`)
      working = await extractEntry(zip, e)
      index = await readZipIndex(working)
    }
  }
  const keys = [...index.keys()].filter(k => !k.endsWith('/'))
  const byBase = new Map<string, string>()
  for (const k of keys) byBase.set(baseName(k), k)
  return { name: zip.name, keys, byBase, extract: (key: string) => extractEntry(working, index.get(key)!) }
}

/* ============================== diagnostic ============================== */

export type ColType = 'fichiers' | 'lien' | 'pose' | 'texte long' | 'texte' | 'vide'
export type Column = {
  name: string
  type: ColType
  filled: number                 // lignes non vides
  samples: string[]
  files?: { found: number; missing: number; missingNames: string[] }
  link?: string                  // table liée
  linkHits?: number              // valeurs retrouvées dans la table liée
}
export type Table = { key: string; name: string; rows: Record<string, string>[]; columns: Column[]; titleColumn: string }
export type Diagnostic = { zipName: string; tables: Table[]; imageCount: number; otherFiles: number; problems: string[]; mainGuess?: string }

/** « Nom (Nom%20abc.md) » → « Nom » ; liste séparée par virgules. */
export function cellRefs(cell: string): string[] {
  if (!cell?.trim()) return []
  // les liens Notion contiennent des virgules encodées : on coupe sur « , » hors parenthèses
  const out: string[] = []
  let depth = 0, cur = ''
  for (const ch of cell) {
    if (ch === '(') depth++
    if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out.map(s => {
    const t = s.trim()
    if (/\.md\)$/i.test(t)) { const i = t.lastIndexOf(' ('); if (i > 0) return t.slice(0, i).trim() }
    return t
  }).filter(Boolean)
}
const fileRefs = (cell: string) => (cell ?? '').split(',').map(s => decodeRef(s.trim())).filter(Boolean)

const tableName = (key: string) => baseName(key).replace(/\.csv$/i, '').replace(/_all$/i, '').replace(/\s+[0-9a-f]{32}$/i, '').trim()

export async function diagnostiquer(z: NotionZip, onProgress?: (m: string) => void): Promise<Diagnostic> {
  const csvKeys = z.keys.filter(k => /\.csv$/i.test(k))
  // Notion exporte souvent « X.csv » et « X_all.csv » : on garde _all si présent (toutes les lignes), sinon X
  const chosen = new Map<string, string>()
  for (const k of csvKeys) {
    const n = tableName(k)
    const prev = chosen.get(n)
    if (!prev || (/_all\.csv$/i.test(k) && !/_all\.csv$/i.test(prev))) chosen.set(n, k)
  }
  const problems: string[] = []
  const tables: Table[] = []
  for (const [name, key] of chosen) {
    onProgress?.(`Lecture du tableau « ${name} »…`)
    const text = (await (await z.extract(key)).text()).replace(/^﻿/, '')
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true })
    const rows = (parsed.data ?? []).filter(r => Object.values(r).some(v => String(v ?? '').trim()))
    const headers = (parsed.meta.fields ?? []).filter(Boolean)
    tables.push({ key, name, rows, columns: headers.map(h => ({ name: h, type: 'texte', filled: 0, samples: [] })), titleColumn: headers[0] ?? '' })
  }
  // index des titres de chaque table (pour reconnaître les liens)
  const titles = new Map<string, Set<string>>()
  for (const t of tables) titles.set(t.name, new Set(t.rows.map(r => norm(cellRefs(String(r[t.titleColumn] ?? ''))[0] ?? '')).filter(Boolean)))

  for (const t of tables) {
    for (const c of t.columns) {
      const vals = t.rows.map(r => String(r[c.name] ?? '').trim()).filter(Boolean)
      c.filled = vals.length
      c.samples = [...new Set(vals)].slice(0, 3).map(v => (v.length > 90 ? v.slice(0, 90) + '…' : v))
      if (!vals.length) { c.type = 'vide'; continue }
      // fichiers : la majorité des valeurs pointent vers des fichiers image
      const refs = vals.flatMap(fileRefs)
      const imgLike = refs.filter(r => IMG_RE.test(r))
      if (imgLike.length && imgLike.length >= refs.length * 0.6) {
        const found = imgLike.filter(r => z.byBase.has(r))
        const missing = imgLike.filter(r => !z.byBase.has(r))
        c.type = 'fichiers'
        c.files = { found: found.length, missing: missing.length, missingNames: [...new Set(missing)].slice(0, 5) }
        if (missing.length) problems.push(`« ${t.name} › ${c.name} » : ${missing.length} image(s) citée(s) mais absente(s) du ZIP (ex. ${missing[0]}).`)
        continue
      }
      // lien vers une autre table
      if (c.name !== t.titleColumn) {
        const names = vals.flatMap(cellRefs).map(norm)
        let best: { table: string; hits: number } | null = null
        for (const [tn, set] of titles) {
          if (tn === t.name || !set.size) continue
          const hits = names.filter(n => set.has(n)).length
          if (!best || hits > best.hits) best = { table: tn, hits }
        }
        const looksLikeLink = vals.some(v => /\.md\)/i.test(v))
        if (best && (best.hits >= names.length * 0.5 || (looksLikeLink && best.hits > 0))) {
          c.type = 'lien'; c.link = best.table; c.linkHits = best.hits
          if (best.hits < names.length) problems.push(`« ${t.name} › ${c.name} » : ${names.length - best.hits} valeur(s) introuvable(s) dans « ${best.table} ».`)
          continue
        }
        if (looksLikeLink) { c.type = 'lien'; c.linkHits = 0; problems.push(`« ${t.name} › ${c.name} » : lien vers une table absente du ZIP.`); continue }
      }
      // pose / vue : nom de colonne explicite, ou valeurs courtes reconnues comme poses
      const avg = vals.reduce((s, v) => s + v.length, 0) / vals.length
      if (/\b(vue|pose|view)\b/i.test(c.name) || (avg <= 60 && vals.filter(v => parsePoseCell(v)).length >= vals.length * 0.7)) { c.type = 'pose'; continue }
      c.type = avg > 60 ? 'texte long' : 'texte'
    }
  }
  // colonne titre (nomme les visuels) : si la 1re colonne est vide, on prend SKU / Référence / Nom / ID, sinon la colonne texte la plus remplie
  const rank = (n: string) => ['sku', 'ref', 'nam', 'nom', 'num', 'id'].findIndex(p => n.trim().toLowerCase().replace('é', 'e').startsWith(p)) + 1 || 9
  for (const t of tables) {
    const first = t.columns.find(c => c.name === t.titleColumn)
    const usable = t.columns.filter(c => (c.type === 'texte' || c.type === 'lien') && c.filled > 0)
    const byName = usable.filter(c => /^(sku|r[ée]f[ée]rence|ref|name|nom|num[ée]ro|id)\b/i.test(c.name.trim())).sort((a, b) => (b.filled - a.filled) || (rank(a.name) - rank(b.name)))[0]
    if (!first || first.type === 'vide' || first.filled < t.rows.length * 0.5) t.titleColumn = (byName ?? [...usable].sort((a, b) => b.filled - a.filled)[0] ?? first)?.name ?? t.titleColumn
  }
  const imageCount = z.keys.filter(k => IMG_RE.test(k)).length
  // table principale probable : celle qui a des poses / des liens / le plus de fichiers
  const score = (t: Table) => t.columns.filter(c => c.type === 'pose').length * 5 + t.columns.filter(c => c.type === 'lien').length * 3 + t.columns.filter(c => c.type === 'fichiers').length + t.rows.length / 100
  const mainGuess = [...tables].sort((a, b) => score(b) - score(a))[0]?.name
  if (!tables.length) problems.push('Aucun tableau CSV dans le ZIP : exporte la base Notion en « Markdown & CSV ».')
  return { zipName: z.name, tables, imageCount, otherFiles: z.keys.length - imageCount - csvKeys.length, problems, mainGuess }
}

/* ============================== recette ============================== */

/** Source d'une image ou d'un texte : colonne de la table principale, ou colonne d'une table liée, ou catalogue Miraggia. */
export type Source =
  | { kind: 'colonne'; column: string }
  | { kind: 'lien'; column: string; field: string }                 // column (lien) → table liée → field
  | { kind: 'catalogue'; column: string; photo: 'visage' | 'corps' }  // nom du mannequin dans column → catalogue Miraggia

export type ImageSlot = { role: string; source: Source; max: number }
export type TextSlot = { label: string; source: Source }
export type Recette = {
  table: string
  poseColumns: string[]          // vide = 1 visuel par ligne
  images: ImageSlot[]
  texts: TextSlot[]
  prompt: string                 // prompt artistique, variables {Colonne} et {pose}
  fileName: string               // ex. « {SKU}_{pose} »
  skipEmpty: boolean             // ignorer les lignes sans aucune image
}

export const recetteVide = (d: Diagnostic): Recette => {
  const t = d.tables.find(x => x.name === d.mainGuess) ?? d.tables[0]
  return {
    table: t?.name ?? '', poseColumns: t?.columns.filter(c => c.type === 'pose').map(c => c.name) ?? [],
    images: [],
    // texte brut à ajouter au prompt : colonnes « description » et textes longs
    texts: (t?.columns ?? []).filter(c => c.type === 'texte long' || (/descri/i.test(c.name) && c.type !== 'vide' && c.type !== 'fichiers'))
      .map(c => ({ label: c.name, source: { kind: 'colonne' as const, column: c.name } })),
    prompt: '', fileName: `{${t?.titleColumn ?? 'ID'}}_{pose}`, skipEmpty: true,
  }
}

export const sourceLabel = (s: Source) =>
  s.kind === 'colonne' ? s.column : s.kind === 'lien' ? `${s.column} → ${s.field}` : `${s.column} → catalogue Miraggia (${s.photo})`

/** Toutes les sources possibles (pour les menus), selon le type voulu. */
export function sourcesPossibles(d: Diagnostic, tableName: string, want: 'image' | 'texte'): Source[] {
  const t = d.tables.find(x => x.name === tableName)
  if (!t) return []
  const ok = (c: Column) => (want === 'image' ? c.type === 'fichiers' : c.type !== 'fichiers' && c.type !== 'vide')
  const out: Source[] = t.columns.filter(ok).map(c => ({ kind: 'colonne', column: c.name }))
  for (const c of t.columns.filter(c => c.type === 'lien')) {
    const lt = d.tables.find(x => x.name === c.link)
    if (lt) for (const f of lt.columns.filter(ok)) out.push({ kind: 'lien', column: c.name, field: f.name })
    if (want === 'image') { out.push({ kind: 'catalogue', column: c.name, photo: 'visage' }); out.push({ kind: 'catalogue', column: c.name, photo: 'corps' }) }
  }
  if (want === 'image') for (const c of t.columns.filter(c => c.type === 'texte' && /mannequin|model|mod[eè]le/i.test(c.name))) {
    out.push({ kind: 'catalogue', column: c.name, photo: 'visage' }); out.push({ kind: 'catalogue', column: c.name, photo: 'corps' })
  }
  return out
}

/** Valide une recette (proposée par l'IA ou chargée) contre le diagnostic : supprime ce qui n'existe pas. */
export function validerRecette(r: any, d: Diagnostic): { recette: Recette; corrections: string[] } {
  const corrections: string[] = []
  const t = d.tables.find(x => x.name === r?.table) ?? d.tables.find(x => x.name === d.mainGuess) ?? d.tables[0]
  if (r?.table && t?.name !== r.table) corrections.push(`Table « ${r.table} » introuvable → « ${t?.name} ».`)
  const cols = new Set(t?.columns.map(c => c.name) ?? [])
  const okSource = (s: any, want: 'image' | 'texte'): Source | null => {
    const all = sourcesPossibles(d, t?.name ?? '', want)
    const hit = all.find(x => x.kind === s?.kind && x.column === s?.column && (x.kind !== 'lien' || x.field === s?.field) && (x.kind !== 'catalogue' || x.photo === s?.photo))
    return hit ?? null
  }
  const images: ImageSlot[] = []
  for (const im of Array.isArray(r?.images) ? r.images : []) {
    const s = okSource(im?.source, 'image')
    if (s) images.push({ role: String(im.role ?? 'référence'), source: s, max: Math.min(14, Math.max(1, Number(im.max) || 4)) })
    else corrections.push(`Image « ${im?.role ?? '?'} » : source ${JSON.stringify(im?.source)} introuvable, retirée.`)
  }
  const texts: TextSlot[] = []
  for (const tx of Array.isArray(r?.texts) ? r.texts : []) {
    const s = okSource(tx?.source, 'texte')
    if (s) texts.push({ label: String(tx.label ?? (s as any).column), source: s })
    else corrections.push(`Texte « ${tx?.label ?? '?'} » : source introuvable, retiré.`)
  }
  const poseColumns = (Array.isArray(r?.poseColumns) ? r.poseColumns : []).filter((c: string) => cols.has(c))
  return {
    recette: {
      table: t?.name ?? '', poseColumns, images, texts,
      prompt: String(r?.prompt ?? ''), fileName: String(r?.fileName ?? `{${t?.titleColumn ?? 'ID'}}_{pose}`),
      skipEmpty: r?.skipEmpty !== false,
    },
    corrections,
  }
}

/** Résumé compact du diagnostic, envoyé à l'IA qui traduit la consigne en recette. */
export function schemaPourIA(d: Diagnostic) {
  return d.tables.map(t => ({
    table: t.name, lignes: t.rows.length, titre: t.titleColumn,
    colonnes: t.columns.filter(c => c.type !== 'vide').map(c => ({ nom: c.name, type: c.type, ...(c.link ? { lien_vers: c.link } : {}), exemples: c.samples.slice(0, 2) })),
  }))
}

/* ============================== visuels ============================== */

export type CatalogMannequin = { name: string; faceUrl: string; bodyUrl: string; description?: string }
export type VisuelImage = { role: string; label: string; zipKey?: string; url?: string }
export type Visuel = {
  id: string
  rowIndex: number
  title: string
  pose?: string
  images: VisuelImage[]
  prompt: string
  fileName: string
  warnings: string[]
}

const sanitize = (s: string) => s.replace(/[\/\\:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim()

export function construireVisuels(d: Diagnostic, z: NotionZip, r: Recette, catalog: CatalogMannequin[] | null, maxImages = 14): Visuel[] {
  const t = d.tables.find(x => x.name === r.table)
  if (!t) return []
  const linked = (colName: string) => d.tables.find(x => x.name === t.columns.find(c => c.name === colName)?.link)
  const linkedRow = (lt: Table, name: string) => lt.rows.find(row => norm(cellRefs(String(row[lt.titleColumn] ?? ''))[0] ?? '') === norm(name))
  const catByName = new Map((catalog ?? []).map(m => [norm(m.name), m]))

  const resolveText = (row: Record<string, string>, s: Source): string => {
    if (s.kind === 'colonne') return cellRefs(String(row[s.column] ?? '')).join(', ') || String(row[s.column] ?? '').trim()
    if (s.kind === 'lien') {
      const lt = linked(s.column)
      if (!lt) return ''
      return cellRefs(String(row[s.column] ?? '')).map(n => String(linkedRow(lt, n)?.[s.field] ?? '').trim()).filter(Boolean).join(' / ')
    }
    return ''
  }
  const resolveImages = (row: Record<string, string>, slot: ImageSlot, warn: string[]): VisuelImage[] => {
    const s = slot.source
    const fromCell = (cell: string, where: string) => fileRefs(cell).filter(f => IMG_RE.test(f)).map(f => {
      const key = z.byBase.get(f)
      if (!key) warn.push(`${slot.role} : « ${f} » absent du ZIP (${where})`)
      return key ? { role: slot.role, label: f, zipKey: key } : null
    }).filter(Boolean) as VisuelImage[]
    if (s.kind === 'colonne') return fromCell(String(row[s.column] ?? ''), s.column).slice(0, slot.max)
    const names = cellRefs(String(row[s.column] ?? ''))
    if (s.kind === 'lien') {
      const lt = linked(s.column)
      if (!lt) return []
      const out: VisuelImage[] = []
      for (const n of names) {
        const lr = linkedRow(lt, n)
        if (!lr) { warn.push(`${slot.role} : « ${n} » introuvable dans « ${lt.name} »`); continue }
        out.push(...fromCell(String(lr[s.field] ?? ''), `${lt.name} › ${s.field}`))
      }
      return out.slice(0, slot.max)
    }
    // catalogue Miraggia
    const out: VisuelImage[] = []
    for (const n of names) {
      const m = catByName.get(norm(n))
      if (!m) { warn.push(`${slot.role} : « ${n} » absent du catalogue Miraggia`); continue }
      const url = s.photo === 'visage' ? m.faceUrl : m.bodyUrl
      if (url) out.push({ role: slot.role, label: `${m.name} (catalogue)`, url })
    }
    return out.slice(0, slot.max)
  }

  const visuels: Visuel[] = []
  t.rows.forEach((row, ri) => {
    const title = cellRefs(String(row[t.titleColumn] ?? ''))[0] || `ligne ${ri + 1}`
    const poses = r.poseColumns.map(c => String(row[c] ?? '').trim()).filter(Boolean)
    const passes = poses.length ? poses : [undefined]
    const warnBase: string[] = []
    const images = r.images.flatMap(slot => resolveImages(row, slot, warnBase))
    if (r.skipEmpty && !images.length) return
    const kept = images.slice(0, maxImages)
    if (images.length > maxImages) warnBase.push(`${images.length} images : seules les ${maxImages} premières sont envoyées (limite du modèle)`)
    passes.forEach((pose, pi) => {
      const vars: Record<string, string> = {}
      for (const c of t.columns) vars[norm(c.name)] = cellRefs(String(row[c.name] ?? '')).join(', ') || String(row[c.name] ?? '').trim()
      const poseLabel = pose ? parsePoseCell(pose) : null
      const posePrompt = pose ? (poseLabel ? poseToPrompt(poseLabel) : pose) : ''
      vars['pose'] = pose ?? ''
      const fill = (tpl: string) => tpl.replace(/\{([^{}]+)\}/g, (_, k) => vars[norm(k)] ?? '')
      // bloc images numérotées
      const lines: string[] = []
      if (r.prompt.trim()) lines.push(fill(r.prompt.trim()), '')
      if (kept.length) {
        lines.push('REFERENCE IMAGES (in order):')
        let n = 0
        const byRole = new Map<string, number[]>()
        for (const im of kept) { n++; byRole.set(im.role, [...(byRole.get(im.role) ?? []), n]) }
        for (const [role, idx] of byRole) lines.push(idx.length > 1 ? `- IMAGES ${idx[0]} to ${idx[idx.length - 1]}: ${role}` : `- IMAGE ${idx[0]}: ${role}`)
        lines.push('')
      }
      for (const tx of r.texts) {
        const v = resolveText(row, tx.source)
        if (v) lines.push(`${tx.label}: ${v}`)
      }
      if (posePrompt) lines.push(`POSE / VIEW: ${posePrompt}`)
      const base = sanitize(fill(r.fileName || `{${t.titleColumn}}_{pose}`).replace(/_+$/, '').replace(/^_+/, '')) || `visuel-${ri + 1}`
      visuels.push({
        id: `${ri}-${pi}`, rowIndex: ri, title, pose, images: kept,
        prompt: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
        fileName: `${base}${passes.length > 1 && !/\{pose\}/i.test(r.fileName) ? `_${pi + 1}` : ''}.jpg`,
        warnings: [...warnBase],
      })
    })
  })
  // noms de fichiers uniques
  const seen = new Map<string, number>()
  for (const v of visuels) {
    const k = v.fileName.toLowerCase(), n = (seen.get(k) ?? 0) + 1
    seen.set(k, n)
    if (n > 1) v.fileName = v.fileName.replace(/\.jpg$/, `_${n}.jpg`)
  }
  return visuels
}

/* ============================== recettes enregistrées (navigateur) ============================== */

const KEY = 'flex-recettes'
export function listerRecettes(): Record<string, Recette> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') } catch { return {} }
}
export function enregistrerRecette(nom: string, r: Recette) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...listerRecettes(), [nom]: r })) } catch { /* */ }
}
export function supprimerRecette(nom: string) {
  try { const all = listerRecettes(); delete all[nom]; localStorage.setItem(KEY, JSON.stringify(all)) } catch { /* */ }
}
