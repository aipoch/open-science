import type { OfficeFileExtension } from './office-package'

export type OfficeRenderCleanup = () => void | Promise<void>

type RenderOfficeFileOptions = {
  bytes: Uint8Array
  extension: OfficeFileExtension
  name: string
  container: HTMLDivElement
  signal: AbortSignal
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => Uint8Array.from(bytes).buffer

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

// Keeps rendered hyperlinks visible as document text without allowing preview navigation or pings.
const neutralizeDocxLinks = (container: HTMLElement): void => {
  container.querySelectorAll<HTMLAnchorElement>('a').forEach((link) => {
    for (const attribute of ['href', 'target', 'rel', 'download', 'ping', 'referrerpolicy']) {
      link.removeAttribute(attribute)
    }
  })
}

const SPREADSHEET_WORKER_STARTUP_TIMEOUT_MS = 5_000
const SPREADSHEET_STATUS_STYLE = `
.excel-wrapper .loading {
  background: var(--bg-10);
  backdrop-filter: none;
}
.excel-wrapper .loading-card {
  width: min(19rem, calc(100% - 3rem));
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 20px;
  align-items: center;
  gap: 12px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.excel-wrapper .loading-brand {
  width: 36px;
  height: 36px;
  border: 1px solid color-mix(in srgb, var(--primary) 15%, transparent);
  border-radius: 8px;
  background: var(--bg-000);
  color: var(--primary);
  font-size: 9px;
  font-weight: 600;
}
.excel-wrapper .loading-kicker {
  display: none;
}
.excel-wrapper .loading-copy strong {
  margin-top: 0;
  color: var(--text-000);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
}
.excel-wrapper .loading-copy p {
  margin-top: 2px;
  color: var(--text-300);
  font-size: 10px;
  line-height: 1.4;
}
.excel-wrapper .loading-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--bg-400);
  border-top-color: var(--primary);
  box-shadow: none;
}
.excel-wrapper .sheet-loading {
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
.excel-wrapper .sheet-loading-dot {
  width: 4px;
  height: 4px;
  background: var(--primary);
  box-shadow: none;
}
.excel-wrapper .sheet-loading-summary {
  color: var(--text-300);
}
@media (prefers-reduced-motion: reduce) {
  .excel-wrapper .loading-spinner,
  .excel-wrapper .sheet-loading-dot {
    animation: none;
  }
}
`

// Keeps vendor-owned parsing surfaces aligned with the application's shared preview status UI.
const installSpreadsheetStatusStyle = (container: HTMLElement): HTMLStyleElement => {
  const style = container.ownerDocument.createElement('style')
  style.dataset.openScienceSpreadsheetStatus = 'true'
  style.textContent = SPREADSHEET_STATUS_STYLE
  container.appendChild(style)
  return style
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
  signal
}: RenderOfficeFileOptions): Promise<OfficeRenderCleanup> => {
  if (extension === 'docx') {
    // Keep active-content features disabled and inline media so detached Blob URLs cannot leak.
    const { renderAsync } = await import('docx-preview')

    try {
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
    const MutationObserverCtor = container.ownerDocument.defaultView?.MutationObserver
    if (!MutationObserverCtor) {
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
      resolveFirstPaint()
    }
    errorObserver.observe(container, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    })
    let instance: Awaited<ReturnType<typeof renderFileViewerSpreadsheet>>
    let claimed = false
    let statusStyle: HTMLStyleElement | undefined
    try {
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
      statusStyle = installSpreadsheetStatusStyle(container)
    } catch (error) {
      errorObserver.disconnect()
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
        statusStyle?.remove()
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
  const viewer = new PptxViewer(container, {
    zipLimits: RECOMMENDED_ZIP_LIMITS,
    lazySlides: true,
    lazyMedia: true,
    scrollContainer: container,
    pdfjs: false
  })
  const destroyViewer = (): void => {
    try {
      viewer.destroy()
    } finally {
      clearContainer(container)
    }
  }

  try {
    await viewer.open(toArrayBuffer(bytes), {
      renderMode: 'list',
      listOptions: { windowed: true, initialSlides: 4, batchSize: 4 },
      lazySlides: true,
      lazyMedia: true,
      signal
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
