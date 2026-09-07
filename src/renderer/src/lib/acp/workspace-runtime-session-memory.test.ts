import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionSizeLimitError } from '../../../../shared/session-persistence'
import { useSessionStore, type ChatSession } from '../../stores/session-store'
import { createWorkspaceRuntimeSessionLifecycleOwner } from './workspace-runtime-session-lifecycle-owner'
import { reconfigureWorkspaceMemory } from './workspace-runtime-session-memory-owner'

const deferred = <Value>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const session = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Memory session',
  cwd: '/workspace',
  status: 'idle',
  permissionProfile: 'ask',
  memoryEnabled: true,
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('workspace Session Memory reconfiguration', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [session()], selectedSessionId: 'session-1' })
  })

  it('persists the preference, replaces live capabilities, and schedules history replay', async () => {
    const flush = vi.fn(async () => undefined)
    const resetSessionContext = vi.fn(async () => ({
      sessionId: 'session-1',
      providerSessionId: 'provider-replacement',
      providerContinuityToken: 'continuity-replacement'
    }))

    await reconfigureWorkspaceMemory(
      {
        state: { sessionIds: ['session-1'], cwd: '/workspace' },
        resetSessionContext
      } as never,
      'session-1',
      false,
      flush
    )

    expect(resetSessionContext).toHaveBeenCalledWith(
      'session-1',
      '/workspace',
      'project-1',
      'ask',
      false
    )
    expect(flush).toHaveBeenCalledTimes(2)
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      memoryEnabled: false,
      providerSessionId: 'provider-replacement',
      providerContinuityToken: 'continuity-replacement',
      pendingHistoryReplay: { kind: 'all' }
    })
  })

  it('rolls back the preference when capability replacement fails', async () => {
    const flush = vi.fn(async () => undefined)
    const failure = new Error('reset failed')

    await expect(
      reconfigureWorkspaceMemory(
        {
          state: { sessionIds: ['session-1'], cwd: '/workspace' },
          resetSessionContext: vi.fn(async () => {
            throw failure
          })
        } as never,
        'session-1',
        false,
        flush
      )
    ).rejects.toBe(failure)

    expect(useSessionStore.getState().sessions[0]?.memoryEnabled).toBe(true)
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('does not replace live capabilities when the preference cannot be persisted', async () => {
    const failure = new Error('disk full')
    const persist = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined)
    const resetSessionContext = vi.fn()

    await expect(
      reconfigureWorkspaceMemory(
        {
          state: { sessionIds: ['session-1'], cwd: '/workspace' },
          resetSessionContext
        } as never,
        'session-1',
        false,
        persist
      )
    ).rejects.toBe(failure)

    expect(resetSessionContext).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0]?.memoryEnabled).toBe(true)
    expect(persist).toHaveBeenCalledTimes(2)
  })

  it('reports a size-limit failure while persisting the preference', async () => {
    const failure = new SessionSizeLimitError()
    const persist = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined)
    const onSessionSizeLimit = vi.fn()

    await expect(
      reconfigureWorkspaceMemory(
        {
          state: { sessionIds: ['session-1'], cwd: '/workspace' },
          resetSessionContext: vi.fn()
        } as never,
        'session-1',
        false,
        persist,
        undefined,
        onSessionSizeLimit
      )
    ).rejects.toBe(failure)

    expect(onSessionSizeLimit).toHaveBeenCalledWith('session-1')
  })

  it('serializes rapid changes so the last conversation preference owns the capabilities', async () => {
    const firstReset = deferred<{
      sessionId: string
      providerSessionId: string
      providerContinuityToken: string
    }>()
    const resetSessionContext = vi
      .fn()
      .mockImplementationOnce(() => firstReset.promise)
      .mockResolvedValueOnce({
        sessionId: 'session-1',
        providerSessionId: 'provider-enabled',
        providerContinuityToken: 'continuity-enabled'
      })
    const runtime = {
      state: { sessionIds: ['session-1'], cwd: '/workspace' },
      resetSessionContext
    } as never
    const preparationChanged = vi.fn()
    const flush = vi.fn(async () => undefined)
    const owner = createWorkspaceRuntimeSessionLifecycleOwner()

    const disabled = owner.reconfigureMemory(runtime, 'session-1', false, preparationChanged, flush)
    const enabled = owner.reconfigureMemory(runtime, 'session-1', true, preparationChanged, flush)

    await vi.waitFor(() => expect(resetSessionContext).toHaveBeenCalledTimes(1))
    firstReset.resolve({
      sessionId: 'session-1',
      providerSessionId: 'provider-disabled',
      providerContinuityToken: 'continuity-disabled'
    })
    await Promise.all([disabled, enabled])

    expect(resetSessionContext.mock.calls.map((call) => call[4])).toEqual([false, true])
    expect(useSessionStore.getState().sessions[0]?.memoryEnabled).toBe(true)
    expect(preparationChanged.mock.calls).toEqual([
      ['session-1', true],
      ['session-1', false],
      ['session-1', true],
      ['session-1', false]
    ])
  })
})
