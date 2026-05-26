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
            temperature: 0.35,
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

const EXTRACTOR_PROMPT = `Tu es directeur artistique pour une marque de mode haut de gamme. Tu rédiges des PROMPTS TRÈS DÉTAILLÉS, prêts à recoller dans un générateur d'images IA de mode.

Pour cette photo, renvoie STRICTEMENT un JSON { "environnement": string, "pose": string }.

⚙️ FORMAT DE SORTIE
Chaque champ doit être écrit comme un PROMPT, c'est-à-dire :
- une suite dense de fragments descriptifs (mots-clés et courtes propositions séparés par des virgules)
- pas de phrases narratives ("on voit", "le mannequin est…", "la photo montre")
- vocabulaire technique mode / photo en français + anglicismes courants (golden hour, blue hour, low-key, high-key, contre-jour, side-light, rim light, fill light, key light, soft box, hard light, bokeh, shallow DoF, etc.)
- ton éditorial mode haut de gamme, précis, sensoriel
- TOUJOURS très détaillé : viser la PRÉCISION SPÉCIFIQUE, pas le générique. Préférer "ruelle pavée en pierre calcaire ocre" à "rue ancienne".

🌅 CHAMP "environnement" (120–200 mots, séparés par virgules)
Tu dois être ULTRA-PRÉCIS. Couvre TOUS ces axes quand ils sont visibles :
1. LIEU PRÉCIS : type de lieu, géographie / culture suggérée, intérieur ou extérieur
2. DÉCOR / ARCHITECTURE / PAYSAGE : éléments nommés (murs en pierre, colonnade, vitrine, escalier en colimaçon, dune, palmier, oliveraie…), textures, matériaux, état (usé, neuf, patiné)
3. PROPS visibles (mobilier, plantes, véhicule, objet posé, drapé…)
4. PALETTE CHROMATIQUE : 3-5 nuances précises ("ocre brûlé, blanc cassé, vert sauge poussiéreux")
5. LUMIÈRE : source (soleil direct, fenêtre, néon, lampe tungstène, lune…), direction (frontale, contre-jour, side-light gauche/droite, top-light…), dureté (hard / soft / diffuse), température (warm 2700K, cool 5500K…), qualité (golden hour, blue hour, overcast, midi écrasé…)
6. ATMOSPHÈRE / AMBIANCE : moodboard en mots (méditerranéen langoureux, brutaliste froid, romantique nostalgique…)
7. MÉTÉO + HEURE
8. PHOTO : focale ressentie (28/35/50/85mm), profondeur de champ (shallow DoF, deep focus, bokeh crémeux), grain / pellicule simulée (Portra 400, Tri-X, Ektachrome, numérique propre), halations, vignettage, aberration chromatique, tilt-shift…

📐 CHAMP "pose" (100–160 mots, séparés par virgules)
DOIT contenir, dans cet ordre :
1. ANGLE DE VUE de la caméra : low-angle / high-angle / eye-level / bird's eye / dutch angle / overhead / worm's-eye, avec hauteur ressentie de l'objectif (genoux, taille, poitrine, yeux, au-dessus de la tête)
2. TYPE DE PLAN / CADRAGE : full body / american shot (plan américain, coupe genoux) / cowboy shot (mi-cuisse) / half-body / bust shot / close-up / extreme close-up / over-the-shoulder / wide shot, et focale équivalente ressentie (28/35/50/85/135mm)
3. ORIENTATION du sujet par rapport à la caméra : face caméra / profil gauche / profil droit / 3/4 face gauche / 3/4 face droite / 3/4 dos gauche / 3/4 dos droite / dos complet
4. POSTURE GLOBALE : debout contrapposto, debout symétrique, assis(e), accroupi(e), agenouillé(e), allongé(e) sur le côté/dos/ventre, appuyé(e) à un mur/banc, marche figée, en mouvement (saut, twirl), pose dynamique…
5. POIDS DU CORPS + TENSION : poids sur la jambe gauche/droite, hanche décalée, épaules abaissées/redressées, dos cambré ou relâché, tension dans les abdos…
6. JAMBES : position exacte (jambe avant fléchie, croisée, en arrière, écartée, talon levé…)
7. BRAS / MAINS : où ils sont, ce qu'ils font (main gauche dans la poche, bras droit relâché, main effleurant la nuque, doigts effilés, paume ouverte…)
8. TÊTE : inclinaison (droite, légèrement penchée gauche/droite, baissée, relevée), tilt en degrés ressenti
9. REGARD : caméra direct / hors-cadre gauche / hors-cadre droite / baissé / vers le haut / yeux fermés / au loin
10. EXPRESSION / MICRO-ATTITUDE : mâchoire détendue, lèvres entrouvertes, sourire absent, intensité retenue, sérénité, mélancolie maîtrisée, etc.

🚫 INTERDICTIONS STRICTES — ne mentionne JAMAIS :
- vêtements, matières, couleurs portées, accessoires, bijoux, chaussures, sacs
- mannequin physiquement : peau (couleur, texture), cheveux (couleur, longueur, coupe, coiffure), âge, genre, ethnicité, maquillage, morphologie, taille
- marques, logos, textes visibles
- prénoms / noms propres

🚫 INTERDICTIONS RENFORCÉES (révèlent indirectement la tenue) — ne mentionne JAMAIS :
- pieds nus, "barefoot", talons, chaussettes, semelles, bottes, sandales, chaussures de tout type
- jambes nues, bras nus, épaules dénudées, dos nu, torse nu, décolleté, peau apparente
- mains gantées, ongles vernis, manucure
- collier, bague, boucles d'oreilles, montre, ceinture, foulard, chapeau, casquette, lunettes
- coiffure, mèche, frange, chignon, queue de cheval, cheveux mouillés
- maquillage visible (rouge à lèvres, eye-liner, mascara, fard, bronzage)
- toute formulation qui dépend de ce qui est porté ou non par le sujet

Le résultat doit pouvoir s'appliquer à TOUTE tenue (bikini comme manteau d'hiver) sans modification.

Si l'image n'a pas de personne, mets "—" dans "pose" et décris quand même le décor.

Exemple de niveau attendu pour "pose" :
"low-angle shot à hauteur de hanche, plan américain 50mm, 3/4 face caméra côté droit, debout en contrapposto marqué, poids sur la jambe gauche, hanche droite décalée vers l'extérieur, épaule gauche légèrement abaissée, jambe avant droite fléchie genou souple, talon droit légèrement soulevé, main gauche enfoncée dans la poche, bras droit pendant le long du corps doigts détendus, tête inclinée 10° vers la gauche, regard hors-cadre droite à mi-hauteur, mâchoire détendue, lèvres closes, expression neutre intense, présence affirmée".

Réponds uniquement avec le JSON valide, sans markdown, sans préambule.`

function truncate(s: string, max = 300) {
  if (!s) return ''
  return s.length > max ? s.slice(0, max) + '…' : s
}
