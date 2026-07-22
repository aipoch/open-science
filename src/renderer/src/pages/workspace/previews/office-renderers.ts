import type { OfficeFileExtension } from './office-package'

export type OfficeRenderCleanup = () => void | Promise<void>
export type OfficeRenderStatus = {
  phase: 'parsing' | 'rendering'
  title: string
  description: string
}

type RenderOfficeFileOptions = {
  bytes: Uint8Array
  extension: OfficeFileExtension
  name: string
  container: HTMLDivElement
  signal: AbortSignal
  onStatus?: (status: OfficeRenderStatus) => void
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer
  }
  return bytes.slice().buffer
}

// Collects renderer-owned Blob URLs from attributes and generated styles for deterministic cleanup.
const collectBlobUrls = (container: HTMLElement): Set<string> => {
  const urls = new Set<string>()
  const elements = [container, ...container.querySelectorAll<HTMLElement>('*')]

  for (const element of elements) {
    for (const attribute of element.getAttributeNames()) {
      for (const match of element.getAttribute(attribute)?.matchAll(/blob:[^)'"\s]+/g) ?? []) {
        urls.add(match[0])
      }
    }
  }
  for (const style of container.querySelectorAll('style')) {
    for (const match of style.textContent?.matchAll(/blob:[^)'"\s]+/g) ?? []) {
      urls.add(match[0])
    }
  }

  return urls
}

const clearContainer = (container: HTMLElement): void => {
  container.replaceChildren()
}

const DOCX_SCALE_PROPERTY = '--open-science-docx-scale'
const DOCX_MIN_SCALE = 0.25
const DOCX_MAX_SCALE = 1
const DOCX_FIT_STYLE = `
.docx-wrapper {
  background: transparent;
  padding: 0;
}
.docx-wrapper > section.docx {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  content-visibility: auto;
  contain-intrinsic-size: auto 1123px;
  zoom: var(${DOCX_SCALE_PROPERTY}, 1);
  transform-origin: top center;
}
`

// Fits the rendered paper width inside the preview viewport without reflowing Word page content.
const applyDocxFit = (container: HTMLElement, wrapper: HTMLElement): void => {
  const view = container.ownerDocument.defaultView
  const pages = wrapper.querySelectorAll<HTMLElement>('section.docx')
  if (!view || pages.length === 0) return

  const wrapperStyle = view.getComputedStyle(wrapper)
  const horizontalPadding =
    Number.parseFloat(wrapperStyle.paddingLeft) + Number.parseFloat(wrapperStyle.paddingRight)
  const availableWidth = container.clientWidth - horizontalPadding
  // Mixed portrait and landscape documents must fit against their widest rendered paper.
  const pageWidth = Math.max(
    ...Array.from(pages, (page) => Number.parseFloat(view.getComputedStyle(page).width))
  )
  if (!Number.isFinite(availableWidth) || availableWidth <= 0 || !Number.isFinite(pageWidth)) return

  const requestedScale = availableWidth / pageWidth
  const scale = Math.min(DOCX_MAX_SCALE, Math.max(DOCX_MIN_SCALE, requestedScale))
  // Center fitted pages, but keep the left edge reachable when minimum zoom still overflows.
  wrapper.style.alignItems = requestedScale < DOCX_MIN_SCALE ? 'flex-start' : 'center'
  wrapper.style.setProperty(DOCX_SCALE_PROPERTY, String(scale))
}

// Installs responsive paper fitting after docx-preview has populated its generated wrapper.
const installDocxFit = (container: HTMLElement, wrapper: HTMLElement): OfficeRenderCleanup => {
  const view = container.ownerDocument.defaultView
  const style = container.ownerDocument.createElement('style')
  style.dataset.openScienceDocxFit = 'true'
  style.textContent = DOCX_FIT_STYLE
  container.appendChild(style)
  wrapper.style.alignItems = 'center'
  applyDocxFit(container, wrapper)

  let animationFrame: number | undefined
  const scheduleFit = (): void => {
    if (!view || animationFrame !== undefined) return
    animationFrame = view.requestAnimationFrame(() => {
      animationFrame = undefined
      applyDocxFit(container, wrapper)
    })
  }
  const ResizeObserverCtor = view?.ResizeObserver
  const resizeObserver = ResizeObserverCtor ? new ResizeObserverCtor(scheduleFit) : undefined
  resizeObserver?.observe(container)

  return () => {
    resizeObserver?.disconnect()
    if (animationFrame !== undefined) view?.cancelAnimationFrame(animationFrame)
    wrapper.style.removeProperty(DOCX_SCALE_PROPERTY)
    wrapper.style.removeProperty('align-items')
    style.remove()
  }
}

type PptxViewerDimensions = {
  slideWidth: number
  slideHeight: number
}

type PptxFitMetrics = {
  scale: number
  displayWidth: number
  displayHeight: number
}

const PPTX_FALLBACK_WIDTH = 960
const MAX_PPTX_MEDIA_URLS = 64

type PptxMediaResolverInternals = {
  media?: Map<string, Uint8Array>
  loadedPaths?: Set<string>
}

// Isolates the only pinned-version private hook and fails closed when the vendor shape changes.
const installPptxMediaUrlCache = (viewer: unknown, cache: Map<string, string>): void => {
  const contract = viewer as { mediaUrlCache?: unknown }
  if (!(contract.mediaUrlCache instanceof Map)) {
    throw new Error('PPTX renderer media cache contract changed')
  }
  contract.mediaUrlCache = cache
}

// Decoded-media eviction needs the lazy resolver's pinned internal stores to remain available.
const requirePptxMediaResolverInternals = (resolver: unknown): PptxMediaResolverInternals => {
  const contract = resolver as PptxMediaResolverInternals | undefined
  if (!(contract?.media instanceof Map) || !(contract.loadedPaths instanceof Set)) {
    throw new Error('PPTX renderer media resolver contract changed')
  }
  return contract
}

// Drops every alias for one decoded media buffer so the lazy resolver can decode it again later.
const releaseDecodedPptxMedia = (
  resolver: PptxMediaResolverInternals | undefined,
  mediaPath: string
): void => {
  const media = resolver?.media
  // EMF rendering stores derived Blob URLs under suffixed keys while decoded bytes use the path.
  const sourceMediaPath = mediaPath.replace(/:emf-(?:pdf|bitmap)$/, '')
  const decoded = media?.get(sourceMediaPath)
  if (!media || !decoded) return

  for (const [path, value] of media) {
    if (value !== decoded) continue
    media.delete(path)
    resolver.loadedPaths?.delete(path)
  }
}

// Uses a soft cap: the active viewport working set may exceed it, but inactive media cannot.
class BoundedBlobUrlCache extends Map<string, string> {
  private onEvict?: (key: string) => void

  setEvictionHandler(handler: (key: string) => void): void {
    this.onEvict = handler
  }

  override get(key: string): string | undefined {
    const value = super.get(key)
    if (value === undefined) return undefined
    super.delete(key)
    super.set(key, value)
    return value
  }

  override set(key: string, value: string): this {
    const previous = super.get(key)
    if (previous && previous !== value) URL.revokeObjectURL(previous)
    super.delete(key)
    super.set(key, value)
    return this
  }

  trim(protectedUrls: ReadonlySet<string> = new Set()): void {
    while (this.size > MAX_PPTX_MEDIA_URLS) {
      const candidate = [...this.entries()].find(([, url]) => !protectedUrls.has(url))
      if (!candidate) break
      const [oldestKey, oldestUrl] = candidate
      super.delete(oldestKey)
      URL.revokeObjectURL(oldestUrl)
      this.onEvict?.(oldestKey)
    }
  }
}

// Reads rendered attributes so shared media stays alive while any mounted slide still references it.
const collectReferencedPptxMediaUrls = (
  container: HTMLElement,
  cache: ReadonlyMap<string, string>
): Set<string> => {
  const cachedUrls = new Set(cache.values())
  const referenced = new Set<string>()
  for (const element of container.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      for (const url of cachedUrls) {
        if (attribute.value.includes(url)) referenced.add(url)
      }
    }
  }
  return referenced
}

const getPptxFitMetrics = (
  container: HTMLElement,
  viewer: PptxViewerDimensions
): PptxFitMetrics | undefined => {
  const availableWidth = container.clientWidth
  const { slideWidth, slideHeight } = viewer
  if (
    !Number.isFinite(availableWidth) ||
    availableWidth <= 0 ||
    !Number.isFinite(slideWidth) ||
    slideWidth <= 0 ||
    !Number.isFinite(slideHeight) ||
    slideHeight <= 0
  ) {
    return undefined
  }

  const scale = availableWidth / slideWidth
  return {
    scale,
    displayWidth: slideWidth * scale,
    displayHeight: slideHeight * scale
  }
}

const applyPptxSlideFit = (slide: HTMLElement, metrics: PptxFitMetrics): void => {
  const wrapper = slide.parentElement
  if (!wrapper) return

  wrapper.style.width = `${metrics.displayWidth}px`
  wrapper.style.height = `${metrics.displayHeight}px`
  slide.style.transform = `scale(${metrics.scale})`
  slide.style.transformOrigin = 'top left'
}

// Updates the vendor-owned slide wrappers without rebuilding parsed presentation content.
const applyPptxFit = (
  container: HTMLElement,
  viewer: PptxViewerDimensions
): PptxFitMetrics | undefined => {
  const metrics = getPptxFitMetrics(container, viewer)
  if (!metrics) return undefined

  for (const item of container.querySelectorAll<HTMLElement>('[data-slide-index]')) {
    const wrapper = item.firstElementChild
    if (!(wrapper instanceof HTMLElement)) continue

    wrapper.style.width = `${metrics.displayWidth}px`
    wrapper.style.height = `${metrics.displayHeight}px`
    const slide = wrapper.firstElementChild
    if (slide instanceof HTMLElement) applyPptxSlideFit(slide, metrics)
  }

  return metrics
}

// Coalesces panel drag updates to one in-place fit per animation frame.
const installPptxFit = (
  container: HTMLElement,
  viewer: PptxViewerDimensions,
  onFit: (metrics: PptxFitMetrics) => void
): OfficeRenderCleanup => {
  const view = container.ownerDocument.defaultView
  const applyFit = (): void => {
    const metrics = applyPptxFit(container, viewer)
    if (metrics) onFit(metrics)
  }
  applyFit()

  let animationFrame: number | undefined
  const scheduleFit = (): void => {
    if (!view || animationFrame !== undefined) return
    animationFrame = view.requestAnimationFrame(() => {
      animationFrame = undefined
      applyFit()
    })
  }
  const ResizeObserverCtor = view?.ResizeObserver
  const resizeObserver = ResizeObserverCtor ? new ResizeObserverCtor(scheduleFit) : undefined
  resizeObserver?.observe(container)

  return () => {
    resizeObserver?.disconnect()
    if (animationFrame !== undefined) view?.cancelAnimationFrame(animationFrame)
  }
}

// Keeps rendered hyperlinks visible as document text without allowing preview navigation or pings.
const neutralizeDocxLinks = (container: HTMLElement): void => {
  container.querySelectorAll<HTMLAnchorElement>('a').forEach((link) => {
    for (const attribute of ['href', 'target', 'rel', 'download', 'ping', 'referrerpolicy']) {
      link.removeAttribute(attribute)
    }
  })
}

const SPREADSHEET_WORKER_STARTUP_TIMEOUT_MS = 5_000
const SPREADSHEET_STATUS_SCOPE_ATTRIBUTE = 'data-open-science-spreadsheet-preview'
const SPREADSHEET_STATUS_SCOPE = `[${SPREADSHEET_STATUS_SCOPE_ATTRIBUTE}]`
const SPREADSHEET_PARSING_STATUS: OfficeRenderStatus = {
  phase: 'parsing',
  title: 'Parsing the Excel workbook',
  description: 'Preparing worksheets, styles, and virtualized viewport data.'
}
const RENDERING_STATUS: OfficeRenderStatus = {
  phase: 'rendering',
  title: 'Rendering the preview',
  description: 'Building the document view.'
}
const SPREADSHEET_STATUS_STYLE = `
${SPREADSHEET_STATUS_SCOPE} .excel-wrapper .loading {
  display: none !important;
}
${SPREADSHEET_STATUS_SCOPE} .excel-wrapper .sheet-loading {
  right: 12px;
  bottom: 12px;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-000);
  box-shadow: none;
  color: var(--text-100);
  font-size: 10px;
  font-weight: 500;
}
${SPREADSHEET_STATUS_SCOPE} .excel-wrapper .sheet-loading-dot {
  width: 4px;
  height: 4px;
  background: var(--primary);
  box-shadow: none;
}
${SPREADSHEET_STATUS_SCOPE} .excel-wrapper .sheet-loading-summary {
  color: var(--text-300);
}
@media (prefers-reduced-motion: reduce) {
  ${SPREADSHEET_STATUS_SCOPE} .excel-wrapper .sheet-loading-dot {
    animation: none;
  }
}
`

// Hides the vendor's blocking loader before it is inserted while retaining background progress.
const installSpreadsheetStatusStyle = (container: HTMLElement): OfficeRenderCleanup => {
  const style = container.ownerDocument.createElement('style')
  style.dataset.openScienceSpreadsheetStatus = 'true'
  style.textContent = SPREADSHEET_STATUS_STYLE
  container.setAttribute(SPREADSHEET_STATUS_SCOPE_ATTRIBUTE, 'true')
  container.ownerDocument.head.appendChild(style)

  return () => {
    style.remove()
    container.removeAttribute(SPREADSHEET_STATUS_SCOPE_ATTRIBUTE)
  }
}

// Canonicalizes Vite's relative worker asset so the vendor resolver and handshake compare one URL.
const resolveSpreadsheetWorkerUrl = (workerUrl: string, container: HTMLElement): string =>
  new URL(workerUrl, container.ownerDocument.baseURI).href

// Handshakes the local spreadsheet Worker before vendor code takes ownership, preventing a silent
// fallback to expensive workbook parsing on the renderer thread.
const createReadySpreadsheetWorker = async (
  workerUrl: string,
  container: HTMLElement,
  signal: AbortSignal
): Promise<Worker> => {
  const WorkerCtor = container.ownerDocument.defaultView?.Worker
  if (!WorkerCtor) throw new Error('Spreadsheet preview Worker is unavailable')

  let worker: Worker
  try {
    worker = new WorkerCtor(workerUrl, { type: 'module' })
  } catch (error) {
    throw new Error('Spreadsheet preview Worker could not start', { cause: error })
  }

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = (): void => {
        window.clearTimeout(timeout)
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
        signal.removeEventListener('abort', onAbort)
      }
      const settle = (callback: () => void): void => {
        if (settled) return
        settled = true
        cleanup()
        callback()
      }
      const onMessage = (): void => settle(resolve)
      const onError = (): void =>
        settle(() => reject(new Error('Spreadsheet preview Worker could not load')))
      const onAbort = (): void =>
        settle(() =>
          reject(signal.reason ?? new DOMException('Spreadsheet preview aborted', 'AbortError'))
        )
      const timeout = window.setTimeout(() => {
        settle(() => reject(new Error('Spreadsheet preview Worker did not respond')))
      }, SPREADSHEET_WORKER_STARTUP_TIMEOUT_MS)

      worker.addEventListener('message', onMessage, { once: true })
      worker.addEventListener('error', onError, { once: true })
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        worker.postMessage({ type: 'parseWorkbook', payload: { workbook: new ArrayBuffer(0) } })
      } catch (error) {
        settle(() => reject(error))
      }
      if (signal.aborted) onAbort()
    })
    return worker
  } catch (error) {
    worker.terminate()
    throw error
  }
}

