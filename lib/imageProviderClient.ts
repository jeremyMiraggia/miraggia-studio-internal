/**
 * Choix du moteur de génération d'image côté navigateur, mémorisé onglet par onglet.
 * L'onglet affiché fixe le moteur « courant » (et la qualité ChatGPT) ; l'intercepteur fetch
 * de app/studio/layout.tsx les envoie en en-têtes sur chaque appel /api/studio/* et
 * remonte le coût réel renvoyé par le serveur (en-tête x-image-cost).
 */
export type ImageProvider = 'gemini' | 'openai'
export type OpenAIQuality = 'auto' | 'low' | 'medium' | 'high' | 'xhigh'

export const PROVIDER_LABELS: Record<ImageProvider, { name: string; model: string }> = {
  gemini: { name: 'Gemini', model: 'Nano Banana Pro · gemini-3-pro-image-preview' },
  openai: { name: 'ChatGPT', model: 'GPT Image 2.5 Sunburst' },
}

export const OPENAI_QUALITIES: { id: OpenAIQuality; label: string; hint: string }[] = [
  { id: 'auto',   label: 'Auto',   hint: '1K → medium, 2K/4K → high' },
  { id: 'low',    label: 'Low',    hint: 'brouillon, très bon marché' },
  { id: 'medium', label: 'Medium', hint: '≈ 4× moins cher que high' },
  { id: 'high',   label: 'High',   hint: 'qualité finale' },
  { id: 'xhigh',  label: 'X-High', hint: '≈ 2× le prix de high' },
]

/* ----------- État courant (onglet affiché) ----------- */
let current: { tab: string; provider: ImageProvider; quality: OpenAIQuality } = { tab: '', provider: 'gemini', quality: 'auto' }
export const getCurrentProvider = () => current.provider
export const getCurrentQuality = () => current.quality
export const setCurrent = (tab: string, provider: ImageProvider, quality: OpenAIQuality) => { current = { tab, provider, quality } }

/* ----------- Préférences par onglet ----------- */
const read = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const write = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* stockage indisponible */ } }

export const loadTabProvider = (tab: string): ImageProvider => read(`image-provider:${tab}`) === 'openai' ? 'openai' : 'gemini'
export const saveTabProvider = (tab: string, p: ImageProvider) => write(`image-provider:${tab}`, p)
export const loadTabQuality = (tab: string): OpenAIQuality => (OPENAI_QUALITIES.find(q => q.id === read(`openai-quality:${tab}`))?.id ?? 'auto')
export const saveTabQuality = (tab: string, q: OpenAIQuality) => write(`openai-quality:${tab}`, q)

/* ----------- Coûts réels, par onglet et par moteur (session) ----------- */
export type CostStats = { last?: { usd: number; provider: ImageProvider; calls: number }; total: Record<ImageProvider, { usd: number; requests: number }> }
const costs = new Map<string, CostStats>()
const listeners = new Set<() => void>()
const empty = (): CostStats => ({ total: { gemini: { usd: 0, requests: 0 }, openai: { usd: 0, requests: 0 } } })

export function recordCost(usd: number, calls: number) {
  if (!current.tab || !Number.isFinite(usd)) return
  const prev = costs.get(current.tab) ?? empty()
  const t = prev.total[current.provider]
  costs.set(current.tab, {
    last: { usd, provider: current.provider, calls },
    total: { ...prev.total, [current.provider]: { usd: t.usd + usd, requests: t.requests + 1 } },
  })
  listeners.forEach(l => l())
}
export const getCosts = (tab: string): CostStats => costs.get(tab) ?? EMPTY
const EMPTY = empty()
export function subscribeCosts(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } }
export function resetCosts(tab: string) { costs.delete(tab); listeners.forEach(l => l()) }
