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
 * Nettoyage STRICT du mask de segmentation + ÉROSION des bords pour
 * supprimer la contamination du fond original.
 *
 * Problème résolu :
 *  1. Les modèles ML produisent un mask "bruité" avec des pixels semi-transparents
 *     éparpillés dans le sujet (= taches visibles dans le composite final).
 *  2. Les pixels de bord du mask ont du fond original Gemini "pré-mélangé"
 *     dedans (alpha 50-200), ce qui crée un halo coloré visible quand on
 *     compose sur un nouveau fond (= "traces" autour du mannequin).
 *
 * Algorithme :
 *  1. Threshold doux (alpha > 80) → mask binaire "subject vs not subject"
 *  2. Flood fill depuis les 4 bords à travers les pixels "not subject"
 *     → identifie les pixels VRAIMENT extérieurs au mannequin
 *  3. ÉROSION du mask "subject" : tout pixel intérieur qui touche un pixel
 *     extérieur dans un rayon de `erodePx` est dégradé en extérieur
 *     → supprime la zone contaminée par le fond original
 *  4. Reconstruction :
 *     - Pixel extérieur (original ou suite à érosion) : alpha = 0
 *     - Pixel intérieur APRÈS érosion : alpha = 255 + RGB original
 *     - Ring d'AA 1 pixel autour du nouveau bord : alpha = 128 pour adoucir
 *
 * Coût : ~100-300 ms pour une image 1024×1536 + 2 passes d'érosion.
 */
