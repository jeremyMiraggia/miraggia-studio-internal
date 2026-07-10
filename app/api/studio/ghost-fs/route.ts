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
  "TASK : Recreate the packshot from the REFERENCE image, but replace the garment with the one shown in the SOURCE image.",
  "",
  "⚠ CRITICAL — GHOST PACKSHOT, ONE GARMENT ONLY :",
  "This is a GHOST MANNEQUIN packshot of ONE folded garment (shirt, t-shirt, polo, pullover, top, jumper, etc. — whatever is in the source image).",
  "There is EXACTLY ONE garment in the output. NOT two. NOT a duplicate. NOT a ghost / reflection / mirror image behind it.",
  "There is NO human, NO model, NO head, NO body, NO neck, NO hands, NO face, NO buste, NO silhouette.",
  "The background is 100% CLEAN and UNIFORM — no additional garment silhouette in the background, no faded copy of the garment behind, no double exposure effect.",
  "If you see any of these artifacts in your generation (double garment, ghost silhouette, human element, background garment), REMOVE THEM.",
  "",
  "⚠ COPY FROM THE REFERENCE IMAGE (the 1st attached image):",
  "  • the exact same composition (garment centered, same crop, same aspect ratio)",
  "  • the exact same folding style (collar visible, cuff visible, buttons visible if any, size label visible)",
  "  • the exact same pose of the folded garment",
  "  • the exact same background color and texture (uniform light grey/white studio background)",
  "  • the exact same lighting (soft, even, no harsh shadows)",
  "  • the exact same subtle drop shadow underneath the garment (nothing more, nothing less)",
  "  • the exact same sharpness and professional quality (very piqué, e-commerce catalog quality)",
  "",
  "⚠ REPLACE THE GARMENT with the one from the SOURCE image (the 2nd attached image):",
  "  • Reproduce faithfully : the exact color, the exact material/texture, the exact cut, the exact stitching, the exact buttons (if any), the exact collar shape (if shirt/polo), the exact neckline (if t-shirt), the exact label brand.",
  "  • The garment must be RECOGNIZABLE as the same one from the source photo, just presented as a professional packshot.",
  "  • If the source photo is an iPhone snapshot (bad lighting, wrinkles, casual background) : IGNORE the environment, just extract the garment identity.",
  "",
  "⚠ FABRIC MUST BE PERFECTLY IRONED :",
  "  • The garment must appear FRESHLY IRONED and STEAMED — 100% smooth, wrinkle-free, crease-free, fold-free (except the intentional folding of the packshot).",
  "  • For linen, cotton, hemp : keep the natural fabric texture visible but ELIMINATE all wrinkles.",
  "  • Ignore any wrinkles present in the source iPhone photo — the packshot must show a perfectly ironed, crisp garment.",
  "",
  "OUTPUT : a single professional packshot with ONE garment (no ghosts, no doubles), perfectly ironed, indistinguishable from the reference in style, but with the source garment.",
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

    parts.push({ text: '=== IMAGE #1 : REFERENCE PACKSHOT ===\nThis is the reference packshot to reproduce (composition, lighting, background, style). Copy EVERYTHING from this image except the garment.' })
    parts.push(await toInlinePart(reference))

    parts.push({ text: '=== IMAGE #2 : SOURCE GARMENT ===\nThis is the actual garment to reproduce (an iPhone photo). Extract only the garment identity (color, material, cut, buttons, details). Ignore the iPhone photo\'s background, lighting, and wrinkles. Present this garment IN THE STYLE OF IMAGE #1.' })
    parts.push(await toInlinePart(source))

    parts.push({ text: 'FINAL REMINDER : Output = a professional GHOST packshot (folded shirt only, NO human, NO head, NO buste). Style = image #1. Garment = image #2. Nothing else.' })

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
