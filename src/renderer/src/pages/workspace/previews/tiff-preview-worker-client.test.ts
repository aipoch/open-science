import { afterEach, describe, expect, it, vi } from 'vitest'

import { decodeTiffFixture, LZW_RGB_TIFF } from './tiff-test-fixtures'
import { createTiffDecodeSession } from './tiff-preview-worker-client'

describe('TIFF decode worker session', () => {
  afterEach(() => vi.useRealTimers())

  it('terminates a decoder that does not respond before the deadline', async () => {
    const worker = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
      terminate: vi.fn()
    }
    const session = createTiffDecodeSession(decodeTiffFixture(LZW_RGB_TIFF), {
      timeoutMs: 1,
      createWorker: () => worker
    })

    await expect(session.decodePage(0)).rejects.toThrow('TIFF decoding timed out')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('terminates the worker when an in-flight decode is aborted', async () => {
    vi.useFakeTimers()
    const worker = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
      terminate: vi.fn()
    }
    const session = createTiffDecodeSession(decodeTiffFixture(LZW_RGB_TIFF), {
      timeoutMs: 100,
      createWorker: () => worker
    })
    const firstController = new AbortController()
    const firstDecode = session.decodePage(0, firstController.signal)
    firstController.abort()
    await expect(firstDecode).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminate).toHaveBeenCalledOnce()
    await expect(session.decodePage(1)).rejects.toThrow('TIFF decoder is unavailable')

    await vi.advanceTimersByTimeAsync(200)
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
})

it('transports a real Worker page error and decodes the next page in the same session', async () => {
  const { createUnsupportedFirstPageTiff } = await import('./tiff-test-fixtures')
  type Request = import('./tiff-preview-worker-protocol').TiffDecodeWorkerRequest
  type Response = import('./tiff-preview-worker-protocol').TiffDecodeWorkerResponse
  let handleRequest: (event: MessageEvent<Request>) => void
  const listeners = new Set<EventListener>()
  vi.stubGlobal('self', {
    addEventListener: (_type: string, listener: typeof handleRequest) => {
      handleRequest = listener
    },
    postMessage: (response: Response) => {
      for (const listener of listeners) listener({ data: response } as MessageEvent<Response>)
    }
  })
  await import('./tiff-preview-worker')
  const session = createTiffDecodeSession(createUnsupportedFirstPageTiff(), {
    createWorker: () => ({
      addEventListener: (type: string, listener: EventListener) => {
        if (type === 'message') listeners.add(listener)
      },
      removeEventListener: (_type: string, listener: EventListener) => {
        listeners.delete(listener)
      },
      postMessage: (request) =>
        queueMicrotask(() => handleRequest({ data: request } as MessageEvent<Request>)),
      terminate: () => {}
    })
  })
  try {
    await expect(session.decodePage(0)).rejects.toMatchObject({
      message: 'Unsupported TIFF compression: 32773',
      pageCount: 2
    })
    const page = await session.decodePage(1)
    expect(Array.from(page.rgba)).toEqual([0, 0, 255, 255])
  } finally {
    session.dispose()
    vi.unstubAllGlobals()
  }
})
