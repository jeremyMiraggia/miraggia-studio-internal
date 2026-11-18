/**
 * 🏷 Logo Fix (option C hybride) — traitement d'image côté navigateur.
 * Spec : zulo_logo_fix_spec.json v1.0.
 *
 *  1 preparerLogo      masques couleur du logo fourni (alpha / segmentation + k-means)
 *  2 localiserLogo     bbox du logo déformé (couleurs Lab + composantes connexes, repli template matching)
 *  3 effacerAncienLogo inpainting par diffusion (équivalent Telea, rayon 5)
 *  4 collerLogo        option A : collage déterministe, couleurs mesurées, ombrage, netteté, grain
 *  5 recadrerPourIA    recadrage 3:2 → 1536×1024 + masque d'édition
 *  7 harmoniser        calage couleur tissu + logo, flou, recollage en ellipse
 *  8 qa                IoU par couleur (agrandi ×8)
 * La passe IA (étape 6) est faite par /api/studio/logo-fix.
 */

export type RGB = [number, number, number]
export type Img = { w: number; h: number; d: Uint8ClampedArray } // RGBA
export type Box = { x: number; y: number; w: number; h: number }
export type LogoColor = { rgb: RGB; mask: Float32Array }
export type PreparedLogo = { w: number; h: number; colors: LogoColor[]; fg: Float32Array; aspect: number }

export const RENDUS = {
  broderie: { en: 'embroidery', details: 'visible thread texture and stitch direction' },
  impression: { en: 'screen print', details: 'thin ink layer following the fabric grain' },
  'transfert/flex': { en: 'heat-transfer vinyl print', details: 'smooth slightly glossy film with soft edges' },
} as const
export type Rendu = keyof typeof RENDUS | 'aucun'

/* ============================== utilitaires ============================== */

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b

export function rgbToLab(r: number, g: number, b: number): RGB {
  const f = (c: number) => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92 }
  const R = f(r), G = f(g), B = f(b)
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047
  let y = R * 0.2126 + G * 0.7152 + B * 0.0722
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883
  const h = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  x = h(x); y = h(y); z = h(z)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}
const dE = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

export function cloneImg(im: Img): Img { return { w: im.w, h: im.h, d: new Uint8ClampedArray(im.d) } }

/** Flou gaussien séparable sur un plan float. */
export function blur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0.05) return new Float32Array(src)
  const r = Math.max(1, Math.ceil(sigma * 3))
  const k = new Float32Array(2 * r + 1)
  let s = 0
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r] }
  for (let i = 0; i < k.length; i++) k[i] /= s
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0
    for (let i = -r; i <= r; i++) a += src[y * w + clamp(x + i, 0, w - 1)] * k[i + r]
    tmp[y * w + x] = a
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0
    for (let i = -r; i <= r; i++) a += tmp[clamp(y + i, 0, h - 1) * w + x] * k[i + r]
    out[y * w + x] = a
  }
  return out
}

/** Poids de rééchantillonnage 1D : par surface en réduction (INTER_AREA), bilinéaire en agrandissement. */
function weights1D(n: number, N: number): { i: number[]; w: number[] }[] {
  const sc = n / N, out: { i: number[]; w: number[] }[] = []
  for (let I = 0; I < N; I++) {
    if (sc >= 1) {
      const s0 = I * sc, s1 = s0 + sc, ii: number[] = [], ww: number[] = []
      for (let i = Math.floor(s0); i < Math.ceil(s1) && i < n; i++) { ii.push(i); ww.push((Math.min(i + 1, s1) - Math.max(i, s0)) / sc) }
      out.push({ i: ii, w: ww })
    } else {
      const f = (I + 0.5) * sc - 0.5
      const i0 = clamp(Math.floor(f), 0, n - 1), i1 = clamp(i0 + 1, 0, n - 1), t = clamp(f - Math.floor(f), 0, 1)
      out.push({ i: [i0, i1], w: [1 - t, t] })
    }
  }
  return out
}

