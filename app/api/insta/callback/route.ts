/**
 * Retour de la connexion Instagram (PUBLIC : Instagram redirige le navigateur ici).
 * Le paramètre state, signé par /api/studio/insta/connect, prouve que la connexion a été lancée depuis le Studio.
 */
import { NextResponse } from 'next/server'
import { connect } from '@/lib/insta/api'
import { redirectUri } from '@/lib/insta/oauth'
import { sign } from '@/lib/insta/store'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const back = (msg: string) => NextResponse.redirect(`${url.origin}/studio?tab=insta&insta=${encodeURIComponent(msg)}`)
  const err = url.searchParams.get('error_description') || url.searchParams.get('error')
  if (err) return back(`Connexion refusée : ${err}`)

  const state = url.searchParams.get('state') ?? ''
  const [exp, sig] = state.split('.')
  if (!exp || !sig || Number(exp) < Date.now() || sig !== (await sign(exp))) return back('Lien de connexion expiré : relance « Connecter Instagram » depuis le Studio.')

  const code = url.searchParams.get('code')
  if (!code) return back('Instagram n’a pas renvoyé de code.')
  try {
    const acc = await connect(code, redirectUri(request))
    return back(`ok:${acc.username}`)
  } catch (e: any) {
    return back(`Erreur : ${e?.message ?? e}`)
  }
}
