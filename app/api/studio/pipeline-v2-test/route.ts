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

    // ============= ÉTAPE 2 — BiRefNet (détourage sujet) =============
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
    const bgArrBuf = await background.arrayBuffer()
    const bgBuf = Buffer.from(new Uint8Array(bgArrBuf))
    const bgMeta = await sharp(bgBuf).metadata()
    const bgW = bgMeta.width ?? 1024, bgH = bgMeta.height ?? 1536

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

    // Détection automatique de la ligne d'horizon (sol vs mur) du fond.
    // On scan une bande verticale au centre et on cherche le gradient le plus fort
    // (transition mur → sol). Si la détection est faible, on fallback à 78%.
    const horizonY = await detectHorizonLine(bgBuf, bgW, bgH)
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
    // Ellipse noire floue placée sous les pieds (cohérent avec un sol plat).
    // Plus fiable qu'IC-Light qui hallucine des ombres complexes.
    const shadowComp = await buildContactShadow(subjectResized, newW, newH, offsetX, offsetY, bgW, bgH)
    const composites: any[] = []
    if (shadowComp.input) {
      composites.push({ input: shadowComp.input, left: shadowComp.left, top: shadowComp.top, blend: 'multiply' })
    }
    composites.push({ input: subjectResized, left: offsetX, top: offsetY, blend: 'over' })
    const compositeBuf = await sharp(bgBuf)
      .composite(composites)
      .png().toBuffer()

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
async function buildContactShadow(
  subjectResized: Buffer, newW: number, newH: number, offsetX: number, offsetY: number,
  bgW: number, bgH: number,
): Promise<{ input: Buffer | null; left: number; top: number }> {
  try {
    // Trouve la bbox réelle du sujet RESIZÉ pour ancrer l'ombre sous les vrais pieds
    const subjBbox = await findAlphaBoundingBox(subjectResized, 20)
    if (!subjBbox) return { input: null, left: 0, top: 0 }

    // Largeur ombre = ~90% de la largeur réelle du sujet (au sol)
    const shadowW = Math.round(subjBbox.width * 0.9)
    const shadowH = Math.max(6, Math.round(subjBbox.width * 0.08))   // ellipse aplatie
    if (shadowW < 4 || shadowH < 2) return { input: null, left: 0, top: 0 }

    // Padding autour pour que le flou n'ait pas un bord net
    const pad = Math.round(shadowH * 0.8)
    const canvasW = shadowW + pad * 2
    const canvasH = shadowH + pad * 2

    const svg = `<svg width="${canvasW}" height="${canvasH}" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="${canvasW/2}" cy="${canvasH/2}" rx="${shadowW/2}" ry="${shadowH/2}"
               fill="white" opacity="0.55"/>
    </svg>`
    // Crée l'ellipse, floute, puis inverse pour avoir une zone noire à multiplier sur le fond
    const shadow = await sharp(Buffer.from(svg))
      .blur(Math.max(4, Math.round(shadowH * 0.8)))
      .negate({ alpha: false })   // blanc → noir, garde l'alpha
      .png()
      .toBuffer()

    // Position : centré sur le sujet réel, au niveau des pieds
    const subjectCenterX = offsetX + subjBbox.left + Math.round(subjBbox.width / 2)
    const subjectFeetY   = offsetY + subjBbox.top + subjBbox.height
    let shadowX = subjectCenterX - Math.round(canvasW / 2)
    let shadowY = subjectFeetY - Math.round(canvasH / 2) + Math.round(shadowH * 0.4)

    // Bound
    shadowX = Math.max(-pad, Math.min(bgW - canvasW + pad, shadowX))
    shadowY = Math.max(-pad, Math.min(bgH - canvasH + pad, shadowY))

    return { input: shadow, left: shadowX, top: shadowY }
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
