/**
 * 🏷 Logo Fix — étape 6 : passe IA (OpenAI Images, endpoint edits, avec masque).
 *
 * Entrée JSON : { cropUrl (PNG 1536×1024), maskUrl (PNG RGBA, transparent = zone éditable), logoUrl, prompt, quality, n }
 * Sortie : { images: string[] (URLs Blob, PNG 1536×1024), model, cost }
 *
 * Timeout 120 s + 1 nouvel essai ; paramètre non supporté par le modèle (input_fidelity, moderation) → renvoi sans.
 * Refus de modération / quota : message clair, pas de boucle.
 */
import { NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { OPENAI_IMAGE_MODEL } from '@/lib/imageModel'

export const maxDuration = 300
export const runtime = 'nodejs'

const MODEL = process.env.OPENAI_LOGO_MODEL || OPENAI_IMAGE_MODEL
const PRICE = { textIn: 5e-6, imageIn: 8e-6, out: 30e-6 } // USD / token (gpt-image-2.5)

async function getBlob(url: string, name: string) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Image inaccessible (${r.status}) : ${name}`)
  return new Blob([await r.arrayBuffer()], { type: r.headers.get('content-type')?.split(';')[0] || 'image/png' })
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const prompt = String(body.prompt ?? '').trim()
    const quality = ['low', 'medium', 'high'].includes(body.quality) ? body.quality : 'high'
    const n = Math.min(4, Math.max(1, Number(body.n) || 1))
    for (const k of ['cropUrl', 'maskUrl', 'logoUrl']) if (typeof body[k] !== 'string' || !/^https?:\/\//.test(body[k])) return NextResponse.json({ error: `${k} manquant.` }, { status: 400 })
    if (!prompt) return NextResponse.json({ error: 'Prompt requis.' }, { status: 400 })
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'OPENAI_API_KEY manquante côté serveur (Vercel → Settings → Environment Variables).' }, { status: 500 })

    const [crop, mask, logo] = await Promise.all([getBlob(body.cropUrl, 'recadrage'), getBlob(body.maskUrl, 'masque'), getBlob(body.logoUrl, 'logo')])
    const skip = new Set<string>()

    const send = async () => {
      const form = new FormData()
      form.append('model', MODEL)
      form.append('prompt', prompt)
      form.append('image[]', crop, 'crop.png')
      form.append('image[]', logo, `logo.${logo.type.includes('png') ? 'png' : logo.type.includes('webp') ? 'webp' : 'jpg'}`)
      form.append('mask', mask, 'mask.png')
      form.append('size', '1536x1024')
      form.append('quality', quality)
      form.append('n', String(n))
      form.append('output_format', 'png')
      if (!skip.has('input_fidelity')) form.append('input_fidelity', 'high')
      if (!skip.has('moderation')) form.append('moderation', 'low')
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 120_000)
      try {
        const res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: ctl.signal })
        return { res, data: await res.json().catch(() => null) as any }
      } finally { clearTimeout(timer) }
    }

    let out: { res: Response; data: any } | null = null
    for (let attempt = 0; attempt < 4; attempt++) {
      try { out = await send() } catch (e: any) {
        if (e?.name === 'AbortError' && attempt === 0) continue // timeout : 1 nouvel essai
        throw e?.name === 'AbortError' ? new Error('OpenAI ne répond pas (timeout 120 s, 2 essais).') : e
      }
      const param = String(out.data?.error?.param ?? '') + ' ' + String(out.data?.error?.message ?? '')
      if (!out.res.ok && /input_fidelity/i.test(param) && !skip.has('input_fidelity')) { skip.add('input_fidelity'); continue }
      if (!out.res.ok && /moderation/i.test(out.data?.error?.param ?? '') && !skip.has('moderation')) { skip.add('moderation'); continue }
      break
    }
    if (!out) throw new Error('Aucune réponse OpenAI.')
    const { res, data } = out
    const u = data?.usage
    const cost = u ? ((u.input_tokens_details?.text_tokens ?? 0) * PRICE.textIn + (u.input_tokens_details?.image_tokens ?? 0) * PRICE.imageIn + (u.output_tokens ?? 0) * PRICE.out) : undefined

    if (!res.ok) {
      const code = data?.error?.code ?? ''
      const msg = data?.error?.message ?? `HTTP ${res.status}`
      if (code === 'moderation_blocked' || /safety|moderation/i.test(msg)) return NextResponse.json({ error: `Refus de modération OpenAI : ${msg}`, kind: 'moderation' }, { status: 422 })
      if (res.status === 429 || /quota|billing|rate/i.test(msg)) return NextResponse.json({ error: `Quota OpenAI : ${msg}`, kind: 'quota' }, { status: 429 })
      return NextResponse.json({ error: `OpenAI : ${msg}` }, { status: res.status })
    }
    const b64s: string[] = (data?.data ?? []).map((d: any) => d?.b64_json).filter(Boolean)
    if (!b64s.length) return NextResponse.json({ error: 'OpenAI : réponse sans image.' }, { status: 502 })
    const images = await Promise.all(b64s.map(async (b64, i) => {
      const buf = Buffer.from(b64, 'base64')
      try {
        const b = await put(`logo-fix/${Date.now()}-${i}.png`, buf, { access: 'public', contentType: 'image/png', token: process.env.BLOB_READ_WRITE_TOKEN })
        return b.url
      } catch { return `data:image/png;base64,${b64}` }
    }))
    return NextResponse.json({ images, model: MODEL, cost })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Erreur inconnue' }, { status: 500 })
  }
}
