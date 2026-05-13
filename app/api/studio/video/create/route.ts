import { NextResponse } from 'next/server'
import { makeKlingJwt, klingBaseUrl, klingVideoModel } from '@/lib/klingAuth'

export const maxDuration = 60

/**
 * Crée une tâche de génération vidéo Kling V3.
 *
 * Body (FormData) :
 *   - mode       : 'text2video' | 'image2video' | 'image2video_pair'
 *   - prompt     : string  (obligatoire)
 *   - negative   : string  (optionnel)
 *   - duration   : '3'..'10' (secondes)
 *   - resolution : '720p' | '1080p' | '4k'
 *   - aspectRatio: '16:9' | '9:16' | '1:1'
 *   - audio      : 'on' | 'off'
 *   - cfgScale   : number  (optionnel, 0..1)
 *   - image      : File    (obligatoire si mode != text2video) — image de départ
 *   - imageTail  : File    (optionnel, image de fin pour image2video_pair)
 *
 * Réponse :
 *   { taskId, endpoint }   où endpoint = 'text2video' ou 'image2video'
 *   (à passer ensuite à /api/studio/video/status?id=…&endpoint=…)
 */
export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const mode       = (formData.get('mode')       as string | null) ?? 'text2video'
    const prompt     = ((formData.get('prompt')   as string | null) ?? '').trim()
    const negative   = ((formData.get('negative') as string | null) ?? '').trim()
    const duration   = (formData.get('duration')   as string | null) ?? '5'
    const resolution = (formData.get('resolution') as string | null) ?? '1080p'
    const aspect     = (formData.get('aspectRatio')as string | null) ?? '9:16'
    const audio      = (formData.get('audio')      as string | null) ?? 'off'
    const cfgScale   = Number(formData.get('cfgScale') ?? 0.5)

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt requis.' }, { status: 400 })
    }

    let token: string
    try { token = makeKlingJwt() }
    catch (e: any) {
      return NextResponse.json({ error: e?.message ?? 'Auth Kling échouée' }, { status: 500 })
    }

    const isImageMode = mode === 'image2video' || mode === 'image2video_pair'
    const endpoint    = isImageMode ? 'image2video' : 'text2video'

    const body: Record<string, any> = {
      model_name:      klingVideoModel(),
      prompt,
      negative_prompt: negative || undefined,
      duration,                   // '3'..'10' — Kling peut limiter à '5' / '10' selon le modèle
      resolution,                 // '720p' | '1080p' | '4k'
      cfg_scale:       Number.isFinite(cfgScale) ? cfgScale : 0.5,
      with_audio:      audio === 'on',
    }

    if (!isImageMode) {
      body.aspect_ratio = aspect
    }

    if (isImageMode) {
      const image = formData.get('image') as File | null
      if (!image) {
        return NextResponse.json({ error: 'Image de départ requise pour ce mode.' }, { status: 400 })
      }
      body.image = await fileToBase64(image)

      if (mode === 'image2video_pair') {
        const tail = formData.get('imageTail') as File | null
        if (!tail) {
          return NextResponse.json({ error: 'Image de fin requise pour le mode start+end.' }, { status: 400 })
        }
        body.image_tail = await fileToBase64(tail)
      }
    }

    const url = `${klingBaseUrl()}/v1/videos/${endpoint}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
    })

    const data = await safeJson(res)
    if (!res.ok || data?.code !== 0) {
      return NextResponse.json(
        { error: data?.message || data?.error || `Kling HTTP ${res.status}`, raw: data },
        { status: res.status === 200 ? 502 : res.status },
      )
    }

    const taskId = data?.data?.task_id
    if (!taskId) {
      return NextResponse.json({ error: 'task_id absent de la réponse Kling.', raw: data }, { status: 502 })
    }

    return NextResponse.json({ taskId, endpoint })

  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue' }, { status: 500 })
  }
}

async function fileToBase64(file: File): Promise<string> {
  const buf = Buffer.from(await file.arrayBuffer())
  return buf.toString('base64')
}

async function safeJson(res: Response): Promise<any> {
  try { return await res.json() } catch { return null }
}
