import type { PdfExportRequest } from './pdf-export-contract'

type ExportWorker = Pick<
  Worker,
  'postMessage' | 'terminate' | 'addEventListener' | 'removeEventListener'
>
export const runPdfExportWorker = (
  request: PdfExportRequest,
  signal: AbortSignal,
  createWorker: () => ExportWorker = () =>
    new Worker(new URL('./pdf-export-worker.ts', import.meta.url), { type: 'module' })
): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Cancelled', 'AbortError'))
      return
    }
    const worker = createWorker()
    const finish = (error?: Error, data?: ArrayBuffer): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      worker.removeEventListener('message', message)
      worker.removeEventListener('error', failed)
      worker.removeEventListener('messageerror', failed)
      worker.terminate()
      if (error) reject(error)
      else resolve(data!)
    }
    const abort = (): void => finish(new DOMException('Cancelled', 'AbortError'))
    const failed = (): void => finish(new Error('export-failed'))
    const message = (event: Event): void => {
      const result = (event as MessageEvent<{ data?: ArrayBuffer; error?: string }>).data
      if (result?.data instanceof ArrayBuffer) finish(undefined, result.data)
      else finish(new Error(typeof result?.error === 'string' ? result.error : 'export-failed'))
    }
    const timer = setTimeout(() => finish(new Error('timeout')), 90_000)
    signal.addEventListener('abort', abort, { once: true })
    worker.addEventListener('message', message)
    worker.addEventListener('error', failed)
    worker.addEventListener('messageerror', failed)
    try {
      worker.postMessage(request, [request.data])
    } catch {
      failed()
    }
  })

// PDF.js range reads belong to the live reader and cannot be terminated by an export.
// Stop waiting immediately, while the caller's signal checks prevent late reads from writing.
export const waitForPdfExport = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
