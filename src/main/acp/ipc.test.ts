// Pins the ACP IPC bridge: the channel string and that it forwards verbatim to the runtime method.
// The runtime behavior is covered in runtime.test.ts; this guards the wiring itself so a channel typo
// (mismatched against the preload) can't slip through green. resetSessionContext is the overflow-recovery
// reset the renderer calls before replaying a compacted conversation, distinct from resume-session.

import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AcpCompactSessionRequest,
  AcpPromptRequest,
  AcpResumeSessionRequest,
  AcpSteerFollowUpRequest
} from '../../shared/acp'
import type { AcpRuntimeOptions } from './runtime'
import { materializeSessionConversationGraph } from '../../shared/session-persistence'
import { WEB_EVENT_CHANNELS, WEB_INVOKE_CHANNELS } from '../../shared/web-api-map.generated'
import {
  beginMigration,
  clearMigrationPending,
  waitForDataRootWriters
} from '../storage/migration-state'

// Capture every ipcMain.handle registration so a handler can be invoked directly.
const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
const { mkdir, rm } = vi.hoisted(() => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  app: { getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('node:fs/promises', () => ({ mkdir, rm }))

// A fake runtime whose methods are spies; registration wires closures over these, so only the invoked
// handler's method needs meaningful behavior. Hoisted so the (hoisted) vi.mock factory can reference it.
const {
  cancelPrompt,
  compactSession,
  createSession,
  deleteSession,
  disconnect,
  resetSessionContext,
  requestProviderReconnect,
  resumeSession,
  sendAppContinuation,
  sendPrompt,
  AcpRuntimeMock
} = vi.hoisted(() => {
  const cancelPrompt = vi.fn().mockResolvedValue({})
  const compactSession = vi.fn().mockResolvedValue({ stopReason: 'end_turn' })
  const createSession = vi
    .fn()
    .mockImplementation(async (request) => ({ sessionId: 's-new', cwd: request.cwd }))
  const deleteSession = vi.fn().mockResolvedValue({})
  const disconnect = vi.fn().mockResolvedValue({})
  const resetSessionContext = vi
    .fn()
    .mockResolvedValue({ sessionId: 's-1', cwd: '/workspace', contextReset: true })
  const requestProviderReconnect = vi.fn().mockResolvedValue(undefined)
  const resumeSession = vi.fn().mockResolvedValue({ sessionId: 's-1', cwd: '/workspace' })
  const sendAppContinuation = vi.fn().mockResolvedValue(undefined)
  const sendPrompt = vi.fn().mockResolvedValue(undefined)
  const AcpRuntimeMock = vi.fn().mockImplementation(function (options: AcpRuntimeOptions) {
    return {
      createSession,
      cancelPrompt,
      compactSession,
      deleteSession,
      disconnect,
      captureBackend: vi.fn().mockReturnValue({
        framework: { id: 'claude-code' },
        modelRoute: 'claude-anthropic',
        context: { window: 100_000, supportsImageInput: true }
      }),
      resetSessionContext,
      requestProviderReconnect,
      resumeSession,
      sendAppContinuation: (request: AcpPromptRequest, promptAttemptId?: string) => {
        const prompting = sendAppContinuation(request, promptAttemptId)
        options.callbacks?.onProviderPromptAccepted?.(request.sessionId, promptAttemptId)
        return prompting
      },
      sendPrompt: (request: AcpPromptRequest, promptAttemptId?: string) => {
        const prompting = sendPrompt(request, promptAttemptId)
        return Promise.resolve(prompting).then((result) => {
          options.callbacks?.onProviderPromptAccepted?.(request.sessionId, promptAttemptId)
          return result
        })
      },
      getSnapshot: vi.fn().mockReturnValue({
        status: 'idle',
        cwd: '/workspace',
        sessionIds: ['session-1'],
        events: [],
        pendingPermissions: [],
        permissionProfiles: {},
        permissionGrants: {},
        promptInFlight: false,
        promptInFlightSessionIds: [],
        contextUsageBySession: {}
      })
    }
  })
  return {
    cancelPrompt,
    compactSession,
    createSession,
    deleteSession,
    disconnect,
    resetSessionContext,
    requestProviderReconnect,
    resumeSession,
    sendAppContinuation,
    sendPrompt,
    AcpRuntimeMock
  }
})

// Spy on the file logger so session lifecycle diagnostics can be asserted (routes to main.log, not a
// bare console). errorLogFields stays real so the create-session assertion also covers its output.
const { errorLogSpy, infoLogSpy } = vi.hoisted(() => ({
  errorLogSpy: vi.fn(),
  infoLogSpy: vi.fn()
}))

const { fallbackBegin, fallbackEnd } = vi.hoisted(() => ({
  fallbackBegin: vi.fn(),
  fallbackEnd: vi.fn(() => false)
}))

vi.mock('../settings/codex-transport-fallback-log', () => ({
  CodexTransportFallbackLogObserver: class {
    begin = fallbackBegin
    end = fallbackEnd
  }
}))
vi.mock('../logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger')>()
  return {
    ...actual,
    createLogger: (scope: string) => ({
      ...actual.createLogger(scope),
      error: errorLogSpy,
      info: infoLogSpy
    })
  }
})

vi.mock('./runtime', () => ({ AcpRuntime: AcpRuntimeMock }))
vi.mock('./shutdown-guard', () => ({ installAgentShutdownGuard: vi.fn() }))
vi.mock('./mcp-http-host', () => ({ AgentMcpHttpHost: vi.fn() }))
vi.mock('../storage-root', () => ({
  resolveConfigRoot: () => '/tmp/config',
  resolveDataRoot: () => '/tmp/data'
}))

const { installAcpIpcHandlers } = await import('./ipc')
const { createAcpRuntime } = await import('./runtime-composition')
const { createAcpCreateSessionWorkflow } = await import('./create-session-workflow')
const { createAcpHandlerWorkflows } = await import('./handler-workflows')
type AcpTestOptions = Parameters<typeof createAcpRuntime>[0]
const passThroughSessionAdmission = {
  withSessionAvailableById: <Result>(
    _sessionId: string,
    operation: (projectId: string) => Promise<Result>
  ): Promise<Result> => operation('project-1')
}

