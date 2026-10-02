'use client'
import { PROVIDER_LABELS, type ImageProvider } from '@/lib/imageProviderClient'

const STYLE: Record<ImageProvider, { bg: string; fg: string; dot: string }> = {
  gemini: { bg: '#0D4A5C', fg: '#C8F07D', dot: '#4285F4' },
  openai: { bg: '#10A37F', fg: '#FFFFFF', dot: '#FFFFFF' },
}

/** Gros interrupteur Gemini / ChatGPT affiché en haut de chaque onglet qui génère des images. */
export default function ProviderSwitch({ value, onChange }: { value: ImageProvider; onChange: (p: ImageProvider) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, padding: 10, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12 }}>
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
  )
}
