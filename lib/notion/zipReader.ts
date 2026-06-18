/**
 * Lecteur ZIP minimal en streaming, natif browser.
 *
 * Permet de lire un ZIP de n'importe quelle taille sans le charger
 * en RAM. On utilise `Blob.slice()` qui ne fait qu'une référence aux
 * octets (sans copie), et `DecompressionStream('deflate-raw')` pour
 * décompresser à la volée.
 *
 * Couvre les cas courants :
 *   - ZIP standard (< 4 GB de fichiers)
 *   - ZIP64 (> 4 GB), via les End Of Central Directory extensions
 *   - Méthodes 0 (stored) et 8 (deflate)
 *   - ZIP imbriqué (Notion Part-1.zip) via baseOffset
 *
 * Stratégie pour les ZIP imbriqués : on évite le double-slice
 * (workingFile = file.slice(...) puis workingFile.slice(...)) qui
 * fait planter Chrome au-delà de 4 GB ("could not be read, permission
 * problems"). À la place, on garde toujours le fichier source original
 * et on translate les offsets via baseOffset.
 *
 * Ne couvre pas :
 *   - Chiffrement (rare en pratique sur les exports Notion)
 *   - Autres méthodes de compression (LZMA, BZIP2, etc.)
 */

export interface ZipEntry {
  name:   string
  size:   number   // taille décompressée
  csize:  number   // taille compressée
  offset: number   // offset du Local File Header (ABSOLU dans le fichier source)
  method: number   // 0 = stored, 8 = deflate
}

const SIG_EOCD     = 0x06054b50
const SIG_EOCD64   = 0x06064b50
const SIG_EOCD64L  = 0x07064b50
const SIG_CDH      = 0x02014b50
const SIG_LFH      = 0x04034b50

export interface ReadZipIndexOptions {
  /**
   * Offset du début du ZIP dans le fichier source.
   *  - 0 (défaut) : le ZIP commence au début du fichier.
   *  - > 0 : le ZIP est imbriqué dans un autre conteneur (Part-1.zip
   *    dans un export Notion par ex).
   */
  baseOffset?: number
  /**
   * Taille "virtuelle" du ZIP imbriqué. Obligatoire si baseOffset > 0,
   * car file.size correspond au conteneur, pas au ZIP imbriqué.
   */
  virtualSize?: number
}

/* ============================== Index reading ============================== */

/**
 * Lit l'index (central directory) du ZIP. Coût : ~64 KB lus + taille du CD.
 * Ne décompresse rien.
 *
 * Pour les ZIP imbriqués, passe { baseOffset, virtualSize } — les reads
 * sont alors faits directement sur le fichier source d'origine avec
 * translation d'offset, ce qui évite le double-slice.
 */
