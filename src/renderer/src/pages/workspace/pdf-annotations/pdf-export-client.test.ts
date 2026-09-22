import { expect, it, vi } from 'vitest'
import { runPdfExportWorker, waitForPdfExport } from './pdf-export-client'
import type { PdfExportRequest } from './pdf-export-contract'

const setup = (): {
  worker: EventTarget & {
    postMessage: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>
    terminate: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>
  }
  request: PdfExportRequest
} => ({
  worker: Object.assign(new EventTarget(), { postMessage: vi.fn(), terminate: vi.fn() }),
  request: { data: new ArrayBuffer(3), checksum: '', marks: [] }
})
it('transfers the input once and terminates the worker after its result', async () => {
  const { worker, request } = setup()
  const result = runPdfExportWorker(request, new AbortController().signal, () => worker)
  expect(worker.postMessage).toHaveBeenCalledWith(request, [request.data])
  const data = new ArrayBuffer(10)
  worker.dispatchEvent(new MessageEvent('message', { data: { data } }))
  await expect(result).resolves.toBe(data)
  expect(worker.terminate).toHaveBeenCalledTimes(1)
})
it('terminates on cancellation, malformed replies, worker errors and timeout without leaking listeners', async () => {
  vi.useFakeTimers()
  try {
    for (const reason of ['cancel', 'malformed', 'error', 'timeout']) {
      const { worker, request } = setup(),
        controller = new AbortController()
      const result = runPdfExportWorker(request, controller.signal, () => worker)
      const rejection = expect(result).rejects.toBeInstanceOf(Error)
      if (reason === 'cancel') controller.abort()
      if (reason === 'malformed') worker.dispatchEvent(new MessageEvent('message', { data: null }))
      if (reason === 'error') worker.dispatchEvent(new Event('error'))
      if (reason === 'timeout') vi.advanceTimersByTime(90_000)
      await rejection
      controller.abort()
      worker.dispatchEvent(new Event('error'))
      expect(worker.terminate).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  } finally {
    vi.useRealTimers()
  }
})

it('stops waiting for PDF.js reads immediately and consumes late rejections', async () => {
  const controller = new AbortController()
  let rejectRead!: (error: Error) => void
  const read = new Promise<void>((_, reject) => {
    rejectRead = reject
  })
  const waiting = waitForPdfExport(read, controller.signal)
  const rejected = expect(waiting).rejects.toThrow('timeout')
  controller.abort(new Error('timeout'))
  await rejected
  rejectRead(new Error('late range failure'))
  await Promise.resolve()
  await expect(
    waitForPdfExport(Promise.reject(new Error('late')), controller.signal)
  ).rejects.toThrow('timeout')
})