/** Redimensionne un plan float w×h → W×H. */
export function resizePlane(src: Float32Array, w: number, h: number, W: number, H: number): Float32Array {
  const wx = weights1D(w, W), wy = weights1D(h, H)
  const tmp = new Float32Array(W * h)
  for (let y = 0; y < h; y++) for (let X = 0; X < W; X++) {
    const k = wx[X]; let a = 0
    for (let t = 0; t < k.i.length; t++) a += src[y * w + k.i[t]] * k.w[t]
    tmp[y * W + X] = a
  }
  const out = new Float32Array(W * H)
  for (let Y = 0; Y < H; Y++) {
    const k = wy[Y]
    for (let X = 0; X < W; X++) {
      let a = 0
      for (let t = 0; t < k.i.length; t++) a += tmp[k.i[t] * W + X] * k.w[t]
      out[Y * W + X] = a
    }
  }
  return out
}

function planes(im: Img, box?: Box): [Float32Array, Float32Array, Float32Array] {
  const b = box ?? { x: 0, y: 0, w: im.w, h: im.h }
  const R = new Float32Array(b.w * b.h), G = new Float32Array(b.w * b.h), B = new Float32Array(b.w * b.h)
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
    const i = ((b.y + y) * im.w + b.x + x) * 4, j = y * b.w + x
    R[j] = im.d[i]; G[j] = im.d[i + 1]; B[j] = im.d[i + 2]
  }
  return [R, G, B]
}

function ringMedian(im: Img, inner: Box, pad: number): RGB {
  const rs: number[] = [], gs: number[] = [], bs: number[] = []
  const x0 = Math.max(0, inner.x - pad), y0 = Math.max(0, inner.y - pad)
  const x1 = Math.min(im.w, inner.x + inner.w + pad), y1 = Math.min(im.h, inner.y + inner.h + pad)
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (x >= inner.x && x < inner.x + inner.w && y >= inner.y && y < inner.y + inner.h) continue
    const i = (y * im.w + x) * 4
    rs.push(im.d[i]); gs.push(im.d[i + 1]); bs.push(im.d[i + 2])
  }
  return [median(rs), median(gs), median(bs)]
}

export const expandBox = (b: Box, m: number, W: number, H: number): Box => {
  const x = Math.max(0, Math.floor(b.x - m)), y = Math.max(0, Math.floor(b.y - m))
  return { x, y, w: Math.min(W, Math.ceil(b.x + b.w + m)) - x, h: Math.min(H, Math.ceil(b.y + b.h + m)) - y }
}

/* ============================== 1. préparer le logo ============================== */

function kmeans(pts: RGB[], k: number, iters = 15): { centers: RGB[]; inertia: number } {
  let centers: RGB[] = [pts[0]]
  while (centers.length < k) { // k-means++ déterministe : point le plus éloigné
    let best = pts[0], bd = -1
    for (const p of pts) { const d = Math.min(...centers.map(c => dE(p, c))); if (d > bd) { bd = d; best = p } }
    centers.push(best)
  }
  let inertia = 0
  for (let it = 0; it < iters; it++) {
    const sum = centers.map(() => [0, 0, 0, 0])
    inertia = 0
    for (const p of pts) {
      let bi = 0, bd = Infinity
      centers.forEach((c, i) => { const d = dE(p, c); if (d < bd) { bd = d; bi = i } })
      inertia += bd * bd
      const s = sum[bi]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++
    }
    centers = centers.map((c, i) => (sum[i][3] ? [sum[i][0] / sum[i][3], sum[i][1] / sum[i][3], sum[i][2] / sum[i][3]] : c) as RGB)
  }
  return { centers, inertia }
}