export async function readZipIndex(
  file: Blob,
  options: ReadZipIndexOptions = {},
): Promise<Map<string, ZipEntry>> {
  const baseOffset  = options.baseOffset  ?? 0
  const virtualSize = options.virtualSize ?? (file.size - baseOffset)

  // 1. Trouve l'EOCD dans les 64 derniers KB
  const tailLen   = Math.min(65557, virtualSize)
  const tailStart = baseOffset + virtualSize - tailLen
  const tailEnd   = baseOffset + virtualSize
  const tail = await file.slice(tailStart, tailEnd).arrayBuffer()
  const tailView = new DataView(tail)

  let eocdPos = -1
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tailView.getUint32(i, true) === SIG_EOCD) {
      eocdPos = i
      break
    }
  }
  if (eocdPos < 0) {
    throw new Error('EOCD introuvable — le fichier n\'est pas un ZIP valide.')
  }

  let cdOffset  = tailView.getUint32(eocdPos + 16, true)  // relatif au début du ZIP
  let cdSize    = tailView.getUint32(eocdPos + 12, true)
  let cdEntries = tailView.getUint16(eocdPos + 10, true)

  // 2. ZIP64 si valeurs sentinel
  if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF || cdEntries === 0xFFFF) {
    let locatorPos = -1
    for (let i = eocdPos - 20; i >= 0; i--) {
      if (tailView.getUint32(i, true) === SIG_EOCD64L) {
        locatorPos = i
        break
      }
    }
    if (locatorPos < 0) {
      throw new Error('ZIP64 locator introuvable mais valeurs sentinel détectées.')
    }
    const eocd64RelOffset = readBigUint64(tailView, locatorPos + 8)
    const eocd64AbsOffset = baseOffset + eocd64RelOffset
    const eocd64Buf = await file.slice(eocd64AbsOffset, eocd64AbsOffset + 56).arrayBuffer()
    const eocd64View = new DataView(eocd64Buf)
    if (eocd64View.getUint32(0, true) !== SIG_EOCD64) {
      throw new Error('Signature EOCD64 invalide à l\'offset attendu.')
    }
    cdEntries = Number(readBigUint64(eocd64View, 32))
    cdSize    = Number(readBigUint64(eocd64View, 40))
    cdOffset  = Number(readBigUint64(eocd64View, 48))
  }

  // 3. Lit la central directory (offset absolu = baseOffset + relatif)
  const cdAbsOffset = baseOffset + cdOffset
  const cdBuf = await file.slice(cdAbsOffset, cdAbsOffset + cdSize).arrayBuffer()
  const cd = new DataView(cdBuf)

  // 4. Parse les entrées
  const entries = new Map<string, ZipEntry>()
  let pos = 0
  for (let n = 0; n < cdEntries; n++) {
    if (cd.getUint32(pos, true) !== SIG_CDH) {
      throw new Error(`Signature CDH invalide à l'index ${n}`)
    }
    const method   = cd.getUint16(pos + 10, true)
    let csize      = cd.getUint32(pos + 20, true) >>> 0
    let size       = cd.getUint32(pos + 24, true) >>> 0
    const nameLen  = cd.getUint16(pos + 28, true)
    const extraLen = cd.getUint16(pos + 30, true)
    const commLen  = cd.getUint16(pos + 32, true)
    let lfhOffset  = cd.getUint32(pos + 42, true) >>> 0  // relatif au début du ZIP
    const nameBuf  = new Uint8Array(cdBuf, pos + 46, nameLen)
    const name     = new TextDecoder('utf-8').decode(nameBuf)

    // ZIP64 extra (id = 0x0001)
    if (csize === 0xFFFFFFFF || size === 0xFFFFFFFF || lfhOffset === 0xFFFFFFFF) {
      let xp = pos + 46 + nameLen
      const xEnd = xp + extraLen
      while (xp + 4 <= xEnd) {
        const xid  = cd.getUint16(xp, true)
        const xlen = cd.getUint16(xp + 2, true)
        if (xid === 0x0001) {
          let off = xp + 4
          if (size === 0xFFFFFFFF) { size = Number(readBigUint64(cd, off)); off += 8 }
          if (csize === 0xFFFFFFFF) { csize = Number(readBigUint64(cd, off)); off += 8 }
          if (lfhOffset === 0xFFFFFFFF) { lfhOffset = Number(readBigUint64(cd, off)); off += 8 }
          break
        }
        xp += 4 + xlen
      }
    }

    if (!name.endsWith('/')) {
      // ⚠ offset stocké = ABSOLU dans le fichier source (baseOffset + relatif).
      // Cela permet à extractEntry de lire directement sans baseOffset.
      entries.set(name, { name, size, csize, offset: baseOffset + lfhOffset, method })
    }

    pos += 46 + nameLen + extraLen + commLen
  }

  return entries
}

/* ============================== Entry extraction ============================== */

/**
 * Extrait UNE entrée du ZIP comme Blob. Décompresse à la volée si besoin.
 *
 * @param onProgress  Callback optionnel appelé périodiquement avec le %
 *                    de bytes lus depuis le ZIP source (utile pour les
 *                    grosses entrées comme un Part-1.zip de 4 GB).
 */