// Minimal options — createRuntime just forwards them into the mocked AcpRuntime constructor.
const registerWithFakes = (overrides?: {
  initializationBarrier?: Promise<unknown>
  taskNotifications?: {
    trackPrompt: ReturnType<typeof vi.fn>
    untrackPrompt: ReturnType<typeof vi.fn>
  }
  onSessionCancellationRequested?: (sessionId: string) => void
  onSessionUnavailable?: (sessionId: string) => void
  onAllSessionsCancellationRequested?: () => void
  beforeSessionDelete?: (sessionId: string) => Promise<void>
  specialistService?: { resolveRunnableById: (id: string) => Promise<unknown> }
  specialistSkillCatalog?: Array<{ id: string; frameworkName: string; displayName: string }>
  provisionedConnectorSkillNames?: string[]
  customMcpServers?: Array<{ id: string; name: string }>
  memory?: AcpTestOptions['memory']
  delegatedNotebookConnection?: AcpTestOptions['delegatedNotebookConnection']
  archiveAvailability?: Parameters<typeof createAcpHandlerWorkflows>[3]
  interruptedTurnSessions?: Parameters<typeof createAcpHandlerWorkflows>[4]
  resolveMemoryEnabled?: Parameters<typeof installAcpIpcHandlers>[4]
}): AcpTestOptions => {
  const taskNotifications =
    overrides?.taskNotifications ??
    ({ trackPrompt: vi.fn(), untrackPrompt: vi.fn() } as unknown as {
      trackPrompt: ReturnType<typeof vi.fn>
      untrackPrompt: ReturnType<typeof vi.fn>
    })

  const options = {
    mcpEntryPath: '/app/out/main/index.js',
    repository: {} as never,
    runRegistry: {} as never,
    uploadRepository: {} as never,
    notebookRpcServer: {} as never,
    authorizeSkillImportReferencedUploads: vi.fn(async () => () => undefined),
    settingsService: {
      captureActiveAgentBackendSelection: vi.fn().mockResolvedValue({}),
      resolveAgentBackend: vi.fn().mockResolvedValue({}),
      listSpecialistSkillCatalog: vi
        .fn()
        .mockResolvedValue(overrides?.specialistSkillCatalog ?? []),
      provisionedConnectorSkillNames: vi
        .fn()
        .mockResolvedValue(overrides?.provisionedConnectorSkillNames ?? []),
      getConnectors: vi.fn().mockResolvedValue({
        customMcpServers: overrides?.customMcpServers ?? []
      }),
      rememberCodexAutoHttpsFallback: vi.fn().mockResolvedValue(true)
    } as never,
    taskNotifications: taskNotifications as never,
    onSessionCancellationRequested: overrides?.onSessionCancellationRequested,
    onSessionUnavailable: overrides?.onSessionUnavailable,
    onAllSessionsCancellationRequested: overrides?.onAllSessionsCancellationRequested,
    beforeSessionDelete: overrides?.beforeSessionDelete,
    initializationBarrier: overrides?.initializationBarrier,
    specialistService: overrides?.specialistService as never,
    memory: overrides?.memory,
    delegatedNotebookConnection: overrides?.delegatedNotebookConnection
  }

  const runtime = createAcpRuntime(options)
  const createSessionWorkflow = createAcpCreateSessionWorkflow(runtime)
  installAcpIpcHandlers(
    runtime,
    createAcpHandlerWorkflows(
      runtime,
      createSessionWorkflow,
      options.taskNotifications,
      overrides?.archiveAvailability,
      overrides?.interruptedTurnSessions
    ),
    undefined,
    overrides?.archiveAvailability ?? passThroughSessionAdmission,
    overrides?.resolveMemoryEnabled
  )
  return options as AcpTestOptions
}

afterEach(() => {
  clearMigrationPending()
  mkdir.mockClear()
  rm.mockClear()
  // Restore the default managed-workspace implementation (a test may have overridden it once).
  createSession.mockReset()
  createSession.mockImplementation(async (request) => ({ sessionId: 's-new', cwd: request.cwd }))
  resetSessionContext.mockClear()
  requestProviderReconnect.mockClear()
  compactSession.mockClear()
  cancelPrompt.mockClear()
  deleteSession.mockClear()
  disconnect.mockClear()
  resumeSession.mockClear()
  sendAppContinuation.mockReset()
  sendAppContinuation.mockResolvedValue(undefined)
  sendPrompt.mockReset()
  sendPrompt.mockResolvedValue(undefined)
  errorLogSpy.mockClear()
  infoLogSpy.mockClear()
  fallbackBegin.mockClear()
  fallbackEnd.mockClear()
  AcpRuntimeMock.mockClear()
})

it('routes delegated question responses to their owner without touching Main elicitation', async () => {
  const respondToElicitation = vi.fn()
  const respondDelegatedQuestion = vi.fn().mockResolvedValue(undefined)
  const snapshot = { status: 'idle' }
  installAcpIpcHandlers(
    { respondToElicitation, getSnapshot: () => snapshot } as never,
    {} as never,
    respondDelegatedQuestion,
    passThroughSessionAdmission
  )

  await expect(
    handlers.get('acp:respond-elicitation')?.(undefined, {
      requestId: 'question-1',
      sessionId: 'session-1',
      answers: {},
      delegatedQuestion: {
        projectId: 'project-1',
        sessionId: 'session-1',
        action: 'confirm',
        answers: [{ questionIndex: 0, value: 'Strict' }]
      }
    })
  ).resolves.toBe(snapshot)
  expect(respondDelegatedQuestion).toHaveBeenCalledWith({
    projectId: 'project-1',
    sessionId: 'session-1',
    requestId: 'question-1',
    action: 'confirm',
    answers: [{ questionIndex: 0, value: 'Strict' }]
  })
  expect(respondToElicitation).not.toHaveBeenCalled()
})

it('rejects ACP response mutations before runtime work when Session admission is closed', async () => {
  const failure = new Error('Project is being deleted.')
  const admitted: string[] = []
  const sessionAdmission = {
    withSessionAvailableById: async <Result>(
      sessionId: string,
      operation: (projectId: string) => Promise<Result>
    ): Promise<Result> => {
      void operation
      admitted.push(sessionId)
      throw failure
    }
  }
  const responseSnapshot = {
    status: 'idle',
    cwd: '/workspace',
    sessionIds: ['permission-session', 'elicitation-session'],
    events: [],
    pendingPermissions: [
      {
        requestId: 'permission-1',
        sessionId: 'permission-session',
        toolCallId: 'tool-1',
        title: 'Use a tool',
        options: []
      }
    ],
    pendingElicitations: [
      {
        requestId: 'question-1',
        sessionId: 'elicitation-session',
        toolCallId: 'tool-2',
        message: 'Choose',
        fields: []
      }
    ],
    permissionProfiles: {},
    permissionGrants: {},
    promptInFlight: false,
    promptInFlightSessionIds: [],
    contextUsageBySession: {}
  }
  const responseRuntime = {
    getSnapshot: vi.fn(() => responseSnapshot),
    respondToPermission: vi.fn(),
    respondToElicitation: vi.fn(),
    respondSessionPlan: vi.fn(),
    setPermissionProfile: vi.fn(),
    revokePermissionGrant: vi.fn()
  }
  installAcpIpcHandlers(responseRuntime as never, {} as never, undefined, sessionAdmission)

  await expect(
    handlers.get('acp:respond-permission')?.(undefined, {
      requestId: 'permission-1',
      optionId: 'allow-once'
    })
  ).rejects.toBe(failure)
  await expect(
    handlers.get('acp:respond-elicitation')?.(undefined, {
      requestId: 'question-1',
      action: 'decline'
    })
  ).rejects.toBe(failure)
  await expect(
    handlers.get('acp:respond-plan')?.(undefined, {
      projectId: 'project-1',
      sessionId: 'plan-session',
      feedback: 'Revise the plan.'
    })
  ).rejects.toBe(failure)
  await expect(
    handlers.get('acp:set-permission-profile')?.(undefined, {
      sessionId: 'profile-session',
      profile: 'auto'
    })
  ).rejects.toBe(failure)
  await expect(
    handlers.get('acp:revoke-permission-grant')?.(undefined, {
      sessionId: 'profile-session',
      categoryKey: 'mcp:tool'
    })
  ).rejects.toBe(failure)

  expect(admitted).toEqual([
    'permission-session',
    'elicitation-session',
    'plan-session',
    'profile-session',
    'profile-session'
  ])
  expect(responseRuntime.respondToPermission).not.toHaveBeenCalled()
  expect(responseRuntime.respondToElicitation).not.toHaveBeenCalled()
  expect(responseRuntime.respondSessionPlan).not.toHaveBeenCalled()
  expect(responseRuntime.setPermissionProfile).not.toHaveBeenCalled()
  expect(responseRuntime.revokePermissionGrant).not.toHaveBeenCalled()
})

