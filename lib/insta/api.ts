/**
 * Appels à l'API Instagram — « Instagram API with Unified Login » (hôte graph.facebook.com).
 * Connexion par la boîte de dialogue Facebook Login for Business (config_id), jeton « system user » de l'entreprise.
 * Env : META_APP_ID, META_APP_SECRET, INSTAGRAM_CONFIG_ID (+ INSTAGRAM_API_VERSION facultatif).
 */
import { findRule, personalize } from './match'
import { addLog, claimComment, getAccount, getRules, releaseComment, saveAccount, type Account, type Rule } from './store'

const V = process.env.INSTAGRAM_API_VERSION || 'v27.0'
const G = `https://graph.facebook.com/${V}`
export const WEBHOOK_FIELDS = 'comments'
const DAY = 24 * 3600_000
const enc = encodeURIComponent

async function call<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, cache: 'no-store' })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || j?.error) {
    const e = j?.error
    throw new Error(e?.message ? `${e.message}${e.code ? ` (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})` : ''}` : `HTTP ${res.status}`)
  }
  return j as T
}

/* ---------- connexion ---------- */

export function authorizeUrl(redirectUri: string, state: string) {
  const p = new URLSearchParams({
    client_id: process.env.META_APP_ID ?? '', config_id: process.env.INSTAGRAM_CONFIG_ID ?? '',
    redirect_uri: redirectUri, response_type: 'code', state,
  })
  return `https://www.facebook.com/${V}/dialog/oauth?${p}`
}

/** Date d'expiration du jeton (0 = n'expire pas), lue auprès de Meta. */
async function tokenExpiry(token: string): Promise<number> {
  try {
    const j = await call<any>(`${G}/debug_token?input_token=${enc(token)}&access_token=${enc(`${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`)}`)
    const t = Number(j.data?.expires_at ?? 0)
    return t > 0 ? t * 1000 : 0
  } catch { return 0 }
}

/** code OAuth → jeton → compte Instagram rattaché, puis abonnement du compte aux webhooks de commentaires. */
export async function connect(code: string, redirectUri: string): Promise<Account> {
  const t = await call<{ access_token: string; expires_in?: number }>(
    `${G}/oauth/access_token?client_id=${enc(process.env.META_APP_ID ?? '')}&client_secret=${enc(process.env.META_APP_SECRET ?? '')}&redirect_uri=${enc(redirectUri)}&code=${enc(code)}`)
  const token = t.access_token
  if (!token) throw new Error('Meta n’a pas renvoyé de jeton.')
  const list = await call<{ data: { id: string; username?: string }[] }>(`${G}/me/assigned_instagram_accounts?fields=id,username&access_token=${enc(token)}`)
  const ig = list.data?.[0]
  if (!ig) throw new Error('Aucun compte Instagram autorisé : pendant la connexion, coche bien le compte Instagram de Miraggia.')
  let username = ig.username ?? ''
  if (!username) { try { username = (await call<any>(`${G}/${ig.id}?fields=username&access_token=${enc(token)}`)).username ?? '' } catch { /* */ } }
  const now = Date.now()
  const acc: Account = {
    igId: String(ig.id), username, token, tokenAt: now,
    expiresAt: t.expires_in ? now + t.expires_in * 1000 : await tokenExpiry(token), connectedAt: now,
  }
  await subscribe(acc)
  await saveAccount(acc)
  return acc
}

export async function subscribe(acc: Account) {
  return call(`${G}/${acc.igId}/subscribed_apps?subscribed_fields=${WEBHOOK_FIELDS}&access_token=${enc(acc.token)}`, { method: 'POST' })
}

export async function subscriptions(acc: Account): Promise<string[]> {
  const j = await call<any>(`${G}/${acc.igId}/subscribed_apps?access_token=${enc(acc.token)}`)
  return (j.data ?? []).flatMap((d: any) => d.subscribed_fields ?? [])
}

/** Compte connecté. Le jeton Unified Login n'a pas de renouvellement à faire : sa durée dépend de la configuration Meta. */
export async function freshAccount(): Promise<Account | null> {
  const acc = await getAccount()
  if (!acc) return null
  // vérifie l'expiration une fois par jour (0 = n'expire pas)
  if (Date.now() - acc.tokenAt > DAY) {
    const exp = await tokenExpiry(acc.token)
    const next = { ...acc, tokenAt: Date.now(), expiresAt: exp }
    await saveAccount(next).catch(() => {})
    return next
  }
  return acc
}

/* ---------- publications / commentaires ---------- */

export type Media = { id: string; caption?: string; media_type: string; media_product_type?: string; thumbnail_url?: string; media_url?: string; permalink: string; timestamp: string; comments_count?: number }

export async function recentMedia(acc: Account, limit = 30): Promise<Media[]> {
  const j = await call<{ data: Media[] }>(`${G}/${acc.igId}/media?fields=id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,comments_count&limit=${limit}&access_token=${enc(acc.token)}`)
  return j.data ?? []
}

export type IgComment = { id: string; text: string; timestamp: string; username?: string; from?: { id: string; username: string } }

export async function mediaComments(acc: Account, mediaId: string, max = 500): Promise<IgComment[]> {
  const out: IgComment[] = []
  let url: string | undefined = `${G}/${mediaId}/comments?fields=id,text,timestamp,username,from&limit=50&access_token=${enc(acc.token)}`
  while (url && out.length < max) {
    const j: any = await call(url)
    out.push(...(j.data ?? []))
    url = j.paging?.next
  }
  return out
}

/* ---------- envoi ---------- */

export async function privateReply(acc: Account, commentId: string, text: string) {
  return call(`${G}/${acc.igId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${acc.token}` },
    body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text } }),
  })
}

