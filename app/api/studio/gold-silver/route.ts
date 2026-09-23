/**
 * Gold&Silver — génération lifestyle : IMAGE 1 = outfit porté, IMAGE 2 = visage mannequin,
 * prompt = REFERENCES + décor (Notion) + TECHNICAL. Entrée JSON avec URLs Blob.
 */
import { NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import sharp from 'sharp'
import { detectHead, maskHead } from '@/lib/faceMask'

export const maxDuration = 300
export const runtime = 'nodejs'

const GEMINI_SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const isUrl = (u: any) => typeof u === 'string' && /^https?:\/\//.test(u)
    const outfitUrls: string[] = (Array.isArray(body.outfitUrls) ? body.outfitUrls : (body.outfitUrl ? [body.outfitUrl] : [])).filter(isUrl)
    const faceUrl: string   = body.faceUrl ?? ''
    const bodyUrl: string   = isUrl(body.bodyUrl) ? body.bodyUrl : ''
    const detailUrls: string[] = (Array.isArray(body.detailUrls) ? body.detailUrls : (body.detailUrl ? [body.detailUrl] : [])).filter(isUrl)
    const prompt: string    = body.prompt ?? ''
    const ratio: string     = body.ratio ?? '2:3'
    const quality: string   = body.quality ?? '2K'
    const sku: string       = body.sku ?? ''
    const maskFaces: boolean = body.maskFaces !== false
    // mode 'back' : IMAGE 1 = visuel de face final (frontVisualUrl), outfitUrls = tenue vue de dos
    const mode: 'front' | 'back' = body.mode === 'back' ? 'back' : 'front'
    const closeup: boolean = body.framing === 'closeup'
    const frontVisualUrl: string = isUrl(body.frontVisualUrl) ? body.frontVisualUrl : ''

    if (outfitUrls.length === 0) return NextResponse.json({ error: 'Au moins une outfitUrl requise.' }, { status: 400 })
    if (mode === 'front' && !isUrl(faceUrl)) return NextResponse.json({ error: 'faceUrl requise.' }, { status: 400 })
    if (mode === 'back' && !frontVisualUrl)  return NextResponse.json({ error: 'frontVisualUrl requise en mode back.' }, { status: 400 })
    if (!prompt.trim())                  return NextResponse.json({ error: 'prompt requis.' }, { status: 400 })

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY manquante.' }, { status: 500 })

    // ===== Masquage tête (visage + cheveux) sur les photos de tenue PORTÉE =====
    // Vêtement à plat / packshot → aucune personne détectée → image inchangée.
    type OutfitPart = { part: any; masked: boolean; maskedUrl?: string; note?: string }
    const outfits: OutfitPart[] = []
    for (const u of outfitUrls) {
      const { buf, mime } = await fetchImage(u)
      if (!maskFaces) { outfits.push({ part: toPart(buf, mime), masked: false }); continue }
      const det = await detectHead(buf, mime, apiKey)
      if (!det.hasPerson) { outfits.push({ part: toPart(buf, mime), masked: false, note: det.error ? `détection échouée : ${det.error.slice(0, 80)}` : 'pas de personne (vêtement non porté)' }); continue }
      if (!det.box) { outfits.push({ part: toPart(buf, mime), masked: false, note: `⚠ non masqué : ${det.error ?? 'tête non localisée'}` }); continue }
      try {
        const m = await maskHead(buf, det.box)
        let maskedUrl: string | undefined
        try {
          const b = await put(`gold-silver-masked/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`, m.buf, {
            access: 'public', contentType: 'image/jpeg', cacheControlMaxAge: 300, token: process.env.BLOB_READ_WRITE_TOKEN,
          })
          maskedUrl = b.url
        } catch { /* vignette non disponible, on continue */ }
        outfits.push({ part: toPart(m.buf, m.mime), masked: true, maskedUrl })
      } catch (e: any) {
        outfits.push({ part: toPart(buf, mime), masked: false, note: `masquage échoué : ${e?.message ?? e}` })
      }
    }
    const anyMasked = outfits.some(o => o.masked)

    const sessionId = Date.now()
    const parts: any[] = [{ text: `[SESSION ${sessionId}]\n${prompt}` }]
    const nOut = outfits.length

    if (mode === 'back') {
      // IMAGE 1 = visuel de face final ; IMAGES 2..n+1 = tenue de dos
      if (anyMasked) {
        parts.push({ text: 'NOTE ON THE BACK-VIEW OUTFIT REFERENCES: the head of the person wearing the garment may be INTENTIONALLY pixelated. Ignore that person — the model is the one in IMAGE 1. Do not reproduce any pixelation.' })
      }
      parts.push({ text: '=== IMAGE 1 — FINAL FRONT PHOTOGRAPH: same model, same place, same light, same style to keep ===' })
      parts.push(await toInlinePart(frontVisualUrl))
      for (let i = 0; i < nOut; i++) {
        parts.push({ text: `=== IMAGE ${i + 2} — OUTFIT seen from the BACK${nOut > 1 ? ` (photo ${i + 1}/${nOut})` : ''} (reproduce the back of this garment exactly) ===` })
        parts.push(outfits[i].part)
      }
      parts.push({ text: `⚠ FINAL CHECK : ONE photograph from BEHIND · same model and same scene as IMAGE 1 · back of the garment identical to ${nOut === 1 ? 'IMAGE 2' : `IMAGES 2-${nOut + 1}`} · same shoes, feet fully visible · standing still, relaxed and composed (no walking) · same light, film look and mood as IMAGE 1 · no text, no collage.` })
    } else {
    if (anyMasked) {
      parts.push({ text: `NOTE ON THE OUTFIT REFERENCES: the head (face and hair) of the person wearing the garment has been INTENTIONALLY pixelated. Ignore that person entirely — she is NOT the model. The ONLY identity reference is the MODEL FACE image (IMAGE ${nOut + 1}). Do not reproduce any pixelation in the output.` })
    }
    for (let i = 0; i < nOut; i++) {
      parts.push({ text: nOut === 1
        ? '=== IMAGE 1 — OUTFIT, front view (reproduce this garment exactly) ==='
        : `=== IMAGE ${i + 1} — OUTFIT, photo ${i + 1}/${nOut} of the SAME garment worn ===` })
      parts.push(outfits[i].part)
    }
    const modelIdx = nOut + 1
    parts.push({ text: `=== IMAGE ${modelIdx} — MODEL FACE (preserve this exact identity) ===` })
    parts.push(await toInlinePart(faceUrl))
    let next = modelIdx + 1
    if (bodyUrl) {
      parts.push({ text: `=== IMAGE ${next} — MODEL BODY, same person (skin tone, build, silhouette — not the pose, not the background) ===` })
      parts.push(await toInlinePart(bodyUrl))
      next++
    }
    for (let i = 0; i < detailUrls.length; i++) {
      parts.push({ text: `=== IMAGE ${next + i} — CLOSE-UP DETAIL of the same garment (fidelity guide only — do NOT copy its framing) ===` })
      parts.push(await toInlinePart(detailUrls[i]))
    }
    parts.push({ text: closeup
      ? `⚠ FINAL CHECK : ONE front-view CLOSE-UP / upper mid-body photograph (head to hips at most, no legs, no feet, no shoes) · garment identical to ${nOut === 1 ? 'IMAGE 1' : `IMAGES 1-${nOut}`} (cut, color, print, details) · face identical to IMAGE ${modelIdx}, sharp · scene, light, film look and mood exactly as described · no text, no collage.`
      : `⚠ FINAL CHECK : ONE front-view photograph · garment identical to ${nOut === 1 ? 'IMAGE 1' : `IMAGES 1-${nOut}`} (cut, color, print, details) · same shoes, feet fully visible · face identical to IMAGE ${modelIdx} · TALL elongated model · scene, light, film look and mood exactly as described · no text, no collage.` })
    }

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
    return NextResponse.json({
      imageUrl, blobError,
      masks: outfits.map(o => ({ masked: o.masked, maskedUrl: o.maskedUrl, note: o.note })),
    })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue' }, { status: 500 })
  }
}

async function fetchImage(url: string): Promise<{ buf: Buffer; mime: string }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Image inaccessible (${res.status}) : ${url.slice(0, 80)}`)
  let mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim()
  let buf = Buffer.from(new Uint8Array(await res.arrayBuffer()))
  if (!GEMINI_SUPPORTED.has(mime)) {
    try { buf = await sharp(buf).jpeg({ quality: 90 }).toBuffer(); mime = 'image/jpeg' } catch { /* tel quel */ }
  }
  return { buf, mime }
}
function toPart(buf: Buffer, mime: string) {
  return { inlineData: { mimeType: mime, data: buf.toString('base64') } }
}
async function toInlinePart(url: string) {
  const { buf, mime } = await fetchImage(url)
  return toPart(buf, mime)
}
