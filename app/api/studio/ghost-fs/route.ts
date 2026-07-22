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
  "Utilise le packshot de l'image 1 comme référence stricte et unique pour la vue.",
  "À partir du produit de l'image 2, recrée exactement :",
  "  • le même angle de prise de vue ;",
  "  • la même orientation du produit ;",
  "  • le même niveau de rotation ;",
  "  • la même perspective ;",
  "  • le même cadrage ;",
  "  • la même position dans l'image ;",
  "  • la même échelle et les mêmes proportions visibles que sur l'image 1.",
  "",
  "La silhouette et les contours du produit généré doivent s'aligner avec ceux de l'image 1. Ne crée pas une vue similaire ou approximative : reproduis précisément la vue de l'image 1.",
  "",
  "L'image 1 sert uniquement de référence pour la vue, l'angle et le cadrage.",
  "",
  "Le produit doit rester strictement celui de l'image 2. Ne modifie ni sa forme, ni sa coupe, ni sa longueur, ni ses volumes, ni ses détails, ni ses coutures, ni sa matière, ni sa texture, ni sa couleur, ni ses finitions.",
  "",
  "Ne mélange jamais les caractéristiques des deux produits.",
  "",
  "⚠ Contraintes techniques (à respecter en plus) :",
  "  • Packshot GHOST : UN SEUL produit, sans doublure/fantôme/reflet, sans humain, sans mannequin, sans tête, sans corps.",
  "  • Fond identique à l'image 1 (couleur, texture, uniformité).",
  "  • Lumière identique à l'image 1.",
  "  • Vêtement PARFAITEMENT REPASSÉ : tissu lisse, tendu, sans plis ni froissements (garde la texture naturelle du tissu mais élimine les plis).",
  "  • Étiquette de marque reproduite avec précision (texte exact, pas d'hallucination du type 'TATHER' au lieu de 'FATHER').",
  "  • Rendu ultra piqué, netteté maximale, qualité catalogue e-commerce professionnel.",
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

    parts.push({ text: '=== IMAGE 1 — RÉFÉRENCE VUE / ANGLE / CADRAGE ===\nCopie EXACTEMENT la vue, l\'angle, l\'orientation, la rotation, la perspective, le cadrage, la position, l\'échelle et les proportions de cette image. Le produit montré ici sert UNIQUEMENT à te donner ces informations — ne le reproduis PAS dans l\'output.' })
    parts.push(await toInlinePart(reference))

    parts.push({ text: '=== IMAGE 2 — PRODUIT À REPRODUIRE ===\nC\'est LE produit qui doit apparaître dans l\'output. Reproduis-le à l\'identique : forme, coupe, longueur, volumes, détails, coutures, matière, texture, couleur, finitions, étiquette de marque. Ignore complètement le cadrage / angle / fond / lumière de cette image — utilise UNIQUEMENT ceux de l\'image 1.' })
    parts.push(await toInlinePart(source))

    parts.push({ text: '⚠ SELF-CHECK final avant de produire l\'output — répond honnêtement :\n  1) VUE / CADRAGE : si je place mon output à côté de l\'image 1, est-ce qu\'ils ont EXACTEMENT le même angle, la même rotation, le même cadrage, la même échelle ? Si les vues diffèrent, mon output est FAUX — je n\'ai pas reproduit précisément la vue de l\'image 1.\n  2) PRODUIT : est-ce que le produit dans mon output est celui de l\'image 2 (couleur, matière, coupe, coutures, étiquette) et PAS celui de l\'image 1 ?\n  3) MÉLANGE : est-ce que j\'ai bien évité de mélanger les caractéristiques des deux produits ?\n\nOutput = un packshot ghost pro, UN SEUL produit, sans humain. Vue = image 1. Produit = image 2. Pas de mélange.' })

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
