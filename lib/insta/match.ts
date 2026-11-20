/** Détection des mots clés dans les commentaires (fonctions pures, utilisables côté navigateur pour le test). */
import type { Rule } from './store'

/** minuscules, sans accents, ponctuation et emojis → espaces */
export const normText = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

export function ruleMatches(rule: Rule, text: string, mediaId?: string): boolean {
  if (!rule.enabled || !rule.message.trim()) return false
  if (rule.posts !== 'all' && (!mediaId || !rule.posts.includes(mediaId))) return false
  const t = normText(text)
  if (!t) return false
  return rule.keywords.some(k => {
    const kw = normText(k)
    if (!kw) return false
    if (rule.mode === 'exact') return t === kw
    if (rule.mode === 'contient') return t.replace(/ /g, '').includes(kw.replace(/ /g, ''))
    return ` ${t} `.includes(` ${kw} `)   // mot entier (ou groupe de mots)
  })
}

/** Première règle active qui correspond. */
export const findRule = (rules: Rule[], text: string, mediaId?: string) => rules.find(r => ruleMatches(r, text, mediaId))

/** Remplace {username} par le pseudo du commentateur. */
export const personalize = (tpl: string, username: string) => tpl.replace(/\{username\}/gi, username ? `@${username}` : '').replace(/[ \t]{2,}/g, ' ').trim()
