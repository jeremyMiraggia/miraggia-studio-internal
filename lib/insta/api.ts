/**
 * Appels à l'API Instagram (« Instagram API with Instagram Login », hôte graph.instagram.com).
 * Env : INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET (+ INSTAGRAM_API_VERSION facultatif).
 */
import { findRule, personalize } from './match'
import { addLog, claimComment, getAccount, getRules, releaseComment, saveAccount, type Account, type Rule } from './store'

const V = process.env.INSTAGRAM_API_VERSION || 'v27.0'
const G = `https://graph.instagram.com/${V}`
export const SCOPES = ['instagram_business_basic', 'instagram_business_manage_comments', 'instagram_business_manage_messages']
export const WEBHOOK_FIELDS = 'comments'
const DAY = 24 * 3600_000

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
    client_id: process.env.INSTAGRAM_APP_ID ?? '', redirect_uri: redirectUri, response_type: 'code',
    scope: SCOPES.join(','), state, enable_fb_login: '0', force_reauth: 'true',
  })
  return `https://www.instagram.com/oauth/authorize?${p}`
}

/** code OAuth → jeton longue durée → compte, puis abonnement du compte aux webhooks de commentaires. */
export async function connect(code: string, redirectUri: string): Promise<Account> {
  const form = new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID ?? '', client_secret: process.env.INSTAGRAM_APP_SECRET ?? '',
    grant_type: 'authorization_code', redirect_uri: redirectUri, code: code.replace(/#_$/, ''),
  })
  const short = await call<any>('https://api.instagram.com/oauth/access_token', { method: 'POST', body: form })
  const shortToken: string = short.access_token ?? short.data?.[0]?.access_token
  if (!shortToken) throw new Error('Instagram n’a pas renvoyé de jeton.')
  const long = await call<{ access_token: string; expires_in: number }>(
    `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(process.env.INSTAGRAM_APP_SECRET ?? '')}&access_token=${encodeURIComponent(shortToken)}`)
  const me = await call<{ user_id?: string; id: string; username: string; account_type?: string }>(
    `${G}/me?fields=user_id,username,account_type&access_token=${encodeURIComponent(long.access_token)}`)
  const now = Date.now()
  const acc: Account = {
    igId: String(me.user_id ?? me.id), username: me.username, token: long.access_token,
    tokenAt: now, expiresAt: now + (long.expires_in || 60 * 86400) * 1000, connectedAt: now,
  }
  await subscribe(acc)
  await saveAccount(acc)
  return acc
}

export async function subscribe(acc: Account) {
  return call(`${G}/me/subscribed_apps?subscribed_fields=${WEBHOOK_FIELDS}&access_token=${encodeURIComponent(acc.token)}`, { method: 'POST' })
}

export async function subscriptions(acc: Account): Promise<string[]> {
  const j = await call<any>(`${G}/me/subscribed_apps?access_token=${encodeURIComponent(acc.token)}`)
  return (j.data ?? []).flatMap((d: any) => d.subscribed_fields ?? [])
}

/** Jeton renouvelé s'il a plus de 7 jours (Instagram : ≥ 24 h et pas expiré ; valable 60 j après renouvellement). */
export async function freshAccount(force = false): Promise<Account | null> {
  const acc = await getAccount()
  if (!acc) return null
  if (!force && Date.now() - acc.tokenAt < 7 * DAY) return acc
  if (Date.now() - acc.tokenAt < DAY || Date.now() > acc.expiresAt) return acc
  try {
    const r = await call<{ access_token: string; expires_in: number }>(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(acc.token)}`)
    const now = Date.now()
    const next = { ...acc, token: r.access_token, tokenAt: now, expiresAt: now + (r.expires_in || 60 * 86400) * 1000 }
    await saveAccount(next)
    return next
  } catch {
    return acc
  }
}

/* ---------- publications / commentaires ---------- */

export type Media = { id: string; caption?: string; media_type: string; media_product_type?: string; thumbnail_url?: string; media_url?: string; permalink: string; timestamp: string; comments_count?: number }

export async function recentMedia(acc: Account, limit = 30): Promise<Media[]> {
  const j = await call<{ data: Media[] }>(`${G}/me/media?fields=id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,comments_count&limit=${limit}&access_token=${encodeURIComponent(acc.token)}`)
  return j.data ?? []
}

export type IgComment = { id: string; text: string; timestamp: string; username?: string; from?: { id: string; username: string } }

export async function mediaComments(acc: Account, mediaId: string, max = 500): Promise<IgComment[]> {
  const out: IgComment[] = []
  let url: string | undefined = `${G}/${mediaId}/comments?fields=id,text,timestamp,username,from&limit=50&access_token=${encodeURIComponent(acc.token)}`
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
