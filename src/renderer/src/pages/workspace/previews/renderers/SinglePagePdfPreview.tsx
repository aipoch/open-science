import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTransformEffect } from 'react-zoom-pan-pinch'

import type { createManagedPdfLoadingTask } from '../managed-pdf-document'
import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import { ZoomablePreview } from './ZoomablePreview'

type PdfDocument = Awaited<ReturnType<typeof createManagedPdfLoadingTask>['promise']>
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>

const SinglePageCanvas = ({
  document,
  name,
  pageDisposersRef
}: {
  document: PdfDocument
  name: string
  pageDisposersRef: React.RefObject<Set<() => void>>
}): React.JSX.Element => {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [page, setPage] = useState<PdfPage>()
  const [error, setError] = useState<{ reason: unknown }>()
  const [ready, setReady] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const renderRef = useRef<ReturnType<PdfPage['render']> | undefined>(undefined)
  useTransformEffect(({ state }) => {
    // Quantize rerasterization during animated zoom; panning never repaints the PDF.
    setZoom(Math.ceil(state.scale * 2) / 2)
  })

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const measure = (): void => {
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height }
      )
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(canvas)
    return () => observer?.disconnect()
  }, [])

  useEffect(() => {
    let disposed = false
    let ownedPage: PdfPage | undefined
    const canvas = canvasRef.current
    const disposers = pageDisposersRef.current
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      renderRef.current?.cancel()
      ownedPage?.cleanup()
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
    }
    disposers.add(dispose)
    void document.getPage(1).then(
      (value) => {
        if (disposed) value.cleanup()
        else {
          ownedPage = value
          setPage(value)
        }
      },
      (reason: unknown) => {
        if (!disposed) setError({ reason })
      }
    )
    return () => {
      dispose()
      disposers.delete(dispose)
    }
  }, [document, pageDisposersRef])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !page) return
    let canceled = false
    const paint = canvas.ownerDocument.createElement('canvas')
    const draw = async (): Promise<void> => {
      const base = page.getViewport({ scale: 1 })
      if (![base.width, base.height].every((value) => Number.isFinite(value) && value > 0))
        throw new Error('Invalid PDF page geometry.')
      const fit =
        size.width > 0 && size.height > 0
          ? Math.min(size.width / base.width, size.height / base.height)
          : 1
      // Match the reader's dimension and area limits, including oversized/rotated pages.
      const scale = Math.min(
        Math.max(1, fit * zoom * Math.max(1, window.devicePixelRatio || 1)),
        5,
        8192 / base.width,
        8192 / base.height,
        Math.sqrt((16 * 1024 * 1024) / (base.width * base.height))
      )
      const viewport = page.getViewport({ scale })
      paint.width = Math.ceil(viewport.width)
      paint.height = Math.ceil(viewport.height)
      const context = paint.getContext('2d')
      if (!context) throw new Error('Canvas 2D context unavailable.')
      const task = page.render({ canvas: paint, canvasContext: context, viewport })
      renderRef.current = task
      try {
        await task.promise
        if (canceled) return
        const target = canvas.getContext('2d')
        if (!target) throw new Error('Canvas 2D context unavailable.')
        canvas.width = paint.width
        canvas.height = paint.height
        target.drawImage(paint, 0, 0)
        setReady(true)
      } finally {
        if (renderRef.current === task) renderRef.current = undefined
      }
    }
    void draw()
      .catch((reason: unknown) => {
        if (!canceled) setError({ reason })
      })
      .finally(() => {
        paint.width = 0
        paint.height = 0
      })
    return () => {
      canceled = true
      renderRef.current?.cancel()
    }
  }, [page, size, zoom])

  if (error)
    return (
      <PreviewErrorCard
        name={name}
        error={error.reason}
        fallbackMessage={t("This PDF couldn't be rendered for preview")}
      />
    )
  return (
    <>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={name}
        width={0}
        height={0}
        className="pointer-events-none size-full object-contain"
      />
      {!ready ? (
        <div className="pointer-events-none absolute inset-0">
          <PreviewLoadingContent />
        </div>
      ) : null}
    </>
  )
}

export const SinglePagePdfPreview = (
  props: React.ComponentProps<typeof SinglePageCanvas>
): React.JSX.Element => (
  <div className="relative size-full overflow-hidden p-4" data-single-page-pdf-preview>
    <ZoomablePreview>
      <SinglePageCanvas {...props} />
    </ZoomablePreview>
  </div>
)
