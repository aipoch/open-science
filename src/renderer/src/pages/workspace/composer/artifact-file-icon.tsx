import { useEffect, useState } from 'react'
import {
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  Presentation,
  type LucideIcon
} from 'lucide-react'

import { cn } from '@/lib/utils'

import { getFileExtension, getImageMimeTypeForExtension } from '../preview-support'

type ArtifactSource = 'upload' | 'artifact'

type ArtifactFileIconProps = {
  name: string
  mimeType?: string
  path: string
  source: ArtifactSource
  className?: string
}

// Keep the per-row thumbnail read tiny; the popup only needs a small preview image.
const THUMBNAIL_MAX_BYTES = 256 * 1024

// Mirrors isImageArtifact: an image/* mime type or a known image extension.
const isImageFile = (name: string, mimeType?: string): boolean =>
  Boolean(mimeType?.startsWith('image/')) || /\.(avif|gif|jpe?g|png|svg|tiff?|webp)$/i.test(name)

// Category SVG plus a distinct accent color, keyed by file extension.
const iconForExtension = (extension: string): { Icon: LucideIcon; color: string } => {
  switch (extension) {
    case 'pdf':
      return { Icon: FileText, color: 'text-red-500' }
    case 'csv':
    case 'tsv':
      return { Icon: FileSpreadsheet, color: 'text-green-600' }
    case 'xls':
    case 'xlsx':
      return { Icon: FileSpreadsheet, color: 'text-emerald-600' }
    case 'ppt':
    case 'pptx':
      return { Icon: Presentation, color: 'text-orange-500' }
    case 'doc':
    case 'docx':
      return { Icon: FileText, color: 'text-blue-500' }
    case 'txt':
    case 'md':
      return { Icon: FileText, color: 'text-text-300' }
    default:
      return { Icon: File, color: 'text-text-300' }
  }
}

// Fixed 20px slot so image thumbnails and category glyphs line up across rows.
const iconSlotClassName = 'flex h-5 w-5 shrink-0 items-center justify-center'

// Reads a small image preview and renders a real thumbnail; falls back to the image glyph while
// loading or when the read fails.
const ArtifactThumbnail = ({
  name,
  mimeType,
  path,
  source,
  className
}: ArtifactFileIconProps): React.JSX.Element => {
  const requestKey = `${source}:${path}`
  // State is keyed by the request so a path change reads as loading without a synchronous reset.
  const [state, setState] = useState<{ key: string; dataUrl: string | null; failed: boolean }>({
    key: requestKey,
    dataUrl: null,
    failed: false
  })

  useEffect(() => {
    let canceled = false

    const readPreview =
      source === 'upload' ? window.api.uploads.readPreview : window.api.artifacts.readPreview

    void readPreview({ path, maxBytes: THUMBNAIL_MAX_BYTES, encoding: 'base64' })
      .then((preview) => {
        if (canceled) return
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
  }, [name, mimeType, path, source, requestKey])

  const current = state.key === requestKey ? state : { dataUrl: null, failed: false }

  if (current.dataUrl && !current.failed) {
    return (
      <span className={cn(iconSlotClassName, className)}>
        <img src={current.dataUrl} alt={name} className="h-5 w-5 rounded object-cover" />
      </span>
    )
  }

  return (
    <span className={cn(iconSlotClassName, className)}>
      <FileImage className="h-4 w-4 text-text-300" />
    </span>
  )
}

// Per-row artifact icon: a thumbnail for image files, a category glyph otherwise.
export const ArtifactFileIcon = (props: ArtifactFileIconProps): React.JSX.Element => {
  if (isImageFile(props.name, props.mimeType)) {
    return <ArtifactThumbnail {...props} />
  }

  const { Icon, color } = iconForExtension(getFileExtension(props.name))
  return (
    <span className={cn(iconSlotClassName, props.className)}>
      <Icon className={cn('h-4 w-4', color)} />
    </span>
  )
}
