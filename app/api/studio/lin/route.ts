/**
 * LIN — défroissage via Flux Kontext (FAL.ai).
 *
 * Pourquoi Flux Kontext et pas Gemini ?
 *   Gemini Image (3 Pro) est excellent pour la génération créative mais
 *   inefficace pour les EDITS LOCAUX fidèles : quand on lui dit "garde
 *   l'image telle quelle sauf X", il garde TOUT à l'identique (ne change
 *   rien). Flux Kontext est conçu spécifiquement pour les retouches
 *   localisées, en gardant fidèlement le reste de l'image.
 *
 * Workflow :
 *   1. Upload de la source sur FAL storage
 *   2. fal-ai/flux-pro/kontext/max avec un prompt court et directif
 *   3. Re-fetch + upload Vercel Blob pour persistance + CORS
 */
import { NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { fal } from '@fal-ai/client'

export const maxDuration = 300
export const runtime = 'nodejs'

// Prompt court & directif (Flux Kontext préfère les prompts directs, pas les longs essais)
const PROMPT = [
  'Iron the garment perfectly.',
  'Remove ALL wrinkles, creases, fold lines and crumples from the fabric.',
  'The clothing must look freshly steamed and ironed — smooth, crisp, flat against the body with natural soft drape.',
  'For LINEN : keep the visible linen weave texture (it must still look like linen, not silk), but eliminate every wrinkle and crease.',
  'Pay attention to typical wrinkle zones : shoulders, sleeves, armpits, mid-back, waist, lap area, elbows.',
  '',
  'CRITICAL : keep EVERYTHING ELSE strictly identical to the source image — same face, same hair, same skin, same exact pose, same hand position, same camera angle, same crop, same framing, same background (every pixel), same lighting, same shadows, same garment color, same garment cut, same garment length, same seams, same buttons, same accessories. Only the wrinkles disappear.',
].join(' ')

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const source = formData.get('source') as File | null
    if (!source) return NextResponse.json({ error: 'Image source requise (champ "source").' }, { status: 400 })

    const falKey = process.env.FAL_KEY
    if (!falKey) return NextResponse.json({ error: 'FAL_KEY manquante côté serveur.' }, { status: 500 })
    fal.config({ credentials: falKey })

    // 1. Upload de la source sur FAL storage
    const sourceUrl = await fal.storage.upload(source)

    // 2. Flux Kontext (pro) — img2img fidèle, bon rapport qualité/prix (~$0.04 / image)
    const result: any = await fal.subscribe('fal-ai/flux-pro/kontext', {
      input: {
        prompt: PROMPT,
        image_url: sourceUrl,
        guidance_scale: 3.5,           // 3-4 = bon équilibre fidélité / suivi du prompt
        num_images: 1,
        safety_tolerance: '6',         // permissif (sinon Flux peut bloquer des photos mode)
        output_format: 'png',
      },
      logs: false,
    })

    const editedUrl: string | undefined =
      result?.data?.images?.[0]?.url ??
      result?.images?.[0]?.url
    if (!editedUrl) {
      return NextResponse.json({ error: 'Flux Kontext n\'a pas renvoyé d\'image.', raw: result }, { status: 502 })
    }

    // 3. Re-fetch puis upload Vercel Blob pour persistance (sinon FAL CDN expire)
    const editedArrBuf = await fetch(editedUrl).then(r => r.arrayBuffer())
    const editedBuf = Buffer.from(new Uint8Array(editedArrBuf))
    let imageUrl: string
    let blobError: string | undefined
    try {
      const path = `lin/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
      const blob = await put(path, editedBuf, {
        access: 'public',
        contentType: 'image/png',
        cacheControlMaxAge: 60,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      })
      imageUrl = blob.url
    } catch (err: any) {
      imageUrl = `data:image/png;base64,${editedBuf.toString('base64')}`
      blobError = err?.message ?? String(err)
    }

    return NextResponse.json({ imageUrl, blobError })
  } catch (error: any) {
    return NextResponse.json({
      error: error?.message ?? 'Erreur inconnue',
      stack: error?.stack?.slice(0, 800),
    }, { status: 500 })
  }
}
