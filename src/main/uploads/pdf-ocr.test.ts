import type { PDFPageProxy } from 'pdfjs-dist'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPdfOcrSession as createSession, PDF_OCR_TIMEOUT_MS } from './pdf-ocr'

const state = vi.hoisted(() => ({
  worker: undefined as undefined | { emit(event: string, value?: unknown): boolean },
  reply: { text: 'recognized evidence', confidence: 90 } as {
    text?: string
    confidence?: number
    error?: boolean
  },
  hanging: false,
  encodeDelay: 0,
  activeEncodings: 0,
  canvasSizes: [] as number[][],
  terminate: vi.fn(async () => 0),
  postMessage: vi.fn()
}))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    Worker: class extends EventEmitter {
      constructor() {
        super()
        state.worker = this
      }
      terminate = state.terminate
      postMessage(image: unknown): void {
        state.postMessage(image)
        if (!state.hanging) queueMicrotask(() => this.emit('message', state.reply))
      }
    }
  }
})
vi.mock('@napi-rs/canvas', () => ({
  createCanvas: (width: number, height: number) => {
    state.canvasSizes.push([width, height])
    return {
      getContext: () => ({}),
      encode: () => {
        state.activeEncodings += 1
        return new Promise<Buffer>((resolve) => {
          const finish = (): void => {
            state.activeEncodings -= 1
            resolve(Buffer.from('png'))
          }
          if (state.encodeDelay) setTimeout(finish, state.encodeDelay)
          else finish()
        })
      }
    }
  }
}))
const release = vi.fn()
const createPdfOcrSession = (): ReturnType<typeof createSession> =>
  createSession({
    acquireUse: async () => ({
      revision: 'test',
      assets: [{ file: 'ocr-worker.mjs', path: '/test/ocr-worker.mjs', size: 1, sha256: 'test' }],
      release
    })
  })

const page = (): PDFPageProxy =>
  ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() })
  }) as unknown as PDFPageProxy

beforeEach(() => {
  state.worker = undefined
  state.reply = { text: 'recognized evidence', confidence: 90 }
  state.hanging = false
  state.encodeDelay = 0
  state.activeEncodings = 0
  state.canvasSizes = []
  vi.clearAllMocks()
})
afterEach(() => {
  vi.useRealTimers()
})

it('reuses its owned worker and terminates it exactly once', async () => {
  const session = createPdfOcrSession()
  expect(await session.recognize(page())).toBe('recognized evidence')
  expect(await session.recognize(page())).toBe('recognized evidence')
  await session.close()
  await session.close()
  expect(state.postMessage).toHaveBeenCalledTimes(2)
  expect(state.terminate).toHaveBeenCalledOnce()
  expect(await session.recognize(page())).toBe('')
})
it('does not turn low-confidence text into readable evidence', async () => {
  const session = createPdfOcrSession()
  state.reply = { text: 'invented text', confidence: 20 }
  expect(await session.recognize(page())).toBe('')
  await session.close()
})
it('terminates a failed worker before reporting the failure', async () => {
  const session = createPdfOcrSession()
  state.reply = { error: true }
  await expect(session.recognize(page())).rejects.toThrow('PDF OCR failed')
  expect(state.terminate).toHaveBeenCalledOnce()
  expect(await session.recognize(page())).toBe('')
})
it('times out a hung worker and joins termination', async () => {
  vi.useFakeTimers()
  const session = createPdfOcrSession()
  state.hanging = true
  const pending = session.recognize(page())
  const failure = expect(pending).rejects.toThrow('deadline exceeded')
  await vi.advanceTimersByTimeAsync(PDF_OCR_TIMEOUT_MS + 1)
  await failure
  expect(state.terminate).toHaveBeenCalledOnce()
})
it('bounds automatic OCR pages without spawning extra work', async () => {
  const session = createPdfOcrSession()
  for (let i = 0; i < 12; i++) await session.recognize(page())
  expect(await session.recognize(page())).toBe('')
  expect(state.postMessage).toHaveBeenCalledTimes(12)
  await session.close()
})

it('caps rendered pixels for oversized page geometry', async () => {
  const session = createPdfOcrSession()
  const oversized = page()
  vi.spyOn(oversized, 'getViewport').mockImplementation(
    (options) =>
      ({ width: 60_000 * (options?.scale ?? 1), height: 80_000 * (options?.scale ?? 1) }) as never
  )
  try {
    await session.recognize(oversized)
    expect(state.canvasSizes).toEqual([[1800, 2400]])
  } finally {
    await session.close()
  }
})