export function preparerLogo(im: Img): PreparedLogo {
  const N = im.w * im.h
  let transparent = 0
  for (let i = 0; i < N; i++) if (im.d[i * 4 + 3] < 250) transparent++
  const fgFull = new Float32Array(N)
  if (transparent / N > 0.02) {
    for (let i = 0; i < N; i++) fgFull[i] = im.d[i * 4 + 3] / 255
  } else {
    // fond = couleur dominante des bords
    const rs: number[] = [], gs: number[] = [], bs: number[] = []
    for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) {
      if (x > 1 && y > 1 && x < im.w - 2 && y < im.h - 2) continue
      const i = (y * im.w + x) * 4; rs.push(im.d[i]); gs.push(im.d[i + 1]); bs.push(im.d[i + 2])
    }
    const bg = rgbToLab(median(rs), median(gs), median(bs))
    for (let i = 0; i < N; i++) {
      const d = dE(rgbToLab(im.d[i * 4], im.d[i * 4 + 1], im.d[i * 4 + 2]), bg)
      fgFull[i] = clamp((d - 20) / 30, 0, 1) // seuil / largeur (en ΔE Lab)
    }
  }
  // bbox du logo
  let x0 = im.w, y0 = im.h, x1 = -1, y1 = -1
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) if (fgFull[y * im.w + x] > 0.1) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
  }
  if (x1 < 0) throw new Error('Logo vide : aucun pixel ne se distingue du fond.')
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1
  const fg = new Float32Array(bw * bh)
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) fg[y * bw + x] = fgFull[(y + y0) * im.w + x + x0]

  // couleurs : k-means sur les pixels du logo (k choisi automatiquement, 1 à 4)
  const sample: RGB[] = []
  const step = Math.max(1, Math.floor(Math.sqrt((bw * bh) / 20000)))
  for (let y = 0; y < bh; y += step) for (let x = 0; x < bw; x += step) if (fg[y * bw + x] > 0.6) {
    const i = ((y + y0) * im.w + x + x0) * 4; sample.push([im.d[i], im.d[i + 1], im.d[i + 2]])
  }
  if (!sample.length) throw new Error('Logo trop fin pour en extraire les couleurs.')
  let best = kmeans(sample, 1)
  for (let k = 2; k <= Math.min(4, sample.length); k++) {
    const r = kmeans(sample, k)
    if (r.inertia > best.inertia * 0.5) break // gain insuffisant → on garde k-1
    best = r
  }
  const centers = best.centers.filter(c => sample.some(p => dE(p, c) < 40))
  const masks = centers.map(() => new Float32Array(bw * bh))
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const j = y * bw + x
    if (fg[j] <= 0) continue
    const i = ((y + y0) * im.w + x + x0) * 4
    const p: RGB = [im.d[i], im.d[i + 1], im.d[i + 2]]
    let bi = 0, bd = Infinity
    centers.forEach((c, ci) => { const d = dE(p, c); if (d < bd) { bd = d; bi = ci } })
    masks[bi][j] = fg[j]
  }
  const sigma = transparent / N > 0.02 ? 0.8 : 2
  const scale = Math.max(1, Math.max(bw, bh) / 1500) // flou en px « logo HD »
  const colors = centers.map((c, i) => ({ rgb: c.map(Math.round) as RGB, mask: blur(masks[i], bw, bh, sigma * scale) }))
    .filter(c => c.mask.reduce((s, v) => s + v, 0) > bw * bh * 0.002)
  return { w: bw, h: bh, colors, fg, aspect: bw / bh }
}

/* ============================== 2. localiser le logo ============================== */

