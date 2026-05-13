import { NextResponse } from 'next/server'

export const maxDuration = 300

/**
 * Extracteur de prompt — Gemini vision.
 *
 * Body (FormData) :
 *   - images : File[]   (1..N images à analyser, clé répétée)
 *
 * Response :
 *   { results: Array<{ index: number, filename: string, environnement?: string, pose?: string, error?: string }> }
 *
 * Pour chaque image, Gemini renvoie un objet { environnement, pose } décrivant
 * UNIQUEMENT le décor et la pose, sous forme de PROMPT mode prêt à l'emploi —
 * pas la tenue, pas le mannequin.
 */
export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const images = formData.getAll('images').filter((v): v is File => v instanceof File)

    if (!images.length) {
      return NextResponse.json({ error: 'Aucune image fournie.' }, { status: 400 })
    }

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY manquante côté serveur.' }, { status: 500 })
    }

    // Toutes les analyses en parallèle (rapide + résilient par item)
    const tasks = images.map(async (file, idx) => {
      try {
        const buf  = Buffer.from(await file.arrayBuffer()).toString('base64')
        const mime = file.type || 'image/jpeg'

        const body = {
          contents: [{
            parts: [
              { text: EXTRACTOR_PROMPT },
              { inlineData: { mimeType: mime, data: buf } },
            ],
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                environnement: { type: 'STRING' },
                pose:          { type: 'STRING' },
              },
              required: ['environnement', 'pose'],
            },
            temperature: 0.4,
          },
        }

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        )

        if (!res.ok) {
          const txt = await res.text()
          return { index: idx, filename: file.name, error: `HTTP ${res.status} : ${truncate(txt)}` }
        }

        const data = await res.json()
        const raw  = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
        try {
          const parsed = JSON.parse(raw)
          return {
            index: idx,
            filename: file.name,
            environnement: String(parsed.environnement ?? '').trim(),
            pose:          String(parsed.pose          ?? '').trim(),
          }
        } catch {
          return { index: idx, filename: file.name, error: `Réponse non-JSON : ${truncate(raw)}` }
        }
      } catch (e: any) {
        return { index: idx, filename: file.name, error: e?.message ?? 'Erreur inconnue' }
      }
    })

    const results = await Promise.all(tasks)
    return NextResponse.json({ results })

  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue' }, { status: 500 })
  }
}

const EXTRACTOR_PROMPT = `Tu es directeur artistique pour une marque de mode haut de gamme. Tu rédiges des PROMPTS PRÊTS À L'EMPLOI pour un générateur d'images IA de mode.

Pour cette photo, renvoie STRICTEMENT un JSON { "environnement": string, "pose": string }.

⚙️ FORMAT DE SORTIE (très important)
Chaque champ doit être écrit comme un PROMPT, c'est-à-dire :
- une suite dense de fragments descriptifs (mots-clés et courtes propositions séparés par des virgules)
- pas de phrases complètes narratives ("le mannequin est…"), pas de "on voit", pas de "la photo montre"
- vocabulaire technique mode / photo en français + anglicismes courants du milieu (golden hour, low-key, contre-jour, side-light, rim light, fill light, grain argentique, bokeh, depth of field, etc.)
- ton éditorial mode haut de gamme

🌅 CHAMP "environnement" (60–120 mots, séparés par virgules)
Décris uniquement le décor : lieu / type de lieu, époque visuelle, architecture ou paysage, props, palette chromatique, météo, heure de la journée, qualité de la lumière (source, direction, dureté, température), atmosphère, grain / texture / médium photographique simulé.

📐 CHAMP "pose" (60–110 mots, séparés par virgules)
DOIT impérativement contenir, dans l'ordre suivant :
1. ANGLE DE VUE de la caméra : low-angle / high-angle / eye-level / bird's eye / dutch angle / overhead, hauteur de l'objectif
2. TYPE DE PLAN / cadrage : full body / american shot (plan américain) / cowboy shot / half-body / bust shot / close-up / extreme close-up / over-the-shoulder, éventuelle focale équivalente (35mm, 50mm, 85mm…)
3. ORIENTATION du sujet face à la caméra : face caméra / profil gauche / profil droit / 3/4 face / 3/4 dos / dos
4. POSTURE du corps : debout contrapposto, assis(e), accroupi(e), allongé(e), appuyé(e) à…, marche figée, en mouvement, sauté…
5. BRAS / MAINS / JAMBES : où sont-ils, ce qu'ils font (main dans la poche, bras croisés, main à la nuque, jambe avant fléchie, etc.)
6. REGARD : caméra direct / hors-cadre gauche / hors-cadre droite / baissé / vers le haut / yeux fermés
7. EXPRESSION : neutre, intense, songeuse, sans sourire, légère esquisse de sourire…

🚫 INTERDICTIONS STRICTES — ne mentionne JAMAIS :
- les vêtements, matières, couleurs portées, accessoires, bijoux, chaussures, sacs
- le mannequin physiquement : peau, cheveux (couleur, longueur, coupe), âge, genre, ethnicité, maquillage, morphologie, taille
- les marques, logos, textes visibles
- des prénoms ou noms propres

Si l'image ne contient pas de personne, écris "—" dans "pose" et décris quand même le décor.

Exemple de style attendu pour "pose" :
"low-angle shot, plan américain 50mm, 3/4 face caméra, debout en contrapposto, hanche droite décalée, main gauche dans la poche, bras droit relâché le long du corps, jambe avant fléchie, regard hors-cadre droite, expression neutre intense, mâchoire détendue".

Réponds uniquement avec le JSON valide, sans markdown, sans préambule.`

function truncate(s: string, max = 300) {
  if (!s) return ''
  return s.length > max ? s.slice(0, max) + '…' : s
}
