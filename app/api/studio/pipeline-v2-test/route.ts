/**
 * Pipeline V2 (POC test) — Gemini + BiRefNet + IC-Light pour lumière cohérente.
 *
 * Objectif : générer des visuels où la lumière du mannequin matche STRICTEMENT
 * celle du fond fourni (résout les 4 pbs : lumière, détourage, placement, ombres).
 *
 * Workflow :
 *   1. Gemini 3 Pro Image → draft (mannequin + tenue + pose + cadrage)
 *   2. BiRefNet HR → détourage propre du sujet
 *   3. Composite intelligent sur le fond user (placement selon framing)
 *   4. IC-Light v2 (FAL) → ré-illumine le sujet pour matcher la lumière du fond
 *   5. Upload Vercel Blob
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
    const background    = formData.get('background')    as File | null
    const mannequinBody = formData.get('mannequinBody') as File | null
    const mannequinFace = formData.get('mannequinFace') as File | null
    const products      = formData.getAll('products').filter((v): v is File => v instanceof File)
    const framing       = (formData.get('framing') as string | null) ?? 'plein'
    const ratio         = (formData.get('ratio')   as string | null) ?? '9:16'
    const quality       = (formData.get('quality') as string | null) ?? '2K'
    const userPrompt    = (formData.get('prompt')  as string | null) ?? ''

    if (!background)    return NextResponse.json({ error: 'background requis.' },    { status: 400 })
    if (!mannequinBody) return NextResponse.json({ error: 'mannequinBody requis.' }, { status: 400 })

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY manquante.' }, { status: 500 })
    const falKey = process.env.FAL_KEY
    if (!falKey) return NextResponse.json({ error: 'FAL_KEY manquante.' }, { status: 500 })
    fal.config({ credentials: falKey })

    const debug: any = { steps: {} }

    // ============= ÉTAPE 1 — GEMINI (draft mannequin+tenue+pose) =============
    const sessionId = Date.now()
    // === Extraire la teinte dominante du fond user pour briefer Gemini ===
    // On échantillonne le haut-centre du fond (zone "mur uniforme")
    const bgPreview = await background.arrayBuffer()
    const bgColor = await extractDominantBackgroundColor(Buffer.from(new Uint8Array(bgPreview)))
    const bgHex = rgbToHex(bgColor.r, bgColor.g, bgColor.b)
    debug.steps.targetBgColor = { hex: bgHex, ...bgColor }

    const intro = [
      `[SESSION ${sessionId}]`,
      'Generate a fashion editorial photograph of the model wearing the provided garments.',
      '⚠ Output will be POST-PROCESSED : the model will be cut out and placed on the EXACT background shown as REFERENCE below.',
      'Focus on : (1) the model identity, (2) the garments fidelity, (3) the pose, (4) the framing, (5) the BACKGROUND MATCHING.',
      '',
      `⚠ CRITICAL — BACKGROUND : generate the model on a background that EXACTLY MATCHES the color and ambient of the BACKGROUND REFERENCE image attached below. The dominant color of this reference is ${bgHex} (a soft neutral tone).`,
      `Reproduce the SAME background color (${bgHex}), the SAME ambient lighting, the SAME texture / softness as in the reference.`,
      'The background should be uniform (flat, no decor, no floor line, no gradient), matching the reference tone.',
      'This is CRUCIAL : the matting algorithm preserves a few pixels of the original background in fine details (hair, fabric edges). If your background color matches the final scene, this halo will be INVISIBLE. If it does not match, a visible halo will ruin the result.',
      '',
      '⚠ MARGIN : leave at LEAST 15% empty background space on EACH side of the model (left, right, top, bottom). The model must NOT touch the edges of the frame. This empty margin is required for the post-processing matting algorithm to work properly.',
      '',
      'FABRIC : all fabrics MUST appear properly ironed and crisp, no wrinkles.',
      '',
      `Project prompt : ${userPrompt || '(none)'}`,
      // ⚠ On demande TOUJOURS un plein-pied à Gemini, peu importe le framing demandé.
      // Le crop au framing voulu est fait à la fin sur l'image finale.
      `FRAMING : ${describeFraming('plein')}`,
    ].join('\n')

    const parts: any[] = [{ text: intro }]

    // ★ Image fond user passée en référence visuelle à Gemini
    parts.push({ text: `BACKGROUND REFERENCE — match the color (${bgHex}) and ambient of this background. Generate the model on a similar uniform background.` })
    parts.push(await toInlinePart(background))

    // ⚠ HACK MORPHOLOGIE : pré-étire verticalement la photo body de +30% avant
    // de l'envoyer à Gemini. Il "voit" un mannequin déjà top-model et reproduit.
    let bodyToSend = mannequinBody
    try {
      const bodyBuf = Buffer.from(new Uint8Array(await mannequinBody.arrayBuffer()))
      const meta = await sharp(bodyBuf).metadata()
      const w = meta.width ?? 1000
      const h = meta.height ?? 1500
      const stretchedH = Math.round(h * 1.30)
      const stretchedBuf = await sharp(bodyBuf)
        .resize({ width: w, height: stretchedH, fit: 'fill', kernel: 'lanczos3' })
        .png()
        .toBuffer()
      bodyToSend = new File([new Uint8Array(stretchedBuf)], 'body_stretched.png', { type: 'image/png' })
      debug.steps.bodyStretch = { originalH: h, stretchedH, factor: 1.30 }
    } catch (e: any) {
      debug.steps.bodyStretch = { error: e?.message ?? String(e) }
    }
    parts.push({ text: 'MODEL BODY — this reference has been PRE-STRETCHED to show the exact tall top-model proportions we want. Use it for IDENTITY (face, skin, hair) AND for MORPHOLOGY (reproduce these elongated top-model proportions faithfully). Do NOT normalize the proportions back to average — keep them as elongated as in this reference.' })
    parts.push(await toInlinePart(bodyToSend))
    if (mannequinFace) {
      parts.push({ text: 'MODEL FACE — apply this exact face : eyes, nose, mouth, hair. FULLY visible.' })
      parts.push(await toInlinePart(mannequinFace))
    }
    if (products.length) {
      parts.push({ text: `GARMENT${products.length > 1 ? 'S' : ''} — ISOLATED PRODUCT PACKSHOT${products.length > 1 ? 'S' : ''} (photographed alone, filling their frame). ⚠ Their scale / size in the frame is IRRELEVANT to the model's height — do NOT use them as size references. The model stays very TALL and ELONGATED. Simply resize these garments onto the tall model's body. Reproduce every detail with absolute fidelity.` })
      for (const f of products) parts.push(await toInlinePart(f))
    }

    const imageSize = quality === '4K' ? '4K' : quality === '1K' ? '1K' : '2K'
    const geminiBody = JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: ratio, imageSize },
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
      return NextResponse.json({ error: geminiData?.error?.message || `Gemini HTTP ${geminiRes.status}` }, { status: geminiRes.status })
    }
    const geminiParts = geminiData?.candidates?.[0]?.content?.parts ?? []
    let geminiB64: string | null = null
    let geminiMime = 'image/png'
    for (const p of geminiParts) {
      if (p?.inlineData?.mimeType?.startsWith('image/')) {
        geminiB64 = p.inlineData.data
        geminiMime = p.inlineData.mimeType
        break
      }
    }
    if (!geminiB64) return NextResponse.json({ error: 'Gemini sans image.' }, { status: 502 })
    const geminiBuf = Buffer.from(geminiB64, 'base64')
    debug.steps.gemini = { mime: geminiMime, bytes: geminiBuf.length }

    // ============= ÉTAPE 2 — Choix de la méthode d'ombre =============
    // shadowMode : 'photoroom-soft' (default) | 'photoroom-hard' | 'custom'
    const shadowMode = (formData.get('shadowMode') as string | null) ?? 'photoroom-soft'
    debug.steps.shadowMode = shadowMode

    // ⚠ On ne crop PLUS le fond avant Photoroom. Le crop se fait sur l'image
    // finale (après composition Photoroom) selon le framing. Comme ça :
    //   - Gemini génère toujours plein-pied (cadrage simple, peu ambigu)
    //   - Photoroom compose sur le fond user complet (ratio cohérent)
    //   - Sharp crop ENSUITE pour produire le framing voulu
    const bgArrBuf = await background.arrayBuffer()
    const bgBuf = Buffer.from(new Uint8Array(bgArrBuf))
    const bgMeta = await sharp(bgBuf).metadata()
    const bgW = bgMeta.width ?? 1024, bgH = bgMeta.height ?? 1536

    // ============= MODE PHOTOROOM (recommandé) =============
    if (shadowMode === 'photoroom-soft' || shadowMode === 'photoroom-hard') {
      const photoroomKey = process.env.PHOTOROOM_API_KEY
      if (!photoroomKey) {
        return NextResponse.json({ error: 'PHOTOROOM_API_KEY manquante (requise pour shadowMode photoroom).' }, { status: 500 })
      }

      // === PRE-PROCESS : harmoniser le fond Gemini vers la teinte du fond user ===
      // Au lieu de forcer en blanc pur, on force vers la couleur dominante du fond user.
      // Comme ça, même si Photoroom laisse un halo résiduel autour des cheveux,
      // il sera de la MÊME teinte que le fond user → invisible au compositing.
      let geminiBufClean: Buffer = geminiBuf
      try {
        geminiBufClean = await harmonizeBackground(geminiBuf, bgColor.r, bgColor.g, bgColor.b)
        debug.steps.harmonizeBg = { ok: true, target: bgHex }
      } catch (e: any) {
        debug.steps.harmonizeBg = { error: e?.message ?? String(e), fallback: 'gemini raw' }
      }

      try {
        const form = new FormData()
        // imageFile = sujet Gemini avec fond blanchi (matting plus propre)
        const geminiBlob = new Blob([new Uint8Array(geminiBufClean)], { type: 'image/png' })
        form.append('imageFile', geminiBlob, 'gemini.png')
        // background.imageFile = fond user (Photoroom le préserve pixel-perfect)
        const bgBlob = new Blob([new Uint8Array(bgBuf)], { type: 'image/png' })
        form.append('background.imageFile', bgBlob, 'background.png')

        // SHADOW : ai.soft = ombre subtile et naturelle (le user veut ça)
        //          ai.hard = ombre plus marquée
        form.append('shadow.mode', shadowMode === 'photoroom-soft' ? 'ai.soft' : 'ai.hard')

        // Préserve position et taille du sujet telles qu'elles sont dans Gemini.
        // Comme Gemini génère sur fond blanc avec sujet centré, Photoroom va
        // placer le sujet ~au centre du fond user.
        // Note : le slider horizonPct ne fonctionne QUE pour le mode custom (le contrôle
        // de placement précis via Photoroom v2 padding/alignment cause des erreurs).
        form.append('referenceBox', 'originalImage')
        debug.steps.photoroom_placement = { mode: 'originalImage', note: 'horizon slider ignored in Photoroom mode' }

        // PNG lossless pour qualité max
        form.append('outputFormat', 'png')

        console.log(`[pipeline-v2] Photoroom call (shadow=${shadowMode})`)
        const res = await fetch('https://image-api.photoroom.com/v2/edit', {
          method: 'POST',
          headers: { 'x-api-key': photoroomKey, 'Accept': 'image/png' },
          body: form as any,
          signal: AbortSignal.timeout(90000),
        })
        if (!res.ok) {
          const errTxt = await res.text().catch(() => '')
          throw new Error(`Photoroom HTTP ${res.status}: ${errTxt.slice(0, 300)}`)
        }
        let finalBuf = Buffer.from(new Uint8Array(await res.arrayBuffer()))
        debug.steps.photoroom = { ok: true, bytes: finalBuf.length, mode: shadowMode }

        // === CROP FINAL selon framing (côté serveur, après Photoroom) ===
        // Sauté si le client a déjà adapté le fond pour le framing (skipFinalCrop=1).
        const skipFinalCrop = formData.get('skipFinalCrop') === '1'
        try {
          if (skipFinalCrop) {
            debug.steps.finalCrop = { skipped: 'client provided framing-adapted background' }
            // pas de crop, finalBuf reste tel quel
            // (mais on continue vers l'upload Blob)
          } else {
          const finalMeta = await sharp(finalBuf).metadata()
          const fW = finalMeta.width ?? bgW, fH = finalMeta.height ?? bgH
          const fLow = framing.toLowerCase()
          let cropTop = 0, cropHeight = fH
          if (fLow.includes('haut') || fLow.includes('upper')) {
            // Close-up haut style e-commerce : head to hips/waist
            // On veut voir la TENUE complète du haut (col, manches, ourlet du top, hanches)
            cropHeight = Math.round(fH * 0.82)
            cropTop = 0
          } else if (fLow.includes('mi')) {
            // Mi-corps : head to mid-thigh (un peu plus bas que close-up haut)
            cropHeight = Math.round(fH * 0.92)
            cropTop = 0
          } else if (fLow.includes('bas') || fLow.includes('lower')) {
            // Close-up bas : hips to feet
            cropHeight = Math.round(fH * 0.50)
            cropTop = fH - cropHeight
          }
          if (cropHeight !== fH || cropTop !== 0) {
            finalBuf = await sharp(finalBuf)
              .extract({ left: 0, top: cropTop, width: fW, height: cropHeight })
              .png().toBuffer()
            debug.steps.finalCrop = { framing, cropTop, cropHeight, originalH: fH }
          } else {
            debug.steps.finalCrop = { framing, skipped: 'plein-pied' }
          }
          }  // end else (skipFinalCrop)
        } catch (e: any) {
          debug.steps.finalCrop = { error: e?.message ?? String(e) }
        }

        // Upload Vercel Blob + return
        let imageUrl: string
        let blobError: string | undefined
        try {
          const path = `pipeline-v2-test/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
          const blob = await put(path, finalBuf, {
            access: 'public', contentType: 'image/png', cacheControlMaxAge: 60,
            token: process.env.BLOB_READ_WRITE_TOKEN,
          })
          imageUrl = blob.url
        } catch (err: any) {
          imageUrl = `data:image/png;base64,${finalBuf.toString('base64')}`
          blobError = err?.message ?? String(err)
        }
        return NextResponse.json({ imageUrl, debug, blobError })
      } catch (err: any) {
        // NE PAS fallback silencieusement — le user a explicitement choisi Photoroom.
        // On renvoie une erreur claire avec le détail pour qu'il sache pourquoi ça plante.
        console.error('[pipeline-v2] Photoroom failed:', err?.message, err)
        return NextResponse.json({
          error: `Photoroom (${shadowMode}) a échoué : ${err?.message ?? err}`,
          debug,
        }, { status: 502 })
      }
    }

    // ============= MODE CUSTOM (fallback ou choix explicite) =============
    // BiRefNet → composite manuel + ombre custom
    const geminiFile = new File([new Uint8Array(geminiBuf)], 'gemini.png', { type: geminiMime })
    const geminiFalUrl = await fal.storage.upload(geminiFile)
    const rembgResult: any = await fal.subscribe('fal-ai/birefnet/v2', {
      input: { image_url: geminiFalUrl }, logs: false,
    })
    const subjectRgbaUrl: string | undefined = rembgResult?.data?.image?.url ?? rembgResult?.image?.url
    if (!subjectRgbaUrl) return NextResponse.json({ error: 'BiRefNet sans image.' }, { status: 502 })
    const subjectArrBuf = await fetch(subjectRgbaUrl).then(r => r.arrayBuffer())
    const subjectBuf = Buffer.from(new Uint8Array(subjectArrBuf))
    debug.steps.birefnet = { bytes: subjectBuf.length }

    // ============= ÉTAPE 3 — Composite sujet sur fond user =============
    // (bgBuf, bgW, bgH déjà calculés plus haut)

    // Trouve la bounding box du sujet pour le cropper proprement
    const bbox = await findAlphaBoundingBox(subjectBuf, 20)
    if (!bbox || bbox.width < 10) {
      return NextResponse.json({ error: 'Sujet non détecté après détourage.' }, { status: 502 })
    }
    const subjectTight = await sharp(subjectBuf)
      .extract({ left: bbox.left, top: bbox.top, width: bbox.width, height: bbox.height })
      .png().toBuffer()

    // Placement intelligent selon framing
    const fLow = framing.toLowerCase()
    const isFullBody    = !fLow.includes('haut') && !fLow.includes('upper') && !fLow.includes('mi') && !fLow.includes('bas') && !fLow.includes('lower') && !fLow.includes('detail')
    const isMidBody     = fLow.includes('mi')
    const isUpperBody   = fLow.includes('haut') || fLow.includes('upper')
    const isLowerBody   = fLow.includes('bas')  || fLow.includes('lower')

    // Ligne d'horizon : si l'user a fourni horizonPct (slider UI), on l'utilise.
    // Sinon, on essaie l'auto-détection. Fallback hardcodé à 80%.
    const horizonPctRaw = formData.get('horizonPct') as string | null
    const horizonPct = horizonPctRaw ? parseFloat(horizonPctRaw) : NaN
    let horizonY: number
    if (!isNaN(horizonPct) && horizonPct > 0.3 && horizonPct < 1.0) {
      horizonY = Math.floor(bgH * horizonPct)
      debug.steps.horizonY_source = `manual (${(horizonPct * 100).toFixed(0)}%)`
    } else {
      try {
        horizonY = await detectHorizonLine(bgBuf, bgW, bgH)
        debug.steps.horizonY_source = 'auto'
      } catch (e: any) {
        horizonY = Math.floor(bgH * 0.80)
        debug.steps.horizonY_error = e?.message ?? String(e)
        debug.steps.horizonY_source = 'fallback'
      }
    }
    debug.steps.horizonY = horizonY

    // Calcule taille cible du sujet en % de la hauteur du canvas + anchor
    let targetHeightRatio: number
    let anchorMode: 'feet_on_horizon' | 'center' | 'top_aligned'
    if (isFullBody) {
      // Plein-pied : le sujet doit occuper du sommet jusqu'à la ligne d'horizon (sol).
      // On veut une marge de 5-8% en haut pour la headroom.
      targetHeightRatio = (horizonY / bgH) - 0.06   // distance du top au sol, moins 6% de headroom
      anchorMode = 'feet_on_horizon'
    } else if (isMidBody) {
      targetHeightRatio = 0.78
      anchorMode = 'feet_on_horizon'
    } else if (isUpperBody) {
      targetHeightRatio = 0.70   // buste seul
      anchorMode = 'center'
    } else if (isLowerBody) {
      targetHeightRatio = 0.72
      anchorMode = 'feet_on_horizon'
    } else {
      targetHeightRatio = 0.85
      anchorMode = 'feet_on_horizon'
    }

    const targetH = Math.round(bgH * targetHeightRatio)
    const scale = targetH / bbox.height
    const newW = Math.round(bbox.width * scale)
    const newH = targetH
    const subjectResized = await sharp(subjectTight)
      .resize({ width: newW, height: newH, fit: 'inside', kernel: 'lanczos3' })
      .png().toBuffer()

    const offsetX = Math.round((bgW - newW) / 2)
    let offsetY: number
    if (anchorMode === 'feet_on_horizon') {
      // Pieds du sujet pile sur la ligne d'horizon détectée
      offsetY = horizonY - newH
    } else if (anchorMode === 'center') {
      offsetY = Math.round((bgH - newH) / 2)
    } else {
      offsetY = Math.round(bgH * 0.05)
    }
    offsetY = Math.max(0, Math.min(bgH - newH, offsetY))
    debug.steps.composite = { offsetX, offsetY, newW, newH, anchorMode, horizonY, targetHeightRatio }

    // === Génération d'une ombre de contact douce sous le sujet ===
    // Ellipse noire floue avec opacité, blend "over" (plus robuste que multiply).
    // Chaque étape est isolée pour éviter qu'un échec ne fasse planter tout le composite.
    const composites: any[] = []
    try {
      const shadowComp = await buildContactShadow(subjectResized, newW, newH, offsetX, offsetY, bgW, bgH)
      if (shadowComp.input) {
        composites.push({ input: shadowComp.input, left: shadowComp.left, top: shadowComp.top, blend: 'over' })
        debug.steps.shadow = { left: shadowComp.left, top: shadowComp.top, ok: true }
      } else {
        debug.steps.shadow = { skipped: 'buildContactShadow returned null' }
      }
    } catch (e: any) {
      debug.steps.shadow = { error: e?.message ?? String(e) }
      console.warn('[pipeline-v2] shadow build failed (continuing without shadow):', e)
    }
    composites.push({ input: subjectResized, left: offsetX, top: offsetY, blend: 'over' })

    let compositeBuf: Buffer
    try {
      compositeBuf = await sharp(bgBuf)
        .composite(composites)
        .png().toBuffer()
    } catch (e: any) {
      // Fallback : si le composite avec ombre plante, on essaie sans ombre
      console.warn('[pipeline-v2] composite with shadow failed, retrying without:', e)
      debug.steps.composite_fallback = e?.message ?? String(e)
      compositeBuf = await sharp(bgBuf)
        .composite([{ input: subjectResized, left: offsetX, top: offsetY, blend: 'over' }])
        .png().toBuffer()
    }

    // ============= ÉTAPE 4 — IC-Light (DÉSACTIVÉ par défaut) =============
    // IC-Light v2 hallucinait des ombres de fenêtre sur fond uniforme.
    // L'ombre de contact custom (étape précédente) est plus fiable pour ce cas.
    // Si le user le demande explicitement (?use_iclight=1), on l'active.
    const url = new URL(request.url)
    const useIcLight = url.searchParams.get('use_iclight') === '1'
    let finalBuf: Buffer = compositeBuf
    let icLightError: string | undefined
    if (useIcLight) {
      try {
        const compositeFile = new File([new Uint8Array(compositeBuf)], 'composite.png', { type: 'image/png' })
        const compositeFalUrl = await fal.storage.upload(compositeFile)
        const icLightResult: any = await fal.subscribe('fal-ai/iclight-v2', {
          input: {
            prompt: describeLighting(framing, userPrompt),
            image_url: compositeFalUrl,
            enable_safety_checker: false,
          },
          logs: false,
        })
        const relightUrl: string | undefined = icLightResult?.data?.images?.[0]?.url
          ?? icLightResult?.images?.[0]?.url
          ?? icLightResult?.data?.image?.url
          ?? icLightResult?.image?.url
        if (relightUrl) {
          const relightArrBuf = await fetch(relightUrl).then(r => r.arrayBuffer())
          finalBuf = Buffer.from(new Uint8Array(relightArrBuf))
          debug.steps.iclight = { url: relightUrl, bytes: finalBuf.length }
        } else {
          icLightError = 'IC-Light sans URL renvoyée.'
        }
      } catch (err: any) {
        icLightError = err?.message ?? String(err)
        debug.steps.iclight = { error: icLightError }
      }
    } else {
      debug.steps.iclight = { skipped: 'disabled by default — add ?use_iclight=1 to enable' }
    }

    // ============= ÉTAPE 5 — Upload Vercel Blob =============
    let imageUrl: string
    let blobError: string | undefined
    try {
      const path = `pipeline-v2-test/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
      const blob = await put(path, finalBuf, {
        access: 'public',
        contentType: 'image/png',
        cacheControlMaxAge: 60,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      })
      imageUrl = blob.url
    } catch (err: any) {
      imageUrl = `data:image/png;base64,${finalBuf.toString('base64')}`
      blobError = err?.message ?? String(err)
    }

    // Aussi upload le composite (avant IC-Light) pour comparaison
    let compositeUrl: string | undefined
    try {
      const path = `pipeline-v2-test/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-composite.png`
      const blob = await put(path, compositeBuf, {
        access: 'public',
        contentType: 'image/png',
        cacheControlMaxAge: 60,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      })
      compositeUrl = blob.url
    } catch { /* ignore */ }

    return NextResponse.json({ imageUrl, compositeUrl, debug, icLightError, blobError })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue', stack: error?.stack?.slice(0, 800) }, { status: 500 })
  }
}

