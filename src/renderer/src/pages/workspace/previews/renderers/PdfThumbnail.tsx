import { useEffect, useState } from 'react'
import { FileText } from 'lucide-react'

import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { pdfjsLib } from '../pdfjs'
import { readPdfBytes } from '../pdf-bytes'

// Roughly the card width; rendering the first page near this size keeps the data URL small.
const THUMBNAIL_WIDTH = 220

// Rendered first-page data URLs are cached by path so scrolling the file list never re-renders a PDF.
const thumbnailCache = new Map<string, string>()

const renderFirstPage = async (path: string, source: PreviewFileSource): Promise<string> => {
  const cached = thumbnailCache.get(path)
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
    thumbnailCache.set(path, dataUrl)
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

export const PdfThumbnail = ({
  path,
  name,
  source = 'artifact'
}: {
  path: string
  name: string
  source?: PreviewFileSource
}): React.JSX.Element => {
  const [dataUrl, setDataUrl] = useState<string | undefined>(() => thumbnailCache.get(path))
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (dataUrl) return
    let canceled = false

    renderFirstPage(path, source)
      .then((url) => {
        if (!canceled) setDataUrl(url)
      })
      .catch((error) => {
        console.error('Failed to render PDF thumbnail', error)
        if (!canceled) setFailed(true)
      })

    return () => {
      canceled = true
    }
  }, [dataUrl, path, source])

  if (failed) return <PdfIconFallback />
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
