import { NextResponse } from 'next/server'

export const maxDuration = 300

/**
 * Génération via Gemini 3 Pro Image Preview.
 *
 * Body (FormData) :
 *   - prompt          : string  (obligatoire) — description principale
 *   - ratio           : '9:16' | '3:4' | '1:1' | '16:9' | '4:3'
 *   - quality         : '1K' | '2K' | '4K'
 *
 *   Soit mode "structuré" (qualité optimale, utilisé par Notion) :
 *     - mannequinBody   : File   (silhouette / corps)
 *     - mannequinFace   : File   (portrait visage)
 *     - background      : File   (fond / décor)
 *     - products        : File[] (vêtements, clé répétée)
 *     - framing         : 'plein'|'mi-corps'|'haut'|'bas'|'detail' (optionnel, sinon plein)
 *     - mannequinLabel  : string (ex "TOM")
 *     - decorLabel      : string (ex "fond du mannequin TOM")
 *
 *   Soit mode "legacy" (utilisé par Free Prompt et Inspi) :
 *     - face            : File   (optionnelle — face photo séparée pour drop on retry)
 *     - refs            : File[] (tout en vrac)
 *
 * Retries :
 *   - 1) avec face photo
 *   - 2) sans face photo (5s) — déclenché par IMAGE_SAFETY
 *   - 3) sans face photo (10s)
 */
