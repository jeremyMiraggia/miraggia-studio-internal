/**
 * Gold&Silver — génération lifestyle : IMAGE 1 = visage mannequin, IMAGE 2 = corps, puis tenue et détails,
 * prompt = REFERENCES + pose + décor condensé (Notion) + TECHNICAL. Entrée JSON avec URLs Blob.
 * En mode face, le prompt est construit ici : le nombre d'images de tenue et de chaussures dépend du classement des photos.
 */
import { NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import sharp from 'sharp'
import { compareSkin, detectHead, maskHead, type PhotoKind } from '@/lib/faceMask'
import { buildGoldSilverBackPrompt, buildGoldSilverDetailCloseupPrompt, buildGoldSilverPrompt, buildGoldSilverProfileToFrontPrompt, buildGoldSilverRawPrompt } from '@/lib/goldSilverPrompt'
import { imageFetch, imageProviderOf, withImageCost } from '@/lib/imageModel'

export const maxDuration = 300
export const runtime = 'nodejs'

const GEMINI_SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])

async function handlePOST(request: Request) {
  const provider = imageProviderOf(request)
  try {
    const body = await request.json().catch(() => ({}))
    const isUrl = (u: any) => typeof u === 'string' && /^https?:\/\//.test(u)
    const outfitUrls: string[] = (Array.isArray(body.outfitUrls) ? body.outfitUrls : (body.outfitUrl ? [body.outfitUrl] : [])).filter(isUrl)
    const faceUrl: string   = body.faceUrl ?? ''
    const bodyUrl: string   = isUrl(body.bodyUrl) ? body.bodyUrl : ''
    const detailUrls: string[] = (Array.isArray(body.detailUrls) ? body.detailUrls : (body.detailUrl ? [body.detailUrl] : [])).filter(isUrl)
    const promptOpts: any   = body.promptOpts ?? {}
    const ratio: string     = body.ratio ?? '2:3'
    const quality: string   = body.quality ?? '2K'
    const sku: string       = body.sku ?? ''
    // MODE BRUT : photos d'origine (ni compression, ni pixelisation), texte Notion seul, légendes d'une ligne,
    // aucune note ni vérification finale ajoutée par Zulo.
    const rawMode: boolean = body.raw === true
    const maskFaces: boolean = !rawMode && body.maskFaces !== false
    // mode 'back'    : IMAGE 1 = visuel de face validé (frontVisualUrl = VISUEL OK FRONT), faceUrl optionnel, outfitUrls = tenue vue de dos — ou, si fromDetail, gros plans DETAILS (de face) → close-up DE FACE
    // mode 'profile' : IMAGE 1 = visuel de profil validé (frontVisualUrl), outfitUrls = tenue vue de face portée par une autre personne
    const mode: 'front' | 'back' | 'profile' = body.mode === 'back' ? 'back' : body.mode === 'profile' ? 'profile' : 'front'
    const refMode = mode !== 'front'   // le prompt vient du navigateur, IMAGE 1 = visuel de référence déjà validé
    const closeup: boolean = body.framing === 'closeup'
    const frontVisualUrl: string = isUrl(body.frontVisualUrl) ? body.frontVisualUrl : ''

    if (outfitUrls.length === 0) return NextResponse.json({ error: 'Au moins une outfitUrl requise.' }, { status: 400 })
    if (mode === 'front' && !isUrl(faceUrl)) return NextResponse.json({ error: 'faceUrl requise.' }, { status: 400 })
    if (refMode && !frontVisualUrl)  return NextResponse.json({ error: `frontVisualUrl requise en mode ${mode}.` }, { status: 400 })
    if (mode === 'front' && !String(promptOpts.decorDescription ?? '').trim()) return NextResponse.json({ error: 'décor requis.' }, { status: 400 })

    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY manquante.' }, { status: 500 })

    // ===== Masquage tête (visage + cheveux) sur les photos de tenue PORTÉE =====
    // Vêtement à plat / packshot → aucune personne détectée → image inchangée.
    // En mode face, la même détection classe aussi chaque photo (portée, cintre, à plat, chaussures seules).
    type OutfitPart = { part: any; masked: boolean; maskedUrl?: string; note?: string; kind?: PhotoKind; worn?: { buf: Buffer; mime: string } }
    const outfits: OutfitPart[] = []
    // Visage du mannequin : obligatoire en mode face, optionnel en Profil → Face (envoyé si le mannequin est connu)
    const faceImg = mode === 'front' || (refMode && isUrl(faceUrl)) ? await fetchImage(faceUrl) : null
    for (const u of outfitUrls) {
      const { buf, mime } = await fetchImage(u)
      const det = await detectHead(buf, mime, apiKey)
      const kind = det.kind, worn = det.hasPerson ? { buf, mime } : undefined
      if (kind === 'shoes') { outfits.push({ part: toPart(buf, mime), masked: false, kind, worn, note: 'chaussures à porter' }); continue }
      if (!maskFaces) { outfits.push({ part: toPart(buf, mime), masked: false, kind, worn }); continue }
      if (!det.hasPerson) { outfits.push({ part: toPart(buf, mime), masked: false, kind, worn, note: det.error ? `détection échouée : ${det.error.slice(0, 80)}` : 'pas de personne (vêtement non porté)' }); continue }
      if (!det.box) { outfits.push({ part: toPart(buf, mime), masked: false, kind, worn, note: `⚠ non masqué : ${det.error ?? 'tête non localisée'}` }); continue }
      try {
        const m = await maskHead(buf, det.box)
        let maskedUrl: string | undefined
        try {
          const b = await put(`gold-silver-masked/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`, m.buf, {
            access: 'public', contentType: 'image/jpeg', cacheControlMaxAge: 300, token: process.env.BLOB_READ_WRITE_TOKEN,
          })
          maskedUrl = b.url
        } catch { /* vignette non disponible, on continue */ }
        outfits.push({ part: toPart(m.buf, m.mime), masked: true, maskedUrl, kind, worn })
      } catch (e: any) {
        outfits.push({ part: toPart(buf, mime), masked: false, kind, worn, note: `masquage échoué : ${e?.message ?? e}` })
      }
    }
    const anyMasked = outfits.some(o => o.masked)

    // Mode face : les chaussures seules sont séparées de la tenue (jamais envoyées en close-up, hors cadre).
    // Si tout est classé « chaussures », on ne sépare rien : il faut au moins une image de tenue.
    const hasGarment = outfits.some(o => o.kind !== 'shoes')
    // Profil → Face : les chaussures seules ne sont pas envoyées, le mannequin garde celles du visuel validé (IMAGE 1)
    const garments = hasGarment ? outfits.filter(o => o.kind !== 'shoes') : outfits
    if (mode === 'profile' && hasGarment) for (const o of outfits) if (o.kind === 'shoes') o.note = 'chaussures seules : non envoyées (celles du visuel validé sont gardées)'
    const shoes = mode !== 'profile' && hasGarment && !closeup ? outfits.filter(o => o.kind === 'shoes') : []
    const nOut = garments.length

    const rawOutfitLabel = nOut === 1 ? `IMAGE ${bodyUrl ? 3 : 2}` : `IMAGES ${bodyUrl ? 3 : 2} à ${(bodyUrl ? 3 : 2) + nOut - 1}`
    // Face → Dos : sans Files (Back), pas de dos possible → close-up DE FACE du visuel validé, gros plan DETAILS en guide
    const fromDetail = mode === 'back' && body.fromDetail === true
    const prompt = fromDetail ? buildGoldSilverDetailCloseupPrompt({
      ratio, sku: promptOpts.sku, detailCount: nOut, detailText: promptOpts.detailText,
      modelDescription: promptOpts.modelDescription, poseDirection: promptOpts.poseDirection, hasFace: !!faceImg,
    }) : mode === 'back' ? buildGoldSilverBackPrompt({
      ratio, sku: promptOpts.sku, backCount: nOut, shoesCount: shoes.length, detailText: promptOpts.detailText,
      modelDescription: promptOpts.modelDescription, framing: closeup ? 'closeup' : 'full', poseDirection: promptOpts.poseDirection,
      hasFace: !!faceImg,
    }) : mode === 'front' && rawMode ? buildGoldSilverRawPrompt({
      decorDescription: String(promptOpts.decorDescription), outfitLabel: rawOutfitLabel, detailText: promptOpts.detailText, closeup,
    }) : mode === 'profile' ? buildGoldSilverProfileToFrontPrompt({
      ratio, sku: promptOpts.sku, outfitCount: nOut, detailText: promptOpts.detailText, modelDescription: promptOpts.modelDescription,
      framing: closeup ? 'closeup' : 'full', poseDirection: promptOpts.poseDirection, hasFace: !!faceImg,
    }) : buildGoldSilverPrompt({
      decorName: String(promptOpts.decorName ?? ''), decorDescription: String(promptOpts.decorDescription),
      ratio, sku: promptOpts.sku, detailText: promptOpts.detailText, modelDescription: promptOpts.modelDescription,
      framing: closeup ? 'closeup' : 'full',
      outfitCount: nOut, shoesCount: shoes.length, hasBody: !!bodyUrl, detailCount: detailUrls.length,
    })
    const sessionId = Date.now()
    const parts: any[] = [{ text: `[SESSION ${sessionId}]\n${prompt}` }]

    if (mode === 'profile') {
      // IMAGE 1 = visuel de profil validé ; IMAGES 2..n+1 = tenue de face portée par une autre personne (tête masquée)
      const refImg = await fetchImage(frontVisualUrl)
      const first = faceImg ? 3 : 2   // première image de tenue
      if (anyMasked) {
        parts.push({ text: 'NOTE ON THE OUTFIT REFERENCES: the head (face and hair) of the person wearing the garment has been INTENTIONALLY pixelated. Ignore that person entirely — she is NOT the model. The model is the one in IMAGE 1. Do not reproduce any pixelation.' })
      }
      // Peau : si la personne de la photo de tenue a une peau nettement différente du mannequin, on le dit explicitement
      const skinChecks = rawMode ? [] : await Promise.all(garments.map(o => o.worn ? compareSkin(refImg, o.worn, apiKey).catch(() => null) : Promise.resolve(null)))
      const skinClash = skinChecks.map((c, i) => ({ i, c })).filter(x => x.c && x.c.verdict !== 'similar')
      if (skinClash.length) {
        const c = skinClash[0].c!
        parts.push({ text: `⚠ SKIN TONE: the person wearing the garment in ${skinClash.map(x => `IMAGE ${x.i + first}`).join(', ')} has a clearly ${c.verdict === 'darker' ? 'DARKER' : 'LIGHTER'} skin tone${c.wearer ? ` (${c.wearer})` : ''} than the model. She is NOT the model — take ONLY the garment from that photo. EVERY visible skin area of the final image (face, neck, chest, shoulders, arms, hands, legs, feet) must have the model's own ${c.model ? `${c.model} ` : ''}skin tone and undertone, exactly as in IMAGE 1, uniform from head to toe.` })
        for (const x of skinClash) garments[x.i].note = [garments[x.i].note, `peau ${x.c!.verdict === 'darker' ? 'plus foncée' : 'plus claire'} que le mannequin : signalée à Gemini`].filter(Boolean).join(' · ')
      }
      parts.push({ text: '=== IMAGE 1 — VALIDATED PROFILE PHOTOGRAPH: same model, same place, same light, same style to keep ===' })
      parts.push(toPart(refImg.buf, refImg.mime))
      if (faceImg) {
        parts.push({ text: '=== IMAGE 2 — MODEL FACE, front view: same person as IMAGE 1 (exact facial features; not its light or background) ===' })
        parts.push(toPart(faceImg.buf, faceImg.mime))
      }
      for (let i = 0; i < nOut; i++) {
        parts.push({ text: `=== IMAGE ${i + first} — OUTFIT${nOut > 1 ? ` (photo ${i + 1}/${nOut})` : ''}, worn by another person (reproduce this garment exactly, ignore that person) ===` })
        parts.push(garments[i].part)
      }
      const framingCheck = closeup ? 'CLOSE-UP from above the head to the waist/hips, legs and feet out of frame' : 'same shoes as IMAGE 1, feet fully visible'
      const poseCheck = body.customPose ? 'pose as described in POSE & ADJUSTMENTS' : 'facing the camera, relaxed and composed'
      if (!rawMode) parts.push({ text: `⚠ FINAL CHECK : ONE photograph from the FRONT · same model (face identical to ${faceImg ? 'IMAGE 2, as the person of IMAGE 1' : 'IMAGE 1'}) and same scene as IMAGE 1 · front of the garment identical to ${nOut === 1 ? `IMAGE ${first}` : `IMAGES ${first}-${first + nOut - 1}`} · all visible skin has the model's skin tone from IMAGE 1, never the outfit wearer's · ${framingCheck} · ${poseCheck} · natural human proportions and anatomy · same light, film look and mood as IMAGE 1 · no text, no collage.` })
    } else if (mode === 'back') {
      // IMAGE 1 = visuel de face validé (VISUEL OK FRONT) ; IMAGE 2 = visage (si connu) ; puis tenue de dos (ou gros plan DETAILS) ; puis chaussures
      const first = faceImg ? 3 : 2
      if (anyMasked) {
        parts.push({ text: 'NOTE ON THE BACK-VIEW OUTFIT REFERENCES: the head of the person wearing the garment may be INTENTIONALLY pixelated. Ignore that person — the model is the one in IMAGE 1. Do not reproduce any pixelation.' })
      }
      parts.push({ text: '=== IMAGE 1 — VALIDATED FRONT PHOTOGRAPH: same model, same place, same light, same style to keep ===' })
      parts.push(await toInlinePart(frontVisualUrl))
      if (faceImg) {
        parts.push({ text: '=== IMAGE 2 — MODEL FACE, front view: same person as IMAGE 1 (identity and hair only; not its light or background) ===' })
        parts.push(toPart(faceImg.buf, faceImg.mime))
      }
      for (let i = 0; i < nOut; i++) {
        parts.push({ text: fromDetail
          ? `=== IMAGE ${i + first} — CLOSE-UP DETAIL of the front of the garment${nOut > 1 ? ` (photo ${i + 1}/${nOut})` : ''} (fabric and finishes — do not copy its framing) ===`
          : `=== IMAGE ${i + first} — OUTFIT seen from the BACK${nOut > 1 ? ` (photo ${i + 1}/${nOut})` : ''} (reproduce the back of this garment exactly) ===` })
        parts.push(garments[i].part)
      }
      for (let i = 0; i < shoes.length; i++) {
        parts.push({ text: `=== IMAGE ${first + nOut + i} — SHOES, same pair as in IMAGE 1 (heel and back of the shoes) ===` })
        parts.push(shoes[i].part)
      }
      const refs = nOut === 1 ? `IMAGE ${first}` : `IMAGES ${first}-${first + nOut - 1}`
      const framingCheck = closeup ? 'CLOSE-UP from above the head to the waist/hips, legs and feet out of frame' : 'same shoes as IMAGE 1, feet fully visible'
      const poseCheck = body.customPose ? 'pose as described in POSE & ADJUSTMENTS' : 'standing still, relaxed and composed (no walking)'
      if (!rawMode && fromDetail) parts.push({ text: `⚠ FINAL CHECK : ONE CLOSE-UP photograph from the FRONT (head to waist/hips, no legs, no feet) · same model${faceImg ? ' (face identical to IMAGE 2, as the person of IMAGE 1)' : ''}, same outfit and same scene as IMAGE 1, seen closer · fabric and finishes faithful to ${refs} · calm gaze to camera · same light, film look and mood as IMAGE 1 · no text, no collage.` })
      else if (!rawMode) parts.push({ text: `⚠ FINAL CHECK : ONE photograph from BEHIND · same model${faceImg ? ' (identity and hair as IMAGES 1-2)' : ''} and same scene as IMAGE 1 · back of the garment identical to ${refs} · ${framingCheck} · ${poseCheck} · same light, film look and mood as IMAGE 1 · no text, no collage.` })
    } else if (rawMode) {
      // MODE BRUT vue de face : visage, corps, tenue, chaussures — une ligne par image (pas de détails)
      const L: [string, any][] = [['visage du mannequin', toPart(faceImg!.buf, faceImg!.mime)]]
      if (bodyUrl) L.push(['corps du mannequin (même personne)', await toInlinePart(bodyUrl)])
      for (let i = 0; i < nOut; i++) L.push([nOut === 1 ? 'tenue' : `tenue (photo ${i + 1}/${nOut})`, garments[i].part])
      for (const sh of shoes) L.push(['chaussures à porter (si les pieds sont dans le cadre)', sh.part])
      L.forEach(([label, part], i) => { parts.push({ text: `IMAGE ${i + 1} — ${label}` }); parts.push(part) })
    } else {
    // Le mannequin toujours en premier : IMAGE 1 = visage, IMAGE 2 = corps (si présent), puis tenue, puis détails
    parts.push({ text: '=== IMAGE 1 — MODEL FACE (preserve this exact identity) ===' })
    parts.push(toPart(faceImg!.buf, faceImg!.mime))
    let next = 2
    if (bodyUrl) {
      parts.push({ text: '=== IMAGE 2 — MODEL BODY, same person (skin tone, build, silhouette — not the pose, not the background) ===' })
      parts.push(await toInlinePart(bodyUrl))
      next = 3
    }
    const firstOutfit = next
    const outfitLabel = nOut === 1 ? `IMAGE ${firstOutfit}` : `IMAGES ${firstOutfit}-${firstOutfit + nOut - 1}`
    if (anyMasked) {
      parts.push({ text: 'NOTE ON THE OUTFIT REFERENCES: the head (face and hair) of the person wearing the garment has been INTENTIONALLY pixelated. Ignore that person entirely — she is NOT the model. The ONLY identity reference is the MODEL FACE image (IMAGE 1). Do not reproduce any pixelation in the output.' })
    }
    // Peau : la personne qui porte la tenue n'est pas le mannequin. Flash compare sa peau à celle du mannequin (photo visage) ;
    // si elle est nettement différente, on le dit explicitement à Gemini (sinon il reprend la couleur des bras / jambes de la photo).
    const modelSkinRef = bodyUrl ? 'IMAGES 1-2' : 'IMAGE 1'
    const skinChecks = await Promise.all(garments.map(g => g.worn ? compareSkin(faceImg!, g.worn, apiKey).catch(() => null) : Promise.resolve(null)))
    const skinClash = skinChecks.map((c, i) => ({ i, c })).filter(x => x.c && x.c.verdict !== 'similar')
    if (skinClash.length) {
      const imgs = skinClash.map(x => `IMAGE ${firstOutfit + x.i}`).join(', ')
      const c = skinClash[0].c!
      const tone = c.model ? `${c.model} ` : ''
      parts.push({ text: `⚠ SKIN TONE: the person wearing the garment in ${imgs} has a clearly ${c.verdict === 'darker' ? 'DARKER' : 'LIGHTER'} skin tone${c.wearer ? ` (${c.wearer})` : ''} than the model. She is NOT the model — take ONLY the garment from that photo. EVERY visible skin area of the final image (face, neck, chest, shoulders, arms, hands, legs, feet) must have the model's own ${tone}skin tone and undertone, exactly as in ${modelSkinRef}, uniform from head to toe.` })
      for (const x of skinClash) garments[x.i].note = [garments[x.i].note, `peau ${x.c!.verdict === 'darker' ? 'plus foncée' : 'plus claire'} que le mannequin : signalée à Gemini`].filter(Boolean).join(' · ')
    }
    const kindNote = (k?: PhotoKind) => k === 'hanger' ? ', on a hanger (ignore the hanger, rack, labels and background)'
      : k === 'flat' ? ', laid flat (ignore the surface and background)' : ''
    for (let i = 0; i < nOut; i++) {
      parts.push({ text: nOut === 1
        ? `=== IMAGE ${firstOutfit} — OUTFIT, front view${kindNote(garments[i].kind)} (reproduce this garment exactly) ===`
        : `=== IMAGE ${firstOutfit + i} — OUTFIT, photo ${i + 1}/${nOut} of the SAME garment${kindNote(garments[i].kind)} ===` })
      parts.push(garments[i].part)
    }
    next = firstOutfit + nOut
    const firstShoes = next
    for (let i = 0; i < shoes.length; i++) {
      parts.push({ text: `=== IMAGE ${next + i} — SHOES the model must wear (not part of the garment) ===` })
      parts.push(shoes[i].part)
    }
    next += shoes.length
    const shoesCheck = shoes.length === 1 ? `shoes identical to IMAGE ${firstShoes}` : shoes.length > 1 ? `shoes identical to IMAGES ${firstShoes}-${next - 1}` : 'same shoes'
    for (let i = 0; i < detailUrls.length; i++) {
      parts.push({ text: `=== IMAGE ${next + i} — CLOSE-UP DETAIL of the same garment (fidelity guide only — do NOT copy its framing) ===` })
      parts.push(await toInlinePart(detailUrls[i]))
    }
    parts.push({ text: closeup
      ? `⚠ FINAL CHECK : ONE front-view CLOSE-UP / upper mid-body photograph (head to hips at most, no legs, no feet, no shoes) · garment identical to ${outfitLabel} (cut, color, print, details) · face identical to IMAGE 1, sharp · neck, arms and hands with the model's skin tone from ${modelSkinRef} · pose as described · scene, light, film look and mood exactly as described · no text, no collage.`
      : `⚠ FINAL CHECK : ONE front-view photograph · garment identical to ${outfitLabel} (cut, color, print, details) · ${shoesCheck} · framing as described in the scene · face identical to IMAGE 1 · all visible skin (neck, arms, hands, legs) has the model's skin tone from ${modelSkinRef}, never the outfit wearer's · natural human proportions and anatomy · ONE pose, as described in the scene · scene, light, film look and mood exactly as described · no text, no collage.` })
    }

    const payloadMB = parts.reduce((n, p) => n + (p.inlineData?.data?.length ?? 0), 0) / 1e6
    if (payloadMB > 90) return NextResponse.json({ error: `Images trop lourdes pour Gemini (${payloadMB.toFixed(0)} Mo, max ~90 Mo). Décoche le mode brut ou allège les photos dans Notion.` }, { status: 413 })
    const imageSize = quality === '4K' ? '4K' : quality === '1K' ? '1K' : '2K'
    const geminiRes = await imageFetch(provider,
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${apiKey}`,
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: ratio, imageSize } },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
          ],
        }),
      },
    )
    const data: any = await geminiRes.json().catch(() => null)
    if (!geminiRes.ok) return NextResponse.json({ error: data?.error?.message || `Gemini HTTP ${geminiRes.status}` }, { status: geminiRes.status })
    const gParts = data?.candidates?.[0]?.content?.parts ?? []
    let b64: string | null = null, mime = 'image/png'
    for (const p of gParts) if (p?.inlineData?.mimeType?.startsWith('image/')) { b64 = p.inlineData.data; mime = p.inlineData.mimeType; break }
    if (!b64) {
      const txt = gParts.filter((p: any) => typeof p?.text === 'string').map((p: any) => p.text).join(' ').slice(0, 300)
      return NextResponse.json({ error: `Gemini sans image. ${txt}` }, { status: 502 })
    }

    const raw = Buffer.from(b64, 'base64')
    let finalBuf: Buffer = raw, finalMime = mime
    try { finalBuf = await sharp(raw).jpeg({ quality: 94, progressive: true, mozjpeg: true }).toBuffer(); finalMime = 'image/jpeg' } catch { /* raw */ }

    let imageUrl: string, blobError: string | undefined
    try {
      const blob = await put(`gold-silver/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${(sku || 'look').replace(/[^\w-]+/g, '_')}.${finalMime === 'image/png' ? 'png' : 'jpg'}`, finalBuf, {
        access: 'public', contentType: finalMime, cacheControlMaxAge: 60, token: process.env.BLOB_READ_WRITE_TOKEN,
      })
      imageUrl = blob.url
    } catch (e: any) {
      imageUrl = `data:${finalMime};base64,${finalBuf.toString('base64')}`
      blobError = e?.message ?? String(e)
    }
    return NextResponse.json({
      imageUrl, blobError,
      masks: outfits.map(o => ({ masked: o.masked, maskedUrl: o.maskedUrl, note: o.note })),
    })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? 'Erreur inconnue' }, { status: 500 })
  }
}

async function fetchImage(url: string): Promise<{ buf: Buffer; mime: string }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Image inaccessible (${res.status}) : ${url.slice(0, 80)}`)
  let mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim()
  let buf = Buffer.from(new Uint8Array(await res.arrayBuffer()))
  if (!GEMINI_SUPPORTED.has(mime)) {
    try { buf = await sharp(buf).jpeg({ quality: 90 }).toBuffer(); mime = 'image/jpeg' } catch { /* tel quel */ }
  }
  return { buf, mime }
}
function toPart(buf: Buffer, mime: string) {
  return { inlineData: { mimeType: mime, data: buf.toString('base64') } }
}
async function toInlinePart(url: string) {
  const { buf, mime } = await fetchImage(url)
  return toPart(buf, mime)
}

// Coût réel des générations renvoyé en en-tête x-image-cost
export const POST = withImageCost(handlePOST)