export function localiserLogo(src: Img, logo: PreparedLogo, hint?: Box): Box | null {
  const R = hint ? expandBox(hint, Math.max(hint.w, hint.h) * 0.2, src.w, src.h) : { x: 0, y: 0, w: src.w, h: src.h }
  const fabric = rgbToLab(...ringMedian(src, { x: R.x + R.w / 2 - 1, y: R.y + R.h / 2 - 1, w: 2, h: 2 }, Math.max(R.w, R.h)))
  const labs = logo.colors.map(c => rgbToLab(...c.rgb)).filter(l => dE(l, fabric) > 20)
  let found: Box | null = null
  if (labs.length) {
    const m = new Uint8Array(R.w * R.h)
    for (let y = 0; y < R.h; y++) for (let x = 0; x < R.w; x++) {
      const i = ((R.y + y) * src.w + R.x + x) * 4
      const l = rgbToLab(src.d[i], src.d[i + 1], src.d[i + 2])
      if (labs.some(c => dE(l, c) < 28)) m[y * R.w + x] = 1
    }
    // regroupement des blobs proches : dilatation puis composantes connexes
    const rad = Math.max(2, Math.round(Math.min(R.w, R.h) / 250))
    const dil = dilate(m, R.w, R.h, rad)
    const lab = new Int32Array(R.w * R.h).fill(-1)
    const groups: { x0: number; y0: number; x1: number; y1: number; n: number }[] = []
    const stack: number[] = []
    for (let s = 0; s < dil.length; s++) {
      if (!dil[s] || lab[s] >= 0) continue
      const g = { x0: R.w, y0: R.h, x1: -1, y1: -1, n: 0 }
      lab[s] = groups.length; stack.push(s)
      while (stack.length) {
        const p = stack.pop()!, px = p % R.w, py = (p / R.w) | 0
        if (m[p]) { g.n++; if (px < g.x0) g.x0 = px; if (px > g.x1) g.x1 = px; if (py < g.y0) g.y0 = py; if (py > g.y1) g.y1 = py }
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const qx = px + dx, qy = py + dy
          if (qx < 0 || qy < 0 || qx >= R.w || qy >= R.h) continue
          const q = qy * R.w + qx
          if (dil[q] && lab[q] < 0) { lab[q] = groups.length; stack.push(q) }
        }
      }
      groups.push(g)
    }
    let bestScore = Infinity
    for (const g of groups) {
      if (g.n < 20) continue
      const w = g.x1 - g.x0 + 1, h = g.y1 - g.y0 + 1
      if (w < 8 || h < 4 || w > R.w * 0.9) continue
      const score = Math.abs(Math.log((w / h) / logo.aspect)) - 0.05 * Math.log(g.n)
      if (score < bestScore) { bestScore = score; found = { x: R.x + g.x0, y: R.y + g.y0, w, h } }
    }
    if (found && Math.abs(Math.log((found.w / found.h) / logo.aspect)) > Math.log(1.6)) found = null
  }
  if (!found && hint) found = templateMatch(src, logo, R)
  return found
}

function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const a = new Uint8Array(m.length), o = new Uint8Array(m.length)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0
    for (let i = -r; i <= r && !v; i++) { const xx = x + i; if (xx >= 0 && xx < w && m[y * w + xx]) v = 1 }
    a[y * w + x] = v
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0
    for (let i = -r; i <= r && !v; i++) { const yy = y + i; if (yy >= 0 && yy < h && a[yy * w + x]) v = 1 }
    o[y * w + x] = v
  }
  return o
}

/** Repli : template matching multi-échelle (NCC absolue) dans la zone indiquée. */
function templateMatch(src: Img, logo: PreparedLogo, R: Box): Box | null {
  const s = Math.min(1, 200 / Math.max(R.w, R.h))
  const W = Math.max(8, Math.round(R.w * s)), H = Math.max(8, Math.round(R.h * s))
  const [r, g, b] = planes(src, R)
  const L = new Float32Array(R.w * R.h)
  for (let i = 0; i < L.length; i++) L[i] = lum(r[i], g[i], b[i])
  const img = resizePlane(L, R.w, R.h, W, H)
  // gabarit : luminance du logo (fond = 0)
  const T0 = new Float32Array(logo.w * logo.h)
  for (const c of logo.colors) { const l = lum(...c.rgb) + 30; for (let i = 0; i < T0.length; i++) T0[i] += c.mask[i] * l }
  let best = { score: 0.35, box: null as Box | null }
  for (let k = 0; k < 14; k++) {
    const tw = Math.round(W * (0.25 + (0.7 * k) / 13)), th = Math.round(tw / logo.aspect)
    if (tw < 6 || th < 4 || th > H || tw > W) continue
    const T = resizePlane(T0, logo.w, logo.h, tw, th)
    const n = tw * th
    let tm = 0; for (const v of T) tm += v; tm /= n
    let ts = 0; for (let i = 0; i < n; i++) { T[i] -= tm; ts += T[i] * T[i] }
    ts = Math.sqrt(ts) || 1
    for (let y = 0; y + th <= H; y++) for (let x = 0; x + tw <= W; x++) {
      let sm = 0, sq = 0, cr = 0
      for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
        const v = img[(y + j) * W + x + i]; sm += v; sq += v * v; cr += v * T[j * tw + i]
      }
      const sd = Math.sqrt(Math.max(1e-6, sq - (sm * sm) / n))
      const ncc = Math.abs(cr / (sd * ts))
      if (ncc > best.score) best = { score: ncc, box: { x: R.x + Math.round(x / s), y: R.y + Math.round(y / s), w: Math.round(tw / s), h: Math.round(th / s) } }
    }
  }
  return best.box
}

