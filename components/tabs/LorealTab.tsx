'use client'
/**
 * Onglet 💄 L'ORÉAL — retouche de post-prod en série.
 *
 * Entrées : un Excel (colonne « Num photo » + « Remarques ») et le dossier des photos à retoucher.
 * Chaque ligne avec une remarque → la photo dont le nom finit par « Num photo » (ex. _020 → Rambouillet_020.jpg)
 * est envoyée à Gemini avec la remarque. Lignes surlignées en jaune = déjà faites (décochées).
 *
 * Format de sortie = format d'entrée, au pixel près : l'image est complétée (bords flous) jusqu'au
 * ratio Gemini le plus proche, puis la sortie est recadrée sur la zone d'origine et remise aux dimensions d'origine.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { upload } from '@vercel/blob/client'
import { readXlsx, isYellow } from '@/lib/xlsxRead'

type Status = 'pending' | 'running' | 'done' | 'error'
type Box = { x: number; y: number; w: number; h: number } // zone de la photo dans l'image envoyée (fractions)
type Item = {
  num: string
  remark: string
  yellow: boolean
  fileName?: string
  enabled: boolean
  status: Status
  imageUrl?: string      // sortie Gemini affichée
  versions: string[]
  refs: File[]           // images de référence ajoutées à la main (ex. personne à ajouter)
  error?: string
  saved?: boolean
  showPrompt?: boolean
}

const GEMINI_RATIOS: [string, number][] = [['1:1', 1], ['2:3', 2 / 3], ['3:2', 3 / 2], ['3:4', 3 / 4], ['4:3', 4 / 3], ['4:5', 4 / 5], ['5:4', 5 / 4], ['9:16', 9 / 16], ['16:9', 16 / 9], ['21:9', 21 / 9]]
const PRICE: Record<string, number> = { '2K': 0.134, '4K': 0.24 }
const MAX_SIDE = 4096

export function buildLorealPrompt(remark: string, nRefs = 0) {
  const lines = [
    `En gardant la colorimétrie de l'image, sa lumière, son contraste, son cadrage, sa composition, sa perspective, sa netteté et son grain strictement identiques, applique uniquement la retouche suivante : ${remark.trim().replace(/\s*\.$/, '')}.`,
    "Ne modifie rien d'autre : mêmes personnes (visages, expressions, peau, cheveux, vêtements), mêmes objets, mêmes machines, même décor. Les zones retouchées sont reconstruites de façon réaliste et invisible, dans la continuité des matières autour (métal, sol, murs, peinture).",
    "C'est une retouche photo professionnelle : la photo doit rester une vraie photographie, pas une image régénérée.",
  ]
  if (nRefs > 0) lines.push(`L'image 1 est la photo à retoucher. ${nRefs > 1 ? `Les images 2 à ${nRefs + 1} sont des références` : "L'image 2 est une référence"} pour la retouche demandée (par exemple la personne à ajouter) : n'en reprends que ce qui est demandé, intégré à la lumière et à la colorimétrie de l'image 1.`)
  return lines.join('\n')
}

const closestRatio = (r: number) => GEMINI_RATIOS.reduce((b, x) => (Math.abs(Math.log(r / x[1])) < Math.abs(Math.log(r / b[1])) ? x : b))

const toBlob = (c: HTMLCanvasElement, q = 0.95) => new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encodage JPEG impossible'))), 'image/jpeg', q))

/** Prépare l'image envoyée : ≤ 4096 px, complétée au ratio Gemini le plus proche si besoin. */
async function prepareInput(file: File) {
  const bmp = await createImageBitmap(file)
  const W = bmp.width, H = bmp.height
  const [ratio, R] = closestRatio(W / H)
  let CW = W, CH = H
  if (Math.abs(Math.log((W / H) / R)) > 0.005) { if (W / H < R) CW = H * R; else CH = W / R }
  const s = Math.min(1, MAX_SIDE / Math.max(CW, CH))
  const c = document.createElement('canvas')
  c.width = Math.round(CW * s); c.height = Math.round(CH * s)
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  const box: Box = { x: (CW - W) / 2 / CW, y: (CH - H) / 2 / CH, w: W / CW, h: H / CH }
  if (CW !== W || CH !== H) { // bords : la photo étirée et floutée
    ctx.filter = 'blur(40px)'; ctx.drawImage(bmp, 0, 0, c.width, c.height); ctx.filter = 'none'
  }
  ctx.drawImage(bmp, box.x * c.width, box.y * c.height, box.w * c.width, box.h * c.height)
  bmp.close()
  return { blob: await toBlob(c), ratio, box, W, H }
}