// Transfers the renderer-owned workbook copy into the parsing Worker instead of cloning it again.
const installTransferableSpreadsheetWorkbook = (worker: Worker): OfficeRenderCleanup => {
  const ownDescriptor = Object.getOwnPropertyDescriptor(worker, 'postMessage')
  const originalPostMessage = worker.postMessage.bind(worker) as (
    message: unknown,
    transferOrOptions?: Transferable[] | StructuredSerializeOptions
  ) => void
  const patchedPostMessage = (
    message: unknown,
    transferOrOptions?: Transferable[] | StructuredSerializeOptions
  ): void => {
    const payload =
      typeof message === 'object' && message !== null && 'payload' in message
        ? message.payload
        : undefined
    const workbook =
      typeof payload === 'object' && payload !== null && 'workbook' in payload
        ? payload.workbook
        : undefined
    const isWorkbookParse =
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'parseWorkbook' &&
      workbook instanceof ArrayBuffer

    if (isWorkbookParse && transferOrOptions === undefined) {
      originalPostMessage(message, [workbook])
      return
    }
    originalPostMessage(message, transferOrOptions)
  }
  worker.postMessage = patchedPostMessage as Worker['postMessage']

  return () => {
    if (ownDescriptor) Object.defineProperty(worker, 'postMessage', ownDescriptor)
    else Reflect.deleteProperty(worker, 'postMessage')
  }
}