/* ============================== 3. effacer l'ancien logo ============================== */

export function effacerAncienLogo(src: Img, bbox: Box, logo: PreparedLogo): { clean: Img; measured: (RGB | null)[]; mask: Uint8Array; zone: Box } {
  const Z = expandBox(bbox, 6, src.w, src.h)
  const fabricRgb = ringMedian(src, Z, 4)
  const fabric = rgbToLab(...fabricRgb)
  const labs = logo.colors.map(c => rgbToLab(...c.rgb))
  const raw = new Uint8Array(Z.w * Z.h)
  const owner = new Int8Array(Z.w * Z.h).fill(-1)
  for (let y = 0; y < Z.h; y++) for (let x = 0; x < Z.w; x++) {
    const i = ((Z.y + y) * src.w + Z.x + x) * 4
    const l = rgbToLab(src.d[i], src.d[i + 1], src.d[i + 2])
    const dFab = dE(l, fabric)
    let bi = -1, bd = Infinity
    labs.forEach((c, ci) => { const d = dE(l, c); if (d < bd) { bd = d; bi = ci } })
    if (dFab > 22 || bd < 28) {
      raw[y * Z.w + x] = 1
      if (bd < dFab) owner[y * Z.w + x] = bi
    }
  }
  // couleurs réellement rendues dans l'ancien logo (médiane par couleur)
  const measured: (RGB | null)[] = logo.colors.map((_, ci) => {
    const rs: number[] = [], gs: number[] = [], bs: number[] = []
    for (let y = 0; y < Z.h; y++) for (let x = 0; x < Z.w; x++) if (owner[y * Z.w + x] === ci) {
      const i = ((Z.y + y) * src.w + Z.x + x) * 4; rs.push(src.d[i]); gs.push(src.d[i + 1]); bs.push(src.d[i + 2])
    }
    return rs.length >= 3 ? [median(rs), median(gs), median(bs)] : null
  })
  const mask = dilate(dilate(raw, Z.w, Z.h, 1), Z.w, Z.h, 1)
  const clean = cloneImg(src)
  inpaint(clean, Z, mask, 5)
  return { clean, measured, mask, zone: Z }
}

/** Inpainting par pelure d'oignon (diffusion pondérée 1/d², rayon r) — remplace cv2.INPAINT_TELEA. */
function inpaint(im: Img, Z: Box, mask: Uint8Array, r: number) {
  const known = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) known[i] = mask[i] ? 0 : 1
  let remaining = mask.reduce((s, v) => s + v, 0)
  let guard = 0
  while (remaining > 0 && guard++ < 500) {
    const front: number[] = []
    for (let y = 0; y < Z.h; y++) for (let x = 0; x < Z.w; x++) {
      const j = y * Z.w + x
      if (known[j]) continue
      let edge = false
      for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy
        // hors zone = pixel connu de l'image
        if (xx < 0 || yy < 0 || xx >= Z.w || yy >= Z.h || known[yy * Z.w + xx]) { edge = true; break }
      }
      if (edge) front.push(j)
    }
    if (!front.length) break
    const vals: number[][] = []
    for (const j of front) {
      const x = j % Z.w, y = (j / Z.w) | 0
      let a = 0, rr = 0, gg = 0, bb = 0
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dy * dy
        if (!d2 || d2 > r * r) continue
        const xx = x + dx, yy = y + dy, gx = Z.x + xx, gy = Z.y + yy
        if (gx < 0 || gy < 0 || gx >= im.w || gy >= im.h) continue
        const inside = xx >= 0 && yy >= 0 && xx < Z.w && yy < Z.h
        if (inside && !known[yy * Z.w + xx]) continue
        const wgt = 1 / d2, i = (gy * im.w + gx) * 4
        rr += im.d[i] * wgt; gg += im.d[i + 1] * wgt; bb += im.d[i + 2] * wgt; a += wgt
      }
      vals.push(a ? [rr / a, gg / a, bb / a] : [0, 0, 0])
    }
    front.forEach((j, k) => {
      const i = ((Z.y + ((j / Z.w) | 0)) * im.w + Z.x + (j % Z.w)) * 4
      im.d[i] = vals[k][0]; im.d[i + 1] = vals[k][1]; im.d[i + 2] = vals[k][2]
      known[j] = 1
    })
    remaining -= front.length
  }
}

