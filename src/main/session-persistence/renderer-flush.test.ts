import { describe, expect, it, vi } from 'vitest'

import { requestRendererSessionPersistenceFlush } from './renderer-flush'

type Listener = (requestId: string) => void

const createHarness = (
  available = true
): {
  sendRequest: ReturnType<typeof vi.fn>
  respond: Listener
  rendererGone: () => void
  cleanupResponse: ReturnType<typeof vi.fn>
  cleanupGone: ReturnType<typeof vi.fn>
  request: () => Promise<void>
} => {
  let responseListener: Listener = () => undefined
  let goneListener = (): void => undefined
  const cleanupResponse = vi.fn()
  const cleanupGone = vi.fn()
  const sendRequest = vi.fn()

  return {
    sendRequest,
    respond: (requestId) => responseListener(requestId),
    rendererGone: () => goneListener(),
    cleanupResponse,
    cleanupGone,
    request: () =>
      requestRendererSessionPersistenceFlush({
        isRendererAvailable: () => available,
        sendRequest,
        onResponse: (listener) => {
          responseListener = listener
          return cleanupResponse
        },
        onRendererGone: (listener) => {
          goneListener = listener
          return cleanupGone
        },
        createRequestId: () => 'flush-1',
        timeoutMs: 1_000
      })
  }
}

describe('requestRendererSessionPersistenceFlush', () => {
  it('waits for the matching renderer acknowledgement and removes listeners', async () => {
    const harness = createHarness()
    const request = harness.request()
    let settled = false
    void request.then(() => {
      settled = true
    })

    expect(harness.sendRequest).toHaveBeenCalledWith('flush-1')
    harness.respond('other')
    await Promise.resolve()
    expect(settled).toBe(false)

    harness.respond('flush-1')
    await request
    expect(harness.cleanupResponse).toHaveBeenCalledOnce()
    expect(harness.cleanupGone).toHaveBeenCalledOnce()
  })

  it('does not wait when no renderer is available', async () => {
    const harness = createHarness(false)
    await expect(harness.request()).resolves.toBeUndefined()
    expect(harness.sendRequest).not.toHaveBeenCalled()
  })

  it('releases the quit when the renderer disappears', async () => {
    const harness = createHarness()
    const request = harness.request()
    harness.rendererGone()
    await expect(request).resolves.toBeUndefined()
  })

  it('bounds the wait when the renderer never acknowledges', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness()
      const request = harness.request()
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(request).resolves.toBeUndefined()
      expect(harness.cleanupResponse).toHaveBeenCalledOnce()
      expect(harness.cleanupGone).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
