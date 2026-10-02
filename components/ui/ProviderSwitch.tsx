'use client'
import { useSyncExternalStore } from 'react'
import {
  PROVIDER_LABELS, OPENAI_QUALITIES, getCosts, subscribeCosts, resetCosts,
  type ImageProvider, type OpenAIQuality,
} from '@/lib/imageProviderClient'

const STYLE: Record<ImageProvider, { bg: string; fg: string; dot: string }> = {
  gemini: { bg: '#0D4A5C', fg: '#C8F07D', dot: '#4285F4' },
  openai: { bg: '#10A37F', fg: '#FFFFFF', dot: '#FFFFFF' },
}
const usd = (v: number) => `${v < 0.1 ? v.toFixed(3) : v.toFixed(2)} $`

/**
 * Gros interrupteur Gemini / ChatGPT en haut de chaque onglet qui génère des images,
 * + qualité ChatGPT + coût réel (dernier appel et total de la session, par moteur).
 */
export default function ProviderSwitch({ tab, value, onChange, quality, onQualityChange }: {
  tab: string
  value: ImageProvider
  onChange: (p: ImageProvider) => void
  quality: OpenAIQuality
  onQualityChange: (q: OpenAIQuality) => void
}) {
  const costs = useSyncExternalStore(subscribeCosts, () => getCosts(tab), () => getCosts(tab))
  const totals = (Object.keys(costs.total) as ImageProvider[]).filter(p => costs.total[p].requests > 0)

  return (
    <div style={{ marginBottom: 16, padding: 10, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 12, color: '#6B7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>Génération via</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, flex: 1 }}>
          {(Object.keys(PROVIDER_LABELS) as ImageProvider[]).map(p => {
            const on = value === p
            return (
              <button key={p} onClick={() => onChange(p)} aria-pressed={on}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '12px 16px',
                        borderRadius: 10, cursor: 'pointer', transition: 'all 0.15s',
                        border: on ? `2px solid ${STYLE[p].bg}` : '2px solid #E5E7EB',
                        background: on ? STYLE[p].bg : '#F9FAFB', color: on ? STYLE[p].fg : '#6B7280',
                      }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: on ? STYLE[p].dot : '#D1D5DB', flexShrink: 0 }} />
                <span style={{ textAlign: 'left' }}>
                  <span style={{ display: 'block', fontSize: 16, fontWeight: 700 }}>{PROVIDER_LABELS[p].name}</span>
                  <span style={{ display: 'block', fontSize: 11, opacity: 0.8 }}>{PROVIDER_LABELS[p].model}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {value === 'openai' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#374151', fontWeight: 600, marginRight: 4 }}>Qualité ChatGPT</span>
          {OPENAI_QUALITIES.map(q => (
            <button key={q.id} onClick={() => onQualityChange(q.id)} title={q.hint} aria-pressed={quality === q.id}
                    style={{ border: 'none', borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                             background: quality === q.id ? '#10A37F' : '#E5E7EB', color: quality === q.id ? '#fff' : '#374151' }}>
              {q.label}
            </button>
          ))}
          <span style={{ fontSize: 11, color: '#6B7280', marginLeft: 4 }}>{OPENAI_QUALITIES.find(q => q.id === quality)?.hint}</span>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, fontSize: 12, color: '#374151', flexWrap: 'wrap' }}>
        <span style={{ color: '#6B7280' }}>💰 Coût réel</span>
        {costs.last ? (
          <>
            <span>dernier appel : <strong>{usd(costs.last.usd)}</strong> ({PROVIDER_LABELS[costs.last.provider].name}{costs.last.calls > 1 ? `, ${costs.last.calls} générations dont retries` : ''})</span>
            <span style={{ color: '#9CA3AF' }}>·</span>
            <span>session sur cet onglet : {totals.map(p => (
              <strong key={p} style={{ marginRight: 8 }}>{PROVIDER_LABELS[p].name} {usd(costs.total[p].usd)} ({costs.total[p].requests})</strong>
            ))}</span>
            <button onClick={() => resetCosts(tab)} style={{ marginLeft: 'auto', background: 'none', border: '1px solid #E5E7EB', borderRadius: 6, cursor: 'pointer', fontSize: 11, padding: '2px 6px' }}>Remettre à zéro</button>
          </>
        ) : (
          <span style={{ color: '#9CA3AF' }}>s'affiche après la première génération (calculé sur les tokens réellement facturés)</span>
        )}
      </div>
    </div>
  )
}
