import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentTurnProvenanceContext } from '../../../../shared/elicitation'
import { SessionSizeLimitError } from '../../../../shared/session-persistence'
import { toPersistedSession, useSessionStore, type ChatSession } from '../../stores/session-store'
import { sendWorkspaceMessage } from './workspace-runtime-command-owner'
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

  it('persists a fresh Runtime Segment before the next real workspace prompt uses it', async () => {
    useSessionStore.setState({
      sessions: [
        session({
          agentFrameworkId: 'codex',
          agentBackendId: 'codex:provider-1',
          providerSessionId: 'provider-original'
        })
      ],
      selectedSessionId: 'session-1'
    })
    const persisted: ReturnType<typeof toPersistedSession>[] = []
    const persist = vi.fn(async (sessionId: string) => {
      const current = useSessionStore
        .getState()
        .sessions.find((candidate) => candidate.id === sessionId)
      if (!current) throw new Error(`Session not found: ${sessionId}`)
      persisted.push(toPersistedSession(current))
    })
    const sendPrompt = vi.fn((...args: unknown[]) => {
      void args
      return Promise.resolve({ sessionIds: ['session-1'] })
    })
    const runtime = {
      state: {
        sessionIds: ['session-1'],
        cwd: '/workspace',
        events: [],
        pendingPermissions: [],
        promptInFlightSessionIds: []
      },
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      resetSessionContext: vi.fn(async () => ({
        sessionId: 'session-1',
        frameworkId: 'codex',
        backendId: 'codex:provider-1',
        providerSessionId: 'provider-replacement',
        providerContinuityToken: 'continuity-replacement',
        contextReset: true
      })),
      sendPrompt
    }

    await reconfigureWorkspaceMemory(runtime as never, 'session-1', false, persist)

    const previousRuntimeSegmentId = persisted[0]?.conversationGraph?.runtimeSegments.at(-1)?.id
    const resetSnapshot = persisted.at(-1)
    const resetRuntimeSegmentId = resetSnapshot?.conversationGraph?.runtimeSegments.at(-1)?.id
    expect(resetRuntimeSegmentId).toEqual(expect.any(String))
    expect(resetRuntimeSegmentId).not.toBe(previousRuntimeSegmentId)
    expect(resetSnapshot).toMatchObject({
      providerSessionId: 'provider-replacement',
      pendingHistoryReplay: { kind: 'all' }
    })

    const sent = await sendWorkspaceMessage(
      runtime as never,
      {
        sessionId: 'session-1',
        text: 'Continue after Memory reset',
        cwd: '/workspace',
        projectId: 'project-1',
        agentFrameworkId: 'codex',
        agentBackendId: 'codex:provider-1'
      },
      { flushPersistence: () => persist('session-1') }
    )

    expect(useSessionStore.getState().sessions[0]?.error).toBeUndefined()
    expect(sent).toEqual({ sessionId: 'session-1', messageId: expect.any(String) })
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledOnce())
    const provenance = sendPrompt.mock.calls[0]?.[9] as AgentTurnProvenanceContext | undefined
    expect(provenance).toMatchObject({ runtimeSegmentId: resetRuntimeSegmentId })
    expect(
      resetSnapshot?.conversationGraph?.runtimeSegments.some(
        (segment) => segment.id === provenance?.runtimeSegmentId
      )
    ).toBe(true)
    expect(
      persisted
        .at(-1)
        ?.conversationGraph?.messages.some(
          (message) =>
            message.id === provenance?.promptMessageId &&
            message.runtimeSegmentId === provenance?.runtimeSegmentId
        )
    ).toBe(true)
    expect(persist.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      sendPrompt.mock.invocationCallOrder[0]!
    )
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
