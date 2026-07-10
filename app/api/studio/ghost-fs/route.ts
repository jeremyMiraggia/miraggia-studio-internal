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

export const maxDuration = 300
export const runtime = 'nodejs'

const ANTI_HALLUCINATION_PROMPT = [
  "TASK : Recreate the packshot from the REFERENCE image, but replace the garment with the one shown in the SOURCE image.",
  "",
  "⚠ CRITICAL — GHOST PACKSHOT ONLY :",
  "This is a GHOST MANNEQUIN packshot of a FOLDED shirt ALONE.",
  "There is NO human, NO model, NO head, NO body, NO neck, NO hands, NO face, NO buste, NO silhouette.",
  "Just the folded garment on a plain uniform background, exactly like the REFERENCE image.",
  "If you see any human element in your generation, REMOVE IT.",
  "",
  "⚠ COPY FROM THE REFERENCE IMAGE (the 1st attached image):",
  "  • the exact same composition (garment centered, same crop, same aspect ratio)",
  "  • the exact same fold (collar visible, cuff visible, buttons visible, size label visible)",
  "  • the exact same pose of the folded shirt",
  "  • the exact same background color and texture (uniform light grey/white studio)",
  "  • the exact same lighting (soft, even, no harsh shadows)",
  "  • the exact same subtle drop shadow underneath the garment",
  "  • the exact same sharpness and professional quality (very piqué, e-commerce catalog quality)",
  "",
  "⚠ REPLACE THE GARMENT with the one from the SOURCE image (the 2nd attached image):",
  "  • Reproduce faithfully : the exact color, the exact material/texture, the exact cut, the exact stitching, the exact buttons, the exact collar shape, the exact label brand (FATHER & SONS if visible).",
  "  • The garment must be RECOGNIZABLE as the same one from the source photo, just presented as a professional packshot.",
  "  • If the source photo is an iPhone snapshot (bad lighting, wrinkles, casual background) : ignore the environment, just extract the garment identity.",
  "",
  "OUTPUT : a single professional packshot, indistinguishable from the reference in style, but with the source garment.",
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

    const buf = Buffer.from(b64, 'base64')

    // Upload Blob
    let imageUrl: string
    let blobError: string | undefined
    try {
      const ext = mime === 'image/png' ? 'png' : 'jpg'
      const path = `ghost-fs/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const blob = await put(path, buf, {
        access: 'public', contentType: mime, cacheControlMaxAge: 60,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      })
      imageUrl = blob.url
    } catch (err: any) {
      imageUrl = `data:${mime};base64,${b64}`
      blobError = err?.message ?? String(err)
    }
    return NextResponse.json({ imageUrl, blobError })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue' }, { status: 500 })
  }
}

async function toInlinePart(file: File) {
  const buf = Buffer.from(new Uint8Array(await file.arrayBuffer())).toString('base64')
  return { inlineData: { mimeType: file.type || 'image/jpeg', data: buf } }
}
