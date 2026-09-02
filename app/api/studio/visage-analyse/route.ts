/**
 * Visage — analyse d'une photo de référence.
 *
 * Reçoit une image + le prompt d'analyse (liste des IDs d'options disponibles),
 * renvoie un JSON avec les critères détectés, prêt à pré-remplir le formulaire.
 *
 * Utilise gemini-3-pro (mode vision/texte), PAS le modèle image.
 */
import { NextResponse } from 'next/server'

export const maxDuration = 120
export const runtime = 'nodejs'

const GEMINI_TEXT_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent'

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const image  = formData.get('image')  as File | null
    const prompt = (formData.get('prompt') as string | null) ?? ''

    if (!image)  return NextResponse.json({ error: 'Image requise.' },  { status: 400 })
    if (!prompt) return NextResponse.json({ error: 'Prompt requis.' }, { status: 400 })

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY manquante.' }, { status: 500 })

    const buf = Buffer.from(new Uint8Array(await image.arrayBuffer())).toString('base64')

    const res = await fetch(`${GEMINI_TEXT_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inlineData: { mimeType: image.type || 'image/jpeg', data: buf } },
          ],
        }],
        generationConfig: {
          responseMimeType: 'application/json',   // force une réponse JSON stricte
          temperature: 0.2,                        // peu de créativité = plus déterministe
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      }),
    })

    const data: any = await res.json().catch(() => null)
    if (!res.ok) {
      return NextResponse.json({ error: data?.error?.message || `Gemini HTTP ${res.status}` }, { status: res.status })
    }

    const parts = data?.candidates?.[0]?.content?.parts ?? []
    const text  = parts.filter((p: any) => typeof p?.text === 'string').map((p: any) => p.text).join('').trim()
    if (!text) return NextResponse.json({ error: 'Gemini n\'a renvoyé aucun texte.' }, { status: 502 })

    // Nettoyage défensif : retire un éventuel bloc markdown ```json ... ```
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

    let analysis: any
    try {
      analysis = JSON.parse(cleaned)
    } catch {
      return NextResponse.json({
        error: 'Réponse Gemini non parsable en JSON.',
        raw: cleaned.slice(0, 500),
      }, { status: 502 })
    }

    return NextResponse.json({ analysis })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue' }, { status: 500 })
  }
}
