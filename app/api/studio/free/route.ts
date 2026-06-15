import { NextResponse } from 'next/server'

export const maxDuration = 300

/**
 * Free Prompt — génération libre via Gemini 3 Pro Image Preview.
 *
 * Body (FormData) :
 *   - prompt   : string
 *   - ratio    : '9:16' | '3:4' | '1:1' | '16:9' | '4:3'
 *   - quality  : '1K' | '2K' | '4K'
 *   - refs     : File[]   (0..N — TOUT sauf la face photo : silhouette, fond, vêtements, etc.)
 *   - face     : File     (optionnelle — portrait visage du mannequin)
 *
 * Stratégie face aux faux positifs IMAGE_SAFETY :
 *   - safetySettings BLOCK_ONLY_HIGH sur les 4 catégories
 *   - prompt suffix qui précise que le mannequin est DÉJÀ IA-généré (pas une vraie personne)
 *   - 3 tentatives :
 *       1) refs + face photo
 *       2) refs SANS face photo + prompt qui explique
 *       3) refs SANS face photo
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

    // Refs principales (sans face photo)
    const refs = formData.getAll('refs').filter((v): v is File => v instanceof File)
    const refInline = await Promise.all(refs.map(toInlinePart))

    // Face photo (optionnelle)
    const faceFile = formData.get('face') as File | null
    const faceInline = faceFile && faceFile instanceof File ? await toInlinePart(faceFile) : null

    const aspectRatio = ratio
    const imageSize   = quality === '4K' ? '4K' : quality === '1K' ? '1K' : '2K'

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY manquante côté serveur.' }, { status: 500 })
    }

    // Suffixe disclaimer normal
    const SAFETY_SUFFIX = [
      '',
      '⚠ Important context for the model :',
      '- The persons shown in the input reference images are ALREADY AI-generated, synthetic mannequins — NOT real people. There is no real-world identity to preserve or protect.',
      '- The image to produce is for a professional fashion editorial / commercial portfolio (Vogue-style).',
      '- Content is family-safe : fully clothed subject, no nudity, no suggestive content, no minors.',
      '- Style is artistic high-end fashion photography.',
      '',
      '🎯 FACE / BODY CONSISTENCY (very important) :',
      '- The output must keep the SAME FACE as in the portrait reference (same eyes, nose, mouth, jawline, hair color & cut, skin tone, eyebrows). The fashion model must remain visually identical across all generated variants.',
      '- The body / silhouette must match the body reference (height, build, posture base).',
      '- Do not invent a new face. Do not blend. Stay faithful to the portrait reference.',
    ].join('\n')

    // Suffixe spécifique quand on dropt la face (pour expliquer pourquoi le visage manque)
    const NO_FACE_SUFFIX = [
      '',
      '🔁 RETRY without the face photo reference :',
      '- The face reference image was removed because Gemini\'s safety filter sometimes treats it as a real-world identity.',
      '- Generate a coherent FICTIONAL fashion model face, consistent with the body reference silhouette. No specific real person.',
    ].join('\n')

    const baseGenConfig = {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio, imageSize },
    }
    const safetySettings = [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ]

    const buildBody = (withFace: boolean, includeNoFaceSuffix: boolean) => {
      const finalPrompt = prompt + '\n' + SAFETY_SUFFIX + (includeNoFaceSuffix ? '\n' + NO_FACE_SUFFIX : '')
      const parts: any[] = [{ text: finalPrompt }, ...refInline]
      if (withFace && faceInline) parts.push(faceInline)
      return JSON.stringify({
        contents: [{ parts }],
        generationConfig: baseGenConfig,
        safetySettings,
      })
    }

    // 3 tentatives :
    //   1) avec face photo
    //   2) sans face photo (5s d'attente) + explication dans le prompt
    //   3) sans face photo (10s d'attente)
    const attempts: { delay: number, withFace: boolean, includeNoFaceSuffix: boolean }[] = [
      { delay: 0,     withFace: !!faceInline, includeNoFaceSuffix: false },
      { delay: 5000,  withFace: false,        includeNoFaceSuffix: !!faceInline },
      { delay: 10000, withFace: false,        includeNoFaceSuffix: !!faceInline },
    ]

    let last: GeminiAttempt | null = null
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i]
      if (a.delay > 0) await sleep(a.delay)
      const body = buildBody(a.withFace, a.includeNoFaceSuffix)
      const att = await callGemini(apiKey, body)
      if (att.ok && att.imageUrl) return NextResponse.json({ imageUrl: att.imageUrl })
      if (!att.ok) {
        return NextResponse.json({ error: att.error, raw: att.raw }, { status: att.status })
      }
      last = att
    }

    const detail = buildDetailMessage(last!)
    return NextResponse.json(
      { error: `Aucune image générée après 3 tentatives (dont 2 sans face photo). ${detail}`, raw: last?.raw },
      { status: 502 },
    )

  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue' }, { status: 500 })
  }
}

/* ============================== helpers ============================== */

type GeminiAttempt = {
  ok:           boolean
  status:       number
  imageUrl?:    string
  error?:       string
  finishReason?:string
  blockReason?: string
  textResponse?:string
  raw?:         any
}

async function toInlinePart(file: File) {
  const buf = Buffer.from(await file.arrayBuffer()).toString('base64')
  return { inlineData: { mimeType: file.type || 'image/jpeg', data: buf } }
}

async function callGemini(apiKey: string, body: string): Promise<GeminiAttempt> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
  )

  let data: any = null
  try { data = await res.json() } catch { /* */ }

  if (!res.ok) {
    return {
      ok: false, status: res.status,
      error: data?.error?.message || data?.error || `Gemini HTTP ${res.status}`,
      raw: data,
    }
  }

  const candidate    = data?.candidates?.[0]
  const finishReason = candidate?.finishReason as string | undefined
  const blockReason  = data?.promptFeedback?.blockReason as string | undefined
  const parts        = candidate?.content?.parts ?? []

  for (const part of parts) {
    if (part?.inlineData?.mimeType?.startsWith('image/')) {
      return {
        ok: true, status: res.status,
        imageUrl: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
        finishReason, blockReason, raw: data,
      }
    }
  }

  const textResponse = parts
    .filter((p: any) => typeof p?.text === 'string')
    .map((p: any) => p.text)
    .join(' ')
    .trim() || undefined

  return { ok: true, status: res.status, finishReason, blockReason, textResponse, raw: data }
}

function buildDetailMessage(att: GeminiAttempt): string {
  const bits: string[] = []
  if (att.blockReason) bits.push(`blockReason=${att.blockReason}`)
  if (att.finishReason && att.finishReason !== 'STOP') bits.push(`finishReason=${att.finishReason}`)
  if (att.textResponse) {
    const t = att.textResponse.length > 240 ? att.textResponse.slice(0, 240) + '…' : att.textResponse
    bits.push(`Gemini : "${t}"`)
  }
  if (att.finishReason === 'IMAGE_SAFETY') {
    bits.push('Le filtre IMAGE_SAFETY a bloqué même sans la face photo. Essaie un autre mannequin ou réduis la similitude visuelle.')
  }
  if (bits.length === 0) {
    return 'Probablement un throttle / quota du modèle preview — réessaye dans 1 min ou baisse le parallélisme à 1.'
  }
  return bits.join(' · ')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
