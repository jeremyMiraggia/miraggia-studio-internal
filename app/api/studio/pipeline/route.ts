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
    // 'refs' = mode legacy utilisé pour les details (base du look + image détail)
    const refsLegacy     = formData.getAll('refs').filter((v): v is File => v instanceof File)
    const framing        = (formData.get('framing')        as string | null) ?? 'plein'
    const mannequinLabel = (formData.get('mannequinLabel') as string | null) ?? 'fashion model'
    const decorLabel     = (formData.get('decorLabel')     as string | null) ?? 'background'

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt requis.' }, { status: 400 })
    }
    // Pour les details (close-up macro), le fond est souvent flou/invisible → on tolère son absence
    const fLowEarly = (framing ?? '').toLowerCase()
    const isDetail = fLowEarly.includes('detail') || fLowEarly.includes('macro')
    if (!background && !isDetail) {
      return NextResponse.json({ error: 'background requis pour le paste-back (sauf detail).' }, { status: 400 })
    }

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY manquante côté serveur.' }, { status: 500 })
    }
    // FAL_KEY n'est plus nécessaire depuis qu'on n'utilise plus BiRefNet (Photoroom fait tout)

    // ============= ÉTAPE 1 — GEMINI (génère le sujet) =============
    // On envoie tout ce dont Gemini a besoin pour faire un beau mannequin habillé,
    // posé, cadré. Le fond importe peu — on l'écrasera après.
    const buildParts = async (): Promise<any[]> => {
      const parts: any[] = []
      const sessionId = Date.now()

      // === MODE LEGACY (utilisé pour les details) ===
      // Quand `refs` est rempli, on est en mode "détail" : le client envoie 1) une
      // image base du look déjà shooté, 2) une image du détail à zoomer.
      // Pas de mannequinBody/products structurés, juste le prompt + les 2 refs.
      if (refsLegacy.length > 0) {
        parts.push({ text: `[SESSION ${sessionId}]\n${prompt}` })
        // Les refs : 1ère = base du look, 2ème (si présente) = détail
        for (let i = 0; i < refsLegacy.length; i++) {
          const label = i === 0
            ? 'REFERENCE #1 — base of the full look already shot (model + outfit + scene).'
            : `REFERENCE #${i + 1} — detail to zoom on / highlight in the close-up.`
          parts.push({ text: label })
          parts.push(await toInlinePart(refsLegacy[i]))
        }
        return parts
      }

      // === MODE STRUCTURÉ (poses : plein, mi-corps, haut, bas) ===
      const intro = [
        `[SESSION ${sessionId}]`,
        'Generate a fashion editorial photograph. The output will be post-processed: the background will be replaced and a shadow will be added automatically. So focus 100% on these 4 things, in order of priority:',
        '  1) THE MODEL — exact body + face from the reference images.',
        '  2) THE GARMENT — reproduce every detail of the product reference(s) with absolute fidelity.',
        '  3) THE POSE — natural fashion editorial pose, fitting the framing.',
        '  4) THE FRAMING — respect the requested view exactly (full body / mid / upper / lower / detail).',
        '',
        'Background : just provide a neutral coherent scene matching the lighting tone. We do not need it to be perfect, it will be replaced.',
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

    const geminiRawBuf = Buffer.from(geminiImageB64, 'base64')

    // Récupère le background (peut être absent pour detail/macro)
    const backgroundBuf = background
      ? Buffer.from(new Uint8Array(await background.arrayBuffer()))
      : null

    const fLow = (framing ?? '').toLowerCase()
    const hasFloor = !(fLow.includes('haut') || fLow.includes('upper') || fLow.includes('detail') || fLow.includes('macro'))

    // ============= ÉTAPE 2+3 — PHOTOROOM (détourage + composite + ombre AI en 1 call) =============
    // Photoroom Image Editing API gère :
    //   - le détourage du sujet (segmentation propre, meilleure que BiRefNet sur les cheveux)
    //   - le compositing sur le background fourni
    //   - la génération d'une ombre AI cohérente (shadow.mode=ai.soft)
    // → Plus de halo autour du visage, plus rapide (-5s), moins cher (-$0.003/visuel).
    let finalJpegBuf: Buffer
    let shadowAiUsed = false
    let shadowAiError: string | undefined

    const photoroomKey = process.env.PHOTOROOM_API_KEY
    // Photoroom uniquement pour les framings avec sol (plein, mi-corps, bas).
    // Skip pour close-up haut & detail : on renvoie l'image Gemini brute (économie).
    const wantPhotoroom = !!photoroomKey && hasFloor

    if (wantPhotoroom) {
      try {
        const photoroomUrl = 'https://image-api.photoroom.com/v2/edit'

        const form = new FormData()
        // Image source = sortie Gemini brute (avec mannequin + faux fond)
        // Photoroom détoure le sujet, ignore le faux fond
        const geminiBlob = new Blob([new Uint8Array(geminiRawBuf)], { type: geminiMime })
        form.append('imageFile', geminiBlob, 'gemini.' + (geminiMime === 'image/png' ? 'png' : 'jpg'))
        // Background Notion (pixel-perfect) — toujours présent ici car hasFloor=true
        if (backgroundBuf) {
          const bgBlob = new Blob([new Uint8Array(backgroundBuf)], { type: 'image/jpeg' })
          form.append('background.imageFile', bgBlob, 'background.jpg')
        }
        // Shadow AI mode renforcé : ai.hard donne une ombre plus marquée que ai.soft
        form.append('shadow.mode', 'ai.hard')
        // ⚠ Ne PAS forcer padding=0 : Photoroom rescale alors le sujet pour
        // remplir le canvas, et la tête peut se retrouver coupée en haut.
        // On utilise referenceBox=originalImage pour que Photoroom garde la
        // position et l'échelle du sujet telles qu'elles sont dans l'image source.
        form.append('referenceBox', 'originalImage')
        // ⚠ Qualité max : PNG = zéro perte (lossless).
        // Évite la perte JPEG inhérente au format. Fichiers 3-5× plus gros mais
        // bande passante Vercel Blob a 100 GB/mois free donc OK pour ton volume.
        form.append('outputFormat', 'png')

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

        // ⚠ On utilise le buffer Photoroom DIRECTEMENT (pas de re-encode sharp).
        // Évite la double compression JPEG qui dégradait visiblement les détails.
        finalJpegBuf = Buffer.from(await res.arrayBuffer())
        shadowAiUsed = true
      } catch (err: any) {
        shadowAiError = err?.message ?? String(err)
        console.warn('[pipeline] Photoroom failed, fallback : image Gemini brute:', shadowAiError)
        // Fallback minimal : on renvoie l'image Gemini directement (avec son faux fond).
        // Pas idéal mais le visuel reste utilisable. Pour avoir le fond exact, il faut Photoroom.
        finalJpegBuf = await sharp(geminiRawBuf)
          .jpeg({ quality: 90, progressive: false, mozjpeg: true })
          .toBuffer()
      }
    } else if (!hasFloor) {
      // ============= BRANCHE close-up haut / detail =============
      // Pour ces framings, on n'utilise pas Photoroom (pas d'ombre nécessaire,
      // économie). À la place, on impose le fond Notion via l'ancienne méthode :
      //   BiRefNet (détoure le sujet) → sharp composite (paste-back sur le fond Notion)
      // Le fond reste pixel-perfect, le sujet est juste collé dessus, sans ombre.
      const falKey = process.env.FAL_KEY
      if (!falKey) {
        shadowAiError = `framing=${framing} : FAL_KEY manquante pour BiRefNet`
        finalJpegBuf = await sharp(geminiRawBuf)
          .jpeg({ quality: 90, progressive: false, mozjpeg: true })
          .toBuffer()
      } else {
        try {
          fal.config({ credentials: falKey })

          // 1. BiRefNet détoure le sujet Gemini
          const geminiFile = new File([new Uint8Array(geminiRawBuf)], 'gemini.png', { type: geminiMime })
          const geminiFalUrl = await fal.storage.upload(geminiFile)
          const rembgResult: any = await fal.subscribe('fal-ai/birefnet/v2', {
            input: { image_url: geminiFalUrl },
            logs: false,
          })
          const subjectRgbaUrl: string | undefined = rembgResult?.data?.image?.url ?? rembgResult?.image?.url
          if (!subjectRgbaUrl) throw new Error('BiRefNet n\'a pas renvoyé d\'image RGBA')

          // 2. Download sujet RGBA
          const subjectArrBuf = await fetch(subjectRgbaUrl).then(r => r.arrayBuffer())
          const subjectBuf = Buffer.from(new Uint8Array(subjectArrBuf))

          // 3. Composite : si on a un fond → paste-back. Sinon (detail sans fond) → sujet sur fond blanc.
          if (backgroundBuf) {
            const bgMeta = await sharp(backgroundBuf).metadata()
            const bgW = bgMeta.width ?? 1024
            const bgH = bgMeta.height ?? 1536
            const subjectFit = await sharp(subjectBuf)
              .resize({ width: bgW, height: bgH, fit: 'inside', withoutEnlargement: false, kernel: 'lanczos3' })
              .png()
              .toBuffer()
            finalJpegBuf = await sharp(backgroundBuf)
              .composite([{ input: subjectFit, blend: 'over' }])
              .jpeg({ quality: 90, progressive: false, mozjpeg: true })
              .toBuffer()
          } else {
            // Detail sans fond → on garde le sujet détouré sur fond Gemini original
            // (puisqu'on n'a pas de fond à imposer)
            finalJpegBuf = await sharp(geminiRawBuf)
              .jpeg({ quality: 90, progressive: false, mozjpeg: true })
              .toBuffer()
          }
          shadowAiError = `framing=${framing} : ancien pipeline (BiRefNet + paste-back fond Notion)`
        } catch (err: any) {
          shadowAiError = `BiRefNet/paste-back failed pour framing=${framing}: ${err?.message ?? err}`
          console.warn('[pipeline] BiRefNet paste-back failed, fallback Gemini brute:', shadowAiError)
          finalJpegBuf = await sharp(geminiRawBuf)
            .jpeg({ quality: 90, progressive: false, mozjpeg: true })
            .toBuffer()
        }
      }
    } else {
      // Pas de clé Photoroom et framing avec sol → fallback Gemini brute
      shadowAiError = 'PHOTOROOM_API_KEY manquante côté serveur'
      finalJpegBuf = await sharp(geminiRawBuf)
        .jpeg({ quality: 90, progressive: false, mozjpeg: true })
        .toBuffer()
    }

    // ============= ÉTAPE 4 — Upload Vercel Blob =============
    let imageUrl: string
    let blobError: string | undefined
    // Détecte le format réel du buffer final (PNG si Photoroom, JPEG si fallback)
    const isPng = finalJpegBuf.length >= 8
      && finalJpegBuf[0] === 0x89 && finalJpegBuf[1] === 0x50 && finalJpegBuf[2] === 0x4E && finalJpegBuf[3] === 0x47
    const outExt  = isPng ? 'png'        : 'jpg'
    const outMime = isPng ? 'image/png'  : 'image/jpeg'
    try {
      const path = `pipeline/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${outExt}`
      const blob = await put(path, finalJpegBuf, {
        access: 'public',
        contentType: outMime,
        cacheControlMaxAge: 60,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      })
      imageUrl = blob.url
    } catch (err: any) {
      const b64 = finalJpegBuf.toString('base64')
      imageUrl = `data:${outMime};base64,${b64}`
      blobError = err?.message ?? String(err)
    }

    return NextResponse.json({
      imageUrl,
      attempt: 1,
      debug: { mannequinLabel, decorLabel, shadowAiUsed, shadowAiError },
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
  if (f.includes('haut') || f.includes('upper')) return 'upper body / bust shot (head, shoulders, top of chest). Leave 5-10% headroom above the head — the top of the head must NOT touch the top edge of the frame.'
  if (f.includes('bas')  || f.includes('lower')) return 'lower body / legs only (from hips down to feet). Leave a small margin below the feet.'
  if (f.includes('mi'))                          return 'mid body / cowboy shot (from head to mid-thigh). Leave 5-10% headroom above the head.'
  if (f.includes('detail') || f.includes('macro')) return 'extreme macro on garment detail (no full body, no model context)'
  return 'full body, head to feet. ⚠ Leave comfortable headroom : 5-10% empty space above the head AND a small margin below the feet. The head must NOT touch the top edge of the frame. The feet must NOT touch the bottom edge of the frame. The model is fully visible with breathing space all around.'
}
