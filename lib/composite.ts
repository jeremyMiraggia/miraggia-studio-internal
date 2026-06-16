/**
 * Mode Composite — pipeline déterministe pour garantir 100% de fidélité du fond.
 *
 *  1. Gemini génère le visuel mannequin + tenue + scène (avec lumière correcte
 *     car le fond de référence est passé en input → Gemini sait où il est).
 *  2. Segmentation client-side (@imgly/background-removal, modèle BRIA RMBG)
 *     → on extrait le mannequin sur fond transparent.
 *  3. Composite Canvas : on dessine les PIXELS EXACTS du fond de référence,
 *     puis on pose le mannequin extrait par-dessus.
 *     - Pour les close-up haut (sol non visible) : crop le bg aux 30% du haut
 *       AVANT de composer, pour éviter de voir le sol derrière la tête.
 *  4. (côté CompositeTab) — pour les framings où le sol est visible (plein
 *     pied, bas), une 4e passe Gemini ajoute une ombre naturelle sous les
 *     pieds en préservant le reste pixel-pour-pixel.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { cropTopPercent } from '@/lib/imageCrop'

/* ============================== Segmenters ============================== */

// Lazy-loaded segmenters — on essaye BiRefNet en 1er (meilleur sur les
// vêtements blancs), fallback automatique sur @imgly/background-removal
// (RMBG-1.4) si BiRefNet échoue.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _hfPipe: any = null
let _hfTried = false
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _imglyFn: any = null

/**
 * Charge BiRefNet via @huggingface/transformers. Première utilisation =
 * download ~80-180 MB du modèle ONNX (cache navigateur ensuite).
 * Retourne null si la lib ou le modèle ne peuvent pas être chargés.
 */
async function getBiRefNetPipe(onProgress?: (msg: string) => void) {
  if (_hfPipe) return _hfPipe
  if (_hfTried) return null
  _hfTried = true
  try {
    onProgress?.('Chargement BiRefNet via @huggingface/transformers (1er run : ~80-180 MB)...')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('@huggingface/transformers')
    const pipeline = mod.pipeline ?? mod.default?.pipeline
    if (typeof pipeline !== 'function') throw new Error('pipeline() introuvable')
    // briaai/RMBG-2.0 = successeur de RMBG-1.4, bien meilleur sur les vêtements
    // blancs/clairs. Si pas dispo, fallback automatique.
    _hfPipe = await pipeline('image-segmentation', 'briaai/RMBG-1.4')
    return _hfPipe
  } catch (err) {
    console.warn('[composite] BiRefNet/HF init failed, will fallback to @imgly:', err)
    return null
  }
}

/**
 * Charge @imgly/background-removal (fallback). Première utilisation = ~80 MB.
 */
async function getImglySegmenter() {
  if (_imglyFn) return _imglyFn
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('@imgly/background-removal')
  const fn = mod.removeBackground ?? mod.default?.removeBackground ?? mod.default
  if (typeof fn !== 'function') throw new Error('@imgly removeBackground introuvable')
  _imglyFn = fn
  return fn as (input: Blob | string | ArrayBuffer) => Promise<Blob>
}

/**
 * Compose un mask de segmentation (grayscale) avec l'image source pour
 * produire un PNG avec canal alpha.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function maskToTransparentPng(source: Blob, maskRaw: any): Promise<Blob> {
  const bmp = await createImageBitmap(source)
  const W = bmp.width
  const H = bmp.height

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D unavailable')
  ctx.drawImage(bmp, 0, 0)
  const imgData = ctx.getImageData(0, 0, W, H)

  // maskRaw : { data: Uint8Array (grayscale 0-255), width, height, channels: 1 }
  const mw = maskRaw.width ?? W
  const mh = maskRaw.height ?? H

  let alphaData: Uint8ClampedArray | Uint8Array
  if (mw === W && mh === H) {
    alphaData = maskRaw.data
  } else {
    // Resize via canvas si dims différentes
    const tempCanvas = document.createElement('canvas')
    tempCanvas.width = mw
    tempCanvas.height = mh
    const tempCtx = tempCanvas.getContext('2d')
    if (!tempCtx) throw new Error('Canvas 2D unavailable')
    const maskImg = new ImageData(mw, mh)
    for (let i = 0; i < mw * mh; i++) {
      const v = maskRaw.data[i]
      maskImg.data[i * 4 + 0] = v
      maskImg.data[i * 4 + 1] = v
      maskImg.data[i * 4 + 2] = v
      maskImg.data[i * 4 + 3] = 255
    }
    tempCtx.putImageData(maskImg, 0, 0)

    const resizeCanvas = document.createElement('canvas')
    resizeCanvas.width = W
    resizeCanvas.height = H
    const resizeCtx = resizeCanvas.getContext('2d')
    if (!resizeCtx) throw new Error('Canvas 2D unavailable')
    resizeCtx.drawImage(tempCanvas, 0, 0, W, H)
    const resized = resizeCtx.getImageData(0, 0, W, H)
    alphaData = new Uint8ClampedArray(W * H)
    for (let i = 0; i < W * H; i++) alphaData[i] = resized.data[i * 4]
  }

  for (let i = 0; i < W * H; i++) {
    imgData.data[i * 4 + 3] = alphaData[i]
  }
  ctx.putImageData(imgData, 0, 0)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob null')), 'image/png')
  })
}

/**
 * Segmente l'image : renvoie un PNG avec canal alpha (fond transparent).
 * Stratégie :
 *  1. BiRefNet (RMBG-2.0) via @huggingface/transformers — meilleur sur
 *     les vêtements blancs/clairs. Download ~80-180 MB au 1er run.
 *  2. Fallback automatique sur @imgly/background-removal (RMBG-1.4) si
 *     BiRefNet ne charge pas ou échoue (lib manquante, modèle indispo,
 *     timeout, etc.).
 */
