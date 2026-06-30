'use client'
import { useState } from 'react'
import SimpleTab     from '@/components/tabs/SimpleTab'
import BatchTab      from '@/components/tabs/BatchTab'
import FreePromptTab from '@/components/tabs/FreePromptTab'
import ExtractTab    from '@/components/tabs/ExtractTab'
import LookbookTab   from '@/components/tabs/LookbookTab'
import GhostTab      from '@/components/tabs/GhostTab'
import LinTab        from '@/components/tabs/LinTab'
import LifestyleTab  from '@/components/tabs/LifestyleTab'
import VideoTab      from '@/components/tabs/VideoTab'
import NotionTab        from '@/components/tabs/NotionTab'
import NotionInternalTab from '@/components/tabs/NotionInternalTab'
import CompositeTab      from '@/components/tabs/CompositeTab'
import PipelineTab       from '@/components/tabs/PipelineTab'
import PipelineV2TestTab from '@/components/tabs/PipelineV2TestTab'
import ECommerceNewTechTab from '@/components/tabs/ECommerceNewTechTab'

const TABS = [
  { id: 'simple',          label: '🖼️ Simple' },
  { id: 'notion',          label: '📥 Notion' },
  { id: 'notion-internal', label: '📥 Notion Internal' },
  { id: 'composite',       label: '🎯 Composite (Gemini)' },
  { id: 'pipeline',        label: '🔬 Pipeline (fond exact)' },
  { id: 'pipeline-v2',     label: '🧪 Pipeline V2 Test' },
  { id: 'ecom-newtech',    label: '🛍 E-Com New Tech' },
  { id: 'lookbook',        label: '👗 Lookbook' },
  { id: 'ghost',           label: '👻 Ghost' },
  { id: 'lin',             label: '🧺 Lin' },
  { id: 'lifestyle',       label: '🌴 Lifestyle' },
  { id: 'video',           label: '🎬 Video' },
  { id: 'batch',           label: '📋 Batch' },
  { id: 'free',            label: '🧠 Free Prompt' },
  { id: 'extract',         label: '🔍 Extracteur' },
]

export default function StudioPage() {
  const [tab, setTab] = useState('simple')

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 52px)' }}>
      {/* Sidebar */}
      <div style={{ width: 180, background: '#fff', borderRight: '1px solid rgba(13,74,92,0.1)', padding: '16px 0', flexShrink: 0 }}>
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
          </div>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 28 }}>
        {tab === 'simple'          && <SimpleTab />}
        {tab === 'notion'          && <NotionTab />}
        {tab === 'notion-internal' && <NotionInternalTab />}
        {tab === 'composite'       && <CompositeTab />}
        {tab === 'pipeline'        && <PipelineTab />}
        {tab === 'pipeline-v2'     && <PipelineV2TestTab />}
        {tab === 'ecom-newtech'    && <ECommerceNewTechTab />}
        {tab === 'lookbook'        && <LookbookTab />}
        {tab === 'ghost'           && <GhostTab />}
        {tab === 'lin'             && <LinTab />}
        {tab === 'lifestyle'       && <LifestyleTab />}
        {tab === 'video'           && <VideoTab />}
                {tab === 'batch'           && <BatchTab />}
        {tab === 'free'            && <FreePromptTab />}
        {tab === 'extract'         && <ExtractTab />}
      </div>
    </div>
  )
}
