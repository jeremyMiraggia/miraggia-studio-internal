/**
 * Pipeline modulaire : IDM-VTON + background removal + paste-back pixel-perfect.
 *
 * Workflow (server-side) :
 *
 *   1. IDM-VTON (FAL.ai) : (mannequin réf, vêtement réf) → mannequin avec le bon vêtement
 *      (mais sur le fond du mannequin réf, PAS sur le fond Notion attendu)
 *
 *   2. Background removal (FAL.ai birefnet) : output IDM-VTON → image RGBA avec
 *      le sujet détouré (alpha = masque binaire du mannequin habillé)
 *
 *   3. Composite paste-back (sharp, server) :
 *        final = subject_rgba composited ON background_notion
 *      Le fond Notion reste BIT-EXACT (pixel-perfect), seul le sujet est neuf.
 *      Feathering ~6px sur le bord du masque pour éviter le halo.
 *
 *   4. Upload Vercel Blob → renvoie URL au client (= ZERO Fast Origin Transfer).
 */
import { NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { fal } from '@fal-ai/client'
import sharp from 'sharp'

export const maxDuration = 300
export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    const formData = await request.formData()

    const background     = formData.get('background')    as File | null
    const mannequinBody  = formData.get('mannequinBody') as File | null
    const products       = formData.getAll('products').filter((v): v is File => v instanceof File)
    const framing        = (formData.get('framing')        as string | null) ?? 'plein'
    const mannequinLabel = (formData.get('mannequinLabel') as string | null) ?? 'fashion model'
    const decorLabel     = (formData.get('decorLabel')     as string | null) ?? 'background'

    if (!mannequinBody) {
      return NextResponse.json({ error: 'mannequinBody requis pour le pipeline VTON.' }, { status: 400 })
    }
    if (products.length === 0) {
      return NextResponse.json({ error: 'Au moins 1 produit (vêtement) requis.' }, { status: 400 })
    }
    if (!background) {
      return NextResponse.json({ error: 'background requis pour le paste-back.' }, { status: 400 })
    }

    const falKey = process.env.FAL_KEY
    if (!falKey) {
      return NextResponse.json({ error: 'FAL_KEY manquante côté serveur.' }, { status: 500 })
    }

    // Configure FAL SDK
    fal.config({ credentials: falKey })

    // ============= ÉTAPE 1 — IDM-VTON =============
    // Upload les images vers FAL (storage temporaire FAL pour ne pas saturer Vercel)
    const humanUrl   = await fal.storage.upload(mannequinBody)
    const garmentUrl = await fal.storage.upload(products[0])

    // garment_des : description courte du vêtement (aide la fidélité)
    const garmentDescription = describeFraming(framing) + ' garment'

    const vtonResult: any = await fal.subscribe('fal-ai/idm-vton', {
      input: {
        human_image_url: humanUrl,
        garment_image_url: garmentUrl,
        description: garmentDescription,
        category: 'upper_body',  // par défaut buste/haut — IDM-VTON supporte upper_body / lower_body / dresses
      },
      logs: false,
    })

    const vtonImageUrl: string | undefined = vtonResult?.data?.image?.url ?? vtonResult?.image?.url
    if (!vtonImageUrl) {
      return NextResponse.json({ error: 'IDM-VTON n\'a pas renvoyé d\'image.', raw: vtonResult }, { status: 502 })
    }

    // ============= ÉTAPE 2 — Background removal (FAL birefnet) =============
    const rembgResult: any = await fal.subscribe('fal-ai/birefnet/v2', {
      input: { image_url: vtonImageUrl },
      logs: false,
    })

    const subjectRgbaUrl: string | undefined = rembgResult?.data?.image?.url ?? rembgResult?.image?.url
    if (!subjectRgbaUrl) {
      return NextResponse.json({ error: 'Background removal a échoué.', raw: rembgResult }, { status: 502 })
    }

    // ============= ÉTAPE 3 — Paste-back (sharp) =============
    // Télécharge le sujet RGBA et le fond original
    const [subjectBuf, backgroundBuf] = await Promise.all([
      fetch(subjectRgbaUrl).then(r => r.arrayBuffer()).then(b => Buffer.from(b)),
      mannequinBody ? background.arrayBuffer().then(b => Buffer.from(b)) : Promise.reject(new Error('no bg')),
    ])

    // Récupère les dimensions du fond pour resize le sujet
    const bgMeta = await sharp(backgroundBuf).metadata()
    const bgW = bgMeta.width ?? 1024
    const bgH = bgMeta.height ?? 1536

    // Resize le sujet pour tenir dans le fond (en gardant le ratio)
    // On le redimensionne à 90% de la hauteur du fond, centré horizontalement.
    const subjectResized = await sharp(subjectBuf)
      .resize({
        height: Math.round(bgH * 0.95),
        fit: 'inside',
        withoutEnlargement: false,
      })
      .png()
      .toBuffer()

    // Feathering : on adoucit le bord alpha du sujet pour éviter le halo dur
    const subjectFeathered = await featherAlpha(subjectResized, 6)

    const subjectMeta = await sharp(subjectFeathered).metadata()
    const subjW = subjectMeta.width ?? bgW
    const subjH = subjectMeta.height ?? bgH

    // Position : sujet centré horizontalement, ancré en bas du fond (les pieds touchent le sol)
    const left = Math.max(0, Math.round((bgW - subjW) / 2))
    const top  = Math.max(0, bgH - subjH)

    // Composite : fond original UNTOUCHED, sujet placé par-dessus
    const finalJpegBuf = await sharp(backgroundBuf)
      .composite([{ input: subjectFeathered, left, top, blend: 'over' }])
      .jpeg({ quality: 90, progressive: true })
      .toBuffer()

    // ============= ÉTAPE 4 — Upload Vercel Blob =============
    let imageUrl: string
    let blobError: string | undefined
    try {
      const path  = `pipeline/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
      const blob  = await put(path, finalJpegBuf, {
        access: 'public',
        contentType: 'image/jpeg',
        cacheControlMaxAge: 60,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      })
      imageUrl = blob.url
    } catch (err: any) {
      // Fallback data URL si Blob indispo
      const b64 = finalJpegBuf.toString('base64')
      imageUrl = `data:image/jpeg;base64,${b64}`
      blobError = err?.message ?? String(err)
    }

    return NextResponse.json({
      imageUrl,
      attempt: 1,
      // Debug : URLs intermédiaires pour comparer si besoin
      debug: {
        vtonImageUrl,
        subjectRgbaUrl,
        mannequinLabel,
        decorLabel,
      },
      blobError,
    })

  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue', stack: error?.stack?.slice(0, 800) }, { status: 500 })
  }
}

/* ============================== helpers ============================== */

/**
 * Adoucit le canal alpha sur N pixels pour éviter le halo dur lors du composite.
 * Implémentation : extract alpha → blur(N) → recombine.
 */
async function featherAlpha(rgbaBuf: Buffer, radius: number): Promise<Buffer> {
  // Sépare les canaux
  const { data, info } = await sharp(rgbaBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  if (channels !== 4) return rgbaBuf

  // Sépare alpha
  const alphaBuf = Buffer.alloc(width * height)
  for (let i = 0; i < width * height; i++) {
    alphaBuf[i] = data[i * 4 + 3]
  }

  // Flou gaussien sur alpha seulement
  const alphaBlurred = await sharp(alphaBuf, { raw: { width, height, channels: 1 } })
    .blur(radius)
    .raw()
    .toBuffer()

  // Recompose RGBA
  const out = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    out[i * 4]     = data[i * 4]
    out[i * 4 + 1] = data[i * 4 + 1]
    out[i * 4 + 2] = data[i * 4 + 2]
    out[i * 4 + 3] = alphaBlurred[i]
  }

  return await sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer()
}

function describeFraming(framing: string): string {
  const f = (framing ?? '').toLowerCase()
  if (f.includes('haut') || f.includes('upper')) return 'upper body'
  if (f.includes('bas')  || f.includes('lower')) return 'lower body'
  if (f.includes('mi'))                          return 'mid body'
  return 'full body'
}
