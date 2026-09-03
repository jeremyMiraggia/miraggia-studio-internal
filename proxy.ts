/**
 * proxy.ts (Next 16 — ex-middleware) : protège le Studio ET ses API.
 *
 *   /studio/*       → redirection vers / si pas de session valide
 *   /api/studio/*   → 401 si pas de session valide
 *   (/api/blob-upload se protège lui-même : Vercel le rappelle sans cookie)
 *
 * Sans ça, les endpoints Gemini / FAL / Photoroom seraient appelables par
 * n'importe qui connaissant l'URL, mot de passe ou pas.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth'

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const ok = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value)
  if (ok) return NextResponse.next()

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Non authentifié.' }, { status: 401 })
  }
  const url = request.nextUrl.clone()
  url.pathname = '/'
  url.search = ''
  return NextResponse.redirect(url)
}

export const config = {
  matcher: ['/studio/:path*', '/api/studio/:path*'],
}
