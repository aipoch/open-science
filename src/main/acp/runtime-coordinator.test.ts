import { describe, expect, it, vi } from 'vitest'

import type { AcpPermissionRequest, AcpRuntimeEvent, AcpStateSnapshot } from '../../shared/acp'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import type { AcpRuntime, AcpRuntimeCallbacks } from './runtime'

const createDeferred = <Value = void>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

const emptySnapshot = (): AcpStateSnapshot => ({
  status: 'connected',
  cwd: '/workspace',
  sessionIds: [],
  events: [],
  pendingPermissions: [],
  permissionProfiles: {},
  permissionGrants: {},
  promptInFlight: false,
  promptInFlightSessionIds: []
})

const createFakeRuntime = (options: {
  frameworkId: 'claude-code' | 'codex'
  sessionIds: string[]
  callbacks: AcpRuntimeCallbacks
  prompt?: (sessionId: string) => Promise<unknown>
}): {
  runtime: AcpRuntime
  disconnect: ReturnType<typeof vi.fn>
  requestRetirement: ReturnType<typeof vi.fn>
  requestProviderReconnect: ReturnType<typeof vi.fn>
  requestSkillsReload: ReturnType<typeof vi.fn>
  applyReasoningEffortChange: ReturnType<typeof vi.fn>
  respondToPermission: ReturnType<typeof vi.fn>
  emitEvent: (event: AcpRuntimeEvent) => void
  emitPermission: (request: AcpPermissionRequest) => void
  emitState: (overrides: Partial<AcpStateSnapshot>) => void
} => {
  let snapshot = emptySnapshot()
  let sessionIndex = 0
  const disconnect = vi.fn(async () => snapshot)
  const requestRetirement = vi.fn(async () => undefined)
  const requestProviderReconnect = vi.fn(async () => undefined)
  const requestSkillsReload = vi.fn(async () => undefined)
  const applyReasoningEffortChange = vi.fn(async () => true)
  const respondToPermission = vi.fn(() => snapshot)
  const shutdownForQuit = vi.fn(async () => ({ reaped: true }))
  const shutdownForUpdateGate = vi.fn(async () => ({ reaped: true }))
  const sendPrompt = vi.fn(async ({ sessionId }: { sessionId: string }) => {
    snapshot = {
      ...snapshot,
      promptInFlight: true,
      promptInFlightSessionIds: [...snapshot.promptInFlightSessionIds, sessionId]
    }
    options.callbacks.onStateChanged?.(snapshot)

    try {
      return await (options.prompt
        ? options.prompt(sessionId)
        : Promise.resolve({ stopReason: 'end_turn' }))
    } finally {
      snapshot = {
        ...snapshot,
        promptInFlight: false,
        promptInFlightSessionIds: snapshot.promptInFlightSessionIds.filter(
          (candidate) => candidate !== sessionId
        )
      }
      options.callbacks.onStateChanged?.(snapshot)
    }
  })
  const runtime = {
    getSnapshot: () => snapshot,
    getActivePromptSessions: () => [],
    getActiveArtifactRunIds: () => [],
    createSession: vi.fn(async () => {
      const sessionId = options.sessionIds[sessionIndex]
      sessionIndex += 1
      snapshot = { ...snapshot, sessionId, sessionIds: [...snapshot.sessionIds, sessionId] }
      options.callbacks.onStateChanged?.(snapshot)
      return { sessionId, cwd: '/workspace', frameworkId: options.frameworkId }
    }),
    resumeSession: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      snapshot = {
        ...snapshot,
        sessionId,
        sessionIds: snapshot.sessionIds.includes(sessionId)
          ? snapshot.sessionIds
          : [...snapshot.sessionIds, sessionId]
      }
      options.callbacks.onStateChanged?.(snapshot)
      return { sessionId, cwd: '/workspace', frameworkId: options.frameworkId, contextReset: true }
    }),
    sendPrompt,
    withActivity: vi.fn(
      async (_activityOptions: unknown, work: (scopedRuntime: AcpRuntime) => Promise<unknown>) =>
        work(runtime)
    ),
    buildReviewerSession: vi.fn(async () => ({
      session: { sessionId: `reviewer-${options.frameworkId}` }
    })),
    disposeReviewerSession: vi.fn(() => ({
      rejectedToolCalls: 0,
      reviewerBridgeScoped: undefined
    })),
    disconnect,
    requestRetirement,
    requestProviderReconnect,
    requestSkillsReload,
    applyReasoningEffortChange,
    respondToPermission,
    shutdownForQuit,
    shutdownForUpdateGate
  } as unknown as AcpRuntime

  return {
    runtime,
    disconnect,
    requestRetirement,
    requestProviderReconnect,
    requestSkillsReload,
    applyReasoningEffortChange,
    respondToPermission,
    emitEvent: (event) => {
      snapshot = { ...snapshot, events: [...snapshot.events, event] }
      options.callbacks.onEvent?.(event)
      options.callbacks.onStateChanged?.(snapshot)
    },
    emitPermission: (request) => {
      snapshot = { ...snapshot, pendingPermissions: [...snapshot.pendingPermissions, request] }
      options.callbacks.onPermissionRequest?.(request)
      options.callbacks.onStateChanged?.(snapshot)
    },
    emitState: (overrides) => {
      snapshot = { ...snapshot, ...overrides }
      options.callbacks.onStateChanged?.(snapshot)
    }
  }
}

