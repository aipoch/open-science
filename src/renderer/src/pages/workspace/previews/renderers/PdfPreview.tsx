import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import { createManagedPdfLoadingTask } from '../managed-pdf-document'
import { isUnavailableFileError } from '../preview-errors'
import { createPreviewResourceKey } from '../preview-resource-key'
import type { PreviewFileRendererProps } from '../preview-types'
import { useNearViewport } from '../useNearViewport'

type PdfDocument = Awaited<ReturnType<typeof createManagedPdfLoadingTask>['promise']>
type DocumentState =
  | { requestKey: string; status: 'ready'; document: PdfDocument }
  | { requestKey: string; status: 'error'; error: unknown }

// Comfortable reading width a page fills; also caps the backing resolution the parent measures.
const FIT_PAGE_WIDTH = 768
// Bound the backing-store resolution so an over-magnified small page cannot exhaust GPU memory.
const MAX_RENDER_SCALE = 4
// Keep the backing store within browser canvas limits so a tall/narrow page cannot render blank:
// clamp each side and the total area (Chromium caps a dimension at 16384 and area near 2^28).
const MAX_CANVAS_DIMENSION = 8192
const MAX_CANVAS_AREA = 16 * 1024 * 1024

// PDF.js rejects an in-flight render with this when cancel() is called; it is an expected teardown,
// not a page failure, so scroll-out, preview switches, and resize rerenders must not surface it.
const isRenderCancel = (error: unknown): boolean =>
  error instanceof Error && error.name === 'RenderingCancelledException'

