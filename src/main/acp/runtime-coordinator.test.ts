import { describe, expect, it, vi } from 'vitest'

import type {
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpRuntimeEvent,
  AcpStateSnapshot
} from '../../shared/acp'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import type { AcpRuntime, AcpRuntimeCallbacks } from './runtime'
import type { ConversationPermissionGrantStore } from './permission-broker'
import type { AgentModelChangeTarget } from '../agent-framework'

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
  contextUsageBySession: {},
  promptInFlight: false,
  promptInFlightSessionIds: []
})

const runtimeEventId = (runtimeSequence: number, eventId: string): RegExp =>
  new RegExp(`^runtime-${runtimeSequence}-[0-9a-f-]{36}:${eventId}$`, 'u')

const createFakeRuntime = (options: {
  frameworkId: 'claude-code' | 'opencode' | 'codex'
  sessionIds: string[]
  callbacks: AcpRuntimeCallbacks
  permissionGrantStore?: ConversationPermissionGrantStore
  beforePromptStart?: () => Promise<void>
  beforeProviderPromptAccepted?: () => Promise<void>
  beforeReviewerSession?: () => Promise<void>
  beforeResume?: () => Promise<void>
  afterResumeAttached?: () => Promise<void>
  eligibleAttachmentUri?: string
  prompt?: (sessionId: string) => Promise<unknown>
}): {
  runtime: AcpRuntime
  connect: ReturnType<typeof vi.fn>
  createSession: ReturnType<typeof vi.fn>
  resetSessionContext: ReturnType<typeof vi.fn>
  switchSpecialist: ReturnType<typeof vi.fn>
  compactSession: ReturnType<typeof vi.fn>
  resumeSession: ReturnType<typeof vi.fn>
  cancelPrompt: ReturnType<typeof vi.fn>
  deleteSession: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  requestRetirement: ReturnType<typeof vi.fn>
  requestProviderReconnect: ReturnType<typeof vi.fn>
  sendPrompt: ReturnType<typeof vi.fn>
  sendAppContinuation: ReturnType<typeof vi.fn>
  applyReasoningEffortChange: ReturnType<typeof vi.fn>
  applyModelChange: ReturnType<typeof vi.fn>
  respondToPermission: ReturnType<typeof vi.fn>
  requestUserInput: ReturnType<typeof vi.fn>
  emitEvent: (event: AcpRuntimeEvent) => void
  emitPermission: (request: AcpPermissionRequest) => void
  emitState: (overrides: Partial<AcpStateSnapshot>) => void
  setStateSilently: (overrides: Partial<AcpStateSnapshot>) => void
  emitRetired: () => void
} => {
  let snapshot = emptySnapshot()
  let sessionIndex = 0
  let turnSequence = 0
  const sessionProjects = new Map<string, string>()
  const connect = vi.fn(async () => snapshot)
  const createSession = vi.fn(async (request: { projectName?: string } = {}) => {
    const sessionId = options.sessionIds[sessionIndex]
    sessionIndex += 1
    sessionProjects.set(sessionId, request.projectName ?? 'Artifacts')
    snapshot = { ...snapshot, sessionId, sessionIds: [...snapshot.sessionIds, sessionId] }
    options.callbacks.onStateChanged?.(snapshot)
    return { sessionId, cwd: '/workspace', frameworkId: options.frameworkId }
  })
  const resumeSession = vi.fn(
    async ({ sessionId, projectName }: { sessionId: string; projectName?: string }) => {
      await options.beforeResume?.()
      sessionProjects.set(sessionId, projectName ?? 'Artifacts')
      snapshot = {
        ...snapshot,
        sessionId,
        sessionIds: snapshot.sessionIds.includes(sessionId)
          ? snapshot.sessionIds
          : [...snapshot.sessionIds, sessionId]
      }
      options.callbacks.onStateChanged?.(snapshot)
      await options.afterResumeAttached?.()
      return { sessionId, cwd: '/workspace', frameworkId: options.frameworkId, contextReset: true }
    }
  )
  const resetSessionContext = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
    sessionId,
    cwd: '/workspace',
    frameworkId: options.frameworkId,
    contextReset: true
  }))
  const switchSpecialist = vi.fn(async () => ({ contextReset: false }))
  const compactSession = vi.fn(async () => ({ stopReason: 'end_turn' }))
  const cancelPrompt = vi.fn(async () => snapshot)
  const deleteSession = vi.fn(async ({ sessionId }: { sessionId: string }) => {
    sessionProjects.delete(sessionId)
    snapshot = {
      ...snapshot,
      sessionId: snapshot.sessionId === sessionId ? undefined : snapshot.sessionId,
      sessionIds: snapshot.sessionIds.filter((candidate) => candidate !== sessionId)
    }
    options.callbacks.onStateChanged?.(snapshot)
    return snapshot
  })
  const disconnect = vi.fn(async () => snapshot)
  const requestRetirement = vi.fn(async () => undefined)
  const requestProviderReconnect = vi.fn(async () => undefined)
  const applyReasoningEffortChange = vi.fn(async () => true)
  const applyModelChange = vi.fn(async () => true)
  const respondToPermission = vi.fn((response: AcpPermissionResponse) => {
    options.callbacks.onPermissionSettled?.(
      response.requestId,
      response.cancelled ? 'cancelled' : 'resolved'
    )
    return snapshot
  })
  const requestUserInput = vi.fn(async () => ({ action: 'answered', answer: 'Minimal' }))
  const shutdown = vi.fn()
  const shutdownForQuit = vi.fn(async () => ({ reaped: true }))
  const shutdownForUpdateGate = vi.fn(async () => ({ reaped: true }))
  const runPrompt = async (
    { sessionId }: { sessionId: string },
    promptAttemptId?: string
  ): Promise<unknown> => {
    await options.beforePromptStart?.()
    const turnToken = `turn-${++turnSequence}`
    snapshot = {
      ...snapshot,
      promptInFlight: true,
      promptInFlightSessionIds: [...snapshot.promptInFlightSessionIds, sessionId]
    }
    options.callbacks.onPromptStarted?.(sessionId, turnToken, promptAttemptId)
    if (options.eligibleAttachmentUri) {
      options.callbacks.onSkillImportAttachmentEligible?.(
        sessionId,
        turnToken,
        options.eligibleAttachmentUri
      )
    }
    options.callbacks.onStateChanged?.(snapshot)

    try {
      const prompt = options.prompt
        ? options.prompt(sessionId)
        : Promise.resolve({ stopReason: 'end_turn' })
      await options.beforeProviderPromptAccepted?.()
      options.callbacks.onProviderPromptAccepted?.(sessionId, promptAttemptId)
      return await prompt
    } finally {
      options.callbacks.onPromptEnded?.(sessionId, turnToken)
      snapshot = {
        ...snapshot,
        promptInFlight: false,
        promptInFlightSessionIds: snapshot.promptInFlightSessionIds.filter(
          (candidate) => candidate !== sessionId
        )
      }
      options.callbacks.onStateChanged?.(snapshot)
    }
  }
  const sendPrompt = vi.fn(runPrompt)
  const sendAppContinuation = vi.fn(runPrompt)
  const runtime = {
    getSnapshot: () => snapshot,
    getActivePromptSessions: () => [],
    hasLiveSession: (projectId: string, sessionId: string) =>
      snapshot.sessionIds.includes(sessionId) && sessionProjects.get(sessionId) === projectId,
    liveSessionProjectId: (sessionId: string) => sessionProjects.get(sessionId),
    getActiveArtifactRunIds: () => [],
    connect,
    createSession,
    resumeSession,
    resetSessionContext,
    switchSpecialist,
    compactSession,
    cancelPrompt,
    deleteSession,
    revokePermissionGrant: vi.fn(
      ({ sessionId, categoryKey }: { sessionId: string; categoryKey: string }) => {
        options.permissionGrantStore?.revoke(sessionId, categoryKey)
        options.callbacks.onStateChanged?.(snapshot)
        return snapshot
      }
    ),
    sendPrompt,
    sendAppContinuation,
    withActivity: vi.fn(
      async (_activityOptions: unknown, work: (scopedRuntime: AcpRuntime) => Promise<unknown>) =>
        work(runtime)
    ),
    buildReviewerSession: vi.fn(async () => {
      await options.beforeReviewerSession?.()
      return { session: { sessionId: `reviewer-${options.frameworkId}` } }
    }),
    disposeReviewerSession: vi.fn(() => ({
      rejectedToolCalls: 0,
      reviewerBridgeScoped: undefined
    })),
    disconnect,
    requestRetirement,
    requestProviderReconnect,
    applyReasoningEffortChange,
    applyModelChange,
    respondToPermission,
    requestUserInput,
    shutdown,
    shutdownForQuit,
    shutdownForUpdateGate
  } as unknown as AcpRuntime

  return {
    runtime,
    connect,
    createSession,
    resetSessionContext,
    switchSpecialist,
    compactSession,
    resumeSession,
    cancelPrompt,
    deleteSession,
    disconnect,
    requestRetirement,
    requestProviderReconnect,
    sendPrompt,
    sendAppContinuation,
    applyReasoningEffortChange,
    applyModelChange,
    respondToPermission,
    requestUserInput,
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
    },
    setStateSilently: (overrides) => {
      snapshot = { ...snapshot, ...overrides }
    },
    emitRetired: () => options.callbacks.onRetired?.()
  }
}

