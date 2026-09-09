/** Endpoints fal pour la vidéo — surchargeables par env si fal renomme. */
export const VIDEO_ENDPOINTS: Record<string, string> = {
  standard: process.env.FAL_VIDEO_ENDPOINT_STANDARD || 'fal-ai/kling-video/o3/standard/image-to-video',
  pro:      process.env.FAL_VIDEO_ENDPOINT_PRO      || 'fal-ai/kling-video/o3/pro/image-to-video',
}

/** Coût $/s (fal llms.txt, sept. 2026) — pour affichage seulement. */
export const VIDEO_PRICE_PER_SEC: Record<string, { noAudio: number; audio: number }> = {
  standard: { noAudio: 0.084, audio: 0.112 },
  pro:      { noAudio: 0.112, audio: 0.14 },
}

/** Un endpoint est-il autorisé (anti-injection depuis le client) ? */
export function isKnownVideoEndpoint(ep: string): boolean {
  return Object.values(VIDEO_ENDPOINTS).includes(ep)
}
