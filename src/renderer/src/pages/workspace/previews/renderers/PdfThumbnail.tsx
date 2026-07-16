import { useEffect, useState } from 'react'
import { FileText } from 'lucide-react'

import type { AcquireManagedPreviewRequest } from '../../../../../../shared/preview-resources'
import type { ManagedPreviewResource } from '../../../../../../shared/preview-resources'
import type { PreviewFileSource } from '@/stores/preview-workbench-store'

import { createManagedPdfLoadingTask } from '../managed-pdf-document'
import { isUnavailableFileError } from '../preview-errors'
import { useNearViewport } from '../useNearViewport'

const THUMBNAIL_WIDTH = 220
const MAX_CACHE_BYTES = 16 * 1024 * 1024
const MAX_CONCURRENT_RENDERS = 2

type RenderedThumbnail = { url: string; size: number }
type ThumbnailCacheEntry = RenderedThumbnail & {
  fileSize: number
  resourceVersion: number
}
const thumbnailCache = new Map<string, ThumbnailCacheEntry>()
let thumbnailCacheBytes = 0
let activeRenderCount = 0
const pendingRenders: Array<() => void> = []
type ThumbnailJob = {
  promise: Promise<void>
  subscribers: number
  abort: () => void
}
const thumbnailJobs = new Map<string, ThumbnailJob>()

const createAbortError = (): Error =>
  Object.assign(new Error('PDF thumbnail render aborted.'), { name: 'AbortError' })
const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError'

const getCachedThumbnail = (key: string): ThumbnailCacheEntry | undefined => {
  const entry = thumbnailCache.get(key)
  if (!entry) return undefined

  // Reinsert on access so Map iteration order doubles as an LRU queue.
  thumbnailCache.delete(key)
  thumbnailCache.set(key, entry)
  return entry
}

const cacheThumbnail = (key: string, entry: ThumbnailCacheEntry): void => {
  const existing = thumbnailCache.get(key)
  if (existing) {
    thumbnailCacheBytes -= existing.size
    URL.revokeObjectURL(existing.url)
    thumbnailCache.delete(key)
  }

  thumbnailCache.set(key, entry)
  thumbnailCacheBytes += entry.size

  while (thumbnailCacheBytes > MAX_CACHE_BYTES && thumbnailCache.size > 1) {
    const oldest = thumbnailCache.entries().next().value as
      [string, ThumbnailCacheEntry] | undefined
    if (!oldest) break

    thumbnailCache.delete(oldest[0])
    thumbnailCacheBytes -= oldest[1].size
    URL.revokeObjectURL(oldest[1].url)
  }
}

const acquireRenderSlot = (signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return Promise.reject(createAbortError())
  if (activeRenderCount < MAX_CONCURRENT_RENDERS) {
    activeRenderCount += 1
    return Promise.resolve()
  }

  // Queue expensive canvas renders and remove canceled entries before they consume a slot.
  return new Promise((resolve, reject) => {
    const start = (): void => {
      signal.removeEventListener('abort', cancel)
      if (signal.aborted) {
        reject(createAbortError())
        return
      }

      activeRenderCount += 1
      resolve()
    }
    const cancel = (): void => {
      const index = pendingRenders.indexOf(start)
      if (index >= 0) pendingRenders.splice(index, 1)
      reject(createAbortError())
    }

    pendingRenders.push(start)
    signal.addEventListener('abort', cancel, { once: true })
  })
}

const runWithRenderSlot = async <Result,>(
  task: () => Promise<Result>,
  signal: AbortSignal
): Promise<Result> => {
  await acquireRenderSlot(signal)

  try {
    if (signal.aborted) throw createAbortError()
    return await task()
  } finally {
    activeRenderCount -= 1
    pendingRenders.shift()?.()
  }
}

const canvasToPngBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('PDF thumbnail encoding failed.'))
    }, 'image/png')
  })

// Renders and encodes only the first page, then tears down all PDF.js state.
const renderFirstPage = async (
  resource: ManagedPreviewResource,
  signal: AbortSignal
): Promise<RenderedThumbnail> => {
  if (signal.aborted) throw createAbortError()

  const loadingTask = createManagedPdfLoadingTask(resource)
  let document: Awaited<typeof loadingTask.promise> | undefined
  let page: Awaited<ReturnType<Awaited<typeof loadingTask.promise>['getPage']>> | undefined
  let renderTask: ReturnType<NonNullable<typeof page>['render']> | undefined
  let destroyPromise: Promise<void> | undefined
  const destroy = (): Promise<void> => {
    destroyPromise ??= document ? document.destroy() : loadingTask.destroy()
    return destroyPromise
  }
  const abort = (): void => {
    renderTask?.cancel()
    void destroy()
  }

  signal.addEventListener('abort', abort, { once: true })

  try {
    if (signal.aborted) {
      abort()
      throw createAbortError()
    }

    document = await loadingTask.promise
    if (signal.aborted) throw createAbortError()

    // Thumbnails intentionally request only page one through the range transport.
    page = await document.getPage(1)
    if (signal.aborted) throw createAbortError()

    const baseViewport = page.getViewport({ scale: 1 })
    const scale = THUMBNAIL_WIDTH / baseViewport.width
    const viewport = page.getViewport({ scale })
    const canvas = window.document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D context unavailable.')

    canvas.width = viewport.width
    canvas.height = viewport.height
    renderTask = page.render({ canvasContext: context, viewport })
    await renderTask.promise
    if (signal.aborted) throw createAbortError()

    const blob = await canvasToPngBlob(canvas)
    if (signal.aborted) throw createAbortError()
    return { url: URL.createObjectURL(blob), size: blob.size }
  } finally {
    signal.removeEventListener('abort', abort)
    page?.cleanup()
    await destroy()
  }
}