/* ============================== helpers ============================== */

async function toInlinePart(file: File) {
  const buf = Buffer.from(new Uint8Array(await file.arrayBuffer())).toString('base64')
  return { inlineData: { mimeType: file.type || 'image/jpeg', data: buf } }
}

function describeFraming(framing: string): string {
  const f = (framing ?? '').toLowerCase()
  if (f.includes('haut') || f.includes('upper')) return 'upper body / bust shot (head, shoulders, top of chest down to waist). 5-10% headroom above the head.'
  if (f.includes('bas')  || f.includes('lower')) return 'lower body / legs only (from hips down to feet). Small margin below feet.'
  if (f.includes('mi'))                          return 'mid body / cowboy shot (head to mid-thigh). 5-10% headroom above head.'
  if (f.includes('detail') || f.includes('macro')) return 'extreme macro on garment detail.'
  return 'full body, head to feet. 5-10% headroom above head AND small margin below feet.'
}

function describeLighting(framing: string, userPrompt: string): string {
  // Prompt pour IC-Light : décrit la lumière cohérente avec un fond studio neutre.
  // L'objectif est que le sujet matche la lumière du fond fourni.
  return [
    'natural soft studio lighting matching the background',
    'even diffuse light from above and slightly front',
    'soft natural shadows on the floor under the model',
    'cohesive integration with the background',
    'photo-realistic, editorial quality, no harsh highlights',
    userPrompt && `Context : ${userPrompt}`,
  ].filter(Boolean).join(', ')
}

