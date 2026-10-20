import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'

import { FileTypeIcon } from '../file-type-icon'
import { getFileExtension, getImageMimeTypeForExtension } from '../preview-support'
import { useNearViewport } from '../previews/useNearViewport'
import type { ArtifactThumbnailReader } from './artifact-thumbnail-reader'

type ArtifactSource = 'upload' | 'artifact' | 'literature'

type ArtifactFileIconProps = {
  name: string
  mimeType?: string
  path: string
  source: ArtifactSource
  className?: string
  readThumbnail: ArtifactThumbnailReader
}

// Mirrors isImageArtifact: an image/* mime type or a known image extension.
const isImageFile = (name: string, mimeType?: string): boolean =>
  Boolean(mimeType?.startsWith('image/')) || /\.(avif|gif|jpe?g|png|svg|tiff?|webp)$/i.test(name)

// Fixed 20px slot so image thumbnails and category glyphs line up across rows.
const iconSlotClassName = 'flex h-5 w-5 shrink-0 items-center justify-center'

// Reads a small image preview and renders a real thumbnail; falls back to the image glyph while
// loading or when the read fails.
const ArtifactThumbnail = ({
  name,
  mimeType,
  path,
  source,
  className,
  readThumbnail
}: ArtifactFileIconProps): React.JSX.Element => {
  const requestKey = `${source}:${path}`
  const [setElement, isNearViewport] = useNearViewport<HTMLSpanElement>()
  // State is keyed by the request so a path change reads as loading without a synchronous reset.
  const [state, setState] = useState<{ key: string; dataUrl: string | null; failed: boolean }>({
    key: requestKey,
    dataUrl: null,
    failed: false
  })

  useEffect(() => {
    if (!isNearViewport || (state.key === requestKey && (state.dataUrl || state.failed))) return
    let canceled = false
    void readThumbnail({ path, source })
      .then((preview) => {
        if (canceled || !preview) return
        if (preview.truncated) {
          setState({ key: requestKey, dataUrl: null, failed: true })
          return
        }
        const mime = mimeType || getImageMimeTypeForExtension(getFileExtension(name)) || 'image/png'
        setState({
          key: requestKey,
          dataUrl: `data:${mime};base64,${preview.content}`,
          failed: false
        })
      })
      .catch(() => {
        if (!canceled) setState({ key: requestKey, dataUrl: null, failed: true })
      })

    return () => {
      canceled = true
    }
  }, [name, mimeType, path, source, requestKey, isNearViewport, readThumbnail, state])

  const current = state.key === requestKey ? state : { dataUrl: null, failed: false }

  if (current.dataUrl && !current.failed) {
    return (
      <span ref={setElement} className={cn(iconSlotClassName, className)}>
        <img
          src={current.dataUrl}
          alt={name}
          className="h-5 w-5 rounded object-cover"
          onError={() => setState({ key: requestKey, dataUrl: null, failed: true })}
        />
      </span>
    )
  }

  return (
    <span ref={setElement} className={cn(iconSlotClassName, className)}>
      <FileTypeIcon name={name} mimeType={mimeType} className="size-4" />
    </span>
  )
}

// Per-row artifact icon: a thumbnail for image files, a category glyph otherwise.
export const ArtifactFileIcon = (props: ArtifactFileIconProps): React.JSX.Element => {
  if (isImageFile(props.name, props.mimeType)) {
    return <ArtifactThumbnail {...props} />
  }

  return (
    <span className={cn(iconSlotClassName, props.className)}>
      <FileTypeIcon name={props.name} mimeType={props.mimeType} />
    </span>
  )
}
