import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { PreviewErrorCard, PreviewLoadingContent } from '../PreviewFallback'
import { createManagedPdfLoadingTask } from '../managed-pdf-document'
import { isUnavailableFileError } from '../preview-errors'
import { createPreviewResourceKey } from '../preview-resource-key'
import { createPreviewRequestScope } from '../preview-file-reader'
import type { PreviewFileRendererProps } from '../preview-types'
import { useNearViewport } from '../useNearViewport'

type PdfDocument = Awaited<ReturnType<typeof createManagedPdfLoadingTask>['promise']>
type DocumentState =
  | { requestKey: string; status: 'ready'; document: PdfDocument }
  | { requestKey: string; status: 'error'; error: unknown }

// Comfortable reading width a page fills at 100%; zoom scales the displayed page beyond it.
const FIT_PAGE_WIDTH = 768
const MIN_ZOOM = 0.5
const MAX_ZOOM = 3
const ZOOM_BUTTON_STEP = 0.25
// Wheel zoom is proportional to accumulated deltaY so one trackpad/pinch gesture (many small
// events) maps to a controlled amount rather than a full step per event. ~100px notch ≈ 0.25.
const ZOOM_WHEEL_SENSITIVITY = 0.0025

const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))

// Bottom-right overlay mirroring the image preview's zoom affordances for a consistent feel.
const PdfZoomControls = ({
  zoom,
  onZoomIn,
  onZoomOut,
  onReset
}: {
  zoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onReset: () => void
}): React.JSX.Element => {
  const actions = [
    { label: 'Zoom out', icon: ZoomOut, onClick: onZoomOut, disabled: zoom <= MIN_ZOOM },
    { label: 'Reset zoom', icon: Maximize2, onClick: onReset, disabled: zoom === 1 },
    { label: 'Zoom in', icon: ZoomIn, onClick: onZoomIn, disabled: zoom >= MAX_ZOOM }
  ]

  return (
    <TooltipProvider delayDuration={300}>
      <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-md border border-border-300/50 bg-bg-000/90 p-1 shadow-sm backdrop-blur">
        <span className="min-w-[3ch] px-1 text-center text-[11px] tabular-nums text-text-200">
          {Math.round(zoom * 100)}%
        </span>
        {actions.map(({ label, icon: Icon, onClick, disabled }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-text-100 hover:text-text-000"
                aria-label={label}
                disabled={disabled}
                onClick={onClick}
              >
                <Icon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  )
}
// Keep the backing store within browser canvas limits so a tall/narrow or heavily zoomed page
// cannot render blank: clamp each side and the total area (Chromium caps a dimension at 16384 and
// area near 2^28).
const MAX_CANVAS_DIMENSION = 8192
const MAX_CANVAS_AREA = 16 * 1024 * 1024
// Per-page backing-scale ceiling. Set above the ~4.5 that a full-width page needs at 175% zoom on
// a 2x display, so normal zoom stays crisp, while capping the deepest zoom so a few near-viewport
// pages cannot each allocate the full canvas-area budget and spike renderer memory.
const MAX_RENDER_SCALE = 5

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
      // Rasterize at the physical pixels the page occupies on screen (never below intrinsic size)
      // so zoom stays crisp at any DPI, capped by MAX_RENDER_SCALE so the deepest zoom cannot
      // allocate the full canvas budget per page.
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
      className={cn(
        'relative bg-bg-000 shadow-sm',
        // Alignment is owned by the parent column; fall back to a responsive width until it has
        // measured the fit width.
        pageWidth > 0 ? 'max-w-none' : 'w-full max-w-3xl'
      )}
      style={pageWidth > 0 ? { aspectRatio, width: pageWidth } : { aspectRatio }}
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
  projectId,
  sessionId,
  mimeType,
  size,
  mtimeMs
}: {
  path: string
  name: string
  source?: PreviewFileSource
  projectId?: string
  sessionId?: string
  mimeType?: string
  size?: number
  mtimeMs?: number
}): React.JSX.Element => {
  const requestKey = createPreviewResourceKey({
    projectId,
    sessionId,
    source,
    path,
    mimeType,
    size,
    mtimeMs
  })
  const [documentState, setDocumentState] = useState<DocumentState | null>(null)
  const [zoom, setZoom] = useState(1)
  // The PreviewPanel path remounts on a file switch, but the Files-tab dialog updates item in place
  // with no contentKey, so reset zoom to fit whenever the previewed file changes (adjust-on-render).
  const [zoomedKey, setZoomedKey] = useState(requestKey)
  if (zoomedKey !== requestKey) {
    setZoomedKey(requestKey)
    setZoom(1)
  }
  // The width one page fills at 100%: the content box, capped to a comfortable reading width. Owned
  // here so one ResizeObserver serves the whole document instead of one per page.
  const [fitWidth, setFitWidth] = useState(0)
  // The real (uncapped) content-box width, used only to decide when a zoomed page actually
  // overflows the viewport — distinct from the capped fitWidth that sizes a 100% page.
  const [viewportWidth, setViewportWidth] = useState(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const pageDisposersRef = useRef(new Set<() => void>())
  const registerPageDisposer = useCallback((dispose: () => void): (() => void) => {
    pageDisposersRef.current.add(dispose)
    return () => pageDisposersRef.current.delete(dispose)
  }, [])

  // Ctrl/Cmd+wheel zooms the document instead of scrolling, matching the image preview gesture.
  // A trackpad/pinch emits many small wheel events per gesture, so accumulate deltaY and apply it
  // proportionally once per frame — one gesture yields a controlled zoom and few rerasterizations.
  // Keyed to requestKey and run as a layout effect so a file switch cancels any queued frame during
  // commit — before the browser's rAF phase — so a stale flush cannot re-apply zoom on top of the
  // new document's reset (a passive-effect cleanup would run after paint, too late to cancel it).
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return

    let pendingDelta = 0
    let frame: number | undefined
    const flush = (): void => {
      frame = undefined
      const delta = pendingDelta
      pendingDelta = 0
      if (delta !== 0) setZoom((current) => clampZoom(current - delta * ZOOM_WHEEL_SENSITIVITY))
    }
    const handleWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      pendingDelta += event.deltaY
      frame ??= requestAnimationFrame(flush)
    }

    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', handleWheel)
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [requestKey])

  // Measure the content-box width before paint (zero-height probe, unaffected by page overflow) so
  // pages rasterize once at the right width on open. Tracks the current width so pages stay
  // responsive: narrowing the panel (or returning from full screen) shrinks them back to fit.
  useLayoutEffect(() => {
    const element = measureRef.current
    if (!element) return

    const measure = (): void => {
      const raw = element.clientWidth
      if (raw <= 0) return
      const width = Math.min(raw, FIT_PAGE_WIDTH)
      setFitWidth((current) => (width === current ? current : width))
      setViewportWidth((current) => (raw === current ? current : raw))
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
          ...createPreviewRequestScope({ projectId, sessionId, source, path }),
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
  }, [mimeType, path, projectId, requestKey, sessionId, source])

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
  const pageWidth = fitWidth > 0 ? Math.round(fitWidth * zoom) : 0
  const zoomBy = (delta: number): void => setZoom((current) => clampZoom(current + delta))

  return (
    <div className="relative size-full overflow-hidden bg-bg-20">
      {/* The inner element is the real scroller (the outer div holds the fixed zoom overlay), so it
          must be keyboard-focusable or PageUp/Down, Space, and arrows never reach the PDF. */}
      <div
        ref={scrollRef}
        className="size-full overflow-auto p-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
        tabIndex={0}
        role="region"
        aria-label={`${name} scrollable preview`}
      >
        {/* Zero-height probe: reports the content-box width even when pages overflow horizontally. */}
        <div ref={measureRef} className="h-0 w-full" aria-hidden="true" />
        {!document ? (
          <div className="absolute inset-0">
            <PreviewLoadingContent />
          </div>
        ) : null}
        {document ? (
          // Center pages while they fit the real viewport, but left-align once a zoomed page
          // overflows it: a centered overflow puts the left margin before scrollLeft=0, making it
          // unreachable. Compared against the uncapped viewport width, not the reading-width cap,
          // so a page still fitting a wide/full-screen pane stays centered.
          <div
            className={cn(
              'flex min-w-full flex-col gap-3',
              viewportWidth > 0 && pageWidth > viewportWidth ? 'items-start' : 'items-center'
            )}
          >
            {Array.from({ length: pageCount }, (_, index) => (
              // Each page mounts its canvas only inside the viewport overscan window.
              <PdfPageCanvas
                key={index + 1}
                document={document}
                pageNumber={index + 1}
                pageWidth={pageWidth}
                registerDisposer={registerPageDisposer}
              />
            ))}
          </div>
        ) : null}
      </div>
      {document ? (
        <PdfZoomControls
          zoom={zoom}
          onZoomIn={() => zoomBy(ZOOM_BUTTON_STEP)}
          onZoomOut={() => zoomBy(-ZOOM_BUTTON_STEP)}
          onReset={() => setZoom(1)}
        />
      ) : null}
    </div>
  )
}

export const PdfPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => (
  <PdfPreviewContent
    path={item.path}
    name={item.name}
    source={item.source}
    projectId={item.projectId}
    sessionId={item.sessionId}
    mimeType={item.mimeType}
    size={item.size}
    mtimeMs={item.mtimeMs}
  />
)
