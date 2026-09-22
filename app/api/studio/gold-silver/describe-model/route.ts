/**
 * Golden Silver — description courte d'un mannequin à partir de sa FACE PHOTO (+ corps).
 *
 * Générée UNE fois par mannequin, puis réinjectée dans chaque prompt sous
 * "MODEL DESCRIPTION" pour verrouiller l'identité (Gemini invente moins un autre visage
 * quand le texte et l'image disent la même chose).
 *
 * Entrée JSON : { faceUrl, bodyUrl?, name? }  →  { description, model }
 */
import { NextResponse } from 'next/server'

export const maxDuration = 60
export const runtime = 'nodejs'

const MODELS = ['gemini-3.1-flash', 'gemini-2.5-flash', 'gemini-2.5-pro']

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const faceUrl: string = body.faceUrl ?? ''
    const bodyUrl: string = body.bodyUrl ?? ''
    const name: string    = body.name ?? ''
    if (!/^https?:\/\//.test(faceUrl)) return NextResponse.json({ error: 'faceUrl requise.' }, { status: 400 })
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY manquante.' }, { status: 500 })

    const parts: any[] = [{ text: [
      'Describe this fashion model for an image-generation prompt. The goal is that another model reproduces EXACTLY this person, so be specific and visual, not flattering.',
      'Write 4 to 6 short lines in English, plain text, no bullets, no headings, no name, no age guess, covering in this order:',
      '1) skin tone and undertone; 2) face shape, cheekbones, jaw, chin; 3) eyes (color, shape, spacing), eyebrows (shape, thickness); 4) nose and lips (shape, fullness); 5) hair (color, texture, length, parting, style); 6) any distinctive marks (freckles, moles, gap, dimples) and, if a body photo is given, build and height impression.',
      'Be concrete ("light olive skin with warm undertone", "almond dark-brown eyes set slightly wide", "straight nose, medium bridge"). Max 120 words.',
    ].join('\n') }]
    parts.push({ text: '=== FACE PHOTO ===' })
    parts.push(await toInlinePart(faceUrl))
    if (/^https?:\/\//.test(bodyUrl)) {
      parts.push({ text: '=== BODY PHOTO (same person) ===' })
      parts.push(await toInlinePart(bodyUrl))
    }

    const payload = JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.2 } })
    let lastErr = ''
    for (const model of MODELS) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
      })
      const json: any = await res.json().catch(() => null)
      if (!res.ok) {
        const msg = json?.error?.message ?? `HTTP ${res.status}`
        lastErr = `${model}: ${msg}`
        if (res.status === 404 || /not found|no longer available|not supported/i.test(msg)) continue
        return NextResponse.json({ error: lastErr }, { status: res.status })
      }
      const text = (json?.candidates?.[0]?.content?.parts ?? []).filter((p: any) => typeof p?.text === 'string').map((p: any) => p.text).join('').trim()
      if (!text) { lastErr = `${model}: réponse vide`; continue }
      return NextResponse.json({ description: text.replace(/\*\*/g, '').trim(), model, name })
    }
    return NextResponse.json({ error: lastErr || 'Aucun modèle disponible.' }, { status: 502 })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue' }, { status: 500 })
  }
}

async function toInlinePart(url: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Image inaccessible (${res.status})`)
  const mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim()
  const buf = Buffer.from(new Uint8Array(await res.arrayBuffer()))
  return { inlineData: { mimeType: mime, data: buf.toString('base64') } }
}
