// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const {
  drainWorkspaceRuntimeEventsForPersistence,
  flushPreviewPersistence,
  flushSessionPersistence,
  resumeAutoReviewsAfterQuitAbort
} = vi.hoisted(() => ({
  drainWorkspaceRuntimeEventsForPersistence: vi.fn(async () => undefined),
  flushPreviewPersistence: vi.fn(async () => undefined),
  flushSessionPersistence: vi.fn(async () => undefined),
  resumeAutoReviewsAfterQuitAbort: vi.fn()
}))

vi.mock('../lib/preview-persistence/preview-persistence', () => ({
  flushPreviewPersistence
}))

vi.mock('../lib/acp/workspace-events', () => ({
  resumeAutoReviewsAfterQuitAbort,
  suppressAutoReviewsForQuit: vi.fn()
}))
vi.mock('../lib/acp/useWorkspaceAgentRuntime', () => ({
  drainWorkspaceRuntimeEventsForPersistence
}))
vi.mock('../lib/session-persistence/session-persistence', () => ({
  flushSessionPersistence
}))

import { completeQuitPersistenceFlush, useQuitPersistenceFlush } from './useQuitPersistenceFlush'

afterEach(() => {
  vi.unstubAllGlobals()
  drainWorkspaceRuntimeEventsForPersistence.mockClear()
  flushPreviewPersistence.mockClear()
  flushSessionPersistence.mockClear()
  resumeAutoReviewsAfterQuitAbort.mockClear()
})

