/**
 * Helpers de traitement d'image côté browser (canvas natif).
 *  - cropTopPercent : extrait les X% du haut d'une image
 *  - cropBottomPercent : extrait les X% du bas
 *  - createWhiteBackground : génère une image blanche pour remplacer un fond
 */

/** Crop la portion supérieure de l'image (utile pour close-up haut sans sol). */
export async function cropTopPercent(file: File, percent = 30): Promise<File> {
  return cropImage(file, 0, percent / 100)
}

/** Crop la portion inférieure de l'image (utile pour close-up bas). */
export async function cropBottomPercent(file: File, percent = 50): Promise<File> {
  return cropImage(file, 1 - percent / 100, 1)
}

/**
 * Crop l'image entre deux ratios verticaux (0 = top, 1 = bottom).
 * Renvoie un nouveau File JPEG.
 */
async function cropImage(file: File, yStart: number, yEnd: number): Promise<File> {
  const bitmap = await createImageBitmapSafe(file)
  const W = bitmap.width
  const H = bitmap.height
  const sy = Math.floor(H * yStart)
  const sh = Math.max(1, Math.floor(H * (yEnd - yStart)))

  const canvas = document.createElement('canvas')
  canvas.width  = W
  canvas.height = sh
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, sy, W, sh, 0, 0, W, sh)
  if ('close' in bitmap) (bitmap as ImageBitmap).close?.()

  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('crop failed'))), 'image/jpeg', 0.9)
  })
  const base = file.name.replace(/\.[a-z0-9]+$/i, '') || 'cropped'
  return new File([blob], `${base}_crop.jpg`, { type: 'image/jpeg', lastModified: Date.now() })
}

/**
 * Crée une image blanche pure aux dimensions données — utile comme
 * placeholder de fond pour la step 1 (génération sur fond neutre).
 */
export async function createWhiteBackground(width = 1024, height = 1536): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width  = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('white bg failed'))), 'image/png')
  })
  return new File([blob], 'white_backdrop.png', { type: 'image/png', lastModified: Date.now() })
}

async function createImageBitmapSafe(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file) } catch { /* fallback */ }
  }
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = reject
      img.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}
