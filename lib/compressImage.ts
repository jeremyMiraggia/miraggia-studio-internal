/**
 * Compresse une image côté client pour rester sous la limite 4.5 MB de Vercel.
 *
 * - Redimensionne à `maxSide` px max sur le plus grand côté
 * - Réencode en JPEG (qualité 0.85 par défaut)
 * - Garde le nom du fichier original (extension .jpg)
 * - Si l'image fait déjà moins que maxBytes ET est sous maxSide, on la renvoie telle quelle
 */
export async function compressImage(
  file: File,
  opts: { maxSide?: number; quality?: number; maxBytes?: number } = {},
): Promise<File> {
  const { maxSide = 2048, quality = 0.85, maxBytes = 1_500_000 } = opts

  if (!file.type.startsWith('image/')) return file

  // Décode l'image
  const bitmap = await createImageBitmapSafe(file)
  const w = bitmap.width
  const h = bitmap.height
  const longest = Math.max(w, h)

  // Si déjà petit et léger, on saute
  if (longest <= maxSide && file.size <= maxBytes) {
    bitmap.close?.()
    return file
  }

  const scale = Math.min(1, maxSide / longest)
  const targetW = Math.round(w * scale)
  const targetH = Math.round(h * scale)

  const canvas = document.createElement('canvas')
  canvas.width = targetW
  canvas.height = targetH
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, targetW, targetH)
  bitmap.close?.()

  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      b => (b ? resolve(b) : reject(new Error('Compression failed'))),
      'image/jpeg',
      quality,
    )
  })

  const baseName = file.name.replace(/\.[a-z0-9]+$/i, '') || 'image'
  return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg', lastModified: Date.now() })
}

async function createImageBitmapSafe(file: File): Promise<ImageBitmap> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      /* fallback */
    }
  }
  // Fallback via <img>
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = reject
      i.src = url
    })
    // Pas un vrai ImageBitmap mais drawImage accepte HTMLImageElement
    return img as unknown as ImageBitmap
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Compresse tout un tableau de Files en parallèle */
export function compressAll(files: File[], opts?: Parameters<typeof compressImage>[1]) {
  return Promise.all(files.map(f => compressImage(f, opts)))
}