export async function segmentForeground(
  input: Blob,
  onProgress?: (msg: string) => void,
): Promise<Blob> {
  // === Tentative 1 : BiRefNet ===
  const pipe = await getBiRefNetPipe(onProgress)
  if (pipe) {
    try {
      onProgress?.('Segmentation BiRefNet...')
      const url = URL.createObjectURL(input)
      let output: any
      try {
        output = await pipe(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      // output = [{ mask, label, score }, ...] — on prend la 1re segmentation
      const first = Array.isArray(output) ? output[0] : output
      const maskRaw = first?.mask ?? first
      if (!maskRaw || !maskRaw.data) throw new Error('BiRefNet : mask absent dans la sortie')
      return await maskToTransparentPng(input, maskRaw)
    } catch (err) {
      console.warn('[composite] BiRefNet segmentation failed, fallback @imgly:', err)
    }
  }

  // === Tentative 2 : @imgly/background-removal (RMBG-1.4) ===
  onProgress?.('Fallback : segmentation @imgly RMBG-1.4...')
  const removeBg = await getImglySegmenter()
  onProgress?.('Extraction du mannequin du fond...')
  return await removeBg(input)
}

// Helper conservé pour compat (le mode RMBG direct n'est plus exposé,
// segmentForeground orchestre tout)
export async function loadSegmenter() {
  return await getImglySegmenter()
}

export type CompositeOptions = {
  /**
   * Si défini sur 'haut' (close-up haut), on crop le fond aux 30% du haut
   * avant le composite — ainsi on ne voit pas le sol derrière la tête.
   */
  framingHint?: string
}

/**
 * Composite : pose le mannequin (PNG transparent) sur le fond de référence.
 * Le canvas final a la résolution du mannequin (= sortie Gemini).
 *
 * Pas d'ombre ajoutée ici — l'ombre est gérée par une passe Gemini
 * supplémentaire côté runner (seulement quand le sol est visible).
 */
export async function compositeOnBackground(
  segmentedPng: Blob,
  backgroundFile: File,
  options: CompositeOptions = {},
): Promise<File> {
  // Pour close-up haut : on coupe le fond pour ne garder que la partie
  // haute (mur), pas de sol visible derrière la tête.
  let bgFile = backgroundFile
  if (options.framingHint === 'haut') {
    try {
      bgFile = await cropTopPercent(backgroundFile, 30)
    } catch (err) {
      console.warn('[composite] cropTopPercent fallback:', err)
    }
  }

  const [modelBmp, bgBmp] = await Promise.all([
    createImageBitmap(segmentedPng),
    createImageBitmap(bgFile),
  ])

  const W = modelBmp.width
  const H = modelBmp.height

  const canvas = document.createElement('canvas')
  canvas.width  = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Impossible d\'obtenir le contexte 2D du canvas.')

  drawCover(ctx, bgBmp, W, H)
  ctx.drawImage(modelBmp, 0, 0)

  return new Promise<File>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('canvas.toBlob a renvoyé null.'))
        resolve(new File([blob], 'composite.jpg', { type: 'image/jpeg' }))
      },
      'image/jpeg',
      0.92,
    )
  })
}

/* ============================== helpers ============================== */

function drawCover(ctx: CanvasRenderingContext2D, bmp: ImageBitmap, W: number, H: number) {
  const ratio = Math.max(W / bmp.width, H / bmp.height)
  const w = bmp.width  * ratio
  const h = bmp.height * ratio
  const x = (W - w) / 2
  const y = (H - h) / 2
  ctx.drawImage(bmp, x, y, w, h)
}