describe('AcpRuntimeCoordinator', () => {
  it.each([
    ['Claude Code', 'claude-code'],
    ['OpenCode', 'opencode'],
    ['Codex shared runtime', 'codex']
  ] as const)(
    'observes provider acceptance through %s without changing completion',
    async (_route, frameworkId) => {
      const coordinator = new AcpRuntimeCoordinator(
        (callbacks) =>
          createFakeRuntime({ frameworkId, sessionIds: ['session-1'], callbacks }).runtime
      )
      const session = await coordinator.createSession()
      const onProviderPromptAccepted = vi.fn()

      await coordinator.sendPromptObserved(
        { sessionId: session.sessionId, text: 'Research this.' },
        onProviderPromptAccepted
      )

      expect(onProviderPromptAccepted).toHaveBeenCalledOnce()
    }
  )

  it('does not report provider acceptance when dispatch fails before acceptance', async () => {
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) =>
        createFakeRuntime({
          frameworkId: 'codex',
          sessionIds: ['session-1'],
          callbacks,
          beforeProviderPromptAccepted: async () => {
            throw new Error('provider rejected before acceptance')
          }
        }).runtime
    )
    const session = await coordinator.createSession()
    const onProviderPromptAccepted = vi.fn()

    await expect(
      coordinator.sendPromptObserved(
        { sessionId: session.sessionId, text: 'Research this.' },
        onProviderPromptAccepted
      )
    ).rejects.toThrow('provider rejected before acceptance')

    expect(onProviderPromptAccepted).not.toHaveBeenCalled()
  })

  it('retains a sanitized app-visible Specialist handoff failure until session deletion', async () => {
    const forwardedEvents: AcpRuntimeEvent[] = []
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) => {
        const fake = createFakeRuntime({
          frameworkId: 'codex',
          sessionIds: ['session-1'],
          callbacks
        })
        created.push(fake)
        return fake.runtime
      },
      { onEvent: (event) => forwardedEvents.push(event) }
    )
    const session = await coordinator.createSession()

    coordinator.publishHandoffFailure({
      sessionId: session.sessionId,
      targetName: 'New Specialist',
      generation: 3,
      failedPhase: 'continuation-startup'
    })

    expect(forwardedEvents).toEqual([
      expect.objectContaining({
        kind: 'error',
        level: 'error',
        sessionId: 'session-1',
        title: 'Specialist handoff failed',
        status: 'failed',
        handoffFailure: {
          targetName: 'New Specialist',
          generation: 3,
          failedPhase: 'continuation-startup',
          retryable: true
        }
      })
    ])
    expect(forwardedEvents[0].raw).toBeUndefined()
    expect(coordinator.getSnapshot().events).toContainEqual(forwardedEvents[0])

    await coordinator.deleteSession({ sessionId: session.sessionId })

    expect(coordinator.getSnapshot().events).not.toContainEqual(forwardedEvents[0])
  })

  it('recognizes a live session only under its owning project', async () => {
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) =>
        createFakeRuntime({
          frameworkId: 'claude-code',
          sessionIds: ['session-1'],
          callbacks
        }).runtime
    )
    const session = await coordinator.createSession({ projectName: 'project-1' })

    expect(coordinator.hasLiveSession('project-1', session.sessionId)).toBe(true)
    expect(coordinator.hasLiveSession('project-2', session.sessionId)).toBe(false)
    expect(coordinator.liveSessionProjectId(session.sessionId)).toBe('project-1')

    await coordinator.deleteSession({ sessionId: session.sessionId })
    expect(coordinator.hasLiveSession('project-1', session.sessionId)).toBe(false)
    expect(coordinator.liveSessionProjectId(session.sessionId)).toBeUndefined()
  })

  it('forwards switchSpecialist to the owning runtime and returns its contextReset flag', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: 'claude-code',
        sessionIds: [`session-${created.length + 1}`],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })
    const session = await coordinator.createSession()

    const result = await coordinator.switchSpecialist(session.sessionId, 'sp-b')

    expect(created[0].switchSpecialist).toHaveBeenCalledWith(session.sessionId, 'sp-b')
    expect(result).toEqual({ contextReset: false })
  })

  it('routes app-owned continuations through the dedicated runtime operation', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: 'claude-code',
        sessionIds: ['session-1'],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })
    const session = await coordinator.createSession()
    const request = {
      sessionId: session.sessionId,
      text: 'internal continuation',
      provenanceContext: { promptMessageId: 'origin-message-1' }
    }

    await coordinator.sendAppContinuation(request)

    expect(created[0].sendAppContinuation).toHaveBeenCalledWith(request, 'prompt-attempt-1')
    expect(created[0].sendPrompt).not.toHaveBeenCalled()
  })

  it('acknowledges prompt ownership release only after the owning runtime publishes drain', async () => {
    const promptResult = createDeferred<{ stopReason: 'end_turn' }>()
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) =>
        createFakeRuntime({
          frameworkId: 'codex',
          sessionIds: ['session-1'],
          callbacks,
          prompt: () => promptResult.promise
        }).runtime
    )
    const session = await coordinator.createSession()
    const prompt = coordinator.sendPrompt({ sessionId: session.sessionId, text: 'original task' })
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().promptInFlightSessionIds).toContain(session.sessionId)
    )
    let released = false
    const ownershipRelease = coordinator
      .waitForPromptOwnershipRelease(session.sessionId)
      .then(() => {
        released = true
      })
    await Promise.resolve()
    expect(released).toBe(false)

    promptResult.resolve({ stopReason: 'end_turn' })
    await prompt
    await ownershipRelease
    expect(released).toBe(true)
  })

  it('keeps the active original prompt available until its runtime releases ownership', async () => {
    const releasePrompt = createDeferred()
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) =>
        createFakeRuntime({
          frameworkId: 'codex',
          sessionIds: ['session-1'],
          callbacks,
          prompt: async () => releasePrompt.promise
        }).runtime
    )
    const session = await coordinator.createSession()
    const original = { sessionId: session.sessionId, text: 'analyse these samples' }
    const pending = coordinator.sendPrompt(original)
    await Promise.resolve()

    expect(coordinator.capturePromptForHandoff(session.sessionId)).toMatchObject({
      prompt: expect.objectContaining(original),
      originatingTurnToken: 'turn-1'
    })
    releasePrompt.resolve()
    await pending
    expect(coordinator.capturePromptForHandoff(session.sessionId)).toBeUndefined()
  })

  it('reports continuation startup only after the provider accepts it', async () => {
    const acceptProviderPrompt = createDeferred()
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) =>
        createFakeRuntime({
          frameworkId: 'codex',
          sessionIds: ['session-1'],
          callbacks,
          beforeProviderPromptAccepted: async () => acceptProviderPrompt.promise
        }).runtime
    )
    const session = await coordinator.createSession()
    let started = false
    const starting = coordinator
      .startContinuation({ sessionId: session.sessionId, text: 'continue original task' })
      .then(() => {
        started = true
      })
    await Promise.resolve()
    expect(started).toBe(false)
    acceptProviderPrompt.resolve()
    await starting
    expect(started).toBe(true)
  })

  it('routes native compaction to the session owner and publishes only owned capabilities', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: 'claude-code',
        sessionIds: [`session-${created.length + 1}`],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })
    const session = await coordinator.createSession()
    created[0].emitState({ nativeContextCompactionSessionIds: [session.sessionId, 'unowned'] })

    expect(coordinator.getSnapshot().nativeContextCompactionSessionIds).toEqual([session.sessionId])
    await coordinator.compactSession({ sessionId: session.sessionId })

    expect(created[0].compactSession).toHaveBeenCalledWith({ sessionId: session.sessionId })
  })

  it('does not run lifecycle requests after disconnect supersedes initialization', async () => {
    const initialization = createDeferred()
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) => {
        const fake = createFakeRuntime({
          frameworkId: 'claude-code',
          sessionIds: ['session-1'],
          callbacks
        })
        created.push(fake)
        return fake.runtime
      },
      {},
      '',
      initialization.promise
    )

    const pending = Promise.allSettled([
      coordinator.connect(),
      coordinator.createSession(),
      coordinator.resumeSession({ sessionId: 'session-1', cwd: '/workspace' }),
      coordinator.resetSessionContext({ sessionId: 'session-1', cwd: '/workspace' })
    ])
    await coordinator.disconnect()
    initialization.resolve()

    const outcomes = await pending
    expect(outcomes).toHaveLength(4)
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') throw new Error('Expected request to be superseded')
      expect(outcome.reason).toEqual(
        expect.objectContaining({ message: expect.stringMatching(/superseded/i) })
      )
    }
    expect(created[0].connect).not.toHaveBeenCalled()
    expect(created[0].createSession).not.toHaveBeenCalled()
    expect(created[0].resumeSession).not.toHaveBeenCalled()
    expect(created[0].resetSessionContext).not.toHaveBeenCalled()
  })

  it('does not connect after shutdown supersedes initialization', async () => {
    const initialization = createDeferred()
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const onDisconnected = vi.fn()
    const onAllSessionsCancellationRequested = vi.fn()
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) => {
        const fake = createFakeRuntime({
          frameworkId: 'claude-code',
          sessionIds: ['session-1'],
          callbacks
        })
        created.push(fake)
        return fake.runtime
      },
      {},
      '',
      initialization.promise,
      onDisconnected,
      undefined,
      { onAllSessionsCancellationRequested }
    )

    const connecting = coordinator.connect()
    coordinator.shutdown()
    initialization.resolve()

    await expect(connecting).rejects.toThrow(/superseded/i)
    expect(created[0].connect).not.toHaveBeenCalled()
    expect(vi.mocked(created[0].runtime.shutdown)).toHaveBeenCalledOnce()
    expect(onAllSessionsCancellationRequested).toHaveBeenCalledOnce()
    expect(onAllSessionsCancellationRequested.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(created[0].runtime.shutdown).mock.invocationCallOrder[0]
    )
    expect(vi.mocked(created[0].runtime.shutdown).mock.invocationCallOrder[0]).toBeLessThan(
      onDisconnected.mock.invocationCallOrder[0]
    )
  })

  it('shares one conversation permission store across runtime generations', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const stores: unknown[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks, permissionGrantStore) => {
      stores.push(permissionGrantStore)
      const fake = createFakeRuntime({
        frameworkId: created.length === 0 ? 'claude-code' : 'codex',
        sessionIds: [`session-${created.length + 1}`],
        callbacks,
        permissionGrantStore
      })
      created.push(fake)
      return fake.runtime
    })

    await coordinator.createSession()
    await coordinator.requestAgentFrameworkSwitch()
    await coordinator.createSession()

    expect(stores).toHaveLength(2)
    expect(stores[1]).toBe(stores[0])
  })

  it('forwards a real runtime prompt start to the session turn lifecycle', async () => {
    const onSessionTurnStarted = vi.fn()
    const onSessionTurnEnded = vi.fn()
    const onSkillImportAttachmentEligible = vi.fn()
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) =>
        createFakeRuntime({
          frameworkId: 'claude-code',
          sessionIds: ['session-1'],
          callbacks,
          eligibleAttachmentUri: 'file:///current.skill'
        }).runtime,
      {},
      '',
      undefined,
      undefined,
      undefined,
      { onSessionTurnStarted, onSessionTurnEnded, onSkillImportAttachmentEligible }
    )

    const session = await coordinator.createSession({ cwd: '/workspace' })
    await coordinator.sendPrompt({ sessionId: session.sessionId, text: 'import this Skill' })

    expect(onSessionTurnStarted).toHaveBeenCalledOnce()
    expect(onSessionTurnStarted).toHaveBeenCalledWith('session-1', 'turn-1')
    expect(onSessionTurnEnded).toHaveBeenCalledOnce()
    expect(onSessionTurnEnded).toHaveBeenCalledWith('session-1', 'turn-1')
    expect(onSkillImportAttachmentEligible).toHaveBeenCalledWith(
      'session-1',
      'turn-1',
      'file:///current.skill'
    )
  })

  it('does not reactivate a prompt attempt cancelled before its runtime turn starts', async () => {
    const firstPromptStart = createDeferred<void>()
    let promptAttempt = 0
    const onSessionTurnStarted = vi.fn()
    const onSessionCancellationRequested = vi.fn()
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) =>
        createFakeRuntime({
          frameworkId: 'claude-code',
          sessionIds: ['session-1'],
          callbacks,
          beforePromptStart: () =>
            promptAttempt++ === 0 ? firstPromptStart.promise : Promise.resolve()
        }).runtime,
      {},
      '',
      undefined,
      undefined,
      undefined,
      { onSessionTurnStarted, onSessionCancellationRequested }
    )

    const session = await coordinator.createSession({ cwd: '/workspace' })
    const cancelledBeforeStart = coordinator.sendPrompt({
      sessionId: session.sessionId,
      text: 'first turn'
    })
    await coordinator.cancelPrompt({ sessionId: session.sessionId })
    firstPromptStart.resolve()
    await cancelledBeforeStart

    expect(onSessionCancellationRequested).toHaveBeenCalledWith('session-1')
    expect(onSessionTurnStarted).not.toHaveBeenCalled()

    await coordinator.sendPrompt({ sessionId: session.sessionId, text: 'next turn' })
    expect(onSessionTurnStarted).toHaveBeenCalledOnce()
    expect(onSessionTurnStarted).toHaveBeenCalledWith('session-1', 'turn-2')
  })

  it('acknowledges prompt ownership release only after the owning prompt promise settles', async () => {
    const prompt = createDeferred<unknown>()
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) =>
        createFakeRuntime({
          frameworkId: 'claude-code',
          sessionIds: ['session-1'],
          callbacks,
          prompt: () => prompt.promise
        }).runtime
    )
    const session = await coordinator.createSession({ cwd: '/workspace' })
    const running = coordinator.sendPrompt({ sessionId: session.sessionId, text: 'handoff' })
    await Promise.resolve()

    let released = false
    const release = coordinator
      .waitForSessionInteractionRelease(session.sessionId)
      .then(() => (released = true))
    await Promise.resolve()
    expect(released).toBe(false)

    prompt.resolve({ stopReason: 'cancelled' })
    await running
    await release
    expect(released).toBe(true)
  })

  it('cancels active prompts and waits for their terminal responses before quit teardown', async () => {
    const prompt = createDeferred<unknown>()
    let created!: ReturnType<typeof createFakeRuntime>
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      created = createFakeRuntime({
        frameworkId: 'claude-code',
        sessionIds: ['session-1'],
        callbacks,
        prompt: () => prompt.promise
      })
      return created.runtime
    })
    const session = await coordinator.createSession({ cwd: '/workspace' })
    const running = coordinator.sendPrompt({ sessionId: session.sessionId, text: 'keep usage' })
    await Promise.resolve()

    let prepared = false
    const preparing = coordinator.prepareForQuit(1_000).then(() => {
      prepared = true
    })
    await Promise.resolve()

    expect(created.cancelPrompt).toHaveBeenCalledWith({ sessionId: 'session-1' })
    expect(prepared).toBe(false)

    prompt.resolve({ stopReason: 'cancelled' })
    await running
    await preparing
    expect(prepared).toBe(true)
  })

  it('bounds quit preparation when an agent never returns a terminal response', async () => {
    const prompt = createDeferred<unknown>()
    let created!: ReturnType<typeof createFakeRuntime>
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      created = createFakeRuntime({
        frameworkId: 'codex',
        sessionIds: ['session-1'],
        callbacks,
        prompt: () => prompt.promise
      })
      return created.runtime
    })
    const session = await coordinator.createSession({ cwd: '/workspace' })
    const running = coordinator.sendPrompt({ sessionId: session.sessionId, text: 'never stops' })
    await Promise.resolve()

    await expect(coordinator.prepareForQuit(0)).resolves.toBe('timeout')
    expect(created.cancelPrompt).toHaveBeenCalledWith({ sessionId: 'session-1' })

    prompt.resolve({ stopReason: 'cancelled' })
    await running
  })

  it('closes user, continuation, and reviewer prompt admission before the quit snapshot', async () => {
    let created!: ReturnType<typeof createFakeRuntime>
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      created = createFakeRuntime({
        frameworkId: 'claude-code',
        sessionIds: ['session-1'],
        callbacks
      })
      return created.runtime
    })
    const session = await coordinator.createSession({ cwd: '/workspace' })

    await expect(coordinator.prepareForQuit()).resolves.toBe('completed')

    await expect(
      coordinator.sendPrompt({ sessionId: session.sessionId, text: 'late user turn' })
    ).rejects.toThrow(/quitting/i)
    await expect(
      coordinator.sendAppContinuation({
        sessionId: session.sessionId,
        text: 'late app continuation'
      })
    ).rejects.toThrow(/quitting/i)
    await expect(
      coordinator.startContinuation({
        sessionId: session.sessionId,
        text: 'late accepted continuation'
      })
    ).rejects.toThrow(/quitting/i)
    await expect(
      coordinator.withActivity({}, (runtime) =>
        runtime.buildReviewerSession({ cwd: '/workspace', mcpServers: [] })
      )
    ).rejects.toThrow(/quitting/i)
    await expect(
      coordinator.buildReviewerSession({ cwd: '/workspace', mcpServers: [] })
    ).rejects.toThrow(/quitting/i)
    await expect(coordinator.compactSession({ sessionId: session.sessionId })).rejects.toThrow(
      /quitting/i
    )

    expect(created.sendPrompt).not.toHaveBeenCalled()
    expect(created.sendAppContinuation).not.toHaveBeenCalled()
    expect(vi.mocked(created.runtime.buildReviewerSession)).not.toHaveBeenCalled()
    expect(created.compactSession).not.toHaveBeenCalled()
  })

  it('rejects a user prompt still waiting on admission when quit begins', async () => {
    const admission = createDeferred<void>()
    let created!: ReturnType<typeof createFakeRuntime>
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      created = createFakeRuntime({
        frameworkId: 'codex',
        sessionIds: ['session-1'],
        callbacks
      })
      return created.runtime
    })
    const session = await coordinator.createSession({ cwd: '/workspace' })
    coordinator.setPromptAdmissionGuard(async () => admission.promise)

    const prompting = coordinator.sendPrompt({
      sessionId: session.sessionId,
      text: 'waiting at startup gate'
    })
    await Promise.resolve()
    await coordinator.prepareForQuit()
    admission.resolve()

    await expect(prompting).rejects.toThrow(/quitting/i)
    expect(created.sendPrompt).not.toHaveBeenCalled()
  })

  it('tracks and drains a reviewer correction admitted just before quit', async () => {
    const promptStart = createDeferred<void>()
    const beforePromptStart = vi.fn(async () => promptStart.promise)
    let created!: ReturnType<typeof createFakeRuntime>
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      created = createFakeRuntime({
        frameworkId: 'claude-code',
        sessionIds: ['session-1'],
        callbacks,
        beforePromptStart
      })
      return created.runtime
    })
    const session = await coordinator.createSession({ cwd: '/workspace' })
    const activity = coordinator.withActivity({}, (runtime) =>
      runtime.sendPrompt({ sessionId: session.sessionId, text: '[Auditor] correction' })
    )
    await Promise.resolve()
    await Promise.resolve()

    let prepared = false
    const preparing = coordinator.prepareForQuit().then(() => {
      prepared = true
    })
    await Promise.resolve()

    expect(beforePromptStart).toHaveBeenCalledOnce()
    expect(created.cancelPrompt).toHaveBeenCalledWith({ sessionId: session.sessionId })
    expect(prepared).toBe(false)

    promptStart.resolve()
    await activity
    await preparing
    expect(prepared).toBe(true)
  })

  it('disposes a reviewer session whose build finishes after quit begins', async () => {
    const reviewerSession = createDeferred<void>()
    let created!: ReturnType<typeof createFakeRuntime>
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      created = createFakeRuntime({
        frameworkId: 'codex',
        sessionIds: [],
        callbacks,
        beforeReviewerSession: async () => reviewerSession.promise
      })
      return created.runtime
    })

    const building = coordinator.buildReviewerSession({ cwd: '/workspace', mcpServers: [] })
    await Promise.resolve()
    await coordinator.prepareForQuit()
    reviewerSession.resolve()

    await expect(building).rejects.toThrow(/quitting/i)
    expect(vi.mocked(created.runtime.disposeReviewerSession)).toHaveBeenCalledOnce()
  })

  it('blocks user prompts on startup admission while allowing recovery continuations through', async () => {
    const admission = createDeferred<void>()
    let createdRuntime!: ReturnType<typeof createFakeRuntime>
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      createdRuntime = createFakeRuntime({
        frameworkId: 'claude-code',
        sessionIds: ['session-1'],
        callbacks
      })
      return createdRuntime.runtime
    })
    const session = await coordinator.createSession({ cwd: '/workspace' })
    coordinator.setPromptAdmissionGuard(async () => admission.promise)

    const userPrompt = coordinator.sendPrompt({ sessionId: session.sessionId, text: 'user turn' })
    await Promise.resolve()
    expect(createdRuntime.sendPrompt).not.toHaveBeenCalled()

    await coordinator.sendAppContinuation({
      sessionId: session.sessionId,
      text: 'approved recovery continuation'
    })
    expect(createdRuntime.sendAppContinuation).toHaveBeenCalledOnce()

    admission.resolve()
    await userPrompt
    expect(createdRuntime.sendPrompt).toHaveBeenCalledOnce()
    expect(createdRuntime.sendAppContinuation).toHaveBeenCalledOnce()
  })

  it('stops a prompt for handoff without reporting a user generation cancellation', async () => {
    const onSessionCancellationRequested = vi.fn()
    const fake = createFakeRuntime({
      frameworkId: 'claude-code',
      sessionIds: ['session-1'],
      callbacks: {}
    })
    const coordinator = new AcpRuntimeCoordinator(
      () => fake.runtime,
      {},
      '',
      undefined,
      undefined,
      undefined,
      { onSessionCancellationRequested }
    )
    const session = await coordinator.createSession({ cwd: '/workspace' })

    await coordinator.stopPromptForHandoff(session.sessionId)

    expect(fake.cancelPrompt).toHaveBeenCalledWith({ sessionId: 'session-1' })
    expect(onSessionCancellationRequested).not.toHaveBeenCalled()
  })

  it('matches out-of-order prompt starts to their exact coordinator attempts', async () => {
    const firstPromptStart = createDeferred<void>()
    let promptAttempt = 0
    const onSessionTurnStarted = vi.fn()
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) =>
        createFakeRuntime({
          frameworkId: 'claude-code',
          sessionIds: ['session-1'],
          callbacks,
          beforePromptStart: () =>
            promptAttempt++ === 0 ? firstPromptStart.promise : Promise.resolve()
        }).runtime,
      {},
      '',
      undefined,
      undefined,
      undefined,
      { onSessionTurnStarted }
    )

    const session = await coordinator.createSession({ cwd: '/workspace' })
    const stalePrompt = coordinator.sendPrompt({
      sessionId: session.sessionId,
      text: 'cancelled before start'
    })
    await coordinator.cancelPrompt({ sessionId: session.sessionId })

    await coordinator.sendPrompt({ sessionId: session.sessionId, text: 'new turn starts first' })
    expect(onSessionTurnStarted).toHaveBeenCalledOnce()
    expect(onSessionTurnStarted).toHaveBeenCalledWith('session-1', 'turn-1')

    firstPromptStart.resolve()
    await stalePrompt
    expect(onSessionTurnStarted).toHaveBeenCalledOnce()
  })

  it('keeps detached conversation grants visible and revocable during framework rotation', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    let store: ConversationPermissionGrantStore | undefined
    const coordinator = new AcpRuntimeCoordinator((callbacks, permissionGrantStore) => {
      store = permissionGrantStore
      const fake = createFakeRuntime({
        frameworkId: created.length === 0 ? 'claude-code' : 'codex',
        sessionIds: [`session-${created.length + 1}`],
        callbacks,
        permissionGrantStore
      })
      created.push(fake)
      return fake.runtime
    })
    const session = await coordinator.createSession()
    store?.remember(session.sessionId, 'file:Write')

    await coordinator.requestAgentFrameworkSwitch()

    expect(coordinator.getSnapshot()).toMatchObject({
      sessionIds: [],
      permissionGrants: {
        [session.sessionId]: [{ categoryKey: 'file:Write', label: 'Write', scope: 'session' }]
      }
    })

    coordinator.revokePermissionGrant({
      sessionId: session.sessionId,
      categoryKey: 'file:Write'
    })
    expect(coordinator.getSnapshot().permissionGrants).toEqual({})

    await coordinator.resumeSession({
      sessionId: session.sessionId,
      cwd: '/workspace',
      previousFrameworkId: 'claude-code'
    })
    expect(coordinator.getSnapshot().permissionGrants).toEqual({})
  })

  it('projects durable registry grants across runtime rotation and refresh notifications', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const onStateChanged = vi.fn()
    const durableGrants: AcpStateSnapshot['permissionGrants'] = {
      'session-1': [
        {
          categoryKey: 'durable-grant-1',
          kind: 'mcp',
          label: 'Manage packages',
          scope: 'session'
        }
      ]
    }
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks, permissionGrantStore) => {
        const fake = createFakeRuntime({
          frameworkId: created.length === 0 ? 'claude-code' : 'codex',
          sessionIds: [`session-${created.length + 1}`],
          callbacks,
          permissionGrantStore
        })
        created.push(fake)
        return fake.runtime
      },
      { onStateChanged },
      '',
      undefined,
      undefined,
      undefined,
      {},
      () => durableGrants
    )

    await coordinator.createSession()
    await coordinator.requestAgentFrameworkSwitch()

    expect(coordinator.getSnapshot().permissionGrants).toEqual(durableGrants)
    coordinator.notifyPermissionGrantsChanged()
    expect(onStateChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ permissionGrants: durableGrants })
    )
  })

  it('moves later settings and model-resolved effort across active generations', async () => {
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

    expect(created).toHaveLength(3)
    expect(created[0].requestProviderReconnect).not.toHaveBeenCalled()
    expect(created[0].applyReasoningEffortChange).not.toHaveBeenCalled()
    expect(created[1].requestProviderReconnect).toHaveBeenCalledOnce()
    expect(created[1].requestRetirement).toHaveBeenCalledOnce()
    expect(created[1].applyReasoningEffortChange).not.toHaveBeenCalled()
    expect(created[2].applyReasoningEffortChange).toHaveBeenCalledWith('high')
  })

  it('routes a model hot-switch only to the active runtime generation', async () => {
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
    const target: AgentModelChangeTarget = {
      frameworkId: 'codex',
      backendId: 'codex:provider-a',
      route: 'codex-responses',
      model: 'model-b',
      sessionModel: 'model-b',
      sessionModelRequired: false,
      supportsImageInput: true,
      reasoningEffort: 'high'
    }

    await coordinator.createSession()
    await coordinator.requestAgentFrameworkSwitch()
    await expect(coordinator.applyModelChange(target)).resolves.toBe(true)

    expect(created[0].applyModelChange).not.toHaveBeenCalled()
    expect(created[1].applyModelChange).toHaveBeenCalledWith(target)
  })

  it('detaches idle sessions while an active turn retires and resumes them on a fresh runtime', async () => {
    const retirement = createDeferred<void>()
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: 'claude-code',
        sessionIds: created.length === 0 ? ['active-session', 'idle-session'] : ['fresh-session'],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })

    const activeSession = await coordinator.createSession()
    const idleSession = await coordinator.createSession()
    created[0].emitState({
      promptInFlight: true,
      promptInFlightSessionIds: [activeSession.sessionId]
    })
    created[0].requestRetirement.mockReturnValue(retirement.promise)
    const reloadRequest = coordinator.requestSkillsReload()

    expect(coordinator.getSnapshot().sessionIds).toEqual([activeSession.sessionId])
    await expect(
      coordinator.sendPrompt({ sessionId: idleSession.sessionId, text: 'stale turn' })
    ).rejects.toThrow('resume')
    expect(created[0].sendPrompt).not.toHaveBeenCalled()

    await coordinator.resumeSession({
      sessionId: idleSession.sessionId,
      cwd: '/workspace',
      previousFrameworkId: 'claude-code'
    })
    await coordinator.sendPrompt({ sessionId: idleSession.sessionId, text: 'fresh turn' })

    expect(created).toHaveLength(2)
    expect(created[1].resumeSession).toHaveBeenCalledOnce()
    expect(created[1].sendPrompt).toHaveBeenCalledOnce()

    retirement.resolve()
    await reloadRequest
  })

  it('publishes prompt ownership only from the runtime that currently owns the session', async () => {
    const retirement = createDeferred<void>()
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: created.length === 0 ? 'claude-code' : 'codex',
        sessionIds: [`agent-session-${created.length + 1}`],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })

    const session = await coordinator.createSession()
    created[0].emitState({
      promptInFlight: true,
      promptInFlightSessionIds: [session.sessionId],
      agentPromptInFlightSessionIds: [session.sessionId]
    })
    created[0].requestRetirement.mockReturnValue(retirement.promise)
    const reloadRequest = coordinator.requestSkillsReload()

    expect(coordinator.getSnapshot().promptInFlightSessionIds).toEqual([session.sessionId])
    expect(coordinator.getSnapshot().agentPromptInFlightSessionIds).toEqual([session.sessionId])

    const resumeRequest = coordinator.resumeSession({
      sessionId: session.sessionId,
      cwd: '/workspace',
      previousFrameworkId: 'claude-code'
    })
    await vi.waitFor(() => expect(created[1].resumeSession).toHaveBeenCalledOnce())

    // Adoption cannot publish the new owner until the prior turn clears its terminal state.
    expect(coordinator.getSnapshot().promptInFlightSessionIds).toEqual([session.sessionId])
    created[0].emitState({
      promptInFlight: false,
      promptInFlightSessionIds: [],
      agentPromptInFlightSessionIds: []
    })
    await resumeRequest

    // Once the old turn settles, only the fresh runtime may publish prompt ownership.
    expect(coordinator.getSnapshot().promptInFlightSessionIds).toEqual([])

    created[1].emitState({
      promptInFlight: true,
      promptInFlightSessionIds: [session.sessionId]
    })
    expect(coordinator.getSnapshot().promptInFlightSessionIds).toEqual([session.sessionId])
    expect(coordinator.getSnapshot().agentPromptInFlightSessionIds).toEqual([])

    retirement.resolve()
    await reloadRequest
  })

  it('keeps draining events on the prior owner until adoption commits', async () => {
    const retirement = createDeferred<void>()
    const adoption = createDeferred<void>()
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const forwardedEvents: AcpRuntimeEvent[] = []
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) => {
        const fake = createFakeRuntime({
          frameworkId: created.length === 0 ? 'codex' : 'claude-code',
          sessionIds: [`agent-session-${created.length + 1}`],
          callbacks,
          ...(created.length === 0 ? {} : { afterResumeAttached: () => adoption.promise })
        })
        created.push(fake)
        return fake.runtime
      },
      { onEvent: (event) => forwardedEvents.push(event) }
    )

    const session = await coordinator.createSession()
    created[0].emitState({
      status: 'error',
      error: 'draining runtime disconnected',
      promptInFlight: true,
      promptInFlightSessionIds: [session.sessionId]
    })
    created[0].requestRetirement.mockReturnValue(retirement.promise)
    const switchRequest = coordinator.requestAgentFrameworkSwitch()
    const toolEvent = (id: string, providerToolName: string): AcpRuntimeEvent => ({
      id,
      timestamp: 1,
      kind: 'tool',
      level: 'info',
      sessionId: session.sessionId,
      toolCallId: id,
      providerToolName,
      title: providerToolName,
      toolKind: providerToolName.startsWith('mcp.') ? 'execute' : 'other',
      status: 'completed'
    })

    // The draining Codex turn still owns the session until Claude Code adopts it.
    created[0].emitEvent(toolEvent('owner-tool', 'mcp.open-science-artifacts.write_artifact_file'))
    expect(forwardedEvents.map((event) => event.id)).toEqual([
      expect.stringMatching(runtimeEventId(1, 'owner-tool'))
    ])

    await coordinator.connect()
    const resumeRequest = coordinator.resumeSession({
      sessionId: session.sessionId,
      cwd: '/workspace',
      previousFrameworkId: 'codex'
    })
    await vi.waitFor(() => expect(created[1].resumeSession).toHaveBeenCalledOnce())

    created[0].emitEvent(
      toolEvent('late-codex-tool', 'mcp.open-science-artifacts.write_artifact_file')
    )
    created[0].emitEvent({
      id: 'late-codex-stop',
      timestamp: 2,
      kind: 'stop',
      level: 'info',
      sessionId: session.sessionId,
      title: 'Prompt stopped',
      text: 'end_turn'
    })
    expect(forwardedEvents.map((event) => event.id)).toEqual([
      expect.stringMatching(runtimeEventId(1, 'owner-tool')),
      expect.stringMatching(runtimeEventId(1, 'late-codex-tool')),
      expect.stringMatching(runtimeEventId(1, 'late-codex-stop'))
    ])
    created[0].emitEvent({
      id: 'late-codex-artifact',
      timestamp: 3,
      kind: 'artifact',
      level: 'info',
      sessionId: session.sessionId,
      runId: 'old-run',
      promptMessageId: 'old-prompt',
      artifactClaimId: 'old-claim',
      artifacts: [
        {
          id: 'artifact-version-1',
          projectName: 'project-1',
          sessionId: session.sessionId,
          name: 'result.csv',
          path: '/workspace/result.csv',
          fileUrl: 'file:///workspace/result.csv',
          size: 12,
          mtimeMs: 2
        }
      ]
    })
    created[0].emitEvent({
      id: 'late-codex-unprovenanced-artifact',
      timestamp: 4,
      kind: 'artifact',
      level: 'info',
      sessionId: session.sessionId,
      runId: 'old-run',
      artifactClaimId: 'old-unprovenanced-claim',
      artifacts: []
    })
    expect(forwardedEvents.map((event) => event.id)).toEqual([
      expect.stringMatching(runtimeEventId(1, 'owner-tool')),
      expect.stringMatching(runtimeEventId(1, 'late-codex-tool')),
      expect.stringMatching(runtimeEventId(1, 'late-codex-stop')),
      expect.stringMatching(runtimeEventId(1, 'late-codex-artifact')),
      expect.stringMatching(runtimeEventId(1, 'late-codex-unprovenanced-artifact'))
    ])
    expect(coordinator.getSnapshot().events.map((event) => event.id)).toEqual([
      expect.stringMatching(runtimeEventId(1, 'owner-tool')),
      expect.stringMatching(runtimeEventId(1, 'late-codex-tool')),
      expect.stringMatching(runtimeEventId(1, 'late-codex-stop')),
      expect.stringMatching(runtimeEventId(1, 'late-codex-artifact')),
      expect.stringMatching(runtimeEventId(1, 'late-codex-unprovenanced-artifact'))
    ])

    adoption.resolve()
    created[0].emitState({ promptInFlight: false, promptInFlightSessionIds: [] })
    await resumeRequest

    expect(coordinator.getSnapshot().sessionConnectionStatuses).toEqual({
      [session.sessionId]: 'connected'
    })

    created[0].emitEvent(toolEvent('post-adoption-codex-tool', 'shell'))
    created[0].emitEvent({
      id: 'post-adoption-unprovenanced-artifact',
      timestamp: 5,
      kind: 'artifact',
      level: 'info',
      sessionId: session.sessionId,
      runId: 'old-run',
      artifactClaimId: 'post-adoption-unprovenanced-claim',
      artifacts: []
    })
    created[1].emitEvent(
      toolEvent('fresh-claude-tool', 'mcp__open-science-artifacts__write_artifact_file')
    )
    expect(forwardedEvents.map((event) => event.id)).toEqual([
      expect.stringMatching(runtimeEventId(1, 'owner-tool')),
      expect.stringMatching(runtimeEventId(1, 'late-codex-tool')),
      expect.stringMatching(runtimeEventId(1, 'late-codex-stop')),
      expect.stringMatching(runtimeEventId(1, 'late-codex-artifact')),
      expect.stringMatching(runtimeEventId(1, 'late-codex-unprovenanced-artifact')),
      expect.stringMatching(runtimeEventId(2, 'fresh-claude-tool'))
    ])
    const adoptedSnapshotEventIds = coordinator.getSnapshot().events.map((event) => event.id)
    expect(adoptedSnapshotEventIds).toEqual(
      expect.arrayContaining([
        expect.stringMatching(runtimeEventId(1, 'owner-tool')),
        expect.stringMatching(runtimeEventId(1, 'late-codex-tool')),
        expect.stringMatching(runtimeEventId(1, 'late-codex-stop')),
        expect.stringMatching(runtimeEventId(1, 'late-codex-artifact')),
        expect.stringMatching(runtimeEventId(2, 'fresh-claude-tool'))
      ])
    )
    expect(adoptedSnapshotEventIds).not.toEqual(
      expect.arrayContaining([expect.stringMatching(runtimeEventId(1, 'post-adoption-codex-tool'))])
    )
    expect(adoptedSnapshotEventIds).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(runtimeEventId(1, 'late-codex-unprovenanced-artifact'))
      ])
    )
    expect(forwardedEvents.map((event) => event.id)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(runtimeEventId(1, 'post-adoption-unprovenanced-artifact'))
      ])
    )

    retirement.resolve()
    await switchRequest
  })

  it('waits for the prior turn terminal event after incoming resume succeeds', async () => {
    const retirement = createDeferred<void>()
    const adoption = createDeferred<void>()
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const forwardedEvents: AcpRuntimeEvent[] = []
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) => {
        const fake = createFakeRuntime({
          frameworkId: created.length === 0 ? 'codex' : 'claude-code',
          sessionIds: [`agent-session-${created.length + 1}`],
          callbacks,
          ...(created.length === 0 ? {} : { afterResumeAttached: () => adoption.promise })
        })
        created.push(fake)
        return fake.runtime
      },
      { onEvent: (event) => forwardedEvents.push(event) }
    )

    const session = await coordinator.createSession()
    created[0].emitState({
      promptInFlight: true,
      promptInFlightSessionIds: [session.sessionId]
    })
    created[0].requestRetirement.mockReturnValue(retirement.promise)
    const switchRequest = coordinator.requestAgentFrameworkSwitch()
    await coordinator.connect()

    let resumeSettled = false
    const resumeRequest = coordinator
      .resumeSession({
        sessionId: session.sessionId,
        cwd: '/workspace',
        previousFrameworkId: 'codex'
      })
      .finally(() => {
        resumeSettled = true
      })
    await vi.waitFor(() => expect(created[1].resumeSession).toHaveBeenCalledOnce())

    adoption.resolve()
    await expect(created[1].resumeSession.mock.results[0]?.value).resolves.toMatchObject({
      sessionId: session.sessionId
    })
    expect(resumeSettled).toBe(false)

    created[0].emitEvent({
      id: 'post-resume-old-stop',
      timestamp: 1,
      kind: 'stop',
      level: 'info',
      sessionId: session.sessionId,
      title: 'Prompt stopped',
      text: 'end_turn'
    })
    expect(forwardedEvents.map((event) => event.id)).toEqual([
      expect.stringMatching(runtimeEventId(1, 'post-resume-old-stop'))
    ])

    created[0].emitState({ promptInFlight: false, promptInFlightSessionIds: [] })
    await resumeRequest

    created[0].emitEvent({
      id: 'post-adoption-old-stop',
      timestamp: 2,
      kind: 'stop',
      level: 'info',
      sessionId: session.sessionId,
      title: 'Prompt stopped',
      text: 'end_turn'
    })
    expect(forwardedEvents.map((event) => event.id)).toEqual([
      expect.stringMatching(runtimeEventId(1, 'post-resume-old-stop'))
    ])

    retirement.resolve()
    await switchRequest
  })

  it('rejects adoption when the incoming runtime retires while the prior turn drains', async () => {
    const retirement = createDeferred<void>()
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: created.length === 0 ? 'codex' : 'claude-code',
        sessionIds: [`agent-session-${created.length + 1}`],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })

    const session = await coordinator.createSession()
    created[0].emitState({
      promptInFlight: true,
      promptInFlightSessionIds: [session.sessionId]
    })
    created[0].requestRetirement.mockReturnValue(retirement.promise)
    const switchRequest = coordinator.requestAgentFrameworkSwitch()
    await coordinator.connect()

    const resumeRequest = coordinator.resumeSession({
      sessionId: session.sessionId,
      cwd: '/workspace',
      previousFrameworkId: 'codex'
    })
    await vi.waitFor(() => expect(created[1].resumeSession).toHaveBeenCalledOnce())
    await expect(created[1].resumeSession.mock.results[0]?.value).resolves.toMatchObject({
      sessionId: session.sessionId
    })

    created[1].emitRetired()
    created[0].emitState({ promptInFlight: false, promptInFlightSessionIds: [] })

    await expect(resumeRequest).rejects.toThrow('superseded')
    await expect(
      coordinator.sendPrompt({ sessionId: session.sessionId, text: 'must resume again' })
    ).rejects.toThrow('must resume')

    retirement.resolve()
    await switchRequest
  })

  it('restores the draining runtime owner when fresh runtime adoption fails before attachment', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const forwardedEvents: AcpRuntimeEvent[] = []
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) => {
        const fake = createFakeRuntime({
          frameworkId: created.length === 0 ? 'codex' : 'claude-code',
          sessionIds: [`agent-session-${created.length + 1}`],
          callbacks
        })
        created.push(fake)
        return fake.runtime
      },
      { onEvent: (event) => forwardedEvents.push(event) }
    )

    const session = await coordinator.createSession()
    await coordinator.requestAgentFrameworkSwitch()
    await coordinator.connect()
    created[1].resumeSession.mockRejectedValue(new Error('resume failed'))

    await expect(
      coordinator.resumeSession({
        sessionId: session.sessionId,
        cwd: '/workspace',
        previousFrameworkId: 'codex'
      })
    ).rejects.toThrow('resume failed')

    created[0].emitEvent({
      id: 'restored-owner-event',
      timestamp: 1,
      kind: 'message',
      level: 'info',
      sessionId: session.sessionId,
      role: 'assistant',
      text: 'old runtime remains authoritative'
    })
    expect(forwardedEvents.map((event) => event.id)).toEqual([
      expect.stringMatching(runtimeEventId(1, 'restored-owner-event'))
    ])
  })

  it('drops late recoverable overflow events from a previous session owner', async () => {
    const retirement = createDeferred<void>()
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const forwardedEvents: AcpRuntimeEvent[] = []
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) => {
        const fake = createFakeRuntime({
          frameworkId: created.length === 0 ? 'claude-code' : 'codex',
          sessionIds: [`agent-session-${created.length + 1}`],
          callbacks
        })
        created.push(fake)
        return fake.runtime
      },
      { onEvent: (event) => forwardedEvents.push(event) }
    )

    const session = await coordinator.createSession()
    created[0].emitState({
      promptInFlight: true,
      promptInFlightSessionIds: [session.sessionId]
    })
    created[0].requestRetirement.mockReturnValue(retirement.promise)
    const reloadRequest = coordinator.requestSkillsReload()
    const overflowEvent = (id: string): AcpRuntimeEvent => ({
      id,
      timestamp: 1,
      kind: 'error',
      level: 'error',
      sessionId: session.sessionId,
      recoverable: 'context-overflow',
      title: 'Prompt failed'
    })

    // The draining runtime still owns the session until a fresh generation adopts it.
    created[0].emitEvent(overflowEvent('owner-overflow'))
    expect(forwardedEvents.map((event) => event.id)).toEqual([
      expect.stringMatching(runtimeEventId(1, 'owner-overflow'))
    ])

    const resumeRequest = coordinator.resumeSession({
      sessionId: session.sessionId,
      cwd: '/workspace',
      previousFrameworkId: 'claude-code'
    })
    await vi.waitFor(() => expect(created[1].resumeSession).toHaveBeenCalledOnce())
    created[0].emitState({ promptInFlight: false, promptInFlightSessionIds: [] })
    await resumeRequest

    created[0].emitEvent(overflowEvent('late-retired-overflow'))
    expect(forwardedEvents.map((event) => event.id)).toEqual([
      expect.stringMatching(runtimeEventId(1, 'owner-overflow'))
    ])
    expect(coordinator.getSnapshot().events).toEqual([])

    created[1].emitEvent(overflowEvent('fresh-owner-overflow'))
    expect(forwardedEvents.map((event) => event.id)).toEqual([
      expect.stringMatching(runtimeEventId(1, 'owner-overflow')),
      expect.stringMatching(runtimeEventId(2, 'fresh-owner-overflow'))
    ])
    expect(coordinator.getSnapshot().events.map((event) => event.id)).toEqual([
      expect.stringMatching(runtimeEventId(2, 'fresh-owner-overflow'))
    ])

    retirement.resolve()
    await reloadRequest
  })

  it('drops late compaction events from a previous session owner', async () => {
    const retirement = createDeferred<void>()
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const forwardedEvents: AcpRuntimeEvent[] = []
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) => {
        const fake = createFakeRuntime({
          frameworkId: created.length === 0 ? 'claude-code' : 'codex',
          sessionIds: [`agent-session-${created.length + 1}`],
          callbacks
        })
        created.push(fake)
        return fake.runtime
      },
      { onEvent: (event) => forwardedEvents.push(event) }
    )

    const session = await coordinator.createSession()
    created[0].emitState({
      promptInFlight: true,
      promptInFlightSessionIds: [session.sessionId]
    })
    created[0].requestRetirement.mockReturnValue(retirement.promise)
    const reloadRequest = coordinator.requestSkillsReload()
    const compactionEvent = (id: string, status: string): AcpRuntimeEvent => ({
      id,
      timestamp: 1,
      kind: 'compaction',
      level: status === 'failed' ? 'error' : 'info',
      sessionId: session.sessionId,
      status,
      title: 'Context compaction'
    })

    created[0].emitEvent(compactionEvent('owner-compaction', 'in_progress'))
    expect(forwardedEvents.map((event) => event.id)).toEqual([
      expect.stringMatching(runtimeEventId(1, 'owner-compaction'))
    ])

    const resumeRequest = coordinator.resumeSession({
      sessionId: session.sessionId,
      cwd: '/workspace',
      previousFrameworkId: 'claude-code'
    })
    await vi.waitFor(() => expect(created[1].resumeSession).toHaveBeenCalledOnce())
    created[0].emitState({ promptInFlight: false, promptInFlightSessionIds: [] })
    await resumeRequest

    created[0].emitEvent(compactionEvent('late-retired-compaction', 'failed'))
    expect(forwardedEvents.map((event) => event.id)).toEqual([
      expect.stringMatching(runtimeEventId(1, 'owner-compaction'))
    ])
    expect(coordinator.getSnapshot().events).toEqual([])

    created[1].emitEvent(compactionEvent('fresh-owner-compaction', 'completed'))
    expect(forwardedEvents.map((event) => event.id)).toEqual([
      expect.stringMatching(runtimeEventId(1, 'owner-compaction')),
      expect.stringMatching(runtimeEventId(2, 'fresh-owner-compaction'))
    ])
    expect(coordinator.getSnapshot().events.map((event) => event.id)).toEqual([
      expect.stringMatching(runtimeEventId(2, 'fresh-owner-compaction'))
    ])

    retirement.resolve()
    await reloadRequest
  })

  it('surfaces an active generation effort failure without touching a retiring model', async () => {
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
    created[1].applyReasoningEffortChange.mockRejectedValue(new Error('active effort failed'))

    await expect(coordinator.applyReasoningEffortChange('high')).rejects.toThrow(
      'active effort failed'
    )
    expect(created[0].applyReasoningEffortChange).not.toHaveBeenCalled()
    expect(created[1].applyReasoningEffortChange).toHaveBeenCalledWith('high')
  })

  it('attempts every runtime disconnect and preserves the surviving snapshot primary', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const onSessionUnavailable = vi.fn()
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
      {},
      '',
      undefined,
      undefined,
      onSessionUnavailable
    )

    await coordinator.createSession()
    await coordinator.requestAgentFrameworkSwitch()
    await coordinator.createSession()
    created[0].emitState({ cwd: '/surviving-old-runtime' })
    const activeDisconnect = createDeferred<AcpStateSnapshot>()
    created[0].disconnect.mockImplementationOnce(async () => {
      created[0].setStateSilently({ sessionId: undefined, sessionIds: [] })
      throw new Error('old disconnect failed')
    })
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
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'connected',
      cwd: '/surviving-old-runtime'
    })
    expect(created).toHaveLength(2)
    expect(onSessionUnavailable).toHaveBeenCalledTimes(2)
    expect(onSessionUnavailable).toHaveBeenCalledWith('session-1')
    expect(onSessionUnavailable).toHaveBeenCalledWith('session-2')
  })

  it('preserves sessions still reported by a runtime whose teardown rejects', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const onSessionUnavailable = vi.fn()
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
      {},
      '',
      undefined,
      undefined,
      onSessionUnavailable
    )

    await coordinator.createSession()
    await coordinator.requestAgentFrameworkSwitch()
    await coordinator.createSession()
    created[0].disconnect.mockRejectedValueOnce(new Error('old disconnect failed early'))

    await expect(coordinator.disconnect()).rejects.toThrow('old disconnect failed early')

    expect(onSessionUnavailable).toHaveBeenCalledOnce()
    expect(onSessionUnavailable).toHaveBeenCalledWith('session-2')
    expect(onSessionUnavailable).not.toHaveBeenCalledWith('session-1')
  })

  it('invalidates only sessions owned by a runtime that closes unexpectedly', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const onSessionUnavailable = vi.fn()
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
      {},
      '',
      undefined,
      undefined,
      onSessionUnavailable
    )

    await coordinator.createSession()
    await coordinator.requestAgentFrameworkSwitch()
    await coordinator.createSession()

    created[0].emitState({ status: 'closed', sessionId: undefined, sessionIds: [] })

    expect(onSessionUnavailable).toHaveBeenCalledOnce()
    expect(onSessionUnavailable).toHaveBeenCalledWith('session-1')
    expect(onSessionUnavailable).not.toHaveBeenCalledWith('session-2')
  })

  it('invalidates a successfully deleted session exactly once', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const onSessionUnavailable = vi.fn()
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) => {
        const fake = createFakeRuntime({
          frameworkId: 'claude-code',
          sessionIds: ['session-1'],
          callbacks
        })
        created.push(fake)
        return fake.runtime
      },
      {},
      '',
      undefined,
      undefined,
      onSessionUnavailable
    )

    await coordinator.createSession()
    await coordinator.deleteSession({ sessionId: 'session-1' })

    expect(created[0].deleteSession).toHaveBeenCalledWith({ sessionId: 'session-1' })
    expect(onSessionUnavailable).toHaveBeenCalledOnce()
    expect(onSessionUnavailable).toHaveBeenCalledWith('session-1')
  })

  it('invalidates a successfully deleted detached session without a runtime state event', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const onSessionUnavailable = vi.fn()
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) => {
        const fake = createFakeRuntime({
          frameworkId: 'claude-code',
          sessionIds: [],
          callbacks
        })
        created.push(fake)
        return fake.runtime
      },
      {},
      '',
      undefined,
      undefined,
      onSessionUnavailable
    )

    await coordinator.deleteSession({ sessionId: 'detached-session' })

    expect(created[0].deleteSession).toHaveBeenCalledWith({ sessionId: 'detached-session' })
    expect(onSessionUnavailable).toHaveBeenCalledOnce()
    expect(onSessionUnavailable).toHaveBeenCalledWith('detached-session')
  })

  it('preserves a session adopted by a new generation while the old delete is in flight', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const onSessionUnavailable = vi.fn()
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) => {
        const fake = createFakeRuntime({
          frameworkId: created.length === 0 ? 'claude-code' : 'codex',
          sessionIds: created.length === 0 ? ['session-1'] : [],
          callbacks
        })
        created.push(fake)
        return fake.runtime
      },
      {},
      '',
      undefined,
      undefined,
      onSessionUnavailable
    )

    await coordinator.createSession()
    await coordinator.requestAgentFrameworkSwitch()
    const deleteDeferred = createDeferred<AcpStateSnapshot>()
    created[0].deleteSession.mockReturnValueOnce(deleteDeferred.promise)

    const deleting = coordinator.deleteSession({ sessionId: 'session-1' })
    await vi.waitFor(() => expect(created[0].deleteSession).toHaveBeenCalledOnce())
    await coordinator.resumeSession({ sessionId: 'session-1', cwd: '/workspace' })
    deleteDeferred.resolve(emptySnapshot())

    await expect(deleting).resolves.toMatchObject({ sessionIds: ['session-1'] })
    await coordinator.sendPrompt({ sessionId: 'session-1', text: 'continue on new runtime' })

    expect(vi.mocked(created[0].runtime.sendPrompt)).not.toHaveBeenCalled()
    expect(vi.mocked(created[1].runtime.sendPrompt)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        text: 'continue on new runtime'
      }),
      expect.any(String)
    )
    expect(onSessionUnavailable).not.toHaveBeenCalled()
  })

  it('attempts every runtime quit teardown and preserves the surviving snapshot primary', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const onDisconnected = vi.fn()
    const onSessionUnavailable = vi.fn()
    const onAllSessionsCancellationRequested = vi.fn()
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
      {},
      '',
      undefined,
      onDisconnected,
      onSessionUnavailable,
      { onAllSessionsCancellationRequested }
    )

    await coordinator.createSession()
    await coordinator.requestAgentFrameworkSwitch()
    await coordinator.createSession()
    created[0].emitState({ cwd: '/surviving-old-runtime' })
    const activeShutdown = createDeferred<{ reaped: boolean }>()
    vi.mocked(created[0].runtime.shutdownForQuit).mockImplementationOnce(async () => {
      created[0].setStateSilently({ sessionId: undefined, sessionIds: [] })
      throw new Error('old shutdown failed')
    })
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
    expect(onAllSessionsCancellationRequested).toHaveBeenCalledOnce()
    expect(onAllSessionsCancellationRequested.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(created[0].runtime.shutdownForQuit).mock.invocationCallOrder[0]
    )
    activeShutdown.resolve({ reaped: true })
    await expect(shuttingDown).rejects.toThrow('old shutdown failed')
    expect(onSessionUnavailable).toHaveBeenCalledTimes(2)
    expect(onSessionUnavailable).toHaveBeenCalledWith('session-1')
    expect(onSessionUnavailable).toHaveBeenCalledWith('session-2')
    expect(onDisconnected).not.toHaveBeenCalled()
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'connected',
      cwd: '/surviving-old-runtime'
    })
    expect(created).toHaveLength(2)

    vi.mocked(created[0].runtime.shutdownForQuit).mockResolvedValueOnce({ reaped: true })
    await expect(coordinator.shutdownForQuit()).resolves.toEqual({ reaped: true })
    expect(created[0].runtime.shutdownForQuit).toHaveBeenCalledTimes(2)
    expect(onAllSessionsCancellationRequested).toHaveBeenCalledTimes(2)
    expect(onDisconnected).toHaveBeenCalledOnce()
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
    expect(vi.mocked(created[1].runtime.sendPrompt)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'old-session',
        text: 'continue on Codex'
      }),
      expect.any(String)
    )
  })

  it('invalidates the old framework context usage until the adopted session reports a new value', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: created.length === 0 ? 'claude-code' : 'codex',
        sessionIds: [`agent-session-${created.length + 1}`],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })

    const session = await coordinator.createSession({ cwd: '/workspace' })
    created[0].emitState({
      contextUsageBySession: { [session.sessionId]: { used: 24000, size: 200000 } }
    })
    expect(coordinator.getSnapshot().contextUsageBySession).toEqual({
      [session.sessionId]: { used: 24000, size: 200000 }
    })

    await coordinator.requestAgentFrameworkSwitch()
    expect(coordinator.getSnapshot().contextUsageBySession).toEqual({})

    await coordinator.resumeSession({
      sessionId: session.sessionId,
      cwd: '/workspace',
      previousFrameworkId: 'claude-code'
    })
    expect(coordinator.getSnapshot().contextUsageBySession).toEqual({})

    created[1].emitState({
      contextUsageBySession: { [session.sessionId]: { used: 18000, size: 128000 } }
    })
    expect(coordinator.getSnapshot().contextUsageBySession).toEqual({
      [session.sessionId]: { used: 18000, size: 128000 }
    })
  })

  it('hides a retiring framework context while its active prompt finishes', async () => {
    const oldPrompt = createDeferred<{ stopReason: string }>()
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: created.length === 0 ? 'claude-code' : 'codex',
        sessionIds: [`agent-session-${created.length + 1}`],
        callbacks,
        ...(created.length === 0 ? { prompt: () => oldPrompt.promise } : {})
      })
      created.push(fake)
      return fake.runtime
    })

    const session = await coordinator.createSession({ cwd: '/workspace' })
    created[0].emitState({
      contextUsageBySession: { [session.sessionId]: { used: 24000, size: 200000 } }
    })
    const turn = coordinator.sendPrompt({ sessionId: session.sessionId, text: 'continue' })

    await coordinator.requestAgentFrameworkSwitch()
    expect(coordinator.getSnapshot().contextUsageBySession).toEqual({})

    created[0].emitState({
      contextUsageBySession: { [session.sessionId]: { used: 26000, size: 200000 } }
    })
    expect(coordinator.getSnapshot().contextUsageBySession).toEqual({})

    oldPrompt.resolve({ stopReason: 'end_turn' })
    await turn
  })

  it('namespaces events and routes permission responses to their owning runtime', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const forwardedEvents: AcpRuntimeEvent[] = []
    const settleAuthorization = vi.fn()
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
      {
        onEvent: (event) => forwardedEvents.push(event),
        onPermissionSettled: (requestId, state) =>
          settleAuthorization('agent-tool', requestId, state)
      }
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
      expect.stringMatching(runtimeEventId(1, 'acp-event-1')),
      expect.stringMatching(runtimeEventId(2, 'acp-event-1'))
    ])
    expect(coordinator.getSnapshot().events.map((item) => item.id)).toEqual([
      expect.stringMatching(runtimeEventId(1, 'acp-event-1')),
      expect.stringMatching(runtimeEventId(2, 'acp-event-1'))
    ])

    const permission: AcpPermissionRequest = {
      requestId: 'permission-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      title: 'Run tool',
      options: []
    }
    created[0].emitPermission(permission)
    expect(coordinator.getSnapshot().sessionIds).toContain('session-1')
    await coordinator.respondToPermission({ requestId: permission.requestId, cancelled: true })

    expect(created[0].respondToPermission).toHaveBeenCalledWith({
      requestId: 'permission-1',
      cancelled: true
    })
    expect(created[1].respondToPermission).not.toHaveBeenCalled()
    expect(settleAuthorization).toHaveBeenCalledWith(
      'agent-tool',
      permission.requestId,
      'cancelled'
    )

    await expect(
      coordinator.requestUserInput({
        sessionId: 'session-1',
        questions: [
          {
            question: 'Which approach?',
            options: [{ label: 'Minimal' }, { label: 'Expanded' }]
          }
        ]
      })
    ).resolves.toEqual({ action: 'answered', answer: 'Minimal' })
    expect(created[0].requestUserInput).toHaveBeenCalledOnce()
    expect(created[1].requestUserInput).not.toHaveBeenCalled()
  })

  it('does not reuse persisted event namespaces across coordinator lifetimes', async () => {
    const createCoordinator = (): {
      coordinator: AcpRuntimeCoordinator
      created: ReturnType<typeof createFakeRuntime>[]
      forwardedEvents: AcpRuntimeEvent[]
    } => {
      const created: ReturnType<typeof createFakeRuntime>[] = []
      const forwardedEvents: AcpRuntimeEvent[] = []
      const coordinator = new AcpRuntimeCoordinator(
        (callbacks) => {
          const fake = createFakeRuntime({
            frameworkId: 'codex',
            sessionIds: ['session-1'],
            callbacks
          })
          created.push(fake)
          return fake.runtime
        },
        { onEvent: (event) => forwardedEvents.push(event) }
      )

      return { coordinator, created, forwardedEvents }
    }
    const event: AcpRuntimeEvent = {
      id: 'acp-event-1',
      timestamp: 1,
      kind: 'system',
      level: 'info',
      sessionId: 'session-1',
      title: 'event'
    }
    const first = createCoordinator()
    const second = createCoordinator()

    await first.coordinator.createSession()
    await second.coordinator.createSession()
    first.created[0].emitEvent(event)
    second.created[0].emitEvent(event)

    expect(first.forwardedEvents[0].id).not.toBe(second.forwardedEvents[0].id)
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
    expect(vi.mocked(created[1].runtime.sendPrompt)).toHaveBeenCalledWith(
      {
        sessionId: 'old-session',
        text: '[Auditor] fix this',
        historyPreamble: 'prior transcript',
        contextReset: true,
        provenanceContext: { promptMessageId: expect.stringMatching(/^prompt-/u) }
      },
      'prompt-attempt-1'
    )
    expect(vi.mocked(created[0].runtime.sendPrompt)).not.toHaveBeenCalled()
  })

  it('removes a runtime from aggregation after its retirement completes', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const onSessionUnavailable = vi.fn()
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) => {
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
      },
      {},
      '',
      undefined,
      undefined,
      onSessionUnavailable
    )

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
    expect(onSessionUnavailable).toHaveBeenCalledOnce()
    expect(onSessionUnavailable).toHaveBeenCalledWith('session-1')
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