/**
 * Extrait la couleur dominante du fond user en échantillonnant une zone
 * censée être uniforme (haut-centre de l'image — généralement "le mur").
 */
async function extractDominantBackgroundColor(imgBuf: Buffer): Promise<{ r: number; g: number; b: number }> {
  const meta = await sharp(imgBuf).metadata()
  const w = meta.width ?? 1024, h = meta.height ?? 1024
  // Échantillonne une bande horizontale dans le tiers supérieur (zone "mur" probable)
  const sampleY = Math.floor(h * 0.15)
  const sampleH = Math.max(20, Math.floor(h * 0.10))
  const sampleX = Math.floor(w * 0.30)
  const sampleW = Math.floor(w * 0.40)

  const stats = await sharp(imgBuf)
    .extract({ left: sampleX, top: sampleY, width: sampleW, height: sampleH })
    .removeAlpha()
    .stats()

  return {
    r: Math.round(stats.channels[0].mean),
    g: Math.round(stats.channels[1].mean),
    b: Math.round(stats.channels[2].mean),
  }
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0').toUpperCase()
  return `#${h(r)}${h(g)}${h(b)}`
}

/**
 * Harmonise le fond Gemini vers une couleur cible (celle du fond user).
 *
 * Approche : FLOOD FILL depuis les bords de l'image.
 *   1. On marque chaque pixel comme "candidat fond" s'il matche les critères
 *      (clair, peu saturé, neutre).
 *   2. On fait un flood-fill 4-connectivité depuis les 4 bords, en ne visitant
 *      que les pixels candidats CONNECTÉS au bord.
 *   3. Seuls ces pixels sont remplacés par la couleur cible.
 *
 * → Le tissu blanc/écru à l'INTÉRIEUR du sujet (chemise, robe blanche) n'est
 *   PAS touché, car il n'est pas connecté au bord de l'image.
 * → Seul le vrai fond environnant le sujet est harmonisé.
 */
