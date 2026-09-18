/**
 * faceMask.ts — masque la TÊTE (visage + cheveux) d'un mannequin sur une photo de tenue,
 * pour que Gemini n'ancre pas son identité sur celui de la référence.
 *
 * 1. Détection : Gemini Flash (vision) renvoie en JSON, champs nommés, échelle 0-1000 :
 *      face  = boîte serrée du visage (front → menton, tempe → tempe)
 *      hair  = boîte de la chevelure visible (peut dépasser le visage sur les côtés / le haut)
 *      chinY = ligne du menton
 * 2. Masque = union(face, hair) mais JAMAIS sous le menton (+3 %) : le vêtement,
 *    le cou et les épaules restent intacts. Cheveux tombant sur le buste : non masqués
 *    (pas de risque d'identité, et on ne touche pas au vêtement).
 * 3. Garde-fous : boîte trop grande ou incohérente → pas de masque, signalé.
 *
 * Aucune personne (vêtement à plat, packshot) → image inchangée.
 */
import sharp from 'sharp'

const DETECT_MODELS = ['gemini-3.1-flash', 'gemini-2.5-flash', 'gemini-2.5-pro']

type Box = { ymin: number; xmin: number; ymax: number; xmax: number }   // 0..1

export type HeadDetection = {
  hasPerson: boolean
  box?: Box
  model?: string
  error?: string
}

function parseBox(b: any): Box | null {
  if (!b || typeof b !== 'object') return null
  const n = (v: any) => Math.max(0, Math.min(1000, Number(v))) / 1000
  const box = { ymin: n(b.ymin), xmin: n(b.xmin), ymax: n(b.ymax), xmax: n(b.xmax) }
  if ([box.ymin, box.xmin, box.ymax, box.xmax].some(v => Number.isNaN(v))) return null
  if (box.ymax <= box.ymin || box.xmax <= box.xmin) return null
  return box
}

export async function detectHead(buf: Buffer, mime: string, apiKey: string): Promise<HeadDetection> {
  const prompt = [
    'You are a precise vision detector. Look at this fashion photo.',
    'Q1: is there a real human person WEARING the garment (not a flat-lay, not a mannequin dummy, not a hanger)?',
    'Q2: if yes, locate the head. Give:',
    '  - "face": a TIGHT box around the face only — from the hairline/forehead to the chin, temple to temple. No neck, no shoulders.',
    '  - "hair": a box around the visible hair of the head (may extend above and to the sides of the face). Do NOT include the neck, shoulders or clothing.',
    '  - "chinY": the vertical position of the bottom of the chin.',
    'Answer with strict JSON only, no prose:',
    '{"hasPerson": boolean, "face": {"ymin":int,"xmin":int,"ymax":int,"xmax":int} | null, "hair": {"ymin":int,"xmin":int,"ymax":int,"xmax":int} | null, "chinY": int | null}',
    'All numbers are integers on a 0-1000 scale relative to the full image: y is vertical (0 = top), x is horizontal (0 = left).',
    'If the head is partly out of frame, clamp to the frame. If no person, face/hair/chinY are null.',
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
      const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
      const hasPerson = !!parsed?.hasPerson
      if (!hasPerson) return { hasPerson: false, model }

      const face = parseBox(parsed.face)
      const hair = parseBox(parsed.hair)
      const chinY = Number.isFinite(Number(parsed.chinY)) ? Math.max(0, Math.min(1000, Number(parsed.chinY))) / 1000 : null
      if (!face) return { hasPerson, model, error: 'visage non localisé' }

      // --- Garde-fous : un visage fait rarement plus de 30 % de la hauteur d'une photo de tenue
      const faceH = face.ymax - face.ymin, faceW = face.xmax - face.xmin
      if (faceH > 0.35 || faceW > 0.5) return { hasPerson, model, error: `boîte visage aberrante (${Math.round(faceW * 100)}×${Math.round(faceH * 100)} %)` }

      // --- Union visage + cheveux, bornée au menton
      let box: Box = { ...face }
      if (hair) {
        box = {
          ymin: Math.min(box.ymin, hair.ymin), xmin: Math.min(box.xmin, hair.xmin),
          ymax: Math.max(box.ymax, hair.ymax), xmax: Math.max(box.xmax, hair.xmax),
        }
      }
      const chin = chinY ?? face.ymax
      const bottomLimit = Math.min(1, chin + 0.03)          // jamais plus bas que menton + 3 %
      box.ymax = Math.min(box.ymax, bottomLimit)
      // largeur bornée : au plus 2.2× la largeur du visage autour de son centre
      const cx = (face.xmin + face.xmax) / 2, maxHalfW = faceW * 1.1
      box.xmin = Math.max(box.xmin, cx - maxHalfW)
      box.xmax = Math.min(box.xmax, cx + maxHalfW)
      if (box.ymax <= box.ymin || box.xmax <= box.xmin) box = { ...face, ymax: Math.min(face.ymax, bottomLimit) }

      return { hasPerson, box, model }
    } catch (e: any) {
      lastErr = `${model}: ${e?.message ?? e}`
    }
  }
  return { hasPerson: false, error: lastErr || 'détection impossible' }
}

/**
 * Pixelise la zone de la tête. Marge 4 % en haut et sur les côtés, AUCUNE marge en bas
 * (la borne menton est déjà appliquée par detectHead).
 * Renvoie le JPEG masqué + la boîte pixel appliquée.
 */
export async function maskHead(buf: Buffer, box: Box) {
  const meta = await sharp(buf).metadata()
  const W = meta.width ?? 0, H = meta.height ?? 0
  if (!W || !H) throw new Error('image illisible')
  const bw = (box.xmax - box.xmin) * W, bh = (box.ymax - box.ymin) * H
  const mx = bw * 0.04, my = bh * 0.04
  const left   = Math.max(0, Math.round(box.xmin * W - mx))
  const top    = Math.max(0, Math.round(box.ymin * H - my))
  const right  = Math.min(W, Math.round(box.xmax * W + mx))
  const bottom = Math.min(H, Math.round(box.ymax * H))
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
