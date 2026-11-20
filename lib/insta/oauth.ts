import { sign } from './store'

/** URL de retour OAuth : doit être déclarée à l'identique dans l'app Meta. */
export function redirectUri(request: Request) {
  return process.env.INSTAGRAM_REDIRECT_URI || `${new URL(request.url).origin}/api/insta/callback`
}

/** state signé valable 15 minutes. */
export async function newState() {
  const exp = String(Date.now() + 15 * 60_000)
  return `${exp}.${await sign(exp)}`
}
