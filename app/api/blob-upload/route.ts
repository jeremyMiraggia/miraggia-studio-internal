/**
 * Endpoint de client-upload Vercel Blob.
 *
 * Permet au navigateur d'uploader des fichiers DIRECTEMENT vers Vercel Blob
 * (sans passer par les API routes → pas de limite 4.5 MB).
 *
 * Utilisé par Nature Morte (et extensible aux autres onglets) pour envoyer
 * les images de référence aux endpoints via URL au lieu de multipart.
 */
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { NextResponse } from 'next/server'
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth'

function cookieValue(request: Request, name: string): string | undefined {
  const raw = request.headers.get('cookie') ?? ''
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return undefined
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody
  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => {
        // Seul un utilisateur connecté peut obtenir un token d'upload.
        // (Le callback "upload-completed" vient des serveurs Vercel, sans cookie —
        //  il ne passe pas par ici, donc pas bloqué.)
        const ok = await verifySessionToken(cookieValue(request, SESSION_COOKIE))
        if (!ok) throw new Error('Non authentifié.')
        return {
          // Large liste — le client convertit normalement tout en JPEG, mais si
          // la conversion échoue (TIFF, BMP exotiques...) on accepte quand même
          // l'upload plutôt que de bloquer le batch.
          allowedContentTypes: [
            'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
            'image/tiff', 'image/bmp', 'image/gif', 'image/avif',
            'application/octet-stream',
          ],
          addRandomSuffix: true,
          tokenPayload: '',
        }
      },
      onUploadCompleted: async () => {
        // rien à faire — l'URL est renvoyée au client
      },
    })
    return NextResponse.json(jsonResponse)
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? String(error) }, { status: 400 })
  }
}
