/** Lance la connexion du compte Instagram (protégé par le mot de passe du Studio, comme tout /api/studio). */
import { NextResponse } from 'next/server'
import { authorizeUrl } from '@/lib/insta/api'
import { newState, redirectUri } from '@/lib/insta/oauth'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  if (!process.env.INSTAGRAM_APP_ID || !process.env.INSTAGRAM_APP_SECRET) {
    const origin = new URL(request.url).origin
    return NextResponse.redirect(`${origin}/studio?tab=insta&insta=${encodeURIComponent('INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET manquants dans Vercel.')}`)
  }
  return NextResponse.redirect(authorizeUrl(redirectUri(request), await newState()))
}