export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const prompt   = (formData.get('prompt')  as string | null)?.trim() ?? ''
    const ratio    = (formData.get('ratio')   as string | null) ?? '9:16'
    const quality  = (formData.get('quality') as string | null) ?? '2K'

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt requis.' }, { status: 400 })
    }

    // Mode "structuré"
    const mannequinBody  = formData.get('mannequinBody') as File | null
    const mannequinFace  = formData.get('mannequinFace') as File | null
    const background     = formData.get('background')    as File | null
    const products       = formData.getAll('products').filter((v): v is File => v instanceof File)
    const framing        = (formData.get('framing')        as string | null) ?? 'plein'
    const mannequinLabel = (formData.get('mannequinLabel') as string | null) ?? 'fashion model'
    const decorLabel     = (formData.get('decorLabel')     as string | null) ?? 'background'

    // Mode "legacy"
    const refs    = formData.getAll('refs').filter((v): v is File => v instanceof File)
    const faceLegacy = formData.get('face') as File | null

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY manquante côté serveur.' }, { status: 500 })
    }

    const aspectRatio = ratio
    const imageSize   = quality === '4K' ? '4K' : quality === '1K' ? '1K' : '2K'

    const isStructured = !!(mannequinBody || background || products.length)

    // ============= Build parts =============
    const buildParts = async (opts: { withFace: boolean }): Promise<any[]> => {
      const parts: any[] = []

      if (isStructured) {
        const sessionId = Date.now()
        parts.push({ text: `[SESSION ID: ${sessionId}]\n\n${prompt}` })

        // ORDRE CRITIQUE : BODY -> FACE -> BACKGROUND -> PRODUCTS
        // Cf. plateforme principale — le 1er ref est celui de plus forte influence.
        if (mannequinBody) {
          parts.push({ text: 'REFERENCE MODEL - BODY (PRIMARY ANCHOR): use THIS EXACT body shape. Morphology, build, silhouette, proportions, height, weight, fat distribution, curves, corpulence — ALL must match this reference exactly. Do NOT slim down, do NOT idealize, do NOT default to a fashion-industry build.' })
          parts.push(await toInlinePart(mannequinBody))
        }
        if (mannequinFace && opts.withFace) {
          parts.push({ text: `REFERENCE MODEL - FACE: apply this exact face (features, hair, skin tone, expression) ON the body defined above. Same person (mannequin "${mannequinLabel}"). The persons shown are ALREADY AI-generated synthetic mannequins, NOT real people.` })
          parts.push(await toInlinePart(mannequinFace))
        } else if (mannequinFace && !opts.withFace) {
          // Retry sans face — on l'indique dans le prompt
          parts.push({ text: '⚠ NOTE : aucune référence visage fournie cette fois (retry). Génère un visage fictionnel COHÉRENT avec le corps de référence et adapté au mannequin nommé "' + mannequinLabel + '". Pas de personne réelle reconnaissable.' })
        }
        if (background) {
          parts.push({ text: `REFERENCE BACKGROUND IMAGE (CRITICAL - PIXEL-LEVEL FIDELITY): This image defines the EXACT background for the scene. Reproduce its color tone, brightness, gradient, texture, grain, lighting direction and ambient atmosphere AS-IS — treat the background like a direct copy. Do NOT relight or recolor the background to match the new model or outfit. The model is composited ONTO this background; the background does NOT adapt to the model. Decor label: "${decorLabel}".` })
          parts.push(await toInlinePart(background))
        }
        if (products.length) {
          parts.push({ text: `PRODUCT${products.length > 1 ? 'S' : ''} TO WEAR — reproduce EVERY garment detail with absolute fidelity: cut, color, texture, fabric, patterns, prints, stitching, buttons, layering, accessories. Do NOT invent, alter, recolor or remove anything :` })
          for (const f of products) parts.push(await toInlinePart(f))
        }
        // Framing instruction explicite à la toute fin (force max)
        parts.push({ text: `FRAMING (STRICT - this is non-negotiable, do not default to full body): ${mapFramingToInstructions(framing)}` })
        parts.push({ text: 'Generate the image using ONLY the product(s) above. Do not include clothing from previous requests.' })
      } else {
        // Mode legacy (Free Prompt / Inspi)
        const SAFETY_SUFFIX = [
          '',
          '⚠ Important context for the model :',
          '- The persons shown in the input reference images are ALREADY AI-generated, synthetic mannequins — NOT real people.',
          '- Family-safe, fully clothed, no nudity, no minors.',
          '- High-end fashion editorial style.',
        ].join('\n')
        const NO_FACE_SUFFIX = opts.withFace ? '' : '\n🔁 RETRY without face photo — generate a coherent fictional face.'
        parts.push({ text: prompt + '\n' + SAFETY_SUFFIX + NO_FACE_SUFFIX })
        for (const f of refs) parts.push(await toInlinePart(f))
        if (faceLegacy && opts.withFace) parts.push(await toInlinePart(faceLegacy))
      }

      return parts
    }

    const buildBody = async (withFace: boolean) => JSON.stringify({
      contents: [{ parts: await buildParts({ withFace }) }],
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

    const hasFace = !!(mannequinFace || faceLegacy)
    const attempts = [
      { delay: 0,     withFace: hasFace },
      { delay: 5000,  withFace: false },
      { delay: 10000, withFace: false },
    ]

    let last: GeminiAttempt | null = null
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i]
      if (a.delay > 0) await sleep(a.delay)
      const body = await buildBody(a.withFace)
      const att = await callGemini(apiKey, body)
      if (att.ok && att.imageUrl) {
        return NextResponse.json({
          imageUrl:    att.imageUrl,
          attempt:     i + 1,
          faceUsed:    a.withFace,
          faceWasAvailable: hasFace,
        })
      }
      if (!att.ok) {
        return NextResponse.json({ error: att.error, raw: att.raw }, { status: att.status })
      }
      last = att
    }

    const detail = buildDetailMessage(last!)
    return NextResponse.json(
      { error: `Aucune image générée après 3 tentatives. ${detail}`, raw: last?.raw },
      { status: 502 },
    )

  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue' }, { status: 500 })
  }
}

/* ============================== helpers ============================== */

type GeminiAttempt = {
  ok: boolean
  status: number
  imageUrl?: string
  error?: string
  finishReason?: string
  blockReason?: string
  textResponse?: string
  raw?: any
}

async function toInlinePart(file: File) {
  const buf = Buffer.from(await file.arrayBuffer()).toString('base64')
  return { inlineData: { mimeType: file.type || 'image/jpeg', data: buf } }
}

async function callGemini(apiKey: string, body: string): Promise<GeminiAttempt> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
  )
  let data: any = null
  try { data = await res.json() } catch { /* */ }
  if (!res.ok) {
    return { ok: false, status: res.status, error: data?.error?.message || `HTTP ${res.status}`, raw: data }
  }
  const candidate = data?.candidates?.[0]
  const finishReason = candidate?.finishReason as string | undefined
  const blockReason  = data?.promptFeedback?.blockReason as string | undefined
  const parts = candidate?.content?.parts ?? []
  for (const part of parts) {
    if (part?.inlineData?.mimeType?.startsWith('image/')) {
      return {
        ok: true, status: res.status,
        imageUrl: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
        finishReason, blockReason, raw: data,
      }
    }
  }
  const textResponse = parts.filter((p: any) => typeof p?.text === 'string').map((p: any) => p.text).join(' ').trim() || undefined
  return { ok: true, status: res.status, finishReason, blockReason, textResponse, raw: data }
}