export async function publicReply(acc: Account, commentId: string, text: string) {
  return call(`${G}/${commentId}/replies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${acc.token}` },
    body: JSON.stringify({ message: text }),
  })
}

export type Incoming = { commentId: string; text: string; mediaId: string; fromId?: string; username: string; createdAt?: number }

/**
 * Traite un commentaire : règle correspondante → verrou anti-doublon → DM → réponse publique éventuelle → journal.
 * Renvoie ce qui s'est passé (null = rien à faire).
 */
export async function handleComment(acc: Account, rules: Rule[], c: Incoming, source: 'webhook' | 'rattrapage'): Promise<'envoyé' | 'erreur' | 'doublon' | null> {
  if (!c.commentId || (c.fromId && c.fromId === acc.igId) || c.username === acc.username) return null   // nos propres commentaires (évite les boucles)
  if (c.createdAt && Date.now() - c.createdAt > 7 * DAY - 3600_000) return null                       // Instagram : 7 jours maximum
  const rule = findRule(rules, c.text, c.mediaId)
  if (!rule) return null
  if (!(await claimComment(c.commentId))) return 'doublon'
  const entry = { at: Date.now(), commentId: c.commentId, username: c.username, text: c.text.slice(0, 300), mediaId: c.mediaId, rule: rule.name, source }
  try {
    await privateReply(acc, c.commentId, personalize(rule.message, c.username))
  } catch (e: any) {
    await releaseComment(c.commentId)
    await addLog({ ...entry, status: 'erreur', error: String(e?.message ?? e).slice(0, 300) }).catch(() => {})
    return 'erreur'
  }
  let pub: string | undefined
  const replies = rule.publicReplies.map(s => s.trim()).filter(Boolean)
  if (replies.length) {
    pub = personalize(replies[Math.floor(Math.random() * replies.length)], c.username)
    try { await publicReply(acc, c.commentId, pub) } catch (e: any) { pub = `⚠ réponse publique refusée : ${String(e?.message ?? e).slice(0, 150)}` }
  }
  await addLog({ ...entry, status: 'envoyé', publicReply: pub }).catch(() => {})
  return 'envoyé'
}

/** Charge compte + règles une seule fois pour un lot de commentaires. */
export async function context() {
  const [acc, rules] = await Promise.all([freshAccount(), getRules()])
  return { acc, rules }
}