// Owns one lazy page canvas and releases its decoded bitmap outside the overscan window.
const PdfPageCanvas = ({
  document,
  pageNumber,
  pageWidth,
  registerDisposer
}: {
  document: PdfDocument
  pageNumber: number
  pageWidth: number
  registerDisposer: (dispose: () => void) => () => void
}): React.JSX.Element => {
  const [setNearViewportRef, isNearViewport] = useNearViewport<HTMLDivElement>()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pageRef = useRef<Awaited<ReturnType<PdfDocument['getPage']>> | undefined>(undefined)
  const renderTaskRef = useRef<
    ReturnType<Awaited<ReturnType<PdfDocument['getPage']>>['render']> | undefined
  >(undefined)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [aspectRatio, setAspectRatio] = useState(3 / 4)
  // Bumped when a fresh page proxy is acquired so rasterization re-runs against the new page.
  const [pageEpoch, setPageEpoch] = useState(0)

  // Acquire the page once while it is near the viewport and keep it alive; width changes then
  // re-rasterize this same page rather than reloading it through the range transport.
  useEffect(() => {
    if (!isNearViewport) return

    let canceled = false
    let disposed = false
    // Clear canvas backing storage on exit; removing the DOM node alone may retain its bitmap.
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      canceled = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = undefined
      pageRef.current?.cleanup()
      pageRef.current = undefined
      const canvas = canvasRef.current
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
    }
    const unregisterDisposer = registerDisposer(dispose)

    void document
      .getPage(pageNumber)
      .then((acquiredPage) => {
        if (canceled) {
          acquiredPage.cleanup()
          return
        }
        pageRef.current = acquiredPage
        setPageEpoch((epoch) => epoch + 1)
      })
      .catch((error: unknown) => {
        if (!canceled) {
          console.error(`Failed to load PDF page ${pageNumber}`, error)
          setStatus('error')
        }
      })

    return () => {
      unregisterDisposer()
      dispose()
    }
  }, [document, isNearViewport, pageNumber, registerDisposer])

  // Rasterize the live page at the target width; re-runs on width change without reacquiring it.
  // Tied to isNearViewport so a scroll-out flips this effect's canceled flag and stops a rerender.
  useEffect(() => {
    const page = pageRef.current
    const canvas = canvasRef.current
    if (!isNearViewport || !page || !canvas) return

    let canceled = false
    const draw = async (): Promise<void> => {
      // Serialize against the previous render: PDF.js forbids two renders on one canvas, and its
      // cancel() settles asynchronously, so a resize-driven rerun must await the prior task first.
      const previous = renderTaskRef.current
      if (previous) {
        previous.cancel()
        await previous.promise.catch(() => undefined)
      }
      // The await above yields, during which the page can scroll out and dispose() can clear it;
      // bail before touching a disposed page or detached canvas.
      if (canceled || pageRef.current !== page) return

      const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1)
      const baseViewport = page.getViewport({ scale: 1 })
      // Rasterize at the physical pixels the page occupies on screen; never below intrinsic size.
      const targetCssWidth = pageWidth > 0 ? pageWidth : baseViewport.width
      const desiredScale = Math.max(
        1,
        Math.min(MAX_RENDER_SCALE, (targetCssWidth * devicePixelRatio) / baseViewport.width)
      )
      // Hard cap so neither backing dimension nor total area exceeds browser canvas limits — must
      // win over the intrinsic floor, or a page taller than the limit at scale 1 renders blank.
      const limitScale = Math.min(
        MAX_CANVAS_DIMENSION / baseViewport.width,
        MAX_CANVAS_DIMENSION / baseViewport.height,
        Math.sqrt(MAX_CANVAS_AREA / (baseViewport.width * baseViewport.height))
      )
      const scale = Math.min(desiredScale, limitScale)
      const viewport = page.getViewport({ scale })
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas 2D context unavailable.')

      // Match the actual PDF page geometry so landscape and non-standard pages are not stretched.
      setAspectRatio(viewport.width / viewport.height)
      canvas.width = viewport.width
      canvas.height = viewport.height
      const renderTask = page.render({ canvas, canvasContext: context, viewport })
      renderTaskRef.current = renderTask
      await renderTask.promise
      if (renderTaskRef.current === renderTask) renderTaskRef.current = undefined
      if (!canceled) setStatus('ready')
    }

    void draw().catch((error: unknown) => {
      // A canceled render (scroll-out, preview switch, or superseding resize) is expected teardown.
      if (canceled || isRenderCancel(error)) return
      console.error(`Failed to render PDF page ${pageNumber}`, error)
      setStatus('error')
    })

    return () => {
      canceled = true
      renderTaskRef.current?.cancel()
    }
  }, [isNearViewport, pageEpoch, pageNumber, pageWidth])

  const displayedStatus = isNearViewport ? status : 'idle'

  return (
    <div
      ref={setNearViewportRef}
      className="relative mx-auto mb-3 w-full max-w-3xl bg-bg-000 shadow-sm"
      style={{ aspectRatio }}
      data-page-number={pageNumber}
    >
      {displayedStatus === 'loading' || (displayedStatus === 'idle' && isNearViewport) ? (
        <div className="absolute inset-0">
          <PreviewLoadingContent compact />
        </div>
      ) : null}
      {displayedStatus === 'error' ? (
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-text-300">
          Page {pageNumber} could not be rendered
        </div>
      ) : null}
      {isNearViewport ? (
        <canvas ref={canvasRef} width={0} height={0} className="block size-full object-contain" />
      ) : null}
    </div>
  )
}

