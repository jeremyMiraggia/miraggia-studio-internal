/**
 * Video — statut d'une requête fal + récupération du résultat.
 *
 * GET ?requestId=…&endpoint=…
 *   → { status: 'pending'|'succeeded'|'failed', videoUrl?, position?, message?, raw }
 *
 * Quand c'est terminé, la vidéo est copiée sur Vercel Blob (les URLs fal expirent)
 * et c'est l'URL Blob qui est renvoyée.
 */
import { NextResponse } from 'next/server'
import { fal } from '@fal-ai/client'
import { put } from '@vercel/blob'
import { isKnownVideoEndpoint } from '@/lib/video'

export const maxDuration = 120
export const runtime = 'nodejs'

export async function GET(request: Request) {
  try {
    const falKey = process.env.FAL_KEY
    if (!falKey) return NextResponse.json({ error: 'FAL_KEY manquante.' }, { status: 500 })
    fal.config({ credentials: falKey })

    const url = new URL(request.url)
    const requestId = url.searchParams.get('requestId') ?? ''
    const endpoint  = url.searchParams.get('endpoint') ?? ''
    if (!requestId) return NextResponse.json({ error: 'requestId requis.' }, { status: 400 })
    if (!isKnownVideoEndpoint(endpoint)) return NextResponse.json({ error: 'endpoint inconnu.' }, { status: 400 })

    const st: any = await fal.queue.status(endpoint, { requestId, logs: false })
    const status = String(st?.status ?? '').toUpperCase()

    if (status === 'IN_QUEUE' || status === 'IN_PROGRESS') {
      return NextResponse.json({
        status: 'pending',
        phase: status === 'IN_QUEUE' ? 'queue' : 'rendering',
        position: st?.queue_position,
        raw: st,
      })
    }

    if (status !== 'COMPLETED') {
      return NextResponse.json({ status: 'failed', message: `Statut fal inattendu : ${status || '(vide)'}`, raw: st })
    }

    // Terminé → résultat
    const res: any = await fal.queue.result(endpoint, { requestId })
    const data = res?.data ?? res
    const falVideoUrl: string | undefined = data?.video?.url ?? data?.video_url ?? data?.url
    if (!falVideoUrl || !/^https?:\/\//.test(falVideoUrl)) {
      return NextResponse.json({ status: 'failed', message: 'Résultat fal sans URL vidéo.', raw: data })
    }

    // Copie sur Vercel Blob (persistance)
    let videoUrl = falVideoUrl
    let blobError: string | undefined
    try {
      const r = await fetch(falVideoUrl)
      if (!r.ok) throw new Error(`fetch vidéo HTTP ${r.status}`)
      const ab: ArrayBuffer = await r.arrayBuffer()
      const buf = Buffer.from(new Uint8Array(ab))
      const blob = await put(`video/${Date.now()}-${requestId.slice(0, 8)}.mp4`, buf, {
        access: 'public', contentType: 'video/mp4', cacheControlMaxAge: 3600,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      })
      videoUrl = blob.url
    } catch (e: any) {
      blobError = e?.message ?? String(e)
    }

    return NextResponse.json({
      status: 'succeeded',
      videoUrl,
      falVideoUrl,
      blobError,
      durationSec: data?.video?.duration ?? data?.duration,
      raw: data,
    })
  } catch (error: any) {
    const detail = error?.body?.detail ?? error?.body
    return NextResponse.json({
      error: error?.message ?? 'Erreur inconnue',
      detail: detail ? JSON.stringify(detail).slice(0, 800) : undefined,
    }, { status: error?.status ?? 500 })
  }
}
