import { useEffect, useState } from 'react'
import { FileText } from 'lucide-react'

import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { pdfjsLib } from '../pdfjs'
import { readPdfBytes } from '../pdf-bytes'
import { isUnavailableFileError } from '../preview-errors'

// Roughly the card width; rendering the first page near this size keeps the data URL small.
const THUMBNAIL_WIDTH = 220

// Rendered first-page data URLs are cached by source, path, and version.
const thumbnailCache = new Map<string, string>()

// Renders page one and stores it under the caller's versioned identity for future tile reuse.
const renderFirstPage = async (
  path: string,
  source: PreviewFileSource,
  requestKey: string
): Promise<string> => {
  const cached = thumbnailCache.get(requestKey)
  if (cached) return cached

  const bytes = await readPdfBytes(path, source)
  const document = await pdfjsLib.getDocument({ data: bytes }).promise

  try {
    const page = await document.getPage(1)
    const baseViewport = page.getViewport({ scale: 1 })
    const scale = THUMBNAIL_WIDTH / baseViewport.width
    const viewport = page.getViewport({ scale })

    const canvas = window.document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D context unavailable.')

    canvas.width = viewport.width
    canvas.height = viewport.height
    await page.render({ canvasContext: context, viewport }).promise
    page.cleanup()

    const dataUrl = canvas.toDataURL('image/png')
    thumbnailCache.set(requestKey, dataUrl)
    return dataUrl
  } finally {
    await document.destroy()
  }
}

// A generic PDF icon shown while the first page renders or if rendering fails.
const PdfIconFallback = (): React.JSX.Element => (
  <div className="flex size-full items-center justify-center bg-bg-000">
    <FileText className="size-7 text-text-300" aria-hidden />
  </div>
)

// Displays a version-aware first-page preview while stale, loading, and failed requests use an icon.
export const PdfThumbnail = ({
  path,
  name,
  source = 'artifact',
  version
}: {
  path: string
  name: string
  source?: PreviewFileSource
  version: string
}): React.JSX.Element => {
  const requestKey = JSON.stringify([source, path, version])
  const [result, setResult] = useState<{
    requestKey: string
    status: 'ready' | 'error'
  } | null>(null)

  useEffect(() => {
    // Keying status prevents a late result from one path/version from affecting the next request.
    if (thumbnailCache.has(requestKey)) return

    let canceled = false

    renderFirstPage(path, source, requestKey)
      .then(() => {
        if (!canceled) setResult({ requestKey, status: 'ready' })
      })
      .catch((error) => {
        if (!isUnavailableFileError(error)) console.error('Failed to render PDF thumbnail', error)
        if (!canceled) setResult({ requestKey, status: 'error' })
      })

    return () => {
      canceled = true
    }
  }, [path, requestKey, source])

  const dataUrl = thumbnailCache.get(requestKey)
  const currentStatus = dataUrl
    ? 'ready'
    : result?.requestKey === requestKey
      ? result.status
      : undefined

  if (currentStatus === 'error') return <PdfIconFallback />
  if (!dataUrl) return <PdfIconFallback />

  return (
    <img
      src={dataUrl}
      alt={`Preview of ${name}`}
      className="size-full object-cover object-top"
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  )
}