export async function fillSegmentationHoles(
  segmentedPng: Blob,
  originalGemini: Blob,
  erodePx = 2,
): Promise<Blob> {
  const [segBmp, origBmp] = await Promise.all([
    createImageBitmap(segmentedPng),
    createImageBitmap(originalGemini),
  ])
  const W = segBmp.width
  const H = segBmp.height

  // Canvas du segmenté
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

  const N = W * H
  const ALPHA_T = 80

  // ---- Phase 1 : mask binaire "subject" ----
  const isSubject = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    isSubject[i] = sData[i * 4 + 3] > ALPHA_T ? 1 : 0
  }

  // ---- Phase 1bis : connected components → on ne garde QUE le plus gros blob ----
  // La lib de segmentation produit parfois des faux positifs : des petits blobs
  // de pixels "subject" éparpillés dans le fond (loin du mannequin). On les
  // élimine en ne gardant que le plus grand composant connecté (8-connectivité).
  const compId = new Int32Array(N).fill(-1)
  const compSizes: number[] = []
  let nextId = 0
  for (let i = 0; i < N; i++) {
    if (compId[i] !== -1 || !isSubject[i]) continue
    // BFS pour explorer le composant
    const stack: number[] = [i]
    compId[i] = nextId
    let size = 0
    while (stack.length) {
      const idx = stack.pop()!
      size++
      const x = idx % W
      const y = (idx - x) / W
      // 8-connectivité (incl. diagonales pour mieux relier les bouts fins)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue
          const nIdx = ny * W + nx
          if (isSubject[nIdx] && compId[nIdx] === -1) {
            compId[nIdx] = nextId
            stack.push(nIdx)
          }
        }
      }
    }
    compSizes.push(size)
    nextId++
  }
  // Trouve le plus grand composant = le mannequin
  let largestId = -1
  let largestSize = 0
  for (let id = 0; id < compSizes.length; id++) {
    if (compSizes[id] > largestSize) {
      largestSize = compSizes[id]
      largestId = id
    }
  }
  // Élimine tous les autres composants (faux positifs dans le fond)
  let nRemoved = 0
  if (largestId >= 0) {
    for (let i = 0; i < N; i++) {
      if (isSubject[i] && compId[i] !== largestId) {
        isSubject[i] = 0
        nRemoved++
      }
    }
  }
  console.log(`[composite] connected components : ${nextId} blobs, plus gros = ${largestSize} px, ${nRemoved} px supprimés (faux positifs fond)`)

  // ---- Phase 2 : flood fill BFS depuis les bords → identifie le "vrai" extérieur ----
  const isOutside = new Uint8Array(N)
  const queue: number[] = []
  for (let x = 0; x < W; x++) {
    if (!isSubject[x]) { isOutside[x] = 1; queue.push(x) }
    const bot = (H - 1) * W + x
    if (!isSubject[bot]) { isOutside[bot] = 1; queue.push(bot) }
  }
  for (let y = 0; y < H; y++) {
    const left = y * W
    if (!isSubject[left]) { isOutside[left] = 1; queue.push(left) }
    const right = y * W + W - 1
    if (!isSubject[right]) { isOutside[right] = 1; queue.push(right) }
  }
  while (queue.length) {
    const idx = queue.pop()!
    const x = idx % W
    const y = (idx - x) / W
    if (x > 0     && !isSubject[idx - 1]     && !isOutside[idx - 1])     { isOutside[idx - 1] = 1; queue.push(idx - 1) }
    if (x < W - 1 && !isSubject[idx + 1]     && !isOutside[idx + 1])     { isOutside[idx + 1] = 1; queue.push(idx + 1) }
    if (y > 0     && !isSubject[idx - W]     && !isOutside[idx - W])     { isOutside[idx - W] = 1; queue.push(idx - W) }
    if (y < H - 1 && !isSubject[idx + W]     && !isOutside[idx + W])     { isOutside[idx + W] = 1; queue.push(idx + W) }
  }

  // ---- Phase 3 : on reconstruit le mask "intérieur" (subject OU trou interne) ----
  // isInside[i] = 1 si pixel doit être considéré comme intérieur au mannequin
  // (= pas marqué outside par le flood fill).
  const isInside = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    isInside[i] = isOutside[i] ? 0 : 1
  }

  // ---- Phase 4 : ÉROSION du mask "isInside" par erodePx pixels ----
  // À chaque pass, tout pixel intérieur qui touche un pixel extérieur (4-conn)
  // devient extérieur lui-même. Élimine la zone de contamination du fond.
  let eroded = isInside
  for (let pass = 0; pass < erodePx; pass++) {
    const next = new Uint8Array(N)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (!eroded[i]) { next[i] = 0; continue }
        // Tous les 4 voisins doivent être inside aussi
        const u = y > 0     ? eroded[i - W] : 0
        const d = y < H - 1 ? eroded[i + W] : 0
        const l = x > 0     ? eroded[i - 1] : 0
        const r = x < W - 1 ? eroded[i + 1] : 0
        next[i] = (u && d && l && r) ? 1 : 0
      }
    }
    eroded = next
  }

  // ---- Phase 5 : reconstruction du PNG final ----
  // - eroded === 1 (intérieur strict) : alpha 255 + RGB original
  // - eroded === 0 ET voisin avec eroded === 1 : alpha 128 (ring AA 1px)
  // - sinon : alpha 0
  let nCore = 0, nAA = 0, nClear = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const p = i * 4

      if (eroded[i]) {
        sData[p + 0] = origData[p + 0]
        sData[p + 1] = origData[p + 1]
        sData[p + 2] = origData[p + 2]
        sData[p + 3] = 255
        nCore++
        continue
      }

      // Pixel non-eroded : check si on est à 1 pixel d'un pixel eroded (= ring AA)
      let nearCore = false
      if (y > 0     && eroded[i - W]) nearCore = true
      else if (y < H - 1 && eroded[i + W]) nearCore = true
      else if (x > 0     && eroded[i - 1]) nearCore = true
      else if (x < W - 1 && eroded[i + 1]) nearCore = true

      if (nearCore) {
        sData[p + 0] = origData[p + 0]
        sData[p + 1] = origData[p + 1]
        sData[p + 2] = origData[p + 2]
        sData[p + 3] = 128
        nAA++
      } else {
        sData[p + 3] = 0
        nClear++
      }
    }
  }
  console.log(`[composite] cleanup+erosion(${erodePx}px) : ${nCore} core opaques, ${nAA} ring AA, ${nClear} clear`)

  ctx.putImageData(segData, 0, 0)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => b ? resolve(b) : reject(new Error('canvas.toBlob a renvoyé null.')),
      'image/png',
    )
  })
}

