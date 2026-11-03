/// <reference types="electron-vite/node" />
import createWorker from './agent-geometry-worker-entry?nodeWorker'
import type { PdfAnnotationGeometryInput, PdfAnnotationGeometryResult } from './agent-geometry-core'

// Bound native parser memory across concurrent agent calls, including cancelled waiters.
let tail: Promise<void> = Promise.resolve()
export async function locatePdfAnnotationGeometryInWorker(
  input: PdfAnnotationGeometryInput,
  signal: AbortSignal
): Promise<PdfAnnotationGeometryResult> {
  const previous = tail
  let release!: () => void
  tail = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    await previous
    signal.throwIfAborted()
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    const worker = createWorker({
      execArgv: [],
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: 512 }
    })
    return await new Promise<PdfAnnotationGeometryResult>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error, result?: PdfAnnotationGeometryResult): void => {
        if (settled) return
        settled = true
        deadline.removeEventListener('abort', abort)
        // The caller retains its verified content lease until the parser has stopped.
        void worker.terminate().then(() => (error ? reject(error) : resolve(result!)), reject)
      }
      const abort = (): void =>
        finish(new Error('PDF_ANNOTATION_CANCELLED: Target resolution was cancelled or timed out.'))
      worker.once(
        'message',
        (message: { result?: PdfAnnotationGeometryResult; error?: string }) => {
          if (deadline.aborted) return abort()
          if (message.result) finish(undefined, message.result)
          else
            finish(
              new Error(
                message.error ?? 'PDF_ANNOTATION_TARGET_UNAVAILABLE: Target resolution failed.'
              )
            )
        }
      )
      worker.once('error', () =>
        finish(new Error('PDF_ANNOTATION_TARGET_UNAVAILABLE: Target resolution failed.'))
      )
      worker.once('exit', () =>
        finish(new Error('PDF_ANNOTATION_TARGET_UNAVAILABLE: Target worker stopped.'))
      )
      deadline.addEventListener('abort', abort, { once: true })
      if (deadline.aborted) abort()
    })
  } finally {
    void previous.then(release)
  }
}
