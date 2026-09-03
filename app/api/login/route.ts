import { NextResponse } from 'next/server'
import { createSessionToken, passwordMatches, SESSION_COOKIE, SESSION_DAYS } from '@/lib/auth'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}))
  const password = typeof body?.password === 'string' ? body.password : ''

  if (!process.env.APP_PASSWORD) {
    return NextResponse.json({ error: 'APP_PASSWORD non configuré côté serveur.' }, { status: 500 })
  }
  if (!passwordMatches(password)) {
    // petit délai anti-bruteforce
    await new Promise(r => setTimeout(r, 400))
    return NextResponse.json({ error: 'Mot de passe incorrect' }, { status: 401 })
  }

  const token = await createSessionToken()
  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 3600,
  })
  return res
}