/**
 * Resize un PNG en gardant le canal alpha (contrairement à compressImage
 * qui re-encode en JPEG et perd la transparence).
 *
 * Utilisé pour le subject segmenté avant envoi à /api/studio/simple :
 * il faut absolument garder l'alpha pour que Gemini sache où est le sujet
 * et où est le fond.
 */
export async function resizePng(file: File, maxSide = 1536): Promise<File> {
  const bmp = await createImageBitmap(file)
  const w = bmp.width
  const h = bmp.height
  const longest = Math.max(w, h)
  if (longest <= maxSide) {
    // Déjà sous la limite — on renvoie tel quel
    return file
  }
  const scale = maxSide / longest
  const W = Math.round(w * scale)
  const H = Math.round(h * scale)
  const canvas = document.createElement('canvas')
  canvas.width  = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D unavailable.')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bmp, 0, 0, W, H)
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob null')), 'image/png')
  })
  return new File([blob], file.name, { type: 'image/png' })
}

/* ============================== Chroma Key V2 ============================== */

const CHROMA_KEY_RGB: [number, number, number] = [0, 192, 0]
const CHROMA_KEY_HEX = '#00C000'

/**
 * Crée une image de fond chroma key vert pur (à passer à Gemini comme bg
 * ref pour qu'il génère le mannequin sur un fond bien isolable).
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
 * Extraction CHROMA KEY V2 — performante et subtile, sans liseret vert.
 *
 * Pipeline :
 *  1. Pour chaque pixel, distance euclidienne RGB à la couleur chroma key.
 *  2. Threshold doux avec FADE :
 *     - dist < innerT → alpha 0 (transparent)
 *     - innerT < dist < outerT → alpha proportionnel (anti-aliasing naturel)
 *     - dist > outerT → alpha 255 (sujet plein)
 *  3. DESPILL : pour tout pixel du sujet où le canal vert est anormalement
 *     dominant (g > max(r, b)), on clamp g à max(r, b). Ça tue le green
 *     spill (le liseret vert sur les bords causé par l'AA Gemini autour
 *     du sujet sur fond chroma).
 *  4. Connected components : on garde uniquement le plus gros blob de
 *     pixels opaques (= le mannequin) → élimine les faux positifs dans
 *     les coins ou poches qui auraient pu être du chroma residual.
 *
 * Pas de modèle ML, déterministe, ~50-150 ms.
 */
