import { describe, expect, it, vi } from 'vitest'

import type {
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpPromptRequest,
  AcpRuntimeEvent,
  AcpStateSnapshot,
  AcpStateUpdate
} from '../../shared/acp'
import { MAX_ACP_RUNTIME_EVENTS, toAcpStateCommandResponse } from '../../shared/acp'
import type { AcpSessionAgentTarget } from '../../shared/acp'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import type { AcpRuntime, AcpRuntimeCallbacks } from './runtime'
import type { ConversationPermissionGrantStore } from './permission-broker'
import type { AgentModelChangeTarget } from '../agent-framework'
import type { AgentFrameworkId } from '../../shared/settings'
import { DelegateMessageParkedError } from '../delegation/execution-port'
import type { RootDelegatedWorkControl } from '../delegation/production-composition'
import { createProjectHandlers } from '../projects/ipc'

const createDeferred = <Value = void>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
  reject: (error: unknown) => void
} => {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
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

const retainedSessionCancellationKeys = (owner: object): unknown[] =>
  Object.entries(owner).flatMap(([name, value]) =>
    name.includes('sessionCancellation') && value instanceof Map ? Array.from(value.keys()) : []
  )

const createFakeRuntime = (options: {
  frameworkId: AgentFrameworkId
  sessionIds: string[]
  callbacks: AcpRuntimeCallbacks
  permissionGrantStore?: ConversationPermissionGrantStore
  beforePromptStart?: () => Promise<void>
  beforeProviderPromptAccepted?: () => Promise<void>
  skipProviderPromptAccepted?: boolean
  beforeReviewerSession?: () => Promise<void>
  beforeResume?: () => Promise<void>
  afterResumeAttached?: () => Promise<void>
  eligibleAttachmentUri?: string
  activePromptSessions?: { projectId: string; sessionId: string }[]
  quitBlockingSessions?: { projectId: string; sessionId: string }[]
  prompt?: (sessionId: string) => Promise<unknown>
  holdAfterPromptEnded?: () => Promise<void>
  stateOnlyEventUpdates?: boolean
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
  steerFollowUp: ReturnType<typeof vi.fn>
  steerSideChatAdvisory: ReturnType<typeof vi.fn>
  applyReasoningEffortChange: ReturnType<typeof vi.fn>
  applyModelChange: ReturnType<typeof vi.fn>
  captureBackend: ReturnType<typeof vi.fn>
  beginProviderTurnObservation: ReturnType<typeof vi.fn>
  captureSessionModel: ReturnType<typeof vi.fn>
  setPermissionProfile: ReturnType<typeof vi.fn>
  setMemoryEnabled: ReturnType<typeof vi.fn>
  respondToPermission: ReturnType<typeof vi.fn>
  requestUserInput: ReturnType<typeof vi.fn>
  disableLiteratureContext: ReturnType<typeof vi.fn>
  callSessionPlan: ReturnType<typeof vi.fn>
  getSessionPlanProjection: ReturnType<typeof vi.fn>
  respondSessionPlan: ReturnType<typeof vi.fn>
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
  const createSession = vi.fn(async (request: { projectId?: string } = {}) => {
    const sessionId = options.sessionIds[sessionIndex]
    sessionIndex += 1
    sessionProjects.set(sessionId, request.projectId ?? 'Artifacts')
    snapshot = { ...snapshot, sessionId, sessionIds: [...snapshot.sessionIds, sessionId] }
    options.callbacks.onStateChanged?.(snapshot)
    return { sessionId, cwd: '/workspace', frameworkId: options.frameworkId }
  })
  const resumeSession = vi.fn(
    async ({ sessionId, projectId }: { sessionId: string; projectId?: string }) => {
      await options.beforeResume?.()
      sessionProjects.set(sessionId, projectId ?? 'Artifacts')
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
  const captureBackend = vi.fn(() => ({ backendId: `${options.frameworkId}:owned` }) as never)
  const beginProviderTurnObservation = vi.fn(async () => ({
    finalize: vi.fn(async () => ({})),
    cancel: vi.fn()
  }))
  const captureSessionModel = vi.fn((sessionId: string) => ({
    backend: { backendId: `${options.frameworkId}:owned` },
    appliedModel: `${sessionId}:applied`
  }))
  const setPermissionProfile = vi.fn(async () => snapshot)
  const setMemoryEnabled = vi.fn()
  const respondToPermission = vi.fn((response: AcpPermissionResponse) => {
    options.callbacks.onPermissionSettled?.(
      response.requestId,
      response.cancelled ? 'cancelled' : 'resolved'
    )
    return snapshot
  })
  const requestUserInput = vi.fn(async () => ({ action: 'answered', answer: 'Minimal' }))
  const disableLiteratureContext = vi.fn(async () => undefined)
  const callSessionPlan = vi.fn(async () => ({ ok: true }))
  const getSessionPlanProjection = vi.fn(async () => null)
  const respondSessionPlan = vi.fn(async () => ({ changed: false }))
  const shutdown = vi.fn()
  const shutdownForQuit = vi.fn(async () => ({ reaped: true }))
  const shutdownForUpdateGate = vi.fn(async () => ({ reaped: true }))
  const runPrompt = async (
    { sessionId }: { sessionId: string },
    promptAttemptId?: string,
    onPromptAdmitted?: () => Promise<AcpPromptRequest['provenanceContext']>
  ): Promise<unknown> => {
    await options.beforePromptStart?.()
    await onPromptAdmitted?.()
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

    let ended = false
    const endPrompt = (): void => {
      if (ended) return
      ended = true
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
    try {
      const prompt = options.prompt
        ? options.prompt(sessionId)
        : Promise.resolve({ stopReason: 'end_turn' })
      await options.beforeProviderPromptAccepted?.()
      if (!options.skipProviderPromptAccepted) {
        options.callbacks.onProviderPromptAccepted?.(sessionId, promptAttemptId)
      }
      const result = await prompt
      endPrompt()
      await options.holdAfterPromptEnded?.()
      return result
    } finally {
      endPrompt()
    }
  }
  const sendPrompt = vi.fn(runPrompt)
  const steerFollowUp = vi.fn(async () => ({
    injected: true as const,
    transport: 'acp-steering' as const,
    messageId: 'message-steer-1'
  }))
  const steerSideChatAdvisory = vi.fn(async () => ({
    injected: true as const,
    promptMessageId: 'prompt-live'
  }))
  const sendApplicationPrompt = vi.fn(
    (
      ...[request, _attribution, promptAttemptId]: Parameters<AcpRuntime['sendApplicationPrompt']>
    ) => {
      void _attribution
      return runPrompt(request, promptAttemptId)
    }
  )
  const sendAppContinuation = vi.fn(runPrompt)
  const runtime = {
    getSnapshot: () => snapshot,
    getState: () => toAcpStateCommandResponse({ ...snapshot, revision: 0 }).result,
    getActivePromptSessions: () => options.activePromptSessions ?? [],
    getQuitBlockingPromptSessions: () => options.quitBlockingSessions ?? [],
    hasLiveSession: (projectId: string, sessionId: string) =>
      snapshot.sessionIds.includes(sessionId) && sessionProjects.get(sessionId) === projectId,
    liveSessionProjectId: (sessionId: string) => sessionProjects.get(sessionId),
    isSessionUsingFramework: (sessionId: string, frameworkId: string) =>
      snapshot.sessionIds.includes(sessionId) && options.frameworkId === frameworkId,
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
    sendApplicationPrompt,
    sendAppContinuation,
    steerFollowUp,
    steerSideChatAdvisory,
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
    captureBackend,
    beginProviderTurnObservation,
    captureSessionModel,
    setPermissionProfile,
    setMemoryEnabled,
    respondToPermission,
    requestUserInput,
    disableLiteratureContext,
    callSessionPlan,
    getSessionPlanProjection,
    respondSessionPlan,
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
    steerFollowUp,
    steerSideChatAdvisory,
    applyReasoningEffortChange,
    applyModelChange,
    captureBackend,
    beginProviderTurnObservation,
    captureSessionModel,
    setPermissionProfile,
    setMemoryEnabled,
    respondToPermission,
    requestUserInput,
    disableLiteratureContext,
    callSessionPlan,
    getSessionPlanProjection,
    respondSessionPlan,
    emitEvent: (event) => {
      snapshot = {
        ...snapshot,
        events: [...snapshot.events, event].slice(
          options.stateOnlyEventUpdates ? -MAX_ACP_RUNTIME_EVENTS : 0
        )
      }
      options.callbacks.onEvent?.(event)
      options.callbacks.onStateChanged?.(
        options.stateOnlyEventUpdates
          ? toAcpStateCommandResponse({ ...snapshot, revision: 0 }).result
          : snapshot
      )
    },
    emitPermission: (request) => {
      snapshot = { ...snapshot, pendingPermissions: [...snapshot.pendingPermissions, request] }
      options.callbacks.onPermissionRequest?.(request)
      options.callbacks.onStateChanged?.(snapshot)
    },
    emitState: (overrides) => {
      snapshot = { ...snapshot, ...overrides }
      options.callbacks.onStateChanged?.(
        options.stateOnlyEventUpdates
          ? toAcpStateCommandResponse({ ...snapshot, revision: 0 }).result
          : snapshot
      )
    },
    setStateSilently: (overrides) => {
      snapshot = { ...snapshot, ...overrides }
    },
    emitRetired: () => options.callbacks.onRetired?.()
  }
}

describe('AcpRuntimeCoordinator', () => {
  it('lazily recreates a runtime for cold Session Plan operations after retirement', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: 'claude-code',
        sessionIds: [],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })

    created[0].emitRetired()

    await coordinator.getSessionPlanProjection('project-1', 'session-1')
    await coordinator.callSessionPlan({ sessionId: 'session-1' } as never)
    await coordinator.respondSessionPlan({
      projectId: 'project-1',
      sessionId: 'session-1',
      feedback: 'Revise the Plan.'
    })

    expect(created).toHaveLength(2)
    expect(created[1].getSessionPlanProjection).toHaveBeenCalledWith('project-1', 'session-1')
    expect(created[1].callSessionPlan).toHaveBeenCalledOnce()
    expect(created[1].respondSessionPlan).toHaveBeenCalledOnce()
  })

  it('forwards a Codex WebSocket fallback from a runtime to the application callback', () => {
    const onCodexWebSocketFallback = vi.fn()
    let runtimeCallbacks: AcpRuntimeCallbacks | undefined
    new AcpRuntimeCoordinator(
      (callbacks) => {
        runtimeCallbacks = callbacks
        return createFakeRuntime({
          frameworkId: 'codex',
          sessionIds: ['session-1'],
          callbacks
        }).runtime
      },
      { onCodexWebSocketFallback }
    )

    runtimeCallbacks?.onCodexWebSocketFallback?.()

    expect(onCodexWebSocketFallback).toHaveBeenCalledOnce()
  })

  it('routes Sessions through runtimes keyed by their explicit agent target', async () => {
    const targets: Array<AcpSessionAgentTarget | undefined> = []
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks, _permissionGrants, target) => {
      targets.push(target)
      const index = created.length
      const fake = createFakeRuntime({
        frameworkId: target?.frameworkId === 'opencode' ? 'opencode' : 'claude-code',
        sessionIds: [`session-${index}-a`, `session-${index}-b`],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })
    const targetA = {
      frameworkId: 'claude-code',
      providerId: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'high'
    } as const
    const targetB = {
      frameworkId: 'opencode',
      providerId: 'provider-b',
      model: 'model-b',
      reasoningEffort: 'low'
    } as const

    const first = await coordinator.createSession({ agentTarget: targetA })
    const second = await coordinator.createSession({ agentTarget: targetA })
    await coordinator.resumeSession({
      sessionId: first.sessionId,
      cwd: '/workspace',
      agentTarget: targetB
    })

    expect(targets).toEqual([undefined, targetA, targetB])
    expect(created[1].createSession).toHaveBeenCalledTimes(2)
    expect(created[2].resumeSession).toHaveBeenCalledWith({
      sessionId: first.sessionId,
      cwd: '/workspace',
      agentTarget: targetB
    })
    expect(created[1].requestRetirement).not.toHaveBeenCalled()

    await coordinator.resumeSession({
      sessionId: second.sessionId,
      cwd: '/workspace',
      agentTarget: targetB
    })

    expect(created[1].requestRetirement).toHaveBeenCalledOnce()

    created[1].emitState({})
    expect(coordinator.captureSessionBackend(first.sessionId)).toMatchObject({
      backendId: 'opencode:owned'
    })
  })

  it.each(['claude-code', 'opencode', 'codex'] as const)(
    'routes a background activity resume through its explicit %s Session target',
    async (frameworkId) => {
      const targets: Array<AcpSessionAgentTarget | undefined> = []
      const created: ReturnType<typeof createFakeRuntime>[] = []
      const coordinator = new AcpRuntimeCoordinator((callbacks, _permissionGrants, target) => {
        targets.push(target)
        const fake = createFakeRuntime({
          frameworkId: target?.frameworkId ?? 'claude-code',
          sessionIds: [`session-${created.length}`],
          callbacks
        })
        created.push(fake)
        return fake.runtime
      })
      const agentTarget = {
        frameworkId,
        providerId: 'provider-1',
        model: 'model-1',
        reasoningEffort: 'high'
      } as const

      await coordinator.withActivity(
        {
          session: {
            sessionId: 'detached-session',
            cwd: '/workspace',
            projectId: 'project-1',
            memoryEnabled: false,
            agentTarget
          }
        },
        (runtime) =>
          runtime.sendApplicationPrompt(
            { sessionId: 'detached-session', text: '[Auditor] correct this' },
            {
              kind: 'application',
              feature: 'reviewer',
              purpose: 'correction',
              causeReviewId: 'review-1'
            }
          )
      )

      expect(targets).toEqual([undefined, agentTarget])
      expect(created[1].resumeSession).toHaveBeenCalledWith({
        sessionId: 'detached-session',
        cwd: '/workspace',
        projectId: 'project-1',
        memoryEnabled: false,
        agentTarget
      })
      expect(vi.mocked(created[1].runtime.sendApplicationPrompt)).toHaveBeenCalledOnce()
      expect(vi.mocked(created[0].runtime.sendApplicationPrompt)).not.toHaveBeenCalled()
    }
  )

  it('reconnects only targeted runtimes using the edited provider', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: 'claude-code',
        sessionIds: [`session-${created.length}`],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })
    const target = (providerId: string): AcpSessionAgentTarget => ({
      frameworkId: 'claude-code',
      providerId,
      model: 'model',
      reasoningEffort: 'high'
    })

    await coordinator.createSession({ agentTarget: target('provider-a') })
    await coordinator.createSession({ agentTarget: target('provider-b') })
    await coordinator.requestProviderReconnect(['provider-a'], false)

    expect(created[0].requestProviderReconnect).not.toHaveBeenCalled()
    expect(created[1].requestProviderReconnect).toHaveBeenCalledOnce()
    expect(created[2].requestProviderReconnect).not.toHaveBeenCalled()
  })

  it('retires an unused targeted runtime after Session creation fails', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks, _permissionGrants, target) => {
      const fake = createFakeRuntime({
        frameworkId: target?.frameworkId ?? 'claude-code',
        sessionIds: [`session-${created.length}`],
        callbacks
      })
      if (target) fake.createSession.mockRejectedValue(new Error('create failed'))
      created.push(fake)
      return fake.runtime
    })
    const agentTarget = {
      frameworkId: 'opencode',
      providerId: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'high'
    } as const

    await expect(coordinator.createSession({ agentTarget })).rejects.toThrow('create failed')

    expect(created[1].requestRetirement).toHaveBeenCalledOnce()
    await expect(coordinator.createSession({ agentTarget })).rejects.toThrow('create failed')
    expect(created).toHaveLength(3)
  })

  it('retires an unused targeted runtime after Session resume fails', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks, _permissionGrants, target) => {
      const fake = createFakeRuntime({
        frameworkId: target?.frameworkId ?? 'claude-code',
        sessionIds: [`session-${created.length}`],
        callbacks
      })
      if (target) fake.resumeSession.mockRejectedValue(new Error('resume failed'))
      created.push(fake)
      return fake.runtime
    })
    const session = await coordinator.createSession()

    await expect(
      coordinator.resumeSession({
        sessionId: session.sessionId,
        cwd: '/workspace',
        agentTarget: {
          frameworkId: 'opencode',
          providerId: 'provider-a',
          model: 'model-a',
          reasoningEffort: 'high'
        }
      })
    ).rejects.toThrow('resume failed')

    expect(created[1].requestRetirement).toHaveBeenCalledOnce()
    expect(created[0].requestRetirement).not.toHaveBeenCalled()
  })

  it('retires default and targeted generations after a global framework switch', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks, _permissionGrants, target) => {
      const fake = createFakeRuntime({
        frameworkId: target?.frameworkId ?? 'claude-code',
        sessionIds: [`session-${created.length}`],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })
    const target = (frameworkId: 'claude-code' | 'opencode'): AcpSessionAgentTarget => ({
      frameworkId,
      providerId: `${frameworkId}-provider`,
      model: `${frameworkId}-model`,
      reasoningEffort: 'high'
    })

    await coordinator.createSession({ agentTarget: target('claude-code') })
    await coordinator.createSession({ agentTarget: target('opencode') })
    await coordinator.requestAgentFrameworkSwitch()

    expect(created).toHaveLength(3)
    expect(
      created.every(({ requestRetirement }) => requestRetirement.mock.calls.length === 1)
    ).toBe(true)
  })

  it('retires the default and matching targeted generations after a scoped framework switch', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks, _permissionGrants, target) => {
      const fake = createFakeRuntime({
        frameworkId: target?.frameworkId ?? 'codex',
        sessionIds: [`session-${created.length}`],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })
    const target = (frameworkId: 'claude-code' | 'opencode'): AcpSessionAgentTarget => ({
      frameworkId,
      providerId: `${frameworkId}-provider`,
      model: `${frameworkId}-model`,
      reasoningEffort: 'high'
    })

    await coordinator.createSession({ agentTarget: target('claude-code') })
    await coordinator.createSession({ agentTarget: target('opencode') })
    await coordinator.requestAgentFrameworkSwitch('claude-code')

    expect(created[0].requestRetirement).toHaveBeenCalledOnce()
    expect(created[1].requestRetirement).toHaveBeenCalledOnce()
    expect(created[2].requestRetirement).not.toHaveBeenCalled()
  })

  it('reloads Skills across default and targeted generations', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks, _permissionGrants, target) => {
      const fake = createFakeRuntime({
        frameworkId: target?.frameworkId ?? 'codex',
        sessionIds: [`session-${created.length}`],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })
    const target: AcpSessionAgentTarget = {
      frameworkId: 'opencode',
      providerId: 'opencode-provider',
      model: 'opencode-model',
      reasoningEffort: 'high'
    }

    await coordinator.createSession()
    await coordinator.createSession({ agentTarget: target })
    await coordinator.requestSkillsReload()

    expect(created).toHaveLength(2)
    expect(created[0].requestRetirement).toHaveBeenCalledOnce()
    expect(created[1].requestRetirement).toHaveBeenCalledOnce()
  })

  it('reloads framework Skills only for matching targeted generations', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks, _permissionGrants, target) => {
      const fake = createFakeRuntime({
        frameworkId: target?.frameworkId ?? 'codex',
        sessionIds: [`session-${created.length}`],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })
    const target = (frameworkId: 'claude-code' | 'opencode'): AcpSessionAgentTarget => ({
      frameworkId,
      providerId: `${frameworkId}-provider`,
      model: `${frameworkId}-model`,
      reasoningEffort: 'high'
    })

    await coordinator.createSession({ agentTarget: target('claude-code') })
    await coordinator.createSession({ agentTarget: target('opencode') })
    await coordinator.requestSkillsReloadForFramework('opencode')

    expect(created[0].requestRetirement).not.toHaveBeenCalled()
    expect(created[1].requestRetirement).not.toHaveBeenCalled()
    expect(created[2].requestRetirement).toHaveBeenCalledOnce()
  })

  it('recreates a targeted runtime after synchronous shutdown clears ownership', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: 'claude-code',
        sessionIds: [`session-${created.length}`],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })
    const agentTarget = {
      frameworkId: 'claude-code',
      providerId: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'high'
    } as const

    await coordinator.createSession({ agentTarget })
    coordinator.shutdown()
    await coordinator.createSession({ agentTarget })

    expect(created).toHaveLength(3)
    expect(created[2].createSession).toHaveBeenCalledOnce()
  })

  it('publishes snapshots with a coordinator-wide monotonic revision', () => {
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) =>
        createFakeRuntime({
          frameworkId: 'claude-code',
          sessionIds: ['session-1'],
          callbacks
        }).runtime
    )

    expect(coordinator.getSnapshot().revision).toBe(1)
    expect(coordinator.getSnapshot().revision).toBe(2)
  })

  it('keeps snapshot publication available when no incremental event adapter is configured', () => {
    let incrementalPublicationConfigured = true
    new AcpRuntimeCoordinator(
      (callbacks) => {
        incrementalPublicationConfigured = callbacks.onEvent !== undefined
        return createFakeRuntime({
          frameworkId: 'claude-code',
          sessionIds: ['session-1'],
          callbacks
        }).runtime
      },
      { onStateChanged: vi.fn() }
    )

    expect(incrementalPublicationConfigured).toBe(false)
  })

  it('does not repeat retained event history through incremental state and command responses', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const stateChanges: AcpStateUpdate[] = []
    const incrementalEvents: AcpRuntimeEvent[] = []
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
      {
        onStateChanged: (state) => stateChanges.push(state),
        onEvent: (event) => incrementalEvents.push(event)
      }
    )
    const retainedPayload = `retained-tool-output:${'x'.repeat(8_000)}`

    created[0].emitEvent({
      id: 'large-tool-event',
      timestamp: 1,
      kind: 'tool',
      level: 'info',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      status: 'completed',
      rawOutput: retainedPayload
    })
    created[0].emitState({ status: 'connected' })
    const commandResponse = await coordinator.connect()

    expect(incrementalEvents).toHaveLength(1)
    expect.soft(JSON.stringify(stateChanges.at(-1))).not.toContain(retainedPayload)
    expect.soft(JSON.stringify(commandResponse)).not.toContain(retainedPayload)
  })

  it('forgets published event ids after the runtime event window evicts them', async () => {
    const retirement = createDeferred<void>()
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const forwardedEvents: AcpRuntimeEvent[] = []
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) => {
        const fake = createFakeRuntime({
          frameworkId: created.length === 0 ? 'codex' : 'claude-code',
          sessionIds: [`agent-session-${created.length + 1}`],
          callbacks,
          stateOnlyEventUpdates: true
        })
        created.push(fake)
        return fake.runtime
      },
      { onEvent: (event) => forwardedEvents.push(event) }
    )
    const session = await coordinator.createSession()
    const message = (id: string, timestamp: number): AcpRuntimeEvent => ({
      id,
      timestamp,
      kind: 'message',
      level: 'info',
      sessionId: session.sessionId,
      role: 'assistant',
      text: id
    })
    const evictedEvent = message('evicted-message', 0)

    created[0].emitEvent(evictedEvent)
    for (let index = 1; index <= MAX_ACP_RUNTIME_EVENTS; index += 1) {
      created[0].emitEvent(message(`retained-message-${index}`, index))
    }
    expect(forwardedEvents).toHaveLength(MAX_ACP_RUNTIME_EVENTS + 1)

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
    created[0].emitState({ promptInFlight: false, promptInFlightSessionIds: [] })
    await resumeRequest

    created[0].emitEvent(evictedEvent)
    expect(forwardedEvents).toHaveLength(MAX_ACP_RUNTIME_EVENTS + 1)

    retirement.resolve()
    await switchRequest
  })

  it('retains snapshot-only events after a new runtime generation adopts the session', async () => {
    const retirement = createDeferred<void>()
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const snapshots: AcpStateSnapshot[] = []
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
      { onStateChanged: (snapshot) => snapshots.push(snapshot as AcpStateSnapshot) }
    )

    const session = await coordinator.createSession()
    created[0].emitEvent({
      id: 'old-owner-message',
      timestamp: 1,
      kind: 'message',
      level: 'info',
      sessionId: session.sessionId,
      role: 'assistant',
      text: 'published before adoption'
    })
    expect(snapshots.at(-1)?.events.map((event) => event.id)).toEqual([
      expect.stringMatching(runtimeEventId(1, 'old-owner-message'))
    ])

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
    created[0].emitState({ promptInFlight: false, promptInFlightSessionIds: [] })
    await resumeRequest

    expect(coordinator.getSnapshot().events.map((event) => event.id)).toContainEqual(
      expect.stringMatching(runtimeEventId(1, 'old-owner-message'))
    )

    retirement.resolve()
    await switchRequest
  })

  it('does not capture the process Active backend for a Session without an owning runtime', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: 'claude-code',
        sessionIds: ['owned-session'],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })

    expect(coordinator.captureSessionBackend('missing-session')).toBeUndefined()
    expect(created[0].captureBackend).not.toHaveBeenCalled()
    await coordinator.createSession()
    expect(coordinator.captureSessionBackend('owned-session')).toMatchObject({
      backendId: 'claude-code:owned'
    })
    expect(created[0].captureBackend).toHaveBeenCalledOnce()
  })

  it('captures Session model facts only from the runtime that owns the Session', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: 'opencode',
        sessionIds: ['owned-session'],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })

    expect(coordinator.captureSessionModel('missing-session')).toBeUndefined()
    expect(created[0].captureSessionModel).not.toHaveBeenCalled()
    await coordinator.createSession()
    expect(coordinator.captureSessionModel('owned-session')).toEqual({
      backend: { backendId: 'opencode:owned' },
      appliedModel: 'owned-session:applied'
    })
    expect(created[0].captureSessionModel).toHaveBeenCalledWith('owned-session')
  })

  it('notifies the reconciliation observer only after resumed runtime ownership commits', async () => {
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
    const observer = vi.fn(async () => undefined)
    coordinator.setSessionResumeObserver(observer)
    const request = {
      sessionId: 'session-1',
      cwd: '/workspace',
      specialistId: 'specialist-new',
      specialistBindingPending: true as const
    }

    const response = await coordinator.resumeSession(request)

    expect(created[0].resumeSession).toHaveBeenCalledWith(request)
    expect(observer).toHaveBeenCalledWith(request, response)
    expect(coordinator.getSnapshot().sessionIds).toContain('session-1')
  })

  it('retries pending binding reconciliation without resuming the attached provider twice', async () => {
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
    const observer = vi
      .fn()
      .mockRejectedValueOnce(new Error('pending marker clear failed'))
      .mockResolvedValueOnce(undefined)
    coordinator.setSessionResumeObserver(observer)
    const request = {
      sessionId: 'session-1',
      cwd: '/workspace',
      specialistId: 'specialist-new',
      specialistBindingPending: true as const
    }

    await expect(coordinator.resumeSession(request)).rejects.toThrow('pending marker clear failed')
    await expect(coordinator.resumeSession(request)).resolves.toMatchObject({
      sessionId: 'session-1'
    })

    expect(created[0].resumeSession).toHaveBeenCalledOnce()
    expect(observer).toHaveBeenCalledTimes(2)
    expect(coordinator.getSnapshot().sessionIds).toContain('session-1')
  })

  it('projects delegated permissions and cascades root permission and Stop controls', async () => {
    const rootPermission: AcpPermissionRequest = {
      requestId: 'delegated:permission-1',
      sessionId: 'session-1',
      toolCallId: 'child-frame',
      title: 'curl https://example.test/data?token=test-delegated-permission-secret',
      rawInput: {
        command: 'curl https://example.test/data?token=test-delegated-permission-secret'
      },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      delegated: {
        frameId: 'child-frame',
        attemptId: 'child-attempt',
        childTitle: 'Evidence child',
        riskScope: 'This call only'
      }
    }
    let listener: ((event: unknown) => void) | undefined
    const delegated = {
      pendingPermissions: vi.fn(() => [rootPermission]),
      subscribe: vi.fn((next: (event: unknown) => void) => {
        listener = next
        return () => undefined
      }),
      respondToPermission: vi.fn(async () => true),
      setPermissionProfile: vi.fn(async () => undefined),
      wakeMessages: vi.fn(async () => undefined),
      stopSession: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      deleteProject: vi.fn(async () => undefined)
    }
    const permissionEvents: unknown[] = []
    const stateChanges: AcpStateSnapshot[] = []
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
      {
        onPermissionRequest: (request) => permissionEvents.push(request),
        onStateChanged: (snapshot) => stateChanges.push(snapshot as AcpStateSnapshot)
      },
      '',
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      delegated
    )

    const initialSnapshot = coordinator.getSnapshot()
    listener?.({ kind: 'permission-requested', request: rootPermission })
    expect(initialSnapshot.pendingPermissions).toHaveLength(1)
    expect(permissionEvents).toHaveLength(1)
    expect(stateChanges.at(-1)?.pendingPermissions).toHaveLength(1)
    expect(
      JSON.stringify({ initialSnapshot, permissionEvents, latestState: stateChanges.at(-1) })
    ).not.toContain('test-delegated-permission-secret')
    expect(JSON.stringify(rootPermission)).toContain('test-delegated-permission-secret')

    await coordinator.respondToPermission({
      requestId: rootPermission.requestId,
      optionId: 'allow'
    })
    expect(delegated.respondToPermission).toHaveBeenCalledWith({
      requestId: rootPermission.requestId,
      optionId: 'allow'
    })
    expect(created[0].respondToPermission).not.toHaveBeenCalled()

    await coordinator.resumeSession({ sessionId: 'session-1', cwd: '/workspace' })
    expect(delegated.wakeMessages).toHaveBeenCalledWith('session-1')

    await coordinator.setPermissionProfile({ sessionId: 'session-1', profile: 'ask' })
    expect(created[0].setPermissionProfile).toHaveBeenCalledWith({
      sessionId: 'session-1',
      profile: 'ask'
    })
    expect(delegated.setPermissionProfile).toHaveBeenCalledWith('session-1', 'ask')

    coordinator.setMemoryEnabled('session-1', false)
    expect(created[0].setMemoryEnabled).toHaveBeenCalledWith('session-1', false)

    await coordinator.cancelPrompt({ sessionId: 'session-1' })
    expect(delegated.stopSession).not.toHaveBeenCalled()
    expect(created[0].cancelPrompt).toHaveBeenCalledWith({ sessionId: 'session-1' })

    created[0].cancelPrompt.mockRejectedValueOnce(new Error('root cancel failed'))
    await expect(coordinator.cancelPrompt({ sessionId: 'session-1' })).rejects.toThrow(
      'root cancel failed'
    )
    expect(delegated.stopSession).not.toHaveBeenCalled()

    await expect(coordinator.prepareForQuit()).resolves.toBe('completed')
    expect(delegated.stopAll).toHaveBeenCalledOnce()
  })

  it('fences only the active Conversation Turn and exposes a separate Subagent Stop scope', async () => {
    const prompt = createDeferred<unknown>()
    let rejectChildCancellation!: (error: Error) => void
    const childCancellation = new Promise<void>((_resolve, reject) => {
      rejectChildCancellation = reject
    })
    const cancelTurn = vi.fn(() => childCancellation)
    const stopActiveBranch = vi.fn(async () => undefined)
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const delegated = {
      pendingPermissions: vi.fn(() => []),
      subscribe: vi.fn(() => () => undefined),
      respondToPermission: vi.fn(async () => false),
      setPermissionProfile: vi.fn(async () => undefined),
      cancelTurn,
      stopActiveBranch,
      stopSession: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      deleteProject: vi.fn(async () => undefined)
    }
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) => {
        const fake = createFakeRuntime({
          frameworkId: 'codex',
          sessionIds: ['session-1'],
          callbacks,
          prompt: () => prompt.promise
        })
        created.push(fake)
        return fake.runtime
      },
      {},
      '',
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      delegated
    )
    const session = await coordinator.createSession({ cwd: '/workspace' })
    const running = coordinator.sendPrompt({
      sessionId: session.sessionId,
      text: 'Turn B',
      provenanceContext: { promptMessageId: 'turn-b-message' }
    })
    await Promise.resolve()

    const cancelling = coordinator.cancelPrompt({ sessionId: session.sessionId })
    await vi.waitFor(() => expect(created[0].cancelPrompt).toHaveBeenCalledOnce())
    expect(cancelTurn).toHaveBeenCalledWith('session-1', 'turn-b-message')
    expect(delegated.stopSession).not.toHaveBeenCalled()
    rejectChildCancellation(new Error('one child Stop failed'))
    await expect(cancelling).rejects.toThrow('one child Stop failed')
    await coordinator.cancelPrompt({ sessionId: session.sessionId, scope: 'subagents' })
    expect(stopActiveBranch).toHaveBeenCalledWith('session-1')
    prompt.resolve({ stopReason: 'cancelled' })
    await running
  })

  it('combines only the quit-blocking prompts reported by each runtime generation', async () => {
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) =>
        createFakeRuntime({
          frameworkId: 'claude-code',
          sessionIds: ['session-1'],
          callbacks,
          quitBlockingSessions: [{ projectId: 'project-1', sessionId: 'session-running' }]
        }).runtime
    )
    await coordinator.connect()

    expect(coordinator.getQuitBlockingPromptSessions()).toEqual([
      { projectId: 'project-1', sessionId: 'session-running' }
    ])
  })

  it.each([
    ['Claude Code', 'claude-code'],
    ['OpenCode', 'opencode'],
    ['Codex shared runtime', 'codex']
  ] as const)(
    'observes provider acceptance through %s without changing completion',
    async (_route, frameworkId) => {
      let created!: ReturnType<typeof createFakeRuntime>
      const coordinator = new AcpRuntimeCoordinator((callbacks) => {
        created = createFakeRuntime({ frameworkId, sessionIds: ['session-1'], callbacks })
        return created.runtime
      })
      const session = await coordinator.createSession()
      const onProviderPromptAccepted = vi.fn()
      const admittedProvenance = {
        promptMessageId: 'prompt-1',
        messageBranchId: 'branch-2',
        runtimeSegmentId: 'runtime-segment-2'
      }
      const onPromptAdmitted = vi.fn(async () => admittedProvenance)

      await coordinator.sendPromptObserved(
        { sessionId: session.sessionId, text: 'Research this.' },
        onProviderPromptAccepted,
        onPromptAdmitted
      )

      expect(onPromptAdmitted).toHaveBeenCalledOnce()
      expect(onProviderPromptAccepted).toHaveBeenCalledOnce()
      expect(onPromptAdmitted.mock.invocationCallOrder[0]).toBeLessThan(
        onProviderPromptAccepted.mock.invocationCallOrder[0]
      )
      expect(created.sendPrompt.mock.calls[0]?.[0].provenanceContext).toEqual(admittedProvenance)
    }
  )

  it.each([
    ['Claude Code', 'claude-code'],
    ['OpenCode', 'opencode'],
    ['Codex Responses', 'codex'],
    ['Codex bridge', 'codex']
  ] as const)(
    'acknowledges a %s user prompt at provider acceptance before turn completion',
    async (_route, frameworkId) => {
      const completion = createDeferred<unknown>()
      let created!: ReturnType<typeof createFakeRuntime>
      const coordinator = new AcpRuntimeCoordinator((callbacks) => {
        created = createFakeRuntime({
          frameworkId,
          sessionIds: ['session-1'],
          callbacks,
          prompt: () => completion.promise
        })
        return created.runtime
      })
      const session = await coordinator.createSession()

      await expect(
        coordinator.startPrompt({ sessionId: session.sessionId, text: 'Research this.' })
      ).resolves.toBeUndefined()

      expect(created.sendPrompt).toHaveBeenCalledOnce()
      expect(coordinator.getSnapshot().promptInFlightSessionIds).toContain(session.sessionId)

      completion.resolve({ stopReason: 'end_turn' })
      await vi.waitFor(() =>
        expect(coordinator.getSnapshot().promptInFlightSessionIds).not.toContain(session.sessionId)
      )
    }
  )

  it.each([
    ['Claude Code', 'claude-code'],
    ['OpenCode', 'opencode'],
    ['Codex Responses', 'codex'],
    ['Codex bridge', 'codex']
  ] as const)(
    'admits a %s follow-up startPrompt after cancel without waiting for the cancelled turn to settle',
    async (_route, frameworkId) => {
      const firstTurn = createDeferred<unknown>()
      let created!: ReturnType<typeof createFakeRuntime>
      const coordinator = new AcpRuntimeCoordinator((callbacks) => {
        created = createFakeRuntime({
          frameworkId,
          sessionIds: ['session-1'],
          callbacks,
          prompt: () => firstTurn.promise
        })
        return created.runtime
      })
      const session = await coordinator.createSession()

      await coordinator.startPrompt({
        sessionId: session.sessionId,
        text: 'live turn'
      })
      expect(created.sendPrompt).toHaveBeenCalledOnce()

      await coordinator.cancelPrompt({ sessionId: session.sessionId })

      await expect(
        coordinator.startPrompt({
          sessionId: session.sessionId,
          text: 'Send now follow-up'
        })
      ).resolves.toBeUndefined()
      expect(created.sendPrompt).toHaveBeenCalledTimes(2)

      firstTurn.resolve({ stopReason: 'cancelled' })
      await vi.waitFor(() =>
        expect(coordinator.getSnapshot().promptInFlightSessionIds).not.toContain(session.sessionId)
      )
    }
  )

  it.each([
    ['Claude Code', 'claude-code'],
    ['OpenCode', 'opencode'],
    ['Codex Responses', 'codex'],
    ['Codex bridge', 'codex']
  ] as const)(
    'admits a %s follow-up startPrompt after end_turn without waiting for post-stop work',
    async (_route, frameworkId) => {
      const postStop = createDeferred<void>()
      let created!: ReturnType<typeof createFakeRuntime>
      const coordinator = new AcpRuntimeCoordinator((callbacks) => {
        created = createFakeRuntime({
          frameworkId,
          sessionIds: ['session-1'],
          callbacks,
          holdAfterPromptEnded: () => postStop.promise
        })
        return created.runtime
      })
      const session = await coordinator.createSession()

      await coordinator.startPrompt({
        sessionId: session.sessionId,
        text: 'live turn'
      })
      await vi.waitFor(() =>
        expect(coordinator.getSnapshot().promptInFlightSessionIds).not.toContain(session.sessionId)
      )

      await expect(
        coordinator.startPrompt({
          sessionId: session.sessionId,
          text: 'queued follow-up'
        })
      ).resolves.toBeUndefined()
      expect(created.sendPrompt).toHaveBeenCalledTimes(2)

      postStop.resolve()
    }
  )

  it('acknowledges a blocking provider prompt after local dispatch without waiting for output', async () => {
    const completion = createDeferred<unknown>()
    let created!: ReturnType<typeof createFakeRuntime>
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      created = createFakeRuntime({
        frameworkId: 'codex',
        sessionIds: ['session-1'],
        callbacks,
        skipProviderPromptAccepted: true,
        prompt: () => completion.promise
      })
      return created.runtime
    })
    const session = await coordinator.createSession()
    const admission = coordinator.startPrompt({
      sessionId: session.sessionId,
      text: 'Wait for the blocking model response.'
    })
    const outcome = Promise.race([
      admission.then(
        () => 'acknowledged' as const,
        () => 'rejected' as const
      ),
      new Promise<'still-pending'>((resolve) => setImmediate(() => resolve('still-pending')))
    ])

    await vi.waitFor(() => expect(created.sendPrompt).toHaveBeenCalledOnce())

    await expect(outcome).resolves.toBe('acknowledged')
    expect(coordinator.getSnapshot().promptInFlightSessionIds).toContain(session.sessionId)

    completion.resolve({ stopReason: 'end_turn' })
    await vi.waitFor(() =>
      expect(coordinator.getSnapshot().promptInFlightSessionIds).not.toContain(session.sessionId)
    )
  })

  it('rejects an immediately failed runtime dispatch before acknowledging application admission', async () => {
    const failure = new Error('Active session disposed')
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) =>
        createFakeRuntime({
          frameworkId: 'codex',
          sessionIds: ['session-1'],
          callbacks,
          skipProviderPromptAccepted: true,
          prompt: () => Promise.reject(failure)
        }).runtime
    )
    const session = await coordinator.createSession()

    await expect(
      coordinator.startPrompt({ sessionId: session.sessionId, text: 'Research this.' })
    ).rejects.toBe(failure)
  })

  it('keeps application admission independent from a missing provider acceptance update', async () => {
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) =>
        createFakeRuntime({
          frameworkId: 'claude-code',
          sessionIds: ['session-1'],
          callbacks,
          skipProviderPromptAccepted: true
        }).runtime
    )
    const session = await coordinator.createSession()

    await expect(
      coordinator.startPrompt({ sessionId: session.sessionId, text: 'Research this.' })
    ).resolves.toBeUndefined()
  })

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
    const session = await coordinator.createSession({ projectId: 'project-1' })

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

  it('classifies a continuation dispatch-guard rejection as proven pre-acceptance', async () => {
    let created!: ReturnType<typeof createFakeRuntime>
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      created = createFakeRuntime({
        frameworkId: 'codex',
        sessionIds: ['session-1'],
        callbacks
      })
      return created.runtime
    })
    const session = await coordinator.createSession()
    coordinator.setPromptDispatchAdmissionGuard(async () => {
      throw new Error('dispatch admission unavailable')
    })
    const onProviderPromptAccepted = vi.fn()

    await expect(
      coordinator.sendAppContinuationObserved(
        { sessionId: session.sessionId, text: 'retry safely' },
        onProviderPromptAccepted
      )
    ).rejects.toMatchObject({
      name: 'DelegateMessagePreAcceptanceError',
      message: 'dispatch admission unavailable'
    })
    expect(created.sendAppContinuation).not.toHaveBeenCalled()
    expect(onProviderPromptAccepted).not.toHaveBeenCalled()
  })

  it('reports completed user and application-owned root turns to delegated settlement watching', async () => {
    const rootTurnEnded = vi.fn(async () => undefined)
    let settlementLease = 0
    const rootTurnStarted = vi.fn(async () => `settlement-lease-${++settlementLease}`)
    const delegatedWork: RootDelegatedWorkControl = {
      pendingPermissions: () => [],
      subscribe: () => () => undefined,
      respondToPermission: async () => false,
      setPermissionProfile: async () => undefined,
      stopSession: async () => undefined,
      stopAll: async () => undefined,
      deleteSession: async () => undefined,
      deleteProject: async () => undefined,
      rootTurnStarted,
      rootTurnEnded
    }
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) =>
        createFakeRuntime({
          frameworkId: 'codex',
          sessionIds: ['session-1'],
          callbacks
        }).runtime,
      {},
      '',
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      delegatedWork
    )
    const session = await coordinator.createSession()

    await coordinator.sendPrompt({
      sessionId: session.sessionId,
      text: 'delegate in the background',
      provenanceContext: { promptMessageId: 'root-prompt' }
    })
    await coordinator.sendAppContinuation({
      sessionId: session.sessionId,
      text: 'application follow-up',
      provenanceContext: { promptMessageId: 'root-prompt' }
    })
    await coordinator.sendApplicationPrompt(
      {
        sessionId: session.sessionId,
        text: 'review correction',
        provenanceContext: { promptMessageId: 'review-prompt' }
      },
      {
        kind: 'application',
        feature: 'reviewer',
        purpose: 'correction',
        causeReviewId: 'review-1'
      }
    )

    expect(rootTurnEnded).toHaveBeenCalledTimes(3)
    expect(rootTurnEnded).toHaveBeenNthCalledWith(1, {
      sessionId: session.sessionId,
      originatingPromptId: 'root-prompt',
      clean: true,
      leaseId: 'settlement-lease-1'
    })
    expect(rootTurnEnded).toHaveBeenNthCalledWith(2, {
      sessionId: session.sessionId,
      originatingPromptId: 'root-prompt',
      clean: true,
      leaseId: 'settlement-lease-2'
    })
    expect(rootTurnEnded).toHaveBeenNthCalledWith(3, {
      sessionId: session.sessionId,
      originatingPromptId: 'review-prompt',
      clean: true,
      leaseId: 'settlement-lease-3'
    })
    expect(rootTurnStarted).toHaveBeenCalledTimes(3)
  })

  it.each(['cancel', 'handoff', 'delete'] as const)(
    'does not dispatch a root turn superseded by %s while its settlement baseline loads',
    async (supersede) => {
      const settlementStart = createDeferred<string | undefined>()
      const rootTurnStarted = vi.fn(async () => settlementStart.promise)
      const rootTurnEnded = vi.fn(async () => undefined)
      const delegatedWork: RootDelegatedWorkControl = {
        pendingPermissions: () => [],
        subscribe: () => () => undefined,
        respondToPermission: async () => false,
        setPermissionProfile: async () => undefined,
        stopSession: async () => undefined,
        stopAll: async () => undefined,
        deleteSession: async () => undefined,
        deleteProject: async () => undefined,
        rootTurnStarted,
        rootTurnEnded
      }
      let created!: ReturnType<typeof createFakeRuntime>
      const coordinator = new AcpRuntimeCoordinator(
        (callbacks) => {
          created = createFakeRuntime({
            frameworkId: 'codex',
            sessionIds: ['session-1'],
            callbacks
          })
          return created.runtime
        },
        {},
        '',
        undefined,
        undefined,
        undefined,
        {},
        undefined,
        delegatedWork
      )
      const session = await coordinator.createSession()
      const prompt = coordinator.sendPrompt({
        sessionId: session.sessionId,
        text: 'do not revive this prompt',
        provenanceContext: { promptMessageId: 'superseded-root-prompt' }
      })
      await vi.waitFor(() => expect(rootTurnStarted).toHaveBeenCalledOnce())

      if (supersede === 'cancel') {
        await coordinator.cancelPrompt({ sessionId: session.sessionId })
      } else if (supersede === 'handoff') {
        await coordinator.stopPromptForHandoff(session.sessionId)
      } else {
        await coordinator.deleteSession({ sessionId: session.sessionId })
      }
      await coordinator.waitForSessionInteractionRelease(session.sessionId)
      settlementStart.resolve('settlement-lease-1')

      await expect(prompt).rejects.toThrow('superseded before provider dispatch')
      expect(created.sendPrompt).not.toHaveBeenCalled()
      expect(rootTurnEnded).toHaveBeenCalledOnce()
      expect(rootTurnEnded).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        originatingPromptId: 'superseded-root-prompt',
        clean: false,
        leaseId: 'settlement-lease-1'
      })
      if (supersede === 'delete') {
        expect(retainedSessionCancellationKeys(coordinator)).not.toContain(session.sessionId)
      }
    }
  )

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
    await vi.waitFor(() =>
      expect(coordinator.capturePromptForHandoff(session.sessionId)).toBeDefined()
    )

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
    const onProviderPromptAccepted = vi.fn()
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) =>
        createFakeRuntime({
          frameworkId: 'codex',
          sessionIds: ['session-1'],
          callbacks,
          beforeProviderPromptAccepted: async () => acceptProviderPrompt.promise
        }).runtime,
      { onProviderPromptAccepted }
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
    expect(onProviderPromptAccepted).toHaveBeenCalledWith(
      session.sessionId,
      expect.stringMatching(/^prompt-attempt-/)
    )
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
    await vi.waitFor(() => expect(promptAttempt).toBe(1))
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

  it('waits for the active turn before disabling Literature context', async () => {
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
    const session = await coordinator.createSession({ projectId: 'project-1' })
    const running = coordinator.sendPrompt({ sessionId: session.sessionId, text: 'read' })
    await vi.waitFor(() => expect(created.sendPrompt).toHaveBeenCalledOnce())

    const disabling = coordinator.disableLiteratureContext(session.sessionId)
    await Promise.resolve()
    expect(created.disableLiteratureContext).not.toHaveBeenCalled()

    prompt.resolve({ stopReason: 'end_turn' })
    await running
    await disabling
    expect(created.disableLiteratureContext).toHaveBeenCalledWith(session.sessionId)
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

  it('preserves a durable permission wait during quit preparation', async () => {
    const prompt = createDeferred<unknown>()
    let created!: ReturnType<typeof createFakeRuntime>
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      created = createFakeRuntime({
        frameworkId: 'claude-code',
        sessionIds: ['session-1'],
        callbacks,
        prompt: () => prompt.promise,
        activePromptSessions: [{ projectId: 'project-1', sessionId: 'session-1' }],
        quitBlockingSessions: []
      })
      return created.runtime
    })
    const session = await coordinator.createSession({
      cwd: '/workspace',
      projectId: 'project-1'
    })
    const running = coordinator.sendPrompt({ sessionId: session.sessionId, text: 'wait for me' })
    await Promise.resolve()

    await expect(coordinator.prepareForQuit(1_000)).resolves.toBe('completed')
    expect(created.cancelPrompt).not.toHaveBeenCalled()

    await expect(coordinator.shutdownForQuit()).resolves.toEqual({ reaped: true })
    prompt.reject(new Error('provider connection closed during quit'))
    await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' })
  })

  it('preserves an unexpected durable prompt failure before provider quit teardown', async () => {
    const prompt = createDeferred<unknown>()
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) =>
        createFakeRuntime({
          frameworkId: 'claude-code',
          sessionIds: ['session-1'],
          callbacks,
          prompt: () => prompt.promise,
          activePromptSessions: [{ projectId: 'project-1', sessionId: 'session-1' }],
          quitBlockingSessions: []
        }).runtime
    )
    const session = await coordinator.createSession({
      cwd: '/workspace',
      projectId: 'project-1'
    })
    const running = coordinator.sendPrompt({ sessionId: session.sessionId, text: 'wait for me' })
    await Promise.resolve()

    await expect(coordinator.prepareForQuit(1_000)).resolves.toBe('completed')
    prompt.reject(new Error('unexpected persistence failure'))

    await expect(running).rejects.toThrow('unexpected persistence failure')
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

  it('reopens prompt admission when quit preparation is aborted', async () => {
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
    coordinator.abortQuitPreparation()

    await expect(
      coordinator.sendPrompt({ sessionId: session.sessionId, text: 'retry after failed quit' })
    ).resolves.toBeDefined()
    expect(created.sendPrompt).toHaveBeenCalledOnce()
  })

  it('linearizes real user prompts and upward continuations through one root admission lock', async () => {
    const prompts = [
      createDeferred<unknown>(),
      createDeferred<unknown>(),
      createDeferred<unknown>()
    ]
    let promptIndex = 0
    let created!: ReturnType<typeof createFakeRuntime>
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      created = createFakeRuntime({
        frameworkId: 'codex',
        sessionIds: ['session-1'],
        callbacks,
        prompt: () => prompts[promptIndex++].promise
      })
      return created.runtime
    })
    const session = await coordinator.createSession({ cwd: '/workspace' })
    const firstUser = coordinator.sendPrompt({ sessionId: session.sessionId, text: 'first user' })
    await vi.waitFor(() => expect(created.sendPrompt).toHaveBeenCalledOnce())

    const validate = vi.fn(async () => undefined)
    const upward = coordinator.startContinuationWhen(
      { sessionId: session.sessionId, text: 'child message' },
      validate
    )
    const laterUser = coordinator.sendPrompt({ sessionId: session.sessionId, text: 'later user' })
    await Promise.resolve()
    expect(validate).not.toHaveBeenCalled()
    expect(created.sendAppContinuation).not.toHaveBeenCalled()

    prompts[0].resolve({ stopReason: 'end_turn' })
    await firstUser
    await upward
    expect(validate).toHaveBeenCalledOnce()
    expect(created.sendAppContinuation).toHaveBeenCalledOnce()
    expect(created.sendPrompt).toHaveBeenCalledOnce()

    prompts[1].resolve({ stopReason: 'end_turn' })
    await vi.waitFor(() => expect(created.sendPrompt).toHaveBeenCalledTimes(2))
    prompts[2].resolve({ stopReason: 'end_turn' })
    await laterUser
  })

  it.each(['claude-code', 'opencode', 'codex'] as const)(
    'linearizes a scoped Reviewer correction behind an active %s user prompt',
    async (frameworkId) => {
      const prompts = [createDeferred<unknown>(), createDeferred<unknown>()]
      let promptIndex = 0
      let created!: ReturnType<typeof createFakeRuntime>
      const coordinator = new AcpRuntimeCoordinator((callbacks) => {
        created = createFakeRuntime({
          frameworkId,
          sessionIds: ['session-1'],
          callbacks,
          prompt: () => prompts[promptIndex++].promise
        })
        return created.runtime
      })
      const session = await coordinator.createSession({
        cwd: '/workspace',
        projectId: 'project-1'
      })

      const userPrompt = coordinator.sendPrompt({
        sessionId: session.sessionId,
        text: 'active user turn'
      })
      await vi.waitFor(() => expect(created.sendPrompt).toHaveBeenCalledOnce())

      const correction = coordinator.withActivity(
        {
          session: {
            sessionId: session.sessionId,
            cwd: '/workspace',
            projectId: 'project-1',
            previousFrameworkId: frameworkId
          }
        },
        (runtime) =>
          runtime.sendApplicationPrompt(
            { sessionId: session.sessionId, text: '[Auditor] correct the reviewed turn' },
            {
              kind: 'application',
              feature: 'reviewer',
              purpose: 'correction',
              causeReviewId: 'review-1'
            }
          )
      )

      await Promise.resolve()
      await Promise.resolve()
      expect(vi.mocked(created.runtime.sendApplicationPrompt)).not.toHaveBeenCalled()

      prompts[0].resolve({ stopReason: 'end_turn' })
      await userPrompt
      await vi.waitFor(() =>
        expect(vi.mocked(created.runtime.sendApplicationPrompt)).toHaveBeenCalledOnce()
      )

      prompts[1].resolve({ stopReason: 'end_turn' })
      await correction
    }
  )

  it('revalidates a parked upward branch inside the root lock before any provider call', async () => {
    let created!: ReturnType<typeof createFakeRuntime>
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      created = createFakeRuntime({
        frameworkId: 'opencode',
        sessionIds: ['session-1'],
        callbacks
      })
      return created.runtime
    })
    const session = await coordinator.createSession({ cwd: '/workspace' })

    await expect(
      coordinator.startContinuationWhen(
        { sessionId: session.sessionId, text: 'branch A payload' },
        async () => {
          throw new DelegateMessageParkedError('branch A is inactive')
        }
      )
    ).rejects.toMatchObject({
      name: 'DelegateMessageParkedError',
      message: 'branch A is inactive'
    })
    expect(created.sendAppContinuation).not.toHaveBeenCalled()
  })

  it('returns completion evidence when an upward continuation completes without an acceptance callback', async () => {
    const coordinator = new AcpRuntimeCoordinator(
      (callbacks) =>
        createFakeRuntime({
          frameworkId: 'codex',
          sessionIds: ['session-1'],
          callbacks,
          skipProviderPromptAccepted: true
        }).runtime
    )
    const session = await coordinator.createSession({ cwd: '/workspace' })

    await expect(
      coordinator.startContinuationWhen(
        { sessionId: session.sessionId, text: 'completion fallback' },
        async () => undefined
      )
    ).resolves.toBe('provider_prompt_completed')
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
    await vi.waitFor(() => expect(beforePromptStart).toHaveBeenCalledOnce())

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

  it('applies the final dispatch admission wrapper to app-owned continuations', async () => {
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
    const admittedSessionIds: string[] = []
    coordinator.setPromptDispatchAdmissionGuard(async (sessionId, dispatch) => {
      admittedSessionIds.push(sessionId)
      await admission.promise
      return dispatch()
    })

    const request = {
      sessionId: session.sessionId,
      text: 'approved recovery continuation',
      suppressUserMessage: true,
      provenanceContext: {
        promptMessageId: 'originating-user-message',
        originMessageId: 'originating-user-message',
        rootFrameId: 'root-frame',
        agentFrameId: 'root-frame',
        messageAncestry: ['originating-user-message'],
        runtimeSegmentId: 'settlement-wake-prompt'
      }
    }
    const continuation = coordinator.sendAppContinuation(request)
    await Promise.resolve()
    expect(createdRuntime.sendAppContinuation).not.toHaveBeenCalled()

    admission.resolve()
    await continuation

    expect(admittedSessionIds).toEqual([session.sessionId])
    expect(createdRuntime.sendAppContinuation).toHaveBeenCalledWith(request, 'prompt-attempt-1')
  })

  it('applies prompt admission and deletion fences to native follow-up', async () => {
    const admission = createDeferred<void>()
    const dispatchAdmission = createDeferred<void>()
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
    const admittedSessionIds: string[] = []
    coordinator.setPromptDispatchAdmissionGuard(async (sessionId, dispatch) => {
      admittedSessionIds.push(sessionId)
      await dispatchAdmission.promise
      return dispatch()
    })

    const followUp = coordinator.steerFollowUp({
      sessionId: session.sessionId,
      text: 'focus on tests'
    })
    await Promise.resolve()
    expect(createdRuntime.steerFollowUp).not.toHaveBeenCalled()

    admission.resolve()
    await Promise.resolve()
    expect(createdRuntime.steerFollowUp).not.toHaveBeenCalled()

    dispatchAdmission.resolve()
    await expect(followUp).resolves.toEqual({
      injected: true,
      transport: 'acp-steering',
      messageId: 'message-steer-1'
    })
    expect(admittedSessionIds).toEqual([session.sessionId])
    expect(createdRuntime.steerFollowUp).toHaveBeenCalledWith({
      sessionId: session.sessionId,
      text: 'focus on tests'
    })
  })

  it('refuses native follow-up when prompt admission rejects', async () => {
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
    coordinator.setPromptAdmissionGuard(async () => {
      throw new Error('Close Side chat before sending a message to Main.')
    })

    await expect(
      coordinator.steerFollowUp({ sessionId: session.sessionId, text: 'focus on tests' })
    ).rejects.toThrow(/Close Side chat/)
    expect(createdRuntime.steerFollowUp).not.toHaveBeenCalled()
  })

  it('admits a Side chat advisory through the deletion fence without opening a Main prompt', async () => {
    const dispatchAdmission = createDeferred<void>()
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
    const promptAdmissionGuard = vi.fn(async () => {
      throw new Error('Side chat owns Main prompt admission.')
    })
    coordinator.setPromptAdmissionGuard(promptAdmissionGuard)
    coordinator.setPromptDispatchAdmissionGuard(async (_sessionId, dispatch) => {
      await dispatchAdmission.promise
      return dispatch()
    })

    const advisory = coordinator.steerSideChatAdvisory({
      sessionId: session.sessionId,
      text: 'context-only advisory'
    })
    await Promise.resolve()
    expect(createdRuntime.steerSideChatAdvisory).not.toHaveBeenCalled()

    dispatchAdmission.resolve()
    await expect(advisory).resolves.toEqual({
      injected: true,
      promptMessageId: 'prompt-live'
    })
    expect(promptAdmissionGuard).not.toHaveBeenCalled()
    expect(createdRuntime.steerSideChatAdvisory).toHaveBeenCalledWith({
      sessionId: session.sessionId,
      text: 'context-only advisory'
    })
  })

  it('does not reacquire dispatch admission for an already admitted continuation', async () => {
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
    const admittedSessionIds: string[] = []
    coordinator.setPromptDispatchAdmissionGuard(async (sessionId, dispatch) => {
      admittedSessionIds.push(sessionId)
      return dispatch()
    })

    await expect(
      coordinator.startContinuationWhenDispatchAdmitted(
        { sessionId: session.sessionId, text: 'already deletion-admitted' },
        async () => undefined
      )
    ).resolves.toBe('provider_prompt_accepted')

    expect(admittedSessionIds).toEqual([])
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
    await vi.waitFor(() => expect(promptAttempt).toBe(1))
    await coordinator.cancelPrompt({ sessionId: session.sessionId })

    await coordinator.sendPrompt({ sessionId: session.sessionId, text: 'new turn starts first' })
    expect(onSessionTurnStarted).toHaveBeenCalledOnce()
    expect(onSessionTurnStarted).toHaveBeenCalledWith('session-1', 'turn-1')

    firstPromptStart.resolve()
    await stalePrompt
    expect(onSessionTurnStarted).toHaveBeenCalledOnce()
  })

  it('preserves an already-queued upward continuation when cancelling its active predecessor', async () => {
    const cancelledPromptStart = createDeferred<void>()
    let promptAttempt = 0
    let created!: ReturnType<typeof createFakeRuntime>
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      created = createFakeRuntime({
        frameworkId: 'claude-code',
        sessionIds: ['session-1'],
        callbacks,
        beforePromptStart: () =>
          promptAttempt++ === 0 ? cancelledPromptStart.promise : Promise.resolve()
      })
      return created.runtime
    })
    const session = await coordinator.createSession({ cwd: '/workspace' })
    const cancelled = coordinator.sendPrompt({
      sessionId: session.sessionId,
      text: 'active predecessor'
    })
    await vi.waitFor(() => expect(promptAttempt).toBe(1))
    const upward = coordinator.startContinuationWhen(
      { sessionId: session.sessionId, text: 'queued child message' },
      async () => undefined
    )

    await coordinator.cancelPrompt({ sessionId: session.sessionId })
    await coordinator.sendPrompt({ sessionId: session.sessionId, text: 'later user prompt' })

    expect(created.sendAppContinuation).toHaveBeenCalledOnce()
    expect(created.sendAppContinuation.mock.invocationCallOrder[0]).toBeLessThan(
      created.sendPrompt.mock.invocationCallOrder[1]
    )
    cancelledPromptStart.resolve()
    await cancelled
    await upward
  })

  it('does not release a queued continuation that becomes active while cancellation settles', async () => {
    const activePrompt = createDeferred<{ stopReason: string }>()
    const upwardContinuation = createDeferred<{ stopReason: string }>()
    let promptRun = 0
    let created!: ReturnType<typeof createFakeRuntime>
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      created = createFakeRuntime({
        frameworkId: 'claude-code',
        sessionIds: ['session-1'],
        callbacks,
        prompt: () =>
          promptRun++ === 0
            ? activePrompt.promise
            : promptRun === 2
              ? upwardContinuation.promise
              : Promise.resolve({ stopReason: 'end_turn' })
      })
      return created.runtime
    })
    const session = await coordinator.createSession({ cwd: '/workspace' })
    const active = coordinator.sendPrompt({ sessionId: session.sessionId, text: 'active prompt' })
    await vi.waitFor(() => expect(created.sendPrompt).toHaveBeenCalledOnce())
    const upward = coordinator.startContinuationWhen(
      { sessionId: session.sessionId, text: 'queued child message' },
      async () => undefined
    )
    created.cancelPrompt.mockImplementationOnce(async () => {
      activePrompt.resolve({ stopReason: 'cancelled' })
      await vi.waitFor(() => expect(created.sendAppContinuation).toHaveBeenCalledOnce())
      return created.runtime.getSnapshot()
    })

    await coordinator.cancelPrompt({ sessionId: session.sessionId })
    await vi.waitFor(() => expect(created.sendAppContinuation).toHaveBeenCalledOnce())
    const laterUser = coordinator.sendPrompt({
      sessionId: session.sessionId,
      text: 'later user prompt'
    })
    await Promise.resolve()
    expect(created.sendPrompt).toHaveBeenCalledOnce()

    upwardContinuation.resolve({ stopReason: 'end_turn' })
    await active
    await upward
    await laterUser
    expect(created.sendPrompt).toHaveBeenCalledTimes(2)
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

  it('reloads Skills only when the active generation owns the requested framework', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: created.length === 0 ? 'codex' : 'claude-code',
        sessionIds: [`session-${created.length + 1}`],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })

    await coordinator.createSession()
    await coordinator.requestSkillsReloadForFramework('claude-code')

    expect(created).toHaveLength(1)
    expect(created[0].requestRetirement).not.toHaveBeenCalled()

    await coordinator.requestSkillsReloadForFramework('codex')

    expect(created[0].requestRetirement).toHaveBeenCalledOnce()
    expect(created).toHaveLength(1)

    await coordinator.createSession()
    await coordinator.requestSkillsReloadForFramework('claude-code')

    expect(created).toHaveLength(2)
    expect(created[1].requestRetirement).toHaveBeenCalledOnce()
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

    const activeSession = await coordinator.createSession({ projectId: 'other-project' })
    const idleSession = await coordinator.createSession({ projectId: 'deleting-project' })
    created[0].emitState({
      promptInFlight: true,
      promptInFlightSessionIds: [activeSession.sessionId]
    })
    created[0].requestRetirement.mockReturnValue(retirement.promise)
    const reloadRequest = coordinator.requestSkillsReload()

    expect(coordinator.getSnapshot().sessionIds).toEqual([activeSession.sessionId])
    expect(coordinator.getSnapshot().sessionResumeRequiredIds).toEqual([activeSession.sessionId])
    expect(coordinator.getOwnedSessionIds()).toEqual([
      activeSession.sessionId,
      idleSession.sessionId
    ])
    expect(coordinator.liveSessionProjectId(idleSession.sessionId)).toBe('deleting-project')
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

  it('uses a fresh runtime generation on the next prompt after Project Agent Context changes', async () => {
    let storedAgentContext = 'Always cite DOIs.'
    const promptContexts: string[] = []
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const generationAgentContext = storedAgentContext
      const fake = createFakeRuntime({
        frameworkId: 'claude-code',
        sessionIds: created.length === 0 ? ['agent-session'] : ['fresh-session'],
        callbacks,
        prompt: async () => {
          promptContexts.push(generationAgentContext)
          return { stopReason: 'end_turn' }
        }
      })
      created.push(fake)
      return fake.runtime
    })
    const project = {
      id: 'project-1',
      name: 'Research',
      description: '',
      agentContext: storedAgentContext,
      isExample: false,
      createdAt: 1,
      updatedAt: 2
    }
    const repository = {
      list: vi.fn(),
      get: vi.fn(async () => ({ ...project, agentContext: storedAgentContext })),
      create: vi.fn(),
      update: vi.fn(async (request) => {
        storedAgentContext = request.agentContext ?? storedAgentContext
        return { ...project, agentContext: storedAgentContext, updatedAt: 3 }
      })
    }
    const handlers = createProjectHandlers(
      repository,
      {
        deleteProject: vi.fn(),
        listDeletionCleanup: vi.fn().mockResolvedValue([]),
        retryDeletionCleanup: vi.fn(),
        waitForProjectOperations: vi.fn().mockResolvedValue(undefined)
      },
      {
        updateArchive: vi.fn(),
        onAgentContextChanged: () => {
          void coordinator.requestProjectAgentContextReload()
        }
      }
    )
    const session = await coordinator.createSession({ projectId: project.id })

    await handlers.update({
      id: project.id,
      agentContext: 'Prefer Python.',
      expectedUpdatedAt: project.updatedAt
    })

    expect(coordinator.getSnapshot().sessionIds).not.toContain(session.sessionId)
    await coordinator.resumeSession({
      sessionId: session.sessionId,
      cwd: '/workspace',
      projectId: project.id,
      previousFrameworkId: 'claude-code'
    })
    await coordinator.sendPrompt({ sessionId: session.sessionId, text: 'Use the current policy' })

    expect(promptContexts).toEqual(['Prefer Python.'])
    expect(created[0].sendPrompt).not.toHaveBeenCalled()
    expect(created[1].resumeSession).toHaveBeenCalledOnce()
    expect(created[1].sendPrompt).toHaveBeenCalledOnce()
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
          projectId: 'project-1',
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

  it('holds the Session deletion lifecycle until runtime deletion settles', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const onSessionDeleteStarted = vi.fn()
    const beforeSessionDelete = vi.fn().mockResolvedValue(undefined)
    const afterSessionDelete = vi.fn()
    const delegatedDeletion = createDeferred<void>()
    const delegatedWork: RootDelegatedWorkControl = {
      pendingPermissions: () => [],
      subscribe: () => () => undefined,
      respondToPermission: async () => false,
      setPermissionProfile: async () => undefined,
      stopSession: async () => undefined,
      stopAll: async () => undefined,
      deleteSession: vi.fn(() => delegatedDeletion.promise),
      deleteProject: async () => undefined
    }
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
      undefined,
      { onSessionDeleteStarted, beforeSessionDelete, afterSessionDelete },
      undefined,
      delegatedWork
    )
    const deletion = createDeferred<AcpStateSnapshot>()
    created[0].deleteSession.mockReturnValueOnce(deletion.promise)

    await coordinator.createSession()
    const deleting = coordinator.deleteSession({ sessionId: 'session-1' })
    await vi.waitFor(() => expect(delegatedWork.deleteSession).toHaveBeenCalledOnce())

    expect(onSessionDeleteStarted).toHaveBeenCalledWith('session-1')
    expect(onSessionDeleteStarted.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(delegatedWork.deleteSession).mock.invocationCallOrder[0]
    )
    expect(beforeSessionDelete).not.toHaveBeenCalled()
    expect(afterSessionDelete).not.toHaveBeenCalled()

    delegatedDeletion.resolve()
    await vi.waitFor(() => expect(created[0].deleteSession).toHaveBeenCalledOnce())

    expect(beforeSessionDelete).toHaveBeenCalledWith('session-1')
    expect(afterSessionDelete).not.toHaveBeenCalled()

    deletion.resolve(emptySnapshot())
    await deleting

    expect(afterSessionDelete).toHaveBeenCalledWith('session-1', false)
    expect(created[0].deleteSession.mock.invocationCallOrder[0]).toBeLessThan(
      afterSessionDelete.mock.invocationCallOrder[0]
    )
  })

  it('releases the Session deletion lifecycle when runtime deletion fails', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const afterSessionDelete = vi.fn()
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
      undefined,
      { afterSessionDelete }
    )

    await coordinator.createSession()
    created[0].deleteSession.mockRejectedValueOnce(new Error('delete failed'))

    await expect(coordinator.deleteSession({ sessionId: 'session-1' })).rejects.toThrow(
      'delete failed'
    )
    expect(afterSessionDelete).toHaveBeenCalledWith('session-1', true)
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

  it('retires a targeted runtime after deleting its last detached session', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      const fake = createFakeRuntime({
        frameworkId: 'claude-code',
        sessionIds: [`session-${created.length}`],
        callbacks
      })
      created.push(fake)
      return fake.runtime
    })
    const session = await coordinator.createSession({
      agentTarget: {
        frameworkId: 'claude-code',
        providerId: 'provider-a',
        model: 'model-a',
        reasoningEffort: 'high'
      }
    })
    created[1].setStateSilently({ sessionId: undefined, sessionIds: [] })
    created[1].deleteSession.mockResolvedValueOnce(emptySnapshot())

    await coordinator.deleteSession({ sessionId: session.sessionId })

    expect(created[1].requestRetirement).toHaveBeenCalledOnce()
  })

  it('preserves a session adopted by a new generation while the old delete is in flight', async () => {
    const created: ReturnType<typeof createFakeRuntime>[] = []
    const onSessionUnavailable = vi.fn()
    const afterSessionDelete = vi.fn()
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
      onSessionUnavailable,
      { afterSessionDelete }
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
    expect(afterSessionDelete).toHaveBeenCalledWith('session-1', true)
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
    let oldBackendId: string | undefined
    let newBackendId: string | undefined

    const oldActivity = coordinator.withActivity({}, async (runtime) => {
      oldActivityStarted.resolve()
      await releaseOldActivity.promise
      oldBackendId = runtime.captureBackend?.().backendId
      await runtime.beginProviderTurnObservation?.({
        providerSessionId: 'reviewer-old',
        cwd: '/workspace'
      })
      await runtime.buildReviewerSession({ cwd: '/workspace', mcpServers: [] })
    })
    await oldActivityStarted.promise

    await coordinator.requestAgentFrameworkSwitch()
    await coordinator.withActivity({}, async (runtime) => {
      newBackendId = runtime.captureBackend?.().backendId
      await runtime.beginProviderTurnObservation?.({
        providerSessionId: 'reviewer-new',
        cwd: '/workspace'
      })
      return runtime.buildReviewerSession({ cwd: '/workspace', mcpServers: [] })
    })
    releaseOldActivity.resolve()
    await oldActivity

    expect(vi.mocked(created[0].runtime.buildReviewerSession)).toHaveBeenCalledOnce()
    expect(vi.mocked(created[1].runtime.buildReviewerSession)).toHaveBeenCalledOnce()
    expect(created[0].beginProviderTurnObservation).toHaveBeenCalledWith({
      providerSessionId: 'reviewer-old',
      cwd: '/workspace'
    })
    expect(created[1].beginProviderTurnObservation).toHaveBeenCalledWith({
      providerSessionId: 'reviewer-new',
      cwd: '/workspace'
    })
    expect(oldBackendId).toBe('claude-code:owned')
    expect(newBackendId).toBe('codex:owned')
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
    const resumeObserver = vi.fn(async () => undefined)
    const admissionGuard = vi.fn(async () => undefined)
    coordinator.setSessionResumeObserver(resumeObserver)
    coordinator.setPromptAdmissionGuard(admissionGuard)

    await coordinator.withActivity(
      {
        session: {
          sessionId: 'old-session',
          cwd: '/workspace',
          projectId: 'project-1',
          memoryEnabled: false,
          previousFrameworkId: 'claude-code',
          specialistId: 'specialist-new',
          specialistBindingPending: true,
          historyPreamble: 'prior transcript'
        }
      },
      async (runtime) => {
        await runtime.buildReviewerSession({ cwd: '/workspace', mcpServers: [] })
        expect(vi.mocked(created[1].runtime.resumeSession)).not.toHaveBeenCalled()
        await runtime.sendApplicationPrompt(
          { sessionId: 'old-session', text: '[Auditor] fix this' },
          {
            kind: 'application',
            feature: 'reviewer',
            purpose: 'correction',
            causeReviewId: 'review-1'
          }
        )
      }
    )

    expect(vi.mocked(created[1].runtime.resumeSession)).toHaveBeenCalledWith({
      sessionId: 'old-session',
      cwd: '/workspace',
      projectId: 'project-1',
      memoryEnabled: false,
      previousFrameworkId: 'claude-code',
      specialistId: 'specialist-new',
      specialistBindingPending: true
    })
    expect(resumeObserver).toHaveBeenCalledOnce()
    expect(admissionGuard).toHaveBeenCalledWith('old-session')
    expect(vi.mocked(created[1].runtime.sendApplicationPrompt)).toHaveBeenCalledWith(
      {
        sessionId: 'old-session',
        text: '[Auditor] fix this',
        historyPreamble: 'prior transcript',
        contextReset: true,
        provenanceContext: { promptMessageId: expect.stringMatching(/^prompt-/u) }
      },
      {
        kind: 'application',
        feature: 'reviewer',
        purpose: 'correction',
        causeReviewId: 'review-1'
      },
      'prompt-attempt-1'
    )
    expect(vi.mocked(created[0].runtime.sendPrompt)).not.toHaveBeenCalled()
  })

  it('blocks a scoped application prompt when an attached Session still has a pending binding', async () => {
    let created!: ReturnType<typeof createFakeRuntime>
    const coordinator = new AcpRuntimeCoordinator((callbacks) => {
      created = createFakeRuntime({
        frameworkId: 'claude-code',
        sessionIds: ['session-1'],
        callbacks
      })
      return created.runtime
    })
    await coordinator.createSession({ cwd: '/workspace' })
    coordinator.setPromptAdmissionGuard(async () => {
      throw new Error('The selected Specialist is saved but has not been applied yet.')
    })

    await expect(
      coordinator.withActivity(
        {
          session: {
            sessionId: 'session-1',
            cwd: '/workspace',
            specialistId: 'specialist-new',
            specialistBindingPending: true
          }
        },
        (runtime) =>
          runtime.sendApplicationPrompt(
            { sessionId: 'session-1', text: '[Auditor] fix this' },
            {
              kind: 'application',
              feature: 'reviewer',
              purpose: 'correction',
              causeReviewId: 'review-1'
            }
          )
      )
    ).rejects.toThrow('has not been applied yet')

    expect(vi.mocked(created.runtime.resumeSession)).not.toHaveBeenCalled()
    expect(vi.mocked(created.runtime.sendApplicationPrompt)).not.toHaveBeenCalled()
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