function buildDetailMessage(att: GeminiAttempt): string {
  const bits: string[] = []
  if (att.blockReason) bits.push(`blockReason=${att.blockReason}`)
  if (att.finishReason && att.finishReason !== 'STOP') bits.push(`finishReason=${att.finishReason}`)
  if (att.textResponse) {
    const t = att.textResponse.length > 240 ? att.textResponse.slice(0, 240) + '…' : att.textResponse
    bits.push(`Gemini : "${t}"`)
  }
  if (att.finishReason === 'IMAGE_SAFETY') {
    bits.push('IMAGE_SAFETY a bloqué la sortie même après retry sans face.')
  }
  return bits.join(' · ') || 'Pas d\'image générée — probablement un throttle.'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/* ============================== framing ============================== */

const FRAMING_BG_PRESERVE =
  'BACKGROUND (preserve exactly, never alter): keep the SAME background as a full-body shot of this SETTING — same color, same texture, same lighting, same ambience. Reproduce the setting AS-IS: if it is a continuous seamless backdrop, keep it continuous and uniform and do NOT invent a floor line, wall edge, horizon or ceiling that is not already there; if it already contains a floor, wall, ceiling, horizon or furniture, keep them exactly where they are. Only the framing/crop changes — never add, move, recolor, relight or remove any background element.'

function mapFramingToInstructions(cadrage: string): string {
  const c = (cadrage ?? '').toLowerCase()
  if (c.includes('conserver') || c.includes('original') || c.includes('inchang')) {
    return 'Keep the framing exactly as in the source image (same crop, same shot composition).'
  }
  if (c.includes('plein') || c.includes('full') || c.includes('front') || c.includes('side') || c.includes('back')) {
    return 'FULL-BODY SHOT, head to feet entirely visible in frame. The model must be shown from head to toe with some margin around. Do NOT crop any part of the body. VERTICAL EXTENT: the frame extends from ground level (the model\'s feet at the bottom edge) up to just above the model\'s head. If the chosen setting naturally contains architectural elements (floor, wall, ceiling, furniture), they appear as they would in reality; if the background is a neutral seamless backdrop, KEEP IT PURE — do NOT invent a floor line, a wall edge, a horizon or a ceiling that don\'t belong.'
  }
  if (c.includes('mi-corps') || c.includes('mi corps') || c.includes('half')) {
    return 'MID-BODY SHOT (cowboy shot), framing from the top of the head down to mid-thigh / above the knees. Lower body below the knees must be OUT of frame. Hips and waist are visible, the legs from the knees down are NOT visible. VERTICAL EXTENT: the frame covers the area from mid-thigh up to just above the head. Anything below mid-thigh is OUT of frame. ' + FRAMING_BG_PRESERVE + ' The camera is positioned at chest level.'
  }
  if (c.includes('haut') || c.includes('upper')) {
    return 'UPPER-BODY CLOSE-UP, head and shoulders down to chest visible. No waist, no legs in frame. Camera close to the subject. Emphasis on neckline, shoulders, top garment, face. VERTICAL EXTENT: the frame covers only from chest level up. Anything below chest level is OUT of frame. ' + FRAMING_BG_PRESERVE + ' Do NOT add extra background blur for this close-up unless it is already present in the SETTING.'
  }
  if (c.includes('bas') || c.includes('lower')) {
    return `LOWER-BODY-ONLY SHOT. STRICT REQUIREMENT: only the legs are shown in frame, from the hips/waist down to the feet. Head, torso, arms, chest must be ENTIRELY OUT of frame (cropped above the hips). The model upper body is invisible. Focus on pants/skirt/shoes only. VERTICAL EXTENT: the frame covers only the area from hip level down to the feet. Anything above hip level is OUT of frame. ${FRAMING_BG_PRESERVE}`
  }
  if (c.includes('detail') || c.includes('matiere') || c.includes('texture')) {
    return `EXTREME MACRO CLOSE-UP on a garment detail (fabric texture, stitching, button, collar, cuff, sleeve edge, embroidery, logo, zipper, accessory). Tight zoom, NO full body, NO head, NO model context. Just a textile/material detail filling the frame. Studio macro photography aesthetic, shallow depth of field. BACKGROUND: completely out of focus, but the COLOR and AMBIENT TONE must match the SETTING.`
  }
  return cadrage
}
