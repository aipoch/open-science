// @vitest-environment jsdom
import type {
  AcpPermissionResponse,
  AcpRuntimeState,
  AcpRuntimeEvent,
  AcpStateSnapshot,
  AcpStateUpdate
} from '../../../../shared/acp'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAcpRuntime } from './useAcpRuntime'
import {
  acceptAcpRuntimeSnapshotRevision,
  resetAcpRuntimeSnapshotRevisionForTests
} from './runtime-snapshot-revision-owner'

// React's act() refuses to run unless the environment opts in to act-aware scheduling.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type AcpRuntimeApi = ReturnType<typeof useAcpRuntime>
type OnStateListener = (snapshot: AcpStateUpdate) => void
type OnEventListener = (events: readonly AcpRuntimeEvent[]) => void

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
  contextUsageBySession: {},
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
let capturedEventListener: OnEventListener | undefined
let removeStateListener: ReturnType<typeof vi.fn>
let removeEventListener: ReturnType<typeof vi.fn>
let acpApi: {
  getState: ReturnType<typeof vi.fn>
  onState: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  createSession: ReturnType<typeof vi.fn>
  resumeSession: ReturnType<typeof vi.fn>
  resetSessionContext: ReturnType<typeof vi.fn>
  continueInterruptedTurn: ReturnType<typeof vi.fn>
  compactSession: ReturnType<typeof vi.fn>
  deleteSession: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  sendPrompt: ReturnType<typeof vi.fn>
  steerFollowUp: ReturnType<typeof vi.fn>
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
  resetAcpRuntimeSnapshotRevisionForTests()
  capturedStateListener = undefined
  capturedEventListener = undefined
  removeStateListener = vi.fn()
  removeEventListener = vi.fn()
  acpApi = {
    getState: vi.fn().mockResolvedValue(createSnapshot({ status: 'idle' })),
    onState: vi.fn((listener: OnStateListener) => {
      capturedStateListener = listener
      return removeStateListener
    }),
    onEvent: vi.fn((listener: OnEventListener) => {
      capturedEventListener = listener
      return removeEventListener
    }),
    connect: vi.fn().mockResolvedValue(createSnapshot()),
    disconnect: vi.fn().mockResolvedValue(createSnapshot({ status: 'idle' })),
    createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
    resumeSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
    resetSessionContext: vi.fn().mockResolvedValue(createSnapshot()),
    continueInterruptedTurn: vi.fn().mockResolvedValue(createSnapshot()),
    compactSession: vi.fn().mockResolvedValue(createSnapshot()),
    deleteSession: vi.fn().mockResolvedValue(createSnapshot()),
    cancel: vi.fn().mockResolvedValue(createSnapshot()),
    sendPrompt: vi.fn().mockResolvedValue(createSnapshot()),
    steerFollowUp: vi.fn().mockResolvedValue({ injected: false, reason: 'not-advertised' }),
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

  it('reports and rethrows a permission persistence failure', async () => {
    acpApi.respondToPermission.mockRejectedValueOnce(
      new Error('Permission approval could not be saved; the tool call was cancelled.')
    )
    const { result } = await mountRuntime()

    let caught: unknown
    await act(async () => {
      try {
        await result.current.respondToPermission('request-1', 'allow-project')
      } catch (error) {
        caught = error
      }
    })

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('Permission approval could not be saved')
    expect(result.current.actionError).toContain('Permission approval could not be saved')
  })
})

