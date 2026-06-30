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
    const intro = [
      `[SESSION ${sessionId}]`,
      'Generate a fashion editorial photograph of the model wearing the provided garments.',
      '⚠ Output will be POST-PROCESSED : background will be replaced + sujet ré-illuminé.',
      'Focus 100% on : (1) the model identity, (2) the garments fidelity, (3) the pose, (4) the framing.',
      'Background can be a simple neutral studio — it will be REPLACED by a real photo.',
      'FABRIC : all fabrics MUST appear properly ironed and crisp, no wrinkles.',
      '',
      `Project prompt : ${userPrompt || '(none)'}`,
      `FRAMING : ${describeFraming(framing)}`,
    ].join('\n')

    const parts: any[] = [{ text: intro }]
    parts.push({ text: 'MODEL BODY — use THIS exact body : morphology, height, skin tone, posture base.' })
    parts.push(await toInlinePart(mannequinBody))
    if (mannequinFace) {
      parts.push({ text: 'MODEL FACE — apply this exact face : eyes, nose, mouth, hair. FULLY visible.' })
      parts.push(await toInlinePart(mannequinFace))
    }
    if (products.length) {
      parts.push({ text: `GARMENT${products.length > 1 ? 'S' : ''} — reproduce every detail with absolute fidelity.` })
      for (const f of products) parts.push(await toInlinePart(f))
    }

    const geminiBody = JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: ratio, imageSize: '2K' },
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

      try {
        const form = new FormData()
        // imageFile = sujet brut Gemini (Photoroom détoure + analyse lumière + génère ombre)
        const geminiBlob = new Blob([new Uint8Array(geminiBuf)], { type: geminiMime })
        form.append('imageFile', geminiBlob, geminiMime === 'image/png' ? 'gemini.png' : 'gemini.jpg')
        // background.imageFile = fond user (Photoroom le préserve pixel-perfect)
        const bgBlob = new Blob([new Uint8Array(bgBuf)], { type: 'image/png' })
        form.append('background.imageFile', bgBlob, 'background.png')

        // SHADOW : ai.soft = ombre subtile et naturelle (le user veut ça)
        //          ai.hard = ombre plus marquée
        form.append('shadow.mode', shadowMode === 'photoroom-soft' ? 'ai.soft' : 'ai.hard')

        // === Placement vertical du sujet (slider horizonPct du user) ===
        // Si horizonPct est défini (ex 85%), on dit à Photoroom :
        //   - mode outputImage : on peut spécifier le placement
        //   - verticalAlignment=bottom : ancre le sujet en bas
        //   - padding.bottom = (100 - horizonPct)% du canvas
        //   → résultat : pieds du sujet pile sur la ligne horizon
        const horizonPctRaw = formData.get('horizonPct') as string | null
        const horizonPctVal = horizonPctRaw ? parseFloat(horizonPctRaw) : NaN
        if (!isNaN(horizonPctVal) && horizonPctVal > 0.3 && horizonPctVal < 1.0) {
          form.append('referenceBox', 'outputImage')
          form.append('verticalAlignment', 'bottom')
          // padding.bottom en % → "10%" pour horizon à 90%
          const paddingBottomPct = Math.round((1 - horizonPctVal) * 100)
          form.append('padding.bottom', `${paddingBottomPct}%`)
          // padding latéral 5% pour ne pas coller aux bords
          form.append('padding.left', '5%')
          form.append('padding.right', '5%')
          form.append('horizontalAlignment', 'center')
          debug.steps.photoroom_placement = { mode: 'outputImage', verticalAlignment: 'bottom', paddingBottom: `${paddingBottomPct}%` }
        } else {
          // Sans horizonPct : Photoroom gère le placement automatiquement
          form.append('referenceBox', 'originalImage')
          debug.steps.photoroom_placement = { mode: 'originalImage' }
        }

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
        const finalBuf = Buffer.from(new Uint8Array(await res.arrayBuffer()))
        debug.steps.photoroom = { ok: true, bytes: finalBuf.length, mode: shadowMode }

        // Upload Vercel Blob + return (court-circuit le reste du pipeline)
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
        console.warn('[pipeline-v2] Photoroom failed, fallback to custom shadow:', err?.message)
        debug.steps.photoroom = { error: err?.message ?? String(err), fallback: 'custom' }
        // Fallback : on continue vers le mode custom ci-dessous
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
 * Ombre de contact NATURELLE — utilise l'alpha des pieds eux-mêmes, squashé
 * verticalement et fortement flouté. Suit la silhouette réelle des chaussures
 * (plus naturel qu'une ellipse parfaite).
 *
 * Technique :
 *   1. Crop les 12% du bas du sujet (zone pieds/chaussures)
 *   2. Extraire l'alpha → silhouette noire avec opacité douce
 *   3. Squash verticalement ×0.2 (effet projection au sol)
 *   4. Blur ~12-15px (très diffus)
 *   5. Placer pile sous les pieds en mode "over"
 */
async function buildContactShadow(
  subjectResized: Buffer, newW: number, newH: number, offsetX: number, offsetY: number,
  bgW: number, bgH: number,
): Promise<{ input: Buffer | null; left: number; top: number }> {
  try {
    const subjBbox = await findAlphaBoundingBox(subjectResized, 20)
    if (!subjBbox) return { input: null, left: 0, top: 0 }

    // 1. Crop les 12% du bas du sujet (= zone pieds)
    const footStripHeight = Math.max(8, Math.round(subjBbox.height * 0.12))
    const footStripTop    = subjBbox.top + subjBbox.height - footStripHeight
    const footStripBuf = await sharp(subjectResized)
      .extract({ left: subjBbox.left, top: footStripTop,
                 width: subjBbox.width, height: footStripHeight })
      .png()
      .toBuffer()

    // 2. Extraire l'alpha → silhouette noire (l'alpha original devient l'opacité)
    const { data: alphaData, info: alphaInfo } = await sharp(footStripBuf)
      .ensureAlpha()
      .extractChannel('alpha')
      .raw()
      .toBuffer({ resolveWithObject: true })
    const w = alphaInfo.width, h = alphaInfo.height

    // Crée une image noire RGBA dont l'alpha = (alphaPieds × 0.45) pour être subtil
    const rgba = Buffer.alloc(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4]     = 0
      rgba[i * 4 + 1] = 0
      rgba[i * 4 + 2] = 0
      rgba[i * 4 + 3] = Math.round(alphaData[i] * 0.45)  // opacité globale 45% de l'alpha
    }
    const silhouette = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
      .png()
      .toBuffer()

    // 3. Squash vertical ×0.22 → effet projection au sol
    const squashedH = Math.max(4, Math.round(h * 0.22))
    const squashedW = w
    const squashed = await sharp(silhouette)
      .resize({ width: squashedW, height: squashedH, fit: 'fill', kernel: 'lanczos3' })
      .png()
      .toBuffer()

    // 4. Pad + blur fort pour rendre l'ombre très diffuse
    const blurRadius = Math.max(6, Math.round(squashedH * 0.6))
    const pad = blurRadius * 2
    const canvasW = squashedW + pad * 2
    const canvasH = squashedH + pad * 2
    const shadow = await sharp({
      create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: squashed, left: pad, top: pad }])
      .blur(blurRadius)
      .png()
      .toBuffer()

    // 5. Position : pile sous les pieds, légèrement décalé vers le bas pour effet sol
    const subjectFeetY = offsetY + subjBbox.top + subjBbox.height
    const shadowX = offsetX + subjBbox.left - pad
    const shadowY = subjectFeetY - Math.round(squashedH / 2) - pad + Math.round(squashedH * 0.3)

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
