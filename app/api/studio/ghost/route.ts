/**
 * GHOST packshot pipeline.
 *
 * Workflow :
 *   1. Gemini 3 Pro Image génère le packshot du produit (le fond importe peu).
 *   2. BiRefNet (FAL.ai) détoure proprement le produit → RGBA.
 *   3. Sharp :
 *        a) crée un canvas BLANC PUR (#FFFFFF) au ratio demandé
 *        b) génère une ombre de contact douce sous le produit (drop shadow flou)
 *        c) colle le produit détouré dessus
 *   4. Upload Vercel Blob → renvoie l'URL au client.
 *
 * Garantit un fond 100% blanc sans aucun artefact, et un rendu packshot pro.
 */
import { NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { fal } from '@fal-ai/client'
import sharp from 'sharp'

export const maxDuration = 300
export const runtime = 'nodejs'

/** Dimensions canvas en fonction du ratio demandé. */
function canvasDimsForRatio(ratio: string): { w: number; h: number } {
  switch (ratio) {
    case '1:1':  return { w: 2048, h: 2048 }
    case '4:3':  return { w: 2048, h: 1536 }
    case '3:4':  return { w: 1536, h: 2048 }
    case '2:3':  return { w: 1536, h: 2304 }
    case '9:16': return { w: 1152, h: 2048 }
    case '16:9': return { w: 2048, h: 1152 }
    default:     return { w: 2048, h: 2048 }
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const prompt   = (formData.get('prompt')  as string | null)?.trim() ?? ''
    const ratio    = (formData.get('ratio')   as string | null) ?? '1:1'
    const quality  = (formData.get('quality') as string | null) ?? '2K'
    const refs     = formData.getAll('refs').filter((v): v is File => v instanceof File)

    if (!prompt) return NextResponse.json({ error: 'Prompt requis.' }, { status: 400 })
    if (refs.length === 0) return NextResponse.json({ error: 'Au moins une image de référence requise.' }, { status: 400 })

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY manquante.' }, { status: 500 })

    // ============= ÉTAPE 1 — GEMINI =============
    const sessionId = Date.now()
    const parts: any[] = []
    parts.push({ text: `[SESSION ${sessionId}]\n${prompt}\n\nNote : the background you generate will be REPLACED by a pure white background in post-processing. Focus 100% on the PRODUCT itself: its exact shape, colors, materials, stitching, logo, details. Reproduce the product EXACTLY as in the reference photos. Lighting should be soft and even.` })
    for (let i = 0; i < refs.length; i++) {
      parts.push({ text: `PRODUCT REFERENCE #${i + 1} (iPhone photo) — reproduce this product with absolute fidelity.` })
      parts.push(await toInlinePart(refs[i]))
    }

    const aspectRatio = ratio
    const imageSize   = quality === '4K' ? '4K' : quality === '1K' ? '1K' : '2K'
    const geminiBody = JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio, imageSize },
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
      ],
    })

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: geminiBody },
    )
    const geminiData: any = await geminiRes.json().catch(() => null)
    if (!geminiRes.ok) {
      return NextResponse.json({ error: geminiData?.error?.message || `Gemini HTTP ${geminiRes.status}`, raw: geminiData }, { status: geminiRes.status })
    }
    const candidate = geminiData?.candidates?.[0]
    const geminiParts = candidate?.content?.parts ?? []
    let geminiImageB64: string | null = null
    let geminiMime = 'image/png'
    for (const part of geminiParts) {
      if (part?.inlineData?.mimeType?.startsWith('image/')) {
        geminiImageB64 = part.inlineData.data
        geminiMime = part.inlineData.mimeType
        break
      }
    }
    if (!geminiImageB64) {
      const textResp = geminiParts.filter((p: any) => typeof p?.text === 'string').map((p: any) => p.text).join(' ').trim()
      return NextResponse.json({ error: `Gemini n'a pas renvoyé d'image. ${textResp.slice(0, 200)}` }, { status: 502 })
    }

    const geminiRawBuf = Buffer.from(geminiImageB64, 'base64')

    // ============= ÉTAPE 2 — BiRefNet (détourage du produit) =============
    const falKey = process.env.FAL_KEY
    if (!falKey) {
      return NextResponse.json({ error: 'FAL_KEY manquante côté serveur (nécessaire pour BiRefNet).' }, { status: 500 })
    }
    fal.config({ credentials: falKey })

    let subjectBuf: Buffer
    try {
      const geminiFile = new File([new Uint8Array(geminiRawBuf)], 'gemini.png', { type: geminiMime })
      const geminiFalUrl = await fal.storage.upload(geminiFile)
      const rembgResult: any = await fal.subscribe('fal-ai/birefnet/v2', {
        input: { image_url: geminiFalUrl },
        logs: false,
      })
      const subjectRgbaUrl: string | undefined = rembgResult?.data?.image?.url ?? rembgResult?.image?.url
      if (!subjectRgbaUrl) throw new Error('BiRefNet n\'a pas renvoyé d\'image RGBA')
      const subjectArrBuf = await fetch(subjectRgbaUrl).then(r => r.arrayBuffer())
      subjectBuf = Buffer.from(new Uint8Array(subjectArrBuf))
    } catch (err: any) {
      return NextResponse.json({ error: `BiRefNet : ${err?.message ?? err}` }, { status: 502 })
    }

    // ============= ÉTAPE 3 — Composite sur fond blanc pur + ombre de contact =============
    const { w: canvasW, h: canvasH } = canvasDimsForRatio(ratio)

    // Resize le sujet pour qu'il occupe ~88% de la dimension la plus courte,
    // centré, avec marge confortable (style packshot pro).
    const meta = await sharp(subjectBuf).metadata()
    const subjW = meta.width ?? 1024
    const subjH = meta.height ?? 1024
    const targetMaxSide = Math.round(Math.min(canvasW, canvasH) * 0.85)
    // Ajuste la taille en gardant le ratio
    const scale = Math.min(targetMaxSide / subjW, targetMaxSide / subjH)
    const newW = Math.round(subjW * scale)
    const newH = Math.round(subjH * scale)
    const subjectResized = await sharp(subjectBuf)
      .resize({ width: newW, height: newH, fit: 'inside', kernel: 'lanczos3' })
      .png()
      .toBuffer()

    // Position : centré horizontalement, centré verticalement (avec petit offset vers le bas)
    const offsetX = Math.round((canvasW - newW) / 2)
    const offsetY = Math.round((canvasH - newH) / 2)

    // === Ombre de contact douce ===
    // Technique : extraire le canal alpha du sujet → flouter → assombrir → décaler
    // légèrement vers le bas → composite SOUS le sujet sur le canvas blanc.
    let shadowComposite: { input: Buffer; left: number; top: number } | null = null
    try {
      // Récupère l'alpha
      const alphaBuf = await sharp(subjectResized)
        .ensureAlpha()
        .extractChannel('alpha')
        .toBuffer()
      // Crée une silhouette noire à partir de l'alpha (RGB noir + alpha = silhouette du sujet)
      const blackSilhouette = await sharp({
        create: { width: newW, height: newH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .composite([{ input: alphaBuf, raw: { width: newW, height: newH, channels: 1 }, blend: 'dest-in' }])
        .png()
        .toBuffer()
      // Flou + opacité réduite (~25%) pour ombre douce
      const shadowBlur = await sharp(blackSilhouette)
        .blur(28)
        .composite([{
          input: Buffer.from([0, 0, 0, Math.round(255 * 0.30)]),
          raw: { width: 1, height: 1, channels: 4 },
          tile: true,
          blend: 'dest-in',
        }])
        .png()
        .toBuffer()

      shadowComposite = {
        input: shadowBlur,
        left: offsetX,
        top: offsetY + Math.round(newH * 0.04),  // décale légèrement vers le bas
      }
    } catch (e) {
      console.warn('[ghost] shadow generation failed, skipping:', e)
    }

    // Composite final : fond blanc → ombre → sujet
    const composites: any[] = []
    if (shadowComposite) composites.push(shadowComposite)
    composites.push({ input: subjectResized, left: offsetX, top: offsetY })

    const finalBuf = await sharp({
      create: { width: canvasW, height: canvasH, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite(composites)
      .png({ compressionLevel: 9 })
      .toBuffer()

    // ============= ÉTAPE 4 — Upload Vercel Blob =============
    let imageUrl: string
    let blobError: string | undefined
    try {
      const path = `ghost/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
      const blob = await put(path, finalBuf, {
        access: 'public',
        contentType: 'image/png',
        cacheControlMaxAge: 60,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      })
      imageUrl = blob.url
    } catch (err: any) {
      const b64 = finalBuf.toString('base64')
      imageUrl = `data:image/png;base64,${b64}`
      blobError = err?.message ?? String(err)
    }

    return NextResponse.json({ imageUrl, blobError })

  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue', stack: error?.stack?.slice(0, 800) }, { status: 500 })
  }
}

async function toInlinePart(file: File) {
  const buf = Buffer.from(await file.arrayBuffer()).toString('base64')
  return { inlineData: { mimeType: file.type || 'image/jpeg', data: buf } }
}
