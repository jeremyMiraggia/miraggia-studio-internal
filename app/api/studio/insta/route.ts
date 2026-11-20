/**
 * Onglet INSTA (protégé par le mot de passe du Studio).
 *   GET  → état : compte, jeton, abonnement webhook, dernier webhook reçu, règles, journal, URLs à déclarer chez Meta
 *   POST → { action: 'rules', rules } | { action: 'media' } | { action: 'backfill', mediaId, limit? } | { action: 'subscribe' } | { action: 'disconnect' }
 * Le jeton n'est jamais renvoyé au navigateur.
 */
import { NextResponse } from 'next/server'
import { freshAccount, handleComment, mediaComments, recentMedia, subscribe, subscriptions } from '@/lib/insta/api'
import { findRule } from '@/lib/insta/match'
import { redirectUri } from '@/lib/insta/oauth'
import { alreadyClaimed, clearAccount, getLogs, getRules, lastPing, saveRules, type Rules } from '@/lib/insta/store'

export const runtime = 'nodejs'
export const maxDuration = 60

const env = () => ({
  appId: !!process.env.META_APP_ID,
  appSecret: !!process.env.META_APP_SECRET,
  configId: !!process.env.INSTAGRAM_CONFIG_ID,
  verifyToken: !!process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN,
  blob: !!process.env.BLOB_READ_WRITE_TOKEN,
})

export async function GET(request: Request) {
  const origin = new URL(request.url).origin
  const urls = { webhook: `${origin}/api/insta/webhook`, redirect: redirectUri(request) }
  try {
    const [acc, rules, logs, last] = await Promise.all([freshAccount(), getRules(), getLogs(), lastPing()])
    let subscribed: string[] | null = null, subError: string | undefined
    if (acc) { try { subscribed = await subscriptions(acc) } catch (e: any) { subError = e?.message } }
    return NextResponse.json({
      env: env(), urls,
      account: acc ? { username: acc.username, igId: acc.igId, expiresAt: acc.expiresAt, tokenAt: acc.tokenAt, connectedAt: acc.connectedAt } : null,
      subscribed, subError, lastWebhook: last, rules, logs,
    })
  } catch (e: any) {
    return NextResponse.json({ env: env(), urls, error: e?.message ?? String(e) }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}))
  try {
    if (body.action === 'rules') {
      const r = body.rules as Rules
      if (!r || !Array.isArray(r.rules)) return NextResponse.json({ error: 'règles invalides' }, { status: 400 })
      const clean: Rules = {
        enabled: !!r.enabled, updatedAt: Date.now(),
        rules: r.rules.map(x => ({
          id: String(x.id || crypto.randomUUID()), name: String(x.name || 'Règle').slice(0, 80), enabled: !!x.enabled,
          keywords: (x.keywords ?? []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 20),
          mode: (['mot', 'exact', 'contient'] as const).includes(x.mode) ? x.mode : 'mot',
          posts: x.posts === 'all' ? 'all' : (Array.isArray(x.posts) ? x.posts.map(String) : []),
          message: String(x.message ?? '').slice(0, 1000),
          publicReplies: (x.publicReplies ?? []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 10),
        })),
      }
      await saveRules(clean)
      return NextResponse.json({ ok: true, rules: clean })
    }

    const acc = await freshAccount()
    if (!acc) return NextResponse.json({ error: 'Aucun compte Instagram connecté.' }, { status: 400 })

    if (body.action === 'media') return NextResponse.json({ media: await recentMedia(acc) })

    if (body.action === 'subscribe') { await subscribe(acc); return NextResponse.json({ ok: true, subscribed: await subscriptions(acc) }) }

    if (body.action === 'disconnect') { await clearAccount(); return NextResponse.json({ ok: true }) }

    // Rattrapage : commentaires déjà postés (≤ 7 jours) qui contiennent un mot clé et n'ont pas encore reçu le DM
    if (body.action === 'backfill') {
      const mediaId = String(body.mediaId ?? '')
      const dryRun = !!body.dryRun
      const limit = Math.min(Number(body.limit) || 25, 40)
      const rules = await getRules()
      const comments = await mediaComments(acc, mediaId)
      const recent = comments.filter(c => Date.now() - Date.parse(c.timestamp) < 7 * 86400_000 - 3600_000)
      const candidates = recent.filter(c => (c.from?.id ?? '') !== acc.igId && findRule(rules.rules, c.text, mediaId))
      const done = await alreadyClaimed(candidates.map(c => c.id))
      const todo = candidates.filter(c => !done.has(c.id))
      if (dryRun) return NextResponse.json({ total: comments.length, recent: recent.length, matching: candidates.length, alreadyDone: done.size, todo: todo.length })
      let sent = 0, errors = 0
      const errorsList: string[] = []
      for (const c of todo.slice(0, limit)) {
        const r = await handleComment(acc, rules.rules, {
          commentId: c.id, text: c.text, mediaId, fromId: c.from?.id, username: c.from?.username ?? c.username ?? '', createdAt: Date.parse(c.timestamp),
        }, 'rattrapage').catch(() => 'erreur' as const)
        if (r === 'envoyé') sent++
        if (r === 'erreur') errors++
        await new Promise(res => setTimeout(res, 1200))   // on reste loin des limites d'envoi d'Instagram
      }
      if (errors) errorsList.push(`${errors} erreur(s) : voir le journal`)
      return NextResponse.json({ sent, errors, remaining: Math.max(0, todo.length - limit), notes: errorsList })
    }

    return NextResponse.json({ error: 'action inconnue' }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