/* ============================== 4. coller le logo (option A) ============================== */

export type Placed = { box: Box; masks: Float32Array[]; colors: RGB[] }

export function collerLogo(clean: Img, bbox: Box, logo: PreparedLogo, measured: (RGB | null)[], seed = 1): { image: Img; placed: Placed } {
  const { w, h } = bbox
  const masks = logo.colors.map(c => blur(resizePlane(c.mask, logo.w, logo.h, w, h), w, h, 0.45))
  // ombrage = luminance locale du tissu nettoyé / moyenne
  const Lb = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((bbox.y + y) * clean.w + bbox.x + x) * 4; Lb[y * w + x] = lum(clean.d[i], clean.d[i + 1], clean.d[i + 2])
  }
  const Ls = blur(Lb, w, h, Math.max(1.5, h / 6))
  const mean = Ls.reduce((s, v) => s + v, 0) / Ls.length || 1
  const fabricLum = lum(...ringMedian(clean, bbox, 4))
  const colors: RGB[] = logo.colors.map((c, i) => measured[i] ?? (c.rgb.map(v => v * clamp(0.55 + fabricLum / 255, 0.6, 1)) as RGB))
  const image = cloneImg(clean)
  let s = seed * 9301 + 49297
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 }
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd())
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const j = y * w + x
    let tot = 0
    for (const m of masks) tot += m[j]
    if (tot <= 0.002) continue
    const norm = tot > 1 ? 1 / tot : 1
    const shade = clamp(Ls[j] / mean, 0.85, 1.15)
    const i = ((bbox.y + y) * image.w + bbox.x + x) * 4
    const a = Math.min(1, tot)
    const n = gauss() * 2 * a
    for (let ch = 0; ch < 3; ch++) {
      let logoV = 0
      masks.forEach((m, ci) => { logoV += m[j] * norm * colors[ci][ch] })
      image.d[i + ch] = clamp(clean.d[i + ch] * (1 - a) + logoV * shade + n, 0, 255)
    }
  }
  return { image, placed: { box: bbox, masks, colors } }
}

/* ============================== 5. recadrer pour l'IA ============================== */

export const IA_W = 1536, IA_H = 1024

export function zoneRecadrage(bbox: Box, W: number, H: number): Box {
  let cw = Math.max(120, 4 * bbox.w), ch = Math.round((cw * 2) / 3)
  if (cw > W) { cw = W; ch = Math.round((cw * 2) / 3) }
  if (ch > H) { ch = H; cw = Math.round(ch * 1.5) }
  const cx = bbox.x + bbox.w / 2, cy = bbox.y + bbox.h / 2
  const x = clamp(Math.round(cx - cw / 2), 0, W - cw), y = clamp(Math.round(cy - ch / 2), 0, H - ch)
  return { x, y, w: cw, h: ch }
}

