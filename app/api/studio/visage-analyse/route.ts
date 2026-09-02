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

/**
 * Modèles texte/vision candidats, testés dans l'ordre.
 * Google déprécie régulièrement les preview → on garde une liste de fallback
 * pour ne pas casser à chaque rotation de version.
 */
const TEXT_MODELS = [
  'gemini-3.1-pro-preview',
  'gemini-3-pro-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
]
const geminiUrl = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

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

    const payload = JSON.stringify({
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
    })

    // Essaie chaque modèle jusqu'à en trouver un disponible.
    // Un modèle déprécié renvoie une 404/400 avec "no longer available" → on passe au suivant.
    let data: any = null
    let usedModel = ''
    const attempts: string[] = []
    for (const model of TEXT_MODELS) {
      const res = await fetch(`${geminiUrl(model)}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      })
      const json: any = await res.json().catch(() => null)
      if (res.ok) {
        data = json
        usedModel = model
        break
      }
      const msg = json?.error?.message ?? `HTTP ${res.status}`
      attempts.push(`${model} → ${msg.slice(0, 120)}`)
      // Modèle indisponible / déprécié / inconnu → on tente le suivant
      const isModelIssue = res.status === 404 || /no longer available|not found|not supported/i.test(msg)
      if (!isModelIssue) {
        // Vraie erreur (quota, clé invalide, image refusée…) → inutile d'insister
        return NextResponse.json({ error: msg, attempts }, { status: res.status })
      }
    }

    if (!data) {
      return NextResponse.json({
        error: 'Aucun modèle Gemini texte disponible.',
        attempts,
      }, { status: 502 })
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

    return NextResponse.json({ analysis, model: usedModel })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue' }, { status: 500 })
  }
}
