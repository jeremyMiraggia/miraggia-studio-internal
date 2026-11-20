/**
 * Stockage de l'onglet INSTA dans Vercel Blob (pas de base de données en plus).
 *
 * Tout est CHIFFRÉ (AES-GCM, clé dérivée de AUTH_SECRET / APP_PASSWORD) : le store Blob est public,
 * donc le jeton Instagram, les règles et le journal (pseudos, commentaires) ne sont jamais lisibles en clair.
 *
 *   insta/account/<ts>.bin   compte connecté + jeton (on garde la dernière version)
 *   insta/rules/<ts>.bin     règles mot clé → DM (dernière version)
 *   insta/sent/<commentId>   verrou « déjà traité » (écriture sans écrasement = anti-doublon atomique)
 *   insta/log/<ordre>-<id>   journal, du plus récent au plus ancien
 *   insta/ping/<ts>.bin      dernier webhook reçu
 *
 * Chaque version porte un nom unique : on ne relit jamais une copie périmée du CDN.
 * ⚠ Changer AUTH_SECRET / APP_PASSWORD rend les données illisibles → il faudra reconnecter le compte et refaire les règles.
 */
import { del, list, put } from '@vercel/blob'

/* ---------- chiffrement ---------- */

let keyPromise: Promise<CryptoKey> | null = null
function key(): Promise<CryptoKey> {
  if (!keyPromise) {
    const secret = process.env.AUTH_SECRET || process.env.APP_PASSWORD || ''
    if (!secret) throw new Error('AUTH_SECRET / APP_PASSWORD manquant : impossible de chiffrer les données Instagram.')
    keyPromise = crypto.subtle.digest('SHA-256', new TextEncoder().encode(`insta-store|${secret}`))
      .then(raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']))
  }
  return keyPromise
}

async function seal(data: unknown): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(JSON.stringify(data))))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv); out.set(ct, 12)
  return out
}

async function open<T>(buf: ArrayBuffer): Promise<T> {
  const b = new Uint8Array(buf)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, await key(), b.slice(12))
  return JSON.parse(new TextDecoder().decode(pt)) as T
}

/* ---------- signature (state OAuth) ---------- */

