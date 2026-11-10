/**
 * Seedream 5 Pro (ByteDance, via fal : bytedance/seedream/v5/pro/edit) — onglet 👙 Lingerie Visage.
 * Seedream ne bloque pas la lingerie / les maillots de bain, contrairement à Gemini.
 *
 * Entrée JSON : { prompt, imageUrls (≤ 10, URLs publiques Blob, dans l'ordre du prompt), width, height, sku }
 * Sortie : { imageUrl (Blob), cost (USD, tarif fal) }
 */
import { NextResponse } from 'next/server'
import { fal } from '@fal-ai/client'
import { put } from '@vercel/blob'
import sharp from 'sharp'

export const maxDuration = 300
export const runtime = 'nodejs'

const ENDPOINT = 'bytedance/seedream/v5/pro/edit'

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const prompt = String(body.prompt ?? '').trim()
    const imageUrls: string[] = (Array.isArray(body.imageUrls) ? body.imageUrls : []).filter((u: any) => typeof u === 'string' && /^https?:\/\//.test(u))
    const width = Number(body.width) || 1728
    const height = Number(body.height) || 2304
    const sku = String(body.sku ?? 'look')
    if (!prompt) return NextResponse.json({ error: 'Prompt requis.' }, { status: 400 })
    if (imageUrls.length === 0) return NextResponse.json({ error: 'Au moins une image requise.' }, { status: 400 })
    if (imageUrls.length > 10) return NextResponse.json({ error: 'Seedream accepte 10 images au maximum.' }, { status: 400 })

    const falKey = process.env.FAL_KEY
    if (!falKey) return NextResponse.json({ error: 'FAL_KEY manquante côté serveur.' }, { status: 500 })
    fal.config({ credentials: falKey })

    let result: any
    try {
      result = await fal.subscribe(ENDPOINT, {
        input: {
          prompt,
          image_urls: imageUrls,
          image_size: { width, height },
          num_images: 1,
          output_format: 'png',
          enable_safety_checker: false,
        },
        logs: false,
      })
    } catch (e: any) {
      const detail = e?.body?.detail
      const msg = typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((d: any) => d?.msg ?? JSON.stringify(d)).join(' · ') : e?.message
      return NextResponse.json({ error: `Seedream : ${msg ?? 'erreur inconnue'}` }, { status: e?.status ?? 502 })
    }
    const outUrl: string | undefined = result?.data?.images?.[0]?.url ?? result?.images?.[0]?.url
    if (!outUrl) return NextResponse.json({ error: 'Seedream sans image.' }, { status: 502 })

    // Les URLs fal expirent : on recopie le visuel sur Blob (JPEG q94)
    const ab: ArrayBuffer = await fetch(outUrl).then(r => r.arrayBuffer())
    const raw = Buffer.from(new Uint8Array(ab))
    let buf: Buffer = raw, mime = 'image/png'
    try { buf = await sharp(raw).jpeg({ quality: 94, progressive: true, mozjpeg: true }).toBuffer(); mime = 'image/jpeg' } catch { /* png tel quel */ }
    let imageUrl: string
    try {
      const b = await put(`lingerie-visage/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${sku.replace(/[^\w-]+/g, '_')}.${mime === 'image/jpeg' ? 'jpg' : 'png'}`, buf, {
        access: 'public', contentType: mime, cacheControlMaxAge: 60, token: process.env.BLOB_READ_WRITE_TOKEN,
      })
      imageUrl = b.url
    } catch {
      imageUrl = outUrl
    }

    // Tarif fal (indicatif) : 0,0675 $ jusqu'à 1536², 0,135 $ jusqu'à 2048², + 0,0045 $ par image d'entrée au-delà de la première
    const cost = (width * height <= 1536 * 1536 ? 0.0675 : 0.135) + 0.0045 * Math.max(0, imageUrls.length - 1)
    return NextResponse.json({ imageUrl, cost })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue' }, { status: 500 })
  }
}
