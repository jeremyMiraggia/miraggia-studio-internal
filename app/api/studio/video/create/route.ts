/**
 * Video — soumission d'une génération Kling 3.0 via fal.ai (file d'attente).
 *
 * Entrée JSON :
 *   { tier: 'standard'|'pro', prompt, startImageUrl, endImageUrl?, duration: 3..15, audio?: boolean }
 * Sortie : { requestId, endpoint }
 *
 * Les images sont des URLs (upload direct Blob côté client) → pas de limite 4.5 MB.
 * La vidéo est récupérée par /status (polling) puis copiée sur Vercel Blob.
 */
import { NextResponse } from 'next/server'
import { fal } from '@fal-ai/client'
import { VIDEO_ENDPOINTS } from '@/lib/video'

export const maxDuration = 60
export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    const falKey = process.env.FAL_KEY
    if (!falKey) return NextResponse.json({ error: 'FAL_KEY manquante.' }, { status: 500 })
    fal.config({ credentials: falKey })

    const body = await request.json().catch(() => ({}))
    const tier: string = body.tier === 'pro' ? 'pro' : 'standard'
    const prompt: string = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    const startImageUrl: string = typeof body.startImageUrl === 'string' ? body.startImageUrl : ''
    const endImageUrl: string | undefined = typeof body.endImageUrl === 'string' && body.endImageUrl ? body.endImageUrl : undefined
    const audio: boolean = body.audio === true
    // Multi-plans : [{ prompt, duration }] — remplace `prompt` (fal : l'un OU l'autre)
    const shots: Array<{ prompt: string; duration: number }> = Array.isArray(body.shots)
      ? body.shots
          .map((s: any) => ({ prompt: String(s?.prompt ?? '').trim(), duration: Math.max(1, Math.min(15, Math.round(Number(s?.duration) || 3))) }))
          .filter((s: any) => s.prompt)
      : []
    const totalFromShots = shots.reduce((a, s) => a + s.duration, 0)
    const durationNum = shots.length
      ? Math.max(3, Math.min(15, totalFromShots))
      : Math.max(3, Math.min(15, Math.round(Number(body.duration) || 5)))

    if (!prompt && !shots.length) return NextResponse.json({ error: 'Prompt requis (ou au moins un plan).' }, { status: 400 })
    if (shots.length && totalFromShots > 15) return NextResponse.json({ error: `Durée totale des plans ${totalFromShots}s > 15s max.` }, { status: 400 })
    if (!/^https?:\/\//.test(startImageUrl)) return NextResponse.json({ error: 'startImageUrl requise (URL).' }, { status: 400 })

    const endpoint = VIDEO_ENDPOINTS[tier]
    const input: Record<string, unknown> = {
      start_image_url: startImageUrl,
      duration: String(durationNum),
      generate_audio: audio,          // défaut fal = true → +50 % : on force explicitement
    }
    if (shots.length) {
      input.multi_prompt = shots.map(s => ({ prompt: s.prompt, duration: String(s.duration) }))
      input.shot_type = 'customize'   // on définit les plans nous-mêmes
    } else {
      input.prompt = prompt
    }
    if (endImageUrl) input.end_image_url = endImageUrl

    const { request_id } = await fal.queue.submit(endpoint, { input })
    return NextResponse.json({ requestId: request_id, endpoint, tier, input })
  } catch (error: any) {
    // fal renvoie souvent le détail de validation dans error.body
    const detail = error?.body?.detail ?? error?.body ?? undefined
    return NextResponse.json({
      error: error?.message ?? 'Erreur inconnue',
      detail: detail ? JSON.stringify(detail).slice(0, 800) : undefined,
    }, { status: error?.status ?? 500 })
  }
}
