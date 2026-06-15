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
 *
 * Ne couvre pas :
 *   - Chiffrement (rare en pratique sur les exports Notion)
 *   - Autres méthodes de compression (LZMA, BZIP2, etc. — extrêmement rare)
 */

export interface ZipEntry {
  name:   string
  size:   number       // taille décompressée
  csize:  number       // taille compressée
  offset: number       // offset du Local File Header dans le Blob source
  method: number       // 0 = stored, 8 = deflate
}

const SIG_EOCD     = 0x06054b50
const SIG_EOCD64   = 0x06064b50
const SIG_EOCD64L  = 0x07064b50
const SIG_CDH      = 0x02014b50
const SIG_LFH      = 0x04034b50

/* ============================== Index reading ============================== */

/**
 * Lit l'index (central directory) du ZIP. Coût : ~64 KB lus + taille du CD.
 * Ne décompresse rien.
 */
export async function readZipIndex(file: Blob): Promise<Map<string, ZipEntry>> {
  // 1. Trouve l'EOCD dans les 64 derniers KB
  const tailLen = Math.min(65557, file.size)
  const tail = await file.slice(file.size - tailLen, file.size).arrayBuffer()
  const tailView = new DataView(tail)

  let eocdPos = -1
  // Cherche le signature EOCD à rebours
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tailView.getUint32(i, true) === SIG_EOCD) {
      eocdPos = i
      break
    }
  }
  if (eocdPos < 0) {
    throw new Error('EOCD introuvable — le fichier n\'est pas un ZIP valide.')
  }

  let cdOffset = tailView.getUint32(eocdPos + 16, true)
  let cdSize   = tailView.getUint32(eocdPos + 12, true)
  let cdEntries = tailView.getUint16(eocdPos + 10, true)

  // 2. Si valeurs ZIP64 sentinel (0xFFFFFFFF / 0xFFFF), lire EOCD64
  if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF || cdEntries === 0xFFFF) {
    // Cherche le locator EOCD64 juste avant l'EOCD
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
    // Le locator donne l'offset absolu de l'EOCD64 dans le fichier
    const eocd64Offset = readBigUint64(tailView, locatorPos + 8)
    // Lit l'EOCD64 (56 bytes)
    const eocd64Buf = await file.slice(eocd64Offset, eocd64Offset + 56).arrayBuffer()
    const eocd64View = new DataView(eocd64Buf)
    if (eocd64View.getUint32(0, true) !== SIG_EOCD64) {
      throw new Error('Signature EOCD64 invalide à l\'offset attendu.')
    }
    cdEntries = Number(readBigUint64(eocd64View, 32))
    cdSize    = Number(readBigUint64(eocd64View, 40))
    cdOffset  = Number(readBigUint64(eocd64View, 48))
  }

  // 3. Lit la central directory
  const cdBuf = await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer()
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
    let lfhOffset  = cd.getUint32(pos + 42, true) >>> 0
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

    // On ignore les dossiers (size 0 + name finit par /)
    if (!name.endsWith('/')) {
      entries.set(name, { name, size, csize, offset: lfhOffset, method })
    }

    pos += 46 + nameLen + extraLen + commLen
  }

  return entries
}

/* ============================== Entry extraction ============================== */

/**
 * Extrait UNE entrée du ZIP comme Blob. Décompresse à la volée si besoin.
 * Coût : taille compressée lue + taille décompressée allouée.
 */
export async function extractEntry(file: Blob, entry: ZipEntry): Promise<Blob> {
  // 1. Lit le Local File Header pour connaître les longueurs name + extra
  const lfhBuf = await file.slice(entry.offset, entry.offset + 30).arrayBuffer()
  const lfh = new DataView(lfhBuf)
  if (lfh.getUint32(0, true) !== SIG_LFH) {
    throw new Error(`LFH signature invalide pour ${entry.name}`)
  }
  const nameLen  = lfh.getUint16(26, true)
  const extraLen = lfh.getUint16(28, true)
  const dataOffset = entry.offset + 30 + nameLen + extraLen

  // 2. Slice les données compressées
  const dataBlob = file.slice(dataOffset, dataOffset + entry.csize)

  // 3. Décompresse si nécessaire
  if (entry.method === 0) {
    // Stored — pas de compression
    return dataBlob
  }
  if (entry.method === 8) {
    // Deflate — utilise DecompressionStream natif du browser
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('DecompressionStream non disponible — utilise un navigateur moderne (Chrome 80+, Firefox 113+, Safari 16.4+).')
    }
    const ds = new DecompressionStream('deflate-raw')
    const decompressed = dataBlob.stream().pipeThrough(ds)
    return await new Response(decompressed).blob()
  }
  throw new Error(`Méthode de compression non supportée : ${entry.method} (entrée ${entry.name})`)
}

/* ============================== utils ============================== */

function readBigUint64(view: DataView, offset: number): number {
  // On suppose que la valeur tient dans Number.MAX_SAFE_INTEGER (53 bits)
  // — vrai pour les tailles de fichier en pratique
  const low  = view.getUint32(offset, true) >>> 0
  const high = view.getUint32(offset + 4, true) >>> 0
  if (high > 0x1FFFFF) {
    throw new Error('Valeur ZIP64 > Number.MAX_SAFE_INTEGER — pas géré.')
  }
  return high * 0x100000000 + low
}