/** Masque API : opaque partout, transparent sur la bbox du logo agrandie + 15 %. */
export function masqueIA(bbox: Box, crop: Box): Img {
  const s = IA_W / crop.w
  const mx = bbox.w * 0.15, my = bbox.h * 0.15
  const x0 = Math.floor((bbox.x - crop.x - mx) * s), x1 = Math.ceil((bbox.x - crop.x + bbox.w + mx) * s)
  const y0 = Math.floor((bbox.y - crop.y - my) * s), y1 = Math.ceil((bbox.y - crop.y + bbox.h + my) * s)
  const d = new Uint8ClampedArray(IA_W * IA_H * 4)
  for (let y = 0; y < IA_H; y++) for (let x = 0; x < IA_W; x++) {
    const i = (y * IA_W + x) * 4
    d[i] = d[i + 1] = d[i + 2] = 255
    d[i + 3] = x >= x0 && x < x1 && y >= y0 && y < y1 ? 0 : 255
  }
  return { w: IA_W, h: IA_H, d }
}

export function buildLogoPrompt(o: { rendu: keyof typeof RENDUS; vetement?: string; texte?: string }) {
  const r = RENDUS[o.rendu]
  const texte = o.texte?.trim() ? o.texte.trim() : 'and graphic elements'
  return `Image 1 is an upscaled close-up of a ${o.vetement?.trim() || 'garment'} with a logo that has been digitally placed and already has the correct shape. Image 2 is the reference logo. Refine image 1 only so the logo looks like a real ${r.en} on this fabric: ${r.details}, subtle relief and shading matching the scene lighting, crisp edges. Do NOT change the logo's shape, letters (${texte}), proportions, position or size — keep them exactly as in image 1. Keep the fabric, seams, framing and colors identical.`
}

/* ============================== 7. harmoniser et recoller ============================== */

/** ia = sortie IA déjà ramenée à la taille du recadrage. base = option A (identique à la source hors zone effacée). */
export function harmoniser(base: Img, source: Img, ia: Img, crop: Box, placed: Placed): Img {
  const { w, h } = crop
  const bx = placed.box.x - crop.x, by = placed.box.y - crop.y
  const cx = bx + placed.box.w / 2, cy = by + placed.box.h / 2
  const ax = 0.95 * placed.box.w, ay = 1.0 * placed.box.h
  // ellipse de recollage (floutée sigma 5)
  let ell: Float32Array = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ell[y * w + x] = ((x - cx) / ax) ** 2 + ((y - cy) / ay) ** 2 <= 1 ? 1 : 0
  ell = blur(ell, w, h, 5)

  const [iR, iG, iB] = planes(ia)
  const [oR, oG, oB] = planes(source, crop)
  // 2) calage couleur du tissu : stats sur les pixels hors ellipse (tissu, dans les 2 images)
  const fab: number[] = []
  for (let j = 0; j < w * h; j++) if (ell[j] < 0.02) fab.push(j)
  const stat = (p: Float32Array) => {
    let m = 0; for (const j of fab) m += p[j]; m /= fab.length || 1
    let v = 0; for (const j of fab) v += (p[j] - m) ** 2
    return [m, Math.sqrt(v / (fab.length || 1)) || 1]
  }
  const out = [iR, iG, iB].map((p, c) => {
    const [mi, si] = stat(p), [mo, so] = stat([oR, oG, oB][c])
    const k = clamp(so / si, 0.5, 2)
    const q = new Float32Array(p.length)
    for (let j = 0; j < p.length; j++) q[j] = (p[j] - mi) * k + mo
    return q
  })
  // 3) calage couleur du logo : médiane IA sous chaque masque → couleur mesurée
  placed.masks.forEach((m, ci) => {
    const idx: number[] = [], wts: number[] = []
    for (let y = 0; y < placed.box.h; y++) for (let x = 0; x < placed.box.w; x++) {
      const v = m[y * placed.box.w + x]
      const X = bx + x, Y = by + y
      if (X < 0 || Y < 0 || X >= w || Y >= h) continue
      idx.push(Y * w + X); wts.push(v)
    }
    const strong = idx.filter((_, k) => wts[k] > 0.5)
    if (strong.length < 3) return
    for (let c = 0; c < 3; c++) {
      const shift = placed.colors[ci][c] - median(strong.map(j => out[c][j]))
      idx.forEach((j, k) => { out[c][j] += shift * wts[k] })
    }
  })
  // 4) netteté de la photo
  const sharp = out.map(p => blur(p, w, h, 0.55))
  // 6) recollage
  const res = cloneImg(base)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const j = y * w + x, a = ell[j]
    if (a <= 0.001) continue
    const i = ((crop.y + y) * res.w + crop.x + x) * 4
    for (let c = 0; c < 3; c++) res.d[i + c] = clamp(base.d[i + c] * (1 - a) + sharp[c][j] * a, 0, 255)
  }
  return res
}

