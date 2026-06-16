/**
 * Mode Composite — pipeline déterministe pour garantir 100% de fidélité du fond.
 *
 *  1. Gemini génère le visuel mannequin + tenue + scène (avec lumière correcte
 *     car le fond de référence est passé en input → Gemini sait où il est).
 *  2. Segmentation client-side (@imgly/background-removal, modèle BRIA RMBG)
 *     → on extrait le mannequin sur fond transparent.
 *  3. Composite Canvas : on dessine les PIXELS EXACTS du fond de référence,
 *     puis on pose le mannequin extrait par-dessus.
 *  4. (optionnel) Ombre synthétique soft sous les pieds, ellipse aplatie
 *     centrée sur la base du mannequin détectée.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

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

/**
 * Composite : pose le mannequin (PNG transparent) sur le fond de référence.
 * Le canvas final a la résolution du mannequin (= sortie Gemini).
 */
export async function compositeOnBackground(
  segmentedPng: Blob,
  backgroundFile: File,
  options: {
    addShadow?: boolean
    /** opacité max au centre (default 0.18). */
    shadowOpacity?: number
    /** facteur d'élargissement de l'ombre par rapport à la largeur des pieds (default 1.6). */
    shadowSpreadFactor?: number
  } = {},
): Promise<File> {
  const addShadow         = options.addShadow         ?? true
  const shadowOpacity     = options.shadowOpacity     ?? 0.30
  const shadowSpreadFactor= options.shadowSpreadFactor?? 2.5

  const [modelBmp, bgBmp] = await Promise.all([
    createImageBitmap(segmentedPng),
    createImageBitmap(backgroundFile),
  ])

  const W = modelBmp.width
  const H = modelBmp.height

  const canvas = document.createElement('canvas')
  canvas.width  = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Impossible d\'obtenir le contexte 2D du canvas.')

  // 1) Fond de référence (cover-fit aux dimensions du mannequin)
  drawCover(ctx, bgBmp, W, H)

  // 2) Ombre synthétique sous les pieds (avant le mannequin pour qu'elle soit derrière)
  if (addShadow) {
    let feet = await detectModelFeet(segmentedPng, W, H)
    if (!feet) {
      // Fallback : ombre par défaut centrée au bas du canvas
      feet = { cx: W / 2, bottom: H - 8, width: W * 0.18 }
    }
    drawShadowEllipse(ctx, feet, shadowOpacity, shadowSpreadFactor)
  }

  // 3) Mannequin par-dessus
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
 * Détecte la position des pieds (= bas du sujet segmenté).
 * Renvoie le centre horizontal, la position Y du bas, et la largeur du bas.
 */
async function detectModelFeet(
  segmentedPng: Blob,
  W: number,
  H: number,
): Promise<{ cx: number; bottom: number; width: number } | null> {
  const bmp = await createImageBitmap(segmentedPng)
  // Canvas off-screen pour scanner les pixels
  const off = document.createElement('canvas')
  off.width = W
  off.height = H
  const offCtx = off.getContext('2d')
  if (!offCtx) return null
  offCtx.drawImage(bmp, 0, 0, W, H)
  let data: Uint8ClampedArray
  try {
    data = offCtx.getImageData(0, 0, W, H).data
  } catch {
    return null
  }

  // Scan from bottom : trouver la 1re row contenant du sujet (alpha > 128)
  for (let y = H - 1; y >= 0; y--) {
    let minX = -1, maxX = -1
    for (let x = 0; x < W; x++) {
      const alpha = data[(y * W + x) * 4 + 3]
      if (alpha > 128) {
        if (minX < 0) minX = x
        maxX = x
      }
    }
    if (minX >= 0) {
      return { cx: (minX + maxX) / 2, bottom: y, width: maxX - minX + 1 }
    }
  }
  return null
}

function drawShadowEllipse(
  ctx: CanvasRenderingContext2D,
  feet: { cx: number; bottom: number; width: number },
  opacity: number,
  spread: number,
) {
  // Largeur de base de l'ombre : aux moins 60 % de la largeur du canvas
  // garanti pour que ça soit visible même si la détection des pieds
  // n'a trouvé qu'une zone étroite (un seul pied vers l'avant par ex).
  const minFeetWidth = Math.max(feet.width, ctx.canvas.width * 0.12)
  const rx = (minFeetWidth / 2) * spread
  const ry = Math.max(14, rx * 0.28)
  const cx = feet.cx
  // Centre VERTICALEMENT sur la ligne des pieds : la moitié haute est
  // cachée par le mannequin (= contact shadow propre), la moitié basse
  // s'étend dans le sol et reste visible.
  const cy = feet.bottom

  ctx.save()
  // Radial gradient au lieu de filter blur : opacité contrôlable, fade
  // smooth, ne dépend pas du support filter (qui peut foirer selon navigateur).
  // Astuce : on travaille en espace transformé (cercle) qu'on aplatit en
  // ellipse via scale, ce qui garde le gradient circulaire.
  ctx.translate(cx, cy)
  ctx.scale(1, ry / rx)
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
  grad.addColorStop(0.0, `rgba(0,0,0,${opacity})`)
  grad.addColorStop(0.4, `rgba(0,0,0,${(opacity * 0.55).toFixed(3)})`)
  grad.addColorStop(0.8, `rgba(0,0,0,${(opacity * 0.12).toFixed(3)})`)
  grad.addColorStop(1.0, 'rgba(0,0,0,0)')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(0, 0, rx, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
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
