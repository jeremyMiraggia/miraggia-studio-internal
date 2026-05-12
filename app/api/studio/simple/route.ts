import { NextResponse } from 'next/server'

export const maxDuration = 60

export async function POST(request: Request) {
  try {
    const formData   = await request.formData()
    const subject    = formData.get('subject')    as File
    const background = formData.get('background') as File
    const brief      = formData.get('brief')      as string
    const ratio      = formData.get('ratio')      as string
    const quality    = formData.get('quality')    as string

    if (!subject || !background) {
      return NextResponse.json({ error: 'Images requises' }, { status: 400 })
    }

    // Convertir en base64
    const subjectBuffer = await subject.arrayBuffer()
    const subjectB64    = Buffer.from(subjectBuffer).toString('base64')
    const subjectMime   = subject.type || 'image/jpeg'

    const bgBuffer = await background.arrayBuffer()
    const bgB64    = Buffer.from(bgBuffer).toString('base64')
    const bgMime   = background.type || 'image/jpeg'

    const aspectRatio = ratio || '9:16'
    const imageSize   = quality === '4K' ? '4K' : quality === '1K' ? '1K' : '2K'

    const prompt = `Fusionne ce sujet/vêtement avec l'image de fond fournie.
Direction artistique : ${brief}.
Format : ${aspectRatio}. Résolution cible : ${imageSize}.
Résultat photographique professionnel, lumière cohérente entre sujet et fond, prêt à publier.`

    // Appel Gemini 3 Pro Image Preview
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inlineData: { mimeType: subjectMime, data: subjectB64 } },
              { inlineData: { mimeType: bgMime,      data: bgB64 } },
            ]
          }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: {
              aspectRatio,
              imageSize,
            },
          },
        }),
      }
    )

    if (!geminiRes.ok) {
      const err = await geminiRes.text()
      return NextResponse.json({ error: err }, { status: 500 })
    }

    const data  = await geminiRes.json()
    const parts = data?.candidates?.[0]?.content?.parts ?? []

    for (const part of parts) {
      if (part.inlineData?.mimeType?.startsWith('image/')) {
        const imageData = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
        return NextResponse.json({ imageUrl: imageData })
      }
    }

    return NextResponse.json({ error: 'Aucune image générée' }, { status: 500 })

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}