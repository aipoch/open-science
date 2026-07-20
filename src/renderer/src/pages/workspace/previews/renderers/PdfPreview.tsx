import { useCallback, useEffect, useRef, useState } from 'react'

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

// Owns one lazy page canvas and releases its decoded bitmap outside the overscan window.
const PdfPageCanvas = ({
  document,
  pageNumber,
  registerDisposer
}: {
  document: PdfDocument
  pageNumber: number
  registerDisposer: (dispose: () => void) => () => void
}): React.JSX.Element => {
  const [setContainer, isNearViewport] = useNearViewport<HTMLDivElement>()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [aspectRatio, setAspectRatio] = useState(3 / 4)

  useEffect(() => {
    if (!isNearViewport) return

    let canceled = false
    let page: Awaited<ReturnType<PdfDocument['getPage']>> | undefined
    let renderTask: ReturnType<Awaited<ReturnType<PdfDocument['getPage']>>['render']> | undefined
    const canvas = canvasRef.current
    let disposed = false
    // Clear canvas backing storage on exit; removing the DOM node alone may retain its bitmap.
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      canceled = true
      renderTask?.cancel()
      page?.cleanup()
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
    }
    const unregisterDisposer = registerDisposer(dispose)

    void document
      .getPage(pageNumber)
      .then(async (loadedPage) => {
        page = loadedPage
        if (canceled || !canvas) {
          loadedPage.cleanup()
          page = undefined
          return
        }

        const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
        const viewport = loadedPage.getViewport({ scale })
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Canvas 2D context unavailable.')

        // Match the actual PDF page geometry so landscape and non-standard pages are not stretched.
        setAspectRatio(viewport.width / viewport.height)
        canvas.width = viewport.width
        canvas.height = viewport.height
        renderTask = loadedPage.render({ canvas, canvasContext: context, viewport })
        await renderTask.promise
        if (!canceled) setStatus('ready')
      })
      .catch((error: unknown) => {
        if (!canceled) {
          console.error(`Failed to render PDF page ${pageNumber}`, error)
          setStatus('error')
        }
      })

    return () => {
      unregisterDisposer()
      dispose()
    }
  }, [document, isNearViewport, pageNumber, registerDisposer])

  const displayedStatus = isNearViewport ? status : 'idle'

  return (
    <div
      ref={setContainer}
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
  const pageDisposersRef = useRef(new Set<() => void>())
  const registerPageDisposer = useCallback((dispose: () => void): (() => void) => {
    pageDisposersRef.current.add(dispose)
    return () => pageDisposersRef.current.delete(dispose)
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
        path={path}
        name={name}
        source={source}
        error={currentDocumentState.error}
        fallbackMessage="This PDF couldn't be rendered for preview"
      />
    )
  }

  const document = currentDocumentState?.status === 'ready' ? currentDocumentState.document : null
  const pageCount = document?.numPages ?? 0

  return (
    <div className="relative size-full overflow-auto bg-bg-20 p-4">
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
