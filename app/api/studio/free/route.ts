import { NextResponse } from 'next/server'

export const maxDuration = 300

/**
 * Free Prompt — génération libre via Gemini 3 Pro Image Preview.
 *
 * Body (FormData) :
 *   - prompt   : string   (obligatoire)  — le prompt brut tel quel
 *   - ratio    : string   (optionnel)    — '9:16' | '3:4' | '1:1' | '16:9' | '4:3'
 *   - quality  : string   (optionnel)    — '1K' | '2K' | '4K'
 *   - refs     : File[]   (optionnel)    — 0..N images de référence
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

    // Toutes les références image (clé "refs" répétée)
    const refs = formData.getAll('refs').filter((v): v is File => v instanceof File)

    const inlineParts: Array<{ inlineData: { mimeType: string; data: string } }> = []
    for (const file of refs) {
      const buf = Buffer.from(await file.arrayBuffer()).toString('base64')
      inlineParts.push({
        inlineData: {
          mimeType: file.type || 'image/jpeg',
          data: buf,
        },
      })
    }

    const aspectRatio = ratio
    const imageSize   = quality === '4K' ? '4K' : quality === '1K' ? '1K' : '2K'

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY manquante côté serveur.' }, { status: 500 })
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              ...inlineParts,
            ],
          }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: {
              aspectRatio,
              imageSize,
            },
          },
        }),
      },
    )

    if (!geminiRes.ok) {
      const err = await geminiRes.text()
      return NextResponse.json({ error: err }, { status: 500 })
    }

    const data  = await geminiRes.json()
    const parts = data?.candidates?.[0]?.content?.parts ?? []

    for (const part of parts) {
      if (part.inlineData?.mimeType?.startsWith('image/')) {
        const imageUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
        return NextResponse.json({ imageUrl })
      }
    }

    return NextResponse.json({ error: 'Aucune image générée.' }, { status: 500 })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue' }, { status: 500 })
  }
}
