/**
 * Recompression server-side d'une image renvoyée par Gemini.
 *
 * Objectif : réduire la bande passante sortante de Vercel.
 * Gemini renvoie typiquement du PNG (~2-5 MB en 2K). Une fois encodé en
 * base64 dans la réponse JSON, ça pèse ~3-7 MB / visuel. En recompressant
 * en JPEG q90, on tombe à ~300-700 KB → division par ~7-10×.
 *
 * Si la recompression échoue (ex : sharp absent en local dev), on renvoie
 * l'image originale sans bloquer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sharp: any | null = null
async function getSharp() {
  if (_sharp) return _sharp
  try {
    const mod = await import('sharp')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _sharp = (mod as any).default ?? mod
    return _sharp
  } catch {
    return null
  }
}

export type CompressOpts = {
  /** 'jpeg' (par défaut, max compat) ou 'webp' (plus petit, ~25 %). */
  format?: 'jpeg' | 'webp'
  /** 1..100, défaut 90 (qualité quasi-lossless visuelle pour mode/portrait). */
  quality?: number
  /** Si défini, on resize l'image pour que son plus grand côté soit <= maxSide. */
  maxSide?: number
}

/**
 * Recompresse une image base64 + mime vers un format plus léger.
 * @returns { base64, mime } à utiliser comme `data:${mime};base64,${base64}`.
 *          Si la recompression échoue, on renvoie l'input intact.
 */
export async function compressGeminiImage(
  base64Data: string,
  inputMime: string,
  opts: CompressOpts = {},
): Promise<{ base64: string; mime: string }> {
  const sharp = await getSharp()
  if (!sharp) return { base64: base64Data, mime: inputMime }

  const fmt     = opts.format  ?? 'jpeg'
  const quality = opts.quality ?? 90

  try {
    const inBuf = Buffer.from(base64Data, 'base64')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let pipeline: any = sharp(inBuf, { failOn: 'none' }).rotate()

    if (opts.maxSide && opts.maxSide > 0) {
      pipeline = pipeline.resize({
        width:  opts.maxSide,
        height: opts.maxSide,
        fit:    'inside',
        withoutEnlargement: true,
      })
    }

    const out: Buffer = fmt === 'webp'
      ? await pipeline.webp({ quality }).toBuffer()
      : await pipeline.jpeg({ quality, chromaSubsampling: '4:2:0', mozjpeg: true }).toBuffer()

    return { base64: out.toString('base64'), mime: `image/${fmt}` }
  } catch (err) {
    console.warn('[serverImageCompress] fallback (no recompress):', err)
    return { base64: base64Data, mime: inputMime }
  }
}
