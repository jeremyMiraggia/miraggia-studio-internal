'use client'
import { useEffect, useState } from 'react'
import ProviderSwitch from '@/components/ui/ProviderSwitch'
import {
  loadTabProvider, saveTabProvider, loadTabQuality, saveTabQuality, setCurrent,
  type ImageProvider, type OpenAIQuality,
} from '@/lib/imageProviderClient'
import SimpleTab     from '@/components/tabs/SimpleTab'
import FreePromptTab from '@/components/tabs/FreePromptTab'
import ExtractTab    from '@/components/tabs/ExtractTab'
import LinTab        from '@/components/tabs/LinTab'
import VideoTab      from '@/components/tabs/VideoTab'
import NotionTab        from '@/components/tabs/NotionTab'
import NotionInternalTab from '@/components/tabs/NotionInternalTab'
import CompositeTab      from '@/components/tabs/CompositeTab'
import PipelineTab       from '@/components/tabs/PipelineTab'
import PipelineV2TestTab from '@/components/tabs/PipelineV2TestTab'
import ECommerceNewTechTab from '@/components/tabs/ECommerceNewTechTab'
import GhostFSTab from '@/components/tabs/GhostFSTab'
import NatureMorteTab from '@/components/tabs/NatureMorteTab'
import VisageTab from '@/components/tabs/VisageTab'
import GoldSilverTab from '@/components/tabs/GoldSilverTab'
import GabaritTab from '@/components/tabs/GabaritTab'
import GrainTab from '@/components/tabs/GrainTab'
import LingerieTab from '@/components/tabs/LingerieTab'
import PacTab from '@/components/tabs/PacTab'

const TABS = [
  { id: 'simple',          label: '🖼️ Simple' },
  { id: 'visage',          label: '🎭 Visage' },
  { id: 'gold-silver',     label: '🥇 Golden Silver' },
  { id: 'lingerie',        label: '🩱 Lingerie' },
  { id: 'pac',             label: '🔧 PAC' },
  { id: 'gabarit',         label: '📐 Gabarit' },
  { id: 'grain',           label: '🎞️ Grain' },
  { id: 'notion',          label: '📥 Notion' },
  { id: 'notion-internal', label: '📥 Notion Internal' },
  { id: 'composite',       label: '🎯 Composite' },
  { id: 'pipeline',        label: '🔬 Pipeline (fond exact)' },
  { id: 'pipeline-v2',     label: '🧪 Pipeline V2 Test' },
  { id: 'ecom-newtech',    label: '🛍 E-Com New Tech' },
  { id: 'ghost-fs',        label: '👻 Ghost F&S' },
  { id: 'nature-morte',    label: '🍃 Nature Morte' },
  { id: 'lin',             label: '🧺 Lin' },
  { id: 'video',           label: '🎬 Video' },
  { id: 'free',            label: '🧠 Free Prompt' },
  { id: 'extract',         label: '🔍 Extracteur' },
]

/** Onglets qui génèrent des images (Grain, Video, Extracteur n'en génèrent pas → pas d'interrupteur). */
const IMAGE_TABS = new Set(TABS.map(t => t.id).filter(id => !['grain', 'video', 'extract'].includes(id)))

export default function StudioPage() {
  const [tab, setTab] = useState('simple')
  // Moteur d'image choisi, onglet par onglet (mémorisé dans le navigateur)
  const [providers, setProviders] = useState<Record<string, ImageProvider>>({})
  const [qualities, setQualities] = useState<Record<string, OpenAIQuality>>({})
  useEffect(() => {
    setProviders(Object.fromEntries(TABS.map(t => [t.id, loadTabProvider(t.id)])))
    setQualities(Object.fromEntries(TABS.map(t => [t.id, loadTabQuality(t.id)])))
  }, [])
  const provider: ImageProvider = providers[tab] ?? 'gemini'
  const quality: OpenAIQuality = qualities[tab] ?? 'auto'
  useEffect(() => { setCurrent(tab, IMAGE_TABS.has(tab) ? provider : 'gemini', quality) }, [tab, provider, quality])
  const changeProvider = (p: ImageProvider) => { setProviders(prev => ({ ...prev, [tab]: p })); saveTabProvider(tab, p) }
  const changeQuality = (q: OpenAIQuality) => { setQualities(prev => ({ ...prev, [tab]: q })); saveTabQuality(tab, q) }

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 52px)' }}>
      {/* Sidebar */}
      <div style={{ width: 180, background: '#fff', borderRight: '1px solid rgba(13,74,92,0.1)', padding: '16px 0', flexShrink: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        {TABS.map(t => (
          <div
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '10px 20px', cursor: 'pointer', fontSize: 13, fontWeight: 500,
              background: tab === t.id ? '#E8F2F5' : 'transparent',
              color: tab === t.id ? '#0D4A5C' : '#6B7A8A',
              borderLeft: tab === t.id ? '3px solid #0D4A5C' : '3px solid transparent',
              transition: 'all 0.15s',
            }}
          >
            {t.label}
            {IMAGE_TABS.has(t.id) && providers[t.id] === 'openai' && (
              <span title="Cet onglet génère via ChatGPT" style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: '#fff', background: '#10A37F', borderRadius: 4, padding: '1px 4px', verticalAlign: 'middle' }}>GPT</span>
            )}
          </div>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 28 }}>
        {IMAGE_TABS.has(tab) && <ProviderSwitch tab={tab} value={provider} onChange={changeProvider} quality={quality} onQualityChange={changeQuality} />}
        {tab === 'simple'          && <SimpleTab />}
        {tab === 'visage'          && <VisageTab />}
        {tab === 'gold-silver'     && <GoldSilverTab />}
        {tab === 'lingerie'        && <LingerieTab />}
        {tab === 'pac'             && <PacTab />}
        {tab === 'gabarit'         && <GabaritTab />}
        {tab === 'grain'           && <GrainTab />}
        {tab === 'notion'          && <NotionTab />}
        {tab === 'notion-internal' && <NotionInternalTab />}
        {tab === 'composite'       && <CompositeTab />}
        {tab === 'pipeline'        && <PipelineTab />}
        {tab === 'pipeline-v2'     && <PipelineV2TestTab />}
        {tab === 'ecom-newtech'    && <ECommerceNewTechTab />}
        {tab === 'ghost-fs'        && <GhostFSTab />}
        {tab === 'nature-morte'    && <NatureMorteTab />}
        {tab === 'lin'             && <LinTab />}
        {tab === 'video'           && <VideoTab />}
        {tab === 'free'            && <FreePromptTab />}
        {tab === 'extract'         && <ExtractTab />}
      </div>
    </div>
  )
}