async function harmonizeBackground(imgBuf: Buffer, tR: number, tG: number, tB: number): Promise<Buffer> {
  const { data, info } = await sharp(imgBuf)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const w = info.width, h = info.height, ch = info.channels
  if (ch !== 3) throw new Error(`harmonizeBackground: expected 3 channels, got ${ch}`)

  // 1. Build candidate mask (pixels matching "background-like" criteria)
  const isCandidate = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 3]
    const g = data[i * 3 + 1]
    const b = data[i * 3 + 2]
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const sat = max > 0 ? (max - min) / max : 0
    const chromaDiff = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b))
    if (lum > 200 && sat < 0.18 && chromaDiff < 30) {
      isCandidate[i] = 1
    }
  }

  // 2. Flood-fill 4-connectivity from border pixels, MAIS limité à une zone
  //    "périphérique" (les 20% du bord). Si le sujet a un vêtement blanc qui
  //    touche les bords, le flood-fill ne pourra pas le traverser car le sujet
  //    occupe la zone centrale qui est exclue.
  //    → Garantit que seul le vrai fond périphérique est harmonisé.
  const borderMargin = Math.round(Math.min(w, h) * 0.20)   // 20% du plus petit côté
  const isBg = new Uint8Array(w * h)
  const stack: number[] = []
  for (let x = 0; x < w; x++) {
    if (isCandidate[x])               stack.push(x)
    if (isCandidate[(h - 1) * w + x]) stack.push((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    if (isCandidate[y * w])             stack.push(y * w)
    if (isCandidate[y * w + (w - 1)])   stack.push(y * w + w - 1)
  }
  while (stack.length > 0) {
    const idx = stack.pop()!
    if (isBg[idx]) continue
    isBg[idx] = 1
    const y = (idx / w) | 0
    const x = idx - y * w
    // Ne PAS étendre dans la zone centrale (au-delà des 20% de bord)
    const inBorderZone = (x < borderMargin) || (x > w - borderMargin)
                      || (y < borderMargin) || (y > h - borderMargin)
    if (!inBorderZone) continue
    if (x > 0     && isCandidate[idx - 1] && !isBg[idx - 1]) stack.push(idx - 1)
    if (x < w - 1 && isCandidate[idx + 1] && !isBg[idx + 1]) stack.push(idx + 1)
    if (y > 0     && isCandidate[idx - w] && !isBg[idx - w]) stack.push(idx - w)
    if (y < h - 1 && isCandidate[idx + w] && !isBg[idx + w]) stack.push(idx + w)
  }

  // 3. Replace only flood-filled pixels
  const out = Buffer.from(data)
  for (let i = 0; i < w * h; i++) {
    if (isBg[i]) {
      out[i * 3]     = tR
      out[i * 3 + 1] = tG
      out[i * 3 + 2] = tB
    }
  }

  return await sharp(out, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer()
}

/**
 * Détecte la ligne d'horizon (transition mur → sol) d'un fond studio.
 * Méthode : scan vertical d'une bande centrale, on cherche la position avec
 * le gradient de luminance le plus marqué dans la moitié basse de l'image.
 * Fallback à 78% si pas de gradient clair.
 */
async function detectHorizonLine(bgBuf: Buffer, bgW: number, bgH: number): Promise<number> {
  try {
    const stripeW = Math.max(1, Math.floor(bgW * 0.5))   // bande de 50% au centre
    const stripeX = Math.floor((bgW - stripeW) / 2)
    const { data, info } = await sharp(bgBuf)
      .extract({ left: stripeX, top: 0, width: stripeW, height: bgH })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
    // Pour chaque y, moyenne de luminance
    const rowMeans: number[] = []
    for (let y = 0; y < info.height; y++) {
      let sum = 0
      for (let x = 0; x < info.width; x++) sum += data[y * info.width + x]
      rowMeans.push(sum / info.width)
    }
    // Gradient absolu entre rangées (avec lissage simple)
    let bestY = -1
    let bestGrad = 0
    const minY = Math.floor(bgH * 0.55)   // on cherche dans la moitié basse seulement
    const maxY = Math.floor(bgH * 0.95)
    for (let y = minY; y < maxY; y++) {
      const grad = Math.abs(rowMeans[y] - rowMeans[y - 4])
      if (grad > bestGrad) {
        bestGrad = grad
        bestY = y
      }
    }
    if (bestY > 0 && bestGrad > 5) return bestY
    return Math.floor(bgH * 0.78)
  } catch {
    return Math.floor(bgH * 0.78)
  }
}

/**
 * Construit une ombre de contact douce sous le sujet.
 * Technique : alpha du sujet → ellipse aplatie noire floue → décalée vers le bas.
 * Donne une ombre physiquement cohérente (ovale sous les pieds) plutôt qu'une
 * silhouette qui suit la forme du sujet (pas naturel pour une ombre au sol).
 */
/**
 * Soft drop shadow STYLE STUDIO — ombre molle projetée au sol.
 *
 * Technique pro (équivalent Photoshop "drop shadow soft") :
 *   1. Récupère l'alpha de la SILHOUETTE ENTIÈRE du sujet
 *   2. Convertit en noir avec opacité réduite (~25%)
 *   3. Squash vertical ×0.32 (effet projection sur sol plat)
 *   4. Blur très fort (40-60px) → ombre molle, diffuse
 *   5. Ancre sous les pieds avec léger décalage vers le bas
 *
 * Donne un effet "ombre studio diffuse" qui suggère le volume du sujet
 * sans être agressif. Beaucoup plus naturel qu'une silhouette de pieds
 * isolée ou qu'une ellipse géométrique.
 */
async function buildContactShadow(
  subjectResized: Buffer, newW: number, newH: number, offsetX: number, offsetY: number,
  bgW: number, bgH: number,
): Promise<{ input: Buffer | null; left: number; top: number }> {
  try {
    const subjBbox = await findAlphaBoundingBox(subjectResized, 20)
    if (!subjBbox) return { input: null, left: 0, top: 0 }

    // 1. Crop la silhouette tight (élimine le transparent autour)
    const tight = await sharp(subjectResized)
      .extract({ left: subjBbox.left, top: subjBbox.top,
                 width: subjBbox.width, height: subjBbox.height })
      .png()
      .toBuffer()

    // 2. Extraire alpha → silhouette noire transparente
    const { data: alphaData, info: alphaInfo } = await sharp(tight)
      .ensureAlpha()
      .extractChannel('alpha')
      .raw()
      .toBuffer({ resolveWithObject: true })
    const sw = alphaInfo.width, sh = alphaInfo.height
    const rgba = Buffer.alloc(sw * sh * 4)
    for (let i = 0; i < sw * sh; i++) {
      rgba[i * 4]     = 0
      rgba[i * 4 + 1] = 0
      rgba[i * 4 + 2] = 0
      // Opacité 25% → ombre subtile, lisible sans être agressive
      rgba[i * 4 + 3] = Math.round(alphaData[i] * 0.25)
    }
    const silhouette = await sharp(rgba, { raw: { width: sw, height: sh, channels: 4 } })
      .png()
      .toBuffer()

    // 3. Squash vertical ×0.32 → projection au sol "lumière haute"
    const squashedH = Math.max(20, Math.round(sh * 0.32))
    const squashed = await sharp(silhouette)
      .resize({ width: sw, height: squashedH, fit: 'fill', kernel: 'lanczos3' })
      .png()
      .toBuffer()

    // 4. Blur très fort pour ombre molle studio
    const blurRadius = Math.max(20, Math.round(sw * 0.06))
    const pad = blurRadius * 2
    const canvasW = sw + pad * 2
    const canvasH = squashedH + pad * 2
    const shadow = await sharp({
      create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: squashed, left: pad, top: pad }])
      .blur(blurRadius)
      .png()
      .toBuffer()

    // 5. Position : centré sous les pieds, légèrement décalé vers le bas
    const subjectCenterX = offsetX + subjBbox.left + Math.round(subjBbox.width / 2)
    const subjectFeetY   = offsetY + subjBbox.top + subjBbox.height
    const shadowX = subjectCenterX - Math.round(canvasW / 2)
    const shadowY = subjectFeetY - Math.round(canvasH / 2) + Math.round(squashedH * 0.45)

    return {
      input: shadow,
      left: Math.max(-pad, Math.min(bgW - canvasW + pad, shadowX)),
      top:  Math.max(-pad, Math.min(bgH - canvasH + pad, shadowY)),
    }
  } catch (e) {
    console.warn('[shadow] failed', e)
    return { input: null, left: 0, top: 0 }
  }
}

async function findAlphaBoundingBox(imgBuf: Buffer, threshold = 20)
  : Promise<{ left: number; top: number; width: number; height: number } | null>
{
  const { data, info } = await sharp(imgBuf)
    .ensureAlpha().extractChannel('alpha')
    .raw().toBuffer({ resolveWithObject: true })
  const w = info.width, h = info.height
  let minX = w, minY = h, maxX = -1, maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x] > threshold) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0 || maxY < 0) return null
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}
