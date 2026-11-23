/**
 * Webhook Instagram (PUBLIC : appelé par Meta, hors du mot de passe du Studio).
 *
 *   GET  : vérification de l'abonnement (hub.mode / hub.verify_token / hub.challenge)
 *   POST : notifications « comments » — signature X-Hub-Signature-256 vérifiée avec le secret de l'app,
 *          réponse 200 immédiate, traitement juste après (DM si un mot clé correspond).
 *
 * Env : INSTAGRAM_WEBHOOK_VERIFY_TOKEN, META_APP_SECRET.
 */
import { after, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { context, handleComment, type Incoming } from '@/lib/insta/api'
import { ping } from '@/lib/insta/store'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams
  const clean = (s?: string | null) => (s ?? '').trim().replace(/^["']|["']$/g, '').trim()
  const expected = clean(process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN)
  if (expected && p.get('hub.mode') === 'subscribe' && clean(p.get('hub.verify_token')) === expected) {
    return new Response(p.get('hub.challenge') ?? '', { status: 200, headers: { 'Content-Type': 'text/plain' } })
  }
  return new Response('Forbidden', { status: 403 })
}

function signatureOk(raw: string, header: string | null): boolean {
  if (!header?.startsWith('sha256=')) return false
  const got = Buffer.from(header.slice(7), 'hex')
  const secrets = [process.env.META_APP_SECRET, process.env.INSTAGRAM_APP_SECRET].filter(Boolean) as string[]
  return secrets.some(s => {
    const exp = createHmac('sha256', s).update(raw, 'utf8').digest()
    return exp.length === got.length && timingSafeEqual(exp, got)
  })
}

/** Les deux formes de notification documentées par Meta (entry.changes[] ou entry.field/value). */
function extract(body: any): Incoming[] {
  const out: Incoming[] = []
  for (const entry of body?.entry ?? []) {
    const changes = Array.isArray(entry.changes) ? entry.changes : entry.field ? [{ field: entry.field, value: entry.value }] : []
    for (const ch of changes) {
      if (ch?.field !== 'comments' || !ch.value) continue
      const v = ch.value
      out.push({
        commentId: String(v.id ?? v.comment_id ?? ''),
        text: String(v.text ?? ''),
        mediaId: String(v.media?.id ?? ''),
        fromId: v.from?.id ? String(v.from.id) : undefined,
        username: String(v.from?.username ?? ''),
      })
    }
  }
  return out.filter(c => c.commentId)
}

export async function POST(request: Request) {
  const raw = await request.text()
  if (!signatureOk(raw, request.headers.get('x-hub-signature-256'))) {
    return NextResponse.json({ error: 'signature invalide' }, { status: 401 })
  }
  let body: any
  try { body = JSON.parse(raw) } catch { return NextResponse.json({ ok: true }) }
  const comments = extract(body)

  after(async () => {
    await ping({ at: Date.now(), count: comments.length })
    if (!comments.length) return
    const { acc, rules } = await context()
    if (!acc || !rules.enabled) return
    for (const c of comments) {
      try { await handleComment(acc, rules.rules, c, 'webhook') } catch (e) { console.error('[insta] commentaire', c.commentId, e) }
    }
  })
  return NextResponse.json({ ok: true })
}