describe('completeQuitPersistenceFlush', () => {
  it('resumes renderer quit preparation and exposes the blocking conflict', () => {
    let notifyAborted: (event: { reason: 'conflict' }) => void = () => undefined
    const removeAborted = vi.fn()
    const removeRequest = vi.fn()
    vi.stubGlobal('window', {
      api: {
        sessions: {
          onFlushAborted: (listener: typeof notifyAborted) => {
            notifyAborted = listener
            return removeAborted
          },
          onFlushRequest: () => removeRequest,
          sendFlushResponse: vi.fn()
        }
      }
    })

    const { result, unmount } = renderHook(() => useQuitPersistenceFlush())
    act(() => notifyAborted({ reason: 'conflict' }))

    expect(resumeAutoReviewsAfterQuitAbort).toHaveBeenCalledOnce()
    expect(result.current).toMatchObject({ notice: { reason: 'conflict' } })
    unmount()
    expect(removeAborted).toHaveBeenCalledOnce()
    expect(removeRequest).toHaveBeenCalledOnce()
  })

  it('resumes renderer activity without a quit notice for a durability handoff abort', () => {
    let notifyAborted: (event?: { reason: 'conflict' }) => void = () => undefined
    vi.stubGlobal('window', {
      api: {
        sessions: {
          onFlushAborted: (listener: typeof notifyAborted) => {
            notifyAborted = listener
            return vi.fn()
          },
          onFlushRequest: () => vi.fn(),
          sendFlushResponse: vi.fn()
        }
      }
    })

    const { result } = renderHook(() => useQuitPersistenceFlush())
    act(() => notifyAborted())

    expect(resumeAutoReviewsAfterQuitAbort).toHaveBeenCalledOnce()
    expect(result.current.notice).toBeUndefined()
  })

  it('retries every renderer persistence phase after a failed quit flush', async () => {
    let notifyAborted: (event: { reason: 'renderer-failed' }) => void = () => undefined
    vi.stubGlobal('window', {
      api: {
        sessions: {
          onFlushAborted: (listener: typeof notifyAborted) => {
            notifyAborted = listener
            return vi.fn()
          },
          onFlushRequest: () => vi.fn(),
          sendFlushResponse: vi.fn()
        }
      }
    })

    const { result } = renderHook(() => useQuitPersistenceFlush())
    act(() => notifyAborted({ reason: 'renderer-failed' }))
    await act(() => result.current.retryPersistence())

    expect(drainWorkspaceRuntimeEventsForPersistence).toHaveBeenCalledOnce()
    expect(flushSessionPersistence).toHaveBeenCalledOnce()
    expect(flushPreviewPersistence).toHaveBeenCalledOnce()
    expect(result.current.notice).toBeUndefined()
  })

  it('keeps the failed quit notice when a complete persistence retry still fails', async () => {
    let notifyAborted: (event: { reason: 'renderer-failed' }) => void = () => undefined
    flushPreviewPersistence.mockRejectedValueOnce(new Error('preview write failed'))
    vi.stubGlobal('window', {
      api: {
        sessions: {
          onFlushAborted: (listener: typeof notifyAborted) => {
            notifyAborted = listener
            return vi.fn()
          },
          onFlushRequest: () => vi.fn(),
          sendFlushResponse: vi.fn()
        }
      }
    })

    const { result } = renderHook(() => useQuitPersistenceFlush())
    act(() => notifyAborted({ reason: 'renderer-failed' }))
    await expect(result.current.retryPersistence()).rejects.toThrow('preview write failed')

    expect(result.current.notice).toEqual({ reason: 'renderer-failed' })
  })

  it('flushes Preview persistence before acknowledging quit', async () => {
    let notifyFlush: (request: { requestId: string }) => void = () => undefined
    const removeRequest = vi.fn()
    const sendFlushResponse = vi.fn()
    vi.stubGlobal('window', {
      api: {
        sessions: {
          onFlushRequest: (listener: (request: { requestId: string }) => void) => {
            notifyFlush = listener
            return removeRequest
          },
          sendFlushResponse
        }
      }
    })

    const { unmount } = renderHook(() => useQuitPersistenceFlush())
    notifyFlush({ requestId: 'flush-preview-1' })

    await vi.waitFor(() => {
      expect(sendFlushResponse).toHaveBeenCalledWith({
        requestId: 'flush-preview-1',
        status: 'completed'
      })
    })
    expect(flushSessionPersistence).toHaveBeenCalledOnce()
    expect(flushPreviewPersistence).toHaveBeenCalledOnce()
    expect(flushSessionPersistence.mock.invocationCallOrder[0]).toBeLessThan(
      flushPreviewPersistence.mock.invocationCallOrder[0]
    )
    expect(flushPreviewPersistence.mock.invocationCallOrder[0]).toBeLessThan(
      sendFlushResponse.mock.invocationCallOrder[0]
    )

    unmount()
    expect(removeRequest).toHaveBeenCalledOnce()
  })

  it('acknowledges a Web handoff through the local storage command', async () => {
    let notifyFlush: (request: {
      requestId: string
      targetLifecycleClientId?: string
    }) => void = () => undefined
    const ackDataRootHandoffFlush = vi.fn(async () => undefined)
    vi.stubGlobal('window', {
      api: {
        lifecycle: { getClientId: vi.fn(async () => 'web:client-a') },
        sessions: {
          onFlushRequest: (listener: typeof notifyFlush) => {
            notifyFlush = listener
            return vi.fn()
          }
        },
        storage: { ackDataRootHandoffFlush }
      }
    })

    const { unmount } = renderHook(() => useQuitPersistenceFlush())
    notifyFlush({ requestId: 'web-flush-1', targetLifecycleClientId: 'web:client-a' })

    await vi.waitFor(() =>
      expect(ackDataRootHandoffFlush).toHaveBeenCalledWith({
        requestId: 'web-flush-1',
        status: 'completed'
      })
    )
    unmount()
  })

  it('ignores a Web handoff request targeted at another browser tab', async () => {
    let notifyFlush: (request: {
      requestId: string
      targetLifecycleClientId?: string
    }) => void = () => undefined
    const getClientId = vi.fn(async () => 'web:client-b')
    const ackDataRootHandoffFlush = vi.fn(async () => undefined)
    vi.stubGlobal('window', {
      api: {
        lifecycle: { getClientId },
        sessions: {
          onFlushRequest: (listener: typeof notifyFlush) => {
            notifyFlush = listener
            return vi.fn()
          }
        },
        storage: { ackDataRootHandoffFlush }
      }
    })

    const { unmount } = renderHook(() => useQuitPersistenceFlush())
    notifyFlush({ requestId: 'web-flush-1', targetLifecycleClientId: 'web:client-a' })

    await vi.waitFor(() => expect(getClientId).toHaveBeenCalledOnce())
    expect(flushSessionPersistence).not.toHaveBeenCalled()
    expect(flushPreviewPersistence).not.toHaveBeenCalled()
    expect(ackDataRootHandoffFlush).not.toHaveBeenCalled()
    unmount()
  })

  it('drains terminal runtime events before flushing and acknowledging', async () => {
    const calls: string[] = []

    await completeQuitPersistenceFlush(
      { requestId: 'flush-1' },
      {
        suppressAutoReviews: () => {
          calls.push('suppress-auto-reviews')
        },
        drainRuntimeEvents: async () => {
          calls.push('drain')
        },
        flushPersistence: async () => {
          calls.push('flush')
        },
        flushPreviewPersistence: async () => {
          calls.push('flush-preview')
        },
        acknowledge: () => {
          calls.push('acknowledge')
        }
      }
    )

    expect(calls).toEqual([
      'suppress-auto-reviews',
      'drain',
      'flush',
      'flush-preview',
      'acknowledge'
    ])
  })

  it('always acknowledges so a failed renderer flush cannot strand app quit', async () => {
    const acknowledge = vi.fn()

    await expect(
      completeQuitPersistenceFlush(
        { requestId: 'flush-1' },
        {
          suppressAutoReviews: () => undefined,
          drainRuntimeEvents: async () => {
            throw new Error('renderer unavailable')
          },
          flushPersistence: async () => undefined,
          flushPreviewPersistence: async () => undefined,
          acknowledge
        }
      )
    ).rejects.toThrow('renderer unavailable')
    expect(acknowledge).toHaveBeenCalledWith({ requestId: 'flush-1', status: 'failed' })
  })

  it('reports a failed Preview flush so Main can abort quit', async () => {
    const acknowledge = vi.fn()
    const previewFailure = new Error('preview persistence failed')

    await expect(
      completeQuitPersistenceFlush(
        { requestId: 'flush-preview-failed' },
        {
          suppressAutoReviews: () => undefined,
          drainRuntimeEvents: async () => undefined,
          flushPersistence: async () => undefined,
          flushPreviewPersistence: async () => Promise.reject(previewFailure),
          acknowledge
        }
      )
    ).rejects.toBe(previewFailure)
    expect(acknowledge).toHaveBeenCalledWith({
      requestId: 'flush-preview-failed',
      status: 'failed'
    })
  })

  it('acknowledges an unresolved revision conflict without classifying the flush as completed', async () => {
    const acknowledge = vi.fn()
    const conflict = Object.assign(new Error('revision changed'), {
      code: 'session-revision-conflict'
    })

    await expect(
      completeQuitPersistenceFlush(
        { requestId: 'flush-1' },
        {
          suppressAutoReviews: () => undefined,
          drainRuntimeEvents: async () => undefined,
          flushPersistence: async () => Promise.reject(conflict),
          flushPreviewPersistence: async () => undefined,
          acknowledge
        }
      )
    ).rejects.toBe(conflict)
    expect(acknowledge).toHaveBeenCalledWith({ requestId: 'flush-1', status: 'conflict' })
  })
})
