import { NextResponse } from 'next/server'
import { makeKlingJwt, klingBaseUrl } from '@/lib/klingAuth'

export const maxDuration = 30

const SUCCESS_STATES = new Set(['succeed', 'succeeded', 'success', 'completed', 'complete', 'done', 'finished'])
const FAILED_STATES  = new Set(['fail', 'failed', 'error', 'errored'])
const PENDING_STATES = new Set(['submitted', 'pending', 'queuing', 'queued', 'processing', 'running', 'in_progress'])

/**
 * Statut d'une tâche vidéo Kling.
 *
 * Query :
 *   - id       : string  (task_id)
 *   - endpoint : 'text2video' | 'image2video'
 *
 * Réponse :
 *   {
 *     status:   'submitted'|'processing'|'succeeded'|'failed'|'unknown',
 *     videoUrl?:string,
 *     durationSec?:number,
 *     message?:string,
 *     raw?:any           // toujours renvoyé pour debug
 *   }
 */
export async function GET(request: Request) {
  try {
    const url      = new URL(request.url)
    const taskId   = url.searchParams.get('id')
    const endpoint = url.searchParams.get('endpoint') || 'image2video'

    if (!taskId) {
      return NextResponse.json({ error: 'Paramètre id manquant.' }, { status: 400 })
    }

    let token: string
    try { token = makeKlingJwt() }
    catch (e: any) {
      return NextResponse.json({ error: e?.message ?? 'Auth Kling échouée' }, { status: 500 })
    }

    const klingUrl = `${klingBaseUrl()}/v1/videos/${endpoint}/${encodeURIComponent(taskId)}`
    const res = await fetch(klingUrl, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    })

    const data = await safeJson(res)
    if (!res.ok || (data && data.code !== undefined && data.code !== 0)) {
      return NextResponse.json(
        { error: data?.message || `Kling HTTP ${res.status}`, raw: data },
        { status: res.status === 200 ? 502 : res.status },
      )
    }

    const d = data?.data ?? data ?? {}

    // Status : on tente plusieurs noms et on normalise
    const rawStatus = String(
      d?.task_status ?? d?.status ?? d?.state ?? ''
    ).toLowerCase().trim()

    let status: 'succeeded' | 'failed' | 'processing' | 'unknown'
    if (SUCCESS_STATES.has(rawStatus)) status = 'succeeded'
    else if (FAILED_STATES.has(rawStatus)) status = 'failed'
    else if (PENDING_STATES.has(rawStatus)) status = 'processing'
    else status = 'unknown'

    // URL vidéo : on cherche dans plusieurs chemins possibles
    const candidates: any[] = [
      d?.task_result?.videos?.[0]?.url,
      d?.task_result?.videos?.[0]?.video_url,
      d?.task_result?.video_url,
      d?.task_result?.url,
      d?.task_result?.result?.videos?.[0]?.url,
      d?.task_result?.result?.[0]?.url,
      d?.result?.videos?.[0]?.url,
      d?.result?.video_url,
      d?.videos?.[0]?.url,
      d?.video_url,
      d?.url,
    ]
    const videoUrl = candidates.find((v) => typeof v === 'string' && /^https?:\/\//i.test(v))

    const duration = pickNumber([
      d?.task_result?.videos?.[0]?.duration,
      d?.task_result?.duration,
      d?.duration,
    ])
    const message = d?.task_status_msg || d?.message || d?.error_msg || undefined

    // Si on dit "succeeded" mais qu'on n'a pas trouvé l'URL : on remonte unknown + raw
    if (status === 'succeeded' && !videoUrl) {
      return NextResponse.json({
        status: 'unknown',
        videoUrl: undefined,
        durationSec: duration,
        message: 'Tâche marquée succeeded mais URL vidéo introuvable dans la réponse. Vérifie le champ "raw" ci-dessous et envoie-le pour qu\'on cale le parseur.',
        raw: data,
      })
    }

    return NextResponse.json({ status, videoUrl, durationSec: duration, message, raw: data })

  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue' }, { status: 500 })
  }
}

async function safeJson(res: Response): Promise<any> {
  try { return await res.json() } catch { return null }
}

function pickNumber(values: any[]): number | undefined {
  for (const v of values) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return undefined
}
