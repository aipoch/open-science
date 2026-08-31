import type { Rectangle } from 'electron'

import type { ManagedPreviewResource } from '../../shared/preview-resources'
import type { FileObservation } from '../bounded-file-io'
import {
  OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES,
  OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS
} from '../../shared/office-preview'
import type { ReviewerPagedContentResolver } from './host-sdk'

const MAX_REVIEWER_PREVIEW_SOURCE_BYTES = 40 * 1024 * 1024
const MAX_REVIEWER_PREVIEW_PAGES = 32
const MAX_REVIEWER_DOCX_TARGET_PAGE = 512

type ReviewerPreviewPage = {
  pageNumber: number
  text: string
  rect: Rectangle
}

type ReviewerCapturedImage = {
  getSize(): { width: number; height: number }
  resize(options: { width: number; height: number; quality: 'better' }): ReviewerCapturedImage
  toJPEG(quality: number): Buffer
}

type ReviewerPreviewWindow = {
  webContents: {
    readonly id: number
    getOSProcessId(): number
    once(event: 'render-process-gone', listener: () => void): void
    removeListener(event: 'render-process-gone', listener: () => void): void
    executeJavaScript(script: string): Promise<unknown>
    capturePage(rect: Rectangle): Promise<ReviewerCapturedImage>
  }
  loadURL(url: string): Promise<void>
  isDestroyed(): boolean
  destroy(): void
}

type ReviewerPagedPreviewDependencies = {
  createWindow(): ReviewerPreviewWindow
  createSessionId(): string
  createRuntimeUrl(sessionId: string): string
  acquireResource(
    ownerId: number,
    resolvedPath: string,
    filename: string,
    verifiedObservation: FileObservation,
    verifiedChecksum: string,
    maxBytes: number
  ): Promise<ManagedPreviewResource>
  releaseResource(ownerId: number, resourceId: string): void | Promise<void>
  renderPdfPages(
    path: string,
    pages: number[],
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<{
    pageCount: number
    media: Array<{ pageNumber: number; data: string; mimeType: 'image/jpeg' }>
    budgetExhaustedPages: number[]
  }>
  getProcessMemoryUsageBytes?(processId: number): number | Promise<number>
}

type ReviewerPreviewInitialization = {
  pageCount: number
  pageCountComplete?: boolean
  availablePages?: number[]
}

const parseInitialization = (value: unknown): ReviewerPreviewInitialization => {
  const result = value as Partial<ReviewerPreviewInitialization> | undefined
  if (!Number.isSafeInteger(result?.pageCount) || (result?.pageCount ?? 0) < 1) {
    throw new Error('Reviewer preview runtime returned an invalid page count.')
  }
  const availablePages = result?.availablePages
  if (
    availablePages !== undefined &&
    (!Array.isArray(availablePages) ||
      availablePages.some((page) => !Number.isSafeInteger(page) || page < 1))
  ) {
    throw new Error('Reviewer preview runtime returned invalid available pages.')
  }
  if (result?.pageCountComplete !== undefined && typeof result.pageCountComplete !== 'boolean') {
    throw new Error('Reviewer preview runtime returned invalid page count completeness.')
  }
  return {
    pageCount: result!.pageCount!,
    ...(result?.pageCountComplete !== undefined
      ? { pageCountComplete: result.pageCountComplete }
      : {}),
    ...(availablePages ? { availablePages } : {})
  }
}

const parsePage = (value: unknown, requestedPage: number): ReviewerPreviewPage => {
  const page = value as Partial<ReviewerPreviewPage> | undefined
  const rect = page?.rect
  if (
    page?.pageNumber !== requestedPage ||
    typeof page.text !== 'string' ||
    !rect ||
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    throw new Error(`Reviewer preview runtime did not return page ${requestedPage}.`)
  }
  return {
    pageNumber: requestedPage,
    text: page.text,
    rect: {
      x: Math.max(0, Math.floor(rect.x)),
      y: Math.max(0, Math.floor(rect.y)),
      width: Math.max(1, Math.ceil(rect.width)),
      height: Math.max(1, Math.ceil(rect.height))
    }
  }
}

const runtimeCall = (method: 'initialize' | 'preparePage', argument: unknown): string =>
  `window.__openScienceReviewerPagedPreview.${method}(${JSON.stringify(argument)})`

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw signal.reason ?? new Error('Reviewer page preview was aborted.')
}

