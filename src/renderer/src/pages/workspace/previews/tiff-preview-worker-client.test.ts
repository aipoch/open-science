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
