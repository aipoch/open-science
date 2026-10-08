import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useNearViewport } from '../useNearViewport'
import { renderPdfTranslationInline, type PdfInlineLayout } from './pdf-translation-inline'
import type { PdfTranslation } from './pdf-translation'

export function PdfTranslatedPage({
  document,
  pageNumber,
  translation,
  fallback,
  registerDisposer
}: {
  document: PDFDocumentProxy
  pageNumber: number
  translation: PdfTranslation
  fallback: ReactNode
  registerDisposer: (dispose: () => void) => () => void
}): React.JSX.Element {
  const [nearRef, near] = useNearViewport<HTMLDivElement>(),
    canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState<{
    document: PDFDocumentProxy
    translation: PdfTranslation
    pageNumber: number
    layouts: PdfInlineLayout[]
  }>()
  const current =
    ready?.document === document &&
    ready.translation === translation &&
    ready.pageNumber === pageNumber &&
    near
      ? ready
      : undefined
  useEffect(() => {
    if (!near) return
    const controller = new AbortController()
    const dispose = (): void => {
      controller.abort()
      if (canvasRef.current) canvasRef.current.width = 0
    }
    const unregister = registerDisposer(dispose)
    void (async () => {
      try {
        const page = await document.getPage(pageNumber)
        controller.signal.throwIfAborted()
        const result = await renderPdfTranslationInline(
          page,
          pageNumber,
          translation.units,
          controller.signal
        )
        if (!result) return
        try {
          controller.signal.throwIfAborted()
          const canvas = canvasRef.current
          if (!canvas) return
          canvas.width = result.canvas.width
          canvas.height = result.canvas.height
          canvas.getContext('2d')!.drawImage(result.canvas, 0, 0)
          setReady({ document, translation, pageNumber, layouts: result.layouts })
        } finally {
          result.canvas.width = 0
        }
      } catch {
        /* Preserve the original and complete linked text on unsupported paint or cancellation. */
      }
    })()
    return () => {
      unregister()
      dispose()
      setReady(undefined)
    }
  }, [document, pageNumber, translation, near, registerDisposer])
  const geometry = translation.pages[pageNumber - 1]
  return (
    <div ref={nearRef} className="relative" data-pdf-inline-ready={Boolean(current)}>
      {!current ? fallback : null}
      <div
        className={current ? 'relative w-full' : 'hidden'}
        style={{ aspectRatio: `${geometry.width} / ${geometry.height}` }}
      >
        <canvas ref={canvasRef} aria-hidden="true" className="block w-full" />
        {current?.layouts.map((layout) => (
          <div
            key={layout.id}
            data-pdf-translated-text={layout.id}
            className="absolute inset-0 select-text"
            style={{ containerType: 'inline-size', pointerEvents: 'none' }}
          >
            {layout.lines.map((line, i) => (
              <span
                key={i}
                style={{
                  position: 'absolute',
                  left: `${(line.x / geometry.width) * 100}%`,
                  top: `${((line.y - layout.size) / geometry.height) * 100}%`,
                  fontSize: `${(layout.size / geometry.width) * 100}cqw`,
                  fontFamily: 'sans-serif',
                  lineHeight: 1,
                  whiteSpace: 'pre',
                  color: 'transparent',
                  pointerEvents: 'auto'
                }}
              >
                {line.text}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
