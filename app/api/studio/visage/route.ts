/**
 * Visage — génération de mannequins sur mesure (face + profil cohérents).
 *
 * Workflow en 2 appels chaînés :
 *   1. Gemini génère la vue de FACE à partir du prompt construit depuis les critères
 *   2. Gemini génère le PROFIL en recevant l'image de face en référence
 *      → garantit que c'est bien la MÊME personne (cohérence d'identité)
 */
import { NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import sharp from 'sharp'

export const maxDuration = 300
export const runtime = 'nodejs'

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const facePrompt:     string  = body.facePrompt     ?? ''
    const profilePrompt:  string  = body.profilePrompt  ?? ''
    const fullBodyPrompt: string  = body.fullBodyPrompt ?? ''
    const ratio:          string  = body.ratio          ?? '3:4'
    const quality:        string  = body.quality        ?? '2K'
    const onlyFace:       boolean = body.onlyFace === true
    const withFullBody:   boolean = body.withFullBody === true

    if (!facePrompt) return NextResponse.json({ error: 'facePrompt requis.' }, { status: 400 })

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY manquante.' }, { status: 500 })

    const imageSize = quality === '4K' ? '4K' : quality === '1K' ? '1K' : '2K'
    const sessionId = Date.now()
    const debug: any = {}

    const callGemini = async (parts: any[]) => {
      const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
        }),
      })
      const data: any = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error?.message || `Gemini HTTP ${res.status}`)
      const gParts = data?.candidates?.[0]?.content?.parts ?? []
      for (const p of gParts) {
        if (p?.inlineData?.mimeType?.startsWith('image/')) {
          return { b64: p.inlineData.data as string, mime: p.inlineData.mimeType as string }
        }
      }
      const txt = gParts.filter((p: any) => typeof p?.text === 'string').map((p: any) => p.text).join(' ')
      throw new Error(`Gemini n'a pas renvoyé d'image. ${txt.slice(0, 200)}`)
    }

    const uploadBlob = async (buf: Buffer, label: string) => {
      // JPEG q92 pour chargement rapide
      let out = buf
      let mime = 'image/png'
      try {
        out = await sharp(buf).jpeg({ quality: 92, progressive: true, mozjpeg: true }).toBuffer()
        mime = 'image/jpeg'
      } catch { /* keep png */ }
      try {
        const ext = mime === 'image/png' ? 'png' : 'jpg'
        const path = `visage/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${label}.${ext}`
        const blob = await put(path, out, {
          access: 'public', contentType: mime, cacheControlMaxAge: 60,
          token: process.env.BLOB_READ_WRITE_TOKEN,
        })
        return blob.url
      } catch {
        return `data:${mime};base64,${out.toString('base64')}`
      }
    }

    // ============= ÉTAPE 1 — FACE =============
    const faceRes = await callGemini([{ text: `[SESSION ${sessionId}]\n${facePrompt}` }])
    const faceBuf = Buffer.from(faceRes.b64, 'base64')
    const faceUrl = await uploadBlob(faceBuf, 'face')
    debug.face = { bytes: faceBuf.length }

    if (onlyFace) {
      return NextResponse.json({ faceUrl, profileUrl: null, fullBodyUrl: null, debug })
    }

    // ============= ÉTAPE 2 — PROFIL (avec la face en référence) =============
    let profileUrl: string | null = null
    let profileError: string | undefined
    try {
      const profileParts = [
        { text: `[SESSION ${sessionId}]\n${profilePrompt || 'Generate the side profile of this exact model, same session, same lighting, same white background.'}` },
        { inlineData: { mimeType: faceRes.mime, data: faceRes.b64 } },
        { text: '⚠ FINAL REMINDER : the image above is the FRONT view of the model. Produce the strict 90° SIDE PROFILE of THE SAME PERSON — identical skin, hair, features, piercings, top, background and lighting. Same framing scale.' },
      ]
      const profRes = await callGemini(profileParts)
      const profBuf = Buffer.from(profRes.b64, 'base64')
      profileUrl = await uploadBlob(profBuf, 'profile')
      debug.profile = { bytes: profBuf.length }
    } catch (e: any) {
      profileError = e?.message ?? String(e)
      debug.profile = { error: profileError }
    }

    // ============= ÉTAPE 3 — PLEIN-PIED (optionnel, face en référence) =============
    let fullBodyUrl: string | null = null
    let fullBodyError: string | undefined
    if (withFullBody && fullBodyPrompt) {
      try {
        const bodyParts = [
          { text: `[SESSION ${sessionId}]\n${fullBodyPrompt}` },
          { inlineData: { mimeType: faceRes.mime, data: faceRes.b64 } },
          { text: '⚠ FINAL REMINDER : the image above is the FACE of the model. Produce the FULL BODY standing shot of THE SAME PERSON, head to feet, same white background, same lighting. The head must look proportionally SMALL relative to the body (fashion model proportions). Count the heads : the total height must match the ratio specified above.' },
        ]
        const bodyRes = await callGemini(bodyParts)
        const bodyBuf = Buffer.from(bodyRes.b64, 'base64')
        fullBodyUrl = await uploadBlob(bodyBuf, 'fullbody')
        debug.fullBody = { bytes: bodyBuf.length }
      } catch (e: any) {
        fullBodyError = e?.message ?? String(e)
        debug.fullBody = { error: fullBodyError }
      }
    }

    return NextResponse.json({ faceUrl, profileUrl, fullBodyUrl, profileError, fullBodyError, debug })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue', stack: error?.stack?.slice(0, 600) }, { status: 500 })
  }
}
