'use client'
/**
 * INSTA : DM automatique quand quelqu'un commente une publication de Miraggia avec un mot clé (ex. « PROMPT »).
 * Instagram envoie chaque commentaire au webhook /api/insta/webhook ; si une règle correspond, le DM part
 * (« réponse privée » Instagram : 1 seul message par commentaire, dans les 7 jours).
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import { findRule, personalize } from '@/lib/insta/match'
import type { LogEntry, MatchMode, Rule, Rules } from '@/lib/insta/store'

type Media = { id: string; caption?: string; media_type: string; media_product_type?: string; thumbnail_url?: string; media_url?: string; permalink: string; timestamp: string; comments_count?: number }
type Status = {
  env: Record<string, boolean>
  urls: { webhook: string; redirect: string }
  account: { username: string; igId: string; expiresAt: number; tokenAt: number; connectedAt: number } | null
  subscribed: string[] | null
  subError?: string
  lastWebhook: { at: number; count: number } | null
  rules: Rules
  logs: LogEntry[]
  error?: string
}

const box: React.CSSProperties = { background: '#fff', borderRadius: 12, padding: 16, marginBottom: 16, border: '1px solid rgba(13,74,92,0.1)' }
const inp: React.CSSProperties = { padding: '6px 8px', borderRadius: 6, border: '1px solid #D1D5DB', fontSize: 13, boxSizing: 'border-box' }
const btn = (bg: string): React.CSSProperties => ({ background: bg, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', textDecoration: 'none', display: 'inline-block' })
const small: React.CSSProperties = { ...inp, cursor: 'pointer', background: '#fff', fontSize: 11 }
const h3: React.CSSProperties = { margin: '0 0 10px', fontSize: 15, color: '#0D4A5C' }
const fmt = (t: number) => new Date(t).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'à l’instant' : m < 60 ? `il y a ${m} min` : m < 1440 ? `il y a ${Math.round(m / 60)} h` : `il y a ${Math.round(m / 1440)} j` }

const newRule = (): Rule => ({
  id: crypto.randomUUID(), name: 'PROMPT', enabled: true, keywords: ['PROMPT'], mode: 'mot', posts: 'all',
  message: 'Hello {username} ! Merci pour ton commentaire 🙌\nVoici le prompt promis : …',
  publicReplies: ['C’est envoyé en DM 📩', 'Regarde tes messages 😉'],
})

export default function InstaTab() {
  const [st, setSt] = useState<Status | null>(null)
  const [loading, setLoading] = useState(true)
  const [rules, setRules] = useState<Rules>({ enabled: false, rules: [], updatedAt: 0 })
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [media, setMedia] = useState<Media[] | null>(null)
  const [mediaErr, setMediaErr] = useState('')
  const [pickFor, setPickFor] = useState<string | null>(null)
  const [test, setTest] = useState({ text: 'PROMPT stp 🙏', mediaId: '' })
  const [bf, setBf] = useState<Record<string, string>>({})

  const load = async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/studio/insta', { cache: 'no-store' })
      const j: Status = await r.json()
      setSt(j)
      if (j.rules && !dirty) setRules(j.rules)
    } catch (e: any) { setMsg({ ok: false, text: e?.message ?? String(e) }) }
    setLoading(false)
  }

  useEffect(() => {
    // message de retour de la connexion Instagram
    const p = new URLSearchParams(window.location.search)
    const m = p.get('insta')
    if (m) {
      setMsg(m.startsWith('ok:') ? { ok: true, text: `Compte @${m.slice(3)} connecté et abonné aux commentaires.` } : { ok: false, text: m })
      p.delete('insta'); p.delete('tab')
      window.history.replaceState(null, '', window.location.pathname + (p.size ? `?${p}` : ''))
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadMedia = async () => {
    setMediaErr('')
    const r = await fetch('/api/studio/insta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'media' }) })
    const j = await r.json()
    if (j.media) setMedia(j.media); else setMediaErr(j.error ?? 'publications indisponibles')
  }
  useEffect(() => { if (st?.account && !media) loadMedia() }, [st?.account]) // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (next: Rules) => { setRules(next); setDirty(true) }
  const patchRule = (id: string, p: Partial<Rule>) => edit({ ...rules, rules: rules.rules.map(r => (r.id === id ? { ...r, ...p } : r)) })

  const save = async (next = rules) => {
    setSaving(true)
    try {
      const r = await fetch('/api/studio/insta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rules', rules: next }) })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error)
      setRules(j.rules); setDirty(false)
      setMsg({ ok: true, text: 'Règles enregistrées (actives sous 1 minute).' })
    } catch (e: any) { setMsg({ ok: false, text: `Enregistrement impossible : ${e?.message ?? e}` }) }
    setSaving(false)
  }

  const action = async (a: string) => {
    const r = await fetch('/api/studio/insta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: a }) })
    const j = await r.json()
    setMsg(r.ok ? { ok: true, text: a === 'disconnect' ? 'Compte déconnecté.' : 'Abonnement aux commentaires renouvelé.' } : { ok: false, text: j.error })
    if (a === 'disconnect') setMedia(null)
    load()
  }

  const backfill = async (m: Media) => {
    setBf(s => ({ ...s, [m.id]: 'Analyse des commentaires…' }))
    try {
      const post = (body: object) => fetch('/api/studio/insta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'backfill', mediaId: m.id, ...body }) }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j })
      const d = await post({ dryRun: true })
      if (!d.todo) return setBf(s => ({ ...s, [m.id]: `${d.total} commentaire(s), ${d.matching} avec mot clé (≤ 7 j), ${d.alreadyDone} déjà traité(s) : rien à envoyer.` }))
      if (dirty) return setBf(s => ({ ...s, [m.id]: 'Enregistre d’abord tes règles.' }))
      if (!confirm(`${d.todo} DM à envoyer pour cette publication (commentaires avec mot clé des 7 derniers jours, pas encore traités). On y va ?`)) return setBf(s => ({ ...s, [m.id]: `${d.todo} DM en attente.` }))
      let sent = 0, errors = 0, remaining = d.todo
      while (remaining > 0) {
        setBf(s => ({ ...s, [m.id]: `Envoi… ${sent} envoyé(s), ${remaining} restant(s)` }))
        const r = await post({ limit: 25 })
        sent += r.sent; errors += r.errors
        if (r.remaining >= remaining || (!r.sent && !r.errors)) break
        remaining = r.remaining
      }
      setBf(s => ({ ...s, [m.id]: `✓ ${sent} DM envoyé(s)${errors ? `, ${errors} erreur(s) (voir journal)` : ''}.` }))
      load()
    } catch (e: any) { setBf(s => ({ ...s, [m.id]: `⚠ ${e?.message ?? e}` })) }
  }

  const testResult = useMemo(() => {
    const r = findRule(rules.rules, test.text, test.mediaId || undefined)
    return r ? { rule: r, dm: personalize(r.message, 'exemple_user') } : null
  }, [rules, test])

  const mediaById = useMemo(() => new Map((media ?? []).map(m => [m.id, m])), [media])
  const thumb = (m?: Media) => m?.thumbnail_url ?? (m?.media_type !== 'VIDEO' ? m?.media_url : undefined)

  if (loading && !st) return <div style={{ color: '#6B7A8A' }}>Chargement…</div>
  const e = st?.env ?? {}
  const daysLeft = st?.account ? Math.round((st.account.expiresAt - Date.now()) / 86400_000) : 0
  const subOk = !!st?.subscribed?.includes('comments')

  return (
    <div style={{ maxWidth: 1100 }}>
      <h2 style={{ margin: '0 0 4px', color: '#0D4A5C' }}>📸 INSTA — DM automatique sur mot clé</h2>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6B7A8A' }}>
        Quand quelqu’un commente une publication avec un mot clé (ex. « PROMPT »), il reçoit automatiquement un DM.
        Instagram n’autorise qu’<b>un seul DM par commentaire</b>, dans les <b>7 jours</b>.
      </p>

      {msg && <div style={{ ...box, background: msg.ok ? '#ECFDF5' : '#FEF2F2', color: msg.ok ? '#065F46' : '#991B1B', fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
        <span>{msg.ok ? '✓' : '⚠'} {msg.text}</span><span style={{ cursor: 'pointer' }} onClick={() => setMsg(null)}>✕</span></div>}
      {st?.error && <div style={{ ...box, background: '#FEF2F2', color: '#991B1B', fontSize: 13 }}>⚠ {st.error}</div>}

      {/* ---------- 1. connexion ---------- */}
      <div style={box}>
        <h3 style={h3}>1. Connexion</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {[['appId', 'INSTAGRAM_APP_ID'], ['appSecret', 'INSTAGRAM_APP_SECRET'], ['verifyToken', 'INSTAGRAM_WEBHOOK_VERIFY_TOKEN'], ['cronSecret', 'CRON_SECRET'], ['blob', 'BLOB_READ_WRITE_TOKEN']].map(([k, label]) => (
            <span key={k} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: e[k] ? '#ECFDF5' : '#FEF2F2', color: e[k] ? '#065F46' : '#991B1B' }}>{e[k] ? '✓' : '✕'} {label}</span>
          ))}
        </div>
        <div style={{ fontSize: 12, color: '#374151', display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '4px 8px', alignItems: 'center', marginBottom: 12 }}>
          {st && ([['URL de rappel webhook', st.urls.webhook], ['URL de redirection OAuth', st.urls.redirect]] as const).map(([l, u]) => (
            <Fragment key={l}><span style={{ color: '#6B7A8A' }}>{l}</span><code style={{ background: '#F3F4F6', padding: '2px 6px', borderRadius: 4, overflowWrap: 'anywhere' }}>{u}</code>
              <button style={small} onClick={() => navigator.clipboard.writeText(u)}>Copier</button></Fragment>
          ))}
        </div>
        {st?.account ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', fontSize: 13 }}>
            <span>✓ Connecté : <b>@{st.account.username}</b></span>
            <span style={{ color: daysLeft < 10 ? '#B45309' : '#6B7A8A' }}>jeton valable {daysLeft} j (renouvelé automatiquement)</span>
            <span style={{ color: subOk ? '#065F46' : '#991B1B' }}>{subOk ? '✓ abonné aux commentaires' : `✕ pas abonné aux commentaires${st.subError ? ` (${st.subError})` : ''}`}</span>
            {!subOk && <button style={small} onClick={() => action('subscribe')}>Réabonner</button>}
            <span style={{ color: '#6B7A8A' }}>dernier webhook : {st.lastWebhook ? ago(st.lastWebhook.at) : 'jamais reçu'}</span>
            <a href="/api/studio/insta/connect" style={small}>Reconnecter</a>
            <button style={{ ...small, color: '#991B1B' }} onClick={() => confirm('Déconnecter le compte Instagram ? Les DM automatiques s’arrêtent.') && action('disconnect')}>Déconnecter</button>
          </div>
        ) : (
          <a href="/api/studio/insta/connect" style={btn('#C13584')}>Connecter le compte Instagram de Miraggia</a>
        )}
      </div>

      {/* ---------- 2. règles ---------- */}
      <div style={box}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <h3 style={{ ...h3, margin: 0 }}>2. Règles mot clé → DM</h3>
          <label style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 600, color: rules.enabled ? '#065F46' : '#991B1B' }}>
            <input type="checkbox" checked={rules.enabled} onChange={ev => edit({ ...rules, enabled: ev.target.checked })} /> {rules.enabled ? 'Automatisation ACTIVE' : 'Automatisation en pause'}
          </label>
          <button style={btn(dirty ? '#0D4A5C' : '#9CA3AF')} disabled={saving || !dirty} onClick={() => save()}>{saving ? 'Enregistrement…' : dirty ? 'Enregistrer' : 'Enregistré'}</button>
        </div>

        {rules.rules.map(r => (
          <div key={r.id} style={{ border: '1px solid #E5E7EB', borderRadius: 10, padding: 12, marginBottom: 10, opacity: r.enabled ? 1 : 0.6 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <input type="checkbox" checked={r.enabled} onChange={ev => patchRule(r.id, { enabled: ev.target.checked })} title="Règle active" />
              <input value={r.name} onChange={ev => patchRule(r.id, { name: ev.target.value })} style={{ ...inp, width: 160, fontWeight: 600 }} placeholder="Nom" />
              <label style={{ fontSize: 12 }}>Mots clés{' '}
                <input value={r.keywords.join(', ')} onChange={ev => patchRule(r.id, { keywords: ev.target.value.split(',').map(s => s.trimStart()) })} style={{ ...inp, width: 200 }} placeholder="PROMPT, PROMPTS" /></label>
              <select value={r.mode} onChange={ev => patchRule(r.id, { mode: ev.target.value as MatchMode })} style={inp}>
                <option value="mot">le mot apparaît dans le commentaire</option>
                <option value="exact">le commentaire n’est que le mot</option>
                <option value="contient">le mot apparaît n’importe où (même collé)</option>
              </select>
              <button style={{ ...small, marginLeft: 'auto', color: '#991B1B' }} onClick={() => confirm(`Supprimer la règle « ${r.name} » ?`) && edit({ ...rules, rules: rules.rules.filter(x => x.id !== r.id) })}>Supprimer</button>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, fontSize: 12, flexWrap: 'wrap' }}>
              <span>Publications :</span>
              <label><input type="radio" checked={r.posts === 'all'} onChange={() => patchRule(r.id, { posts: 'all' })} /> toutes</label>
              <label><input type="radio" checked={r.posts !== 'all'} onChange={() => { patchRule(r.id, { posts: r.posts === 'all' ? [] : r.posts }); setPickFor(r.id) }} /> seulement certaines</label>
              {r.posts !== 'all' && <>
                {r.posts.map(id => { const m = mediaById.get(id); return (
                  <span key={id} title={m?.caption?.slice(0, 120)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#F3F4F6', borderRadius: 6, padding: 2 }}>
                    {thumb(m) ? <img src={thumb(m)} alt="" style={{ width: 28, height: 28, objectFit: 'cover', borderRadius: 4 }} /> : <span style={{ fontSize: 10, padding: '0 4px' }}>{id.slice(-6)}</span>}
                    <span style={{ cursor: 'pointer', padding: '0 4px' }} onClick={() => patchRule(r.id, { posts: (r.posts as string[]).filter(x => x !== id) })}>✕</span>
                  </span>) })}
                <button style={small} onClick={() => setPickFor(pickFor === r.id ? null : r.id)}>{pickFor === r.id ? 'Fermer' : '+ Choisir'}</button>
                {!r.posts.length && <span style={{ color: '#B45309' }}>⚠ aucune publication choisie : la règle ne fera rien</span>}
              </>}
            </div>
            {pickFor === r.id && r.posts !== 'all' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 6, marginBottom: 8, maxHeight: 260, overflowY: 'auto' }}>
                {!media && <span style={{ fontSize: 12, color: '#6B7A8A' }}>{mediaErr || (st?.account ? 'Chargement des publications…' : 'Connecte le compte pour voir les publications.')}</span>}
                {media?.map(m => { const on = (r.posts as string[]).includes(m.id); return (
                  <div key={m.id} title={m.caption?.slice(0, 200)} onClick={() => patchRule(r.id, { posts: on ? (r.posts as string[]).filter(x => x !== m.id) : [...(r.posts as string[]), m.id] })}
                       style={{ cursor: 'pointer', borderRadius: 6, overflow: 'hidden', outline: on ? '3px solid #C13584' : '1px solid #E5E7EB', position: 'relative', aspectRatio: '1' }}>
                    {thumb(m) ? <img src={thumb(m)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: on ? 1 : 0.75 }} /> : <div style={{ fontSize: 10, padding: 4 }}>{m.media_type}</div>}
                    <span style={{ position: 'absolute', bottom: 0, left: 0, right: 0, fontSize: 9, background: 'rgba(0,0,0,0.55)', color: '#fff', padding: '1px 3px' }}>{new Date(m.timestamp).toLocaleDateString('fr-FR')}</span>
                  </div>) })}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
              <label style={{ fontSize: 12 }}>DM envoyé <span style={{ color: '#9CA3AF' }}>({'{username}'} = pseudo · {r.message.length}/1000)</span>
                <textarea value={r.message} onChange={ev => patchRule(r.id, { message: ev.target.value })} rows={5} style={{ ...inp, width: '100%', marginTop: 4, fontFamily: 'inherit' }} /></label>
              <label style={{ fontSize: 12 }}>Réponse publique sous le commentaire <span style={{ color: '#9CA3AF' }}>(une par ligne, tirée au hasard ; vide = aucune)</span>
                <textarea value={r.publicReplies.join('\n')} onChange={ev => patchRule(r.id, { publicReplies: ev.target.value.split('\n') })} rows={5} style={{ ...inp, width: '100%', marginTop: 4, fontFamily: 'inherit' }} /></label>
            </div>
          </div>
        ))}
        <button style={small} onClick={() => edit({ ...rules, rules: [...rules.rules, newRule()] })}>+ Ajouter une règle</button>
        {rules.rules.length > 1 && <span style={{ fontSize: 11, color: '#6B7A8A', marginLeft: 8 }}>Si plusieurs règles correspondent, c’est la première de la liste qui s’applique.</span>}

        {/* test sans envoi */}
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed #E5E7EB', fontSize: 12 }}>
          <b>Tester (sans rien envoyer)</b>
          <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <input value={test.text} onChange={ev => setTest({ ...test, text: ev.target.value })} style={{ ...inp, flex: 1, minWidth: 220 }} placeholder="Texte d’un commentaire" />
            <select value={test.mediaId} onChange={ev => setTest({ ...test, mediaId: ev.target.value })} style={{ ...inp, maxWidth: 260 }}>
              <option value="">(publication quelconque)</option>
              {media?.map(m => <option key={m.id} value={m.id}>{new Date(m.timestamp).toLocaleDateString('fr-FR')} — {(m.caption ?? m.media_type).slice(0, 40)}</option>)}
            </select>
          </div>
          <div style={{ marginTop: 6, padding: 8, borderRadius: 6, background: testResult ? '#ECFDF5' : '#F9FAFB', whiteSpace: 'pre-wrap' }}>
            {testResult ? <>✓ Règle « {testResult.rule.name} » → DM :{'\n'}{testResult.dm}</> : 'Aucune règle active ne correspond : pas de DM.'}
            {!rules.enabled && testResult && <div style={{ color: '#B45309', marginTop: 4 }}>⚠ L’automatisation est en pause : rien ne partira tant qu’elle n’est pas active.</div>}
          </div>
        </div>
      </div>

      {/* ---------- 3. rattrapage ---------- */}
      {st?.account && (
        <div style={box}>
          <h3 style={h3}>3. Rattrapage des commentaires déjà postés</h3>
          <p style={{ fontSize: 12, color: '#6B7A8A', margin: '0 0 10px' }}>
            Pour une publication sortie avant l’activation (ou pendant une panne) : envoie le DM aux commentaires des 7 derniers jours qui contiennent un mot clé et ne l’ont pas encore reçu. On ne renvoie jamais deux fois.
          </p>
          {!media && <div style={{ fontSize: 12 }}>{mediaErr || 'Chargement…'}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
            {media?.filter(m => Date.now() - Date.parse(m.timestamp) < 30 * 86400_000).map(m => (
              <div key={m.id} style={{ display: 'flex', gap: 8, border: '1px solid #E5E7EB', borderRadius: 8, padding: 6, fontSize: 11 }}>
                {thumb(m) ? <img src={thumb(m)} alt="" style={{ width: 54, height: 54, objectFit: 'cover', borderRadius: 4 }} /> : <div style={{ width: 54 }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}><a href={m.permalink} target="_blank" rel="noreferrer">{(m.caption ?? m.media_type).slice(0, 60)}</a></div>
                  <div style={{ color: '#6B7A8A' }}>{new Date(m.timestamp).toLocaleDateString('fr-FR')} · {m.comments_count ?? '?'} commentaire(s)</div>
                  <button style={{ ...small, marginTop: 4 }} onClick={() => backfill(m)}>Rattraper</button>
                  {bf[m.id] && <div style={{ marginTop: 4 }}>{bf[m.id]}</div>}
                </div>
              </div>
            ))}
          </div>
          {media && !media.some(m => Date.now() - Date.parse(m.timestamp) < 30 * 86400_000) && <div style={{ fontSize: 12, color: '#6B7A8A' }}>Aucune publication des 30 derniers jours.</div>}
        </div>
      )}

      {/* ---------- 4. journal ---------- */}
      <div style={box}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ ...h3, margin: 0 }}>4. Journal</h3>
          <button style={{ ...small, marginLeft: 'auto' }} onClick={load}>{loading ? '…' : 'Actualiser'}</button>
        </div>
        {!st?.logs?.length ? <div style={{ fontSize: 12, color: '#6B7A8A' }}>Aucun DM envoyé pour l’instant.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ textAlign: 'left', color: '#6B7A8A' }}><th>Date</th><th>Compte</th><th>Commentaire</th><th>Règle</th><th>Statut</th></tr></thead>
            <tbody>{st.logs.map(l => (
              <tr key={l.commentId + l.at} style={{ borderTop: '1px solid #F3F4F6', verticalAlign: 'top' }}>
                <td style={{ whiteSpace: 'nowrap', padding: '4px 6px 4px 0' }}>{fmt(l.at)}</td>
                <td>@{l.username}</td>
                <td style={{ maxWidth: 320 }}>{l.text}</td>
                <td>{l.rule}{l.source === 'rattrapage' ? ' (rattrapage)' : ''}</td>
                <td style={{ color: l.status === 'envoyé' ? '#065F46' : '#991B1B' }}>{l.status === 'envoyé' ? '✓ DM envoyé' : `✕ ${l.error}`}{l.publicReply && <div style={{ color: '#6B7A8A' }}>↳ {l.publicReply}</div>}</td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
    </div>
  )
}