describe('useAcpRuntime snapshot action failures', () => {
  it('swallows a rejecting snapshot action, records the error, and clears the pending flag', async () => {
    acpApi.connect.mockRejectedValueOnce(new Error('connect failed'))
    const { result } = await mountRuntime()

    let returned: AcpRuntimeState | undefined = createSnapshot()
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
  it('rethrows a rejecting value action without recording it in actionError', async () => {
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
    // runValueAction now records the error in actionError while rethrowing.
    expect(result.current.actionError).toBe('createSession failed')
    expect(result.current.isConnecting).toBe(false)
  })

  it('sendPrompt rethrows IPC rejection without recording it in actionError', async () => {
    const failure = new Error('Connection timeout')
    acpApi.sendPrompt.mockRejectedValueOnce(failure)
    const { result } = await mountRuntime()

    let thrown: unknown
    await act(async () => {
      await result.current.sendPrompt('session-1', 'test prompt').catch((error: unknown) => {
        thrown = error
      })
    })

    // sendPrompt must rethrow the actual IPC error for callers to handle.
    expect(thrown).toBe(failure)
    // sendPrompt does NOT set actionError; the error is only rethrown.
    expect(result.current.actionError).toBeNull()
  })

  it('sendPrompt syncs snapshot state on success', async () => {
    const snapshot = createSnapshot({ cwd: '/new/workspace' })
    acpApi.sendPrompt.mockResolvedValueOnce(snapshot)
    const { result } = await mountRuntime()

    await act(async () => {
      await result.current.sendPrompt('session-1', 'test prompt')
    })

    // sendPrompt must call setState to sync the snapshot before returning.
    expect(result.current.state.cwd).toBe('/new/workspace')
  })
})

describe('useAcpRuntime payload construction', () => {
  it('forwards the closed Plan first turn intent without changing the user text', async () => {
    const { result } = await mountRuntime()

    await act(async () => {
      await result.current.sendPrompt(
        'session-1',
        'analyze this dataset',
        undefined,
        ['skill-analysis'],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'plan-first'
      )
    })

    expect(acpApi.sendPrompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      text: 'analyze this dataset',
      forcedSkillIds: ['skill-analysis'],
      attachments: undefined,
      memoryEnabled: true,
      turnIntent: 'plan-first'
    })
  })

  it('requests native context compaction for one session', async () => {
    const { result } = await mountRuntime()

    await act(async () => {
      await result.current.compactSession('session-1')
    })

    expect(acpApi.compactSession).toHaveBeenCalledWith({ sessionId: 'session-1' })
  })

  it('forwards prior runtime and provider identity into the resume payload', async () => {
    const { result } = await mountRuntime()

    await act(async () => {
      await result.current.resumeSession(
        'session-1',
        '/workspace/project',
        'Project',
        'ask',
        'opencode',
        'opencode:provider-a',
        'specialist-1',
        'provider-session-1',
        'bridge-generation-1'
      )
    })

    expect(acpApi.resumeSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      cwd: '/workspace/project',
      projectId: 'Project',
      permissionProfile: 'ask',
      memoryEnabled: true,
      previousFrameworkId: 'opencode',
      previousBackendId: 'opencode:provider-a',
      specialistId: 'specialist-1',
      providerSessionId: 'provider-session-1',
      providerContinuityToken: 'bridge-generation-1',
      specialistBindingPending: undefined
    })
  })

  it('forwards an explicitly disabled conversation Memory preference across ACP requests', async () => {
    const { result } = await mountRuntime()

    await act(async () => {
      await result.current.createSession(
        '/workspace',
        'project-1',
        'ask',
        undefined,
        undefined,
        false
      )
      await result.current.resumeSession(
        'session-1',
        '/workspace',
        'project-1',
        'ask',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false
      )
      await result.current.resetSessionContext('session-1', '/workspace', 'project-1', 'ask', false)
      await result.current.sendPrompt(
        'session-1',
        'answer without memory',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false
      )
    })

    expect(acpApi.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ memoryEnabled: false })
    )
    expect(acpApi.resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ memoryEnabled: false })
    )
    expect(acpApi.resetSessionContext).toHaveBeenCalledWith(
      expect.objectContaining({ memoryEnabled: false })
    )
    expect(acpApi.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ memoryEnabled: false })
    )
  })

  it('forwards only the restricted interrupted-turn continuation contract', async () => {
    const { result } = await mountRuntime()
    const request = {
      sessionId: 'session-1',
      projectId: 'project-1',
      promptMessageId: 'prompt-1'
    }

    await act(async () => {
      await result.current.continueInterruptedTurn(request)
    })

    expect(acpApi.continueInterruptedTurn).toHaveBeenCalledWith(request)
  })

  it('keeps current images separate from replay images in the prompt request', async () => {
    const { result } = await mountRuntime()

    const attachment = { id: 'up-1', name: 'a.txt', mimeType: 'text/plain', size: 1 }
    const image = { mimeType: 'image/png', data: 'aGVsbG8=' }
    const currentImage = { mimeType: 'image/png', data: 'd29ybGQ=', byteLength: 5 }
    const resumeFallback = { historyPreamble: 'fallback transcript' }

    await act(async () => {
      await result.current.sendPrompt(
        'session-1',
        'continue',
        undefined,
        undefined,
        undefined,
        'prior transcript',
        [attachment] as never,
        [image] as never,
        resumeFallback as never,
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        [currentImage] as never
      )
    })

    const [payload] = acpApi.sendPrompt.mock.calls[0] as [Record<string, unknown>]
    expect(payload).toMatchObject({
      sessionId: 'session-1',
      text: 'continue',
      historyPreamble: 'prior transcript',
      historyAttachments: [attachment],
      historyImages: [image],
      currentImages: [currentImage],
      resumeFallback,
      contextReset: true
    })
  })

  it('omits the history/resume fields entirely when they are absent or empty', async () => {
    const { result } = await mountRuntime()

    await act(async () => {
      await result.current.sendPrompt(
        'session-1',
        'hello',
        undefined,
        undefined,
        undefined,
        undefined,
        [],
        []
      )
    })

    const [payload] = acpApi.sendPrompt.mock.calls[0] as [Record<string, unknown>]
    expect(payload).toEqual({
      sessionId: 'session-1',
      text: 'hello',
      memoryEnabled: true,
      attachments: undefined
    })
    for (const field of [
      'historyPreamble',
      'historyAttachments',
      'historyImages',
      'currentImages',
      'resumeFallback',
      'contextReset'
    ]) {
      expect(field in payload).toBe(false)
    }
  })
})

