/**
 * Lingerie — recadrage d'un visuel généré en cadrage large (coupé à la bouche / au ventre selon le type).
 * Entrée JSON : { imageUrl, ratio, type }. Sortie : { imageUrl (recadré), box, landmarks }.
 */
import { NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { locateLandmarks, cropForType, type CropType } from '@/lib/lingerieCrop'

export const maxDuration = 60
export const runtime = 'nodejs'

const TYPES: CropType[] = ['ensemble', 'pyjama', 'haut', 'bas']

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const imageUrl: string = typeof body.imageUrl === 'string' ? body.imageUrl : ''
    const ratio: string = typeof body.ratio === 'string' ? body.ratio : '3:4'
    const type: CropType = TYPES.includes(body.type) ? body.type : 'ensemble'
    if (!/^(https?:|data:image\/)/.test(imageUrl)) return NextResponse.json({ error: 'imageUrl requise.' }, { status: 400 })
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY manquante.' }, { status: 500 })

    let buf: Buffer, mime: string
    if (imageUrl.startsWith('data:')) {
      const m = imageUrl.match(/^data:([^;]+);base64,(.*)$/)
      if (!m) return NextResponse.json({ error: 'data URL invalide.' }, { status: 400 })
      mime = m[1]; buf = Buffer.from(m[2], 'base64')
    } else {
      const res = await fetch(imageUrl)
      if (!res.ok) return NextResponse.json({ error: `Image inaccessible (${res.status}).` }, { status: 502 })
      mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]
      buf = Buffer.from(new Uint8Array(await res.arrayBuffer()))
    }

    const landmarks = await locateLandmarks(buf, mime, apiKey)
    const crop = await cropForType(buf, type, ratio, landmarks)

    let url: string
    try {
      const b = await put(`lingerie/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-crop.jpg`, crop.buf, {
        access: 'public', contentType: 'image/jpeg', cacheControlMaxAge: 60, token: process.env.BLOB_READ_WRITE_TOKEN,
      })
      url = b.url
    } catch {
      url = `data:image/jpeg;base64,${crop.buf.toString('base64')}`   // Blob indisponible (local) → data URL
    }
    return NextResponse.json({ imageUrl: url, box: crop.box, source: crop.source, landmarks })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Erreur de recadrage' }, { status: 500 })
  }
}
