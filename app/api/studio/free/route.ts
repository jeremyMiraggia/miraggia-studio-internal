import { NextResponse } from 'next/server'
import { compressGeminiImage } from '@/lib/serverImageCompress'

export const maxDuration = 300
export const runtime = 'nodejs'

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

        // ===== Prompt simplifié, hiérarchie claire : =====
        //   1. Bon mannequin (corps + visage)
        //   2. Bon fond (preservation)
        //   3. Bon vêtement
        //   4. Bonne pose
        //   5. Bonne vue (framing)
        const intro = [
          `[SESSION ${sessionId}]`,
          'You are creating a fashion editorial photograph. Five things must be correct, in this order of priority:',
          '  1) THE MODEL — exact body + face from the reference images.',
          '  2) THE BACKGROUND — keep the reference background photograph identical (do not regenerate).',
          '  3) THE GARMENT — reproduce every detail of the product reference(s).',
          '  4) THE POSE — natural fashion editorial pose, fitting the framing.',
          '  5) THE FRAMING — respect the requested view exactly.',
          '',
          '— Project-specific prompt —',
          prompt,
        ].join('\n')
        parts.push({ text: intro })

        // ⚠ ORDRE DES IMAGES : BACKGROUND EN PREMIER (= plus de poids visuel dans Gemini).
        // La hiérarchie des PRIORITÉS texte (1.mannequin → 2.fond → 3.vêtement) reste,
        // mais la 1ère image vue par le modèle = celle qu'il "ancre" le plus → on lui
        // sert le fond en 1er pour maximiser la fidélité de préservation.

        // FOND — référence à preserver pixel-perfect
        if (background) {
          parts.push({ text:
            `BACKGROUND (decor "${decorLabel}") — this exact photograph IS the final background. Keep it identical: tone, lighting, texture, atmosphere. Do not relight, do not recolor, do not regenerate it. Composite the model into it.`
          })
          parts.push(await toInlinePart(background))
        }

        // MANNEQUIN — corps puis visage
        if (mannequinBody) {
          parts.push({ text: `MODEL BODY (mannequin "${mannequinLabel}") — use THIS exact body: morphology, build, height, proportions, curves, skin tone. Do not slim down or idealize.` })
          parts.push(await toInlinePart(mannequinBody))
        }
        if (mannequinFace && opts.withFace) {
          parts.push({ text: `MODEL FACE — apply this exact face (features, hair, expression) on the body above. Synthetic AI mannequin, not a real person.` })
          parts.push(await toInlinePart(mannequinFace))
        } else if (mannequinFace && !opts.withFace) {
          parts.push({ text: `MODEL FACE — retry without face ref. Generate a coherent fictional face for mannequin "${mannequinLabel}".` })
        }

        // VÊTEMENT — produits
        if (products.length) {
          parts.push({ text: `GARMENT${products.length > 1 ? 'S' : ''} — reproduce every detail with absolute fidelity: cut, color, fabric, pattern, stitching, buttons. Use ONLY the product(s) below — no clothing from previous requests.` })
          for (const f of products) parts.push(await toInlinePart(f))
        }

        // 4 + 5) POSE + VUE
        parts.push({ text: `4/ POSE — natural fashion editorial pose, coherent with the framing.\n5/ FRAMING (STRICT, non-negotiable): ${mapFramingToInstructions(framing)}` })
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
        return NextResponse.json({ error: att.error, raw: trimRaw(att.raw) }, { status: att.status })
      }
      last = att
    }

    const detail = buildDetailMessage(last!)
    return NextResponse.json(
      { error: `Aucune image générée après 3 tentatives. ${detail}`, raw: trimRaw(last?.raw) },
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
      // Recompression JPEG q90 pour réduire la bande passante Vercel
      // (Gemini renvoie souvent du PNG ~2-5 MB → JPEG ~300-700 KB).
      const compressed = await compressGeminiImage(
        part.inlineData.data,
        part.inlineData.mimeType,
        { format: 'jpeg', quality: 90 },
      )
      return {
        ok: true, status: res.status,
        imageUrl: `data:${compressed.mime};base64,${compressed.base64}`,
        finishReason, blockReason,
        // Note : on NE renvoie PAS `raw: data` en succès — payload Gemini complet
        // peut peser plusieurs MB (parts text/usage/etc.) sans utilité pour le client.
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

/**
 * Tronque les payloads Gemini volumineux avant de les renvoyer au client.
 * Évite que des `inlineData` parasites de plusieurs MB ne soient sérialisés
 * dans les réponses d'erreur (gros impact sur la bande passante Vercel).
 */
function trimRaw(raw: unknown): unknown {
  if (!raw) return raw
  try {
    const s = JSON.stringify(raw)
    if (s.length <= 4_000) return raw
    return { truncated: true, preview: s.slice(0, 4_000) + '…' }
  } catch {
    return { truncated: true, preview: '[non sérialisable]' }
  }
}

/* ============================== framing ============================== */

// ⚠ Plus court, plus neutre : on ne suppose JAMAIS l'existence d'un mur, d'un sol,
// d'une plinthe ou d'une transition particulière — c'est l'image fond qui décide.
// On ne mentionne plus "full-body shot" non plus, car ça crée de la confusion
// pour les close-up (où le fond fourni est cadré différemment).
const BG_PRESERVE_NEUTRAL =
  'BACKGROUND (preserve exactly, never alter): keep the EXACT same background as the reference photograph — same color, same texture, same lighting, same ambience. Only the framing/crop changes. Never add, move, recolor, relight or remove any element. Never invent any element that is not already in the reference (e.g. floor line, wall, horizon, furniture, props).'

// Ombre au sol pour les plans qui montrent le sol (plein-pied, plan bas)
const SHADOW_FLOOR_NATURAL =
  'SHADOW: keep it discreet and natural — a soft contact shadow at the feet adapted to the scene lighting. No projected body silhouette on the floor. No floor reflection of the model. Nothing dramatic.'


function mapFramingToInstructions(cadrage: string): string {
  const c = (cadrage ?? '').toLowerCase()
  if (c.includes('conserver') || c.includes('original') || c.includes('inchang')) {
    return 'Keep the framing exactly as in the source image (same crop, same shot composition).'
  }
  if (c.includes('plein') || c.includes('full') || c.includes('front') || c.includes('side') || c.includes('back')) {
    return 'FULL-BODY SHOT, head to feet entirely visible in frame. The model must be shown from head to toe with some margin around. Do NOT crop any part of the body. VERTICAL EXTENT: the frame extends from ground level (the model\'s feet at the bottom edge) up to just above the model\'s head. If the chosen setting naturally contains architectural elements (floor, wall, ceiling, furniture), they appear as they would in reality; if the background is a neutral seamless backdrop, KEEP IT PURE — do NOT invent a floor line, a wall edge, a horizon or a ceiling that don\'t belong. ' + SHADOW_FLOOR_NATURAL
  }
  if (c.includes('mi-corps') || c.includes('mi corps') || c.includes('half')) {
    return 'MID-BODY SHOT (cowboy shot), framing from the top of the head down to mid-thigh / above the knees. Lower body below the knees must be OUT of frame. Hips and waist are visible, the legs from the knees down are NOT visible. VERTICAL EXTENT: the frame covers the area from mid-thigh up to just above the head. Anything below mid-thigh is OUT of frame. ' + BG_PRESERVE_NEUTRAL + ' The camera is positioned at chest level. '  }
  if (c.includes('haut') || c.includes('upper')) {
    return 'UPPER-BODY CLOSE-UP, head and shoulders down to chest visible. No waist, no legs in frame. Camera close to the subject. Emphasis on neckline, shoulders, top garment, face. VERTICAL EXTENT: the frame covers only from chest level up. Anything below chest level is OUT of frame. ' + BG_PRESERVE_NEUTRAL + ' Do NOT add extra background blur for this close-up unless it is already present in the SETTING. '  }
  if (c.includes('bas') || c.includes('lower')) {
    return `LOWER-BODY-ONLY SHOT. STRICT REQUIREMENT: only the legs are shown in frame, from the hips/waist down to the feet. Head, torso, arms, chest must be ENTIRELY OUT of frame (cropped above the hips). The model upper body is invisible. Focus on pants/skirt/shoes only. VERTICAL EXTENT: the frame covers only the area from hip level down to the feet. Anything above hip level is OUT of frame. ${BG_PRESERVE_NEUTRAL} ${SHADOW_FLOOR_NATURAL}`
  }
  if (c.includes('detail') || c.includes('matiere') || c.includes('texture')) {
    return `EXTREME MACRO CLOSE-UP on a garment detail (fabric texture, stitching, button, collar, cuff, sleeve edge, embroidery, logo, zipper, accessory). Tight zoom, NO full body, NO head, NO model context. Just a textile/material detail filling the frame. Studio macro photography aesthetic, shallow depth of field. BACKGROUND: completely out of focus, but the COLOR and AMBIENT TONE must match the SETTING.`
  }
  return cadrage
}
