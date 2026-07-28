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

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody
  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => {
        return {
          allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
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
