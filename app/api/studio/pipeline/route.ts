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
        parts.push({ text: `MODEL BODY (mannequin "${mannequinLabel}") — use THIS exact body: morphology, build, height, proportions, curves, skin tone. ⚠ The HEAD MUST BE FULLY VISIBLE in the output (never cropped). Show the entire face, hair, neck.` })
        parts.push(await toInlinePart(mannequinBody))
      }
      if (mannequinFace) {
        parts.push({ text: `MODEL FACE — apply this exact face (eyes, nose, mouth, hair) on the body above. The face MUST be fully visible, never blurred, never cropped. Synthetic AI mannequin.` })
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
    const [subjectBufRaw, backgroundBuf] = await Promise.all([
      fetch(subjectRgbaUrl).then(r => r.arrayBuffer()).then(b => Buffer.from(b)),
      background.arrayBuffer().then(b => Buffer.from(b)),
    ])

    const bgMeta = await sharp(backgroundBuf).metadata()
    const bgW = bgMeta.width ?? 1024
    const bgH = bgMeta.height ?? 1536

    // ⚠ Pas de trim() : BiRefNet renvoie un PNG RGBA de la même taille que l'image Gemini source.
    // Le sujet réel est positionné EXACTEMENT à la même place que dans le visuel Gemini.
    // Comme Gemini et le fond ont le même aspectRatio, on resize juste pour matcher
    // les dimensions du fond → le sujet est placé naturellement au bon endroit.
    const subjectBuf = subjectBufRaw

    // Resize pour tenir dans le fond SANS déformation (fit:'inside' garde le ratio).
    // Si le ratio Gemini = ratio fond, le sujet remplira exactement bgW × bgH.
    // sharpen() léger pour récupérer la netteté perdue au resize, surtout autour du visage.
    let subjectFit = await sharp(subjectBuf)
      .resize({ width: bgW, height: bgH, fit: 'inside', withoutEnlargement: false, kernel: 'lanczos3' })
      .sharpen({ sigma: 0.8, m1: 0.4, m2: 1.5 })   // sharpen léger anti-flou
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

    // ============= OMBRE : déléguée à Flux Fill plus bas =============
    // L'ellipse SVG géométrique a été retirée — on délègue maintenant à un vrai
    // modèle de diffusion (Flux Fill) qui génère une ombre photoréaliste cohérente
    // avec la lumière de la scène.
    const fLow = (framing ?? '').toLowerCase()
    const hasFloor = !(fLow.includes('haut') || fLow.includes('upper') || fLow.includes('detail') || fLow.includes('macro'))

    // ============= ÉTAPE 3 — COMPOSITE via Photoroom API (sujet + fond + ombre AI) =============
    // Photoroom Image Editing API gère en 1 call :
    //   - le compositing sujet/fond
    //   - la génération d'une ombre AI réaliste (shadow.mode=ai.soft) qui s'adapte à la silhouette
    // C'est LE service de référence pour ce type d'effet → bien plus fiable que nos bricolages.
    let finalJpegBuf: Buffer
    let shadowAiUsed = false
    let shadowAiError: string | undefined

    const photoroomKey = process.env.PHOTOROOM_API_KEY
    const wantPhotoroom = hasFloor && !!photoroomKey

    if (wantPhotoroom) {
      try {
        // Photoroom utilise le MÊME endpoint pour sandbox + production.
        // C'est la clé API qui détermine le mode (sandbox keys = 100 calls gratuits).
        const photoroomUrl = 'https://image-api.photoroom.com/v2/edit'

        const form = new FormData()
        // Sujet détouré (RGBA déjà fait par BiRefNet)
        const subjectBlob = new Blob([new Uint8Array(subjectBuf)], { type: 'image/png' })
        form.append('imageFile', subjectBlob, 'subject.png')
        // Background Notion (paste-back pixel-perfect)
        const bgBlob = new Blob([new Uint8Array(backgroundBuf)], { type: 'image/jpeg' })
        form.append('background.imageFile', bgBlob, 'background.jpg')
        // Shadow AI mode (le truc qu'on cherche)
        form.append('shadow.mode', 'ai.soft')
        // Pas de padding (sujet placé tel que dans l'image)
        form.append('padding', '0')
        // Output JPEG quality
        form.append('outputFormat', 'jpg')
        form.append('quality', '92')

        console.log('[photoroom] calling ' + photoroomUrl + ' (keyLen=' + photoroomKey.length + ', keyPrefix=' + photoroomKey.slice(0, 8) + '…)')
        const res = await fetch(photoroomUrl, {
          method: 'POST',
          headers: { 'x-api-key': photoroomKey, 'Accept': 'image/jpeg, image/png' },
          body: form as any,
          // Timeout 90s pour laisser le temps à Photoroom
          signal: AbortSignal.timeout(90000),
        })

        if (!res.ok) {
          const errTxt = await res.text().catch(() => '')
          throw new Error(`Photoroom HTTP ${res.status}: ${errTxt.slice(0, 300)}`)
        }
        console.log('[photoroom] OK, content-type=' + res.headers.get('content-type'))

        const photoroomBuf = Buffer.from(await res.arrayBuffer())
        finalJpegBuf = await sharp(photoroomBuf)
          .jpeg({ quality: 90, progressive: false, mozjpeg: true })
          .toBuffer()
        shadowAiUsed = true
      } catch (err: any) {
        shadowAiError = err?.message ?? String(err)
        console.warn('[pipeline] Photoroom shadow failed, fallback sharp composite without shadow:', shadowAiError)
        // Fallback : composite simple sans ombre
        finalJpegBuf = await sharp(backgroundBuf)
          .composite([{ input: subjectFeathered, left, top, blend: 'over' }])
          .jpeg({ quality: 90, progressive: false, mozjpeg: true })
          .toBuffer()
      }
    } else {
      // Pas de clé Photoroom OU framing sans sol → composite simple sans ombre
      if (!photoroomKey) shadowAiError = 'PHOTOROOM_API_KEY manquante côté serveur'
      finalJpegBuf = await sharp(backgroundBuf)
        .composite([{ input: subjectFeathered, left, top, blend: 'over' }])
        .jpeg({ quality: 90, progressive: false, mozjpeg: true })
        .toBuffer()
    }

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
      debug: { geminiUrl, subjectRgbaUrl, mannequinLabel, decorLabel, bgW, bgH, subjW, subjH, shadowAiUsed, shadowAiError },
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

function describeFraming(framing: string): string {
  const f = (framing ?? '').toLowerCase()
  if (f.includes('haut') || f.includes('upper')) return 'upper body / bust shot'
  if (f.includes('mi'))                          return 'mid body / cowboy shot'
  if (f.includes('detail') || f.includes('macro')) return 'extreme macro on garment detail'
  return 'full body, head to feet'
}