// Supplies the already-handshaken Worker to a vendor API that otherwise constructs its own Worker.
const renderWithReadySpreadsheetWorker = async <T>(
  workerUrl: string,
  container: HTMLElement,
  worker: Worker,
  render: () => Promise<T>
): Promise<{ instance: T; claimed: boolean }> => {
  const view = container.ownerDocument.defaultView
  const NativeWorker = view?.Worker
  if (!view || !NativeWorker) throw new Error('Spreadsheet preview Worker is unavailable')

  let claimed = false
  const InjectedWorker = function (scriptUrl: string | URL, options?: WorkerOptions): Worker {
    if (String(scriptUrl) === workerUrl) {
      if (claimed) throw new Error('Spreadsheet preview requested more than one Worker')
      claimed = true
      return worker
    }

    return new NativeWorker(scriptUrl, options)
  } as unknown as typeof Worker
  InjectedWorker.prototype = NativeWorker.prototype

  const ownDescriptor = Object.getOwnPropertyDescriptor(view, 'Worker')
  // The vendor reads window.Worker during its async factory. Keep the override bounded by this
  // try/finally; callers must not run spreadsheet factories concurrently in the same window.
  Object.defineProperty(view, 'Worker', {
    configurable: true,
    writable: true,
    value: InjectedWorker
  })

  try {
    return { instance: await render(), claimed }
  } finally {
    if (ownDescriptor) Object.defineProperty(view, 'Worker', ownDescriptor)
    else Reflect.deleteProperty(view, 'Worker')
  }
}

