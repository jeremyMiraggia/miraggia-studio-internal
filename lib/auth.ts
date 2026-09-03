/**
 * Auth serveur — session signée (HMAC-SHA256) dans un cookie httpOnly.
 *
 * Le mot de passe vit dans APP_PASSWORD (variable serveur, jamais envoyée au
 * navigateur). Le cookie ne contient PAS le mot de passe : seulement une date
 * d'expiration signée avec une clé dérivée du mot de passe. Changer le mot de
 * passe invalide donc toutes les sessions.
 *
 * Web Crypto uniquement → fonctionne dans proxy.ts (edge) et dans les routes.
 */

export const SESSION_COOKIE = 'studio_session'
export const SESSION_DAYS = 30

function secret(): string {
  return process.env.AUTH_SECRET || process.env.APP_PASSWORD || ''
}

async function hmac(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Crée un token "exp.signature". */
export async function createSessionToken(): Promise<string> {
  const exp = Date.now() + SESSION_DAYS * 24 * 3600 * 1000
  return `${exp}.${await hmac(String(exp))}`
}

/** Vérifie signature + expiration. */
export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token || !secret()) return false
  const dot = token.indexOf('.')
  if (dot <= 0) return false
  const exp = token.slice(0, dot), sig = token.slice(dot + 1)
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false
  const expected = await hmac(exp)
  if (expected.length !== sig.length) return false
  // comparaison à temps constant
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
  return diff === 0
}

/** Comparaison mot de passe à temps constant. */
export function passwordMatches(input: string): boolean {
  const expected = process.env.APP_PASSWORD ?? ''
  if (!expected) return false
  const a = new TextEncoder().encode(input), b = new TextEncoder().encode(expected)
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}
