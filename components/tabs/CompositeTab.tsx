'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import Dropzone from '@/components/ui/Dropzone'
import { compressAll, compressImage } from '@/lib/compressImage'
import { parseNotionExport, type GenerationTask, type ParsedExport } from '@/lib/notion/parseExport'
import { segmentForeground, compositeOnBackground, fillSegmentationHoles, blobToDataUrl, dataUrlToBlob } from '@/lib/composite'
import { VIEW_CATALOG, POSE_CATALOG } from '@/lib/poses'

type TaskStatus = 'pending' | 'running' | 'done' | 'error'

type TaskState = {
  task:    GenerationTask
  status:  TaskStatus
  enabled: boolean
  imageUrlGemini?:    string   // étape 1 : sortie Gemini brute (mannequin + scène)
  imageUrlSegmented?: string   // étape 2 : mannequin sur fond transparent
  imageUrlComposite?: string   // étape 3 : composite (fond ref + mannequin), AVANT passe ombre
  imageUrl?:          string   // étape 4 : composite + ombre Gemini (ou étape 3 si pas d'ombre)
  error?: string
  faceUsed?:         boolean
  faceWasAvailable?: boolean
  progressStep?: 'gemini' | 'segment' | 'composite' | 'shadow' | 'done'
}

function sanitizeFilename(s: string): string {
  return s
    .replace(/[\/\\:*?"<>|]/g, '_')   // caractères interdits Windows
    .replace(/\s+/g, '_')                 // espaces -> _
    .replace(/_+/g, '_')                   // _ multiples -> 1 seul
    .replace(/^_|_$/g, '')                 // pas de _ au début/fin
    .slice(0, 80)                          // limite à 80 chars
    || 'unnamed'
}

export default function CompositeTab() {
  const [concurrency, setConcurrency]   = useState<number>(2)
  const [shadowEnabled, setShadowEnabled] = useState<boolean>(true)   // active la passe Gemini "ajoute une ombre"
  const [lookLimit, setLookLimit] = useState<string>('')

  const [zips, setZips]               = useState<File[]>([])
  const [parsing, setParsing]         = useState(false)
  const [parsed, setParsed]           = useState<ParsedExport | null>(null)
  const [states, setStates]           = useState<TaskState[]>([])
  const statesRef                     = useRef<TaskState[]>([])
  const [globalError, setGlobalError] = useState<string | null>(null)

  const [ratio, setRatio]       = useState('9:16')
  const [quality, setQuality]   = useState('2K')
  const [running, setRunning]   = useState(false)
  const [progress, setProgress] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  /* ----------- Parsing zip (réutilise parseNotionExport) ----------- */
  const handleZipChange = async (files: File[]) => {
    setZips(files)
    setGlobalError(null)
    setParsed(null)
    setStates([])
    setExpanded({})

    if (files.length === 0) return

    const sizeGB = files[0].size / (1024 * 1024 * 1024)
    if (sizeGB > 10.0) {
      setGlobalError(`Le ZIP fait ${sizeGB.toFixed(1)} GB — au-delà de la limite pratique (~10 GB). Découpe l'export.`)
      setZips([])
      return
    }
    if (sizeGB > 3.0) {
      const limitSet = lookLimit.trim() && Number(lookLimit) > 0
      setProgress(
        `ZIP volumineux (${sizeGB.toFixed(1)} GB)` +
        (limitSet ? ` — limité aux ${lookLimit} premiers looks ✓` : ' — pense à remplir "Limite looks" pour un premier essai rapide (ex : 3)'),
      )
    }

    setParsing(true)
    try {
      const limit = lookLimit.trim() && Number(lookLimit) > 0 ? Number(lookLimit) : undefined
      const result = await parseNotionExport(files[0], (msg) => setProgress(msg), limit)
      // On filtre les tâches détail (le composite est principalement pour les poses).
      const posesOnly = { ...result, tasks: result.tasks.filter(t => t.taskType !== 'detail') }
      setParsed(posesOnly)
      setStates(posesOnly.tasks.map(t => ({ task: t, status: 'pending', enabled: true })))
      setProgress('')
    } catch (e: any) {
      setGlobalError(e?.message ?? 'Impossible de parser le zip.')
    }
    setParsing(false)
  }

  useEffect(() => { statesRef.current = states }, [states])

  /* ----------- Grouping par look ----------- */
  const groupedLooks = useMemo(() => {
    const map = new Map<string, TaskState[]>()
    const order: string[] = []
    for (const s of states) {
      const key = s.task.lookId
      if (!map.has(key)) { map.set(key, []); order.push(key) }
      map.get(key)!.push(s)
    }
    return order.map(lookId => ({ lookId, tasks: map.get(lookId)! }))
  }, [states])

  const enabledCount = states.filter(s => s.enabled).length

  const toggleTask = (id: string) =>
    setStates(prev => prev.map(s => s.task.id === id ? { ...s, enabled: !s.enabled } : s))
  const toggleLook = (lookId: string, value: boolean) =>
    setStates(prev => prev.map(s => s.task.lookId === lookId ? { ...s, enabled: value } : s))
  const toggleAllStates = (value: boolean) =>
    setStates(prev => prev.map(s => ({ ...s, enabled: value })))

  const setLookExpansion = (lookId: string, open: boolean) =>
    setExpanded(prev => ({ ...prev, [lookId]: open }))

  /* ----------- Runner ----------- */
  const handleRunAll = async () => {
    if (!parsed) return
    setGlobalError(null)
    setRunning(true)

    const queue = states.filter(s => s.enabled)
    let done = 0
    let errors = 0
    const total = queue.length

    const processOne = async (item: TaskState): Promise<void> => {
      setLookExpansion(item.task.lookId, true)
      updateState(item.task.id, {
        status: 'running',
        error: undefined,
        imageUrl: undefined,
        imageUrlGemini: undefined,
        imageUrlSegmented: undefined,
        imageUrlComposite: undefined,
        progressStep: 'gemini',
      })

      try {
        // ===== Étape 1 : Gemini =====
        if (!item.task.bodyPhotoFile || !item.task.backgroundFile) {
          updateState(item.task.id, { status: 'error', error: 'Pas de bodyPhotoFile ou backgroundFile.' })
          errors++
          return
        }

        const body  = await compressImage(item.task.bodyPhotoFile,  { maxSide: 2048, quality: 0.90 })
        const bg    = await compressImage(item.task.backgroundFile, { maxSide: 2048, quality: 0.92 })
        const prods = await compressAll(item.task.productFiles ?? [], { maxSide: 2048, quality: 0.85 })

        const fd = new FormData()
        fd.append('prompt',  item.task.prompt)
        fd.append('ratio',   ratio)
        fd.append('quality', quality)
        fd.append('mannequinBody', body)
        fd.append('background',    bg)
        for (const p of prods) fd.append('products', p)
        if (item.task.facePhotoFile) {
          const face = await compressImage(item.task.facePhotoFile, { maxSide: 2048, quality: 0.92 })
          fd.append('mannequinFace', face)
        }
        fd.append('framing',        item.task.framingHint ?? 'plein')
        fd.append('mannequinLabel', item.task.mannequinName)
        fd.append('decorLabel',     item.task.fondName)

        setProgress(`Gemini · look ${item.task.numeroLook} · ${done + errors}/${total}`)
        const res = await fetch('/api/studio/free', { method: 'POST', body: fd })
        const data: any = await res.json().catch(() => null)
        if (!res.ok || !data?.imageUrl) {
          const msg = (data && (data.error || data.message)) || `Gemini HTTP ${res.status}`
          updateState(item.task.id, { status: 'error', error: truncate(msg) })
          errors++
          return
        }

        updateState(item.task.id, {
          imageUrlGemini:   data.imageUrl,
          faceUsed:         typeof data.faceUsed === 'boolean' ? data.faceUsed : undefined,
          faceWasAvailable: typeof data.faceWasAvailable === 'boolean' ? data.faceWasAvailable : undefined,
          progressStep: 'segment',
        })

        // ===== Étape 2 : Segmentation ML + hole-fill =====
        setProgress(`Segmentation · look ${item.task.numeroLook} · ${done + errors}/${total}`)
        const geminiBlob = await dataUrlToBlob(data.imageUrl)
        const rawSegmented = await segmentForeground(geminiBlob, (msg) =>
          setProgress(`Segmentation · ${msg} · look ${item.task.numeroLook}`),
        )
        setProgress(`Refinement (hole-fill) · look ${item.task.numeroLook}`)
        let segmented: Blob
        try {
          segmented = await fillSegmentationHoles(rawSegmented, geminiBlob)
        } catch (err: any) {
          console.warn('[composite] hole-fill failed, using raw segmentation:', err?.message)
          segmented = rawSegmented
        }
        const segmentedDataUrl = await blobToDataUrl(segmented)
        updateState(item.task.id, { imageUrlSegmented: segmentedDataUrl, progressStep: 'composite' })

        // ===== Étape 3 : Composite =====
        setProgress(`Composite · look ${item.task.numeroLook} · ${done + errors}/${total}`)
        const framing = item.task.framingHint ?? 'plein'
        const compositeFile = await compositeOnBackground(segmented, item.task.backgroundFile, {
          framingHint: framing,
        })
        const compositeDataUrl = await blobToDataUrl(compositeFile)
        // imageUrlComposite = pré-ombre (toujours conservé pour comparaison)
        // imageUrl = final (sera écrasé par la passe ombre si elle a lieu)
        updateState(item.task.id, {
          imageUrlComposite: compositeDataUrl,
          imageUrl:          compositeDataUrl,
          progressStep:      'composite',
        })

        // ===== Étape 4 : Fusion finale style "Simple" =====
        // On envoie le mannequin segmenté (PNG transparent) + le fond seul à
        // /api/studio/simple, qui fusionne via Gemini avec une lumière + ombre
        // naturelles (comme dans l'onglet Simple).
        // Seulement quand le sol est visible (plein pied / close-up bas).
        // Pour close-up haut (mur, sol croppé) → on garde le composite Canvas.
        const needsShadow = shadowEnabled && (framing === 'plein' || framing === 'bas')
        if (needsShadow) {
          setProgress(`Fusion Simple · look ${item.task.numeroLook} · ${done + errors}/${total}`)
          updateState(item.task.id, { progressStep: 'shadow' })

          try {
            // Subject = mannequin segmenté (PNG transparent)
            const segmentedFile = new File([segmented], 'subject.png', { type: 'image/png' })
            const subjectCompressed = await compressImage(segmentedFile, { maxSide: 2048, quality: 0.92 })
            const bgCompressed      = await compressImage(item.task.backgroundFile, { maxSide: 2048, quality: 0.92 })

            const fdSimple = new FormData()
            fdSimple.append('subject',    subjectCompressed)
            fdSimple.append('background', bgCompressed)
            fdSimple.append('brief',      'Photographie de mode professionnelle, ombre naturelle subtile au sol, lumière cohérente entre sujet et fond.')
            fdSimple.append('ratio',      ratio)
            fdSimple.append('quality',    quality)

            const resSimple = await fetch('/api/studio/simple', { method: 'POST', body: fdSimple })
            const dataSimple: any = await resSimple.json().catch(() => null)
            if (resSimple.ok && dataSimple?.imageUrl) {
              updateState(item.task.id, { imageUrl: dataSimple.imageUrl })
            } else {
              console.warn('[composite] fusion Simple échouée :', dataSimple?.error || resSimple.status)
            }
          } catch (err: any) {
            console.warn('[composite] fusion Simple exception :', err?.message)
          }
        }

        updateState(item.task.id, {
          status:       'done',
          progressStep: 'done',
        })
        done++
      } catch (e: any) {
        updateState(item.task.id, { status: 'error', error: truncate(e?.message ?? 'Erreur') })
        errors++
      } finally {
        const finished = done + errors
        setProgress(`${finished}/${total} composites traités · ${done} ok · ${errors} erreur(s)`)
      }
    }

    let nextIdx = 0
    const worker = async () => {
      while (true) {
        const i = nextIdx++
        if (i >= queue.length) return
        await processOne(queue[i])
      }
    }
    const workerCount = Math.max(1, Math.min(concurrency, queue.length))
    setProgress(`Lancement de ${workerCount} workers en parallèle…`)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))

    setProgress(`Terminé · ${done}/${total} composite(s) générés` + (errors > 0 ? ` · ${errors} erreur(s)` : ''))
    setRunning(false)
  }

  const updateState = (id: string, patch: Partial<TaskState>) =>
    setStates(prev => prev.map(s => s.task.id === id ? { ...s, ...patch } : s))

  /* ----------- Export ZIP — un dossier par look ----------- */
  const exportZip = async () => {
    const ok = states.filter(s => s.status === 'done' && s.imageUrl)
    if (!ok.length) return
    const zip = new JSZip()

    for (const s of ok) {
      const blob = await dataUrlToBlob(s.imageUrl!)
      // Détecte l'extension depuis le data URL
      const mimeMatch = s.imageUrl!.match(/^data:image\/(\w+)/)
      const ext = mimeMatch ? mimeMatch[1].replace('jpeg', 'jpg') : 'jpg'

      // Nom du dossier : "{lookId}_{numeroLook}" (sanitisé)
      const folder = sanitizeFilename(`${s.task.lookId}_${s.task.numeroLook}`)

      // Nom du fichier dans le dossier : "vue{N}_{orientation}_{framing}.ext"
      const vueNum     = (s.task.vueIndex ?? 0) + 1
      const orientation = (s.task.pose?.orientation ?? 'front').toString().toLowerCase()
      const framing    = (s.task.framingHint ?? 'plein').toString().toLowerCase()
      const filename = `vue${vueNum}_${orientation}_${framing}.${ext}`

      zip.file(`${folder}/${filename}`, blob)
    }

    const out = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(out)
    const a = document.createElement('a')
    a.href = url
    a.download = `composite_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`
    document.body.appendChild(a); a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }



  const hasResults = states.some(s => s.status === 'done')

  return (
    <div style={styles.wrap}>
      <h2 style={styles.title}>Composite — fond exact garanti</h2>
      <p style={styles.subtitle}>
        Pipeline déterministe : Gemini génère le mannequin + scène → segmentation client-side
        → composite sur les <strong>pixels exacts</strong> du fond de référence → ombre synthétique soft.
        <br />
        <em>Premier run : ~30 s de download du modèle de segmentation (cache navigateur après).</em>
        <br />
        💡 <strong>Gros ZIP (5 GB+) ?</strong> Remplis "Limite looks" <em>avant</em> de drop le ZIP (ex : 3) pour ne parser/extraire que les premiers looks.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: 12, alignItems: 'end', marginBottom: 8 }}>
        <Dropzone files={zips} onChange={handleZipChange} accept=".zip" multiple={false}
          label="Glisse-dépose ton export Notion (.zip)" />
        <div>
          <label style={styles.label}>Limite looks (avant le drop)</label>
          <input value={lookLimit} onChange={e => setLookLimit(e.target.value)} placeholder="ex : 3"
            style={styles.input} type="number" min="1" />
          <div style={{ fontSize: 10, color: '#6B7A8A', marginTop: 4 }}>
            Pour tester sur N looks seulement, indispensable pour les gros ZIPs (4-5 GB+).
          </div>
        </div>
      </div>

      {parsing && <div style={styles.info}>📦 Parsing en cours… {progress}</div>}
      {globalError && <div style={styles.errorBox}>⚠ {globalError}</div>}

      {parsed && !parsing && (
        <>
          <div style={styles.panel}>
            <div style={styles.panelGrid}>
              <div>
                <label style={styles.label}>Ratio</label>
                <select value={ratio} onChange={e => setRatio(e.target.value)} style={styles.select}>
                  <option value="9:16">9:16</option>
                  <option value="3:4">3:4</option>
                  <option value="1:1">1:1</option>
                  <option value="16:9">16:9</option>
                  <option value="4:3">4:3</option>
                </select>
              </div>
              <div>
                <label style={styles.label}>Qualité</label>
                <select value={quality} onChange={e => setQuality(e.target.value)} style={styles.select}>
                  <option value="1K">1K</option>
                  <option value="2K">2K</option>
                  <option value="4K">4K</option>
                </select>
              </div>
              <div>
                <label style={styles.label}>Parallélisme</label>
                <select value={concurrency} onChange={e => setConcurrency(Number(e.target.value))} style={styles.select}>
                  {[1, 2, 3, 5].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div>
                <label style={styles.label}>Limite looks</label>
                <input value={lookLimit} onChange={e => setLookLimit(e.target.value)} placeholder="ex: 3"
                  style={styles.input} type="number" min="1" />
              </div>
            </div>

            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid rgba(13,74,92,0.08)' }}>
              <label style={{ ...styles.label, display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0, fontSize: 13, fontWeight: 600, color: '#0D4A5C', cursor: 'pointer' }}>
                <input type="checkbox" checked={shadowEnabled} onChange={e => setShadowEnabled(e.target.checked)} />
                Fusion finale style &quot;Simple&quot; (sol visible uniquement)
              </label>
              <p style={{ fontSize: 11, color: '#6B7A8A', marginTop: 4, lineHeight: 1.5 }}>
                Pour les <strong>plein pied</strong> et <strong>close-up bas</strong>, on envoie le mannequin segmenté + le fond seul
                à <code>/api/studio/simple</code> qui fusionne via Gemini avec une lumière et une ombre naturelles
                (comme dans l&apos;onglet Simple).
                <br />
                Pour les <strong>close-up haut</strong>, on garde le composite Canvas (bg croppé aux 30 % du haut).
                <br />
                Coût : <strong>+1 appel Gemini</strong> par visuel concerné.
              </p>
            </div>

            <div style={styles.statsBox}>
              📊 {parsed.tasks.length} visuels (poses) · {enabledCount} sélectionnés
              {parsed.warnings.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 11, color: '#7A4F00' }}>
                  ⚠ {parsed.warnings.length} avertissement(s) du parser Notion.
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button onClick={() => toggleAllStates(true)}  style={styles.btnLight}>✓ tout cocher</button>
              <button onClick={() => toggleAllStates(false)} style={styles.btnLight}>✗ tout décocher</button>
              <button onClick={handleRunAll} disabled={running || enabledCount === 0} style={styles.btnPrimary}>
                {running ? '⏳ génération en cours…' : `🚀 lancer le composite (${enabledCount})`}
              </button>
              {hasResults && (
                <button onClick={exportZip} style={styles.btnLight}>⬇ Export ZIP</button>
              )}
            </div>

            {progress && <div style={{ ...styles.info, marginTop: 12 }}>{progress}</div>}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {groupedLooks.map(({ lookId, tasks }) => {
              const open    = expanded[lookId] ?? false
              const doneN   = tasks.filter(t => t.status === 'done').length
              const errN    = tasks.filter(t => t.status === 'error').length
              const runN    = tasks.filter(t => t.status === 'running').length
              const allOn   = tasks.every(t => t.enabled)
              const anyOn   = tasks.some(t => t.enabled)
              const numero  = tasks[0].task.numeroLook
              return (
                <div key={lookId} style={styles.lookCard}>
                  <div style={styles.lookHead} onClick={() => setLookExpansion(lookId, !open)}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: '#0D4A5C' }}>{open ? '▼' : '▶'} Look {numero}</span>
                    <span style={{ fontSize: 11, color: '#6B7A8A', marginLeft: 8 }}>
                      ({tasks.length} pose(s) · ✓ {doneN} · ⚠ {errN} · ⏳ {runN})
                    </span>
                    <span style={{ marginLeft: 'auto' }}>
                      <Indeterminate3StateCheckbox
                        checked={allOn} indeterminate={anyOn && !allOn}
                        onChange={() => toggleLook(lookId, !allOn)} />
                    </span>
                  </div>
                  {open && (
                    <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {tasks.map(s => (
                        <TaskRow key={s.task.id} state={s} onToggle={() => toggleTask(s.task.id)} />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {!parsed && !parsing && (
        <div style={styles.emptyState}>
          📦 Drop ton export Notion (.zip) pour commencer.<br />
          <span style={{ fontSize: 11 }}>Le runner ne traite que les poses (pas les détails) en mode Composite.</span>

          <div style={{ marginTop: 20, padding: 14, background: '#FFF8E1', border: '1px solid #F1D78A', borderRadius: 8, textAlign: 'left', color: '#7A4F00', fontSize: 12, lineHeight: 1.5 }}>
            💡 <strong>Gros ZIP (3-10 GB) ?</strong> Renseigne le champ <strong>"Limite looks"</strong> (à droite du Dropzone) <em>avant</em> de drop le fichier.
            Le parseur lit alors le ZIP en lazy et n'extrait que les images des N premiers looks — pas besoin de tout charger pour tester.
            <br />Exemple : pour un test rapide, mets <code>2</code> ou <code>3</code>.
          </div>

          <div style={{ marginTop: 16, fontSize: 11, color: '#6B7A8A', textAlign: 'left' }}>
            <strong>Vues supportées</strong> : {VIEW_CATALOG.map(v => v.label ?? v.key).join(', ')}<br />
            <strong>Poses supportées</strong> : {POSE_CATALOG.map(p => p.key).join(', ')}
          </div>
        </div>
      )}
    </div>
  )
}

/* ============================== TaskRow ============================== */

function TaskRow({ state, onToggle }: { state: TaskState, onToggle: () => void }) {
  const { task, status, imageUrl, imageUrlGemini, imageUrlSegmented, imageUrlComposite, error, enabled } = state
  const color =
    status === 'done'    ? '#1F7A35'
    : status === 'error' ? '#9B1C1C'
    : status === 'running'? '#0D4A5C'
    : '#6B7A8A'

  const stepLabel: Record<string, string> = {
    gemini:    '1️⃣ Gemini',
    segment:   '2️⃣ Segmentation',
    composite: '3️⃣ Composite',
    shadow:    '4️⃣ Fusion Simple',
    done:      '✓ Done',
  }

  return (
    <div style={taskRowStyle}>
      <input type="checkbox" checked={enabled} onChange={onToggle} disabled={status === 'running'} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#0D4A5C' }}>{task.vueRaw ?? task.id}</div>
        <div style={{ fontSize: 11, color: '#6B7A8A', marginTop: 2 }}>
          ID <code>{task.id}</code> · type <strong>{task.taskType}</strong>
          {state.progressStep && status === 'running' && (
            <span style={{ marginLeft: 8, color: '#0D4A5C', fontWeight: 600 }}>· {stepLabel[state.progressStep]}</span>
          )}
        </div>
        {error && <div style={{ ...errorBoxStyle, marginTop: 4 }}>⚠ {error}</div>}
      </div>

      <span style={{ ...statusPill, color, borderColor: color }}>{status}</span>

      <div style={{ display: 'flex', gap: 8 }}>
        {imageUrlGemini && (
          <ImgThumb label="1. Gemini"     url={imageUrlGemini} />
        )}
        {imageUrlSegmented && (
          <ImgThumb label="2. Segmenté"   url={imageUrlSegmented} />
        )}
        {imageUrlComposite && imageUrlComposite !== imageUrl && (
          <ImgThumb label="3. Composite (sans ombre)"  url={imageUrlComposite} />
        )}
        {imageUrl && (
          <ImgThumb
            label={imageUrlComposite && imageUrlComposite !== imageUrl ? '4. Final (fusion Simple)' : '3. Composite'}
            url={imageUrl}
            highlight
          />
        )}
      </div>
    </div>
  )
}

function ImgThumb({ label, url, highlight }: { label: string, url: string, highlight?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
      <img src={url} alt={label} style={{
        width: 90, borderRadius: 6,
        border: highlight ? '2px solid #1F7A35' : '1px solid rgba(13,74,92,0.1)',
        background: '#f4f6f8',
      }} />
      <div style={{ fontSize: 9, color: highlight ? '#1F7A35' : '#6B7A8A', fontWeight: highlight ? 700 : 600 }}>{label}</div>
      <div style={{ display: 'flex', gap: 3 }}>
        <a href={url} download={`${label.replace(/\W+/g, '_')}.jpg`}
           style={highlight ? linkBtnDark : linkBtnLight}>⬇</a>
        <a href={url} target="_blank" rel="noreferrer"
           style={highlight ? linkBtnDark : linkBtnLight}>↗</a>
      </div>
    </div>
  )
}

/* ============================== Checkbox 3 états ============================== */

function Indeterminate3StateCheckbox({
  checked, indeterminate, onChange,
}: { checked: boolean, indeterminate: boolean, onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return <input ref={ref} type="checkbox" checked={checked} onChange={onChange} onClick={e => e.stopPropagation()} />
}

/* ============================== utils ============================== */

function truncate(s: string, max = 240): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

/* ============================== styles ============================== */

const styles: Record<string, React.CSSProperties> = {
  wrap:      { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1400 },
  title:     { fontSize: 22, fontWeight: 700, color: '#0D4A5C', margin: 0 },
  subtitle:  { fontSize: 13, color: '#6B7A8A', lineHeight: 1.5, margin: '0 0 6px' },
  panel:     { background: '#F5F7F9', borderRadius: 12, padding: 16, border: '1px solid rgba(13,74,92,0.08)' },
  panelGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 },
  label:     { fontSize: 10, fontWeight: 600, color: '#6B7A8A', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: 4 },
  select:    { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid rgba(13,74,92,0.15)', background: '#fff', fontSize: 13, color: '#0D4A5C' },
  input:     { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid rgba(13,74,92,0.15)', background: '#fff', fontSize: 13, color: '#0D4A5C' },
  btnPrimary:{ padding: '10px 16px', background: '#0D4A5C', color: '#fff', borderRadius: 8, border: 0, fontWeight: 700, fontSize: 13, cursor: 'pointer' },
  btnLight:  { padding: '10px 14px', background: '#fff', color: '#0D4A5C', borderRadius: 8, border: '1px solid rgba(13,74,92,0.2)', fontWeight: 600, fontSize: 12, cursor: 'pointer' },
  info:      { fontSize: 12, color: '#0D4A5C', background: '#E8F2F5', borderRadius: 6, padding: '8px 10px' },
  errorBox:  { background: '#FDECEC', color: '#9B1C1C', border: '1px solid #F5C2C2', padding: '8px 10px', borderRadius: 7, fontSize: 12, whiteSpace: 'pre-wrap' },
  statsBox:  { background: '#E8F2F5', color: '#0D4A5C', borderRadius: 8, padding: '10px 12px', fontSize: 12, lineHeight: 1.5, marginTop: 12 },
  emptyState:{ textAlign: 'center', padding: '60px 24px', color: '#6B7A8A', fontSize: 14, border: '1px dashed rgba(13,74,92,0.2)', borderRadius: 12, background: '#fff', lineHeight: 1.5 },
  lookHead:  { padding: '10px 14px', background: '#F5F7F9', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', borderBottom: '1px solid rgba(13,74,92,0.08)' },
}

const taskRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 10, padding: 10,
  background: '#fff', borderRadius: 8, border: '1px solid rgba(13,74,92,0.08)',
}
const statusPill: React.CSSProperties = {
  padding: '3px 8px', borderRadius: 12, fontSize: 10, fontWeight: 700,
  textTransform: 'uppercase', border: '1px solid', alignSelf: 'flex-start',
}
const errorBoxStyle: React.CSSProperties = {
  background: '#FDECEC', color: '#9B1C1C', border: '1px solid #F5C2C2',
  padding: '6px 8px', borderRadius: 6, fontSize: 11, whiteSpace: 'pre-wrap',
}
const linkBtnDark: React.CSSProperties = {
  padding: '3px 7px', fontSize: 10, color: '#fff', background: '#0D4A5C',
  borderRadius: 4, textDecoration: 'none', fontWeight: 600, textAlign: 'center',
}
const linkBtnLight: React.CSSProperties = {
  padding: '3px 7px', fontSize: 10, color: '#0D4A5C',
  border: '1px solid rgba(13,74,92,0.2)', borderRadius: 4,
  textDecoration: 'none', fontWeight: 600, textAlign: 'center',
}