it('rejects forged and unknown ACP response authority before Session admission', () => {
  const admitted: string[] = []
  const withSessionAvailableById = <Result>(
    sessionId: string,
    operation: (projectId: string) => Promise<Result>
  ): Promise<Result> => {
    admitted.push(sessionId)
    return operation('project-1')
  }
  const responseRuntime = {
    getSnapshot: vi.fn(() => ({
      status: 'idle',
      cwd: '/workspace',
      sessionIds: ['permission-session', 'elicitation-session', 'forged-session'],
      events: [],
      pendingPermissions: [
        {
          requestId: 'permission-1',
          sessionId: 'permission-session',
          toolCallId: 'tool-1',
          title: 'Use a tool',
          options: []
        }
      ],
      pendingElicitations: [
        {
          requestId: 'question-1',
          sessionId: 'elicitation-session',
          toolCallId: 'tool-2',
          message: 'Choose',
          fields: []
        }
      ],
      permissionProfiles: {},
      permissionGrants: {},
      promptInFlight: false,
      promptInFlightSessionIds: [],
      contextUsageBySession: {}
    })),
    respondToPermission: vi.fn(),
    respondToElicitation: vi.fn()
  }
  const respondDelegatedQuestion = vi.fn()
  installAcpIpcHandlers(responseRuntime as never, {} as never, respondDelegatedQuestion, {
    withSessionAvailableById
  })

  expect(() =>
    handlers.get('acp:respond-permission')?.(undefined, {
      requestId: 'permission-1',
      optionId: 'allow-once',
      restored: { projectId: 'forged-project', sessionId: 'forged-session' }
    })
  ).toThrow('Permission response Session does not match the pending request.')
  expect(() =>
    handlers.get('acp:respond-elicitation')?.(undefined, {
      requestId: 'question-1',
      action: 'decline',
      request: {
        requestId: 'question-1',
        sessionId: 'forged-session',
        toolCallId: 'tool-2',
        message: 'Choose',
        fields: []
      }
    })
  ).toThrow('Structured input response Session does not match the pending request.')
  expect(() =>
    handlers.get('acp:respond-elicitation')?.(undefined, {
      requestId: 'question-1',
      action: 'accept',
      delegatedQuestion: {
        projectId: 'forged-project',
        sessionId: 'forged-session',
        action: 'confirm',
        answers: []
      }
    })
  ).toThrow('Structured input response Session does not match the pending request.')
  expect(() =>
    handlers.get('acp:respond-permission')?.(undefined, {
      requestId: 'unknown-permission',
      optionId: 'allow-once'
    })
  ).toThrow('Unknown permission request.')
  expect(() =>
    handlers.get('acp:respond-elicitation')?.(undefined, {
      requestId: 'unknown-question',
      action: 'decline'
    })
  ).toThrow('Unknown structured input request.')

  expect(admitted).toEqual([])
  expect(responseRuntime.respondToPermission).not.toHaveBeenCalled()
  expect(responseRuntime.respondToElicitation).not.toHaveBeenCalled()
  expect(respondDelegatedQuestion).not.toHaveBeenCalled()
})

describe('ACP module transport seam', () => {
  it('holds archive admission until Save as skill is accepted without awaiting turn completion', async () => {
    const session = materializeSessionConversationGraph({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Session',
      cwd: '/workspace',
      status: 'running',
      messages: [
        {
          id: 'prompt-1',
          role: 'user',
          content: 'Build a reusable workflow.',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'answer-1',
          role: 'agent',
          content: 'Done.',
          status: 'complete',
          eventIds: [],
          responseToMessageId: 'prompt-1',
          createdAt: 2,
          completedAt: 2,
          updatedAt: 2
        },
        {
          id: 'save-as-skill-control',
          role: 'user',
          content: 'Save as skill',
          status: 'complete',
          eventIds: [],
          turnIntent: 'save-as-skill',
          createdAt: 3,
          updatedAt: 3
        }
      ],
      activeRun: { promptMessageId: 'save-as-skill-control', startedAt: 3 },
      createdAt: 1,
      updatedAt: 3
    })
    const graph = session.conversationGraph!
    const frame = graph.frames.find(({ id }) => id === graph.activeFrameId)!
    let admissionActive = false
    const admitted = vi.fn()
    registerWithFakes({
      archiveAvailability: {
        withSessionAvailable: async <Result>(
          projectId: string,
          sessionId: string,
          operation: () => Promise<Result>
        ): Promise<Result> => {
          admitted(projectId, sessionId)
          admissionActive = true
          try {
            return await operation()
          } finally {
            admissionActive = false
          }
        },
        withSessionAvailableById: async <Result>(
          _sessionId: string,
          operation: (projectId: string) => Promise<Result>
        ): Promise<Result> => operation('project-1')
      },
      interruptedTurnSessions: { loadSession: vi.fn(async () => session) }
    })
    let completeTurn!: () => void
    sendAppContinuation.mockImplementationOnce(() => {
      expect(admissionActive).toBe(true)
      return new Promise((resolve) => {
        completeTurn = () => resolve(undefined)
      })
    })

    await handlers.get('acp:save-as-skill')?.(
      {},
      {
        projectId: session.projectId,
        sessionId: session.id,
        agentFrameId: frame.id,
        messageBranchId: frame.activeBranchId,
        promptMessageId: 'save-as-skill-control'
      }
    )

    expect(admitted).toHaveBeenCalledWith('project-1', 'session-1')
    expect(admissionActive).toBe(false)
    completeTurn()
  })

  it('pins the complete ACP call and event inventory shared by Electron and Web', () => {
    registerWithFakes()

    const invokeChannels = Object.entries(WEB_INVOKE_CHANNELS)
      .filter(([path]) => path.startsWith('acp.'))
      .map(([, channel]) => channel)
      .sort()
    const eventChannels = Object.entries(WEB_EVENT_CHANNELS)
      .filter(([path]) => path.startsWith('acp.'))
      .map(([, channel]) => channel)
      .sort()

    expect([...handlers.keys()].sort()).toEqual([
      'acp:cancel',
      'acp:compact-session',
      'acp:connect',
      'acp:continue-interrupted-turn',
      'acp:create-session',
      'acp:delete-session',
      'acp:disconnect',
      'acp:get-plan-projection',
      'acp:get-state',
      'acp:reset-session-context',
      'acp:respond-elicitation',
      'acp:respond-permission',
      'acp:respond-plan',
      'acp:resume-session',
      'acp:revoke-permission-grant',
      'acp:save-as-skill',
      'acp:send-prompt',
      'acp:set-permission-profile',
      'acp:steer-follow-up'
    ])
    expect(invokeChannels).toEqual([...handlers.keys()].sort())
    expect(eventChannels).toEqual([
      'acp:agent-runtime-update',
      'acp:event',
      'acp:permission-request',
      'acp:state'
    ])
  })

  it('constructs the coordinator before installing Electron handlers', () => {
    const options = registerWithFakes()
    handlers.clear()

    const runtime = createAcpRuntime(options)

    expect(handlers.size).toBe(0)

    const createSessionWorkflow = createAcpCreateSessionWorkflow(runtime)
    installAcpIpcHandlers(
      runtime,
      createAcpHandlerWorkflows(runtime, createSessionWorkflow, options.taskNotifications),
      undefined,
      passThroughSessionAdmission
    )

    expect(handlers.has('acp:get-state')).toBe(true)
    expect(handlers.has('acp:respond-permission')).toBe(true)
  })
})

describe('ACP runtime composition — memory eligibility', () => {
  it('passes recall to the primary runtime and withholds it from delegated runtimes', () => {
    const memory = { recallForPrompt: vi.fn().mockResolvedValue(undefined) }

    registerWithFakes({ memory })
    expect(AcpRuntimeMock.mock.calls.at(-1)?.[0]).toMatchObject({ memory })

    registerWithFakes({
      memory,
      delegatedNotebookConnection: {} as AcpTestOptions['delegatedNotebookConnection']
    })
    expect(AcpRuntimeMock.mock.calls.at(-1)?.[0]).not.toHaveProperty('memory')
  })
})

