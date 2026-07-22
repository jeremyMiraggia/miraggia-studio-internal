/**
 * Ghost F&S — Style transfer packshot ghost (chemise pliée sans mannequin).
 *
 * Workflow :
 *   1. Le client envoie 2 images : reference (packshot pro) + source (photo iPhone)
 *   2. On labelise CHAQUE image côté serveur avec un texte explicite AVANT l'image
 *      → Gemini ne peut plus confondre l'ordre
 *   3. Le prompt insiste : PACKSHOT GHOST FOLDED SHIRT ONLY, no human, no head, no model
 *
 * L'endpoint /api/studio/free ne labelisait pas les images → Gemini inventait
 * des contextes (buste flottant, tête, etc.). Ici on force le contexte "ghost packshot".
 */
import { NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import sharp from 'sharp'

export const maxDuration = 300
export const runtime = 'nodejs'

const ANTI_HALLUCINATION_PROMPT = [
  "TASK : Take the GARMENT shown in IMAGE #2 (source photo) and present it in the exact FORMAT / ANGLE / COMPOSITION / STYLE of IMAGE #1 (reference packshot).",
  "",
  "⚠ IMPORTANT DISTINCTION — DO NOT CONFUSE THE TWO IMAGES :",
  "  → IMAGE #1 = REFERENCE for HOW to present : the framing, the camera angle, the view (front / 3/4 / detail / etc.), the composition, the aspect ratio, the crop, the background, the lighting. DO NOT copy the actual garment of image #1 — it is only there to teach you the presentation style.",
  "  → IMAGE #2 = SOURCE for WHAT to present : the garment itself. Its color, its material, its cut, its buttons, its collar, its label brand. This garment MUST appear in the final output, presented like image #1.",
  "",
  "⚠ COMMON MISTAKE TO AVOID :",
  "The two images might both be shirts / garments that look similar at first glance. DO NOT take the easy path of copying image #1 as-is. The output MUST be the GARMENT OF IMAGE #2, presented in the STYLE OF IMAGE #1. If your output looks like image #1 unchanged, you have FAILED the task.",
  "",
  "⚠ ANGLE / VIEW / FRAMING TRANSFER — REPRODUCE THE EXACT FRAMING OF IMAGE #1 :",
  "  • Look CAREFULLY at image #1 and identify its framing : is it a wide full-body shot, a tight close-up, a 3/4 angled view, a top-down view, a side view, a zoomed detail on the collar or cuff, or something else ?",
  "  • Whatever the framing of image #1 is, YOU MUST reproduce it EXACTLY in your output.",
  "  • Examples : if image #1 is a tight close-up on the collar area + cuff at a 3/4 angle → your output must also be a tight close-up on the collar area + cuff at a 3/4 angle. If image #1 is a top-down full-shirt shot → your output must also be a top-down full-shirt shot.",
  "  • DO NOT default to a standard flat vertical packshot unless image #1 is a standard flat vertical packshot.",
  "  • The angle, the zoom level, the crop, the aspect ratio, the visible parts of the garment, the perspective — ALL must match image #1.",
  "  • IGNORE the framing / angle / zoom of image #2 completely. Even if image #2 is laid flat on a bed and image #1 is a tight zoomed 3/4 shot, your output must be a tight zoomed 3/4 shot.",
  "",
  "⚠ CRITICAL — GHOST PACKSHOT, ONE GARMENT ONLY :",
  "This is a GHOST MANNEQUIN packshot of ONE folded garment (shirt, t-shirt, polo, pullover, top, jumper, etc.).",
  "There is EXACTLY ONE garment in the output. NOT two. NOT a duplicate. NOT a ghost / reflection / mirror image behind it.",
  "There is NO human, NO model, NO head, NO body, NO neck, NO hands, NO face, NO buste, NO silhouette.",
  "The background is 100% CLEAN and UNIFORM.",
  "",
  "⚠ FROM IMAGE #1 (reference packshot) — COPY the presentation :",
  "  • the exact same composition, framing, aspect ratio, crop",
  "  • the exact same view/angle (if front full-frame, keep front full-frame; if 3/4 angle, keep 3/4 angle; etc.)",
  "  • the exact same folding style (collar visible, cuff visible, buttons visible if any, size label visible)",
  "  • the exact same background color and texture (uniform light grey/white studio background)",
  "  • the exact same lighting (soft, even, no harsh shadows)",
  "  • the exact same subtle drop shadow underneath the garment",
  "  • the exact same sharpness and professional quality (very piqué, e-commerce catalog quality)",
  "  • ⚠ DO NOT copy the garment itself of image #1 (color, material, brand label of image #1 are IRRELEVANT — they must NOT appear in the output).",
  "",
  "⚠ FROM IMAGE #2 (source garment) — EXTRACT ONLY the garment :",
  "  • the exact garment color, exact material/texture (velvet, corduroy, linen, cotton, etc.)",
  "  • the exact cut, exact stitching, exact buttons",
  "  • the exact collar shape (if shirt/polo), exact neckline (if t-shirt)",
  "  • the exact brand label (name, colors, format on the label)",
  "  • The garment must be RECOGNIZABLE as the one from image #2, just re-presented in the style of image #1.",
  "  • ⚠ IGNORE the framing, angle, zoom, background, lighting of image #2 — only the garment itself matters. If image #2 is a close-up on the collar, DO NOT produce a close-up on the collar — produce the same full view as image #1.",
  "",
  "⚠ FABRIC MUST BE PERFECTLY IRONED, SMOOTH AND CRISP :",
  "  • The garment must appear FRESHLY IRONED and STEAMED — 100% smooth, wrinkle-free, crease-free, fold-free (except the intentional folding of the packshot).",
  "  • The fabric is PULLED TAUT / PULLED TIGHT — no waviness, no ripples, no loose fabric, no folds inside the fabric surface.",
  "  • For linen, cotton, hemp : keep the natural fabric weave texture visible but ELIMINATE all wrinkles and creases.",
  "  • Ignore any wrinkles present in the source iPhone photo — the packshot must show a perfectly ironed, crisp garment.",
  "",
  "⚠ FOLDING MUST BE MILLIMETRIC AND SYMMETRIC (this is critical for professional look) :",
  "  • The garment is folded with PERFECT SYMMETRY — the left side and right side are mirror-perfect.",
  "  • ALL edges are STRAIGHT LINES (no curves, no waves, no crooked edges). Rectangular / square shape overall.",
  "  • ALL corners are SHARP and CRISP (90° angles, no rounded corners).",
  "  • The center line (button placket / center fold) is a perfectly VERTICAL straight line.",
  "  • The collar is centered and symmetric.",
  "  • The visible cuff is aligned with a straight bottom edge.",
  "  • The size label is centered and readable.",
  "  • Zero wobble, zero asymmetry, zero misalignment — pin-sharp precision like a pro fashion catalog folding.",
  "",
  "⚠ PIQUÉ / SHARPNESS :",
  "  • The output is razor-sharp, ultra-crisp, extremely piqué. Every detail (fabric weave, stitching, button holes, brand label text) is perfectly focused.",
  "  • Brand label text must be legible and accurate — if the source shows 'FATHER & SONS', reproduce it EXACTLY (not 'TATHER' or 'FAT HER' or similar hallucination). Copy the label lettering pixel-perfect.",
  "",
  "OUTPUT : a single professional packshot with ONE garment (no ghosts, no doubles), perfectly ironed AND perfectly folded (straight lines, sharp corners, mirror symmetry), pin-sharp, indistinguishable from the reference in style, but with the source garment.",
].join('\n')

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const reference = formData.get('reference') as File | null
    const source    = formData.get('source')    as File | null
    const ratio     = (formData.get('ratio')   as string | null) ?? '3:4'
    const quality   = (formData.get('quality') as string | null) ?? '2K'
    const userPromptOverride = (formData.get('prompt') as string | null) ?? ''

    if (!reference) return NextResponse.json({ error: 'reference requise (packshot pro).' }, { status: 400 })
    if (!source)    return NextResponse.json({ error: 'source requise (photo iPhone).' },   { status: 400 })

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY manquante.' }, { status: 500 })

    const sessionId = Date.now()
    const prompt = userPromptOverride.trim() || ANTI_HALLUCINATION_PROMPT

    // ⚠ Ordre important : on labelise CHAQUE image avec un texte AVANT.
    // Gemini associe le texte immédiatement précédent à l'image qui suit.
    const parts: any[] = []
    parts.push({ text: `[SESSION ${sessionId}]\n${prompt}` })

    parts.push({ text: '=== IMAGE #1 : REFERENCE PACKSHOT (style teacher) ===\n⚠ This image teaches you HOW to present a garment (composition, angle, view, framing, background, lighting). Copy the PRESENTATION STYLE of this image. But the GARMENT SHOWN in this image is IRRELEVANT — do NOT reproduce this specific garment. It is not the one we want in the output. Look at HOW the garment is shot, not WHAT it is.' })
    parts.push(await toInlinePart(reference))

    parts.push({ text: '=== IMAGE #2 : SOURCE GARMENT (the actual garment for the output) ===\n⚠ This is the ACTUAL garment that MUST appear in the output. Extract only its identity : color, material/texture (e.g. corduroy, linen, velvet), cut, stitching, buttons, collar shape, neckline, brand label. IGNORE the framing / angle / zoom / background / lighting of this image #2 — those are wrong. Present this garment WITH THE PRESENTATION STYLE of image #1 (same framing, same angle, same view, same background, same lighting as image #1).' })
    parts.push(await toInlinePart(source))

    parts.push({ text: '⚠ FINAL SELF-CHECK before producing the output — answer these questions honestly :\n  1) FRAMING match : if I place my output next to image #1, do they have the same framing/angle/zoom/crop ? (Same tight close-up if #1 is tight ; same wide shot if #1 is wide ; same 3/4 angle if #1 is 3/4 ; same top-down if #1 is top-down.) If the framings differ, my output is WRONG — I copied a generic packshot instead of matching image #1\'s actual framing.\n  2) GARMENT identity : is the garment in my output the one from image #2 (color, material, brand label of image #2) ? NOT the one from image #1.\n  3) Comparison test : if someone compared my output side-by-side with image #1, would they say : "same presentation style but DIFFERENT garments" ? Yes = success. No (they look like the same shirt) = failure, redo.\n\nOutput = a professional GHOST packshot, single folded garment, NO human. Presentation style / framing / angle = COPY EXACTLY from image #1. Garment identity = COPY EXACTLY from image #2.' })

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
    let b64: string | null = null
    let mime = 'image/png'
    for (const p of geminiParts) {
      if (p?.inlineData?.mimeType?.startsWith('image/')) {
        b64 = p.inlineData.data
        mime = p.inlineData.mimeType
        break
      }
    }
    if (!b64) return NextResponse.json({ error: 'Gemini sans image.' }, { status: 502 })

    const rawBuf = Buffer.from(b64, 'base64')

    // === Compression : Gemini renvoie souvent des PNG 5-10 MB.
    // On re-encode en JPEG q92 progressif → ~500 KB - 1.5 MB, chargement 5-10× plus rapide.
    // JPEG q92 = qualité visuellement identique au PNG pour un packshot.
    let optimizedBuf: Buffer = rawBuf
    let optimizedMime = mime
    try {
      optimizedBuf = await sharp(rawBuf)
        .jpeg({ quality: 92, progressive: true, mozjpeg: true })
        .toBuffer()
      optimizedMime = 'image/jpeg'
    } catch (e) {
      console.warn('[ghost-fs] compression failed, using raw:', e)
    }

    // Upload Blob
    let imageUrl: string
    let blobError: string | undefined
    try {
      const ext = optimizedMime === 'image/png' ? 'png' : 'jpg'
      const path = `ghost-fs/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const blob = await put(path, optimizedBuf, {
        access: 'public', contentType: optimizedMime, cacheControlMaxAge: 60,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      })
      imageUrl = blob.url
    } catch (err: any) {
      imageUrl = `data:${optimizedMime};base64,${optimizedBuf.toString('base64')}`
      blobError = err?.message ?? String(err)
    }
    return NextResponse.json({ imageUrl, blobError, bytes: optimizedBuf.length })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue' }, { status: 500 })
  }
}

async function toInlinePart(file: File) {
  const buf = Buffer.from(new Uint8Array(await file.arrayBuffer())).toString('base64')
  return { inlineData: { mimeType: file.type || 'image/jpeg', data: buf } }
}
