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

// Lazy-loaded segmenter ; le 1er load télécharge ~80 MB de modèle ONNX.
let _segmenter: ((input: Blob | string | ArrayBuffer) => Promise<Blob>) | null = null

export async function loadSegmenter() {
  if (_segmenter) return _segmenter
  const mod: any = await import('@imgly/background-removal')
  const fn = (mod.removeBackground ?? mod.default?.removeBackground ?? mod.default) as any
  if (typeof fn !== 'function') {
    throw new Error('@imgly/background-removal : fonction removeBackground introuvable.')
  }
  _segmenter = fn
  return fn as (input: Blob | string | ArrayBuffer) => Promise<Blob>
}

/**
 * Segmente l'image : renvoie un PNG avec canal alpha (fond transparent).
 * Premier appel = ~10-30 s (download du modèle), suivants = ~2-5 s.
 */
export async function segmentForeground(
  input: Blob,
  onProgress?: (msg: string) => void,
): Promise<Blob> {
  onProgress?.('Chargement du modèle de segmentation (cache navigateur après le 1er run)...')
  const removeBg = await loadSegmenter()
  onProgress?.('Extraction du mannequin du fond...')
  const result = await removeBg(input)
  return result
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

/* ============================== Chroma Key ============================== */

/**
 * Couleur chroma key utilisée : vert saturé non-pur pour rester safe en JPEG.
 * (un pur 0,255,0 sature trop le canal vert et peut bleed en compression.)
 */
const CHROMA_KEY_RGB: [number, number, number] = [0, 192, 0]
const CHROMA_KEY_HEX = '#00C000'

/**
 * Crée un fond plein de couleur chroma key (à passer à Gemini comme
 * background ref pour qu'il génère le mannequin sur fond vert pur).
 */
export async function createChromaBackground(width = 1024, height = 1536): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width  = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D unavailable.')
  ctx.fillStyle = CHROMA_KEY_HEX
  ctx.fillRect(0, 0, width, height)
  return new Promise<File>((resolve, reject) => {
    canvas.toBlob(
      (b) => b ? resolve(new File([b], 'chroma_bg.jpg', { type: 'image/jpeg' })) : reject(new Error('toBlob null')),
      'image/jpeg',
      0.95,
    )
  })
}

/**
 * Extrait le sujet d'une image générée sur fond chroma key vert.
 *
 *  - Threshold avec fade smooth (alpha proportionnel à la distance au key)
 *    → bords anti-aliasés au lieu d'un masque binaire dur.
 *  - Despill optionnel : pour les pixels proches du bord où le vert "bleed"
 *    sur le sujet, on remplace le canal vert par max(r, b), ce qui dé-tinte
 *    sans changer la luminosité globale.
 *
 * Pas de modèle ML, pas de download, exécution déterministe en ~30-100 ms.
 */
export async function extractByChromaKey(
  imageBlob: Blob,
  options: {
    /** Distance min au key sous laquelle un pixel est 100 % transparent (0..1, default 0.10). */
    innerThreshold?: number
    /** Distance max au key au-dessus de laquelle un pixel est 100 % opaque (0..1, default 0.25). */
    outerThreshold?: number
    /** Active le despill (de-tint vert sur les bords du sujet). */
    despill?: boolean
  } = {},
): Promise<Blob> {
  const innerT = (options.innerThreshold ?? 0.10) * 441  // 441 ≈ sqrt(3) * 255
  const outerT = (options.outerThreshold ?? 0.25) * 441
  const despill = options.despill ?? true

  const bmp = await createImageBitmap(imageBlob)
  const W = bmp.width
  const H = bmp.height

  const canvas = document.createElement('canvas')
  canvas.width  = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D unavailable.')
  ctx.drawImage(bmp, 0, 0)
  const imgData = ctx.getImageData(0, 0, W, H)
  const data = imgData.data

  const [KR, KG, KB] = CHROMA_KEY_RGB
  let nKey = 0, nFade = 0

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const dr = r - KR, dg = g - KG, db = b - KB
    const dist = Math.sqrt(dr * dr + dg * dg + db * db)

    if (dist < innerT) {
      // Pleinement chroma → transparent
      data[i + 3] = 0
      nKey++
    } else if (dist < outerT) {
      // Zone de transition → fade alpha proportionnel
      const t = (dist - innerT) / (outerT - innerT)
      data[i + 3] = Math.round(255 * t)
      nFade++
    } // else : pixel sujet, alpha reste à 255

    // Despill : si le canal vert est dominant (résidu de bleed) ET on est dans
    // la zone sujet ou transition, on remplace g par max(r, b) pour dé-tinter.
    if (despill && data[i + 3] > 0 && g > r && g > b) {
      const maxRb = Math.max(r, b)
      if (g - maxRb > 8) {
        data[i + 1] = maxRb
      }
    }
  }

  console.log(`[chroma key] ${nKey} pixels key (${(nKey / (W * H) * 100).toFixed(1)}%), ${nFade} pixels fade transition`)

  ctx.putImageData(imgData, 0, 0)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => b ? resolve(b) : reject(new Error('toBlob null')),
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
