'use client'
/**
 * Onglet 🎁 Brief + instructions — ZIP (images) + fichier d'instructions JSON (prompts, rôle de chaque image, formats).
 * Deux formats : le 1er est généré et validé, puis le 2e est décliné À PARTIR du visuel validé (envoyé en IMAGE 1).
 * Retouche : consigne libre appliquée à la version affichée. Génération via /api/studio/free (mode brut).
 */
import { useEffect, useRef, useState } from 'react'
import JSZip from 'jszip'
import { upload } from '@vercel/blob/client'
import Dropzone from '@/components/ui/Dropzone'
import { compressImage } from '@/lib/compressImage'
import { openPackZip, parseInstructions, toWebImage, type PackInstructions, type PackItem, type PackZip } from '@/lib/notion/parsePackExport'

type Shot = { versions: string[]; current?: string; status: 'idle' | 'running' | 'error'; error?: string }
type State = { prompt: string; first: string; validated?: { format: string; url: string }; shots: Record<string, Shot>; enabled: boolean; note: string; showPrompt?: boolean }
type Mode = 'create' | 'adapt' | 'edit'

const emptyShot: Shot = { versions: [], status: 'idle' }
const safe = (s: string) => s.replace(/[\/\\:*?"<>|]/g, '_').trim() || 'visuel'

function Thumb({ load, title, version, replaced, onReplace }: { load: () => Promise<File | undefined>; title: string; version: unknown; replaced: boolean; onReplace: (f: File) => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [bad, setBad] = useState(false)
  useEffect(() => {
    let alive = true, obj: string | null = null
    setUrl(null); setBad(false)
    load().then(async f => {
      if (!f) { if (alive) setBad(true); return }
      let b: Blob = f
      try { b = await compressImage(f, { maxSide: 300, quality: 0.8, maxBytes: 100_000 }) } catch { /* brut */ }
      if (!alive) return
      obj = URL.createObjectURL(b); setUrl(obj)
    }).catch(() => { if (alive) setBad(true) })
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj) }
  }, [title, version]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <label title={`${title}\n(cliquer pour remplacer ce fichier)`} style={{ cursor: 'pointer' }}>
      {url ? <img src={url} alt="" style={{ width: 60, height: 60, objectFit: 'contain', background: '#F3F4F6', borderRadius: 6, border: replaced ? '2px solid #10B981' : '1px solid #E5E7EB', display: 'block' }} />
           : <div style={{ width: 60, height: 60, borderRadius: 6, background: bad ? '#FEE2E2' : '#F3F4F6', fontSize: 10, color: '#B91C1C', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{bad ? 'absent' : '…'}</div>}
      <input type="file" accept="image/*,.heic,.heif" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onReplace(f) }} />
    </label>
  )
}

export default function BriefTab() {
  const [zips, setZips] = useState<File[]>([])
  const [jsons, setJsons] = useState<File[]>([])
  const [zip, setZip] = useState<PackZip | null>(null)
  const [ins, setIns] = useState<PackInstructions | null>(null)
  const [states, setStates] = useState<Record<string, State>>({})
  const ref = useRef<Record<string, State>>({})
  const projectRef = useRef('')
  const [replacements, setReplacements] = useState<Record<string, File>>({})
  const replRef = useRef<Record<string, File>>({})
  const urlCache = useRef(new Map<string, Promise<string>>())
  const [quality, setQuality] = useState('2K')
  const [concurrency, setConcurrency] = useState(3)
  const [running, setRunning] = useState(false)
  const [busyZip, setBusyZip] = useState(false)
  const stopRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

  const commit = (n: Record<string, State>) => {
    ref.current = n; setStates(n)
    try {
      const keep = Object.fromEntries(Object.entries(n).map(([id, s]) => [id, { first: s.first, validated: s.validated, shots: s.shots }]))
      localStorage.setItem(`zulo-brief:${projectRef.current}`, JSON.stringify(keep))
    } catch { /* stockage indisponible ou plein : on continue sans */ }
  }
  const patch = (id: string, p: Partial<State>) => { if (ref.current[id]) commit({ ...ref.current, [id]: { ...ref.current[id], ...p } }) }
  const patchShot = (id: string, f: string, p: Partial<Shot>) => {
    const s = ref.current[id]
    if (s) patch(id, { shots: { ...s.shots, [f]: { ...(s.shots[f] ?? emptyShot), ...p } } })
  }
  const setAll = (enabled: boolean) => commit(Object.fromEntries(Object.entries(ref.current).map(([k, s]) => [k, { ...s, enabled }])))

  const busy = running || Object.values(states).some(s => Object.values(s.shots).some(x => x.status === 'running'))

  const handleZip = async (files: File[]) => {
    if (busy) { setError('Génération en cours : attends la fin avant de changer de fichier.'); return }
    setZips(files); setZip(null); setError(null); urlCache.current.clear(); replRef.current = {}; setReplacements({})
    if (!files[0]) return
    try { setZip(await openPackZip(files[0])) } catch (e: any) { setError(e?.message ?? String(e)) }
  }
  const handleJson = async (files: File[]) => {
    if (busy) { setError('Génération en cours : attends la fin avant de changer de fichier.'); return }
    setJsons(files); setIns(null); setError(null); ref.current = {}; setStates({})
    if (!files[0]) return
    try {
      const parsed = parseInstructions(await files[0].text())
      let saved: any = {}
      try { saved = JSON.parse(localStorage.getItem(`zulo-brief:${parsed.project}`) ?? '{}') ?? {} } catch { /* rien */ }
      const next: Record<string, State> = {}
      for (const it of parsed.items) {
        const s = saved[it.id]
        const shots: Record<string, Shot> = {}
        for (const f of it.formats) shots[f] = { versions: s?.shots?.[f]?.versions ?? [], current: s?.shots?.[f]?.current, status: 'idle' }
        next[it.id] = {
          prompt: it.prompt,   // le fichier d'instructions fait toujours foi
          first: it.formats.includes(s?.first) ? s.first : it.formats[0],
          validated: s?.validated && it.formats.includes(s.validated.format) ? s.validated : undefined,
          shots, enabled: true, note: '',
        }
      }
      projectRef.current = parsed.project
      ref.current = next; setStates(next); setIns(parsed)
    } catch (e: any) { setError(e?.message ?? String(e)) }
  }

  const fileFor = async (name: string) => replRef.current[name] ?? zip?.getFile(name)
  const replaceFile = async (name: string, f: File) => {
    try {
      replRef.current = { ...replRef.current, [name]: await toWebImage(f) }
      urlCache.current.delete(name); setReplacements(replRef.current)
    } catch (e: any) { setError(`Remplacement de ${name} : ${e?.message ?? e}`) }
  }
  const urlFor = (name: string) => {
    let p = urlCache.current.get(name)
    if (!p) {
      p = (async () => {
        const f = await fileFor(name)
        if (!f) throw new Error(`Fichier absent du ZIP : ${name}`)
        let file = f
        try { file = await compressImage(f, { maxSide: 2048, quality: 0.92 }) } catch { /* brut */ }
        return (await upload(`brief-inputs/${Date.now()}-${safe(file.name)}`, file, { access: 'public', handleUploadUrl: '/api/blob-upload', contentType: file.type || 'image/jpeg' })).url
      })()
      const mine = p
      p.catch(() => { if (urlCache.current.get(name) === mine) urlCache.current.delete(name) })
      urlCache.current.set(name, p)
    }
    return p
  }

  const buildPrompt = (it: PackItem, format: string, mode: Mode, note: string) => {
    const st = ref.current[it.id]
    const lines: string[] = []
    if (mode === 'adapt') lines.push(`- IMAGE 1: the APPROVED MASTER visual (format ${st.validated!.format}).`)
    if (mode === 'edit') lines.push('- IMAGE 1: the CURRENT visual to correct.')
    const offset = lines.length
    it.images.forEach((im, i) => lines.push(`- IMAGE ${i + 1 + offset}: ${im.role}`))
    // {{1}}, {{2}}… = rang dans « images », décalé quand un visuel est ajouté devant
    const framing = it.formatNotes?.[format] ? `\n\nFRAMING FOR THIS ${format} FORMAT: ${it.formatNotes[format]}` : ''
    const body = (st.prompt + framing).replace(/\{\{(\d+)\}\}/g, (_, d) => `IMAGE ${Number(d) + offset}`)
    const rules = ins?.rules ? `\n\n${ins.rules}` : ''
    const head = lines.length ? `REFERENCE IMAGES, in this order:\n${lines.join('\n')}\n\n---\n\n` : ''
    if (mode === 'adapt') return `${head}Re-frame the APPROVED MASTER (IMAGE 1) into a ${format} image. It must look like the SAME photograph from the same shoot: same products, same arrangement and props, same light, same colors, same background. Only the framing changes: extend the background naturally to fill the new format. Do not stretch, crop or duplicate the products, and do not add or remove anything. Keep product details faithful to the product references. The master overrides any conflicting composition detail below.\n\nORIGINAL BRIEF:\n${body}${rules}`
    if (mode === 'edit') return `${head}Correct IMAGE 1. Apply ONLY this correction and keep everything else strictly identical (framing, light, colors, products, background):\n${note}\n\nFor context, the original brief of this visual (the correction takes priority over it):\n${body}${rules}`
    return `${head}${body}${rules}`
  }

  const modeFor = (id: string, format: string): Mode => { const v = ref.current[id]?.validated; return v && v.format !== format ? 'adapt' : 'create' }
  /** Le 2e format reste verrouillé tant que le premier n'est pas validé. */
  const locked = (id: string, format: string) => { const s = states[id]; return !!s && !s.validated && format !== s.first }

  const generate = async (it: PackItem, format: string, mode: Mode) => {
    const st = ref.current[it.id]
    const shot = st.shots[format] ?? emptyShot
    if (shot.status === 'running') return
    const before = mode === 'adapt' ? [st.validated!.url] : mode === 'edit' ? [shot.current!] : []
    const prompt = buildPrompt(it, format, mode, st.note.trim())
    patchShot(it.id, format, { status: 'running', error: undefined })
    try {
      const refUrls = [...before, ...(await Promise.all(it.images.map(im => urlFor(im.file))))]
      const res = await fetch('/api/studio/free', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, ratio: format, quality, refUrls }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.imageUrl) throw new Error(j.error || `HTTP ${res.status}`)
      if (!/^https?:/.test(j.imageUrl)) throw new Error(`Image générée mais non enregistrée sur Blob : ${j.blobError ?? 'stockage indisponible'}`)
      patchShot(it.id, format, { status: 'idle', versions: [...(ref.current[it.id]?.shots[format]?.versions ?? []), j.imageUrl], current: j.imageUrl })
    } catch (e: any) { patchShot(it.id, format, { status: 'error', error: e?.message ?? String(e) }) }
  }

  const todo = (ins?.items ?? []).flatMap(it => {
    const s = states[it.id]
    if (!s?.enabled) return []
    return it.formats.filter(f => !locked(it.id, f) && !s.shots[f]?.versions.length && s.shots[f]?.status !== 'running').map(f => ({ it, f }))
  })
  const run = async () => {
    const list = todo
    stopRef.current = false; setRunning(true); setError(null)
    let c = 0
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (c < list.length && !stopRef.current) { const { it, f } = list[c++]; await generate(it, f, modeFor(it.id, f)) }
    }))
    setRunning(false)
  }

  const finals = (ins?.items ?? []).flatMap(it => it.formats.map(f => ({ it, f, url: states[it.id]?.shots[f]?.current })).filter(x => !!x.url))
  const downloadZip = async () => {
    setBusyZip(true); setError(null)
    try {
      const z = new JSZip()
      for (const { it, f, url } of finals) {
        const r = await fetch(url!)
        if (!r.ok) throw new Error(`${it.sku} ${f} : HTTP ${r.status}`)
        z.file(`${safe(it.sku)}/${safe(it.sku)}_${f.replace(':', 'x')}.jpg`, await r.blob())
      }
      const u = URL.createObjectURL(await z.generateAsync({ type: 'blob', compression: 'STORE' }))
      const a = document.createElement('a'); a.href = u; a.download = `${safe(ins!.project)}.zip`; a.click()
      setTimeout(() => URL.revokeObjectURL(u), 2000)
    } catch (e: any) { setError(`ZIP : ${e?.message ?? e}`) } finally { setBusyZip(false) }
  }

  const missing = ins && zip ? [...new Set(ins.items.flatMap(i => i.images.map(x => x.file)))].filter(f => !zip.has(f) && !replacements[f]) : []
  const ready = !!ins && !!zip
  const cost = (n: number) => (n * (quality === '4K' ? 0.24 : 0.134)).toFixed(2)

  const card: React.CSSProperties = { border: '1px solid #E5E7EB', borderRadius: 12, padding: 16, background: '#fff' }
  const label: React.CSSProperties = { fontSize: 12, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 6 }
  const inp: React.CSSProperties = { border: '1px solid #D1D5DB', borderRadius: 8, padding: '6px 10px', fontSize: 13, background: '#fff' }
  const btn = (bg: string, off = false, color = '#fff'): React.CSSProperties => ({ background: bg, color, border: 'none', borderRadius: 8, padding: '6px 12px', fontWeight: 600, fontSize: 13, cursor: off ? 'not-allowed' : 'pointer', opacity: off ? 0.5 : 1 })
  const grey = (off = false) => btn('#E5E7EB', off, '#374151')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <h2 style={{ margin: 0, color: '#0D4A5C', fontSize: 18 }}>🎁 Brief + instructions</h2>
        <p style={{ fontSize: 13, color: '#6B7280', margin: '6px 0 12px' }}>Le ZIP apporte les images, le fichier d&apos;instructions apporte les prompts. Avec deux formats, valide le premier : le second est décliné à partir du visuel validé.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><div style={label}>1 — ZIP du client</div><Dropzone files={zips} onChange={handleZip} accept=".zip" multiple={false} label="Glisse le ZIP" hint="Export Notion ou dossier zippé" /></div>
          <div><div style={label}>2 — Instructions (.json)</div><Dropzone files={jsons} onChange={handleJson} accept=".json" multiple={false} label="Glisse le fichier d'instructions" hint="Prompts, rôle des images, formats" /></div>
        </div>
        {missing.length > 0 && <div style={{ marginTop: 10, color: '#B91C1C', fontSize: 12 }}>⚠ Absents du ZIP : {missing.join(', ')}. Clique sur la vignette rouge pour fournir le fichier.</div>}
        {error && <div style={{ marginTop: 10, background: '#FEF2F2', color: '#991B1B', padding: 8, borderRadius: 6, fontSize: 12 }}>❌ {error}</div>}
        {ins && (
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 13 }}>{ins.project}</strong>
            <select value={quality} onChange={e => setQuality(e.target.value)} style={inp}>{['1K', '2K', '4K'].map(q => <option key={q}>{q}</option>)}</select>
            <select value={concurrency} onChange={e => setConcurrency(+e.target.value)} style={inp}>{[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} en parallèle</option>)}</select>
            <button disabled={!ready || running || !todo.length} onClick={run} style={btn('#0D4A5C', !ready || running || !todo.length)}>{running ? '⏳ Génération…' : `🚀 Générer ${todo.length} visuel${todo.length > 1 ? 's' : ''} (≈ ${cost(todo.length)} $)`}</button>
            {running && <button onClick={() => { stopRef.current = true }} style={btn('#DC2626')}>⏹ Stop</button>}
            <button disabled={busyZip || !finals.length} onClick={downloadZip} style={grey(busyZip || !finals.length)}>{busyZip ? '⏳ ZIP…' : `⬇ ZIP (${finals.length})`}</button>
            <button disabled={running} onClick={() => setAll(true)} style={grey(running)}>Tout cocher</button>
            <button disabled={running} onClick={() => setAll(false)} style={grey(running)}>Tout décocher</button>
          </div>
        )}
      </div>

      {ins && zip && ins.items.map(it => {
        const s = states[it.id]
        if (!s) return null
        const anyRunning = it.formats.some(f => s.shots[f]?.status === 'running')
        const started = anyRunning || it.formats.some(f => s.shots[f]?.versions.length)
        return (
          <div key={it.id} style={{ ...card, opacity: s.enabled ? 1 : 0.6 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 15, fontWeight: 700, color: '#0D4A5C', cursor: 'pointer' }}>
              <input type="checkbox" checked={s.enabled} disabled={running} onChange={e => patch(it.id, { enabled: e.target.checked })} />
              #{it.id} · {it.sku}
            </label>
            {it.brief && <div style={{ fontSize: 12, color: '#374151', margin: '4px 0' }}>« {it.brief} »</div>}
            {it.alerts?.map((a, i) => <div key={i} style={{ fontSize: 12, color: '#B45309' }}>⚠ {a}</div>)}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
              {it.images.map((im, i) => <Thumb key={i} title={`IMAGE ${i + 1} — ${im.file}\n${im.role}`} load={() => fileFor(im.file)} version={replacements[im.file] ?? zip} replaced={!!replacements[im.file]} onReplace={f => replaceFile(im.file, f)} />)}
            </div>
            {it.formats.length > 1 && !s.validated && (
              <div style={{ fontSize: 12, marginBottom: 8 }}>Format à valider en premier :{' '}
                <select value={s.first} disabled={started || running} onChange={e => patch(it.id, { first: e.target.value })} style={inp}>{it.formats.map(f => <option key={f}>{f}</option>)}</select>
              </div>
            )}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {it.formats.map(f => {
                const shot = s.shots[f] ?? emptyShot
                const lock = locked(it.id, f)
                const on = shot.status === 'running'
                const isMaster = s.validated?.format === f
                const adapt = !!s.validated && !isMaster
                const [w, h] = f.split(':').map(Number)
                const noEdit = !ready || on || !s.note.trim()
                return (
                  <div key={f} style={{ width: w > h ? 440 : 280, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{f} {isMaster && <span style={{ color: '#047857' }}>✓ validé</span>}</div>
                    {shot.current
                      ? <a href={shot.current} target="_blank" rel="noreferrer"><img src={shot.current} alt="" style={{ width: '100%', borderRadius: 8, display: 'block', outline: isMaster ? '3px solid #10B981' : 'none' }} /></a>
                      : <div style={{ aspectRatio: `${w}/${h}`, maxHeight: 300, border: '1px dashed #D1D5DB', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 8, fontSize: 12, color: '#9CA3AF' }}>{on ? '⏳ génération…' : lock ? `🔒 Valide d'abord le ${s.first}` : '—'}</div>}
                    {shot.versions.length > 1 && <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{shot.versions.map((v, i) => <button key={v} disabled={on} onClick={() => patchShot(it.id, f, { current: v })} style={{ ...(v === shot.current ? btn('#0D4A5C') : grey()), padding: '2px 8px', fontSize: 11 }}>v{i + 1}</button>)}</div>}
                    {isMaster && shot.current !== s.validated?.url && <div style={{ fontSize: 11, color: '#B45309' }}>La version affichée n&apos;est pas celle validée : revalide-la avant de décliner.</div>}
                    {shot.error && <div style={{ fontSize: 11, color: '#B91C1C' }}>{shot.error.slice(0, 250)}</div>}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button disabled={!ready || lock || on} onClick={() => generate(it, f, modeFor(it.id, f))} style={btn('#0D4A5C', !ready || lock || on)}>{on ? '⏳' : shot.versions.length ? '↺ Regénérer' : adapt ? '▶ Décliner' : '▶ Générer'}</button>
                      {it.formats.length > 1 && shot.current && !adapt && shot.current !== s.validated?.url &&
                        <button disabled={on} onClick={() => patch(it.id, { validated: { format: f, url: shot.current! } })} style={btn('#10B981', on)}>✓ Valider ce format</button>}
                      {isMaster && <button disabled={anyRunning || running} onClick={() => patch(it.id, { validated: undefined, first: f })} style={grey(anyRunning || running)}>Annuler la validation</button>}
                      {shot.current && <button disabled={noEdit} title="Écris d'abord la consigne ci-dessous" onClick={() => generate(it, f, 'edit')} style={grey(noEdit)}>✏️ Retoucher</button>}
                    </div>
                  </div>
                )
              })}
            </div>
            {it.formats.some(f => s.shots[f]?.current) && <input value={s.note} onChange={e => patch(it.id, { note: e.target.value })} placeholder="Consigne de retouche (ex. : guirlande plus fine, nœud plus grand)" style={{ ...inp, width: '100%', boxSizing: 'border-box', marginTop: 8 }} />}
            <button onClick={() => patch(it.id, { showPrompt: !s.showPrompt })} style={{ ...grey(), marginTop: 8, padding: '3px 10px', fontSize: 12 }}>{s.showPrompt ? 'Masquer le prompt' : 'Voir / modifier le prompt'}</button>
            {s.showPrompt && <textarea value={s.prompt} onChange={e => patch(it.id, { prompt: e.target.value })} style={{ width: '100%', minHeight: 220, marginTop: 6, fontSize: 12, border: '1px solid #D1D5DB', borderRadius: 6, padding: 8, boxSizing: 'border-box', fontFamily: 'system-ui' }} />}
          </div>
        )
      })}
    </div>
  )
}
