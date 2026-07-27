/**
 * Nature Morte — génération de visuels still-life adaptatifs.
 *
 * Le prompt s'adapte selon les inputs présents :
 *   - Produits (obligatoire) : les articles à mettre en scène
 *   - Reference (optionnel) : image d'inspiration à réinterpréter
 *   - Decors (optionnel) : fond à utiliser
 *   - Model body + face (optionnel) : mannequin (parfois juste une partie visible)
 *   - Description (optionnel) : consignes texte
 */
import { NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import sharp from 'sharp'

export const maxDuration = 300
export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const products     = formData.getAll('products').filter((v): v is File => v instanceof File)
    const reference    = formData.get('reference')    as File | null
    const decors       = formData.get('decors')       as File | null
    const modelBody    = formData.get('modelBody')    as File | null
    const modelFace    = formData.get('modelFace')    as File | null
    const modelName    = (formData.get('modelName')   as string | null) ?? ''
    const decorsName   = (formData.get('decorsName')  as string | null) ?? ''
    const description  = (formData.get('description') as string | null) ?? ''
    const ratio        = (formData.get('ratio')       as string | null) ?? '3:4'
    const quality      = (formData.get('quality')     as string | null) ?? '2K'
    const sku          = (formData.get('sku')         as string | null) ?? 'Nature Morte'

    if (products.length === 0) {
      return NextResponse.json({ error: 'Au moins un produit requis (champ "products").' }, { status: 400 })
    }

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY manquante.' }, { status: 500 })

    const debug: any = { steps: { present: {
      products: products.length,
      reference: !!reference,
      decors: !!decors,
      modelBody: !!modelBody,
      modelFace: !!modelFace,
      description: !!description,
    }}}

    // === Construction du prompt ADAPTATIF selon les inputs présents ===
    const sessionId = Date.now()
    const intro: string[] = [
      `[SESSION ${sessionId}]`,
      `Créer un visuel NATURE MORTE (still life) éditorial pour un catalogue mode / e-commerce.`,
      `SKU : "${sku}".`,
      ``,
      `⚠ COMPOSITION NATURE MORTE : les produits sont mis en scène de manière esthétique et éditoriale, ` +
      `pas juste posés à plat. Composition travaillée, lumière soignée, ambiance premium. ` +
      `Ce n'est PAS un packshot ghost classique — c'est une VRAIE MISE EN SCÈNE avec ambiance.`,
      ``,
    ]

    // ★ Reference (inspiration)
    if (reference) {
      intro.push(
        `⚠ IMAGE DE RÉFÉRENCE (inspiration — image 1 attachée) : cette image te donne L'ESPRIT / L'AMBIANCE / LA COMPOSITION à recréer. ` +
        `Copie sa mise en scène, sa lumière, son cadrage, son mood. ` +
        `⚠ MAIS le/les produit(s) montré(s) dans cette référence sont IRRELEVANT — remplace-les par le(s) produit(s) fourni(s) plus bas dans le prompt.`,
      )
    }

    // ★ Decors (fond spécifique)
    if (decors) {
      intro.push(
        `⚠ DÉCOR IMPOSÉ ("${decorsName}" — image jointe) : utilise ce fond EXACTEMENT tel qu'il est. Ne le modifie pas, ne le régénère pas, ` +
        `préserve sa couleur / texture / lumière pixel-perfect. Compose les produits DESSUS.`,
      )
    } else if (reference) {
      intro.push(
        `⚠ FOND : puisque aucun décor n'est imposé, reproduis fidèlement le fond / l'ambiance de la référence d'inspiration.`,
      )
    } else {
      intro.push(
        `⚠ FOND : fond neutre studio (beige, taupe, blanc cassé — au choix selon l'ambiance des produits). ` +
        `Uniforme, propre, éditorial premium.`,
      )
    }

    // ★ Model (mannequin partiel ou total selon inspiration)
    if (modelBody || modelFace) {
      intro.push(
        `⚠ MANNEQUIN "${modelName}" (photos jointes) : un mannequin ou une PARTIE du corps du mannequin apparaît dans le visuel. ` +
        `Regarde la référence d'inspiration pour comprendre quelle partie apparaît (main, bras, jambe, silhouette partielle, corps entier, etc.) et à quel endroit. ` +
        `Utilise l'identité du mannequin fourni : peau, ethnicité, cheveux, visage. ` +
        `Si le corps entier est visible : applique la morphologie top-model longiligne (jambes longues, silhouette élancée, 9-10 têtes).`,
      )
    } else {
      intro.push(
        `⚠ AUCUN MANNEQUIN dans ce visuel — pure nature morte de produits. Ne fais apparaître AUCUN humain (pas de main, pas de silhouette, pas de partie de corps).`,
      )
    }

    // ★ Description
    if (description) {
      intro.push(``, `⚠ CONSIGNES SPÉCIFIQUES : ${description}`)
    }

    // ★ Fabric + qualité
    intro.push(
      ``,
      `⚠ QUALITÉ : rendu ultra piqué, éclairage soigné et naturel (pas de flash cheap), ombres douces cohérentes, ` +
      `matières bien rendues, palette éditoriale premium. Style Zara / Massimo Dutti / Sézane / Toteme.`,
      `⚠ TISSUS : si des vêtements sont dans le visuel, ils apparaissent parfaitement repassés (lisses, sans plis, sans froissement).`,
    )

    // === Construction des parts (images étiquetées) ===
    const parts: any[] = [{ text: intro.join('\n') }]

    // Reference (inspiration) EN PREMIER (Gemini l'ancre le plus)
    if (reference) {
      parts.push({ text: `=== IMAGE 1 : RÉFÉRENCE D'INSPIRATION (mood, composition, ambiance à recréer) ===` })
      parts.push(await toInlinePart(reference))
    }

    // Decors (fond)
    if (decors) {
      parts.push({ text: `=== DÉCOR IMPOSÉ ("${decorsName}") — fond pixel-perfect à préserver ===` })
      parts.push(await toInlinePart(decors))
    }

    // Model body
    if (modelBody) {
      parts.push({ text: `=== MANNEQUIN BODY ("${modelName}") — pour l'identité (peau, morphologie de base) ===` })
      parts.push(await toInlinePart(modelBody))
    }
    if (modelFace) {
      parts.push({ text: `=== MANNEQUIN FACE ("${modelName}") — visage exact ===` })
      parts.push(await toInlinePart(modelFace))
    }

    // Products
    parts.push({ text: `=== PRODUIT${products.length > 1 ? 'S' : ''} À METTRE EN SCÈNE (${products.length} article${products.length > 1 ? 's' : ''}) — leur identité doit être STRICTEMENT préservée (couleur, matière, coupe, coutures, détails, étiquette). ⚠ Leur échelle dans le packshot est irrelevant — adapte-la à la composition finale. ===` })
    for (const p of products) parts.push(await toInlinePart(p))

    // Final self-check
    parts.push({ text:
      `⚠ SELF-CHECK final :\n` +
      `  1) Composition = ambiance/mood de la référence d'inspiration ${reference ? '(image 1)' : '(à imaginer selon les produits)'}\n` +
      `  2) Produits = ceux fournis dans les images "PRODUIT" (couleur/matière exactes, sans hallucinations)\n` +
      `  3) Fond = ${decors ? 'décor imposé (pixel-perfect)' : reference ? 'ambiance de la référence' : 'fond neutre studio'}\n` +
      `  4) Mannequin = ${(modelBody || modelFace) ? 'oui, partie visible selon la référence' : 'ABSENT — pure nature morte, aucun humain'}\n` +
      `Output = un visuel Nature Morte éditorial premium.`
    })

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
      return NextResponse.json({ error: geminiData?.error?.message || `Gemini HTTP ${geminiRes.status}`, debug }, { status: geminiRes.status })
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
    if (!b64) return NextResponse.json({ error: 'Gemini sans image.', debug }, { status: 502 })

    const rawBuf = Buffer.from(b64, 'base64')

    // Compression JPEG q92 pour download rapide
    let finalBuf: Buffer = rawBuf
    let finalMime = mime
    try {
      finalBuf = await sharp(rawBuf).jpeg({ quality: 92, progressive: true, mozjpeg: true }).toBuffer()
      finalMime = 'image/jpeg'
    } catch { /* keep raw */ }

    // Upload Vercel Blob
    let imageUrl: string
    let blobError: string | undefined
    try {
      const ext = finalMime === 'image/png' ? 'png' : 'jpg'
      const path = `nature-morte/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const blob = await put(path, finalBuf, {
        access: 'public', contentType: finalMime, cacheControlMaxAge: 60,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      })
      imageUrl = blob.url
    } catch (err: any) {
      imageUrl = `data:${finalMime};base64,${finalBuf.toString('base64')}`
      blobError = err?.message ?? String(err)
    }
    return NextResponse.json({ imageUrl, debug, blobError })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue', stack: error?.stack?.slice(0, 800) }, { status: 500 })
  }
}

async function toInlinePart(file: File) {
  const buf = Buffer.from(new Uint8Array(await file.arrayBuffer())).toString('base64')
  return { inlineData: { mimeType: file.type || 'image/jpeg', data: buf } }
}
