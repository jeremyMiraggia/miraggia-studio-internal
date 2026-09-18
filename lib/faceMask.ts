/**
 * faceMask.ts — masque la TÊTE (visage + cheveux) d'un mannequin sur une photo de tenue,
 * pour que Gemini n'ancre pas son identité sur celui de la référence.
 *
 * 1. Détection : Gemini Flash (vision) renvoie la boîte de la tête en JSON.
 *    Convention Gemini : [ymin, xmin, ymax, xmax] sur une échelle 0-1000.
 * 2. Masquage : pixelisation forte de la zone (avec marge), le reste intact.
 *
 * Si aucune personne / aucune tête détectée (vêtement à plat, packshot) → image inchangée.
 */
import sharp from 'sharp'

const DETECT_MODELS = ['gemini-3.1-flash', 'gemini-2.5-flash', 'gemini-2.5-pro']

export type HeadDetection = {
  hasPerson: boolean
  box?: { ymin: number; xmin: number; ymax: number; xmax: number }   // 0..1
  model?: string
  error?: string
}

export async function detectHead(buf: Buffer, mime: string, apiKey: string): Promise<HeadDetection> {
  const prompt = [
    'You are a vision detector. Look at this fashion photo.',
    'Question 1: is there a real human person WEARING the garment (not a flat-lay, not a mannequin dummy, not a hanger)?',
    'Question 2: if yes, give ONE bounding box that covers the WHOLE HEAD: face AND all the hair (including hair falling on the shoulders), from the top of the hair to just under the chin.',
    'Answer with strict JSON only: {"hasPerson": boolean, "head": [ymin, xmin, ymax, xmax] | null}',
    'Coordinates are integers on a 0-1000 scale relative to the image (y = vertical, x = horizontal). If the head is cut by the frame, clamp to the frame. If no person, "head" is null.',
  ].join('\n')
  const payload = JSON.stringify({
    contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: buf.toString('base64') } }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  })
  let lastErr = ''
  for (const model of DETECT_MODELS) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
      })
      const json: any = await res.json().catch(() => null)
      if (!res.ok) {
        const msg = json?.error?.message ?? `HTTP ${res.status}`
        lastErr = `${model}: ${msg}`
        if (res.status === 404 || /not found|no longer available|not supported/i.test(msg)) continue
        return { hasPerson: false, error: lastErr }
      }
      const text = (json?.candidates?.[0]?.content?.parts ?? []).filter((p: any) => typeof p?.text === 'string').map((p: any) => p.text).join('').trim()
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      const parsed = JSON.parse(cleaned)
      const hasPerson = !!parsed?.hasPerson
      const h = parsed?.head
      if (!hasPerson || !Array.isArray(h) || h.length !== 4) return { hasPerson, model }
      const [ymin, xmin, ymax, xmax] = h.map((v: any) => Math.max(0, Math.min(1000, Number(v) || 0)) / 1000)
      if (ymax <= ymin || xmax <= xmin) return { hasPerson, model }
      return { hasPerson, box: { ymin, xmin, ymax, xmax }, model }
    } catch (e: any) {
      lastErr = `${model}: ${e?.message ?? e}`
    }
  }
  return { hasPerson: false, error: lastErr || 'détection impossible' }
}

/**
 * Pixelise la zone de la tête (marge 12 % autour de la boîte).
 * Renvoie le JPEG masqué + la boîte pixel appliquée.
 */
export async function maskHead(buf: Buffer, box: { ymin: number; xmin: number; ymax: number; xmax: number }) {
  const meta = await sharp(buf).metadata()
  const W = meta.width ?? 0, H = meta.height ?? 0
  if (!W || !H) throw new Error('image illisible')
  const bw = (box.xmax - box.xmin) * W, bh = (box.ymax - box.ymin) * H
  const mx = bw * 0.12, my = bh * 0.12
  const left   = Math.max(0, Math.round(box.xmin * W - mx))
  const top    = Math.max(0, Math.round(box.ymin * H - my))
  const right  = Math.min(W, Math.round(box.xmax * W + mx))
  const bottom = Math.min(H, Math.round(box.ymax * H + my))
  const w = right - left, h = bottom - top
  if (w < 4 || h < 4) throw new Error('boîte trop petite')

  // Pixelisation : réduction à ~6 blocs de large puis agrandissement sans lissage,
  // puis léger flou pour casser les arêtes. Aucun visage ni cheveu lisible.
  const region = await sharp(buf).extract({ left, top, width: w, height: h }).toBuffer()
  const blocks = 6
  const tiny = await sharp(region).resize({ width: blocks, height: Math.max(1, Math.round(blocks * h / w)), kernel: 'lanczos3' }).toBuffer()
  const pixelated = await sharp(tiny).resize({ width: w, height: h, kernel: 'nearest' }).blur(Math.max(2, w * 0.02)).toBuffer()

  const out = await sharp(buf).composite([{ input: pixelated, left, top }]).jpeg({ quality: 93 }).toBuffer()
  return { buf: out, mime: 'image/jpeg', pixelBox: { left, top, width: w, height: h }, imageSize: { W, H } }
}
