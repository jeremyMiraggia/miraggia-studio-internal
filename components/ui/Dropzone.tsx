'use client'
import { useRef, useState, useCallback } from 'react'

type Props = {
  /** Mode multi-fichiers ou non */
  multiple?: boolean
  /** Mime accepté, ex "image/*" */
  accept?: string
  /** Fichiers actuels (contrôlé) */
  files: File[]
  /** Callback : reçoit la nouvelle liste complète */
  onChange: (files: File[]) => void
  /** Texte principal de la zone (ex "Glisse tes sujets ici") */
  label?: string
  /** Texte secondaire (ex "PNG, JPG, WEBP — jusqu'à 20 fichiers") */
  hint?: string
  /** Hauteur min de la zone */
  minHeight?: number
}

/**
 * Drop zone réutilisable :
 *  - drag & drop natif
 *  - click pour ouvrir le picker
 *  - prévisualisation par vignettes
 *  - suppression par fichier
 */
export default function Dropzone({
  multiple = false,
  accept = 'image/*',
  files,
  onChange,
  label,
  hint,
  minHeight = 110,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [hover, setHover]   = useState(false)
  const [previews, setPreviews] = useState<Record<string, string>>({})

  const addFiles = useCallback((incoming: FileList | File[] | null | undefined) => {
    if (!incoming) return
    const arr = Array.from(incoming).filter(f => {
      if (!accept || accept === '*') return true
      if (accept === 'image/*') return f.type.startsWith('image/')
      return true
    })
    if (arr.length === 0) return

    // Crée les data URLs pour la preview (asynchrone) — uniquement pour les images
    arr.forEach(f => {
      if (!f.type.startsWith('image/')) return
      const key = `${f.name}:${f.size}:${f.lastModified}`
      if (previews[key]) return
      const reader = new FileReader()
      reader.onload = () => {
        setPreviews(prev => ({ ...prev, [key]: reader.result as string }))
      }
      reader.readAsDataURL(f)
    })

    onChange(multiple ? [...files, ...arr] : [arr[0]])
  }, [accept, files, multiple, onChange, previews])

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setHover(false)
    addFiles(e.dataTransfer.files)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setHover(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setHover(false)
  }

  const removeAt = (idx: number) => {
    onChange(files.filter((_, i) => i !== idx))
  }

  const openPicker = () => inputRef.current?.click()

  const onPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.files
    if (items && items.length) addFiles(items)
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={openPicker}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') openPicker() }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onPaste={onPaste}
        style={{
          ...zoneBase,
          background: hover ? '#E8F2F5' : '#FAFBFC',
          borderColor: hover ? '#0D4A5C' : 'rgba(13,74,92,0.25)',
          minHeight,
        }}
      >
        <div style={{ fontSize: 22, marginBottom: 6 }}>⬆</div>
        <div style={{ fontSize: 13, color: '#0D4A5C', fontWeight: 600 }}>
          {label ?? (multiple ? 'Glisse tes images ici' : 'Glisse une image ici')}
        </div>
        <div style={{ fontSize: 11, color: '#6B7A8A', marginTop: 2 }}>
          {hint ?? 'ou clique pour parcourir · colle depuis le presse-papier'}
        </div>

        <input
          ref={inputRef}
          type="file"
          multiple={multiple}
          accept={accept}
          onChange={e => addFiles(e.target.files)}
          style={{ display: 'none' }}
        />
      </div>

      {files.length > 0 && (
        <div style={previewGrid}>
          {files.map((f, i) => {
            const key = `${f.name}:${f.size}:${f.lastModified}`
            const src = previews[key]
            return (
              <div key={i} style={previewCard}>
                {src
                  ? <img src={src} alt={f.name} style={previewImg} />
                  : <div style={previewPlaceholder}>…</div>
                }
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); removeAt(i) }}
                  style={removeBtn}
                  aria-label={`Retirer ${f.name}`}
                  title="Retirer"
                >×</button>
                <div style={previewName} title={f.name}>{f.name}</div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const zoneBase: React.CSSProperties = {
  border: '1.5px dashed rgba(13,74,92,0.25)',
  borderRadius: 10,
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  textAlign: 'center',
  transition: 'all 0.15s ease',
  userSelect: 'none',
  outline: 'none',
}

const previewGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))',
  gap: 6,
  marginTop: 8,
}

const previewCard: React.CSSProperties = {
  position: 'relative',
  borderRadius: 6,
  overflow: 'hidden',
  background: '#fff',
  border: '1px solid rgba(13,74,92,0.1)',
  aspectRatio: '1 / 1',
}

const previewImg: React.CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
}

const previewPlaceholder: React.CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#9BA8B5',
  fontSize: 14,
}

const removeBtn: React.CSSProperties = {
  position: 'absolute',
  top: 3,
  right: 3,
  width: 18,
  height: 18,
  borderRadius: '50%',
  border: 'none',
  background: 'rgba(13,74,92,0.85)',
  color: '#fff',
  fontSize: 13,
  lineHeight: 1,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
}

const previewName: React.CSSProperties = {
  position: 'absolute',
  bottom: 0,
  left: 0,
  right: 0,
  background: 'linear-gradient(transparent, rgba(0,0,0,0.65))',
  color: '#fff',
  fontSize: 9,
  padding: '10px 4px 3px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
