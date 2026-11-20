/**
 * Renouvellement quotidien du jeton Instagram (cron Vercel, voir vercel.json).
 * Vercel envoie « Authorization: Bearer $CRON_SECRET » quand CRON_SECRET est défini.
 */
import { NextResponse } from 'next/server'
import { freshAccount } from '@/lib/insta/api'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 })
  }
  const acc = await freshAccount()
  return NextResponse.json({ ok: true, connected: !!acc, expiresAt: acc ? new Date(acc.expiresAt).toISOString() : null })
}
