'use client'
/**
 * Champ texte (ou zone de texte) avec autocomplétion des variables : taper « @ » ouvre la liste,
 * on filtre en continuant à taper, ↑ ↓ pour choisir, Entrée / Tab pour insérer « {Variable} », Échap pour fermer.
 */
import { useRef, useState } from 'react'

type Var = { name: string; hint?: string }
type Props = {
  value: string
  onChange: (v: string) => void
  vars: Var[]
  multiline?: boolean
  rows?: number
  placeholder?: string
  style?: React.CSSProperties
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

export default function VarInput({ value, onChange, vars, multiline, rows = 4, placeholder, style }: Props) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  const [query, setQuery] = useState<{ start: number; text: string } | null>(null)
  const [sel, setSel] = useState(0)

  const matches = query ? vars.filter(v => norm(v.name).includes(norm(query.text))).slice(0, 12) : []

  /** Cherche un « @mot » juste avant le curseur. */
  const detect = (text: string, caret: number) => {
    const before = text.slice(0, caret)
    const at = before.lastIndexOf('@')
    if (at < 0) return setQuery(null)
    const q = before.slice(at + 1)
    if (/[\n{}@]/.test(q) || q.length > 40) return setQuery(null)
    setQuery({ start: at, text: q }); setSel(0)
  }

  const insert = (v: Var) => {
    if (!query || !ref.current) return
    const caret = ref.current.selectionStart ?? value.length
    const token = `{${v.name}}`
    const next = value.slice(0, query.start) + token + value.slice(caret)
    onChange(next)
    setQuery(null)
    const pos = query.start + token.length
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(pos, pos) })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!query || !matches.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => (s + 1) % matches.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => (s - 1 + matches.length) % matches.length) }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insert(matches[sel]) }
    else if (e.key === 'Escape') { e.preventDefault(); setQuery(null) }
  }

  const common = {
    ref, value, placeholder,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement & HTMLInputElement>) => { onChange(e.target.value); detect(e.target.value, e.target.selectionStart ?? e.target.value.length) },
    onKeyDown,
    onClick: (e: React.MouseEvent<HTMLTextAreaElement & HTMLInputElement>) => detect(e.currentTarget.value, e.currentTarget.selectionStart ?? 0),
    onBlur: () => setTimeout(() => setQuery(null), 150),
    style: { width: '100%', boxSizing: 'border-box' as const, ...style },
  }

  return (
    <div style={{ position: 'relative' }}>
      {multiline ? <textarea {...common} rows={rows} /> : <input {...common} />}
      {query && matches.length > 0 && (
        <div style={{ position: 'absolute', left: 0, top: '100%', marginTop: 2, zIndex: 20, background: '#fff', border: '1px solid #D1D5DB', borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.12)', minWidth: 260, maxWidth: 460, maxHeight: 260, overflowY: 'auto' }}>
          <div style={{ fontSize: 10, color: '#9CA3AF', padding: '4px 8px', borderBottom: '1px solid #F3F4F6' }}>Variables — ↑ ↓ puis Entrée</div>
          {matches.map((v, i) => (
            <div key={v.name} onMouseDown={e => { e.preventDefault(); insert(v) }} onMouseEnter={() => setSel(i)}
                 style={{ padding: '5px 8px', cursor: 'pointer', background: i === sel ? '#E8F2F5' : '#fff', display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <code style={{ fontSize: 12, color: '#0D4A5C', whiteSpace: 'nowrap' }}>{`{${v.name}}`}</code>
              {v.hint && <span style={{ fontSize: 10, color: '#6B7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.hint}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
