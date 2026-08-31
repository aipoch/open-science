import { describe, expect, it, vi } from 'vitest'

import {
  SESSION_PERSISTENCE_FLUSH_ABORTED_CHANNEL,
  SESSION_PERSISTENCE_FLUSH_REQUEST_CHANNEL,
  SESSION_PERSISTENCE_FLUSH_RESPONSE_CHANNEL
} from '../../shared/session-persistence-flush'
import type { SessionPersistenceFlushResponse } from '../../shared/session-persistence-flush'
import {
  createElectronSessionPersistenceFlush,
  createWebSessionPersistenceFlush,
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

  it.each([
    'conflict',
    'renderer-failed',
    'unavailable',
    'renderer-gone',
    'send-failed',
    'timeout'
  ] as const)('blocks a data-root handoff for %s', (outcome) => {
    expect(rendererSessionPersistenceFlushBlocksShutdown(outcome, 'data-root-handoff')).toBe(true)
  })

  it('allows a data-root handoff after a completed flush', () => {
    expect(rendererSessionPersistenceFlushBlocksShutdown('completed', 'data-root-handoff')).toBe(
      false
    )
  })

  it('requires a post-teardown Web acknowledgement for a data-root handoff', () => {
    expect(rendererSessionPersistenceFlushBlocksShutdown('unavailable', 'data-root-handoff')).toBe(
      true
    )
  })
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

    notifyRendererSessionPersistenceFlushAborted(() => window as never, 'conflict')

    expect(webContents.send).toHaveBeenCalledWith(SESSION_PERSISTENCE_FLUSH_ABORTED_CHANNEL, {
      reason: 'conflict'
    })
  })

  it('preserves the payload-free durability-abort notification', () => {
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

describe('createWebSessionPersistenceFlush', () => {
  it('publishes a post-teardown request and waits for its Web acknowledgement', async () => {
    const publish = vi.fn()
    const coordinator = createWebSessionPersistenceFlush({ publish }, 1_000)
    const request = coordinator.flush('web:client-1')
    const flushRequest = publish.mock.calls[0][1] as {
      requestId: string
      targetLifecycleClientId: string
    }

    expect(publish).toHaveBeenCalledWith(SESSION_PERSISTENCE_FLUSH_REQUEST_CHANNEL, flushRequest)
    expect(flushRequest.targetLifecycleClientId).toBe('web:client-1')
    coordinator.acknowledge({ requestId: 'stale', status: 'completed' }, 'web:client-1')
    coordinator.acknowledge(
      { requestId: flushRequest.requestId, status: 'completed' },
      'web:client-1'
    )

    await expect(request).resolves.toBe('completed')
  })

  it('accepts an acknowledgement only from the Web client that requested the handoff', async () => {
    const publish = vi.fn()
    const coordinator = createWebSessionPersistenceFlush({ publish }, 1_000) as unknown as {
      flush: (targetClientId: string) => Promise<RendererSessionPersistenceFlushOutcome>
      acknowledge: (response: SessionPersistenceFlushResponse, clientId: string) => void
    }
    const request = coordinator.flush('web:client-a')
    const flushRequest = publish.mock.calls[0][1] as { requestId: string }
    let settled = false
    void request.then(() => {
      settled = true
    })

    coordinator.acknowledge(
      { requestId: flushRequest.requestId, status: 'completed' },
      'web:client-b'
    )
    const prematureOutcome = await Promise.race([
      request,
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))
    ])
    expect(prematureOutcome).toBe('pending')
    expect(settled).toBe(false)

    coordinator.acknowledge(
      { requestId: flushRequest.requestId, status: 'completed' },
      'web:client-a'
    )
    await expect(request).resolves.toBe('completed')
  })

  it('notifies Web when a refused handoff must resume renderer activity', () => {
    const publish = vi.fn()
    const coordinator = createWebSessionPersistenceFlush({ publish })

    coordinator.notifyAborted('renderer-failed')

    expect(publish).toHaveBeenCalledWith(SESSION_PERSISTENCE_FLUSH_ABORTED_CHANNEL, {
      reason: 'renderer-failed'
    })
  })

  it('preserves the payload-free Web durability-abort notification', () => {
    const publish = vi.fn()
    const coordinator = createWebSessionPersistenceFlush({ publish })

    coordinator.notifyAborted()

    expect(publish).toHaveBeenCalledWith(SESSION_PERSISTENCE_FLUSH_ABORTED_CHANNEL, undefined)
  })
})
