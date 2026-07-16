import { useEffect, useRef, useState } from 'react'

import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import { pdfjsLib } from '../pdfjs'
import { readPdfBytes } from '../pdf-bytes'
import { isUnavailableFileError } from '../preview-errors'
import type { PreviewFileRendererProps } from '../preview-types'

// Rendering every page of a huge PDF would freeze the panel; cap the preview at a sensible depth.
const MAX_PREVIEW_PAGES = 30

type LoadState = 'loading' | 'ready' | 'error'

export const PdfPreviewContent = ({
  path,
  name,
  source = 'artifact'
}: {
  path: string
  name: string
  source?: PreviewFileSource
}): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  // Track the outcome per path so the status is derived, not reset synchronously inside the effect.
  const [rendered, setRendered] = useState<{
    path: string
    status: 'ready' | 'error'
    error?: unknown
  } | null>(null)

  useEffect(() => {
    let canceled = false
    const container = containerRef.current

    const render = async (): Promise<void> => {
      const bytes = await readPdfBytes(path, source)
      // getDocument transfers the buffer, so hand it a copy it can consume freely.
      const document = await pdfjsLib.getDocument({ data: bytes }).promise

      try {
        if (canceled || !container) return
        container.replaceChildren()

        const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
        const pageCount = Math.min(document.numPages, MAX_PREVIEW_PAGES)

        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
          const page = await document.getPage(pageNumber)
          if (canceled) return

          const viewport = page.getViewport({ scale })
          const canvas = window.document.createElement('canvas')
          const context = canvas.getContext('2d')
          if (!context) continue

          canvas.width = viewport.width
          canvas.height = viewport.height
          canvas.className = 'mx-auto mb-3 h-auto w-full max-w-3xl rounded-sm shadow-sm'
          container.appendChild(canvas)

          await page.render({ canvasContext: context, viewport }).promise
          page.cleanup()
        }

        if (!canceled) setRendered({ path, status: 'ready' })
      } finally {
        await document.destroy()
      }
    }

    render().catch((error) => {
      if (!isUnavailableFileError(error)) console.error('Failed to render PDF preview', error)
      if (!canceled) setRendered({ path, status: 'error', error })
    })

    return () => {
      canceled = true
    }
  }, [path, source])

  // Until the effect resolves for the current path, the file is still loading.
  const status: LoadState = rendered?.path === path ? rendered.status : 'loading'

  if (status === 'error') {
    return (
      <PreviewErrorCard
        path={path}
        name={name}
        source={source}
        error={rendered?.error}
        fallbackMessage="This PDF couldn't be rendered for preview"
      />
    )
  }

  return (
    <div className="relative size-full overflow-auto bg-bg-20 p-4">
      {status === 'loading' && (
        <div className="absolute inset-0">
          <PreviewLoadingContent />
        </div>
      )}
      <div ref={containerRef} />
    </div>
  )
}

export const PdfPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => (
  <PdfPreviewContent path={item.path} name={item.name} source={item.source} />
)