describe('AcpRuntimeCoordinator', () => {
  it('keeps reconnecting settings on the active generation and fans out live effort', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: created.length === 0 ? 'claude-code' : 'codex',
        sessionIds: [`session-${created.length + 1}`],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })

    await coordinator.createSession()
    await coordinator.requestAgentFrameworkSwitch()
    created[0].applyReasoningEffortChange.mockResolvedValue(false)
    await coordinator.requestProviderReconnect()
    await coordinator.requestSkillsReload()
    await expect(coordinator.applyReasoningEffortChange('high')).resolves.toBe(true)

    expect(created).toHaveLength(2)
    expect(created[0].requestProviderReconnect).not.toHaveBeenCalled()
    expect(created[0].requestSkillsReload).not.toHaveBeenCalled()
    expect(created[0].applyReasoningEffortChange).toHaveBeenCalledWith('high')
    expect(created[1].requestProviderReconnect).toHaveBeenCalledOnce()
    expect(created[1].requestSkillsReload).toHaveBeenCalledOnce()
    expect(created[1].applyReasoningEffortChange).toHaveBeenCalledWith('high')
  })

  it('keeps the active effort result when a retiring generation rejects', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: created.length === 0 ? 'claude-code' : 'codex',
        sessionIds: [`session-${created.length + 1}`],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })

    await coordinator.createSession()
    await coordinator.requestAgentFrameworkSwitch()
    await coordinator.createSession()
    created[0].applyReasoningEffortChange.mockRejectedValue(new Error('old effort failed'))

    await expect(coordinator.applyReasoningEffortChange('high')).resolves.toBe(true)
    expect(created[1].applyReasoningEffortChange).toHaveBeenCalledWith('high')
  })

  it('attempts every runtime disconnect before surfacing a partial failure', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: created.length === 0 ? 'claude-code' : 'codex',
        sessionIds: [`session-${created.length + 1}`],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })

    await coordinator.createSession()
    await coordinator.requestAgentFrameworkSwitch()
    await coordinator.createSession()
    const activeDisconnect = createDeferred<AcpStateSnapshot>()
    created[0].disconnect.mockRejectedValueOnce(new Error('old disconnect failed'))
    created[1].disconnect.mockReturnValueOnce(activeDisconnect.promise)

    let settled = false
    const disconnecting = coordinator.disconnect().finally(() => {
      settled = true
    })
    void disconnecting.catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(settled).toBe(false)
    expect(created[0].disconnect).toHaveBeenCalledOnce()
    expect(created[1].disconnect).toHaveBeenCalledOnce()
    activeDisconnect.resolve(emptySnapshot())
    await expect(disconnecting).rejects.toThrow('old disconnect failed')
  })

  it('attempts every runtime quit teardown before surfacing a partial failure', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: created.length === 0 ? 'claude-code' : 'codex',
        sessionIds: [`session-${created.length + 1}`],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })

    await coordinator.createSession()
    await coordinator.requestAgentFrameworkSwitch()
    await coordinator.createSession()
    const activeShutdown = createDeferred<{ reaped: boolean }>()
    vi.mocked(created[0].runtime.shutdownForQuit).mockRejectedValueOnce(
      new Error('old shutdown failed')
    )
    vi.mocked(created[1].runtime.shutdownForQuit).mockReturnValueOnce(activeShutdown.promise)

    let settled = false
    const shuttingDown = coordinator.shutdownForQuit().finally(() => {
      settled = true
    })
    void shuttingDown.catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(settled).toBe(false)
    expect(created[0].runtime.shutdownForQuit).toHaveBeenCalledOnce()
    expect(created[1].runtime.shutdownForQuit).toHaveBeenCalledOnce()
    activeShutdown.resolve({ reaped: true })
    await expect(shuttingDown).rejects.toThrow('old shutdown failed')
  })

  it('runs new sessions immediately and moves the old session after its active turn', async () => {
    const oldPrompt = createDeferred<{ stopReason: string }>()
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime(
        created.length === 0
          ? {
              frameworkId: 'claude-code',
              sessionIds: ['old-session'],
              callbacks,
              prompt: () => oldPrompt.promise
            }
          : { frameworkId: 'codex', sessionIds: ['new-session-1', 'new-session-2'], callbacks }
      )
      created.push(fake)
      return fake.runtime
    })

    const oldSession = await coordinator.createSession({ cwd: '/workspace' })
    const oldTurn = coordinator.sendPrompt({ sessionId: oldSession.sessionId, text: 'use a tool' })

    await coordinator.requestAgentFrameworkSwitch()
    const newSessions = await Promise.all([
      coordinator.createSession({ cwd: '/workspace' }),
      coordinator.createSession({ cwd: '/workspace' })
    ])
    await expect(
      coordinator.sendPrompt({ sessionId: newSessions[0].sessionId, text: 'new conversation' })
    ).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(newSessions.map((session) => session.frameworkId)).toEqual(['codex', 'codex'])
    expect(created).toHaveLength(2)
    expect(created[0].requestRetirement).toHaveBeenCalledOnce()
    expect(created[0].requestProviderReconnect).not.toHaveBeenCalled()
    expect(created[0].disconnect).not.toHaveBeenCalled()
    expect(coordinator.getSnapshot().sessionIds).toEqual([
      'old-session',
      'new-session-1',
      'new-session-2'
    ])

    oldPrompt.resolve({ stopReason: 'end_turn' })
    await expect(oldTurn).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(coordinator.getSnapshot().sessionIds).toEqual(['new-session-1', 'new-session-2'])

    await coordinator.resumeSession({
      sessionId: oldSession.sessionId,
      cwd: '/workspace',
      previousFrameworkId: 'claude-code'
    })
    await expect(
      coordinator.sendPrompt({ sessionId: oldSession.sessionId, text: 'continue on Codex' })
    ).resolves.toMatchObject({ stopReason: 'end_turn' })

    expect(vi.mocked(created[0].runtime.sendPrompt)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(created[1].runtime.resumeSession)).toHaveBeenCalledWith({
      sessionId: 'old-session',
      cwd: '/workspace',
      previousFrameworkId: 'claude-code'
    })
    expect(vi.mocked(created[1].runtime.sendPrompt)).toHaveBeenCalledWith({
      sessionId: 'old-session',
      text: 'continue on Codex'
    })
  })

  it('namespaces events and routes permission responses to their owning runtime', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const forwardedEvents: AcpRuntimeEvent[] = []
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) => {
        const fake = createFakeRuntime({
          frameworkId: created.length === 0 ? 'claude-code' : 'codex',
          sessionIds: [`session-${created.length + 1}`],
          callbacks
        })
        created.push(fake)
        return fake.runtime
      },
      { onEvent: (event) => forwardedEvents.push(event) }
    )

    await coordinator.createSession()
    await coordinator.requestAgentFrameworkSwitch()
    expect(coordinator.getSnapshot().sessionIds).toEqual([])
    await coordinator.createSession()

    const event = (sessionId: string): AcpRuntimeEvent => ({
      id: 'acp-event-1',
      timestamp: 1,
      kind: 'system',
      level: 'info',
      sessionId,
      title: 'event'
    })
    created[0].emitEvent(event('session-1'))
    created[1].emitEvent(event('session-2'))

    expect(forwardedEvents.map((item) => item.id)).toEqual([
      'runtime-1:acp-event-1',
      'runtime-2:acp-event-1'
    ])
    expect(coordinator.getSnapshot().events.map((item) => item.id)).toEqual([
      'runtime-1:acp-event-1',
      'runtime-2:acp-event-1'
    ])

    const permission: AcpPermissionRequest = {
      requestId: 'permission-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      title: 'Run tool',
      options: [],
      raw: {}
    }
    created[0].emitPermission(permission)
    expect(coordinator.getSnapshot().sessionIds).toContain('session-1')
    coordinator.respondToPermission({ requestId: permission.requestId, cancelled: true })

    expect(created[0].respondToPermission).toHaveBeenCalledWith({
      requestId: 'permission-1',
      cancelled: true
    })
    expect(created[1].respondToPermission).not.toHaveBeenCalled()
  })

  it('pins each activity workflow to the runtime generation active when it starts', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: created.length === 0 ? 'claude-code' : 'codex',
        sessionIds: [`session-${created.length + 1}`],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })
    const oldActivityStarted = createDeferred()
    const releaseOldActivity = createDeferred()

    const oldActivity = coordinator.withActivity({}, async (runtime) => {
      oldActivityStarted.resolve()
      await releaseOldActivity.promise
      await runtime.buildReviewerSession({ cwd: '/workspace', mcpServers: [] })
    })
    await oldActivityStarted.promise

    await coordinator.requestAgentFrameworkSwitch()
    await coordinator.withActivity({}, (runtime) =>
      runtime.buildReviewerSession({ cwd: '/workspace', mcpServers: [] })
    )
    releaseOldActivity.resolve()
    await oldActivity

    expect(vi.mocked(created[0].runtime.buildReviewerSession)).toHaveBeenCalledOnce()
    expect(vi.mocked(created[1].runtime.buildReviewerSession)).toHaveBeenCalledOnce()
  })

  it('lazily adopts the main session on the pinned runtime only when an activity sends a prompt', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: created.length === 0 ? 'claude-code' : 'codex',
        sessionIds: created.length === 0 ? ['old-session'] : ['unused-session'],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })
    await coordinator.createSession({ cwd: '/workspace' })
    await coordinator.requestAgentFrameworkSwitch()

    await coordinator.withActivity(
      {
        session: {
          sessionId: 'old-session',
          cwd: '/workspace',
          projectName: 'project-1',
          previousFrameworkId: 'claude-code',
          historyPreamble: 'prior transcript'
        }
      },
      async (runtime) => {
        await runtime.buildReviewerSession({ cwd: '/workspace', mcpServers: [] })
        expect(vi.mocked(created[1].runtime.resumeSession)).not.toHaveBeenCalled()
        await runtime.sendPrompt({ sessionId: 'old-session', text: '[Auditor] fix this' })
      }
    )

    expect(vi.mocked(created[1].runtime.resumeSession)).toHaveBeenCalledWith({
      sessionId: 'old-session',
      cwd: '/workspace',
      projectName: 'project-1',
      previousFrameworkId: 'claude-code'
    })
    expect(vi.mocked(created[1].runtime.sendPrompt)).toHaveBeenCalledWith({
      sessionId: 'old-session',
      text: '[Auditor] fix this',
      historyPreamble: 'prior transcript'
    })
    expect(vi.mocked(created[0].runtime.sendPrompt)).not.toHaveBeenCalled()
  })

  it('removes a runtime from aggregation after its retirement completes', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: created.length === 0 ? 'claude-code' : 'codex',
        sessionIds: [`session-${created.length + 1}`],
        callbacks
      })
      fake.requestRetirement.mockImplementation(async () => {
        callbacks.onRetired?.()
      })
      created.push(fake)
      return fake.runtime
    })

    await coordinator.createSession()
    created[0].emitEvent({
      id: 'old-event',
      timestamp: 1,
      kind: 'system',
      level: 'info',
      sessionId: 'session-1',
      title: 'old generation'
    })
    await coordinator.requestAgentFrameworkSwitch()

    expect(coordinator.getSnapshot().events).toEqual([])
    expect(coordinator.getSnapshot().sessionIds).toEqual([])
  })

  it('projects connection status from each session owning runtime', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: created.length === 0 ? 'claude-code' : 'codex',
        sessionIds: [`session-${created.length + 1}`],
        callbacks
      })
      fake.requestRetirement.mockImplementation(async () => callbacks.onRetired?.())
      created.push(fake)
      return fake.runtime
    })

    await coordinator.createSession()
    created[0].emitState({ status: 'error', error: 'old runtime failed' })
    await coordinator.requestAgentFrameworkSwitch()
    await coordinator.createSession()

    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'connected',
      sessionConnectionStatuses: {
        'session-1': 'error',
        'session-2': 'connected'
      }
    })
  })
})