it('shares the 120-second admission budget across pages', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
  const session = createPdfOcrSession()
  const slow = (): PDFPageProxy => {
    const value = page()
    vi.spyOn(value, 'render').mockReturnValue({
      promise: new Promise<void>((resolve) => setTimeout(resolve, 41_000)),
      cancel: vi.fn()
    } as never)
    return value
  }
  try {
    for (let index = 0; index < 2; index++) {
      const recognized = session.recognize(slow())
      await vi.advanceTimersByTimeAsync(41_000)
      expect(await recognized).toBe('recognized evidence')
    }
    let settled = false
    const third = session
      .recognize(slow())
      .catch(() => '')
      .finally(() => {
        settled = true
      })
    await vi.advanceTimersByTimeAsync(38_001)
    try {
      expect(settled, 'a new page must not reset the session budget').toBe(true)
    } finally {
      await vi.advanceTimersByTimeAsync(3_000)
      await third
    }
  } finally {
    await session.close()
  }
})

it('uses one deadline across rendering and recognition', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
  state.hanging = true
  const session = createPdfOcrSession()
  const delayed = page()
  vi.spyOn(delayed, 'render').mockReturnValue({
    promise: new Promise<void>((resolve) => setTimeout(resolve, 40_000)),
    cancel: vi.fn()
  } as never)
  const pending = session.recognize(delayed).catch(() => '')
  try {
    await vi.advanceTimersByTimeAsync(PDF_OCR_TIMEOUT_MS + 1)
    expect(
      state.terminate,
      'the 45-second budget must not restart after rendering'
    ).toHaveBeenCalledOnce()
    await pending
  } finally {
    await session.close()
  }
})

it('bounds a stalled PNG encoding within the page deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
  state.encodeDelay = 60_000
  const session = createPdfOcrSession()
  let settled = false
  const pending = session
    .recognize(page())
    .catch(() => '')
    .finally(() => {
      settled = true
    })
  try {
    await vi.advanceTimersByTimeAsync(PDF_OCR_TIMEOUT_MS + 1)
    expect(settled, 'encoding must not hold the extraction slot past the deadline').toBe(true)
    await pending
    // The native API exposes no cancellation: waiting is bounded, physical work is not joined.
    expect(state.activeEncodings).toBe(1)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(state.activeEncodings).toBe(0)
  } finally {
    await session.close()
  }
})

it('cancels an overdue PDF render before admitting recognition', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
  const session = createPdfOcrSession()
  const delayed = page()
  const cancel = vi.fn()
  vi.spyOn(delayed, 'render').mockReturnValue({
    promise: new Promise<void>(() => {}),
    cancel
  } as never)
  const failure = expect(session.recognize(delayed)).rejects.toThrow('deadline exceeded')
  try {
    await vi.advanceTimersByTimeAsync(PDF_OCR_TIMEOUT_MS + 1)
    await failure
    expect(cancel, 'timing out the caller must also cancel the PDF render').toHaveBeenCalledOnce()
    expect(state.activeEncodings).toBe(0)
    expect(state.postMessage).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})

it('cancels a render that exhausts the deadline during synchronous setup', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
  const session = createPdfOcrSession()
  const delayed = page()
  let rejectRender!: (error: Error) => void
  const promise = new Promise<void>((_, reject) => {
    rejectRender = reject
  })
  const cancel = vi.fn(() => rejectRender(new Error('Rendering cancelled')))
  vi.spyOn(delayed, 'render').mockImplementation(() => {
    vi.advanceTimersByTime(PDF_OCR_TIMEOUT_MS + 1)
    return { promise, cancel } as never
  })
  try {
    await expect(session.recognize(delayed)).rejects.toThrow()
    expect(
      cancel,
      'an already-expired wait must still cancel the started render'
    ).toHaveBeenCalledOnce()
    expect(state.postMessage).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})

it('close joins worker termination before releasing ownership', async () => {
  const session = createPdfOcrSession()
  await session.recognize(page())
  let finish!: () => void
  state.terminate.mockImplementationOnce(
    () =>
      new Promise<number>((resolve) => {
        finish = () => resolve(0)
      })
  )
  let released = false
  const closing = session.close().then(() => {
    released = true
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(released, 'ownership must be retained until termination is confirmed').toBe(false)
  finish()
  await closing
  expect(released).toBe(true)
  expect(release).toHaveBeenCalledOnce()
})

it('does not render or spawn when the optional component is absent', async () => {
  const session = createSession()
  expect(await session.recognize(page())).toBe('')
  expect(state.canvasSizes).toEqual([])
  expect(state.postMessage).not.toHaveBeenCalled()
  await session.close()
})
