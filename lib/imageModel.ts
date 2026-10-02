/**
 * Aiguillage du modèle de génération d'image : Gemini (défaut) ou ChatGPT (OpenAI GPT Image).
 *
 * Les routes construisent toutes un corps Gemini `generateContent` (parts texte + inlineData).
 * `imageFetch` est un remplaçant direct de `fetch(URL Gemini, …)` :
 *   - provider 'gemini' → appel Gemini inchangé ;
 *   - provider 'openai' → le corps Gemini est converti (textes concaténés, images dans l'ordre)
 *     et envoyé à GPT Image ; la réponse est remise au FORMAT GEMINI
 *     (candidates[0].content.parts[].inlineData) pour que la suite de chaque route ne change pas.
 *
 * Le choix vient de l'en-tête `x-image-provider` ajouté côté navigateur (onglet par onglet).
 */

export type ImageProvider = 'gemini' | 'openai'

/** Modèle OpenAI (surchargeable par env OPENAI_IMAGE_MODEL, ex. gpt-image-2.5-flare, plus rapide). */
export const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-sunburst'
const OPENAI_MAX_IMAGES = 16

export function imageProviderOf(request: Request): ImageProvider {
  return request.headers.get('x-image-provider') === 'openai' ? 'openai' : 'gemini'
}

export async function imageFetch(provider: ImageProvider, url: string, init: RequestInit): Promise<Response> {
  if (provider !== 'openai') return fetch(url, init)
  return callOpenAIFromGeminiBody(typeof init.body === 'string' ? init.body : '')
}

/* ============================== OpenAI ============================== */

const geminiJson = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const geminiError = (status: number, message: string) => geminiJson(status, { error: { message, status } })

async function callOpenAIFromGeminiBody(bodyStr: string): Promise<Response> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return geminiError(500, 'OPENAI_API_KEY manquante côté serveur (Vercel → Settings → Environment Variables).')

  let body: any
  try { body = JSON.parse(bodyStr) } catch { return geminiError(400, 'Corps de requête image illisible.') }
  const parts: any[] = (body?.contents ?? []).flatMap((c: any) => c?.parts ?? [])
  const cfg = body?.generationConfig?.imageConfig ?? {}

  // Textes dans l'ordre, chaque image signalée à l'endroit où elle apparaissait
  const texts: string[] = []
  const images: { buf: Buffer; mime: string }[] = []
  for (const p of parts) {
    if (typeof p?.text === 'string') texts.push(p.text)
    else if (p?.inlineData?.data) {
      images.push({ buf: Buffer.from(p.inlineData.data, 'base64'), mime: p.inlineData.mimeType || 'image/jpeg' })
      texts.push(`[attached image ${images.length}]`)
    }
  }
  const kept = images.slice(0, OPENAI_MAX_IMAGES)
  let prompt = texts.join('\n\n').trim()
  if (kept.length) prompt = `The reference images are attached in order (attached image 1 = IMAGE 1 when the text numbers them).\n\n${prompt}`
  if (images.length > kept.length) prompt += `\n\n(Only the first ${kept.length} reference images could be attached.)`
  if (!prompt) return geminiError(400, 'Prompt vide.')

  const size = openAISize(cfg.aspectRatio ?? '1:1', cfg.imageSize ?? '2K')
  const quality = cfg.imageSize === '1K' ? 'medium' : 'high'

  const send = async (withModeration: boolean) => {
    if (kept.length === 0) {
      return fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: OPENAI_IMAGE_MODEL, prompt, size, quality, n: 1,
          output_format: 'jpeg', output_compression: 95,
          ...(withModeration ? { moderation: 'low' } : {}),
        }),
      })
    }
    const form = new FormData()
    form.append('model', OPENAI_IMAGE_MODEL)
    form.append('prompt', prompt)
    form.append('size', size)
    form.append('quality', quality)
    form.append('n', '1')
    form.append('output_format', 'jpeg')
    form.append('output_compression', '95')
    if (withModeration) form.append('moderation', 'low')
    kept.forEach((im, i) => {
      const ext = im.mime.includes('png') ? 'png' : im.mime.includes('webp') ? 'webp' : 'jpg'
      form.append('image[]', new Blob([new Uint8Array(im.buf)], { type: im.mime }), `ref-${i + 1}.${ext}`)
    })
    return fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
    })
  }

  let res = await send(true)
  let data: any = await res.json().catch(() => null)
  // Paramètre `moderation` refusé par un modèle/endpoint → on retente sans
  if (!res.ok && /moderation/i.test(data?.error?.param ?? '') ) {
    res = await send(false)
    data = await res.json().catch(() => null)
  }

  if (!res.ok) {
    const code = data?.error?.code ?? ''
    const msg = data?.error?.message ?? `HTTP ${res.status}`
    // Refus de sécurité → même forme qu'un IMAGE_SAFETY Gemini (les routes savent l'afficher / retenter)
    if (code === 'moderation_blocked' || /safety|moderation/i.test(msg)) {
      return geminiJson(200, { candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [{ text: `ChatGPT (sécurité) : ${msg}` }] } }] })
    }
    return geminiError(res.status, `ChatGPT : ${msg}`)
  }

  const b64 = data?.data?.[0]?.b64_json
  if (!b64) return geminiJson(200, { candidates: [{ finishReason: 'OTHER', content: { parts: [{ text: 'ChatGPT : réponse sans image.' }] } }] })
  return geminiJson(200, {
    candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: b64 } }] } }],
    provider: 'openai', model: OPENAI_IMAGE_MODEL,
  })
}

/**
 * Ratio + qualité Studio (1K/2K/4K) → taille GPT Image « LxH » :
 * multiples de 16, ratio entre 1:3 et 3:1, côté max 3840 px, 655 360 à 8 294 400 pixels.
 */
export function openAISize(ratio: string, imageSize: string): string {
  const [a, b] = ratio.split(':').map(Number)
  let r = a > 0 && b > 0 ? a / b : 1
  r = Math.min(3, Math.max(1 / 3, r))
  const area = imageSize === '4K' ? 8_294_400 : imageSize === '1K' ? 1_048_576 : 4_194_304
  let h = Math.sqrt(area / r), w = h * r
  const k = Math.min(1, 3840 / Math.max(w, h))
  w *= k; h *= k
  const r16 = (x: number) => Math.max(16, Math.floor(x / 16) * 16)
  let W = r16(w), H = r16(h)
  while (W * H < 655_360) { W += 16; H = r16(W / r) }
  return `${W}x${H}`
}
