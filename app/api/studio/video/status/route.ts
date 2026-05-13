import { NextResponse } from 'next/server'
import { makeKlingJwt, klingBaseUrl } from '@/lib/klingAuth'

export const maxDuration = 30

/**
 * Statut d'une tâche vidéo Kling.
 *
 * Query :
 *   - id       : string  (task_id)
 *   - endpoint : 'text2video' | 'image2video'
 *
 * Réponse :
 *   { status: 'submitted'|'processing'|'succeeded'|'failed', videoUrl?, durationSec?, message? }
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
    if (!res.ok || data?.code !== 0) {
      return NextResponse.json(
        { error: data?.message || `Kling HTTP ${res.status}`, raw: data },
        { status: res.status === 200 ? 502 : res.status },
      )
    }

    const d        = data?.data ?? {}
    const status   = String(d?.task_status ?? '').toLowerCase()        // 'submitted'|'processing'|'succeeded'|'failed'
    const videos   = d?.task_result?.videos ?? []
    const first    = videos[0] ?? {}
    const videoUrl = first?.url || undefined
    const duration = first?.duration ? Number(first.duration) : undefined
    const message  = d?.task_status_msg || undefined

    return NextResponse.json({ status, videoUrl, durationSec: duration, message })

  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue' }, { status: 500 })
  }
}

async function safeJson(res: Response): Promise<any> {
  try { return await res.json() } catch { return null }
}