/**
 * Comble les "trous" internes dans le segmenté en cas d'erreur de la lib RMBG.
 *
 * Problème : RMBG confond parfois le t-shirt blanc avec le fond et le rend
 * partiellement transparent. Le résultat : des trous bizarres au milieu du
 * mannequin.
 *
 * Solution : on identifie les pixels "extérieurs" via un flood fill depuis
 * les bords du canvas (sur le mask alpha thresholdé). Tout pixel transparent
 * qui n'est PAS atteint par le flood fill est un "trou interne" qu'on
 * recomble avec les pixels RGB de l'image Gemini originale + alpha 255.
 *
 * Coût : ~50-200 ms pour une image 1024x1536.
 */
export async function fillSegmentationHoles(
  segmentedPng: Blob,
  originalGemini: Blob,
): Promise<Blob> {
  const [segBmp, origBmp] = await Promise.all([
    createImageBitmap(segmentedPng),
    createImageBitmap(originalGemini),
  ])
  const W = segBmp.width
  const H = segBmp.height

  // Canvas du segmenté (avec alpha)
  const canvas = document.createElement('canvas')
  canvas.width  = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D unavailable.')
  ctx.drawImage(segBmp, 0, 0)
  const segData = ctx.getImageData(0, 0, W, H)
  const sData = segData.data

  // Canvas de l'original Gemini (RGB) — resize si dims différentes
  const origCanvas = document.createElement('canvas')
  origCanvas.width  = W
  origCanvas.height = H
  const origCtx = origCanvas.getContext('2d')
  if (!origCtx) throw new Error('Canvas 2D unavailable for original.')
  origCtx.drawImage(origBmp, 0, 0, W, H)
  const origData = origCtx.getImageData(0, 0, W, H).data

  // Build state map : 0 = transparent (à classifier), 1 = opaque (sujet),
  // 2 = transparent atteint depuis les bords (= vrai extérieur)
  const N = W * H
  const state = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    state[i] = sData[i * 4 + 3] > 128 ? 1 : 0
  }

  // Flood fill BFS depuis les 4 bords sur les pixels transparents
  const queue: number[] = []
  for (let x = 0; x < W; x++) {
    if (state[x] === 0) { state[x] = 2; queue.push(x) }
    const bot = (H - 1) * W + x
    if (state[bot] === 0) { state[bot] = 2; queue.push(bot) }
  }
  for (let y = 0; y < H; y++) {
    const left = y * W
    if (state[left] === 0) { state[left] = 2; queue.push(left) }
    const right = y * W + W - 1
    if (state[right] === 0) { state[right] = 2; queue.push(right) }
  }
  while (queue.length) {
    const idx = queue.pop()!
    const x = idx % W
    const y = (idx - x) / W
    // 4-connectivité
    if (x > 0     && state[idx - 1] === 0) { state[idx - 1] = 2; queue.push(idx - 1) }
    if (x < W - 1 && state[idx + 1] === 0) { state[idx + 1] = 2; queue.push(idx + 1) }
    if (y > 0     && state[idx - W] === 0) { state[idx - W] = 2; queue.push(idx - W) }
    if (y < H - 1 && state[idx + W] === 0) { state[idx + W] = 2; queue.push(idx + W) }
  }

  // Comble les trous : pour chaque pixel encore à 0 (transparent ET non atteint
  // depuis les bords → trou interne), on restaure RGB de l'original + alpha 255
  let filled = 0
  for (let i = 0; i < N; i++) {
    if (state[i] === 0) {
      const p = i * 4
      sData[p + 0] = origData[p + 0]
      sData[p + 1] = origData[p + 1]
      sData[p + 2] = origData[p + 2]
      sData[p + 3] = 255
      filled++
    }
  }
  if (filled > 0) {
    console.log(`[composite] hole-fill : ${filled} pixels comblés (${(filled / N * 100).toFixed(2)}% de l'image)`)
  }

  ctx.putImageData(segData, 0, 0)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => b ? resolve(b) : reject(new Error('canvas.toBlob a renvoyé null.')),
      'image/png',
    )
  })
}

/* ============================== utils ============================== */

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload  = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl)
  return res.blob()
}

/**
 * Prompt minimaliste pour la passe Gemini "ajoute une ombre naturelle".
 * Approche à la SimpleTab : on laisse Gemini gérer le rendu avec juste
 * l'intention. Moins d'instructions = meilleurs résultats avec Gemini
 * (il s'appuie sur son prior éditorial naturel).
 */
export const SHADOW_ADD_PROMPT =
  'Add a subtle, natural soft shadow under the model\'s feet, consistent with the existing scene lighting. Keep the model, the background, the framing and everything else exactly identical to the input — only the shadow is added.'