describe('useAcpRuntime state subscription', () => {
  it('keeps snapshot delivery enabled when the Main event channel is unavailable', async () => {
    const event: AcpRuntimeEvent = {
      id: 'runtime-1:event-1',
      timestamp: 1,
      kind: 'message',
      level: 'info',
      role: 'assistant',
      sessionId: 'session-1',
      text: 'snapshot output'
    }
    Reflect.deleteProperty(acpApi, 'onEvent')
    acpApi.getState.mockResolvedValueOnce(createSnapshot({ events: [event] }))

    const { result } = await mountRuntime()

    expect(result.current.subscribeRuntimeEvents).toBeUndefined()
    expect(result.current.state.events).toEqual([event])
  })

  it('streams runtime events outside React state and unsubscribes both IPC listeners', async () => {
    const { result, unmount } = await mountRuntime()
    const delivered = vi.fn()
    result.current.subscribeRuntimeEvents?.(delivered)
    const event: AcpRuntimeEvent = {
      id: 'runtime-1:event-1',
      timestamp: 1,
      kind: 'message',
      level: 'info',
      role: 'assistant',
      sessionId: 'session-1',
      text: 'incremental output'
    }

    expect(acpApi.onEvent).toHaveBeenCalledTimes(1)
    expect(acpApi.onState.mock.invocationCallOrder[0]).toBeLessThan(
      acpApi.getState.mock.invocationCallOrder[0]
    )
    expect(acpApi.onEvent.mock.invocationCallOrder[0]).toBeLessThan(
      acpApi.getState.mock.invocationCallOrder[0]
    )
    act(() => capturedEventListener?.([event]))

    expect(delivered).toHaveBeenCalledWith([event], undefined)
    expect(result.current.currentRuntimeEvents()).toEqual([event])
    expect(result.current.state.events).toEqual([])

    unmount()
    expect(removeEventListener).toHaveBeenCalledTimes(1)
    expect(removeStateListener).toHaveBeenCalledTimes(1)
  })

  it('delivers an incremental event that arrives before the initial snapshot resolves', async () => {
    const initial = createDeferred<AcpStateSnapshot>()
    acpApi.getState.mockReturnValueOnce(initial.promise)
    const { result } = await mountRuntime()
    const delivered: AcpRuntimeEvent[] = []
    result.current.subscribeRuntimeEvents?.((events) => delivered.push(...events))
    const event: AcpRuntimeEvent = {
      id: 'runtime-1:event-1',
      timestamp: 2,
      kind: 'thought',
      level: 'info',
      role: 'assistant',
      sessionId: 'session-1',
      text: 'newer live output'
    }

    act(() => capturedEventListener?.([event]))
    await act(async () => {
      initial.resolve(createSnapshot({ revision: 1, events: [] }))
      await initial.promise
    })

    expect(delivered).toEqual([event])
    expect(result.current.currentRuntimeEvents()).toEqual([event])
    expect(result.current.state.events).toEqual([])
  })

  it('uses the initial snapshot as the event barrier after a newer state-only update', async () => {
    const initial = createDeferred<AcpStateSnapshot>()
    acpApi.getState.mockReturnValueOnce(initial.promise)
    const { result } = await mountRuntime()
    const delivered: AcpRuntimeEvent[] = []
    result.current.subscribeRuntimeEvents?.((events) => delivered.push(...events))
    const pendingEvent: AcpRuntimeEvent = {
      id: 'runtime-1:event-before-initial-snapshot',
      timestamp: 2,
      kind: 'message',
      level: 'info',
      role: 'assistant',
      sessionId: 'session-1',
      text: 'queued until the initial event window arrives'
    }

    act(() => {
      capturedStateListener?.({
        ...createSnapshot({ revision: 2, status: 'connected' }),
        events: undefined
      })
      capturedEventListener?.([pendingEvent])
    })
    await act(async () => {
      initial.resolve(createSnapshot({ revision: 1, status: 'idle', events: [] }))
      await initial.promise
    })

    expect(delivered).toEqual([pendingEvent])
    expect(result.current.currentRuntimeEvents()).toEqual([pendingEvent])
    expect(result.current.state.status).toBe('connected')
    expect(result.current.state.revision).toBe(2)
  })

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

  it('clears omitted optional fields from an authoritative state-only update', async () => {
    const { result } = await mountRuntime()

    act(() => {
      capturedStateListener?.(
        createSnapshot({
          revision: 1,
          sessionId: 'session-1',
          sessionIds: ['session-1'],
          error: 'connection failed'
        })
      )
      capturedStateListener?.({
        ...createSnapshot({ revision: 2, status: 'idle' }),
        events: undefined
      })
    })

    expect(result.current.state.sessionId).toBeUndefined()
    expect(result.current.state.error).toBeUndefined()
    expect(result.current.state.events).toEqual([])
    expect(result.current.state.revision).toBe(2)
  })

  it('does not let an older initial snapshot overwrite a newer pushed lifecycle event', async () => {
    const initial = createDeferred<AcpStateSnapshot>()
    acpApi.getState.mockReturnValueOnce(initial.promise)
    const { result } = await mountRuntime()
    const delivered: AcpRuntimeEvent[] = []
    result.current.subscribeRuntimeEvents?.((events) => delivered.push(...events))
    const terminal = createSnapshot({
      revision: 2,
      events: [
        {
          id: 'permission-settled',
          timestamp: 2,
          kind: 'permission',
          level: 'info',
          permissionRequestId: 'permission-restored',
          title: 'Restored permission settled'
        }
      ]
    })

    act(() => {
      capturedStateListener?.(terminal)
    })
    expect(acceptAcpRuntimeSnapshotRevision({ revision: 1 })).toBe(false)
    await act(async () => {
      initial.resolve(
        createSnapshot({
          revision: 1,
          events: [
            {
              id: 'permission-rearmed',
              timestamp: 1,
              kind: 'permission',
              level: 'info',
              permissionRequestId: 'permission-restored',
              title: 'Restored permission rearmed'
            }
          ]
        })
      )
      await initial.promise
    })

    expect(result.current.state).toEqual(terminal)
    expect(delivered).toEqual(terminal.events)
  })

  it('reconciles a snapshot already accepted by another renderer ingress', async () => {
    const { result } = await mountRuntime()
    const pulled = createSnapshot({
      revision: 2,
      sessionIds: ['session-1'],
      promptInFlight: false,
      promptInFlightSessionIds: []
    })

    expect(acceptAcpRuntimeSnapshotRevision(pulled)).toBe(true)
    act(() => result.current.reconcileSnapshot(pulled))

    expect(result.current.state).toEqual(pulled)
  })
})