export async function extractEntry(
  file: Blob,
  entry: ZipEntry,
  onProgress?: (percent: number, bytesRead: number, totalBytes: number) => void,
): Promise<Blob> {
  // 1. Lit le Local File Header
  const lfhBuf = await file.slice(entry.offset, entry.offset + 30).arrayBuffer()
  const lfh = new DataView(lfhBuf)
  if (lfh.getUint32(0, true) !== SIG_LFH) {
    throw new Error(`LFH signature invalide pour ${entry.name}`)
  }
  const nameLen  = lfh.getUint16(26, true)
  const extraLen = lfh.getUint16(28, true)
  const dataOffset = entry.offset + 30 + nameLen + extraLen

  // 2. Slice les données compressées (absolu dans le fichier source)
  const dataBlob = file.slice(dataOffset, dataOffset + entry.csize)

  // 3. Décompresse si nécessaire
  if (entry.method === 0) {
    return dataBlob
  }
  if (entry.method !== 8) {
    throw new Error(`Méthode de compression non supportée : ${entry.method} (entrée ${entry.name})`)
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream non disponible — utilise un navigateur moderne (Chrome 80+, Firefox 113+, Safari 16.4+).')
  }

  // Stream avec progress : on intercepte chaque chunk pour compter les bytes lus
  // depuis le ZIP source, avant qu'ils ne soient piped au décompresseur.
  const total = entry.csize
  let bytesRead = 0
  let lastEmit = 0

  const sourceStream = dataBlob.stream()
  // Le TransformStream pour le progress peut interrompre le pipe si la
  // callback onProgress throw (ex : setProgress React mid-render → erreur).
  // On wrap CHAQUE appel onProgress dans un try/catch silencieux, ET on
  // garde la possibilité de désactiver le progress (= pipe direct).
  const progressStream = onProgress
    ? new TransformStream({
        transform(chunk, controller) {
          try {
            bytesRead += chunk.byteLength
            const now = performance.now()
            if (now - lastEmit > 200) {
              const pct = total > 0 ? Math.min(100, Math.round(bytesRead / total * 100)) : 0
              try { onProgress(pct, bytesRead, total) } catch { /* ignore React errors */ }
              lastEmit = now
            }
          } catch { /* never break the stream because of progress */ }
          controller.enqueue(chunk)
        },
        flush() {
          try { if (onProgress) onProgress(100, total, total) } catch { /* ignore */ }
        },
      })
    : null

  const ds = new DecompressionStream('deflate-raw')
  const decompressed = progressStream
    ? sourceStream.pipeThrough(progressStream).pipeThrough(ds)
    : sourceStream.pipeThrough(ds)
  return await new Response(decompressed).blob()
}

/**
 * Calcule l'offset du début des DONNÉES (post LFH) d'une entrée donnée
 * dans le fichier source. Utile pour lire un ZIP imbriqué sans le
 * détacher du conteneur — on récupère son baseOffset + virtualSize
 * et on appelle readZipIndex avec ces options.
 */
export async function getEntryDataOffset(file: Blob, entry: ZipEntry): Promise<{ dataOffset: number; csize: number }> {
  const lfhBuf = await file.slice(entry.offset, entry.offset + 30).arrayBuffer()
  const lfh = new DataView(lfhBuf)
  if (lfh.getUint32(0, true) !== SIG_LFH) {
    throw new Error(`LFH signature invalide pour ${entry.name}`)
  }
  const nameLen  = lfh.getUint16(26, true)
  const extraLen = lfh.getUint16(28, true)
  const dataOffset = entry.offset + 30 + nameLen + extraLen
  return { dataOffset, csize: entry.csize }
}

function readBigUint64(view: DataView, offset: number): number {
  const low  = view.getUint32(offset, true) >>> 0
  const high = view.getUint32(offset + 4, true) >>> 0
  if (high > 0x1FFFFF) {
    throw new Error('Valeur ZIP64 > Number.MAX_SAFE_INTEGER — pas géré.')
  }
  return high * 0x100000000 + low
}
