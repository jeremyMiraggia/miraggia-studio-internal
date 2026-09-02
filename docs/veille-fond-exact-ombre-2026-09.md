# Veille — fond client exact + ombre adaptée (mode / e-commerce)

Date : 2 septembre 2026. Périmètre : littérature 2024-2026 + APIs hébergées. Objectif : garder le fond fourni par le client **au pixel près**, avec une ombre de contact cohérente avec la pose du mannequin et la lumière du décor.

---

## 1. Le constat qui cadre tout

Aucun modèle génératif end-to-end ne préserve un fond au pixel près. Gemini 3 Pro Image ne propose que du « semantic masking » par texte (« change only X »), pas de masque pixel ; Imagen (qui avait l'inpainting masqué) a été arrêté le 24 juin 2026. Donc la préservation exacte du fond ne peut venir que d'une des deux mécaniques suivantes :

- **Paste-back** : on recolle les pixels originaux hors sujet (ce que fait déjà Pipeline V2 mode `custom`).
- **Inpainting masqué** : un modèle qui, par construction, ne touche qu'à l'intérieur d'un masque (FLUX.1 Fill, Kontext inpaint).

Toute la question est donc : **d'où vient l'ombre**, et comment elle se pose sur le fond sans raccord.

---

## 2. Les cinq familles de solutions

### A. Ombre récupérée de la sortie Gemini, appliquée en multiplicateur (training-free, CPU)

Idée : Gemini a déjà produit une ombre plausible pour cette pose dans ce décor. On la récupère par différence de luminance entre sortie recalée et fond original, puis `résultat = fond × clamp(gemini/fond, 0, 1)` dans la zone d'ombre.

Ancrage littérature : c'est le « shadow opacity ratio » de **ZeroComp** (WACV 2025) et l'« adaptive background blending » de **SHINE** (ICLR 2026), transposés du latent au pixel. Aucun papier ne fait exactement ça — c'est de l'ingénierie, pas de la recherche.

- Coût : 0 €. Node/sharp pur (arithmétique par pixel sur buffers raw). Pas de GPU.
- Risque : sur fond texturé ou décor, le bruit de repeinte de Gemini peut dépasser le seuil d'ombre. Sur cyclo / studio uni, ça marche.
- Prérequis : que Gemini ait effectivement produit une ombre (pas garanti — parfois il n'en met aucune).

### B. Modèle dédié de génération d'ombre (cutout + fond → ombre)

C'est une tâche académique à part entière (lignée bcmi / Shanghai Jiao Tong). Entrée : composite naïf + masque objet. Sortie : ombre. Le fond est préservé par construction puisque seule l'ombre est produite.

| Méthode | Venue | Code | Remarques |
|---|---|---|---|
| **Physics-grounded shadow generation** (Hu et al.) | arXiv 2512.06174, v2 mars 2026 | oui (Stony Brook) | ControlNet. Estime géométrie + direction de lumière dominante + **scores de confiance**. −23 % RMSE ombre vs SOTA. Le plus prometteur si auto-hébergé. |
| **VSDiffusion** | arXiv 2603.08020, mars 2026 | ? | 2 étapes : masque grossier puis diffusion conditionnée lumière + profondeur. |
| **CoShadow / MultiShadow** | arXiv 2603.02743, 2026 | ? | Multi-objets. Hors sujet pour nous. |
| **MetaShadow** (Adobe) | CVPR 2025 | non | Détection + suppression + synthèse contrôlée par référence. Le plus « produit », mais fermé. |
| **GPSDiffusion** | CVPR 2025 | oui (bcmi) | Prior géométrique. **256 px** — inutilisable en prod HD sans upscale de l'ombre. |
| **DESOBAv2 / SGDiffusion** | CVPR 2024 | oui | Dataset 21 k images **extérieur**. Pas de studio. |
| **ObjectDrop** (Google) | ECCV 2024 | non | Apprend ombres + reflets par contrefactuels. Fermé. |

Limite commune : **tous entraînés sur des objets, pas sur des humains en pose de mode.** Aucun dataset studio / cyclo. Les résultats sur une silhouette jambes écartées, bras tendu, restent à valider.

APIs industrielles de cette famille :

- **Photoroom AI Shadows** (`shadow.mode=ai.soft/ai.hard`) — déjà en place. Qualité bonne, **coût rédhibitoire** (1000 crédits épuisés en 200 visuels).
- **Claid.ai Shadow Generator** — même promesse, tarification à vérifier.
- **Pixelcut** — « sun positioning matrix » : on fixe la direction de lumière. Bulk 10 k images. Orienté produit.
- **Bria Product Shadow** (`/product/shadow`, aussi sur fal) — **ombre géométrique paramétrique** (offset, blur, ellipse). Pas scene-aware. Pas mieux que notre `buildContactShadow()`.

### C. Inpainting masqué sur une bande de sol (hébergé, pas de GPU)

Pipeline : Gemini → BiRefNet → paste-back sur le fond exact → **FLUX.1 Fill [pro]** (fal) avec masque = bande de sol autour des pieds (sujet exclu), prompt « soft studio contact shadow cast by the person, consistent with the scene lighting ». Tout ce qui est hors masque est intouché par construction.

- Coût : ~0,04-0,05 $/image sur fal. Pas d'infra.
- Le modèle voit le sujet et le fond, il infère la direction de lumière du décor.
- Risque : sur un sol texturé, Fill peut re-texturer légèrement l'intérieur de la bande. Sur cyclo / studio uni, invisible. Mitigation : masque étroit + feather, ou multiplier l'ombre Fill sur le fond original (combiner avec A).
- Alternative : `fal-ai/flux-kontext-lora/inpaint`, `fal-ai/flux-general/inpainting` (dev, licence non commerciale — à éviter en prod).

### D. Insertion générative end-to-end

Le sujet est **régénéré** dans la scène par un modèle de composition. Meilleure intégration lumière, mais on perd le contrôle Gemini sur pose et vêtement.

- **SHINE** (ICLR 2026, code) — training-free sur FLUX.1-dev. Licence non commerciale, GPU lourd.
- **Insert Anything** (AAAI 2026, code) — in-context editing DiT (FLUX Fill).
- **OSInsert** (bcmi, fév. 2026, code) — deux étapes authenticité → fidélité. Pertinent conceptuellement : c'est exactement notre tension (pose juste vs vêtement fidèle).
- **HOComp** (NeurIPS 2025, code) — humain-objet, interaction-aware.
- **OmniPaint** (ICCV 2025, code), **ObjectMate** (Google, ICCV 2025, fermé), **DreamFuse** (ICCV 2025, code).

Verdict : **non** pour l'e-commerce. Le risque de dérive du vêtement (couleur, motif, coupe) est le seul défaut qu'un client mode ne tolère pas, et c'est précisément ce que ces modèles ne garantissent pas.

### E. Relighting du sujet (complémentaire, pas une solution ombre)

- **IC-Light v1** background-conditioned (SD1.5, Apache 2.0) — utilisable commercialement. **v2** (Flux) — licence non commerciale. On l'a désactivé pour hallucination d'ombres de stores ; à ne réactiver qu'en secours QC.
- **MV-CoLight** (2025), **CFDiffusion** (ACM MM 2024) — relighting + ombre conjoints, code partiel.

---

## 3. Ce que fait la concurrence (Botika, Veeton, Fashn)

Rien de public sur leur compositing. Leur communication (« Models and backgrounds change, your design stays flawless ») indique qu'ils **génèrent** avec fond au choix, pas qu'ils garantissent un fond client pixel-identique. L'argument « fond garanti identique » est donc un différenciateur réel, pas un rattrapage.

---

## 4. Recommandation pour Miraggia

**Garder** : Gemini sur fond de couleur harmonisée → BiRefNet → `harmonizeBackground()` → paste-back. C'est la bonne base et le halo se traite là, pas dans l'ombre.

**Remplacer** `buildContactShadow()` (silhouette écrasée, toujours verticale) par un A/B sur 20 looks réels :

1. **Mode A — ombre Gemini multiplicative.** 0 €, Node pur. À implémenter en premier parce que c'est gratuit et que ça teste l'hypothèse « Gemini produit une ombre exploitable ».
2. **Mode C — FLUX Fill bande de sol.** ~0,05 $/img, hébergé, direction de lumière inférée du décor. Filet de sécurité quand A échoue (pas d'ombre Gemini, ou seuil pollué).

Les deux garantissent le fond exact hors masque. Photoroom reste en fallback manuel.

**Ne pas engager** : famille D (dérive vêtement), auto-hébergement de la famille B (GPU + modèles entraînés sur objets extérieurs) — sauf si un client à gros volume et décor unique justifie de fine-tuner le modèle Stony Brook sur ses propres packshots.

**QC minimal utile** : détection de halo par gradient à la frontière du masque, et vérification que la composante d'ombre touche bien la zone de contact du sujet. Le « SSIM hors masque = 0 » est vrai par construction — argument commercial, pas un contrôle.

---

## Sources

- Awesome Object Shadow Generation (bcmi) — https://github.com/bcmi/Awesome-Object-Shadow-Generation
- Awesome Generative Image Composition (bcmi) — https://github.com/bcmi/Awesome-Generative-Image-Composition
- Embedding Physical Reasoning into Diffusion-Based Shadow Generation — https://arxiv.org/abs/2512.06174 · projet https://shilin21.github.io/physical_generation/
- VSDiffusion — https://arxiv.org/abs/2603.08020
- CoShadow / MultiShadow — https://arxiv.org/abs/2603.02743
- MetaShadow (CVPR 2025) — https://arxiv.org/abs/2412.02635
- GPSDiffusion (CVPR 2025) — https://github.com/bcmi/GPSDiffusion-Object-Shadow-Generation
- DESOBAv2 (CVPR 2024) — https://github.com/bcmi/Object-Shadow-Generation-Dataset-DESOBAv2
- ObjectDrop (ECCV 2024) — https://arxiv.org/abs/2403.18818
- SHINE (ICLR 2026) — https://arxiv.org/abs/2509.21278
- OSInsert (2026) — https://arxiv.org/abs/2602.19523
- OmniPaint (ICCV 2025) — https://arxiv.org/abs/2503.08677
- ZeroComp (WACV 2025) — https://arxiv.org/abs/2410.08168
- MV-CoLight — https://arxiv.org/abs/2505.21483
- FLUX.1 Fill [pro] sur fal — https://fal.ai/models/fal-ai/flux-pro/v1/fill/api · BFL docs https://docs.bfl.ml/flux_1_fill
- Flux Kontext inpaint sur fal — https://fal.ai/models/fal-ai/flux-kontext-lora/inpaint/api
- Gemini image generation (semantic masking, pas de masque pixel) — https://ai.google.dev/gemini-api/docs/image-generation · Imagen shutdown https://firebase.google.com/docs/ai-logic/edit-images-imagen-overview
- Photoroom AI Shadows — https://docs.photoroom.com/image-editing-api-plus-plan/ai-shadows
- Bria Product Shadow — https://docs.bria.ai/product-shot-editing/product-endpoints/product-shadow
- Claid Shadow Generator — https://claid.ai/api-products/shadow-generator
- Pixelcut bulk shadows — https://www.pixelcut.ai/bulk/add-shadows
- Botika — https://botika.com/products · Veeton — https://veeton.com/alternatives/botika
