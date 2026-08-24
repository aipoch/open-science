import { describe, expect, it, vi } from 'vitest'

import {
  SESSION_PERSISTENCE_FLUSH_ABORTED_CHANNEL,
  SESSION_PERSISTENCE_FLUSH_REQUEST_CHANNEL,
  SESSION_PERSISTENCE_FLUSH_RESPONSE_CHANNEL
} from '../../shared/session-persistence-flush'
import type { SessionPersistenceFlushResponse } from '../../shared/session-persistence-flush'
import {
  createElectronSessionPersistenceFlush,
  notifyRendererSessionPersistenceFlushAborted,
  rendererSessionPersistenceFlushBlocksShutdown,
  requestRendererSessionPersistenceFlush
} from './renderer-flush'
import type { RendererSessionPersistenceFlushOutcome } from './renderer-flush'

const electronMocks = vi.hoisted(() => ({
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: electronMocks.on,
    removeListener: electronMocks.removeListener
  }
}))

type Listener = (response: SessionPersistenceFlushResponse) => void

const createHarness = (
  available = true
): {
  sendRequest: ReturnType<typeof vi.fn>
  respond: (requestId: string, status?: SessionPersistenceFlushResponse['status']) => void
  rendererGone: () => void
  cleanupResponse: ReturnType<typeof vi.fn>
  cleanupGone: ReturnType<typeof vi.fn>
  request: () => Promise<RendererSessionPersistenceFlushOutcome>
} => {
  let responseListener: Listener = () => undefined
  let goneListener = (): void => undefined
  const cleanupResponse = vi.fn()
  const cleanupGone = vi.fn()
  const sendRequest = vi.fn()

  return {
    sendRequest,
    respond: (requestId, status = 'completed') => responseListener({ requestId, status }),
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
    await expect(request).resolves.toBe('completed')
    expect(harness.cleanupResponse).toHaveBeenCalledOnce()
    expect(harness.cleanupGone).toHaveBeenCalledOnce()
  })

  it('does not wait when no renderer is available', async () => {
    const harness = createHarness(false)
    await expect(harness.request()).resolves.toBe('unavailable')
    expect(harness.sendRequest).not.toHaveBeenCalled()
  })

  it('surfaces an unresolved renderer revision conflict to the quit owner', async () => {
    const harness = createHarness()
    const request = harness.request()
    harness.respond('flush-1', 'conflict')
    await expect(request).resolves.toBe('conflict')
  })

  it('fails closed when the renderer returns an invalid status', async () => {
    const harness = createHarness()
    const request = harness.request()
    harness.respond('flush-1', 'invalid' as SessionPersistenceFlushResponse['status'])
    await expect(request).resolves.toBe('renderer-failed')
  })

  it('releases the quit when the renderer disappears', async () => {
    const harness = createHarness()
    const request = harness.request()
    harness.rendererGone()
    await expect(request).resolves.toBe('renderer-gone')
  })

  it('bounds the wait when the renderer never acknowledges', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness()
      const request = harness.request()
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(request).resolves.toBe('timeout')
      expect(harness.cleanupResponse).toHaveBeenCalledOnce()
      expect(harness.cleanupGone).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('classifies a send failure without rejecting quit', async () => {
    const harness = createHarness()
    harness.sendRequest.mockImplementation(() => {
      throw new Error('renderer unavailable')
    })

    await expect(harness.request()).resolves.toBe('send-failed')
  })
})

describe('rendererSessionPersistenceFlushBlocksShutdown', () => {
  it.each(['conflict', 'renderer-failed'] as const)('blocks shutdown for %s', (outcome) => {
    expect(rendererSessionPersistenceFlushBlocksShutdown(outcome)).toBe(true)
  })

  it.each(['completed', 'unavailable', 'renderer-gone', 'send-failed', 'timeout'] as const)(
    'allows shutdown for %s',
    (outcome) => {
      expect(rendererSessionPersistenceFlushBlocksShutdown(outcome)).toBe(false)
    }
  )
})

describe('createElectronSessionPersistenceFlush', () => {
  it('notifies a surviving renderer when quit is aborted', () => {
    const webContents = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn()
    }
    const window = {
      isDestroyed: vi.fn(() => false),
      webContents
    }

    notifyRendererSessionPersistenceFlushAborted(() => window as never)

    expect(webContents.send).toHaveBeenCalledWith(SESSION_PERSISTENCE_FLUSH_ABORTED_CHANNEL)
  })

  it('uses a five-second default timeout for a live renderer that never acknowledges', async () => {
    vi.useFakeTimers()
    electronMocks.on.mockClear()
    electronMocks.removeListener.mockClear()

    try {
      const webContents = {
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn()
      }
      const window = {
        isDestroyed: vi.fn(() => false),
        webContents
      }
      const flush = createElectronSessionPersistenceFlush(() => window as never)
      const request = flush()
      let settled = false
      void request.then(() => {
        settled = true
      })

      await vi.advanceTimersByTimeAsync(4_999)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await expect(request).resolves.toBe('timeout')
      expect(electronMocks.removeListener).toHaveBeenCalledOnce()
      expect(webContents.removeListener).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts only the target renderer acknowledgement with the matching request ID', async () => {
    electronMocks.on.mockClear()
    electronMocks.removeListener.mockClear()

    const webContents = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn()
    }
    const window = {
      isDestroyed: vi.fn(() => false),
      webContents
    }
    const flush = createElectronSessionPersistenceFlush(() => window as never, 1_000)
    const request = flush()
    let settled = false
    void request.then(() => {
      settled = true
    })

    expect(webContents.send).toHaveBeenCalledWith(
      SESSION_PERSISTENCE_FLUSH_REQUEST_CHANNEL,
      expect.objectContaining({ requestId: expect.any(String) })
    )
    const sentRequest = webContents.send.mock.calls[0][1] as { requestId: string }
    const responseRegistration = electronMocks.on.mock.calls.find(
      ([channel]) => channel === SESSION_PERSISTENCE_FLUSH_RESPONSE_CHANNEL
    )
    const responseHandler = responseRegistration?.[1] as
      ((event: { sender: unknown }, response: SessionPersistenceFlushResponse) => void) | undefined
    expect(responseHandler).toBeTypeOf('function')
    const rendererGoneRegistration = webContents.on.mock.calls.find(
      ([event]) => event === 'render-process-gone'
    )
    const rendererGoneListener = rendererGoneRegistration?.[1] as (() => void) | undefined
    expect(rendererGoneListener).toBeTypeOf('function')

    responseHandler?.({ sender: {} }, { requestId: sentRequest.requestId, status: 'completed' })
    await Promise.resolve()
    expect(settled).toBe(false)

    responseHandler?.({ sender: webContents }, { requestId: 'other-request', status: 'completed' })
    await Promise.resolve()
    expect(settled).toBe(false)

    responseHandler?.(
      { sender: webContents },
      { requestId: sentRequest.requestId, status: 'completed' }
    )
    await expect(request).resolves.toBe('completed')
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      SESSION_PERSISTENCE_FLUSH_RESPONSE_CHANNEL,
      responseHandler
    )
    expect(webContents.removeListener).toHaveBeenCalledWith(
      'render-process-gone',
      rendererGoneListener
    )
  })
})
