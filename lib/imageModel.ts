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
 * Le choix vient de l'en-tête `x-image-provider` ajouté côté navigateur (onglet par onglet),
 * la qualité ChatGPT de `x-openai-quality`.
 *
 * Coût réel : chaque appel calcule son coût d'après les tokens facturés (usage OpenAI /
 * usageMetadata Gemini). `withImageCost` additionne les appels d'une requête (retries compris)
 * et renvoie le total dans l'en-tête `x-image-cost` (USD).
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export type ImageProvider = 'gemini' | 'openai'
export type OpenAIQuality = 'auto' | 'low' | 'medium' | 'high' | 'xhigh'

/** Modèle OpenAI (surchargeable par env OPENAI_IMAGE_MODEL, ex. gpt-image-2.5-flare, plus rapide). */
export const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-sunburst'
const OPENAI_MAX_IMAGES = 16

/** Tarifs USD par token (pages tarifs officielles, oct. 2026). */
const PRICE = {
  openai: { textIn: 5e-6, imageIn: 8e-6, out: 30e-6 },              // gpt-image-2.5 (Sunburst = Flare)
  gemini: { in: 2e-6, textOut: 12e-6, imageOut: 120e-6 },           // gemini-3-pro-image-preview
}

type CostCtx = { cost: number; calls: number; quality: OpenAIQuality }
const costCtx = new AsyncLocalStorage<CostCtx>()

export function imageProviderOf(request: Request): ImageProvider {
  return request.headers.get('x-image-provider') === 'openai' ? 'openai' : 'gemini'
}

/** Enveloppe un handler de route : mesure le coût des générations et l'ajoute en en-tête. */
export function withImageCost(handler: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    const q = request.headers.get('x-openai-quality')
    const ctx: CostCtx = { cost: 0, calls: 0, quality: (['low', 'medium', 'high', 'xhigh'] as const).find(x => x === q) ?? 'auto' }
    const res = await costCtx.run(ctx, () => handler(request))
    if (ctx.calls === 0) return res
    try {
      res.headers.set('x-image-cost', ctx.cost.toFixed(5))
      res.headers.set('x-image-calls', String(ctx.calls))
      return res
    } catch {
      // en-têtes immuables → on recopie la réponse
      const h = new Headers(res.headers)
      h.set('x-image-cost', ctx.cost.toFixed(5)); h.set('x-image-calls', String(ctx.calls))
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
    }
  }
}

const addCost = (usd: number) => {
  const ctx = costCtx.getStore()
  if (ctx && Number.isFinite(usd)) { ctx.cost += usd; ctx.calls++ }
}

export async function imageFetch(provider: ImageProvider, url: string, init: RequestInit): Promise<Response> {
  if (provider !== 'openai') {
    const res = await fetch(url, init)
    // Coût Gemini d'après usageMetadata (lu sur une copie, la route lit l'original)
    try {
      const u = (await res.clone().json())?.usageMetadata
      if (u) {
        const imageOut = (u.candidatesTokensDetails ?? []).filter((d: any) => d.modality === 'IMAGE').reduce((s: number, d: any) => s + (d.tokenCount ?? 0), 0)
        const textOut = (u.candidatesTokenCount ?? 0) - imageOut + (u.thoughtsTokenCount ?? 0)
        addCost((u.promptTokenCount ?? 0) * PRICE.gemini.in + imageOut * PRICE.gemini.imageOut + Math.max(0, textOut) * PRICE.gemini.textOut)
      }
    } catch { /* pas de JSON lisible : pas de coût */ }
    return res
  }
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
  // Qualité : choix de l'onglet, sinon auto (1K → medium, 2K/4K → high)
  const chosen = costCtx.getStore()?.quality ?? 'auto'
  const quality = chosen !== 'auto' ? chosen : cfg.imageSize === '1K' ? 'medium' : 'high'

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
  // Coût réel d'après les tokens facturés
  const u = data?.usage
  if (u) {
    const imgIn = u.input_tokens_details?.image_tokens ?? 0
    const txtIn = u.input_tokens_details?.text_tokens ?? Math.max(0, (u.input_tokens ?? 0) - imgIn)
    addCost(txtIn * PRICE.openai.textIn + imgIn * PRICE.openai.imageIn + (u.output_tokens ?? 0) * PRICE.openai.out)
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