/* ============================== 8. QA ============================== */

export type QA = { score: number; statut: 'ok' | 'a_verifier' | 'rejet'; parCouleur: number[] }

export function qa(final: Img, bbox: Box, logo: PreparedLogo, colors: RGB[]): QA {
  const Z = 8, W = bbox.w * Z, H = bbox.h * Z
  const [r, g, b] = planes(final, bbox)
  const R = resizePlane(r, bbox.w, bbox.h, W, H), G = resizePlane(g, bbox.w, bbox.h, W, H), B = resizePlane(b, bbox.w, bbox.h, W, H)
  const fabric = rgbToLab(...ringMedian(final, bbox, 4))
  const labs = colors.map(c => rgbToLab(...c))
  const refs = logo.colors.map(c => resizePlane(c.mask, logo.w, logo.h, W, H))
  const inter = colors.map(() => 0), union = colors.map(() => 0), area = colors.map(() => 0)
  for (let j = 0; j < W * H; j++) {
    const l = rgbToLab(R[j], G[j], B[j])
    let bi = -1, bd = dE(l, fabric)
    labs.forEach((c, ci) => { const d = dE(l, c); if (d < bd) { bd = d; bi = ci } })
    refs.forEach((m, ci) => {
      const ref = m[j] > 0.5, got = bi === ci
      if (ref) area[ci]++
      if (ref && got) inter[ci]++
      if (ref || got) union[ci]++
    })
  }
  const parCouleur = inter.map((v, i) => (union[i] ? v / union[i] : 1))
  const tot = area.reduce((s, v) => s + v, 0) || 1
  const score = parCouleur.reduce((s, v, i) => s + v * area[i], 0) / tot
  return { score, statut: score >= 0.8 ? 'ok' : score >= 0.65 ? 'a_verifier' : 'rejet', parCouleur }
}

/* ============================== E/S navigateur ============================== */

export async function fileToImg(file: Blob, opts?: { svgWidth?: number; maxSide?: number }): Promise<Img> {
  const isSvg = (file as File).type === 'image/svg+xml' || /\.svg$/i.test((file as File).name ?? '')
  let source: CanvasImageSource, w: number, h: number
  if (isSvg) {
    const url = URL.createObjectURL(file)
    const el = new Image()
    await new Promise((res, rej) => { el.onload = res; el.onerror = () => rej(new Error('SVG illisible')); el.src = url })
    const target = opts?.svgWidth ?? 2000
    w = target; h = Math.round(target * ((el.naturalHeight || 1) / (el.naturalWidth || 1)))
    source = el
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } else {
    const bmp = await createImageBitmap(file)
    source = bmp; w = bmp.width; h = bmp.height
  }
  const k = opts?.maxSide ? Math.min(1, opts.maxSide / Math.max(w, h)) : 1
  const c = document.createElement('canvas')
  c.width = Math.round(w * k); c.height = Math.round(h * k)
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, c.width, c.height)
  return { w: c.width, h: c.height, d: ctx.getImageData(0, 0, c.width, c.height).data }
}

export function imgToCanvas(im: Img): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = im.w; c.height = im.h
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(im.d), im.w, im.h), 0, 0)
  return c
}

/** Recadre puis redimensionne (lissage haute qualité ≈ Lanczos). */
export function cropResize(im: Img, box: Box, W: number, H: number): Img {
  const src = imgToCanvas(im)
  const c = document.createElement('canvas'); c.width = W; c.height = H
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, W, H)
  return { w: W, h: H, d: ctx.getImageData(0, 0, W, H).data }
}

export const canvasBlob = (c: HTMLCanvasElement, type = 'image/png', q?: number) =>
  new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encodage impossible'))), type, q))
