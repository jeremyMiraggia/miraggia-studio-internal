import { createHmac } from 'crypto'

/**
 * Génère un JWT HS256 pour l'API Kling.
 *
 * L'API Kling attend un Bearer JWT signé avec :
 *   header  : { alg: "HS256", typ: "JWT" }
 *   payload : { iss: ACCESS_KEY, exp: now + 1800, nbf: now - 5 }
 *
 * On lit `KLING_ACCESS_KEY` et `KLING_SECRET_KEY` depuis l'environnement.
 */
export function makeKlingJwt(): string {
  const accessKey = process.env.KLING_ACCESS_KEY
  const secret    = process.env.KLING_SECRET_KEY
  if (!accessKey || !secret) {
    throw new Error('KLING_ACCESS_KEY ou KLING_SECRET_KEY manquante côté serveur.')
  }

  const now = Math.floor(Date.now() / 1000)
  const header  = { alg: 'HS256', typ: 'JWT' }
  const payload = {
    iss: accessKey,
    exp: now + 1800, // 30 min
    nbf: now - 5,
  }

  const h = b64url(JSON.stringify(header))
  const p = b64url(JSON.stringify(payload))
  const data = `${h}.${p}`
  const sig  = createHmac('sha256', secret).update(data).digest()
  const s    = b64urlBuf(sig)
  return `${data}.${s}`
}

/** Base URL configurable (Kling propose api.klingai.com et api-singapore.klingai.com). */
export function klingBaseUrl(): string {
  return (process.env.KLING_API_BASE_URL || 'https://api.klingai.com').replace(/\/+$/, '')
}

/** Nom du modèle vidéo Kling. */
export function klingVideoModel(): string {
  // Kling Video 3.0 — surchargeable via env si Kling renomme le model_name.
  return process.env.KLING_VIDEO_MODEL || 'kling-v3'
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function b64urlBuf(buf: Buffer): string {
  return buf.toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