/** Sortie Gemini → zone d'origine recadrée, aux dimensions exactes de la photo d'entrée. */
async function finalizeOutput(url: string, box: Box, W: number, H: number) {
  const bmp = await createImageBitmap(await fetch(url).then(r => r.blob()))
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bmp, box.x * bmp.width, box.y * bmp.height, box.w * bmp.width, box.h * bmp.height, 0, 0, W, H)
  bmp.close()
  return toBlob(c)
}

function Thumb({ file }: { file: File }) {
  const [url, setUrl] = useState('')
  useEffect(() => { const u = URL.createObjectURL(file); setUrl(u); return () => URL.revokeObjectURL(u) }, [file])
  return url ? <img src={url} alt="" loading="lazy" decoding="async" style={{ width: '100%', borderRadius: 6, background: '#F3F4F6' }} /> : <div style={{ aspectRatio: '4/3', background: '#F3F4F6', borderRadius: 6 }} />
}

export default function LorealTab() {
  const [xlsName, setXlsName] = useState('')
  const [rowsInfo, setRowsInfo] = useState('')
  const [items, setItems] = useState<Item[]>([])
  const itemsRef = useRef<Item[]>([])
  const filesRef = useRef(new Map<string, File>())   // nom de fichier → File
  const [dirIn, setDirIn] = useState('')
  const dirInRef = useRef<any>(null)
  const dirOutRef = useRef<any>(null)
  const [dirOut, setDirOut] = useState('')
  const [quality, setQuality] = useState('4K')
  const [concurrency, setConcurrency] = useState(2)
  const [running, setRunning] = useState(false)
  const stopRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [, force] = useState(0)
  const meta = useRef(new Map<number, Promise<{ url: string; ratio: string; box: Box; W: number; H: number }>>())

  const update = (idx: number, patch: Partial<Item>) => setItems(prev => {
    const next = [...prev]; next[idx] = { ...next[idx], ...patch }; itemsRef.current = next; return next
  })
  const setList = (list: Item[]) => { itemsRef.current = list; setItems(list) }

  /** Associe chaque ligne à son fichier : nom (sans extension) qui finit par « Num photo ». */
  const match = (list: Item[]) => {
    const names = [...filesRef.current.keys()]
    return list.map(it => {
      const fileName = names.find(n => n.replace(/\.[^.]+$/, '').toLowerCase().endsWith(it.num.toLowerCase()))
      return { ...it, fileName, enabled: it.enabled && (!names.length || !!fileName) }
    })
  }

  /* ----------- Excel ----------- */
  const handleXlsx = async (f?: File) => {
    if (!f) return
    setError(null); setXlsName(f.name); meta.current = new Map()
    try {
      const sheet = await readXlsx(f)
      const header = sheet.rows.findIndex(r => r.some(c => /num\s*photo/i.test(c.value)))
      if (header < 0) throw new Error('Colonne « Num photo » introuvable.')
      const h = sheet.rows[header]
      const ci = h.findIndex(c => /num\s*photo/i.test(c.value))
      const ri = h.findIndex(c => /remarque/i.test(c.value))
      if (ri < 0) throw new Error('Colonne « Remarques » introuvable.')
      let total = 0, noRemark = 0
      const list: Item[] = []
      for (const r of sheet.rows.slice(header + 1)) {
        const num = r[ci]?.value ?? ''
        if (!num) continue
        total++
        const remark = r[ri]?.value ?? ''
        if (!remark) { noRemark++; continue }
        const yellow = isYellow(r[ci]?.fill) || isYellow(r[ri]?.fill)
        list.push({ num, remark, yellow, enabled: !yellow, status: 'pending', versions: [], refs: [] })
      }
      const y = list.filter(i => i.yellow).length
      setRowsInfo(`${total} lignes · ${noRemark} sans remarque (ignorées) · ${list.length} à retoucher dont ${y} surlignées en jaune (déjà faites, décochées)`)
      setList(match(list))
    } catch (e: any) { setError(`Excel : ${e?.message ?? e}`) }
  }

  /* ----------- Dossiers ----------- */
  const pickIn = async () => {
    try {
      // @ts-ignore
      const h = await window.showDirectoryPicker({ mode: 'read' })
      const m = new Map<string, File>()
      for await (const [name, entry] of h.entries()) {
        if (entry.kind === 'file' && /\.(jpe?g|png|webp)$/i.test(name)) m.set(name, await entry.getFile())
      }
      filesRef.current = m; dirInRef.current = h; setDirIn(`${h.name} (${m.size} photos)`); meta.current = new Map()
      setList(match(itemsRef.current.map(i => ({ ...i, enabled: !i.yellow }))))
    } catch (e: any) { if (e?.name !== 'AbortError') setError(`Dossier : ${e?.message ?? e}`) }
  }
  const pickOut = async () => {
    try {
      // @ts-ignore
      const h = await window.showDirectoryPicker({ mode: 'readwrite' })
      if (dirInRef.current && await h.isSameEntry(dirInRef.current)) { setError('Choisis un dossier de sortie différent du dossier des originaux (les fichiers gardent le même nom).'); return }
      dirOutRef.current = h; setDirOut(h.name); setError(null)
    } catch (e: any) { if (e?.name !== 'AbortError') setError(`Dossier : ${e?.message ?? e}`) }
  }

  /* ----------- Préparation + upload (une fois par photo) ----------- */
  const prepared = (idx: number) => {
    let p = meta.current.get(idx)
    if (!p) {
      const it = itemsRef.current[idx]
      const file = it.fileName ? filesRef.current.get(it.fileName) : undefined
      if (!file) return Promise.reject(new Error('photo introuvable dans le dossier'))
      p = prepareInput(file).then(async x => {
        const b = await upload(`loreal-inputs/${Date.now()}-${file.name}`, x.blob, { access: 'public', handleUploadUrl: '/api/blob-upload', contentType: 'image/jpeg' })
        return { url: b.url, ratio: x.ratio, box: x.box, W: x.W, H: x.H }
      })
      meta.current.set(idx, p)
      p.catch(() => meta.current.delete(idx))
    }
    return p
  }

  const saveVersion = async (idx: number, url: string) => {
    const it = itemsRef.current[idx]
    const m = await prepared(idx)
    const blob = await finalizeOutput(url, m.box, m.W, m.H)
    const name = it.fileName!.replace(/\.[^.]+$/, '.jpg')
    if (dirOutRef.current) {
      const fh = await dirOutRef.current.getFileHandle(name, { create: true })
      const w = await fh.createWritable(); await w.write(blob); await w.close()
      update(idx, { saved: true })
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 3000)
    }
  }

  const uploads = useRef(new WeakMap<File, Promise<string>>())
  const uploadRef = (f: File) => {
    let p = uploads.current.get(f)
    if (!p) { p = upload(`loreal-refs/${Date.now()}-${f.name}`, f, { access: 'public', handleUploadUrl: '/api/blob-upload', contentType: f.type || 'image/jpeg' }).then(b => b.url); uploads.current.set(f, p) }
    return p
  }

  /* ----------- Génération ----------- */
  const generateOne = async (idx: number) => {
    const it = itemsRef.current[idx]
    if (!it?.fileName) return update(idx, { status: 'error', error: 'photo introuvable dans le dossier' })
    update(idx, { status: 'running', error: undefined })
    try {
      const m = await prepared(idx)
      const refUrls = [m.url, ...(await Promise.all(it.refs.map(uploadRef)))]
      const resp = await fetch('/api/studio/free', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: buildLorealPrompt(it.remark, it.refs.length), refUrls, ratio: m.ratio, quality }),
      })
      const text = await resp.text()
      let json: any
      try { json = JSON.parse(text) } catch { throw new Error(`HTTP ${resp.status} : ${text.replace(/<[^>]+>/g, ' ').trim().slice(0, 160)}`) }
      if (!resp.ok || !json.imageUrl) throw new Error(json.error || `HTTP ${resp.status}`)
      const versions = [...(itemsRef.current[idx]?.versions ?? []), json.imageUrl]
      update(idx, { status: 'done', imageUrl: json.imageUrl, versions, saved: false })
      if (dirOutRef.current) await saveVersion(idx, json.imageUrl)
    } catch (e: any) {
      update(idx, { status: 'error', error: e?.message ?? String(e) })
    }
  }

  const runAll = async () => {
    const queue = itemsRef.current.map((it, i) => ({ it, i })).filter(x => x.it.enabled && x.it.fileName && x.it.status !== 'done').map(x => x.i)
    if (!queue.length) return
    setRunning(true); stopRef.current = false
    const worker = async () => { while (queue.length && !stopRef.current) await generateOne(queue.shift()!) }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
    setRunning(false)
  }

  const stats = useMemo(() => {
    const on = items.filter(i => i.enabled && i.fileName)
    const todo = on.filter(i => i.status !== 'done')
    return { on: on.length, done: items.filter(i => i.status === 'done').length, todo: todo.length, missing: items.filter(i => !i.yellow && !i.fileName).length }
  }, [items])

  const setAll = (v: boolean) => setList(itemsRef.current.map(i => ({ ...i, enabled: v && !!i.fileName && !i.yellow })))

  /* ----------- Rendu ----------- */
  const box: React.CSSProperties = { background: '#fff', borderRadius: 12, padding: 16, marginBottom: 16, border: '1px solid rgba(13,74,92,0.1)' }
  const inp: React.CSSProperties = { padding: '6px 8px', borderRadius: 6, border: '1px solid #D1D5DB', fontSize: 13 }
  const btn = (bg: string): React.CSSProperties => ({ background: bg, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' })
  const small: React.CSSProperties = { ...inp, cursor: 'pointer', background: '#fff', fontSize: 11 }

  return (
    <div style={{ maxWidth: 1200 }}>
      <h2 style={{ margin: '0 0 4px', color: '#0D4A5C' }}>💄 L&apos;ORÉAL</h2>
      <p style={{ fontSize: 13, color: '#6B7280', margin: '0 0 16px' }}>
        Retouche en série : chaque ligne de l&apos;Excel avec une <strong>Remarque</strong> → la photo dont le nom finit par le <strong>Num photo</strong> (ex. <code>_020</code> → <code>Rambouillet_020.jpg</code>) est retouchée par Gemini selon la remarque.
        Les lignes <span style={{ background: '#FEF08A', padding: '0 3px' }}>surlignées en jaune</span> sont déjà faites : décochées.
        Sortie : même nom, <strong>mêmes dimensions au pixel près</strong>, JPEG. ≈ {PRICE['4K']} $ par photo en 4K, {PRICE['2K']} $ en 2K.
      </p>

      <div style={{ ...box, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ ...btn('#0D4A5C'), display: 'inline-block' }}>
          📊 {xlsName || "Choisir l'Excel"}
          <input type="file" accept=".xlsx" style={{ display: 'none' }} onChange={e => handleXlsx(e.target.files?.[0])} />
        </label>
        <button onClick={pickIn} style={btn('#0D4A5C')} disabled={running}>🗂 {dirIn || 'Dossier des photos à retoucher'}</button>
        <button onClick={pickOut} style={btn('#6B7A8A')} disabled={running}>📁 {dirOut || 'Dossier de sortie'}</button>
        {rowsInfo && <div style={{ width: '100%', fontSize: 12, color: '#374151' }}>✓ {rowsInfo}{stats.missing > 0 && dirIn && <span style={{ color: '#92400E' }}> · {stats.missing} photo(s) introuvable(s) dans le dossier</span>}</div>}
        {error && <div style={{ width: '100%', fontSize: 13, color: '#991B1B' }}>⚠ {error}</div>}
      </div>

      {items.length > 0 && (
        <div style={{ ...box, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 2 }}>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Qualité Gemini</div>
            <select value={quality} onChange={e => setQuality(e.target.value)} style={inp} disabled={running}>
              <option value="4K">4K (recommandé, photos 6000 px)</option>
              <option value="2K">2K</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Parallèle</div>
            <select value={concurrency} onChange={e => setConcurrency(parseInt(e.target.value, 10))} style={inp} disabled={running}>
              {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <button onClick={() => setAll(true)} style={{ ...inp, cursor: 'pointer', background: '#fff' }} disabled={running}>Tout cocher (hors jaune)</button>
          <button onClick={() => setAll(false)} style={{ ...inp, cursor: 'pointer', background: '#fff' }} disabled={running}>Tout décocher</button>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 12, color: '#374151', textAlign: 'right' }}>
            {stats.done}/{stats.on} faites · reste {stats.todo} ≈ {(stats.todo * PRICE[quality]).toFixed(2)} $
            {!dirOut && <><br /><span style={{ color: '#92400E' }}>pas de dossier de sortie : téléchargement manuel</span></>}
          </div>
          {running
            ? <button onClick={() => { stopRef.current = true }} style={btn('#991B1B')}>■ Arrêter après les photos en cours</button>
            : <button onClick={runAll} style={btn('#0D4A5C')} disabled={!stats.todo || !dirIn}>▶ Retoucher {stats.todo} photo{stats.todo > 1 ? 's' : ''}</button>}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 12 }}>
        {items.map((it, idx) => {
          const file = it.fileName ? filesRef.current.get(it.fileName) : undefined
          return (
            <div key={`${it.num}-${idx}`} style={{ ...box, marginBottom: 0, opacity: it.enabled ? 1 : 0.55, background: it.yellow ? '#FEFCE8' : '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <input type="checkbox" checked={it.enabled} disabled={running || !it.fileName} onChange={e => update(idx, { enabled: e.target.checked })} />
                <strong style={{ fontSize: 14, color: '#0D4A5C' }}>{it.num}</strong>
                <span style={{ fontSize: 11, color: '#6B7280' }}>{it.fileName ?? (dirIn ? '⚠ photo introuvable' : '')}</span>
                {it.yellow && <span style={{ fontSize: 10, background: '#FEF08A', padding: '1px 5px', borderRadius: 4 }}>déjà fait</span>}
                <span style={{ marginLeft: 'auto', fontSize: 11, color: it.status === 'error' ? '#991B1B' : it.status === 'done' ? '#166534' : '#6B7280' }}>
                  {it.status === 'running' ? '⏳ en cours' : it.status === 'done' ? (it.saved ? '✓ enregistrée' : '✓') : it.status === 'error' ? '✗ erreur' : ''}
                </span>
              </div>
              <textarea value={it.remark} onChange={e => update(idx, { remark: e.target.value })} disabled={running} rows={2}
                        style={{ ...inp, width: '100%', fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }} />
              {/photo|pj|personne/i.test(it.remark) && !it.refs.length && <div style={{ fontSize: 10, color: '#92400E', marginTop: 2 }}>⚠ la remarque parle d&apos;une photo jointe : ajoute-la en référence ci-dessous</div>}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
                <div><div style={{ fontSize: 10, color: '#6B7280' }}>Avant</div>{file ? <Thumb file={file} /> : <div style={{ aspectRatio: '4/3', background: '#F3F4F6', borderRadius: 6 }} />}</div>
                <div>
                  <div style={{ fontSize: 10, color: '#6B7280' }}>Après</div>
                  {it.imageUrl
                    ? <a href={it.imageUrl} target="_blank" rel="noreferrer"><img src={it.imageUrl} alt="" style={{ width: '100%', borderRadius: 6 }} /></a>
                    : <div style={{ aspectRatio: '4/3', background: '#F3F4F6', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#9CA3AF' }}>{it.status === 'running' ? 'Gemini retouche…' : '—'}</div>}
                </div>
              </div>
              {it.error && <div style={{ fontSize: 11, color: '#991B1B', marginTop: 4 }}>{it.error}</div>}
              <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <button onClick={() => generateOne(idx)} disabled={it.status === 'running' || !it.fileName} style={small}>{it.versions.length ? '↻ Refaire' : '▶ Retoucher'}</button>
                {it.imageUrl && <button onClick={() => saveVersion(idx, it.imageUrl!).catch(e => update(idx, { error: e?.message ?? String(e) }))} style={small}>{dirOut ? '💾 Enregistrer cette version' : '⬇ Télécharger'}</button>}
                <label style={small}>
                  + Référence{it.refs.length ? ` (${it.refs.length})` : ''}
                  <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => { update(idx, { refs: [...it.refs, ...Array.from(e.target.files ?? [])] }); force(x => x + 1) }} />
                </label>
                {it.refs.length > 0 && <button onClick={() => update(idx, { refs: [] })} style={small}>✕ réf.</button>}
                <button onClick={() => update(idx, { showPrompt: !it.showPrompt })} style={small}>{it.showPrompt ? 'Masquer' : 'Voir'} le prompt</button>
              </div>
              {it.versions.length > 1 && (
                <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                  {it.versions.map((v, i) => (
                    <img key={v} src={v} alt="" onClick={() => update(idx, { imageUrl: v, saved: false })} title={`Version ${i + 1}`}
                         style={{ width: 48, height: 36, objectFit: 'cover', borderRadius: 3, cursor: 'pointer', outline: v === it.imageUrl ? '2px solid #0D4A5C' : 'none' }} />
                  ))}
                </div>
              )}
              {it.showPrompt && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 10, background: '#F9FAFB', padding: 8, borderRadius: 6, marginTop: 8 }}>{buildLorealPrompt(it.remark, it.refs.length)}</pre>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