// Creates one cancellable resource-and-render pipeline for a versioned file identity.
const createThumbnailJob = (
  requestKey: string,
  request: AcquireManagedPreviewRequest
): ThumbnailJob => {
  const abortController = new AbortController()
  const promise = runWithRenderSlot(async () => {
    let resource: ManagedPreviewResource | undefined

    try {
      resource = await window.api.previewResources.acquire(request)
      if (abortController.signal.aborted) throw createAbortError()

      // The main-process stat is authoritative when validating a renderer-side cached image.
      const cached = getCachedThumbnail(requestKey)
      if (cached?.resourceVersion === resource.version && cached.fileSize === resource.size) {
        return
      }

      const entry = await renderFirstPage(resource, abortController.signal)
      if (abortController.signal.aborted) {
        URL.revokeObjectURL(entry.url)
        throw createAbortError()
      }
      cacheThumbnail(requestKey, {
        ...entry,
        fileSize: resource.size,
        resourceVersion: resource.version
      })
    } finally {
      if (resource) {
        await window.api.previewResources.release({ resourceId: resource.id })
      }
    }
  }, abortController.signal).catch((error: unknown) => {
    if (abortController.signal.aborted) throw createAbortError()
    throw error
  })
  const job: ThumbnailJob = {
    promise,
    subscribers: 0,
    abort: () => abortController.abort()
  }
  thumbnailJobs.set(requestKey, job)
  const removeJob = (): void => {
    if (thumbnailJobs.get(requestKey) === job) thumbnailJobs.delete(requestKey)
  }
  void promise.then(removeJob, removeJob)
  return job
}

const subscribeThumbnailJob = (
  requestKey: string,
  request: AcquireManagedPreviewRequest
): { promise: Promise<void>; unsubscribe: () => void } => {
  // Duplicate tiles share one acquire/render job; the final subscriber owns cancellation.
  const job = thumbnailJobs.get(requestKey) ?? createThumbnailJob(requestKey, request)
  job.subscribers += 1
  let subscribed = true

  return {
    promise: job.promise,
    unsubscribe: () => {
      if (!subscribed) return
      subscribed = false
      job.subscribers -= 1
      if (job.subscribers === 0) {
        if (thumbnailJobs.get(requestKey) === job) thumbnailJobs.delete(requestKey)
        job.abort()
      }
    }
  }
}

const PdfIconFallback = (): React.JSX.Element => (
  <div className="flex size-full items-center justify-center bg-bg-000">
    <FileText className="size-7 text-text-300" aria-hidden />
  </div>
)

export const PdfThumbnail = ({
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
  const requestKey = JSON.stringify([source, path, mimeType ?? null, size ?? null, mtimeMs ?? null])
  const [setElement, isNearViewport] = useNearViewport<HTMLDivElement>()
  const [result, setResult] = useState<{ requestKey: string; status: 'ready' | 'error' } | null>(
    null
  )
  const cached = getCachedThumbnail(requestKey)
  const hasCurrentResult = result?.requestKey === requestKey
  const hasCurrentError = hasCurrentResult && result.status === 'error'
  // Off-screen tiles retain only an encoded thumbnail and do not keep a PDF document alive.
  const shouldRender = isNearViewport && !hasCurrentError && (!hasCurrentResult || !cached)

  useEffect(() => {
    if (!shouldRender) return

    const subscription = subscribeThumbnailJob(requestKey, {
      source,
      path,
      ...(mimeType ? { mimeType } : {})
    })
    let subscribed = true
    void subscription.promise
      .then(() => {
        if (!subscribed) return
        setResult({ requestKey, status: 'ready' })
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return
        if (!isUnavailableFileError(error)) console.error('Failed to render PDF thumbnail', error)
        if (subscribed) setResult({ requestKey, status: 'error' })
      })

    return () => {
      subscribed = false
      subscription.unsubscribe()
    }
  }, [mimeType, path, requestKey, shouldRender, source])

  return (
    <div ref={setElement} className="size-full">
      {cached ? (
        <img
          src={cached.url}
          alt={`Preview of ${name}`}
          className="size-full object-cover object-top"
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      ) : (
        <PdfIconFallback />
      )}
    </div>
  )
}
