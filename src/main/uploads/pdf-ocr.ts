import { pathToFileURL } from 'node:url'
import type { LocalModelOwner, LocalModelUse } from '../local-models/owner'
import { Worker } from 'node:worker_threads'
import type { PDFPageProxy } from 'pdfjs-dist'

export const MAX_PDF_OCR_PAGES = 12
export const PDF_OCR_TIMEOUT_MS = 45_000

export const createPdfOcrSession = (
  models?: Pick<LocalModelOwner, 'acquireUse'>
): {
  recognize(page: PDFPageProxy): Promise<string>
  close(): Promise<void>
} => {
  let worker: Worker | undefined
  let lease: LocalModelUse | undefined
  let acquiring: Promise<LocalModelUse> | undefined
  let attempts = 0
  let closed = false
  let startedAt: number | undefined
  let stop: Promise<unknown> | undefined
  const close = async (): Promise<void> => {
    closed = true
    if (worker) stop ??= worker.terminate()
    await stop
    if (acquiring) {
      try {
        await acquiring
      } catch {
        /* Failed acquisition owns no lease. */
      }
    }
    lease?.release()
    lease = undefined
  }
  return {
    close,
    async recognize(page): Promise<string> {
      if (closed || !models || attempts >= MAX_PDF_OCR_PAGES) return ''
      attempts += 1
      startedAt ??= performance.now()
      const deadline = Math.min(startedAt + 120_000, performance.now() + PDF_OCR_TIMEOUT_MS)
      const withinDeadline = async <T>(
        operation: () => Promise<T>,
        cancel?: () => void
      ): Promise<T> => {
        if (closed || performance.now() >= deadline) throw new Error('PDF OCR deadline exceeded.')
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const pending = operation()
          return await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              const expire = (): void => {
                try {
                  cancel?.()
                } catch {
                  /* Cancellation cannot suppress the deadline. */
                }
                reject(new Error('PDF OCR deadline exceeded.'))
              }
              // Synchronous setup also consumes the deadline. Observe pending even if cancel
              // immediately rejects it, so an expired render cannot leave an unhandled rejection.
              const remaining = deadline - performance.now()
              if (closed || remaining <= 0) expire()
              else timer = setTimeout(expire, remaining)
            })
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      try {
        acquiring ??= models.acquireUse().then((use) => {
          lease = use
          return use
        })
        await withinDeadline(() => acquiring!)
        if (closed) return ''
        const { createCanvas } = await withinDeadline(() => import('@napi-rs/canvas'))
        const base = page.getViewport({ scale: 1 })
        if (
          !Number.isFinite(base.width) ||
          !Number.isFinite(base.height) ||
          base.width <= 0 ||
          base.height <= 0
        )
          throw new Error('PDF OCR page geometry is invalid.')
        const viewport = page.getViewport({
          scale: Math.min(3, 2400 / Math.max(base.width, base.height))
        })
        const canvas = createCanvas(
          Math.max(1, Math.ceil(viewport.width)),
          Math.max(1, Math.ceil(viewport.height))
        )
        let rendering: ReturnType<PDFPageProxy['render']> | undefined
        await withinDeadline(
          () => {
            rendering = page.render({
              canvas: canvas as never,
              canvasContext: canvas.getContext('2d') as never,
              viewport
            })
            return rendering.promise
          },
          () => rendering?.cancel()
        )
        const image = await withinDeadline(() => canvas.encode('png'))
        if (closed || performance.now() >= deadline) throw new Error('PDF OCR deadline exceeded.')
        if (!worker) {
          const entry = lease!.assets.find((asset) => asset.file === 'ocr-worker.mjs')
          if (!entry) throw new Error('OCR component worker is missing.')
          const languages = lease!.languages ?? ['eng', 'chi_sim']
          const languageAssets = Object.fromEntries(
            languages.flatMap((code) => {
              const asset = lease!.assets.find(
                (candidate) => candidate.file === `${code}.traineddata.gz`
              )
              return asset ? [[code, asset.path]] : []
            })
          )
          worker = new Worker(pathToFileURL(entry.path), {
            workerData: { languages, languageAssets }
          })
          // A late worker failure must not become an uncaught backend error between pages.
          worker.on('error', () => {
            closed = true
          })
        }
        const active = worker
        return await withinDeadline(
          () =>
            new Promise<string>((resolve, reject) => {
              const cleanup = (): void => {
                active.off('message', message)
                active.off('error', error)
                active.off('exit', exited)
              }
              const error = (): void => {
                cleanup()
                reject(new Error('PDF OCR failed.'))
              }
              const exited = (): void => error()
              const message = (result: {
                text?: string
                confidence?: number
                error?: boolean
              }): void => {
                cleanup()
                if (result.error) reject(new Error('PDF OCR failed.'))
                else
                  resolve(
                    typeof result.text === 'string' &&
                      Number.isFinite(result.confidence) &&
                      result.confidence! >= 50
                      ? result.text.trim()
                      : ''
                  )
              }
              active.once('message', message)
              active.once('error', error)
              active.once('exit', exited)
              active.postMessage(image)
            })
        )
      } catch (error) {
        await close()
        throw error
      }
    }
  }
}