const createReviewerPagedContentResolver = (
  dependencies: ReviewerPagedPreviewDependencies
): ReviewerPagedContentResolver => {
  const resolveOne: ReviewerPagedContentResolver = async (request) => {
    if (request.pages.length < 1 || request.pages.length > MAX_REVIEWER_PREVIEW_PAGES) {
      throw new Error(`Reviewer preview supports 1-${MAX_REVIEWER_PREVIEW_PAGES} target pages.`)
    }
    if (
      request.format === 'docx' &&
      request.pages.some((page) => page > MAX_REVIEWER_DOCX_TARGET_PAGE)
    ) {
      return {
        pageCount: Math.max(...request.pages),
        pages: [],
        limitations: [
          {
            kind: 'budget-exhausted',
            subjectId: request.artifactVersionId,
            detail: `DOCX page target exceeds the bounded layout limit of ${MAX_REVIEWER_DOCX_TARGET_PAGE}.`
          }
        ]
      }
    }
    throwIfAborted(request.signal)
    if (request.format === 'pdf') {
      const preview = await dependencies.renderPdfPages(
        request.path,
        request.pages,
        request.maxBytes,
        request.signal
      )
      return {
        pageCount: preview.pageCount,
        pages: request.pages.map((pageNumber) => ({ pageNumber, text: '' })),
        ...(preview.media.length > 0 ? { media: preview.media } : {}),
        ...(preview.budgetExhaustedPages.length > 0
          ? {
              limitations: preview.budgetExhaustedPages.map((pageNumber) => ({
                kind: 'budget-exhausted' as const,
                subjectId: request.artifactVersionId,
                detail: `Rendered PDF page ${pageNumber} image exceeded the Reviewer preview budget.`
              }))
            }
          : {})
      }
    }
    const previewWindow = dependencies.createWindow()
    const ownerId = previewWindow.webContents.id
    let resource: ManagedPreviewResource | undefined
    let acquisition: Promise<ManagedPreviewResource> | undefined
    const destroyWindow = (): void => {
      if (!previewWindow.isDestroyed()) previewWindow.destroy()
    }
    let rejectLifecycle: (error: Error) => void = () => undefined
    const lifecycleFailure = new Promise<never>((_, reject) => {
      rejectLifecycle = reject
    })
    const failLifecycle = (error: Error): void => {
      destroyWindow()
      rejectLifecycle(error)
    }
    const onAbort = (): void =>
      failLifecycle(
        request.signal?.reason instanceof Error
          ? request.signal.reason
          : new Error('Reviewer page preview was aborted.')
      )
    const onRendererGone = (): void =>
      failLifecycle(new Error('Reviewer page preview renderer exited unexpectedly.'))
    request.signal?.addEventListener('abort', onAbort, { once: true })
    previewWindow.webContents.once('render-process-gone', onRendererGone)
    const timeout = setTimeout(
      () => failLifecycle(new Error('Reviewer page preview timed out.')),
      120_000
    )
    let memoryPollInFlight = false
    const memoryPoll = dependencies.getProcessMemoryUsageBytes
      ? setInterval(() => {
          if (memoryPollInFlight || previewWindow.isDestroyed()) return
          memoryPollInFlight = true
          void Promise.resolve(
            dependencies.getProcessMemoryUsageBytes!(previewWindow.webContents.getOSProcessId())
          )
            .then((bytes) => {
              if (bytes >= OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES) {
                failLifecycle(new Error('Reviewer page preview exceeded its memory limit.'))
              }
            })
            .catch((error: unknown) =>
              failLifecycle(error instanceof Error ? error : new Error(String(error)))
            )
            .finally(() => {
              memoryPollInFlight = false
            })
        }, OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS)
      : undefined
    const guarded = <Result>(operation: Promise<Result>): Promise<Result> =>
      Promise.race([operation, lifecycleFailure])

    try {
      acquisition = dependencies.acquireResource(
        ownerId,
        request.path,
        request.filename,
        request.verifiedObservation,
        request.verifiedChecksum,
        MAX_REVIEWER_PREVIEW_SOURCE_BYTES
      )
      resource = await guarded(acquisition)
      throwIfAborted(request.signal)
      const sessionId = dependencies.createSessionId()
      await guarded(previewWindow.loadURL(dependencies.createRuntimeUrl(sessionId)))
      throwIfAborted(request.signal)
      const initialization = parseInitialization(
        await guarded(
          previewWindow.webContents.executeJavaScript(
            runtimeCall('initialize', {
              sessionId,
              resource,
              format: request.format,
              pages: request.pages
            })
          )
        )
      )
      const pages: Array<{ pageNumber: number; text: string }> = []
      const media: Array<{ pageNumber: number; data: string; mimeType: string }> = []
      const limitations: NonNullable<
        Awaited<ReturnType<ReviewerPagedContentResolver>>['limitations']
      > = []
      let returnedBytes = 0
      const availablePages = new Set(initialization.availablePages ?? request.pages)

      for (const pageNumber of [...new Set(request.pages)]) {
        if (!availablePages.has(pageNumber)) {
          limitations.push({
            kind: 'truncated',
            subjectId: request.artifactVersionId,
            detail: `Rendered document did not contain requested page ${pageNumber}.`
          })
          continue
        }
        throwIfAborted(request.signal)
        const prepared = parsePage(
          await guarded(
            previewWindow.webContents.executeJavaScript(runtimeCall('preparePage', { pageNumber }))
          ),
          pageNumber
        )
        const textBytes = Buffer.byteLength(prepared.text, 'utf8')
        if (returnedBytes + textBytes <= request.maxBytes) {
          pages.push({ pageNumber, text: prepared.text })
          returnedBytes += textBytes
        } else {
          pages.push({ pageNumber, text: '' })
          limitations.push({
            kind: 'budget-exhausted',
            subjectId: request.artifactVersionId,
            detail: `Rendered page ${pageNumber} text exceeded the Reviewer preview budget.`
          })
        }

        if (!request.includePreview) continue
        let captured = await guarded(previewWindow.webContents.capturePage(prepared.rect))
        let encoded = captured.toJPEG(80)
        let data = encoded.toString('base64')
        while (returnedBytes + data.length > request.maxBytes) {
          const size = captured.getSize()
          const width = Math.floor(size.width * 0.75)
          const height = Math.floor(size.height * 0.75)
          if (width < 320 || height < 240) break
          captured = captured.resize({ width, height, quality: 'better' })
          encoded = captured.toJPEG(65)
          data = encoded.toString('base64')
        }
        if (returnedBytes + data.length > request.maxBytes) {
          limitations.push({
            kind: 'budget-exhausted',
            subjectId: request.artifactVersionId,
            detail: `Rendered page ${pageNumber} image exceeded the Reviewer preview budget.`
          })
          continue
        }
        media.push({ pageNumber, data, mimeType: 'image/jpeg' })
        returnedBytes += data.length
      }

      return {
        pageCount: initialization.pageCount,
        ...(initialization.pageCountComplete !== undefined
          ? { pageCountComplete: initialization.pageCountComplete }
          : {}),
        pages,
        ...(media.length > 0 ? { media } : {}),
        ...(limitations.length > 0 ? { limitations } : {})
      }
    } finally {
      clearTimeout(timeout)
      if (memoryPoll) clearInterval(memoryPoll)
      request.signal?.removeEventListener('abort', onAbort)
      previewWindow.webContents.removeListener('render-process-gone', onRendererGone)
      destroyWindow()
      if (resource) {
        await dependencies.releaseResource(ownerId, resource.id)
      } else if (acquisition) {
        // Lifecycle failure can win the race while capability acquisition is still in flight.
        // Attach an owner-scoped late release without delaying abort/timeout completion.
        void acquisition
          .then((lateResource) => dependencies.releaseResource(ownerId, lateResource.id))
          .catch(() => undefined)
      }
    }
  }
  let queue: Promise<unknown> = Promise.resolve()
  return (request) => {
    const result = queue.then(() => resolveOne(request))
    queue = result.catch(() => undefined)
    return result
  }
}

export {
  createReviewerPagedContentResolver,
  MAX_REVIEWER_PREVIEW_PAGES,
  MAX_REVIEWER_PREVIEW_SOURCE_BYTES,
  MAX_REVIEWER_DOCX_TARGET_PAGE
}
export type { ReviewerPagedPreviewDependencies, ReviewerPreviewWindow }
