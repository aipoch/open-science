// @vitest-environment jsdom
import type { AcpPermissionResponse, AcpStateSnapshot } from '../../../../shared/acp'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAcpRuntime } from './useAcpRuntime'

// React's act() refuses to run unless the environment opts in to act-aware scheduling.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type AcpRuntimeApi = ReturnType<typeof useAcpRuntime>
type OnStateListener = (snapshot: AcpStateSnapshot) => void

// Minimal renderHook so we can exercise the real hook without pulling in @testing-library/react,
// which the repo does not depend on. A null-rendering harness captures each render's return value.
const renderHook = <Value>(
  hook: () => Value
): { result: { current: Value }; unmount: () => void } => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const result = { current: undefined as unknown as Value }

  const HookHarness = (): null => {
    result.current = hook()
    return null
  }

  act(() => {
    root.render(createElement(HookHarness))
  })

  return {
    result,
    unmount: () =>
      act(() => {
        root.unmount()
      })
  }
}

const createSnapshot = (overrides: Partial<AcpStateSnapshot> = {}): AcpStateSnapshot => ({
  status: 'connected',
  cwd: '/workspace/project',
  sessionIds: [],
  events: [],
  pendingPermissions: [],
  permissionProfiles: {},
  permissionGrants: {},
  promptInFlight: false,
  promptInFlightSessionIds: [],
  ...overrides
})

const createDeferred = <Value>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
  reject: (reason: unknown) => void
} => {
  let resolve!: (value: Value) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })

  return { promise, resolve, reject }
}

// Captures the applySnapshot listener the hook registers so tests can push broadcasts through it.
let capturedStateListener: OnStateListener | undefined
let removeStateListener: ReturnType<typeof vi.fn>
let acpApi: {
  getState: ReturnType<typeof vi.fn>
  onState: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  createSession: ReturnType<typeof vi.fn>
  resumeSession: ReturnType<typeof vi.fn>
  deleteSession: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  sendPrompt: ReturnType<typeof vi.fn>
  respondToPermission: ReturnType<typeof vi.fn>
}

// Lets the initial effect (getState + onState subscription) settle before assertions.
const mountRuntime = async (): Promise<{
  result: { current: AcpRuntimeApi }
  unmount: () => void
}> => {
  const rendered = renderHook(() => useAcpRuntime())
  await act(async () => {
    await Promise.resolve()
  })

  return rendered
}

beforeEach(() => {
  capturedStateListener = undefined
  removeStateListener = vi.fn()
  acpApi = {
    getState: vi.fn().mockResolvedValue(createSnapshot({ status: 'idle' })),
    onState: vi.fn((listener: OnStateListener) => {
      capturedStateListener = listener
      return removeStateListener
    }),
    connect: vi.fn().mockResolvedValue(createSnapshot()),
    disconnect: vi.fn().mockResolvedValue(createSnapshot({ status: 'idle' })),
    createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
    resumeSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
    deleteSession: vi.fn().mockResolvedValue(createSnapshot()),
    cancel: vi.fn().mockResolvedValue(createSnapshot()),
    sendPrompt: vi.fn().mockResolvedValue(createSnapshot()),
    respondToPermission: vi.fn().mockResolvedValue(createSnapshot())
  }

  vi.stubGlobal('window', { api: { acp: acpApi } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('useAcpRuntime respondToPermission', () => {
  it('builds a cancelled response with an undefined optionId when none is chosen', async () => {
    const { result } = await mountRuntime()

    await act(async () => {
      await result.current.respondToPermission('request-1')
    })

    expect(acpApi.respondToPermission).toHaveBeenCalledTimes(1)
    const [payload] = acpApi.respondToPermission.mock.calls[0] as [AcpPermissionResponse]
    expect(payload).toEqual({
      requestId: 'request-1',
      optionId: undefined,
      cancelled: true
    })
    // The undefined optionId key must be present, not merely absent.
    expect('optionId' in payload).toBe(true)
  })

  it('forwards the chosen option and marks the response as not cancelled', async () => {
    const { result } = await mountRuntime()

    await act(async () => {
      await result.current.respondToPermission('request-1', 'allow-once')
    })

    expect(acpApi.respondToPermission).toHaveBeenCalledWith({
      requestId: 'request-1',
      optionId: 'allow-once',
      cancelled: false
    })
  })
})

describe('useAcpRuntime snapshot action failures', () => {
  it('swallows a rejecting snapshot action, records the error, and clears the pending flag', async () => {
    acpApi.connect.mockRejectedValueOnce(new Error('connect failed'))
    const { result } = await mountRuntime()

    let returned: AcpStateSnapshot | undefined = createSnapshot()
    await act(async () => {
      returned = await result.current.connect('/workspace/project')
    })

    // runSnapshotAction returns undefined on failure instead of rethrowing.
    expect(returned).toBeUndefined()
    expect(result.current.actionError).toBe('connect failed')
    expect(result.current.isConnecting).toBe(false)
  })

  it('normalizes non-Error rejections into UI-safe text', async () => {
    acpApi.cancel.mockRejectedValueOnce('raw failure string')
    const { result } = await mountRuntime()

    await act(async () => {
      await result.current.cancel('session-1')
    })

    expect(result.current.actionError).toBe('raw failure string')
  })
})

describe('useAcpRuntime value action failures', () => {
  it('rethrows a rejecting value action while still recording the error and clearing pending', async () => {
    const failure = new Error('createSession failed')
    acpApi.createSession.mockRejectedValueOnce(failure)
    const { result } = await mountRuntime()

    let thrown: unknown
    await act(async () => {
      await result.current.createSession('/workspace/project').catch((error: unknown) => {
        thrown = error
      })
    })

    expect(thrown).toBe(failure)
    expect(result.current.actionError).toBe('createSession failed')
    expect(result.current.isConnecting).toBe(false)
  })
})

describe('useAcpRuntime state subscription', () => {
  it('subscribes on mount, applies pushed snapshots, and unsubscribes on unmount', async () => {
    const { result, unmount } = await mountRuntime()

    expect(acpApi.onState).toHaveBeenCalledTimes(1)
    expect(capturedStateListener).toBeTypeOf('function')

    const pushed = createSnapshot({
      status: 'connected',
      cwd: '/pushed/cwd',
      sessionIds: ['session-9']
    })

    act(() => {
      capturedStateListener?.(pushed)
    })

    expect(result.current.state).toEqual(pushed)
    expect(removeStateListener).not.toHaveBeenCalled()

    unmount()

    expect(removeStateListener).toHaveBeenCalledTimes(1)
  })
})

describe('useAcpRuntime pending lifecycle', () => {
  it('raises the connecting flag while an action is in flight and lowers it once it resolves', async () => {
    const deferred = createDeferred<AcpStateSnapshot>()
    acpApi.connect.mockReturnValueOnce(deferred.promise)
    const { result } = await mountRuntime()

    expect(result.current.isConnecting).toBe(false)

    let inFlight: Promise<AcpStateSnapshot | undefined> | undefined
    await act(async () => {
      inFlight = result.current.connect('/workspace/project')
    })

    // Pending flag is raised synchronously before the IPC promise settles.
    expect(result.current.isConnecting).toBe(true)

    await act(async () => {
      deferred.resolve(createSnapshot({ cwd: '/connected' }))
      await inFlight
    })

    expect(result.current.isConnecting).toBe(false)
    expect(result.current.state.cwd).toBe('/connected')
  })
})
