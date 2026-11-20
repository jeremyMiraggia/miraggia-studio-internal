/** Lance la connexion du compte Instagram (protégé par le mot de passe du Studio, comme tout /api/studio). */
import { NextResponse } from 'next/server'
import { authorizeUrl } from '@/lib/insta/api'
import { newState, redirectUri } from '@/lib/insta/oauth'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET || !process.env.INSTAGRAM_CONFIG_ID) {
    const origin = new URL(request.url).origin
    return NextResponse.redirect(`${origin}/studio?tab=insta&insta=${encodeURIComponent('META_APP_ID / META_APP_SECRET / INSTAGRAM_CONFIG_ID manquants dans Vercel.')}`)
  }
  return NextResponse.redirect(authorizeUrl(redirectUri(request), await newState()))
}