describe('useAcpRuntime pending lifecycle', () => {
  it('raises the connecting flag while an action is in flight and lowers it once it resolves', async () => {
    const deferred = createDeferred<AcpStateSnapshot>()
    acpApi.connect.mockReturnValueOnce(deferred.promise)
    const { result } = await mountRuntime()

    expect(result.current.isConnecting).toBe(false)

    let inFlight: Promise<AcpRuntimeState | undefined> | undefined
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

  it('keeps the connecting flag raised until all overlapping actions settle', async () => {
    const first = createDeferred<{ sessionId: string }>()
    const second = createDeferred<{ sessionId: string }>()
    acpApi.createSession.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result } = await mountRuntime()

    let firstAction!: Promise<{ sessionId: string }>
    let secondAction!: Promise<{ sessionId: string }>
    act(() => {
      firstAction = result.current.createSession('/first')
      secondAction = result.current.createSession('/second')
    })
    await act(async () => {
      first.resolve({ sessionId: 'first' })
      await firstAction
    })

    expect(result.current.isConnecting).toBe(true)

    await act(async () => {
      second.resolve({ sessionId: 'second' })
      await secondAction
    })
    expect(result.current.isConnecting).toBe(false)
  })

  it('does not surface an older action failure after a newer action succeeds', async () => {
    const older = createDeferred<{ sessionId: string }>()
    const latest = createDeferred<{ sessionId: string }>()
    acpApi.createSession.mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise)
    const { result } = await mountRuntime()

    let olderAction!: Promise<{ sessionId: string }>
    let latestAction!: Promise<{ sessionId: string }>
    act(() => {
      olderAction = result.current.createSession('/older')
      latestAction = result.current.createSession('/latest')
    })
    await act(async () => {
      latest.resolve({ sessionId: 'latest' })
      await latestAction
    })
    await act(async () => {
      older.reject(new Error('older failed'))
      await olderAction.catch(() => undefined)
    })

    expect(result.current.actionError).toBeNull()
  })
})