// Converts the spreadsheet renderer's DOM-only parse error state into the adapter's promise flow.
const getSpreadsheetParseError = (container: HTMLElement): Error | undefined => {
  const errorElement = container.querySelector<HTMLElement>('.excel-wrapper .error')
  if (!errorElement || errorElement.classList.contains('hidden')) return undefined

  const message = errorElement.textContent?.trim()
  return new Error(message || 'Spreadsheet preview could not parse this workbook')
}

// Dynamically loads the selected renderer and returns one cleanup function that owns all generated
// DOM, workers, Blob URLs, and vendor instances for that preview generation.
export const renderOfficeFile = async ({
  bytes,
  extension,
  name,
  container,
  signal,
  onStatus
}: RenderOfficeFileOptions): Promise<OfficeRenderCleanup> => {
  if (extension === 'docx') {
    // Keep active-content features disabled and inline media so detached Blob URLs cannot leak.
    const { renderAsync } = await import('docx-preview')

    try {
      onStatus?.(RENDERING_STATUS)
      await renderAsync(bytes, container, container, {
        breakPages: true,
        ignoreLastRenderedPageBreak: false,
        renderAltChunks: false,
        renderComments: false,
        useBase64URL: true
      })
    } catch (error) {
      collectBlobUrls(container).forEach((url) => URL.revokeObjectURL(url))
      clearContainer(container)
      throw error
    }
    neutralizeDocxLinks(container)
    const wrapper = container.querySelector<HTMLElement>('.docx-wrapper')
    const disposeFit = wrapper ? installDocxFit(container, wrapper) : undefined
    const blobUrls = collectBlobUrls(container)

    return () => {
      disposeFit?.()
      blobUrls.forEach((url) => URL.revokeObjectURL(url))
      clearContainer(container)
    }
  }

  if (extension === 'xls' || extension === 'xlsx') {
    // Spreadsheet parsing stays in the bundled Worker; readiness means a real first paint occurred.
    const [{ renderFileViewerSpreadsheet }, { default: importedWorkerUrl }] = await Promise.all([
      import('@file-viewer/renderer-spreadsheet'),
      import('@file-viewer/renderer-spreadsheet/worker/sheetjs/sheet.worker?worker&url')
    ])
    const workerUrl = resolveSpreadsheetWorkerUrl(importedWorkerUrl, container)
    const readyWorker = await createReadySpreadsheetWorker(workerUrl, container, signal)
    const disposeTransferableWorkbook = installTransferableSpreadsheetWorkbook(readyWorker)
    const MutationObserverCtor = container.ownerDocument.defaultView?.MutationObserver
    if (!MutationObserverCtor) {
      disposeTransferableWorkbook()
      readyWorker.terminate()
      throw new Error('Spreadsheet preview error observer is unavailable')
    }

    let firstPaintSettled = false
    let resolveFirstPaint: () => void = () => undefined
    let rejectFirstPaint: (error: Error) => void = () => undefined
    const firstPaint = new Promise<void>((resolve, reject) => {
      resolveFirstPaint = resolve
      rejectFirstPaint = reject
    })
    // The renderer factory may still be pending when a DOM parse error rejects this promise.
    void firstPaint.catch(() => undefined)
    // Upstream does not call onProgressiveRender for parse errors, so observe its error node early.
    const errorObserver = new MutationObserverCtor(() => {
      const error = getSpreadsheetParseError(container)
      if (!error || firstPaintSettled) return

      firstPaintSettled = true
      errorObserver.disconnect()
      rejectFirstPaint(error)
    })
    const markFirstPaint = (): void => {
      if (firstPaintSettled) return
      firstPaintSettled = true
      errorObserver.disconnect()
      onStatus?.(RENDERING_STATUS)
      resolveFirstPaint()
    }
    errorObserver.observe(container, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    })
    const disposeStatusStyle = installSpreadsheetStatusStyle(container)
    let instance: Awaited<ReturnType<typeof renderFileViewerSpreadsheet>>
    let claimed = false
    try {
      onStatus?.(SPREADSHEET_PARSING_STATUS)
      const rendered = await renderWithReadySpreadsheetWorker(
        workerUrl,
        container,
        readyWorker,
        () =>
          renderFileViewerSpreadsheet(toArrayBuffer(bytes), container, extension, {
            filename: name,
            signal,
            onProgressiveRender: markFirstPaint,
            options: {
              locale: 'en-US',
              spreadsheet: {
                worker: true,
                workerUrl
              }
            }
          })
      )
      instance = rendered.instance
      claimed = rendered.claimed
    } catch (error) {
      errorObserver.disconnect()
      disposeStatusStyle()
      disposeTransferableWorkbook()
      readyWorker.terminate()
      clearContainer(container)
      throw error
    }

    let disposed = false
    // Cleanup is idempotent because timeout, abort, file replacement, and unmount can race.
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      try {
        if ('unmount' in instance) await instance.unmount()
        else if ('$destroy' in instance) await instance.$destroy()
        else await instance.destroy()
      } finally {
        disposeStatusStyle()
        disposeTransferableWorkbook()
        readyWorker.terminate()
        clearContainer(container)
      }
    }

    if (!claimed) {
      errorObserver.disconnect()
      await dispose()
      throw new Error('Spreadsheet renderer did not claim the required Worker')
    }

    const reportedError = getSpreadsheetParseError(container)
    if (reportedError && !firstPaintSettled) {
      firstPaintSettled = true
      errorObserver.disconnect()
      rejectFirstPaint(reportedError)
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const rejectAfterDispose = (error: unknown): void => {
        if (settled) return
        settled = true
        errorObserver.disconnect()
        signal.removeEventListener('abort', onAbort)
        void dispose().then(
          () => reject(error),
          (cleanupError) => {
            console.error('Failed to dispose spreadsheet preview', cleanupError)
            reject(error)
          }
        )
      }
      const onAbort = (): void =>
        rejectAfterDispose(
          signal.reason ?? new DOMException('Spreadsheet preview aborted', 'AbortError')
        )

      signal.addEventListener('abort', onAbort, { once: true })
      firstPaint.then(() => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, rejectAfterDispose)
      if (signal.aborted) onAbort()
    })

    return dispose
  }

  // Construct explicitly so a failed open still leaves an instance that can be destroyed.
  const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import('@aiden0z/pptx-renderer')
  const viewerDimensionsRef: { current?: PptxViewerDimensions } = {}
  const mediaUrlCache = new BoundedBlobUrlCache()
  let currentFit: PptxFitMetrics | undefined
  let reportedRendering = false
  const reportRendering = (): void => {
    if (reportedRendering) return
    reportedRendering = true
    onStatus?.(RENDERING_STATUS)
  }
  const viewer = new PptxViewer(container, {
    // A fixed width disables the vendor's resize path, which clears and rebuilds every slide.
    width: container.clientWidth || PPTX_FALLBACK_WIDTH,
    zipLimits: RECOMMENDED_ZIP_LIMITS,
    lazySlides: true,
    lazyMedia: true,
    scrollContainer: container,
    pdfjs: false,
    onRenderStart: reportRendering,
    onSlideUnmounted: () =>
      mediaUrlCache.trim(collectReferencedPptxMediaUrls(container, mediaUrlCache)),
    // Windowed slides can mount after a resize, so apply the latest fit before their next paint.
    onSlideRendered: (_index, element) => {
      const viewerDimensions = viewerDimensionsRef.current
      const metrics = viewerDimensions ? getPptxFitMetrics(container, viewerDimensions) : currentFit
      if (!metrics) return

      currentFit = metrics
      applyPptxSlideFit(element, metrics)
    }
  })
  viewerDimensionsRef.current = viewer
  let disposeFit: OfficeRenderCleanup | undefined
  const destroyViewer = (): void => {
    disposeFit?.()
    disposeFit = undefined
    try {
      viewer.destroy()
    } finally {
      clearContainer(container)
    }
  }

  try {
    installPptxMediaUrlCache(viewer, mediaUrlCache)
    await viewer.open(toArrayBuffer(bytes), {
      renderMode: 'list',
      listOptions: { windowed: true, initialSlides: 4, batchSize: 4 },
      lazySlides: true,
      lazyMedia: true,
      signal
    })
    reportRendering()
    const resolver = requirePptxMediaResolverInternals(viewer.presentationData?.mediaResolver)
    mediaUrlCache.setEvictionHandler((mediaPath) => releaseDecodedPptxMedia(resolver, mediaPath))
    disposeFit = installPptxFit(container, viewer, (metrics) => {
      currentFit = metrics
    })
  } catch (error) {
    try {
      destroyViewer()
    } catch (cleanupError) {
      console.error('Failed to dispose PPTX preview', cleanupError)
    }
    throw error
  }

  return destroyViewer
}

export {
  BoundedBlobUrlCache,
  collectReferencedPptxMediaUrls,
  installPptxMediaUrlCache,
  MAX_PPTX_MEDIA_URLS,
  releaseDecodedPptxMedia
}