describe('ACP runtime composition — Codex transport memory', () => {
  it('persists HTTPS when the completed prompt log contains a native Codex fallback', async () => {
    fallbackEnd.mockReturnValueOnce(true)
    const options = registerWithFakes()
    const callbacks = AcpRuntimeMock.mock.calls.at(-1)?.[0].callbacks
    let finishRemembering: ((remembered: boolean) => void) | undefined
    const remembering = new Promise<boolean>((resolve) => {
      finishRemembering = resolve
    })
    vi.mocked(options.settingsService.rememberCodexAutoHttpsFallback).mockReturnValueOnce(
      remembering
    )

    callbacks.onPromptStarted?.('session-1', 'turn-1')
    callbacks.onPromptEnded?.('session-1', 'turn-1')

    expect(fallbackBegin).toHaveBeenCalledOnce()
    expect(options.settingsService.rememberCodexAutoHttpsFallback).toHaveBeenCalledOnce()
    expect(requestProviderReconnect).not.toHaveBeenCalled()

    finishRemembering?.(true)
    await vi.waitFor(() => expect(requestProviderReconnect).toHaveBeenCalledOnce())
  })

  it('does not reconnect when Auto fallback memory is no longer applicable', async () => {
    fallbackEnd.mockReturnValueOnce(true)
    const options = registerWithFakes()
    vi.mocked(options.settingsService.rememberCodexAutoHttpsFallback).mockResolvedValueOnce(false)
    const callbacks = AcpRuntimeMock.mock.calls.at(-1)?.[0].callbacks

    callbacks.onPromptStarted?.('session-1', 'turn-1')
    callbacks.onPromptEnded?.('session-1', 'turn-1')

    await vi.waitFor(() =>
      expect(options.settingsService.rememberCodexAutoHttpsFallback).toHaveBeenCalledOnce()
    )
    expect(requestProviderReconnect).not.toHaveBeenCalled()
  })
})

describe('ACP runtime composition — Specialist identity resolver', () => {
  it('passes a SpecialistService-backed resolver into each runtime', async () => {
    const profile = {
      name: 'RNA-seq Reviewer',
      systemPrompt: 'Review RNA-seq quality.',
      enabled: true
    }
    const specialistService = { resolveRunnableById: vi.fn().mockResolvedValue(profile) }

    registerWithFakes({ specialistService })

    const options = AcpRuntimeMock.mock.calls.at(-1)?.[0] as {
      resolveSpecialistIdentity?: (id: string, framework: string) => Promise<unknown>
    }
    expect(options.resolveSpecialistIdentity).toBeTypeOf('function')
    await expect(
      options.resolveSpecialistIdentity?.('uuid-1', 'claude-code')
    ).resolves.toMatchObject({
      append: expect.stringContaining('RNA-seq Reviewer'),
      prefix: ''
    })
    expect(specialistService.resolveRunnableById).toHaveBeenCalledWith('uuid-1')
  })

  it('wires the production SpecialistService and live catalog into the Specialist Skill resolver', async () => {
    const specialistService = {
      resolveRunnableById: vi.fn().mockResolvedValue({
        enabled: true,
        capabilityMode: 'selected',
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
        selectedCapabilities: { skillIds: ['main-disabled'], connectorIds: [], connectorTools: [] }
      })
    }
    registerWithFakes({
      specialistService,
      specialistSkillCatalog: [
        { id: 'main-disabled', frameworkName: 'Main Disabled', displayName: 'Main Disabled' }
      ]
    })
    const options = AcpRuntimeMock.mock.calls.at(-1)?.[0] as {
      resolveSpecialistSkills?: (id: string) => Promise<unknown>
    }
    await expect(options.resolveSpecialistSkills?.('uuid-1')).resolves.toEqual({
      kind: 'specialist',
      skillIds: ['main-disabled'],
      frameworkNames: ['Main Disabled'],
      missingSkillIds: []
    })
  })

  it('merges only the specialist-allowed connector skills into the whitelist (selected mode)', async () => {
    const specialistService = {
      resolveRunnableById: vi.fn().mockResolvedValue({
        enabled: true,
        capabilityMode: 'selected',
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
        selectedCapabilities: {
          skillIds: ['skill-a'],
          connectorIds: ['chemistry'],
          connectorTools: []
        }
      })
    }
    registerWithFakes({
      specialistService,
      specialistSkillCatalog: [{ id: 'skill-a', frameworkName: 'Skill A', displayName: 'Skill A' }],
      provisionedConnectorSkillNames: ['mcp-chemistry', 'mcp-literature']
    })
    const options = AcpRuntimeMock.mock.calls.at(-1)?.[0] as {
      resolveSpecialistSkills?: (id: string) => Promise<unknown>
    }
    const result = (await options.resolveSpecialistSkills?.('uuid-1')) as {
      frameworkNames: string[]
    }
    // Selected mode: only connectorIds are allowed, so mcp-literature is filtered out.
    expect(result.frameworkNames).toEqual(['Skill A', 'mcp-chemistry'])
  })

  it('projects a custom Connector UUID to its public runtime skill name', async () => {
    const specialistService = {
      resolveRunnableById: vi.fn().mockResolvedValue({
        enabled: true,
        capabilityMode: 'selected',
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
        selectedCapabilities: {
          skillIds: [],
          connectorIds: ['custom-server-uuid'],
          connectorTools: []
        }
      })
    }
    registerWithFakes({
      specialistService,
      provisionedConnectorSkillNames: ['mcp-public-route'],
      customMcpServers: [{ id: 'custom-server-uuid', name: 'public-route' }]
    })
    const options = AcpRuntimeMock.mock.calls.at(-1)?.[0] as {
      resolveSpecialistSkills?: (id: string) => Promise<unknown>
    }
    const result = (await options.resolveSpecialistSkills?.('uuid-1')) as {
      frameworkNames: string[]
    }

    expect(result.frameworkNames).toEqual(['mcp-public-route'])
  })

  it('excludes full-access blocked connectors from the whitelist (full mode)', async () => {
    const specialistService = {
      resolveRunnableById: vi.fn().mockResolvedValue({
        enabled: true,
        capabilityMode: 'full',
        fullAccess: {
          excludedSkillIds: [],
          excludedConnectorIds: ['literature'],
          connectorTools: []
        },
        selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] }
      })
    }
    registerWithFakes({
      specialistService,
      specialistSkillCatalog: [],
      provisionedConnectorSkillNames: ['mcp-chemistry', 'mcp-literature']
    })
    const options = AcpRuntimeMock.mock.calls.at(-1)?.[0] as {
      resolveSpecialistSkills?: (id: string) => Promise<unknown>
    }
    const result = (await options.resolveSpecialistSkills?.('uuid-1')) as {
      frameworkNames: string[]
    }
    // Full mode: all connectors except excludedConnectorIds; literature is excluded.
    expect(result.frameworkNames).toEqual(['mcp-chemistry'])
  })
})

