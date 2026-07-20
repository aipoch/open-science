import { useEffect, useRef, useState } from 'react'
import { FileWarning } from 'lucide-react'

import type { PreviewFileItem, PreviewFileSource } from '@/stores/preview-workbench-store'

import { readManagedFileBytes } from '../managed-file-bytes'
import type { OfficeFileExtension } from '../office-package'
import {
  DOCX_PREVIEW_MAX_COMPRESSED_BYTES,
  isLegacyExcelFile,
  OFFICE_PREVIEW_MAX_COMPRESSED_BYTES,
  validateOfficePackage
} from '../office-package'
import {
  renderOfficeFile,
  type OfficeRenderCleanup,
  type OfficeRenderStatus
} from '../office-renderers'
import { PreviewFallbackCard, PreviewLoadingContent } from '../PreviewFallback'
import { usePreviewRuntime } from '../preview-runtime'
import type { PreviewFileRendererProps } from '../preview-types'

export const OFFICE_PREVIEW_TIMEOUT_MS = 30_000
export const LARGE_SPREADSHEET_PREVIEW_TIMEOUT_MS = 120_000

const LARGE_SPREADSHEET_PREVIEW_BYTES = 20 * 1024 * 1024
const MAX_OFFICE_RETRY_TIMEOUT_MS = 300_000

// Every retry gets one fixed doubled allowance; repeated retries never compound the timeout.
const getOfficePreviewTimeoutMs = (item: PreviewFileItem, attempt: number): number => {
  const defaultTimeout =
    item.format === 'spreadsheet' && (item.size ?? 0) >= LARGE_SPREADSHEET_PREVIEW_BYTES
      ? LARGE_SPREADSHEET_PREVIEW_TIMEOUT_MS
      : OFFICE_PREVIEW_TIMEOUT_MS

  return attempt > 0 ? Math.min(defaultTimeout * 2, MAX_OFFICE_RETRY_TIMEOUT_MS) : defaultTimeout
}

type OfficeRenderState = {
  key: string
  status: 'ready' | 'error'
  message?: string
}

type OfficeLoadingState = OfficeRenderStatus & {
  key: string
}

// Resolves ambiguous spreadsheet names from their container signature while other formats are fixed.
const resolveOfficeExtension = (item: PreviewFileItem, bytes: Uint8Array): OfficeFileExtension => {
  if (item.format === 'word') return 'docx'
  if (item.format === 'presentation') return 'pptx'
  if (item.name.toLowerCase().endsWith('.xls')) return 'xls'
  if (item.name.toLowerCase().endsWith('.xlsx')) return 'xlsx'

  return isLegacyExcelFile(bytes) ? 'xls' : 'xlsx'
}

// Runs sync or async vendor cleanup without letting disposal failures break React lifecycle cleanup.
const disposeOfficeRender = (cleanup: OfficeRenderCleanup | undefined): void => {
  if (!cleanup) return

  Promise.resolve(cleanup()).catch((error) => {
    console.error('Failed to dispose Office preview', error)
  })
}

// Owns the read, preflight, renderer, timeout, and cleanup lifecycle for one managed Office file.
export const OfficePreviewContent = ({
  item,
  source = 'artifact'
}: {
  item: PreviewFileItem
  source?: PreviewFileSource
}): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [renderState, setRenderState] = useState<OfficeRenderState | null>(null)
  const [loadingState, setLoadingState] = useState<OfficeLoadingState | null>(null)
  const attempt = usePreviewRuntime()?.attempt ?? 0
  const renderKey = `${source}:${item.path}:${item.name}:${item.format}`
  const timeoutMs = getOfficePreviewTimeoutMs(item, attempt)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Each generation gets a disposable child target so an unabortable stale renderer can only
    // mutate detached DOM after the next file replaces it.
    const renderTarget = container.ownerDocument.createElement('div')
    renderTarget.className = 'size-full'
    container.replaceChildren(renderTarget)

    const controller = new AbortController()
    let canceled = false
    let timedOut = false
    let cleanup: OfficeRenderCleanup | undefined

    const timeout = window.setTimeout(() => {
      if (canceled) return

      timedOut = true
      controller.abort(new Error('Office preview timed out'))
      disposeOfficeRender(cleanup)
      cleanup = undefined
      setRenderState({
        key: renderKey,
        status: 'error',
        message: 'This Office file took too long to preview'
      })
    }, timeoutMs)

    const render = async (): Promise<void> => {
      // Check the format-specific limit against managed stat metadata before any range transfer.
      const maxBytes =
        item.format === 'word'
          ? DOCX_PREVIEW_MAX_COMPRESSED_BYTES
          : OFFICE_PREVIEW_MAX_COMPRESSED_BYTES
      const bytes = await readManagedFileBytes(item.path, source, maxBytes)
      if (canceled || controller.signal.aborted) return

      const extension = resolveOfficeExtension(item, bytes)
      await validateOfficePackage(bytes, extension, controller.signal)
      const nextCleanup = await renderOfficeFile({
        bytes,
        extension,
        name: item.name,
        container: renderTarget,
        scrollContainer: container,
        signal: controller.signal,
        // The application remains the sole owner of blocking loading chrome across vendor phases.
        onStatus: (status) => {
          if (canceled || controller.signal.aborted) return
          setLoadingState({ key: renderKey, ...status })
        }
      })

      // Some third-party renderers ignore AbortSignal; dispose their late result immediately.
      if (canceled || controller.signal.aborted) {
        disposeOfficeRender(nextCleanup)
        return
      }

      cleanup = nextCleanup
      window.clearTimeout(timeout)
      setRenderState({ key: renderKey, status: 'ready' })
    }

    render().catch((error) => {
      if (canceled || timedOut || controller.signal.aborted) return

      window.clearTimeout(timeout)
      console.error('Failed to render Office preview', error)
      setRenderState({ key: renderKey, status: 'error' })
    })

    return () => {
      canceled = true
      window.clearTimeout(timeout)
      controller.abort()
      disposeOfficeRender(cleanup)
      cleanup = undefined
    }
  }, [item, renderKey, source, timeoutMs])

  const state = renderState?.key === renderKey ? renderState : null
  const loading = loadingState?.key === renderKey ? loadingState : null
  if (state?.status === 'error') {
    return (
      <PreviewFallbackCard
        icon={FileWarning}
        name={item.name}
        title={state.message ? 'Preview timed out' : 'Preview unavailable'}
        message={state.message ?? "This Office file couldn't be rendered for preview"}
        retryable
      />
    )
  }

  // Preview content is read-only; block both primary and auxiliary activation of generated links.
  const blockDocumentLink = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!(target instanceof Element) || !target.closest('a')) return

    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <div className="relative size-full overflow-hidden bg-bg-20">
      {!state && (
        <div className="absolute inset-0 z-10 bg-bg-20">
          <PreviewLoadingContent title={loading?.title} description={loading?.description} />
        </div>
      )}
      <div
        ref={containerRef}
        className="office-preview-content size-full overflow-auto p-4"
        onClickCapture={blockDocumentLink}
        onAuxClickCapture={blockDocumentLink}
      />
    </div>
  )
}

export const OfficePreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => (
  <OfficePreviewContent item={item} source={item.source} />
)
