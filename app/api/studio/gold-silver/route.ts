/**
 * Gold&Silver — génération lifestyle : IMAGE 1 = outfit porté, IMAGE 2 = visage mannequin,
 * prompt = REFERENCES + décor (Notion) + TECHNICAL. Entrée JSON avec URLs Blob.
 */
import { NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import sharp from 'sharp'

export const maxDuration = 300
export const runtime = 'nodejs'

const GEMINI_SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const outfitUrl: string = body.outfitUrl ?? ''
    const faceUrl: string   = body.faceUrl ?? ''
    const prompt: string    = body.prompt ?? ''
    const ratio: string     = body.ratio ?? '2:3'
    const quality: string   = body.quality ?? '2K'
    const sku: string       = body.sku ?? ''

    if (!/^https?:\/\//.test(outfitUrl)) return NextResponse.json({ error: 'outfitUrl requise.' }, { status: 400 })
    if (!/^https?:\/\//.test(faceUrl))   return NextResponse.json({ error: 'faceUrl requise.' }, { status: 400 })
    if (!prompt.trim())                  return NextResponse.json({ error: 'prompt requis.' }, { status: 400 })

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY manquante.' }, { status: 500 })

    const sessionId = Date.now()
    const parts: any[] = [
      { text: `[SESSION ${sessionId}]\n${prompt}` },
      { text: '=== IMAGE 1 — OUTFIT (reproduce this garment exactly) ===' },
      await toInlinePart(outfitUrl),
      { text: '=== IMAGE 2 — MODEL (preserve this exact identity) ===' },
      await toInlinePart(faceUrl),
      { text: '⚠ FINAL CHECK : garment identical to IMAGE 1 (cut, color, print, details) · face identical to IMAGE 2 · scene, light, film look and mood exactly as described · one photograph, no text, no collage.' },
    ]

    const imageSize = quality === '4K' ? '4K' : quality === '1K' ? '1K' : '2K'
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${apiKey}`,
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: ratio, imageSize } },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
          ],
        }),
      },
    )
    const data: any = await geminiRes.json().catch(() => null)
    if (!geminiRes.ok) return NextResponse.json({ error: data?.error?.message || `Gemini HTTP ${geminiRes.status}` }, { status: geminiRes.status })
    const gParts = data?.candidates?.[0]?.content?.parts ?? []
    let b64: string | null = null, mime = 'image/png'
    for (const p of gParts) if (p?.inlineData?.mimeType?.startsWith('image/')) { b64 = p.inlineData.data; mime = p.inlineData.mimeType; break }
    if (!b64) {
      const txt = gParts.filter((p: any) => typeof p?.text === 'string').map((p: any) => p.text).join(' ').slice(0, 300)
      return NextResponse.json({ error: `Gemini sans image. ${txt}` }, { status: 502 })
    }

    const raw = Buffer.from(b64, 'base64')
    let finalBuf: Buffer = raw, finalMime = mime
    try { finalBuf = await sharp(raw).jpeg({ quality: 94, progressive: true, mozjpeg: true }).toBuffer(); finalMime = 'image/jpeg' } catch { /* raw */ }

    let imageUrl: string, blobError: string | undefined
    try {
      const blob = await put(`gold-silver/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${(sku || 'look').replace(/[^\w-]+/g, '_')}.${finalMime === 'image/png' ? 'png' : 'jpg'}`, finalBuf, {
        access: 'public', contentType: finalMime, cacheControlMaxAge: 60, token: process.env.BLOB_READ_WRITE_TOKEN,
      })
      imageUrl = blob.url
    } catch (e: any) {
      imageUrl = `data:${finalMime};base64,${finalBuf.toString('base64')}`
      blobError = e?.message ?? String(e)
    }
    return NextResponse.json({ imageUrl, blobError })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue' }, { status: 500 })
  }
}

async function toInlinePart(url: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Image inaccessible (${res.status}) : ${url.slice(0, 80)}`)
  let mime = res.headers.get('content-type') ?? 'image/jpeg'
  let buf = Buffer.from(new Uint8Array(await res.arrayBuffer()))
  if (!GEMINI_SUPPORTED.has(mime)) {
    try { buf = await sharp(buf).jpeg({ quality: 90 }).toBuffer(); mime = 'image/jpeg' } catch { /* tel quel */ }
  }
  return { inlineData: { mimeType: mime, data: buf.toString('base64') } }
}