export async function sign(message: string): Promise<string> {
  const secret = process.env.AUTH_SECRET || process.env.APP_PASSWORD || ''
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(`insta-state|${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message))
  return Buffer.from(sig).toString('base64url')
}

/* ---------- versions « dernière valeur » ---------- */

const putOpts = { access: 'public' as const, addRandomSuffix: false, contentType: 'application/octet-stream', cacheControlMaxAge: 60 }

async function readLatest<T>(prefix: string): Promise<T | null> {
  const { blobs } = await list({ prefix, limit: 100 })
  if (!blobs.length) return null
  const latest = blobs.sort((a, b) => b.pathname.localeCompare(a.pathname))[0]
  const res = await fetch(latest.url, { cache: 'no-store' })
  if (!res.ok) return null
  return open<T>(await res.arrayBuffer())
}

async function writeLatest(prefix: string, data: unknown): Promise<void> {
  const name = `${prefix}${String(Date.now()).padStart(15, '0')}.bin`
  await put(name, Buffer.from(await seal(data)), putOpts)
  // ménage : on ne garde que les 3 dernières versions
  const { blobs } = await list({ prefix, limit: 100 })
  const old = blobs.sort((a, b) => b.pathname.localeCompare(a.pathname)).slice(3)
  if (old.length) await del(old.map(b => b.url)).catch(() => {})
}

/* ---------- types ---------- */

export type Account = {
  igId: string          // identifiant du compte pro (celui des webhooks)
  username: string
  token: string         // jeton « system user » Unified Login (durée fixée par la configuration Meta)
  tokenAt: number       // dernière vérification
  expiresAt: number     // 0 = n'expire pas
  connectedAt: number
}

export type MatchMode = 'mot' | 'exact' | 'contient'

export type Rule = {
  id: string
  name: string
  enabled: boolean
  keywords: string[]       // ex. ["PROMPT"] — insensible à la casse et aux accents
  mode: MatchMode          // mot : le mot apparaît dans le commentaire ; exact : le commentaire n'est que le mot ; contient : n'importe où
  posts: 'all' | string[]  // identifiants des publications concernées
  message: string          // DM envoyé ({username} = pseudo du commentateur)
  publicReplies: string[]  // réponse publique sous le commentaire (une au hasard), vide = aucune
}

export type Rules = { enabled: boolean; rules: Rule[]; updatedAt: number }

export type LogEntry = {
  at: number
  commentId: string
  username: string
  text: string
  mediaId: string
  rule: string
  status: 'envoyé' | 'erreur'
  error?: string
  publicReply?: string
  source: 'webhook' | 'rattrapage'
}

/* ---------- API ---------- */

export const getAccount = () => readLatest<Account>('insta/account/')
export const saveAccount = (a: Account) => writeLatest('insta/account/', a)
export async function clearAccount() {
  const { blobs } = await list({ prefix: 'insta/account/', limit: 100 })
  if (blobs.length) await del(blobs.map(b => b.url))
}

export async function getRules(): Promise<Rules> {
  return (await readLatest<Rules>('insta/rules/')) ?? { enabled: false, rules: [], updatedAt: 0 }
}
export const saveRules = (r: Rules) => writeLatest('insta/rules/', { ...r, updatedAt: Date.now() })

/** Réserve un commentaire. false = déjà traité (webhook renvoyé par Meta, ou rattrapage déjà fait). */
export async function claimComment(commentId: string): Promise<boolean> {
  const path = `insta/sent/${commentId.replace(/[^\w-]/g, '_')}`
  try {
    await put(path, String(Date.now()), { ...putOpts, contentType: 'text/plain', allowOverwrite: false })
    return true
  } catch (e) {
    // refus d'écrasement = déjà traité ; sinon (panne Blob…) on remonte l'erreur et rien n'est envoyé
    const { blobs } = await list({ prefix: path, limit: 5 }).catch(() => ({ blobs: [] as { pathname: string }[] }))
    if (blobs.some(b => b.pathname === path)) return false
    throw e
  }
}

/** Libère un commentaire après un échec d'envoi, pour qu'un rattrapage puisse réessayer. */
export async function releaseComment(commentId: string) {
  const path = `insta/sent/${commentId.replace(/[^\w-]/g, '_')}`
  const { blobs } = await list({ prefix: path, limit: 5 })
  const b = blobs.find(x => x.pathname === path)
  if (b) await del(b.url).catch(() => {})
}

export async function alreadyClaimed(commentIds: string[]): Promise<Set<string>> {
  const done = new Set<string>()
  let cursor: string | undefined
  do {
    const r = await list({ prefix: 'insta/sent/', limit: 1000, cursor })
    for (const b of r.blobs) done.add(b.pathname.slice('insta/sent/'.length))
    cursor = r.hasMore ? r.cursor : undefined
  } while (cursor)
  return new Set(commentIds.filter(id => done.has(id.replace(/[^\w-]/g, '_'))))
}

export async function addLog(e: LogEntry) {
  const order = String(9_999_999_999_999 - e.at).padStart(13, '0')   // tri alphabétique = du plus récent au plus ancien
  await put(`insta/log/${order}-${e.commentId.replace(/[^\w-]/g, '_')}.bin`, Buffer.from(await seal(e)), putOpts)
}

export async function getLogs(limit = 60): Promise<LogEntry[]> {
  const { blobs } = await list({ prefix: 'insta/log/', limit: 1000 })
  const recent = blobs.sort((a, b) => a.pathname.localeCompare(b.pathname)).slice(0, limit)
  const out = await Promise.all(recent.map(async b => {
    try { const r = await fetch(b.url, { cache: 'force-cache' }); return r.ok ? await open<LogEntry>(await r.arrayBuffer()) : null } catch { return null }
  }))
  return out.filter((x): x is LogEntry => !!x)
}

export async function ping(info: { at: number; count: number; note?: string }) {
  await writeLatest('insta/ping/', info).catch(() => {})
}
export const lastPing = () => readLatest<{ at: number; count: number; note?: string }>('insta/ping/').catch(() => null)