describe('installAcpIpcHandlers — Skill import cancellation lifecycle', () => {
  it('invalidates a stopped prompt and deleted session before runtime teardown starts', async () => {
    const onSessionCancellationRequested = vi.fn()
    const onSessionUnavailable = vi.fn()
    const beforeSessionDelete = vi.fn().mockResolvedValue(undefined)
    registerWithFakes({
      onSessionCancellationRequested,
      onSessionUnavailable,
      beforeSessionDelete
    })

    await handlers.get('acp:cancel')?.({}, { sessionId: 'session-1' })
    await handlers.get('acp:delete-session')?.({}, { sessionId: 'session-2' })

    expect(onSessionCancellationRequested).toHaveBeenCalledTimes(2)
    expect(onSessionCancellationRequested).toHaveBeenNthCalledWith(1, 'session-1')
    expect(onSessionCancellationRequested).toHaveBeenNthCalledWith(2, 'session-2')
    expect(onSessionUnavailable).toHaveBeenCalledOnce()
    expect(onSessionUnavailable).toHaveBeenCalledWith('session-2')
    expect(beforeSessionDelete).toHaveBeenCalledWith('session-2')
    expect(cancelPrompt).toHaveBeenCalledWith({ sessionId: 'session-1' })
    expect(deleteSession).toHaveBeenCalledWith({ sessionId: 'session-2' })
    expect(onSessionCancellationRequested.mock.invocationCallOrder[0]).toBeLessThan(
      cancelPrompt.mock.invocationCallOrder[0]
    )
    expect(onSessionCancellationRequested.mock.invocationCallOrder[1]).toBeLessThan(
      beforeSessionDelete.mock.invocationCallOrder[0]
    )
    expect(beforeSessionDelete.mock.invocationCallOrder[0]).toBeLessThan(
      deleteSession.mock.invocationCallOrder[0]
    )
    expect(deleteSession.mock.invocationCallOrder[0]).toBeLessThan(
      onSessionUnavailable.mock.invocationCallOrder[0]
    )
  })

  it('keeps the agent session when notebook teardown fails', async () => {
    const onSessionUnavailable = vi.fn()
    const beforeSessionDelete = vi.fn().mockRejectedValue(new Error('notebook shutdown failed'))
    registerWithFakes({ onSessionUnavailable, beforeSessionDelete })

    await expect(
      handlers.get('acp:delete-session')?.({}, { sessionId: 'session-2' })
    ).rejects.toThrow('notebook shutdown failed')

    expect(deleteSession).not.toHaveBeenCalled()
    expect(onSessionUnavailable).not.toHaveBeenCalled()
  })

  it('keeps pending imports invalidated when prompt or session teardown fails', async () => {
    const onSessionCancellationRequested = vi.fn()
    const onSessionUnavailable = vi.fn()
    registerWithFakes({ onSessionCancellationRequested, onSessionUnavailable })
    cancelPrompt.mockRejectedValueOnce(new Error('cancel failed'))
    deleteSession.mockRejectedValueOnce(new Error('delete failed'))

    await expect(handlers.get('acp:cancel')?.({}, { sessionId: 'session-1' })).rejects.toThrow(
      'cancel failed'
    )
    await expect(
      handlers.get('acp:delete-session')?.({}, { sessionId: 'session-2' })
    ).rejects.toThrow('delete failed')

    expect(onSessionCancellationRequested).toHaveBeenCalledTimes(2)
    expect(onSessionCancellationRequested).toHaveBeenNthCalledWith(1, 'session-1')
    expect(onSessionCancellationRequested).toHaveBeenNthCalledWith(2, 'session-2')
    expect(onSessionUnavailable).not.toHaveBeenCalled()
  })

  it('invalidates every pending import before all agent runtimes disconnect', async () => {
    const onAllSessionsCancellationRequested = vi.fn()
    registerWithFakes({ onAllSessionsCancellationRequested })

    await handlers.get('acp:disconnect')?.({}, undefined)

    expect(onAllSessionsCancellationRequested).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(onAllSessionsCancellationRequested.mock.invocationCallOrder[0]).toBeLessThan(
      disconnect.mock.invocationCallOrder[0]
    )
  })

  it('keeps pending imports invalidated when global disconnect fails', async () => {
    const onAllSessionsCancellationRequested = vi.fn()
    registerWithFakes({ onAllSessionsCancellationRequested })
    disconnect.mockRejectedValueOnce(new Error('disconnect failed'))

    await expect(handlers.get('acp:disconnect')?.({}, undefined)).rejects.toThrow(
      'disconnect failed'
    )

    expect(onAllSessionsCancellationRequested).toHaveBeenCalledOnce()
    expect(onAllSessionsCancellationRequested.mock.invocationCallOrder[0]).toBeLessThan(
      disconnect.mock.invocationCallOrder[0]
    )
  })
})

