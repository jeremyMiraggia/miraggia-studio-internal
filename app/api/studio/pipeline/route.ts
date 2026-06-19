/**
 * Pipeline HYBRIDE : Gemini (pour le sujet) + paste-back fond original (pour la cohérence BG).
 *
 * Workflow (server-side) :
 *
 *   1. Gemini 3 Pro Image : génère le visuel complet (mannequin + vêtement + pose + cadrage).
 *      Le fond du visuel Gemini est "ce que Gemini a inventé" — on s'en fout, on va l'écraser.
 *      → On bénéficie de toute la qualité Gemini sur le sujet (vêtement, pose, multi-vues).
 *
 *   2. BiRefNet (FAL.ai) : détoure le sujet du visuel Gemini → image RGBA propre.
 *
 *   3. Composite paste-back (sharp, server) :
 *        final = subject_rgba composited ON background_notion
 *      Le fond Notion reste BIT-EXACT pixel-perfect, seul le sujet est neuf.
 *      Feathering ~6px sur le bord du masque pour éviter le halo.
 *
 *   4. Upload Vercel Blob → renvoie URL au client.
 */
import { NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { fal } from '@fal-ai/client'
import sharp from 'sharp'

export const maxDuration = 300
export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const prompt   = (formData.get('prompt')  as string | null)?.trim() ?? ''
    const ratio    = (formData.get('ratio')   as string | null) ?? '9:16'
    const quality  = (formData.get('quality') as string | null) ?? '2K'

    const mannequinBody  = formData.get('mannequinBody') as File | null
    const mannequinFace  = formData.get('mannequinFace') as File | null
    const background     = formData.get('background')    as File | null
    const products       = formData.getAll('products').filter((v): v is File => v instanceof File)
    const framing        = (formData.get('framing')        as string | null) ?? 'plein'
    const mannequinLabel = (formData.get('mannequinLabel') as string | null) ?? 'fashion model'
    const decorLabel     = (formData.get('decorLabel')     as string | null) ?? 'background'

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt requis.' }, { status: 400 })
    }
    if (!background) {
      return NextResponse.json({ error: 'background requis pour le paste-back.' }, { status: 400 })
    }

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY manquante côté serveur.' }, { status: 500 })
    }
    const falKey = process.env.FAL_KEY
    if (!falKey) {
      return NextResponse.json({ error: 'FAL_KEY manquante côté serveur.' }, { status: 500 })
    }

    // ============= ÉTAPE 1 — GEMINI (génère le sujet) =============
    // On envoie tout ce dont Gemini a besoin pour faire un beau mannequin habillé,
    // posé, cadré. Le fond importe peu — on l'écrasera après.
    const buildParts = async (): Promise<any[]> => {
      const parts: any[] = []
      const sessionId = Date.now()
      const intro = [
        `[SESSION ${sessionId}]`,
        'Generate a fashion editorial photograph. Priority order:',
        '  1) THE MODEL — exact body + face from the reference images.',
        '  2) THE GARMENT — reproduce every detail of the product reference(s).',
        '  3) THE POSE — natural fashion editorial pose, fitting the framing.',
        '  4) THE FRAMING — respect the requested view exactly.',
        '  5) THE BACKGROUND — match the lighting & color tone of the reference background (the background will be replaced post-generation, but the model lighting must look natural in it).',
        '',
        '— Project-specific prompt —',
        prompt,
      ].join('\n')
      parts.push({ text: intro })

      // Background en 1er pour donner le ton lumineux/colorimétrique
      if (background) {
        parts.push({ text: `BACKGROUND REFERENCE (decor "${decorLabel}") — match the lighting and atmosphere of this scene. The model must look like it belongs in this setting.` })
        parts.push(await toInlinePart(background))
      }
      if (mannequinBody) {
        parts.push({ text: `MODEL BODY (mannequin "${mannequinLabel}") — use THIS exact body: morphology, build, height, proportions, curves, skin tone.` })
        parts.push(await toInlinePart(mannequinBody))
      }
      if (mannequinFace) {
        parts.push({ text: `MODEL FACE — apply this exact face on the body above. Synthetic AI mannequin.` })
        parts.push(await toInlinePart(mannequinFace))
      }
      if (products.length) {
        parts.push({ text: `GARMENT${products.length > 1 ? 'S' : ''} — reproduce every detail with absolute fidelity.` })
        for (const f of products) parts.push(await toInlinePart(f))
      }
      parts.push({ text: `FRAMING: ${describeFraming(framing)}` })
      return parts
    }

    const aspectRatio = ratio
    const imageSize   = quality === '4K' ? '4K' : quality === '1K' ? '1K' : '2K'
    const geminiBody = JSON.stringify({
      contents: [{ parts: await buildParts() }],
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
      return NextResponse.json({ error: `Gemini n'a pas renvoyé d'image. ${textResp.slice(0, 200)}`, raw: geminiData }, { status: 502 })
    }

    // ⚠ Pas de recompression : on envoie l'image Gemini brute à FAL.
    // compressGeminiImage produisait des artefacts scanlines.
    const geminiRawBuf = Buffer.from(geminiImageB64, 'base64')
    const geminiExt = geminiMime === 'image/png' ? 'png' : 'jpg'

    // ============= ÉTAPE 2 — BiRefNet (détoure le sujet) =============
    fal.config({ credentials: falKey })

    // Upload l'image Gemini vers FAL pour BiRefNet
    const geminiFile = new File([geminiRawBuf], 'gemini.' + geminiExt, { type: geminiMime })
    const geminiUrl  = await fal.storage.upload(geminiFile)

    const rembgResult: any = await fal.subscribe('fal-ai/birefnet/v2', {
      input: { image_url: geminiUrl },
      logs: false,
    })
    const subjectRgbaUrl: string | undefined = rembgResult?.data?.image?.url ?? rembgResult?.image?.url
    if (!subjectRgbaUrl) {
      return NextResponse.json({ error: 'BiRefNet n\'a pas renvoyé d\'image RGBA.', raw: rembgResult }, { status: 502 })
    }

    // ============= ÉTAPE 3 — Paste-back =============
    const [subjectBuf, backgroundBuf] = await Promise.all([
      fetch(subjectRgbaUrl).then(r => r.arrayBuffer()).then(b => Buffer.from(b)),
      background.arrayBuffer().then(b => Buffer.from(b)),
    ])

    const bgMeta = await sharp(backgroundBuf).metadata()
    const bgW = bgMeta.width ?? 1024
    const bgH = bgMeta.height ?? 1536

    // ⚠ Ici le sujet (Gemini) a une taille proche du fond (même ratio aspectRatio) —
    // on resize juste pour faire matcher EXACTEMENT les dimensions du fond.
    // Pas de scaling artificiel, le sujet est censé occuper la même zone que dans le visuel Gemini.
    let subjectFit = await sharp(subjectBuf)
      .resize({ width: bgW, height: bgH, fit: 'inside', withoutEnlargement: false })
      .png()
      .toBuffer()

    // ⚠ featherAlpha désactivé temporairement : il produisait des scanlines.
    // Le bord sera un peu plus dur mais l'image sera propre.
    let subjectFeathered = subjectFit
    const subjMeta = await sharp(subjectFeathered).metadata()
    let subjW = Math.min(subjMeta.width ?? bgW, bgW)
    let subjH = Math.min(subjMeta.height ?? bgH, bgH)

    if ((subjMeta.width ?? 0) > bgW || (subjMeta.height ?? 0) > bgH) {
      subjectFeathered = await sharp(subjectFeathered).resize({ width: bgW, height: bgH, fit: 'inside' }).png().toBuffer()
      const m2 = await sharp(subjectFeathered).metadata()
      subjW = Math.min(m2.width ?? bgW, bgW)
      subjH = Math.min(m2.height ?? bgH, bgH)
    }

    // Position : centré horizontalement, ancré en bas (les pieds touchent le bord bas du fond)
    const left = Math.max(0, Math.round((bgW - subjW) / 2))
    const top  = Math.max(0, bgH - subjH)

    const finalJpegBuf = await sharp(backgroundBuf)
      .composite([{ input: subjectFeathered, left, top, blend: 'over' }])
      .jpeg({ quality: 90, progressive: false, mozjpeg: true })
      .toBuffer()

    // ============= ÉTAPE 4 — Upload Vercel Blob =============
    let imageUrl: string
    let blobError: string | undefined
    try {
      const path = `pipeline/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
      const blob = await put(path, finalJpegBuf, {
        access: 'public',
        contentType: 'image/jpeg',
        cacheControlMaxAge: 60,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      })
      imageUrl = blob.url
    } catch (err: any) {
      const b64 = finalJpegBuf.toString('base64')
      imageUrl = `data:image/jpeg;base64,${b64}`
      blobError = err?.message ?? String(err)
    }

    return NextResponse.json({
      imageUrl,
      attempt: 1,
      debug: { geminiUrl, subjectRgbaUrl, mannequinLabel, decorLabel, bgW, bgH, subjW, subjH },
      blobError,
    })

  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue', stack: error?.stack?.slice(0, 800) }, { status: 500 })
  }
}

/* ============================== helpers ============================== */

async function toInlinePart(file: File) {
  const buf = Buffer.from(await file.arrayBuffer()).toString('base64')
  return { inlineData: { mimeType: file.type || 'image/jpeg', data: buf } }
}

async function featherAlpha(rgbaBuf: Buffer, radius: number): Promise<Buffer> {
  const { data, info } = await sharp(rgbaBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  if (channels !== 4) return rgbaBuf

  const alphaBuf = Buffer.alloc(width * height)
  for (let i = 0; i < width * height; i++) {
    alphaBuf[i] = data[i * 4 + 3]
  }
  const alphaBlurred = await sharp(alphaBuf, { raw: { width, height, channels: 1 } })
    .blur(radius)
    .raw()
    .toBuffer()

  const out = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    out[i * 4]     = data[i * 4]
    out[i * 4 + 1] = data[i * 4 + 1]
    out[i * 4 + 2] = data[i * 4 + 2]
    out[i * 4 + 3] = alphaBlurred[i]
  }
  return await sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer()
}

function describeFraming(framing: string): string {
  const f = (framing ?? '').toLowerCase()
  if (f.includes('haut') || f.includes('upper')) return 'upper body / bust shot'
  if (f.includes('bas')  || f.includes('lower')) return 'lower body / legs only'
  if (f.includes('mi'))                          return 'mid body / cowboy shot'
  if (f.includes('detail') || f.includes('macro')) return 'extreme macro on garment detail'
  return 'full body, head to feet'
}
