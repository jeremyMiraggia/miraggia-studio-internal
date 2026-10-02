/**
 * Choix du moteur de génération d'image côté navigateur, mémorisé onglet par onglet.
 * L'onglet affiché fixe le moteur « courant » ; l'intercepteur fetch de app/studio/layout.tsx
 * l'envoie en en-tête `x-image-provider` sur chaque appel /api/studio/*.
 */
export type ImageProvider = 'gemini' | 'openai'

export const PROVIDER_LABELS: Record<ImageProvider, { name: string; model: string }> = {
  gemini: { name: 'Gemini', model: 'Nano Banana Pro · gemini-3-pro-image-preview' },
  openai: { name: 'ChatGPT', model: 'GPT Image 2.5 Sunburst' },
}

let current: ImageProvider = 'gemini'
export const getCurrentProvider = () => current
export const setCurrentProvider = (p: ImageProvider) => { current = p }

const key = (tabId: string) => `image-provider:${tabId}`

export function loadTabProvider(tabId: string): ImageProvider {
  try { return localStorage.getItem(key(tabId)) === 'openai' ? 'openai' : 'gemini' } catch { return 'gemini' }
}
export function saveTabProvider(tabId: string, p: ImageProvider) {
  try { localStorage.setItem(key(tabId), p) } catch { /* stockage indisponible */ }
}
