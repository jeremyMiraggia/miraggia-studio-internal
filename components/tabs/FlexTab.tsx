'use client'
/**
 * Onglet 🧩 FLEX — n'importe quel ZIP Notion.
 *  1) Diagnostic : tables, colonnes typées (fichiers / lien / pose / texte long / texte), problèmes.
 *  2) Consigne en français → recette (IA) → recette modifiable (menus), enregistrable.
 *  3) Aperçu gratuit des visuels (images envoyées + prompt final), puis génération en série.
 * Modèle : sélecteur Gemini / ChatGPT de la barre du Studio ; format et qualité ici.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { upload } from '@vercel/blob/client'
import Dropzone from '@/components/ui/Dropzone'
import VarInput from '@/components/ui/VarInput'
import { compressImage } from '@/lib/compressImage'
import {
  ajusterFond, construireVisuels, diagnostiquer, estFond, tailleSortie, enregistrerRecette, listerRecettes, ouvrirZipNotion, recetteVide, schemaPourIA,
  sourceLabel, sourcesPossibles, supprimerRecette, validerRecette, variablesDisponibles,
  type Audience, type CatalogMannequin, type ColType, type SaasPose, type Diagnostic, type NotionZip, type Recette, type Source, type Visuel,
} from '@/lib/flex'

type Status = 'pending' | 'running' | 'done' | 'error'
type ItemState = { enabled: boolean; off?: number[]; status: Status; imageUrl?: string; versions: string[]; error?: string; saved?: boolean; showPrompt?: boolean }

const RATIOS = ['3:4', '2:3', '4:5', '9:16', '1:1', '4:3', '3:2', '16:9']
const PRICE: Record<string, number> = { '1K': 0.134, '2K': 0.134, '4K': 0.24 } // Gemini 3 Pro Image, indicatif
const TYPE_STYLE: Record<ColType, [string, string]> = {
  fichiers: ['#DBEAFE', '#1E40AF'], lien: ['#EDE9FE', '#5B21B6'], pose: ['#FCE7F3', '#9D174D'],
  'texte long': ['#DCFCE7', '#166534'], texte: ['#F3F4F6', '#374151'], vide: ['#F9FAFB', '#9CA3AF'],
}
const TYPE_ICON: Record<ColType, string> = { fichiers: '📎', lien: '🔗', pose: '🧍', 'texte long': '📝', texte: 'Aa', vide: '∅' }
const srcKey = (s: Source) => JSON.stringify(s)

function ZipThumb({ get, label }: { get: () => Promise<string>; label: string }) {
  const [url, setUrl] = useState('')
  useEffect(() => { let ok = true; get().then(u => { if (ok) setUrl(u) }).catch(() => {}); return () => { ok = false } }, [get])
  return (
    <div style={{ textAlign: 'center' }} title={label}>
      {url ? <img src={url} alt="" loading="lazy" style={{ width: '100%', aspectRatio: '3/4', objectFit: 'cover', borderRadius: 4, background: '#F3F4F6' }} />
           : <div style={{ width: '100%', aspectRatio: '3/4', borderRadius: 4, background: '#F3F4F6' }} />}
      <div style={{ fontSize: 9, color: '#6B7280', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
    </div>
  )
}

export default function FlexTab() {
  const [zips, setZips] = useState<File[]>([])
  const zipRef = useRef<NotionZip | null>(null)
  const [diag, setDiag] = useState<Diagnostic | null>(null)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<CatalogMannequin[] | null>(null)
  const [saasPoses, setSaasPoses] = useState<SaasPose[] | null>(null)
  const [audience, setAudience] = useState<Audience>('auto')
  const [consigne, setConsigne] = useState('')
  const [interpreting, setInterpreting] = useState(false)
  const [explication, setExplication] = useState('')
  const [corrections, setCorrections] = useState<string[]>([])
  const [recette, setRecette] = useState<Recette | null>(null)
  const [saved, setSaved] = useState<Record<string, Recette>>({})
  const [saveName, setSaveName] = useState('')
  const [ratio, setRatio] = useState('3:4')
  const [quality, setQuality] = useState('2K')
  const [concurrency, setConcurrency] = useState(2)
  const [fitFond, setFitFond] = useState(true)
  const [prep, setPrep] = useState('')
  const [states, setStates] = useState<Record<string, ItemState>>({})
  const statesRef = useRef<Record<string, ItemState>>({})
  const [running, setRunning] = useState(false)
  const stopRef = useRef(false)
  const dirRef = useRef<any>(null)
  const [dirName, setDirName] = useState('')
  const [shown, setShown] = useState(40)
  const [openTables, setOpenTables] = useState<Record<string, boolean>>({})

  useEffect(() => {
    setSaved(listerRecettes())
    try { const r = localStorage.getItem('flex-ratio'); if (r) setRatio(r); const q = localStorage.getItem('flex-quality'); if (q) setQuality(q) } catch { /* */ }
    fetch('/api/studio/mannequins').then(r => r.json()).then(j => { if (Array.isArray(j.mannequins)) setCatalog(j.mannequins) }).catch(() => {})
    fetch('/api/studio/poses').then(r => r.json()).then(j => { if (Array.isArray(j.poses)) setSaasPoses(j.poses) }).catch(() => {})
  }, [])

  /* ----------- ZIP → diagnostic ----------- */
  const handleZip = async (files: File[]) => {
    setZips(files); setDiag(null); setRecette(null); setError(null); setExplication(''); setCorrections([])
    setStates({}); statesRef.current = {}; cache.current = new Map(); uploads.current = new Map()
    if (!files[0]) return
    try {
      const z = await ouvrirZipNotion(files[0], setProgress)
      zipRef.current = z
      const d = await diagnostiquer(z, setProgress)
      setDiag(d)
      setOpenTables(Object.fromEntries(d.tables.map(t => [t.name, t.name === d.mainGuess])))
      setRecette(recetteVide(d))
    } catch (e: any) { setError(e?.message ?? String(e)) } finally { setProgress('') }
  }

  /* ----------- consigne → recette ----------- */
  const interpret = async () => {
    if (!diag || !consigne.trim()) return
    setInterpreting(true); setError(null)
    try {
      const r = await fetch('/api/studio/flex-recette', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consigne, schema: schemaPourIA(diag), catalogue: !!catalog?.length }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      const v = validerRecette(j.recette, diag)
      setRecette(v.recette); setCorrections(v.corrections); setExplication(j.explication ?? '')
      setStates({}); statesRef.current = {}
    } catch (e: any) { setError(e?.message ?? String(e)) } finally { setInterpreting(false) }
  }
  const patch = (p: Partial<Recette>) => { setRecette(r => (r ? { ...r, ...p } : r)); setStates({}); statesRef.current = {} }

  /* ----------- visuels ----------- */
  const visuels: Visuel[] = useMemo(() => (diag && zipRef.current && recette ? construireVisuels(diag, zipRef.current, recette, catalog, 14, saasPoses ?? [], audience) : []), [diag, recette, catalog, saasPoses, audience])
  const st = (v: Visuel): ItemState => states[v.id] ?? { enabled: true, status: 'pending', versions: [] }
  const update = (id: string, p: Partial<ItemState>) => setStates(prev => {
    const next = { ...prev, [id]: { ...(prev[id] ?? { enabled: true, status: 'pending', versions: [] }), ...p } }
    statesRef.current = next; return next
  })

  // fichiers du ZIP : extraction + aperçu (une fois)
  const cache = useRef(new Map<string, Promise<Blob>>())
  const blobOf = (key: string) => {
    let p = cache.current.get(key)
    if (!p) { p = zipRef.current!.extract(key); cache.current.set(key, p) }
    return p
  }
  // fond ajusté au format de sortie (recadrage centré + résolution), mis en cache par format
  const fitKey = (key: string, fond?: boolean) => (fond && fitFond ? `${key}|${ratio}|${quality}` : key)
  const fitted = useRef(new Map<string, Promise<{ blob: Blob; from: string; to: string; crop: boolean }>>())
  const sourceBlob = (key: string, fond?: boolean) => {
    if (!(fond && fitFond)) return blobOf(key)
    const k = fitKey(key, fond)
    let p = fitted.current.get(k)
    if (!p) { p = blobOf(key).then(b => ajusterFond(b, ratio, quality)); fitted.current.set(k, p); p.catch(() => fitted.current.delete(k)) }
    return p.then(x => x.blob)
  }
  const thumbs = useRef(new Map<string, Promise<string>>())
  const thumbOf = (key: string, fond?: boolean) => {
    const k = fitKey(key, fond)
    let p = thumbs.current.get(k)
    if (!p) { p = sourceBlob(key, fond).then(b => URL.createObjectURL(b)); thumbs.current.set(k, p) }
    return p
  }
  const uploads = useRef(new Map<string, Promise<string>>())
  const urlOf = (key: string, fond?: boolean) => {
    const k = fitKey(key, fond)
    let p = uploads.current.get(k)
    if (!p) {
      p = (async () => {
        const name = key.slice(key.lastIndexOf('/') + 1)
        const adjusted = !!(fond && fitFond)
        let f = new File([await sourceBlob(key, fond)], adjusted ? name.replace(/\.[^.]+$/, '') + `_${ratio.replace(':', 'x')}_${quality}.jpg` : name,
                         { type: adjusted ? 'image/jpeg' : /png$/i.test(name) ? 'image/png' : /webp$/i.test(name) ? 'image/webp' : 'image/jpeg' })
        // très grosses images : réduites à 3072 px (au-delà, le modèle les réduit de toute façon)
        if (!adjusted && f.size > 8_000_000) { try { f = await compressImage(f, { maxSide: 3072, quality: 0.92, maxBytes: 8_000_000 }) } catch { /* */ } }
        const b = await upload(`flex-inputs/${Date.now()}-${f.name}`, f, { access: 'public', handleUploadUrl: '/api/blob-upload', contentType: f.type || 'image/jpeg' })
        return b.url
      })()
      uploads.current.set(k, p)
      p.catch(() => uploads.current.delete(k))
    }
    return p
  }

  /* ----------- sortie ----------- */
  const pickDir = async () => {
    try {
      // @ts-ignore
      const h = await window.showDirectoryPicker({ mode: 'readwrite' }); dirRef.current = h; setDirName(h.name)
    } catch (e: any) { if (e?.name !== 'AbortError') setError(`Dossier : ${e?.message ?? e}`) }
  }
  const saveToDir = async (url: string, name: string) => {
    if (!dirRef.current) return false
    try { const b = await fetch(url).then(r => r.blob()); const fh = await dirRef.current.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(b); await w.close(); return true } catch { return false }
  }
  const download = async (url: string, name: string) => {
    const b = await fetch(url).then(r => r.blob()); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }

  const offOf = (v: Visuel) => statesRef.current[v.id]?.off ?? states[v.id]?.off ?? v.defaultOff
  const selected = (v: Visuel) => { const off = offOf(v); return v.images.filter((_, i) => !off.includes(i)) }
  const toggleImage = (v: Visuel, i: number) => {
    const off = offOf(v)
    update(v.id, { off: off.includes(i) ? off.filter(x => x !== i) : [...off, i] })
  }
  const generateOne = async (v: Visuel) => {
    const sel = selected(v)
    if (!sel.length) return update(v.id, { status: 'error', error: 'aucune image cochée' })
    update(v.id, { status: 'running', error: undefined })
    try {
      const refUrls = await Promise.all(sel.map(im => (im.url ? Promise.resolve(im.url) : urlOf(im.zipKey!, im.fond))))
      const resp = await fetch('/api/studio/free', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: v.promptFor(sel), refUrls, ratio, quality }),
      })
      const text = await resp.text()
      let j: any
      try { j = JSON.parse(text) } catch { throw new Error(`HTTP ${resp.status} : ${text.replace(/<[^>]+>/g, ' ').trim().slice(0, 160)}`) }
      if (!resp.ok || !j.imageUrl) throw new Error(j.error || `HTTP ${resp.status}`)
      const versions = [...(statesRef.current[v.id]?.versions ?? []), j.imageUrl]
      update(v.id, { status: 'done', imageUrl: j.imageUrl, versions, saved: false })
      const name = versions.length > 1 ? v.fileName.replace(/\.jpg$/, `_v${versions.length}.jpg`) : v.fileName
      if (dirRef.current && await saveToDir(j.imageUrl, name)) update(v.id, { saved: true })
    } catch (e: any) { update(v.id, { status: 'error', error: e?.message ?? String(e) }) }
  }
  const runAll = async () => {
    const queue = visuels.filter(v => st(v).enabled && st(v).status !== 'done')
    if (!queue.length) return
    setRunning(true); stopRef.current = false
    // 1) préparation des fonds : recadrés au format de sortie et envoyés une seule fois
    if (fitFond) {
      const fonds = [...new Set(queue.flatMap(v => selected(v).filter(im => im.fond && im.zipKey).map(im => im.zipKey!)))]
      for (let i = 0; i < fonds.length && !stopRef.current; i++) {
        setPrep(`Préparation des fonds ${i + 1}/${fonds.length} : recadrage ${ratio} et mise en ${quality}…`)
        try { await urlOf(fonds[i], true) } catch (e: any) { setError(`Fond ${fonds[i].slice(fonds[i].lastIndexOf('/') + 1)} : ${e?.message ?? e}`) }
      }
      setPrep('')
    }
    // 2) génération
    const worker = async () => { while (queue.length && !stopRef.current) await generateOne(queue.shift()!) }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
    setRunning(false)
  }
  const setAll = (on: boolean) => { const next = { ...statesRef.current }; for (const v of visuels) next[v.id] = { ...(next[v.id] ?? { status: 'pending', versions: [] }), enabled: on } as ItemState; statesRef.current = next; setStates(next) }
  const stats = useMemo(() => {
    const on = visuels.filter(v => (states[v.id]?.enabled ?? true))
    const todo = on.filter(v => states[v.id]?.status !== 'done')
    return { on: on.length, todo: todo.length, done: visuels.filter(v => states[v.id]?.status === 'done').length, warn: visuels.filter(v => v.warnings.length).length }
  }, [visuels, states])

  /* ----------- rendu ----------- */
  const box: React.CSSProperties = { background: '#fff', borderRadius: 12, padding: 16, marginBottom: 16, border: '1px solid rgba(13,74,92,0.1)' }
  const inp: React.CSSProperties = { padding: '6px 8px', borderRadius: 6, border: '1px solid #D1D5DB', fontSize: 13 }
  const btn = (bg: string): React.CSSProperties => ({ background: bg, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' })
  const small: React.CSSProperties = { ...inp, cursor: 'pointer', background: '#fff', fontSize: 11 }
  const h3: React.CSSProperties = { margin: '0 0 8px', fontSize: 15, color: '#0D4A5C' }
  const mainTable = diag?.tables.find(t => t.name === recette?.table)
  const imgSources = diag && recette ? sourcesPossibles(diag, recette.table, 'image') : []
  const txtSources = diag && recette ? sourcesPossibles(diag, recette.table, 'texte') : []
  const vars = diag && recette ? variablesDisponibles(diag, recette.table) : []
  // consigne : toutes les colonnes de toutes les tables (insérées telles quelles)
  const colonnes = useMemo(() => {
    if (!diag) return []
    const seen = new Set<string>(), out: { name: string; hint: string }[] = []
    for (const t of diag.tables) for (const c of t.columns) {
      if (c.type === 'vide' || seen.has(c.name)) continue
      seen.add(c.name)
      out.push({ name: c.name, hint: `${t.name} · ${TYPE_ICON[c.type]} ${c.type}${c.link ? ` → ${c.link}` : ''}` })
    }
    return out
  }, [diag])

  return (
    <div style={{ maxWidth: 1200 }}>
      <h2 style={{ margin: '0 0 4px', color: '#0D4A5C' }}>🧩 FLEX</h2>
      <p style={{ fontSize: 13, color: '#6B7280', margin: '0 0 16px' }}>
        N&apos;importe quel ZIP Notion : Zulo te montre ce qu&apos;il lit (tables, colonnes, fichiers), tu écris ta consigne
        (« prends les visuels de la colonne X, le mannequin de la colonne Y, une image par pose… »), il la traduit en <strong>recette</strong> modifiable,
        tu vérifies l&apos;aperçu (gratuit) puis tu génères. Une ligne = 1 visuel par pose remplie (ou 1 si pas de pose).
      </p>

      {/* 1. ZIP */}
      <div style={box}>
        <Dropzone files={zips} onChange={handleZip} accept=".zip" multiple={false} label="Glisse l'export Notion (ZIP)" hint="Export « Markdown & CSV », avec les sous-dossiers d'images" />
        {progress && <div style={{ marginTop: 8, fontSize: 13, color: '#0D4A5C' }}>⏳ {progress}</div>}
        {error && <div style={{ marginTop: 8, fontSize: 13, color: '#991B1B' }}>⚠ {error}</div>}
      </div>

      {/* 2. Diagnostic */}
      {diag && (
        <div style={box}>
          <h3 style={h3}>Ce que Zulo lit dans le ZIP</h3>
          <div style={{ fontSize: 12, color: '#374151', marginBottom: 8 }}>
            {diag.tables.length} tableau(x) · {diag.imageCount} image(s){diag.otherFiles ? ` · ${diag.otherFiles} autre(s) fichier(s)` : ''}
            {catalog ? ` · catalogue Miraggia : ${catalog.length} mannequins` : ''}{saasPoses ? ` · ${saasPoses.length} poses du SaaS` : ' · poses du SaaS indisponibles'}
          </div>
          {diag.tables.map(t => (
            <div key={t.name} style={{ border: '1px solid #E5E7EB', borderRadius: 8, marginBottom: 8 }}>
              <div onClick={() => setOpenTables(o => ({ ...o, [t.name]: !o[t.name] }))} style={{ padding: '8px 10px', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center', background: '#F9FAFB', borderRadius: 8 }}>
                <span>{openTables[t.name] ? '▾' : '▸'}</span>
                <strong style={{ fontSize: 13 }}>{t.name}</strong>
                <span style={{ fontSize: 12, color: '#6B7280' }}>{t.rows.length} ligne(s) · {t.columns.length} colonne(s)</span>
                {t.name === recette?.table && <span style={{ fontSize: 10, background: '#0D4A5C', color: '#fff', borderRadius: 4, padding: '1px 6px' }}>table principale</span>}
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  {(['fichiers', 'lien', 'pose', 'texte long'] as ColType[]).map(ty => { const n = t.columns.filter(c => c.type === ty).length; return n ? <span key={ty} style={{ fontSize: 10, background: TYPE_STYLE[ty][0], color: TYPE_STYLE[ty][1], borderRadius: 4, padding: '1px 5px' }}>{TYPE_ICON[ty]} {n}</span> : null })}
                </span>
              </div>
              {openTables[t.name] && (
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <tbody>
                    {t.columns.map(c => (
                      <tr key={c.name} style={{ borderTop: '1px solid #F3F4F6', opacity: c.type === 'vide' ? 0.5 : 1 }}>
                        <td style={{ padding: '4px 10px', fontWeight: 600, whiteSpace: 'nowrap' }}>{c.name}{c.name === t.titleColumn && <span style={{ color: '#9CA3AF', fontWeight: 400 }}> (titre)</span>}</td>
                        <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}><span style={{ background: TYPE_STYLE[c.type][0], color: TYPE_STYLE[c.type][1], borderRadius: 4, padding: '1px 6px' }}>{TYPE_ICON[c.type]} {c.type}</span></td>
                        <td style={{ padding: '4px 6px', color: '#6B7280', whiteSpace: 'nowrap' }}>{c.filled}/{t.rows.length}</td>
                        <td style={{ padding: '4px 6px', color: '#374151' }}>
                          {c.files && <span>{c.files.found} image(s) trouvée(s){c.files.missing ? <span style={{ color: '#991B1B' }}> · {c.files.missing} manquante(s)</span> : ''} · </span>}
                          {c.type === 'lien' && <span>→ {c.link ? <strong>{c.link}</strong> : <span style={{ color: '#991B1B' }}>table absente</span>}{c.link ? ` (${c.linkHits} trouvée(s))` : ''} · </span>}
                          <span style={{ color: '#9CA3AF' }}>{c.samples.join(' | ')}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
          {diag.problems.length > 0 && (
            <div style={{ fontSize: 12, color: '#92400E', background: '#FFFBEB', borderRadius: 6, padding: 8 }}>
              {diag.problems.map((p, i) => <div key={i}>⚠ {p}</div>)}
            </div>
          )}
        </div>
      )}

      {/* 3. Consigne + recette */}
      {diag && recette && (
        <div style={box}>
          <h3 style={h3}>Consigne</h3>
          <VarInput value={consigne} onChange={setConsigne} vars={colonnes} multiline rows={3} format={n => n} title="Colonnes du ZIP"
                    style={{ ...inp, resize: 'vertical' }}
                    placeholder="Ex. : Habille le mannequin (@FACE PHOTO et @FRONT-model) avec les images de @FILES (FRONT), fond = @Fond, une image par @Vue et Pose 1… — tape @ pour la liste des colonnes" />
          <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 2 }}>Tape <code>@</code> pour insérer le nom exact d&apos;une colonne (toutes les tables du ZIP).</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button onClick={interpret} disabled={interpreting || !consigne.trim()} style={btn('#0D4A5C')}>{interpreting ? '⏳ Interprétation…' : '✨ Traduire en recette'}</button>
            <select value="" onChange={e => { const r = saved[e.target.value]; if (r && diag) { const v = validerRecette(r, diag); setRecette(v.recette); setCorrections(v.corrections); setExplication(`Recette « ${e.target.value} » chargée.`); setStates({}); statesRef.current = {} } }} style={inp}>
              <option value="">📂 Charger une recette…</option>
              {Object.keys(saved).map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            <input value={saveName} onChange={e => setSaveName(e.target.value)} placeholder="Nom de la recette" style={{ ...inp, width: 160 }} />
            <button onClick={() => { if (saveName.trim()) { enregistrerRecette(saveName.trim(), recette); setSaved(listerRecettes()) } }} disabled={!saveName.trim()} style={small}>💾 Enregistrer</button>
            {saveName && saved[saveName] && <button onClick={() => { supprimerRecette(saveName); setSaved(listerRecettes()) }} style={small}>🗑 Supprimer</button>}
          </div>
          {explication && <div style={{ marginTop: 8, fontSize: 12, color: '#0D4A5C', background: '#E8F2F5', borderRadius: 6, padding: 8 }}>{explication}</div>}
          {corrections.length > 0 && <div style={{ marginTop: 6, fontSize: 11, color: '#92400E' }}>{corrections.map((c, i) => <div key={i}>⚠ {c}</div>)}</div>}

          <h3 style={{ ...h3, marginTop: 16 }}>Recette <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 400 }}>(modifiable)</span></h3>
          <div style={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: '8px 12px', fontSize: 13, alignItems: 'start' }}>
            <div style={{ color: '#6B7280', paddingTop: 6 }}>Table principale</div>
            <select value={recette.table} onChange={e => { const d = recetteVide({ ...diag, mainGuess: e.target.value }); setRecette(d); setStates({}); statesRef.current = {} }} style={{ ...inp, maxWidth: 360 }}>
              {diag.tables.map(t => <option key={t.name} value={t.name}>{t.name} ({t.rows.length} lignes)</option>)}
            </select>

            <div style={{ color: '#6B7280', paddingTop: 2 }}>Un visuel par pose</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {mainTable?.columns.filter(c => c.type !== 'fichiers' && c.type !== 'vide').map(c => (
                <label key={c.name} style={{ fontSize: 12, opacity: c.type === 'pose' ? 1 : 0.7 }}>
                  <input type="checkbox" checked={recette.poseColumns.includes(c.name)} onChange={e => patch({ poseColumns: e.target.checked ? [...recette.poseColumns, c.name] : recette.poseColumns.filter(x => x !== c.name) })} /> {c.name}
                </label>
              ))}
              {!recette.poseColumns.length && <span style={{ fontSize: 11, color: '#6B7280' }}>(aucune : 1 visuel par ligne)</span>}
              <label style={{ fontSize: 12, marginLeft: 'auto' }} title="Quand une pose existe en version adulte et enfant dans le SaaS">Poses du SaaS :{' '}
                <select value={audience} onChange={e => setAudience(e.target.value as Audience)} style={{ ...inp, fontSize: 12, padding: '2px 4px' }}>
                  <option value="auto">auto (adulte si les deux existent)</option><option value="adulte">adulte</option><option value="enfant">enfant</option>
                </select></label>
            </div>

            <div style={{ color: '#6B7280', paddingTop: 6 }}>Images envoyées<br /><span style={{ fontSize: 10 }}>dans cet ordre</span></div>
            <div>
              {recette.images.map((im, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, color: '#6B7280', width: 16 }}>{i + 1}.</span>
                  <input value={im.role} onChange={e => patch({ images: recette.images.map((x, k) => (k === i ? { ...x, role: e.target.value } : x)) })} placeholder="rôle (ex. the garment to wear)" style={{ ...inp, width: 230, fontSize: 12 }} />
                  <select value={srcKey(im.source)} onChange={e => patch({ images: recette.images.map((x, k) => (k === i ? { ...x, source: JSON.parse(e.target.value) } : x)) })} style={{ ...inp, fontSize: 12, maxWidth: 330 }}>
                    {imgSources.map(s => <option key={srcKey(s)} value={srcKey(s)}>{sourceLabel(s)}</option>)}
                  </select>
                  <label style={{ fontSize: 11 }} title="Fond : recadré au format de sortie avant l'envoi"><input type="checkbox" checked={estFond(im)} onChange={e => patch({ images: recette.images.map((x, k) => (k === i ? { ...x, fond: e.target.checked } : x)) })} /> 🏞 fond</label>
                  <button onClick={() => i > 0 && patch({ images: recette.images.map((x, k) => (k === i - 1 ? recette.images[i] : k === i ? recette.images[i - 1] : x)) })} style={small} title="Monter">↑</button>
                  <button onClick={() => patch({ images: recette.images.filter((_, k) => k !== i) })} style={small}>✕</button>
                </div>
              ))}
              {imgSources.length > 0
                ? <button onClick={() => patch({ images: [...recette.images, { role: 'reference', source: imgSources[0], max: 10 }] })} style={small}>+ Image</button>
                : <span style={{ fontSize: 11, color: '#991B1B' }}>Aucune colonne de fichiers dans cette table (ni via ses liens).</span>}
            </div>

            <div style={{ color: '#6B7280', paddingTop: 6 }}>Textes ajoutés au prompt</div>
            <div>
              {recette.texts.map((tx, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input value={tx.label} onChange={e => patch({ texts: recette.texts.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)) })} style={{ ...inp, width: 180, fontSize: 12 }} />
                  <select value={srcKey(tx.source)} onChange={e => patch({ texts: recette.texts.map((x, k) => (k === i ? { ...x, source: JSON.parse(e.target.value) } : x)) })} style={{ ...inp, fontSize: 12, maxWidth: 330 }}>
                    {txtSources.map(s => <option key={srcKey(s)} value={srcKey(s)}>{sourceLabel(s)}</option>)}
                  </select>
                  <button onClick={() => patch({ texts: recette.texts.filter((_, k) => k !== i) })} style={small}>✕</button>
                </div>
              ))}
              {txtSources.length > 0 && <button onClick={() => patch({ texts: [...recette.texts, { label: (txtSources[0] as any).column, source: txtSources[0] }] })} style={small}>+ Texte</button>}
            </div>

            <div style={{ color: '#6B7280', paddingTop: 6 }}>Prompt artistique</div>
            <div>
              <VarInput value={recette.prompt} onChange={v => patch({ prompt: v })} vars={vars} multiline rows={4}
                        style={{ ...inp, fontSize: 12, resize: 'vertical' }}
                        placeholder="Professional e-commerce fashion photograph… — tape @ pour insérer une variable" />
              <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 2 }}>Tape <code>@</code> pour la liste des variables. La pose du visuel est ajoutée automatiquement : inutile d&apos;écrire {'{Vue et Pose 1}'}.</div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                {vars.map(x => x.name).map(v => (
                  <button key={v} onClick={() => patch({ prompt: `${recette.prompt}${recette.prompt && !recette.prompt.endsWith(' ') ? ' ' : ''}{${v}}` })} style={{ ...small, fontSize: 10, padding: '1px 6px' }}>{`{${v}}`}</button>
                ))}
              </div>
            </div>

            <div style={{ color: '#6B7280', paddingTop: 6 }}>Nom des fichiers</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ width: 260 }}><VarInput value={recette.fileName} onChange={v => patch({ fileName: v })} vars={vars} style={{ ...inp, fontSize: 12 }} placeholder="{SKU}_{n} — tape @" /></div>
              <label style={{ fontSize: 12 }}><input type="checkbox" checked={recette.skipEmpty} onChange={e => patch({ skipEmpty: e.target.checked })} /> ignorer les lignes sans image</label>
            </div>
          </div>
        </div>
      )}

      {/* 4. Aperçu + génération */}
      {recette && diag && (
        <>
          <div style={{ ...box, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 2 }}>
            <div><div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Format</div>
              <select value={ratio} onChange={e => { setRatio(e.target.value); try { localStorage.setItem('flex-ratio', e.target.value) } catch { /* */ } }} style={inp} disabled={running}>{RATIOS.map(r => <option key={r}>{r}</option>)}</select></div>
            <div><div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Qualité</div>
              <select value={quality} onChange={e => { setQuality(e.target.value); try { localStorage.setItem('flex-quality', e.target.value) } catch { /* */ } }} style={inp} disabled={running}>{['1K', '2K', '4K'].map(q => <option key={q}>{q}</option>)}</select></div>
            <div><div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Parallèle</div>
              <select value={concurrency} onChange={e => setConcurrency(Number(e.target.value))} style={inp} disabled={running}>{[1, 2, 3, 4].map(n => <option key={n}>{n}</option>)}</select></div>
            <label style={{ fontSize: 12, maxWidth: 200 }} title="Avant la génération, chaque image marquée « fond » est recadrée au centre au format choisi et mise à la résolution de sortie : le modèle la reprend telle quelle.">
              <input type="checkbox" checked={fitFond} onChange={e => setFitFond(e.target.checked)} disabled={running} /> Ajuster les fonds au format ({(() => { const t = tailleSortie(ratio, quality); return `${t.w}×${t.h}` })()})
            </label>
            <button onClick={pickDir} style={btn('#6B7A8A')} disabled={running}>📁 {dirName || 'Dossier de sortie'}</button>
            <button onClick={() => setAll(true)} style={{ ...inp, cursor: 'pointer', background: '#fff' }} disabled={running}>Tout cocher</button>
            <button onClick={() => setAll(false)} style={{ ...inp, cursor: 'pointer', background: '#fff' }} disabled={running}>Tout décocher</button>
            <div style={{ flex: 1 }} />
            <div style={{ fontSize: 12, color: '#374151', textAlign: 'right' }}>
              {visuels.length} visuel(s) · {stats.done}/{stats.on} faits{stats.warn ? <span style={{ color: '#92400E' }}> · {stats.warn} avec ⚠</span> : ''}<br />
              <span style={{ color: '#6B7280' }}>reste {stats.todo} ≈ {(stats.todo * (PRICE[quality] ?? 0.134)).toFixed(2)} $ (tarif Gemini)</span>
            </div>
            {running
              ? <button onClick={() => { stopRef.current = true }} style={btn('#991B1B')}>■ Arrêter</button>
              : <button onClick={runAll} style={btn('#0D4A5C')} disabled={!stats.todo || !recette.images.length}>▶ Générer {stats.todo}</button>}
          </div>
          {prep && <div style={{ ...box, fontSize: 13, color: '#0D4A5C', background: '#E8F2F5' }}>⏳ {prep}</div>}
          {!recette.images.length && <div style={{ ...box, fontSize: 13, color: '#92400E' }}>Ajoute au moins une image à la recette (ou écris une consigne) pour voir les visuels.</div>}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
            {visuels.slice(0, shown).map(v => {
              const s = st(v)
              return (
                <div key={v.id} style={{ ...box, marginBottom: 0, opacity: s.enabled ? 1 : 0.55 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <input type="checkbox" checked={s.enabled} disabled={running} onChange={e => update(v.id, { enabled: e.target.checked })} />
                    <strong style={{ fontSize: 13, color: '#0D4A5C' }}>{v.title}</strong>
                    {v.pose && <span style={{ fontSize: 11, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }} title={v.pose}>🧍 {v.pose}</span>}
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: s.status === 'error' ? '#991B1B' : s.status === 'done' ? '#166534' : '#6B7280' }}>
                      {s.status === 'running' ? '⏳ en cours' : s.status === 'done' ? (s.saved ? '✓ enregistré' : '✓') : s.status === 'error' ? '✗ erreur' : ''}
                    </span>
                  </div>
                  {v.warnings.length > 0 && <div style={{ fontSize: 10, color: '#92400E', marginBottom: 6 }}>⚠ {v.warnings.join(' · ')}</div>}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, alignContent: 'start' }}>
                      <div style={{ gridColumn: '1 / -1', fontSize: 10, color: '#6B7280' }}>{v.images.length - (s.off ?? v.defaultOff).length}/{v.images.length} image(s) envoyée(s) — clic = exclure / remettre</div>
                      {v.images.map((im, i) => {
                        const off = (s.off ?? v.defaultOff).includes(i)
                        return (
                          <div key={i} onClick={() => s.status !== 'running' && toggleImage(v, i)} title={off ? 'Exclue — cliquer pour l’envoyer' : 'Envoyée — cliquer pour l’exclure'}
                               style={{ position: 'relative', cursor: 'pointer', opacity: off ? 0.35 : 1, outline: off ? 'none' : '2px solid #0D4A5C', outlineOffset: -2, borderRadius: 4 }}>
                            <ZipThumb label={im.fond && fitFond ? `🏞 ${ratio} ${quality}` : `${im.role}`} get={im.url ? () => Promise.resolve(im.url!) : () => thumbOf(im.zipKey!, im.fond)} />
                            <span style={{ position: 'absolute', top: 2, left: 2, fontSize: 10, fontWeight: 700, background: off ? '#9CA3AF' : '#0D4A5C', color: '#fff', borderRadius: 3, padding: '0 4px' }}>
                              {off ? '✕' : v.images.slice(0, i + 1).filter((_, k) => !(s.off ?? v.defaultOff).includes(k)).length}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                    <div>
                      {s.imageUrl
                        ? <a href={s.imageUrl} target="_blank" rel="noreferrer"><img src={s.imageUrl} alt="" style={{ width: '100%', borderRadius: 6 }} /></a>
                        : <div style={{ aspectRatio: ratio.replace(':', '/'), background: '#F3F4F6', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#9CA3AF' }}>{s.status === 'running' ? 'Génération…' : 'aperçu'}</div>}
                      {s.error && <div style={{ fontSize: 11, color: '#991B1B', marginTop: 4 }}>{s.error}</div>}
                      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                        <button onClick={() => generateOne(v)} disabled={s.status === 'running' || !v.images.length} style={small}>{s.versions.length ? '↻ Régénérer' : '▶ Générer'}</button>
                        {s.imageUrl && <button onClick={() => download(s.imageUrl!, v.fileName)} style={small}>⬇ {v.fileName}</button>}
                        <button onClick={() => update(v.id, { showPrompt: !s.showPrompt })} style={small}>{s.showPrompt ? 'Masquer' : 'Voir'} le prompt</button>
                      </div>
                      {s.versions.length > 1 && (
                        <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                          {s.versions.map((u, i) => <img key={u} src={u} alt="" onClick={() => update(v.id, { imageUrl: u })} title={`Version ${i + 1}`} style={{ width: 36, height: 48, objectFit: 'cover', borderRadius: 3, cursor: 'pointer', outline: u === s.imageUrl ? '2px solid #0D4A5C' : 'none' }} />)}
                        </div>
                      )}
                    </div>
                  </div>
                  {s.showPrompt && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 10, background: '#F9FAFB', padding: 8, borderRadius: 6, marginTop: 8 }}>{v.promptFor(v.images.filter((_, i) => !(s.off ?? v.defaultOff).includes(i)))}</pre>}
                </div>
              )
            })}
          </div>
          {visuels.length > shown && <div style={{ textAlign: 'center', marginTop: 12 }}><button onClick={() => setShown(n => n + 40)} style={small}>Afficher 40 de plus ({visuels.length - shown} restants)</button></div>}
        </>
      )}
    </div>
  )
}