export async function extractByChromaKeyV2(
  imageBlob: Blob,
  options: {
    /** Distance min au key sous laquelle un pixel est 100 % transparent (0..1, default 0.12). */
    innerThreshold?: number
    /** Distance max au key au-dessus de laquelle un pixel est 100 % opaque (0..1, default 0.32). */
    outerThreshold?: number
    /** Force du despill core (0..1, default 0.8). */
    despillStrength?: number
    /** Nombre de pixels d'érosion finale pour éliminer la couche contaminée (default 2). */
    erodePx?: number
  } = {},
): Promise<Blob> {
  const innerT = (options.innerThreshold ?? 0.12) * 441
  const outerT = (options.outerThreshold ?? 0.32) * 441
  const despillCore = options.despillStrength ?? 0.8
  const erodePx = options.erodePx ?? 2

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
  let nKey = 0, nFade = 0, nDespill = 0
  const N = W * H

  // ===== Phase 1 : alpha threshold avec fade + despill ADAPTATIF =====
  // Despill alpha-adaptatif : plus le pixel est au bord (alpha faible),
  // plus on tue le vert agressivement.
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const dr = r - KR, dg = g - KG, db = b - KB
    const dist = Math.sqrt(dr * dr + dg * dg + db * db)

    if (dist < innerT) {
      data[i + 3] = 0
      nKey++
      continue
    } else if (dist < outerT) {
      const t = (dist - innerT) / (outerT - innerT)
      data[i + 3] = Math.round(255 * t)
      nFade++
    }
    // else : pixel sujet plein, alpha reste 255

    // DESPILL agressif basé sur (r+b)/2 (plus violent que max(r,b))
    const alphaFrac = data[i + 3] / 255
    const meanRb = (r + b) / 2
    const spillBound = meanRb  // borne au-dessus de laquelle le vert est suspect
    const spill = g - spillBound
    if (spill > 0) {
      // strength adaptative : 0.5 sur pixel plein → 1.0 sur pixel très transparent
      const strength = despillCore + (1 - alphaFrac) * (1.0 - despillCore)
      data[i + 1] = Math.round(g - strength * spill)
      nDespill++
    }
    // Sécurité : si après despill, le vert est encore > max(r,b), on re-clamp
    if (data[i + 1] > Math.max(data[i], data[i + 2])) {
      data[i + 1] = Math.max(data[i], data[i + 2])
    }
  }

  // ===== Phase 2 : connected components → seul le plus gros blob =====
  const isOpaque = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    isOpaque[i] = data[i * 4 + 3] > 80 ? 1 : 0
  }
  const compId = new Int32Array(N).fill(-1)
  const compSizes: number[] = []
  let nextId = 0
  for (let i = 0; i < N; i++) {
    if (compId[i] !== -1 || !isOpaque[i]) continue
    const stack: number[] = [i]
    compId[i] = nextId
    let size = 0
    while (stack.length) {
      const idx = stack.pop()!
      size++
      const x = idx % W
      const y = (idx - x) / W
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx, ny = y + dy
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue
          const nIdx = ny * W + nx
          if (isOpaque[nIdx] && compId[nIdx] === -1) {
            compId[nIdx] = nextId
            stack.push(nIdx)
          }
        }
      }
    }
    compSizes.push(size)
    nextId++
  }
  let largestId = -1, largestSize = 0
  for (let id = 0; id < compSizes.length; id++) {
    if (compSizes[id] > largestSize) { largestSize = compSizes[id]; largestId = id }
  }
  let nOutliers = 0
  if (largestId >= 0) {
    for (let i = 0; i < N; i++) {
      if (isOpaque[i] && compId[i] !== largestId) {
        data[i * 4 + 3] = 0
        isOpaque[i] = 0
        nOutliers++
      }
    }
  }

  // ===== Phase 3 : FEATHERING gaussien sur le canal alpha =====
  // Comme l'option "Feather" de Photoshop : on blur uniquement le canal alpha
  // pour adoucir les bords. Le liseret vert disparaît parce qu'il est noyé
  // dans la transparence progressive plutôt que d'avoir un bord net.
  if (erodePx > 0) {
    const featherRadius = erodePx
    try {
      // 1. Extrait le canal alpha dans un canvas grayscale
      const alphaSrcCanvas = document.createElement('canvas')
      alphaSrcCanvas.width = W
      alphaSrcCanvas.height = H
      const alphaSrcCtx = alphaSrcCanvas.getContext('2d')
      if (!alphaSrcCtx) throw new Error('Canvas 2D unavailable.')
      const alphaImg = alphaSrcCtx.createImageData(W, H)
      for (let i = 0; i < N; i++) {
        const a = data[i * 4 + 3]
        alphaImg.data[i * 4 + 0] = a
        alphaImg.data[i * 4 + 1] = a
        alphaImg.data[i * 4 + 2] = a
        alphaImg.data[i * 4 + 3] = 255
      }
      alphaSrcCtx.putImageData(alphaImg, 0, 0)

      // 2. Blur le canal alpha via ctx.filter (Gaussian blur natif)
      const alphaBlurCanvas = document.createElement('canvas')
      alphaBlurCanvas.width = W
      alphaBlurCanvas.height = H
      const alphaBlurCtx = alphaBlurCanvas.getContext('2d')
      if (!alphaBlurCtx) throw new Error('Canvas 2D unavailable.')
      alphaBlurCtx.filter = `blur(${featherRadius}px)`
      alphaBlurCtx.drawImage(alphaSrcCanvas, 0, 0)

      // 3. Réécrit l'alpha blurré dans l'image data
      const blurredData = alphaBlurCtx.getImageData(0, 0, W, H)
      for (let i = 0; i < N; i++) {
        data[i * 4 + 3] = blurredData.data[i * 4]
      }
      console.log(`[chroma key v2] feathering : blur ${featherRadius}px sur alpha`)
    } catch (err) {
      console.warn('[chroma key v2] feathering failed, alpha non modifié :', err)
    }
  }

  console.log(`[chroma key v2] ${nKey} key, ${nFade} fade, ${nDespill} despilled, ${nOutliers} outliers`)

  ctx.putImageData(imgData, 0, 0)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob null')), 'image/png')
  })
}