describe('installAcpIpcHandlers — managed session workspace', () => {
  it('registers immediately but waits for initialization before creating the first session', async () => {
    let finishInitialization: (() => void) | undefined
    const initializationBarrier = new Promise<void>((resolve) => {
      finishInitialization = resolve
    })

    registerWithFakes({ initializationBarrier })
    expect(handlers.has('acp:create-session')).toBe(true)

    const creation = handlers.get('acp:create-session')?.(
      {},
      { cwd: '/workspace', projectId: 'project-1', permissionProfile: 'ask' }
    )
    await Promise.resolve()
    expect(createSession).not.toHaveBeenCalled()

    finishInitialization?.()
    await creation

    expect(createSession).toHaveBeenCalledOnce()
  })

  it('creates new sessions in a unique workspace under the configured data root', async () => {
    registerWithFakes()

    const firstResult = await handlers.get('acp:create-session')?.(
      {},
      { projectId: 'project-1', permissionProfile: 'ask' }
    )
    const secondResult = await handlers.get('acp:create-session')?.(
      {},
      { projectId: 'project-1', permissionProfile: 'ask' }
    )

    expect(createSession).toHaveBeenCalledTimes(2)
    const firstRequest = createSession.mock.calls[0][0]
    const secondRequest = createSession.mock.calls[1][0]
    expect(firstRequest).toMatchObject({
      projectId: 'project-1',
      permissionProfile: 'ask',
      cwd: expect.any(String)
    })
    expect(firstRequest.cwd).toMatch(
      new RegExp(`^${join('/tmp/data', 'workspaces').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    )
    expect(secondRequest.cwd).not.toBe(firstRequest.cwd)
    expect(mkdir).toHaveBeenNthCalledWith(1, firstRequest.cwd, { recursive: true })
    expect(mkdir).toHaveBeenNthCalledWith(2, secondRequest.cwd, { recursive: true })
    expect(rm).not.toHaveBeenCalled()
    expect(firstResult).toEqual({ sessionId: 's-new', cwd: firstRequest.cwd })
    expect(secondResult).toEqual({ sessionId: 's-new', cwd: secondRequest.cwd })
  })

  it('preserves an explicitly supplied cwd without creating a managed workspace', async () => {
    registerWithFakes()
    const request = {
      cwd: 'D:\\research\\chosen-workspace',
      projectId: 'project-1',
      permissionProfile: 'ask' as const
    }

    await handlers.get('acp:create-session')?.({}, request)

    expect(createSession).toHaveBeenCalledWith(request)
    expect(mkdir).not.toHaveBeenCalled()
  })

  it('trims an explicitly supplied cwd before creating the session', async () => {
    registerWithFakes()

    await handlers.get('acp:create-session')?.(
      {},
      {
        cwd: '  D:\\research\\chosen-workspace  ',
        projectId: 'project-1',
        permissionProfile: 'ask'
      }
    )

    expect(createSession).toHaveBeenCalledWith({
      cwd: 'D:\\research\\chosen-workspace',
      projectId: 'project-1',
      permissionProfile: 'ask'
    })
    expect(mkdir).not.toHaveBeenCalled()
  })

  it('treats a blank cwd as missing and allocates a managed workspace', async () => {
    registerWithFakes()

    await handlers.get('acp:create-session')?.(
      {},
      { cwd: '   ', projectId: 'project-1', permissionProfile: 'ask' }
    )

    const request = createSession.mock.calls[0][0]
    expect(request.cwd).not.toBe('   ')
    expect(mkdir).toHaveBeenCalledWith(request.cwd, { recursive: true })
  })

  it('rejects managed workspace creation while a data-root migration is pending', async () => {
    registerWithFakes()
    beginMigration()

    await expect(
      handlers.get('acp:create-session')?.({}, { projectId: 'project-1', permissionProfile: 'ask' })
    ).rejects.toThrow(/moving your data/i)

    expect(mkdir).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
  })

  it('keeps migration drain pending until managed session creation finishes', async () => {
    registerWithFakes()
    let finishCreateSession!: () => void
    createSession.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          finishCreateSession = () => resolve({ sessionId: 's-new', cwd: request.cwd })
        })
    )

    const createPromise = handlers.get('acp:create-session')?.(
      {},
      { projectId: 'project-1', permissionProfile: 'ask' }
    )
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1))

    beginMigration()
    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()

    expect(drained).toBe(false)

    finishCreateSession()
    await createPromise
    await drainPromise
    expect(drained).toBe(true)
  })

  it('removes a managed workspace when session creation fails', async () => {
    registerWithFakes()
    const error = new Error('session creation failed')
    createSession.mockRejectedValueOnce(error)

    await expect(
      handlers.get('acp:create-session')?.({}, { projectId: 'project-1', permissionProfile: 'ask' })
    ).rejects.toBe(error)

    const request = createSession.mock.calls[0][0]
    expect(mkdir).toHaveBeenCalledWith(request.cwd, { recursive: true })
    expect(rm).toHaveBeenCalledWith(request.cwd, { recursive: true, force: true })
  })

  it('removes a managed workspace when session creation is superseded', async () => {
    registerWithFakes()
    const superseded = new Error('ACP session startup was superseded')
    createSession.mockRejectedValueOnce(superseded)

    await expect(
      handlers.get('acp:create-session')?.({}, { projectId: 'project-1', permissionProfile: 'ask' })
    ).rejects.toBe(superseded)

    const request = createSession.mock.calls[0][0]
    expect(rm).toHaveBeenCalledWith(request.cwd, { recursive: true, force: true })
  })

  it('keeps the data-root writer until failed-session workspace rollback finishes', async () => {
    registerWithFakes()
    const failure = new Error('session creation failed')
    createSession.mockRejectedValueOnce(failure)
    let finishRollback!: () => void
    rm.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRollback = resolve
        })
    )

    const createPromise = handlers.get('acp:create-session')?.(
      {},
      { projectId: 'project-1', permissionProfile: 'ask' }
    )
    await vi.waitFor(() => expect(rm).toHaveBeenCalledTimes(1))

    beginMigration()
    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()

    expect(drained).toBe(false)

    finishRollback()
    await expect(createPromise).rejects.toBe(failure)
    await drainPromise
    expect(drained).toBe(true)
  })

  it('keeps the session creation error when managed workspace rollback also fails', async () => {
    registerWithFakes()
    const failure = new Error('session creation failed')
    createSession.mockRejectedValueOnce(failure)
    rm.mockRejectedValueOnce(new Error('workspace rollback failed'))

    await expect(
      handlers.get('acp:create-session')?.({}, { projectId: 'project-1', permissionProfile: 'ask' })
    ).rejects.toBe(failure)
  })
})

describe('installAcpIpcHandlers — reset-session-context bridge', () => {
  const persistedProjectId = 'persisted-project'
  const ownerResolvingArchiveAvailability = {
    withSessionAvailable: async <Result>(
      _projectId: string,
      _sessionId: string,
      operation: () => Promise<Result>
    ): Promise<Result> => operation(),
    withSessionAvailableById: async <Result>(
      _sessionId: string,
      operation: (projectId: string) => Promise<Result>
    ): Promise<Result> => operation(persistedProjectId)
  }

  it('registers the acp:reset-session-context channel', () => {
    registerWithFakes()
    expect(handlers.has('acp:reset-session-context')).toBe(true)
  })

  it('forwards the request to runtime.resetSessionContext and returns its result', async () => {
    registerWithFakes()
    const request: AcpResumeSessionRequest = { sessionId: 's-1', cwd: '/workspace' }

    const result = await handlers.get('acp:reset-session-context')?.({}, request)

    expect(resetSessionContext).toHaveBeenCalledTimes(1)
    expect(resetSessionContext).toHaveBeenCalledWith({ ...request, projectId: 'project-1' })
    // The distinct resume channel must not be driven by the reset call.
    expect(resumeSession).not.toHaveBeenCalled()
    expect(result).toEqual({ sessionId: 's-1', cwd: '/workspace', contextReset: true })
  })

  it('injects the persisted Project owner when the request omits projectId', async () => {
    registerWithFakes({ archiveAvailability: ownerResolvingArchiveAvailability })
    const request: AcpResumeSessionRequest = { sessionId: 's-1', cwd: '/workspace' }

    await handlers.get('acp:reset-session-context')?.({}, request)

    expect(resetSessionContext).toHaveBeenCalledWith({
      ...request,
      projectId: persistedProjectId
    })
  })

  it('rejects a request whose projectId disagrees with the persisted owner', async () => {
    registerWithFakes({ archiveAvailability: ownerResolvingArchiveAvailability })

    await expect(
      handlers.get('acp:reset-session-context')?.(
        {},
        { sessionId: 's-1', cwd: '/workspace', projectId: 'forged-project' }
      )
    ).rejects.toThrow('Session does not belong to the requested Project.')

    expect(resetSessionContext).not.toHaveBeenCalled()
  })

  it('uses the durable Memory preference for renderer resume and reset requests', async () => {
    const resolveMemoryEnabled = vi.fn(async () => false)
    registerWithFakes({ resolveMemoryEnabled })
    const request: AcpResumeSessionRequest = {
      sessionId: 's-1',
      cwd: '/workspace',
      projectId: 'project-1',
      memoryEnabled: true
    }

    await handlers.get('acp:resume-session')?.({}, request)
    await handlers.get('acp:reset-session-context')?.({}, request)

    expect(resumeSession).toHaveBeenCalledWith({ ...request, memoryEnabled: false })
    expect(resetSessionContext).toHaveBeenCalledWith({ ...request, memoryEnabled: false })
    expect(resolveMemoryEnabled).toHaveBeenCalledTimes(2)
    expect(resolveMemoryEnabled).toHaveBeenNthCalledWith(1, { sessionId: request.sessionId })
    expect(resolveMemoryEnabled).toHaveBeenNthCalledWith(2, { sessionId: request.sessionId })
  })

  it('fails closed when the durable Memory preference is missing', async () => {
    const resolveMemoryEnabled = vi.fn(async () => undefined)
    registerWithFakes({ resolveMemoryEnabled })
    const request: AcpResumeSessionRequest = {
      sessionId: 's-1',
      cwd: '/workspace',
      projectId: 'project-1',
      memoryEnabled: true
    }

    await handlers.get('acp:resume-session')?.({}, request)
    await handlers.get('acp:reset-session-context')?.({}, request)

    expect(resumeSession).toHaveBeenCalledWith({ ...request, memoryEnabled: false })
    expect(resetSessionContext).toHaveBeenCalledWith({ ...request, memoryEnabled: false })
    expect(resolveMemoryEnabled).toHaveBeenCalledTimes(2)
  })

  it('rejects reset before runtime mutation when Session admission is closed', async () => {
    const failure = new Error('Project is being deleted.')
    const withSessionAvailableById = vi.fn().mockRejectedValue(failure)
    registerWithFakes({
      archiveAvailability: {
        withSessionAvailable: async <Result>(
          _projectId: string,
          _sessionId: string,
          operation: () => Promise<Result>
        ): Promise<Result> => operation(),
        withSessionAvailableById
      }
    })
    const request: AcpResumeSessionRequest = { sessionId: 's-1', cwd: '/workspace' }

    await expect(handlers.get('acp:reset-session-context')?.({}, request)).rejects.toBe(failure)

    expect(withSessionAvailableById).toHaveBeenCalledWith('s-1', expect.any(Function))
    expect(resetSessionContext).not.toHaveBeenCalled()
  })

  it('does not nest Session admission around the coordinator follow-up guard', async () => {
    let archiveQueue: Promise<void> = Promise.resolve()
    const enqueueArchive = <Result>(operation: () => Promise<Result>): Promise<Result> => {
      const result = archiveQueue.then(operation, operation)
      archiveQueue = result.then(
        () => undefined,
        () => undefined
      )
      return result
    }
    const archiveAvailability = {
      withSessionAvailableById: <Result>(
        _sessionId: string,
        operation: (projectId: string) => Promise<Result>
      ): Promise<Result> => enqueueArchive(() => operation('project-1'))
    }
    const withSessionAvailableById = vi.spyOn(archiveAvailability, 'withSessionAvailableById')
    const steerFollowUp = vi.fn(() =>
      archiveAvailability.withSessionAvailableById('s-1', async () => ({
        injected: false as const,
        reason: 'prompt-required' as const
      }))
    )
    installAcpIpcHandlers({ steerFollowUp } as never, {} as never, undefined, archiveAvailability)
    const request: AcpSteerFollowUpRequest = { sessionId: 's-1', text: 'focus on tests' }

    const outcome = await handlers.get('acp:steer-follow-up')?.({}, request)

    expect(outcome).toEqual({ injected: false, reason: 'prompt-required' })
    expect(withSessionAvailableById).toHaveBeenCalledWith('s-1', expect.any(Function))
    expect(withSessionAvailableById).toHaveBeenCalledOnce()
    expect(steerFollowUp).toHaveBeenCalledWith(request)
  })
})

describe('installAcpIpcHandlers — resume-session diagnostics', () => {
  it('holds archive admission until runtime resume completes', async () => {
    let admissionActive = false
    const admitted = vi.fn()
    const archiveAvailability = {
      withSessionAvailable: async <Result>(
        projectId: string,
        sessionId: string,
        operation: () => Promise<Result>
      ): Promise<Result> => {
        admitted(projectId, sessionId, operation)
        admissionActive = true
        try {
          return await operation()
        } finally {
          admissionActive = false
        }
      },
      withSessionAvailableById: async <Result>(
        sessionId: string,
        operation: (projectId: string) => Promise<Result>
      ): Promise<Result> => {
        admitted('project-1', sessionId, operation)
        admissionActive = true
        try {
          return await operation('project-1')
        } finally {
          admissionActive = false
        }
      }
    }
    registerWithFakes({ archiveAvailability })
    const request: AcpResumeSessionRequest = {
      sessionId: 'session-1',
      cwd: '/workspace',
      projectId: 'project-1'
    }
    resumeSession.mockImplementationOnce(async () => {
      expect(admissionActive).toBe(true)
      return { sessionId: request.sessionId, cwd: request.cwd }
    })

    await handlers.get('acp:resume-session')?.({}, request)

    expect(admitted).toHaveBeenCalledWith('project-1', request.sessionId, expect.any(Function))
    expect(admissionActive).toBe(false)
  })

  it('logs a privacy-safe correlated lifecycle on success', async () => {
    registerWithFakes()
    const request: AcpResumeSessionRequest = {
      sessionId: 'private-session-id',
      cwd: '/Users/alice/private-project',
      projectId: 'private-project'
    }
    resumeSession.mockResolvedValueOnce({
      sessionId: request.sessionId,
      cwd: request.cwd,
      frameworkId: 'codex',
      backendId: 'private-backend-id',
      contextReset: true
    })

    await handlers.get('acp:resume-session')?.({}, request)

    const started = infoLogSpy.mock.calls.find(
      ([message]) => message === 'acp:resume-session started'
    )
    const completed = infoLogSpy.mock.calls.find(
      ([message]) => message === 'acp:resume-session completed'
    )
    expect(started?.[1]).toMatchObject({
      operationId: expect.any(String),
      sessionHash: expect.stringMatching(/^[a-f0-9]{12}$/)
    })
    expect(completed?.[1]).toMatchObject({
      operationId: started?.[1]?.operationId,
      sessionHash: started?.[1]?.sessionHash,
      frameworkId: 'codex',
      contextReset: true,
      durationMs: expect.any(Number)
    })
    const serialized = JSON.stringify(infoLogSpy.mock.calls)
    expect(serialized).not.toContain(request.sessionId)
    expect(serialized).not.toContain(request.cwd)
    expect(serialized).not.toContain(request.projectId)
    expect(serialized).not.toContain('private-backend-id')
  })

  it('classifies a failure without logging private error details', async () => {
    registerWithFakes()
    const request: AcpResumeSessionRequest = {
      sessionId: 'private-session-id',
      cwd: '/Users/alice/private-project'
    }
    const failure = Object.assign(
      new Error('private provider detail at https://secret.example.test'),
      {
        name: 'RequestError',
        code: -32603,
        data: {
          errorKind: 'session_not_found',
          service: 'session',
          details: 'private upstream details'
        }
      }
    )
    resumeSession.mockRejectedValueOnce(failure)

    await expect(handlers.get('acp:resume-session')?.({}, request)).rejects.toBe(failure)

    const started = infoLogSpy.mock.calls.find(
      ([message]) => message === 'acp:resume-session started'
    )
    const failed = errorLogSpy.mock.calls.find(
      ([message]) => message === 'acp:resume-session failed'
    )
    expect(failed?.[1]).toMatchObject({
      operationId: started?.[1]?.operationId,
      sessionHash: started?.[1]?.sessionHash,
      errorCategory: 'request',
      rpcCode: -32603,
      errorKind: 'session_not_found',
      service: 'session',
      durationMs: expect.any(Number)
    })
    const serialized = JSON.stringify([infoLogSpy.mock.calls, errorLogSpy.mock.calls])
    expect(serialized).not.toContain(request.sessionId)
    expect(serialized).not.toContain(request.cwd)
    expect(serialized).not.toContain('secret.example.test')
    expect(serialized).not.toContain('private upstream details')
  })

  it('buckets an unknown numeric RPC code instead of copying it into the log', async () => {
    registerWithFakes()
    const privateCode = 987_654_321
    resumeSession.mockRejectedValueOnce(
      Object.assign(new Error('private detail'), { code: privateCode })
    )

    await expect(
      handlers.get('acp:resume-session')?.(
        {},
        { sessionId: 'private-session-id', cwd: '/private/workspace' }
      )
    ).rejects.toThrow('private detail')

    const failed = errorLogSpy.mock.calls.find(
      ([message]) => message === 'acp:resume-session failed'
    )
    expect(failed?.[1]).toMatchObject({ errorCategory: 'request', rpcCode: 'other' })
    expect(JSON.stringify(failed)).not.toContain(String(privateCode))
  })

  it('keeps resume results and failures authoritative when diagnostics throw', async () => {
    registerWithFakes()
    const request: AcpResumeSessionRequest = {
      sessionId: 'private-session-id',
      cwd: '/private/workspace'
    }
    const result = {
      sessionId: request.sessionId,
      cwd: request.cwd,
      frameworkId: 'codex' as const
    }
    infoLogSpy.mockImplementationOnce(() => {
      throw new Error('diagnostic sink failed')
    })
    resumeSession.mockResolvedValueOnce(result)

    await expect(handlers.get('acp:resume-session')?.({}, request)).resolves.toBe(result)

    const failure = new Error('resume failed')
    errorLogSpy.mockImplementationOnce(() => {
      throw new Error('diagnostic sink failed')
    })
    resumeSession.mockRejectedValueOnce(failure)

    await expect(handlers.get('acp:resume-session')?.({}, request)).rejects.toBe(failure)
  })
})

describe('installAcpIpcHandlers — native context compaction bridge', () => {
  it('forwards the session to its runtime and returns the refreshed snapshot', async () => {
    registerWithFakes()
    const request: AcpCompactSessionRequest = { sessionId: 's-1' }

    const result = await handlers.get('acp:compact-session')?.({}, request)

    expect(compactSession).toHaveBeenCalledOnce()
    expect(compactSession).toHaveBeenCalledWith(request)
    expect(result).toMatchObject({ status: 'idle', cwd: '/workspace' })
  })

  it('rejects compaction before runtime mutation when Session admission is closed', async () => {
    const failure = new Error('Project is being deleted.')
    const withSessionAvailableById = vi.fn().mockRejectedValue(failure)
    registerWithFakes({
      archiveAvailability: {
        withSessionAvailable: async <Result>(
          _projectId: string,
          _sessionId: string,
          operation: () => Promise<Result>
        ): Promise<Result> => operation(),
        withSessionAvailableById
      }
    })
    const request: AcpCompactSessionRequest = { sessionId: 's-1' }

    await expect(handlers.get('acp:compact-session')?.({}, request)).rejects.toBe(failure)

    expect(withSessionAvailableById).toHaveBeenCalledWith('s-1', expect.any(Function))
    expect(compactSession).not.toHaveBeenCalled()
  })
})

describe('installAcpIpcHandlers — create-session failure logging', () => {
  it('logs the failure via the file logger and re-throws so the renderer still sees the error', async () => {
    registerWithFakes()
    const failure = Object.assign(new Error('Internal error'), { code: -32603 })
    createSession.mockRejectedValueOnce(failure)

    await expect(handlers.get('acp:create-session')?.({}, {})).rejects.toBe(failure)

    expect(errorLogSpy).toHaveBeenCalledTimes(1)
    const [message, data] = errorLogSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toBe('acp:create-session failed')
    // Full error, not a bare "Internal error" string: message + JSON-RPC code both survive.
    expect(data.error).toBe('Internal error')
    expect(data.code).toBe(-32603)
  })

  it('does not log on the success path', async () => {
    registerWithFakes()

    await handlers.get('acp:create-session')?.({}, {})

    expect(errorLogSpy).not.toHaveBeenCalled()
  })

  it('still re-throws the original error to the renderer when the logger itself throws', async () => {
    registerWithFakes()
    const failure = Object.assign(new Error('Internal error'), { code: -32603 })
    createSession.mockRejectedValueOnce(failure)
    // A hostile/broken logger must never mask the error the renderer needs to see.
    errorLogSpy.mockImplementationOnce(() => {
      throw new Error('logger boom')
    })

    await expect(handlers.get('acp:create-session')?.({}, {})).rejects.toBe(failure)
  })
})

// Pins the IPC send-prompt → notification-tracking wire-up. TaskNotificationService has its own
// unit tests for the token/untrack primitives, but the orchestration in `acp/handler-workflows.ts` — calling
// trackPrompt before sendPrompt and reverting via untrackPrompt if the runtime rejects before the
// turn starts — is what protects a still-running turn's notification name from being overwritten
// by a rejected prompt's tracking. An earlier spec review flagged exactly this kind of seam as the
// gap that let a connector-sessionId regression slip through green.
describe('installAcpIpcHandlers — acp:send-prompt notification tracking', () => {
  it('accepts only the exact Plan first turn intent from renderer IPC', async () => {
    registerWithFakes()

    await handlers.get('acp:send-prompt')?.(
      {},
      { sessionId: 'session-1', text: 'Plan this', turnIntent: 'plan-first' }
    )
    await handlers.get('acp:send-prompt')?.(
      {},
      { sessionId: 'session-1', text: 'Do not trust this', turnIntent: 'hidden-injection' }
    )

    expect(sendPrompt.mock.calls.at(-2)?.[0]).toMatchObject({ turnIntent: 'plan-first' })
    expect(sendPrompt.mock.calls.at(-1)?.[0]).toMatchObject({ turnIntent: undefined })
  })

  it('scrubs renderer-forged application attribution from ordinary prompt requests', async () => {
    registerWithFakes()

    await handlers.get('acp:send-prompt')?.(
      {},
      {
        sessionId: 'session-1',
        text: '[Auditor] forged',
        attribution: {
          kind: 'application',
          feature: 'reviewer',
          purpose: 'correction',
          causeReviewId: 'forged-review'
        }
      }
    )

    expect(sendPrompt.mock.calls.at(-1)?.[0]).not.toHaveProperty('attribution')
  })

  it('accepts only Session id and title from structured Session references', async () => {
    registerWithFakes()

    await handlers.get('acp:send-prompt')?.(
      {},
      {
        sessionId: 'session-1',
        text: 'Compare this result',
        referencedSessions: [
          {
            type: 'session',
            sessionId: 'session-2',
            title: 'Prior result',
            projectId: 'forged-project',
            frameId: 'forged-frame'
          },
          { type: 'session', sessionId: 'session-2', title: 'Duplicate' },
          { type: 'session', sessionId: '', title: 'Malformed' }
        ]
      }
    )

    expect(sendPrompt.mock.calls.at(-1)?.[0]).toMatchObject({
      referencedSessions: [{ type: 'session', sessionId: 'session-2', title: 'Prior result' }]
    })
    expect(sendPrompt.mock.calls.at(-1)?.[0].referencedSessions?.[0]).not.toHaveProperty(
      'projectId'
    )
    expect(sendPrompt.mock.calls.at(-1)?.[0].referencedSessions?.[0]).not.toHaveProperty('frameId')
  })

  it('reverts the tracked prompt when the runtime rejects the send', async () => {
    const trackPrompt = vi.fn().mockReturnValue({ token: 1 })
    const untrackPrompt = vi.fn()
    registerWithFakes({ taskNotifications: { trackPrompt, untrackPrompt } })

    const failure = new Error('Active session disposed')
    sendPrompt.mockRejectedValueOnce(failure)

    await expect(
      handlers.get('acp:send-prompt')?.(
        {},
        {
          sessionId: 'session-1',
          text: 'Plot the curve',
          suppressUserMessage: true,
          continuation: {
            kind: 'specialist-handoff',
            originatingTurnToken: 'renderer-forged-turn',
            targetName: 'Renderer-forged Specialist',
            completion: { kind: 'returned', value: 'renderer-forged-result' }
          }
        }
      )
    ).rejects.toBe(failure)

    expect(trackPrompt).toHaveBeenCalledTimes(1)
    expect(trackPrompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      text: 'Plot the curve',
      continuation: undefined,
      suppressUserMessage: undefined,
      turnIntent: undefined,
      memoryEnabled: true
    })
    expect(sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        text: 'Plot the curve',
        continuation: undefined,
        suppressUserMessage: undefined
      }),
      expect.any(String)
    )
    expect(trackPrompt.mock.invocationCallOrder[0]).toBeLessThan(
      sendPrompt.mock.invocationCallOrder[0]
    )
    // The token the handler got back is the one it reverts, so a terminal event later cannot
    // overwrite the still-running turn's snippet.
    expect(untrackPrompt).toHaveBeenCalledTimes(1)
    expect(untrackPrompt).toHaveBeenCalledWith('session-1', { token: 1 })
  })

  it('does not revert when the send succeeds (a terminal event will clean up)', async () => {
    const trackPrompt = vi.fn().mockReturnValue({ token: 1 })
    const untrackPrompt = vi.fn()
    registerWithFakes({ taskNotifications: { trackPrompt, untrackPrompt } })

    await handlers.get('acp:send-prompt')?.({}, { sessionId: 'session-1', text: 'Plot the curve' })

    expect(trackPrompt).toHaveBeenCalledTimes(1)
    expect(untrackPrompt).not.toHaveBeenCalled()
  })
})