export const PdfPreviewContent = ({
  path,
  name,
  source = 'artifact',
  mimeType,
  size,
  mtimeMs
}: {
  path: string
  name: string
  source?: PreviewFileSource
  mimeType?: string
  size?: number
  mtimeMs?: number
}): React.JSX.Element => {
  const requestKey = createPreviewResourceKey({ source, path, mimeType, size, mtimeMs })
  const [documentState, setDocumentState] = useState<DocumentState | null>(null)
  // The width one page fills: the content box, capped to a comfortable reading width. Owned here so
  // one ResizeObserver serves the whole document instead of one per page.
  const [fitWidth, setFitWidth] = useState(0)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const pageDisposersRef = useRef(new Set<() => void>())
  const registerPageDisposer = useCallback((dispose: () => void): (() => void) => {
    pageDisposersRef.current.add(dispose)
    return () => pageDisposersRef.current.delete(dispose)
  }, [])

  // Measure the content-box width before paint (zero-height probe, unaffected by page overflow) so
  // pages rasterize once at the right width on open, and only grow it so a shrink reuses the bitmap.
  useLayoutEffect(() => {
    const element = measureRef.current
    if (!element) return

    const measure = (): void => {
      const width = Math.min(element.clientWidth, FIT_PAGE_WIDTH)
      if (width > 0) setFitWidth((current) => (width > current ? width : current))
    }
    measure()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let canceled = false
    let document: PdfDocument | undefined
    let loadingTask: ReturnType<typeof createManagedPdfLoadingTask> | undefined
    let resourceId: string | undefined
    let disposePromise: Promise<void> | undefined
    const dispose = (): Promise<void> => {
      disposePromise ??= (async () => {
        // Cancel page renders before destroying their shared PDF.js document and resource.
        for (const disposePage of pageDisposersRef.current) disposePage()
        pageDisposersRef.current.clear()

        try {
          if (document) await document.destroy()
          else if (loadingTask) await loadingTask.destroy()
        } catch (error) {
          console.error('Failed to destroy PDF preview', error)
        }

        if (resourceId) {
          try {
            await window.api.previewResources.release({ resourceId })
          } catch (error) {
            console.error('Failed to release PDF preview resource', error)
          }
        }
      })()
      return disposePromise
    }

    void (async () => {
      try {
        const resource = await window.api.previewResources.acquire({
          source,
          path,
          ...(mimeType ? { mimeType } : {})
        })
        resourceId = resource.id
        if (canceled) {
          await dispose()
          return
        }

        loadingTask = createManagedPdfLoadingTask(resource)
        document = await loadingTask.promise
        if (canceled) {
          await dispose()
          return
        }

        setDocumentState({ requestKey, status: 'ready', document })
      } catch (error: unknown) {
        if (!isUnavailableFileError(error)) console.error('Failed to load PDF preview', error)
        if (!canceled) setDocumentState({ requestKey, status: 'error', error })
        await dispose()
      }
    })()

    return () => {
      canceled = true
      if (resourceId) void dispose()
    }
  }, [mimeType, path, requestKey, source])

  const currentDocumentState = documentState?.requestKey === requestKey ? documentState : null
  const hasError = currentDocumentState?.status === 'error'

  if (hasError) {
    return (
      <PreviewErrorCard
        name={name}
        error={currentDocumentState.error}
        fallbackMessage="This PDF couldn't be rendered for preview"
      />
    )
  }

  const document = currentDocumentState?.status === 'ready' ? currentDocumentState.document : null
  const pageCount = document?.numPages ?? 0

  return (
    <div className="relative size-full overflow-auto bg-bg-20 p-4">
      {/* Zero-height probe: reports the content-box width once for every page. */}
      <div ref={measureRef} className="h-0 w-full" aria-hidden="true" />
      {!document ? (
        <div className="absolute inset-0">
          <PreviewLoadingContent />
        </div>
      ) : null}
      {document
        ? Array.from({ length: pageCount }, (_, index) => (
            // Each page mounts its canvas only inside the viewport overscan window.
            <PdfPageCanvas
              key={index + 1}
              document={document}
              pageNumber={index + 1}
              pageWidth={fitWidth}
              registerDisposer={registerPageDisposer}
            />
          ))
        : null}
    </div>
  )
}

export const PdfPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => (
  <PdfPreviewContent
    path={item.path}
    name={item.name}
    source={item.source}
    mimeType={item.mimeType}
    size={item.size}
    mtimeMs={item.mtimeMs}
  />
)
