import { NextResponse } from 'next/server'

export const maxDuration = 300

/**
 * Free Prompt — génération libre via Gemini 3 Pro Image Preview.
 *
 * Body (FormData) :
 *   - prompt   : string   (obligatoire)
 *   - ratio    : string   ('9:16' | '3:4' | '1:1' | '16:9' | '4:3')
 *   - quality  : string   ('1K' | '2K' | '4K')
 *   - refs     : File[]   (0..N images de référence)
 *
 * Si Gemini renvoie un HTTP 200 sans image (cas typique de throttle
 * preview ou safety filter), on retente 1× avec un délai puis on
 * remonte la vraie raison (finishReason / blockReason / texte renvoyé).
 */
export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const prompt   = (formData.get('prompt')  as string | null)?.trim() ?? ''
    const ratio    = (formData.get('ratio')   as string | null) ?? '9:16'
    const quality  = (formData.get('quality') as string | null) ?? '2K'

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt requis.' }, { status: 400 })
    }

    const refs = formData.getAll('refs').filter((v): v is File => v instanceof File)
    const inlineParts: Array<{ inlineData: { mimeType: string; data: string } }> = []
    for (const file of refs) {
      const buf = Buffer.from(await file.arrayBuffer()).toString('base64')
      inlineParts.push({
        inlineData: { mimeType: file.type || 'image/jpeg', data: buf },
      })
    }

    const aspectRatio = ratio
    const imageSize   = quality === '4K' ? '4K' : quality === '1K' ? '1K' : '2K'

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY manquante côté serveur.' }, { status: 500 })
    }

    const requestBody = JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          ...inlineParts,
        ],
      }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio, imageSize },
      },
    })

    // 1er essai
    const r1 = await callGemini(apiKey, requestBody)
    if (r1.ok && r1.imageUrl) return NextResponse.json({ imageUrl: r1.imageUrl })
    if (!r1.ok) {
      return NextResponse.json({ error: r1.error, raw: r1.raw }, { status: r1.status })
    }

    // r1.ok mais pas d'image → throttle preview / safety / etc.
    // On attend et on retente 1× avec un petit délai.
    await sleep(6000)
    const r2 = await callGemini(apiKey, requestBody)
    if (r2.ok && r2.imageUrl) return NextResponse.json({ imageUrl: r2.imageUrl })

    // Construction d'un message d'erreur le plus précis possible
    const last = r2.ok ? r2 : r2
    const detail = buildDetailMessage(last)
    return NextResponse.json(
      {
        error: `Aucune image générée après 2 tentatives. ${detail}`,
        raw: last.raw,
      },
      { status: 502 },
    )

  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue' }, { status: 500 })
  }
}

/* ============================== helpers ============================== */

type GeminiAttempt = {
  ok:           boolean       // HTTP 2xx ET réponse parseable
  status:       number
  imageUrl?:    string
  error?:       string
  finishReason?:string
  blockReason?: string
  textResponse?:string
  raw?:         any
}

async function callGemini(apiKey: string, body: string): Promise<GeminiAttempt> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    },
  )

  let data: any = null
  try { data = await res.json() } catch { /* */ }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: data?.error?.message || data?.error || `Gemini HTTP ${res.status}`,
      raw: data,
    }
  }

  const candidate    = data?.candidates?.[0]
  const finishReason = candidate?.finishReason as string | undefined
  const blockReason  = data?.promptFeedback?.blockReason as string | undefined
  const parts        = candidate?.content?.parts ?? []

  // Cherche l'image
  for (const part of parts) {
    if (part?.inlineData?.mimeType?.startsWith('image/')) {
      return {
        ok: true,
        status: res.status,
        imageUrl: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
        finishReason, blockReason, raw: data,
      }
    }
  }

  // Sinon récupère le texte
  const textResponse = parts
    .filter((p: any) => typeof p?.text === 'string')
    .map((p: any) => p.text)
    .join(' ')
    .trim() || undefined

  return {
    ok: true,
    status: res.status,
    finishReason, blockReason, textResponse,
    raw: data,
  }
}

function buildDetailMessage(att: GeminiAttempt): string {
  const bits: string[] = []
  if (att.blockReason)  bits.push(`blockReason=${att.blockReason}`)
  if (att.finishReason && att.finishReason !== 'STOP') bits.push(`finishReason=${att.finishReason}`)
  if (att.textResponse) {
    const t = att.textResponse.length > 240 ? att.textResponse.slice(0, 240) + '…' : att.textResponse
    bits.push(`Gemini a renvoyé du texte : "${t}"`)
  }
  if (bits.length === 0) {
    return 'Probablement un throttle / quota du modèle preview — réessaye dans 1 min ou baisse le parallélisme à 1.'
  }
  return bits.join(' · ')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
