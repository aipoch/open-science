import type { Worker, WorkerOptions } from 'node:worker_threads'

import createNativePdfAnnotationWorker from './native-import-worker-entry?nodeWorker'
import {
  MAX_IMPORTED_NATIVE_ANNOTATIONS,
  NATIVE_EXTRACTOR_VERSION,
  parseNativePdfAnnotationsOnCurrentThread
} from './native-import-core'
import type {
  NativePdfAnnotationImportResult,
  NativePdfAnnotationParseOptions,
  NativePdfAnnotationProgress,
  PdfNativeAnnotationDraft
} from './native-import-core'

type NativePdfAnnotationImportOptions = NativePdfAnnotationParseOptions &
  Readonly<{
    execution?: 'worker' | 'current-thread'
    createWorker?: (options: WorkerOptions) => Worker
  }>

const parseError = (message: string, name?: string): Error => {
  const error = new Error(message)
  if (name) error.name = name
  return error
}

const parseWithWorker = async (
  filePath: string,
  options: NativePdfAnnotationImportOptions
): Promise<NativePdfAnnotationImportResult> => {
  options.signal?.throwIfAborted()
  const createWorker = options.createWorker ?? createNativePdfAnnotationWorker
  const worker = createWorker({
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 64 },
    workerData: { filePath }
  })
  return new Promise<NativePdfAnnotationImportResult>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      options.signal?.removeEventListener('abort', abort)
      worker.off('message', message)
      worker.off('error', error)
      worker.off('exit', exit)
    }
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      // Join the worker before releasing the caller's immutable content lease.
      void worker.terminate().then(
        () => {
          cleanup()
          callback()
        },
        (error) => {
          cleanup()
          reject(error)
        }
      )
    }
    const abort = (): void => {
      finish(() => {
        reject(options.signal?.reason ?? new DOMException('PDF import cancelled.', 'AbortError'))
      })
    }
    const message = (value: unknown): void => {
      if (settled) return
      if (!value || typeof value !== 'object' || !('kind' in value)) return
      const event = value as {
        kind: string
        progress?: NativePdfAnnotationProgress
        result?: NativePdfAnnotationImportResult
        name?: string
        message?: string
      }
      if (event.kind === 'progress' && event.progress) {
        options.onProgress?.(event.progress)
      } else if (event.kind === 'result' && event.result) {
        finish(() => resolve(event.result!))
      } else if (event.kind === 'error') {
        finish(() =>
          reject(parseError(event.message ?? 'Native PDF annotation import failed.', event.name))
        )
      }
    }
    const error = (value: Error): void => finish(() => reject(value))
    const exit = (): void => {
      finish(() =>
        reject(new Error('Native PDF annotation worker stopped before returning a result.'))
      )
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    worker.on('message', message)
    worker.once('error', error)
    worker.once('exit', exit)
    if (options.signal?.aborted) abort()
  })
}

// One shared lane for both Literature and ordinary uploads. Each worker may use up to 1 GB;
// allowing one per uploaded file makes a batch an unbounded memory spike.
let workerQueue: Promise<void> = Promise.resolve()
const parseNativePdfAnnotations = async (
  filePath: string,
  options: NativePdfAnnotationImportOptions = {}
): Promise<NativePdfAnnotationImportResult> => {
  // Page count and annotation complexity do not correlate reliably with file size: a 1000-page
  // text PDF can be only a few MB. Keep all production parsing off the Electron main thread.
  if (options.execution === 'current-thread')
    return parseNativePdfAnnotationsOnCurrentThread(filePath, options)
  options.signal?.throwIfAborted()
  const previous = workerQueue
  let release!: () => void
  workerQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => reject(options.signal!.reason)
      options.signal?.addEventListener('abort', abort, { once: true })
      void previous.then(() => {
        options.signal?.removeEventListener('abort', abort)
        resolve()
      })
      if (options.signal?.aborted) abort()
    })
    options.signal?.throwIfAborted()
    return await parseWithWorker(filePath, options)
  } finally {
    // A cancelled waiter must not let its successors overtake the active worker.
    void previous.then(release)
  }
}

export { MAX_IMPORTED_NATIVE_ANNOTATIONS, NATIVE_EXTRACTOR_VERSION, parseNativePdfAnnotations }
export type {
  NativePdfAnnotationImportOptions,
  NativePdfAnnotationImportResult,
  NativePdfAnnotationProgress,
  PdfNativeAnnotationDraft
}

export { nativeImportReceipt } from './native-import-core'
