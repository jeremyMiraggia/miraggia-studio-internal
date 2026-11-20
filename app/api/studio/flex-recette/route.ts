/**
 * 🧩 FLEX — traduit la consigne en français en RECETTE (JSON) d'après le diagnostic du ZIP.
 * Entrée : { consigne, schema (tables/colonnes typées), catalogue: boolean }
 * Sortie : { recette, explication } — la recette est ensuite validée côté navigateur (validerRecette).
 * Modèle texte Gemini (rapide, coût négligeable), avec liste de repli.
 */
import { NextResponse } from 'next/server'

export const maxDuration = 60
export const runtime = 'nodejs'

const TEXT_MODELS = ['gemini-3.1-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash']

const INSTRUCTIONS = `Tu configures un générateur de visuels de mode à partir d'un export Notion.
On te donne le SCHÉMA du ZIP (tables CSV, colonnes typées, exemples) et la CONSIGNE de l'utilisateur.
Réponds UNIQUEMENT avec un objet JSON :
{
  "recette": {
    "table": "<table principale : 1 ligne = 1 produit/look>",
    "poseColumns": ["<colonnes de type pose/vue : chaque cellule remplie = 1 visuel ; [] = 1 visuel par ligne>"],
    "images": [ { "role": "<rôle en anglais pour le modèle d'image, ex. 'the model face (identity to keep)', 'the garment to wear (front)', 'the background to keep identical'>",
                  "source": <SOURCE>, "max": <nb max d'images de cette source, 1 à 14> } ],
    "texts": [ { "label": "<libellé ajouté au prompt, ex. 'Garment description'>", "source": <SOURCE> } ],
    "prompt": "<prompt artistique en anglais, peut contenir des variables {Nom de colonne} et {pose}>",
    "fileName": "<modèle de nom de fichier, ex. '{SKU}_{pose}'>",
    "skipEmpty": true
  },
  "explication": "<2 à 4 phrases en français : ce que fera la recette, et ce qui est ambigu ou manquant>"
}
<SOURCE> est l'un de :
  {"kind":"colonne","column":"<colonne de la table principale>"}
  {"kind":"lien","column":"<colonne de type lien de la table principale>","field":"<colonne de la table liée>"}
  {"kind":"catalogue","column":"<colonne contenant le nom du mannequin>","photo":"visage"|"corps"}   (catalogue des mannequins Miraggia, à utiliser seulement si la table liée n'a pas les photos ou si la consigne le demande)
Règles :
- N'utilise QUE des tables et colonnes présentes dans le schéma, orthographiées exactement.
- Images : colonnes de type "fichiers" (directement, ou via un lien). Textes : colonnes texte / texte long / pose (directement ou via un lien).
- Les colonnes "texte long" ou nommées description/descriptif sont du texte brut à ajouter au prompt : mets-les dans "texts" sauf si la consigne dit le contraire.
- Ordre des images : visage du mannequin, corps du mannequin, fond, puis vêtements/produits, sauf consigne contraire.
- Si la consigne ne parle pas de pose, mets dans poseColumns les colonnes de type pose de la table principale.
- Le prompt artistique ne décrit pas les images une à une (Zulo ajoute automatiquement la liste numérotée des images) : il décrit le résultat voulu (style, lumière, cadrage, réalisme).
- Zulo ajoute AUTOMATIQUEMENT la pose du visuel (« POSE / VIEW: … ») : n'écris JAMAIS la pose dans le prompt artistique, ni une colonne de pose ({Vue et Pose 1} serait faux pour les visuels de la pose 2), ni {pose}.
- Nom de fichier : colonne d'identifiant (SKU, référence…) + {n} (numéro de la pose), ex. '{SKU}_{n}'. Jamais une colonne de pose.
- "max" : 1 pour un visage, un corps ou un fond ; 4 à 6 pour les photos de vêtements/produits (toutes les vues du produit aident).
- Si la consigne cite une seule colonne de pose alors qu'il en existe plusieurs du même genre (Vue et Pose 1, 2…), mets-les toutes et signale-le dans l'explication.`

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const consigne = String(body.consigne ?? '').trim()
    if (!consigne) return NextResponse.json({ error: 'Consigne vide.' }, { status: 400 })
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY manquante côté serveur.' }, { status: 500 })
    const text = `${INSTRUCTIONS}\n\nCatalogue Miraggia disponible : ${body.catalogue ? 'oui' : 'non'}\n\nSCHÉMA :\n${JSON.stringify(body.schema ?? [], null, 1)}\n\nCONSIGNE :\n${consigne}`
    let lastErr = ''
    for (const model of TEXT_MODELS) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } }),
      })
      const data: any = await res.json().catch(() => null)
      if (!res.ok) { lastErr = data?.error?.message ?? `HTTP ${res.status}`; if (res.status === 404 || /not found|not supported/i.test(lastErr)) continue; break }
      const out = (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('')
      try {
        const j = JSON.parse(out.replace(/^```json\s*|\s*```$/g, ''))
        return NextResponse.json({ recette: j.recette ?? j, explication: j.explication ?? '', model })
      } catch { lastErr = 'réponse illisible'; continue }
    }
    return NextResponse.json({ error: `Interprétation impossible : ${lastErr}` }, { status: 502 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Erreur inconnue' }, { status: 500 })
  }
}