/* ============================== utils ============================== */

/**
 * Blend vertical de deux images : moitié haute de TOP + moitié basse de BOTTOM,
 * avec une bande de transition douce à la jointure.
 *
 * Usage step 5 plein pied :
 *   - top    = composite Canvas (visage pristine + fond ref)
 *   - bottom = Gemini Simple step 4 (avec ombre naturelle)
 */
export async function verticalBlendTopBottom(
  topImage: Blob,
  bottomImage: Blob,
  splitRatio = 0.50,
  blendBand  = 0.08,
): Promise<File> {
  const [topBmp, botBmp] = await Promise.all([
    createImageBitmap(topImage),
    createImageBitmap(bottomImage),
  ])
  const W = topBmp.width
  const H = topBmp.height

  const topCanvas = document.createElement('canvas')
  topCanvas.width = W
  topCanvas.height = H
  const topCtx = topCanvas.getContext('2d')
  if (!topCtx) throw new Error('Canvas 2D unavailable.')
  topCtx.drawImage(topBmp, 0, 0)
  const topData = topCtx.getImageData(0, 0, W, H)

  const botCanvas = document.createElement('canvas')
  botCanvas.width = W
  botCanvas.height = H
  const botCtx = botCanvas.getContext('2d')
  if (!botCtx) throw new Error('Canvas 2D unavailable.')
  botCtx.drawImage(botBmp, 0, 0, W, H)
  const botData = botCtx.getImageData(0, 0, W, H)

  const splitY = Math.round(H * splitRatio)
  const bandHalf = Math.max(1, Math.round(H * blendBand / 2))
  const yTopBoundary = splitY - bandHalf
  const yBotBoundary = splitY + bandHalf

  const td = topData.data
  const bd = botData.data
  for (let y = 0; y < H; y++) {
    let alphaBot: number
    if (y <= yTopBoundary) alphaBot = 0
    else if (y >= yBotBoundary) alphaBot = 1
    else alphaBot = (y - yTopBoundary) / (yBotBoundary - yTopBoundary)
    const alphaTop = 1 - alphaBot

    if (alphaBot === 0) continue

    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      td[i + 0] = td[i + 0] * alphaTop + bd[i + 0] * alphaBot
      td[i + 1] = td[i + 1] * alphaTop + bd[i + 1] * alphaBot
      td[i + 2] = td[i + 2] * alphaTop + bd[i + 2] * alphaBot
    }
  }

  topCtx.putImageData(topData, 0, 0)
  console.log(`[composite] verticalBlend : split=${(splitRatio * 100).toFixed(0)}% band=${(blendBand * 100).toFixed(0)}%`)

  return new Promise<File>((resolve, reject) => {
    topCanvas.toBlob(
      b => b ? resolve(new File([b], 'blended.jpg', { type: 'image/jpeg' })) : reject(new Error('toBlob null')),
      'image/jpeg',
      0.95,
    )
  })
}

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
