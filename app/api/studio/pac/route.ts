/**
 * PAC — pose une pompe à chaleur à l'emplacement du placeholder (rectangle rouge ou blanc).
 * Entrée JSON : { imageUrl (original pleine résolution), pacUrls[], mode: 'crop' | 'full', quality }.
 * Sortie : { imageUrl (JPEG aux dimensions d'origine), placeholder, crop, size }.
 */
import { NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import sharp from 'sharp'

// Photos de 25-30 Mpx : pas de cache libvips (il garde les images décodées en mémoire) et un seul
// traitement lourd à la fois par instance — sinon plusieurs requêtes simultanées font tomber la fonction.
sharp.cache(false)
sharp.concurrency(1)
let heavy: Promise<unknown> = Promise.resolve()
function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  const run = heavy.then(job, job)
  heavy = run.catch(() => {})
  return run
}
import { imageFetch, imageProviderOf, withImageCost } from '@/lib/imageModel'
import { detectPlaceholder, chooseCrop, buildPacPrompt, pasteBack, nearestRatio } from '@/lib/pac'

export const maxDuration = 300
export const runtime = 'nodejs'

const isUrl = (u: any) => typeof u === 'string' && /^https?:\/\//.test(u)

async function fetchBuf(url: string) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Image inaccessible (${r.status})`)
  return Buffer.from(new Uint8Array(await r.arrayBuffer()))
}

async function handlePOST(request: Request) {
  const provider = imageProviderOf(request)
  try {
    const body = await request.json().catch(() => ({}))
    const imageUrl: string = body.imageUrl
    const pacUrls: string[] = (Array.isArray(body.pacUrls) ? body.pacUrls : []).filter(isUrl)
    const mode: 'crop' | 'full' = body.mode === 'full' ? 'full' : 'crop'
    const imageSize = body.quality === '2K' ? '2K' : '4K'
    if (!isUrl(imageUrl)) return NextResponse.json({ error: 'imageUrl requise.' }, { status: 400 })
    if (!pacUrls.length) return NextResponse.json({ error: 'Aucune image de PAC.' }, { status: 400 })
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY manquante.' }, { status: 500 })

    const original = await fetchBuf(imageUrl)
    const meta = await sharp(original).rotate().metadata()
    // dimensions après orientation EXIF
    const swap = (meta.orientation ?? 1) >= 5
    const W = (swap ? meta.height : meta.width) ?? 0, H = (swap ? meta.width : meta.height) ?? 0
    if (!W || !H) throw new Error('Image illisible.')

    // 1. Placeholder + 2. image envoyée (zone autour du placeholder, ou image entière) — étapes lourdes, une à la fois
    const { ph, crop, region } = await oneAtATime(async () => {
      const ph = await detectPlaceholder(original, W, H, apiKey)
      const crop = mode === 'crop' ? chooseCrop(ph.box, W, H) : { box: { left: 0, top: 0, width: W, height: H }, ratio: nearestRatio(W, H) }
      const region = await sharp(original).rotate().extract(crop.box)
        .resize({ width: 3072, height: 3072, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 93 }).toBuffer()
      return { ph, crop, region }
    })
    const pacs = await Promise.all(pacUrls.map(async u =>
      sharp(await fetchBuf(u)).rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer()))

    const rel = { x: (ph.box.left + ph.box.width / 2 - crop.box.left) / crop.box.width, y: (ph.box.top + ph.box.height / 2 - crop.box.top) / crop.box.height }
    const tol = 0.01 * Math.max(W, H)   // un placeholder à quelques pixels du bord est considéré coupé
    const edgeCut = ph.box.left <= tol || ph.box.top <= tol || ph.box.left + ph.box.width >= W - tol || ph.box.top + ph.box.height >= H - tol
    const prompt = buildPacPrompt({ color: ph.color, isCrop: mode === 'crop', pacCount: pacs.length, posX: rel.x, posY: rel.y, edgeCut })

    // 3. Génération (Gemini ou ChatGPT selon l'onglet)
    const parts: any[] = [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data: region.toString('base64') } }]
    for (const p of pacs) parts.push({ inlineData: { mimeType: 'image/jpeg', data: p.toString('base64') } })
    const res = await imageFetch(provider,
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${apiKey}`,
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: crop.ratio, imageSize } },
          safetySettings: ['HARASSMENT', 'HATE_SPEECH', 'SEXUALLY_EXPLICIT', 'DANGEROUS_CONTENT'].map(c => ({ category: `HARM_CATEGORY_${c}`, threshold: 'BLOCK_ONLY_HIGH' })),
        }),
      })
    const data: any = await res.json().catch(() => null)
    if (!res.ok) return NextResponse.json({ error: data?.error?.message ?? `Génération HTTP ${res.status}` }, { status: res.status })
    const img = (data?.candidates?.[0]?.content?.parts ?? []).find((p: any) => p?.inlineData?.data)
    if (!img) {
      const reason = data?.candidates?.[0]?.finishReason ?? data?.promptFeedback?.blockReason ?? ''
      const txt = (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join(' ').slice(0, 200)
      return NextResponse.json({ error: `Aucune image générée. ${reason} ${txt}`.trim() }, { status: 502 })
    }
    const generated = Buffer.from(img.inlineData.data, 'base64')

    // 4. Sortie aux dimensions d'origine
    const out = await oneAtATime<Buffer>(() => mode === 'crop'
      ? pasteBack(original, generated, crop.box, ph.box)
      : sharp(generated).resize(W, H, { fit: 'fill', kernel: 'lanczos3' }).withMetadata().jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer())

    let url: string
    try {
      const b = await put(`pac/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`, out, {
        access: 'public', contentType: 'image/jpeg', cacheControlMaxAge: 60, token: process.env.BLOB_READ_WRITE_TOKEN,
      })
      url = b.url
    } catch (e: any) {
      // Sur Vercel, une réponse de 15-30 Mo en data URL dépasserait la limite de réponse (4,5 Mo) et ferait planter la fonction
      if (process.env.VERCEL) return NextResponse.json({ error: `Enregistrement Blob impossible : ${e?.message ?? e}` }, { status: 502 })
      url = `data:image/jpeg;base64,${out.toString('base64')}`   // local sans Blob
    }
    return NextResponse.json({ imageUrl: url, placeholder: ph, crop, size: { W, H }, mode })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Erreur PAC' }, { status: 500 })
  }
}

export const POST = withImageCost(handlePOST)
