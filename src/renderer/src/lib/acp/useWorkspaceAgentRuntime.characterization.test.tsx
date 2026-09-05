// @vitest-environment jsdom

import { join } from 'node:path'
import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import {
  ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_REARM_FAILED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE,
  type AcpAgentRuntimeUpdate,
  type AcpCreateSessionResponse,
  type AcpPermissionRequest,
  type AcpRuntimeEvent,
  type AcpStateSnapshot
} from '../../../../shared/acp'
import {
  createInitialSessionState,
  toPersistedSession,
  useSessionStore
} from '../../stores/session-store'
import { SESSION_SIZE_LIMIT_ERROR_CODE } from '../../../../shared/session-persistence'
import { createInitialSettingsState, useSettingsStore } from '../../stores/settings-store'
import { resetDeferredArtifactEventsForTests } from './workspace-events'
import { acceptAcpRuntimeSnapshotRevision } from './runtime-snapshot-revision-owner'
import {
  drainWorkspaceRuntimeEventsForPersistence,
  resetWorkspaceRuntimeEventOwnerForTests
} from './workspace-runtime-event-owner'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const runtimeMock = vi.hoisted(() => ({ current: {} as unknown }))
const useAcpRuntimeMock = vi.hoisted(() => vi.fn())

vi.mock('./useAcpRuntime', () => ({
  useAcpRuntime: useAcpRuntimeMock
}))

import { useWorkspaceAgentRuntime, WorkspaceAgentRuntimeProvider } from './useWorkspaceAgentRuntime'

const workspacePath = join('workspace', 'project')

const createSnapshot = (overrides: Partial<AcpStateSnapshot> = {}): AcpStateSnapshot => ({
  status: 'connected',
  cwd: workspacePath,
  sessionIds: [],
  events: [],
  pendingPermissions: [],
  pendingElicitations: [],
  permissionProfiles: {},
  permissionGrants: {},
  contextUsageBySession: {},
  promptInFlight: false,
  promptInFlightSessionIds: [],
  agentPromptInFlightSessionIds: [],
  ...overrides
})

type RuntimeMock = {
  state: AcpStateSnapshot
  reconcileSnapshot: Mock
  actionError: string | null
  isConnecting: boolean
  createSession: Mock
  resumeSession: Mock
  resetSessionContext: Mock
  sendPrompt: Mock
  steerFollowUp: Mock
  compactSession: Mock
  cancel: Mock
  deleteSession: Mock
  respondToPermission: Mock
  respondToElicitation: Mock
  setPermissionProfile: Mock
  revokePermissionGrant: Mock
  subscribeRuntimeEvents?: Mock
  currentRuntimeEvents?: () => readonly AcpRuntimeEvent[]
}

const createRuntime = (state: AcpStateSnapshot): RuntimeMock => ({
  state,
  reconcileSnapshot: vi.fn(),
  actionError: null as string | null,
  isConnecting: false,
  createSession: vi.fn(),
  resumeSession: vi.fn(),
  resetSessionContext: vi.fn(),
  sendPrompt: vi.fn().mockResolvedValue(state),
  steerFollowUp: vi.fn().mockResolvedValue({ injected: false, reason: 'not-advertised' }),
  compactSession: vi.fn(),
  cancel: vi.fn(),
  deleteSession: vi.fn(),
  respondToPermission: vi.fn().mockResolvedValue(state),
  respondToElicitation: vi.fn().mockResolvedValue(state),
  setPermissionProfile: vi.fn(),
  revokePermissionGrant: vi.fn().mockResolvedValue(state)
})

const createDeferred = <Value,>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

describe('workspace Agent Runtime hook contract', () => {
  let container: HTMLDivElement
  let root: Root
  let latest!: ReturnType<typeof useWorkspaceAgentRuntime>

  const Probe = (): JSX.Element | null => {
    latest = useWorkspaceAgentRuntime()
    return null
  }

  const render = async (onSessionSizeLimit?: (sessionId: string) => void): Promise<void> => {
    await act(async () =>
      root.render(
        <WorkspaceAgentRuntimeProvider onSessionSizeLimit={onSessionSizeLimit}>
          <Probe />
        </WorkspaceAgentRuntimeProvider>
      )
    )
  }

  const projectRestoredPermissionPending = (request: AcpPermissionRequest): void => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === request.sessionId
          ? {
              ...session,
              status: 'waiting-permission',
              activeRun: undefined,
              runtimeContext: {
                ...session.runtimeContext,
                version: 1,
                revision: (session.runtimeContext?.revision ?? 0) + 1,
                permission: {
                  state: 'pending',
                  request,
                  originatingPromptMessageId: session.messages[0].id,
                  fingerprint: 'a'.repeat(64),
                  createdAt: 1
                }
              }
            }
          : session
      )
    }))
  }

  const arrangeRestoredPermission = (): {
    request: AcpPermissionRequest
    runtime: RuntimeMock
  } => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Run the verification',
      cwd: workspacePath,
      projectId: 'project-1',
      agentFrameworkId: 'claude-code'
    })
    const request: AcpPermissionRequest = {
      requestId: 'permission-restored',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      title: 'Run npm test',
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    }
    projectRestoredPermissionPending(request)
    const runtime = createRuntime(createSnapshot({ sessionIds: ['session-1'] }))
    runtimeMock.current = runtime
    return { request, runtime }
  }

  beforeEach(() => {
    resetDeferredArtifactEventsForTests()
    resetWorkspaceRuntimeEventOwnerForTests()
    useSessionStore.setState(createInitialSessionState())
    useSettingsStore.setState(createInitialSettingsState())
    runtimeMock.current = createRuntime(createSnapshot())
    useAcpRuntimeMock.mockReset()
    useAcpRuntimeMock.mockImplementation(() => runtimeMock.current)
    window.api = {
      acp: { getState: vi.fn().mockResolvedValue(createSnapshot()) }
    } as never
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('publishes the exact state and command surface consumed by WorkspacePage', async () => {
    const snapshot = createSnapshot({
      sessionIds: ['session-1'],
      pendingPermissions: [
        {
          requestId: 'permission-1',
          sessionId: 'session-1',
          toolCallId: 'tool-1',
          title: 'Allow command?',
          options: []
        }
      ],
      pendingElicitations: [
        {
          requestId: 'elicitation-1',
          sessionId: 'session-1',
          toolCallId: 'tool-choice-1',
          message: 'Choose an approach',
          fields: []
        }
      ],
      permissionProfiles: {
        'session-1': {
          selectedProfile: 'ask',
          effectiveProfile: 'ask',
          availableModeIds: ['default'],
          fullAccessAvailable: true
        }
      },
      permissionGrants: {
        'session-1': [{ categoryKey: 'shell:git', label: 'Git', kind: 'shell', scope: 'session' }]
      },
      contextUsageBySession: { 'session-1': { used: 128, size: 4_096 } },
      promptInFlight: true,
      promptInFlightSessionIds: ['session-1'],
      nativeContextCompactionSessionIds: ['session-1']
    })
    runtimeMock.current = {
      ...createRuntime(snapshot),
      actionError: 'runtime warning',
      isConnecting: true
    }

    await render()

    expect(useAcpRuntimeMock).toHaveBeenCalledOnce()

    expect(Object.keys(latest).sort()).toEqual(
      [
        'actionError',
        'isConnecting',
        'pendingPermissions',
        'permissionProfiles',
        'permissionGrants',
        'contextUsageBySession',
        'delegatedWorkUnavailableBySession',
        'promptInFlightSessionIds',
        'sendPreparationInFlightSessionIds',
        'saveAsSkillInFlightSessionIds',
        'nativeContextCompactionSessionIds',
        'subscribeToSubagentRuntimeUpdates',
        'compactContext',
        'ensureSessionReady',
        'saveAsSkill',
        'sendMessage',
        'resendEditedMessage',
        'cancelRun',
        'steerFollowUp',
        'resumeInterruptedSession',
        'resolveSessionRuntimeSelection',
        'respondToPermission',
        'setPermissionProfile',
        'setMemoryEnabled',
        'revokePermissionGrant'
      ].sort()
    )
    expect(latest).toMatchObject({
      actionError: 'runtime warning',
      isConnecting: true,
      pendingPermissions: snapshot.pendingPermissions,
      permissionProfiles: snapshot.permissionProfiles,
      permissionGrants: snapshot.permissionGrants,
      contextUsageBySession: snapshot.contextUsageBySession,
      delegatedWorkUnavailableBySession: {},
      promptInFlightSessionIds: ['session-1'],
      sendPreparationInFlightSessionIds: [],
      saveAsSkillInFlightSessionIds: [],
      nativeContextCompactionSessionIds: ['session-1']
    })
  })

  it('resolves image input support from the Session-selected official model', async () => {
    useSettingsStore.setState({
      activeProviderId: 'deepseek',
      agentFrameworkId: 'claude-code',
      agentFrameworks: [
        {
          id: 'claude-code',
          displayName: 'Claude Code',
          supportsSkills: true,
          supportedApiTypes: ['anthropic']
        }
      ],
      providers: [
        {
          id: 'deepseek',
          type: 'official',
          vendorId: 'deepseek',
          name: 'DeepSeek',
          apiEndpoints: ['anthropic'],
          model: 'deepseek-v4-pro',
          models: ['deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'],
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        }
      ]
    })
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Inspect the image.',
      cwd: workspacePath,
      projectId: 'project-1',
      agentConfiguration: {
        providerId: 'deepseek',
        model: 'deepseek-v4-flash-vision-exp',
        reasoningEffort: 'default'
      }
    })
    useSessionStore.getState().finishRun('session-1')

    await render()

    expect(latest.resolveSessionRuntimeSelection('session-1').supportsImageInput).toBe(true)
  })

  it('resolves runtime selection from legacy backend identity when configuration is absent', async () => {
    useSettingsStore.setState({
      activeProviderId: 'deepseek',
      reasoningEffort: 'low',
      agentFrameworkId: 'claude-code',
      agentFrameworks: [
        {
          id: 'claude-code',
          displayName: 'Claude Code',
          supportsSkills: true,
          supportedApiTypes: ['anthropic']
        }
      ],
      providers: [
        {
          id: 'deepseek',
          type: 'official',
          vendorId: 'deepseek',
          name: 'DeepSeek',
          apiEndpoints: ['anthropic'],
          model: 'deepseek-v4-pro',
          models: ['deepseek-v4-pro'],
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        },
        {
          id: 'legacy-provider',
          type: 'official',
          vendorId: 'anthropic',
          name: 'Legacy',
          apiEndpoints: ['anthropic'],
          model: 'legacy-model',
          models: ['legacy-model'],
          supportsImageInput: true,
          hasKey: true,
          needsKey: false
        }
      ]
    })
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Continue the restored chat.',
      cwd: workspacePath,
      projectId: 'project-1',
      agentFrameworkId: 'claude-code',
      agentBackendId: 'claude-code:legacy-provider',
      agentModel: 'legacy-model'
    })
    useSessionStore.getState().finishRun('session-1')

    await render()

    expect(useSessionStore.getState().sessions[0].agentConfiguration).toBeUndefined()
    expect(latest.resolveSessionRuntimeSelection('session-1')).toMatchObject({
      agentBackendId: 'claude-code:legacy-provider',
      agentModel: 'legacy-model',
      supportsImageInput: true,
      agentTarget: {
        frameworkId: 'claude-code',
        providerId: 'legacy-provider',
        model: 'legacy-model',
        reasoningEffort: 'low'
      }
    })
  })

  it('falls back to the Settings Active Model instead of the provider base model', async () => {
    useSettingsStore.setState({
      activeProviderId: 'custom',
      activeModel: 'settings-selected',
      reasoningEffort: 'low',
      agentFrameworkId: 'claude-code',
      agentFrameworks: [
        {
          id: 'claude-code',
          displayName: 'Claude Code',
          supportsSkills: true,
          supportedApiTypes: ['anthropic']
        }
      ],
      providers: [
        {
          id: 'custom',
          type: 'custom',
          name: 'Custom',
          apiEndpoints: ['anthropic'],
          baseUrl: 'https://example.test/v1',
          model: 'provider-base',
          models: ['provider-base', 'settings-selected'],
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        }
      ]
    })
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Continue the restored chat.',
      cwd: workspacePath,
      projectId: 'project-1',
      agentFrameworkId: 'claude-code',
      agentBackendId: 'claude-code:deleted-provider',
      agentModel: 'gone'
    })
    useSessionStore.getState().finishRun('session-1')

    await render()

    expect(latest.resolveSessionRuntimeSelection('session-1')).toMatchObject({
      agentBackendId: 'claude-code:custom',
      agentModel: 'settings-selected',
      agentTarget: {
        frameworkId: 'claude-code',
        providerId: 'custom',
        model: 'settings-selected',
        reasoningEffort: 'low'
      }
    })
  })

  it('does not auto-send when the Session target is unavailable', async () => {
    useSettingsStore.setState({
      activeProviderId: 'incompatible',
      activeModel: 'other',
      reasoningEffort: 'low',
      agentFrameworkId: 'claude-code',
      agentFrameworks: [
        {
          id: 'claude-code',
          displayName: 'Claude Code',
          supportsSkills: true,
          supportedApiTypes: ['anthropic']
        }
      ],
      providers: [
        {
          id: 'incompatible',
          type: 'custom',
          name: 'Incompatible',
          apiEndpoints: ['openai'],
          baseUrl: 'https://example.test/v1',
          model: 'other',
          models: ['other'],
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        }
      ]
    })
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Earlier turn',
      cwd: workspacePath,
      projectId: 'project-1',
      agentFrameworkId: 'claude-code',
      agentConfiguration: {
        providerId: 'deleted',
        model: 'gone',
        reasoningEffort: 'low'
      }
    })
    useSessionStore.getState().finishRun('session-1')
    const runtime = createRuntime(createSnapshot())
    runtimeMock.current = runtime
    await render()

    await expect(
      latest.sendMessage({ sessionId: 'session-1', text: 'Job analysis' })
    ).resolves.toBeUndefined()
    expect(runtime.resumeSession).not.toHaveBeenCalled()
    expect(runtime.sendPrompt).not.toHaveBeenCalled()
  })

  it('sends a background turn without changing the visible Session', async () => {
    useSettingsStore.setState({
      activeProviderId: 'session-provider',
      activeModel: 'session-model',
      agentFrameworkId: 'claude-code',
      agentFrameworks: [
        {
          id: 'claude-code',
          displayName: 'Claude Code',
          supportsSkills: true,
          supportedApiTypes: ['anthropic']
        }
      ],
      providers: [
        {
          id: 'session-provider',
          type: 'custom',
          name: 'Session',
          apiEndpoints: ['anthropic'],
          baseUrl: 'https://example.test/v1',
          model: 'session-model',
          models: ['session-model'],
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        }
      ]
    })
    const configuration = {
      providerId: 'session-provider',
      model: 'session-model',
      reasoningEffort: 'low' as const
    }
    for (const sessionId of ['visible-session', 'background-session']) {
      useSessionStore.getState().appendUserMessage({
        sessionId,
        content: 'Earlier turn',
        cwd: workspacePath,
        projectId: 'project-1',
        agentFrameworkId: 'claude-code',
        agentConfiguration: configuration
      })
      useSessionStore.getState().finishRun(sessionId)
    }
    useSessionStore.setState({ selectedSessionId: 'visible-session' })
    const runtime = createRuntime(createSnapshot({ sessionIds: ['background-session'] }))
    runtimeMock.current = runtime
    await render()

    await act(async () => {
      await latest.sendMessage({
        sessionId: 'background-session',
        text: 'Analyze the completed Compute Job.',
        preserveSelection: true
      })
    })

    expect(useSessionStore.getState().selectedSessionId).toBe('visible-session')
    expect(
      useSessionStore
        .getState()
        .sessions.find((session) => session.id === 'background-session')
        ?.messages.at(-1)?.content
    ).toBe('Analyze the completed Compute Job.')
    expect(runtime.sendPrompt).toHaveBeenCalledOnce()
  })

  it('routes live events into Workspace before snapshot reconciliation', async () => {
    const pending = useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Stream the answer',
      cwd: workspacePath,
      projectId: 'project-1',
      agentFrameworkId: 'claude-code'
    })
    let liveListener: ((events: readonly AcpRuntimeEvent[]) => void) | undefined
    const runtime = createRuntime(
      createSnapshot({
        sessionIds: ['session-1'],
        promptInFlight: true,
        promptInFlightSessionIds: ['session-1'],
        agentPromptInFlightSessionIds: ['session-1']
      })
    )
    runtime.subscribeRuntimeEvents = vi.fn((listener) => {
      liveListener = listener
      return vi.fn()
    })
    runtime.currentRuntimeEvents = () => []
    runtimeMock.current = runtime
    await render()

    const events: AcpRuntimeEvent[] = Array.from({ length: 8 }, (_, index) => ({
      id: `runtime-1:acp-event-${index + 1}`,
      timestamp: index + 1,
      kind: 'message',
      level: 'info',
      role: 'assistant',
      sessionId: 'session-1',
      promptMessageId: pending?.messageId,
      text: 'x'
    }))
    vi.mocked(window.api.acp.getState).mockResolvedValue(
      createSnapshot({
        revision: 1,
        sessionIds: ['session-1'],
        events
      })
    )
    await act(async () => {
      for (const event of events) liveListener?.([event])
      await drainWorkspaceRuntimeEventsForPersistence('session-1')
    })

    const agentText = useSessionStore
      .getState()
      .sessions.find((session) => session.id === 'session-1')
      ?.messages.filter((message) => message.role === 'agent')
      .map((message) => message.content)
      .join('')
    expect(agentText).toBe('x'.repeat(8))
    expect(
      useSessionStore.getState().sessions.find((session) => session.id === 'session-1')
        ?.awaitingFirstAgentOutput
    ).not.toBe(true)
  })

  it('uses initial snapshot state when handling a recoverable lifecycle event', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Continue after compacting',
      cwd: workspacePath,
      projectId: 'project-1',
      agentFrameworkId: 'claude-code'
    })
    let liveListener:
      ((events: readonly AcpRuntimeEvent[], snapshot?: AcpStateSnapshot) => void) | undefined
    const runtime = createRuntime(createSnapshot())
    runtime.subscribeRuntimeEvents = vi.fn((listener) => {
      liveListener = listener
      return vi.fn()
    })
    runtime.currentRuntimeEvents = () => []
    runtimeMock.current = runtime
    await render()

    liveListener?.(
      [
        {
          id: 'runtime-1:overflow-1',
          timestamp: 1,
          kind: 'error',
          level: 'error',
          sessionId: 'session-1',
          recoverable: 'context-overflow',
          text: 'context overflow'
        }
      ],
      createSnapshot({ sessionIds: ['session-1'] })
    )

    await vi.waitFor(() => expect(runtime.resetSessionContext).toHaveBeenCalledOnce())
  })

  it('owns one child runtime transport subscription and exposes its selector', async () => {
    let publish!: (update: AcpAgentRuntimeUpdate) => void
    const onAgentRuntimeUpdate = vi.fn((listener: typeof publish) => {
      publish = listener
      return vi.fn()
    })
    window.api = {
      acp: {
        getState: vi.fn().mockResolvedValue(createSnapshot()),
        onAgentRuntimeUpdate
      }
    } as never

    await render()
    expect(onAgentRuntimeUpdate).toHaveBeenCalledOnce()

    const listener = vi.fn()
    const unsubscribe = latest.subscribeToSubagentRuntimeUpdates(listener)
    const update = {
      scope: {
        projectId: 'project-1',
        sessionId: 'session-1',
        agentFrameId: 'child-1',
        attemptId: 'attempt-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'prompt-1'
      },
      event: { id: 'event-1', kind: 'stop', level: 'info', timestamp: 1 }
    } satisfies AcpAgentRuntimeUpdate

    act(() => publish(update))
    expect(listener).toHaveBeenCalledWith(update)

    unsubscribe()
    act(() => publish(update))
    expect(listener).toHaveBeenCalledOnce()
  })

  it('publishes runtime adoption as preparation and releases it before opening the prompt', async () => {
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: [
        {
          id: 'claude-code',
          displayName: 'Claude Code',
          supportsSkills: true,
          supportedApiTypes: ['anthropic']
        }
      ],
      providers: [
        {
          id: 'session-provider',
          type: 'custom',
          name: 'Session',
          apiEndpoints: ['anthropic'],
          baseUrl: 'https://example.test/v1',
          model: 'session-model',
          models: ['session-model'],
          supportsImageInput: false,
          hasKey: true,
          needsKey: false
        }
      ]
    })
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Earlier turn',
      cwd: workspacePath,
      projectId: 'project-1',
      agentFrameworkId: 'claude-code'
    })
    useSessionStore.getState().finishRun('session-1')
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'session-1'
          ? {
              ...session,
              agentConfiguration: {
                providerId: 'session-provider',
                model: 'session-model',
                reasoningEffort: 'high'
              }
            }
          : session
      )
    }))

    const resume = createDeferred<AcpCreateSessionResponse>()
    const runtime = createRuntime(createSnapshot())
    runtime.resumeSession.mockReturnValue(resume.promise)
    runtimeMock.current = runtime
    const reconciledSnapshot = createSnapshot({
      revision: 2,
      sessionIds: ['session-1'],
      promptInFlight: false,
      promptInFlightSessionIds: []
    })
    const getState = vi.fn().mockResolvedValue(reconciledSnapshot)
    window.api = { acp: { getState } } as never
    await render()

    let request!: Promise<unknown>
    act(() => {
      request = latest.sendMessage({ sessionId: 'session-1', text: 'Continue' })
    })
    await act(async () => Promise.resolve())

    expect(runtime.resumeSession).toHaveBeenCalledOnce()
    expect(runtime.resumeSession.mock.calls[0]?.at(-2)).toEqual({
      frameworkId: 'claude-code',
      providerId: 'session-provider',
      model: 'session-model',
      reasoningEffort: 'high'
    })
    expect(runtime.resumeSession.mock.calls[0]?.at(-1)).toBe(true)
    expect(latest.sendPreparationInFlightSessionIds).toEqual(['session-1'])
    expect(useSessionStore.getState().sessions[0]).toMatchObject({ status: 'idle' })
    expect(runtime.sendPrompt).not.toHaveBeenCalled()

    resume.resolve({ sessionId: 'session-1', cwd: workspacePath })
    await act(async () => request)

    expect(latest.sendPreparationInFlightSessionIds).toEqual([])
    expect(useSessionStore.getState().sessions[0]).toMatchObject({ status: 'running' })
    expect(getState).toHaveBeenCalledOnce()
    expect(runtime.resumeSession.mock.invocationCallOrder[0]).toBeLessThan(
      getState.mock.invocationCallOrder[0]
    )
    expect(getState.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.sendPrompt.mock.invocationCallOrder[0]
    )
    expect(runtime.reconcileSnapshot).toHaveBeenCalledWith(reconciledSnapshot)
  })

  it('does not reconcile an unordered legacy drain snapshot into live runtime state', async () => {
    const legacySnapshot = createSnapshot({
      sessionIds: ['session-1'],
      promptInFlight: true,
      promptInFlightSessionIds: ['session-1']
    })
    const reconcileSnapshot = vi.fn()
    window.api = { acp: { getState: vi.fn().mockResolvedValue(legacySnapshot) } } as never

    await drainWorkspaceRuntimeEventsForPersistence(undefined, reconcileSnapshot)

    expect(reconcileSnapshot).not.toHaveBeenCalled()
  })

  it('reconciles live runtime state after durable drain projections settle', async () => {
    const order: string[] = []
    const setContextUsage = vi
      .spyOn(useSessionStore.getState(), 'setContextUsage')
      .mockImplementation(() => order.push('durable'))
    const snapshot = createSnapshot({ revision: 2, sessionIds: ['session-1'] })
    window.api = { acp: { getState: vi.fn().mockResolvedValue(snapshot) } } as never

    await drainWorkspaceRuntimeEventsForPersistence(undefined, () => order.push('runtime'))

    expect(order).toEqual(['durable', 'runtime'])
    setContextUsage.mockRestore()
  })

  it('routes permission commands through the runtime and persists its committed profile', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Permission turn',
      cwd: workspacePath,
      projectId: 'project-1'
    })
    useSessionStore.getState().finishRun('session-1')

    const state = createSnapshot({
      sessionIds: ['session-1'],
      pendingPermissions: [
        {
          requestId: 'permission-1',
          sessionId: 'session-1',
          toolCallId: 'tool-1',
          title: 'Allow command?',
          options: []
        }
      ]
    })
    const runtime = createRuntime(state)
    runtime.setPermissionProfile.mockResolvedValue(
      createSnapshot({
        sessionIds: ['session-1'],
        permissionProfiles: {
          'session-1': {
            selectedProfile: 'auto',
            effectiveProfile: 'auto',
            availableModeIds: [],
            fullAccessAvailable: true
          }
        }
      })
    )
    runtimeMock.current = runtime
    await render()

    await act(async () => {
      await latest.respondToPermission('permission-1', 'allow-once')
      await latest.setPermissionProfile('session-1', 'full')
      await latest.revokePermissionGrant('session-1', 'shell:git')
    })

    expect(runtime.respondToPermission).toHaveBeenCalledWith(
      'permission-1',
      'allow-once',
      undefined
    )
    expect(runtime.setPermissionProfile).toHaveBeenCalledWith('session-1', 'full')
    expect(runtime.revokePermissionGrant).toHaveBeenCalledWith('session-1', 'shell:git')
    expect(useSessionStore.getState().sessions[0]?.permissionProfile).toBe('auto')
  })

  it('hides a live permission immediately while its response is pending', async () => {
    const request = {
      requestId: 'permission-live',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      title: 'Allow command?',
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    }
    const deferred = createDeferred<AcpStateSnapshot>()
    const runtime = createRuntime(
      createSnapshot({ sessionIds: ['session-1'], pendingPermissions: [request] })
    )
    runtime.respondToPermission.mockImplementation(async () => {
      const snapshot = await deferred.promise
      runtime.state = snapshot
      return snapshot
    })
    runtimeMock.current = runtime
    await render()

    expect(latest.pendingPermissions).toEqual([request])

    let response!: Promise<void>
    act(() => {
      response = latest.respondToPermission('permission-live', 'allow-once')
    })

    expect(runtime.respondToPermission).toHaveBeenCalledOnce()
    expect(latest.pendingPermissions).toEqual([])

    deferred.resolve(createSnapshot({ sessionIds: ['session-1'] }))
    await act(async () => response)
    expect(latest.pendingPermissions).toEqual([])
  })

  it('reports a permission response size limit for the affected Session', async () => {
    const request = {
      requestId: 'permission-size-limit',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      title: 'Allow command?',
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    }
    const runtime = createRuntime(
      createSnapshot({ sessionIds: ['session-1'], pendingPermissions: [request] })
    )
    runtime.respondToPermission.mockRejectedValue(
      Object.assign(new Error('Session exceeds the persistence limit.'), {
        code: SESSION_SIZE_LIMIT_ERROR_CODE
      })
    )
    runtimeMock.current = runtime
    const onSessionSizeLimit = vi.fn()
    await render(onSessionSizeLimit)

    await act(async () => latest.respondToPermission(request.requestId, 'allow-once'))

    expect(onSessionSizeLimit).toHaveBeenCalledWith('session-1')
  })

  it('reattaches a restored permission wait before sending its main-validated decision', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Run the verification',
      cwd: workspacePath,
      projectId: 'project-1',
      agentFrameworkId: 'claude-code'
    })
    const request = {
      requestId: 'permission-restored',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      title: 'Run npm test',
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    }
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        status: 'waiting-permission',
        activeRun: undefined,
        runtimeContext: {
          version: 1,
          revision: 1,
          permission: {
            state: 'pending',
            request,
            originatingPromptMessageId: session.messages[0].id,
            fingerprint: 'a'.repeat(64),
            createdAt: 1
          }
        }
      }))
    }))
    const runtime = createRuntime(createSnapshot())
    runtime.resumeSession.mockResolvedValue({
      sessionId: 'session-1',
      cwd: workspacePath,
      frameworkId: 'claude-code',
      backendId: 'claude-code:anthropic',
      contextReset: false
    })
    runtimeMock.current = runtime
    await render()
    const staleResponder = latest.respondToPermission

    expect(latest.pendingPermissions).toEqual([request])
    await act(async () => {
      await latest.respondToPermission('permission-restored', 'allow-once')
    })

    expect(runtime.resumeSession).toHaveBeenCalledWith(
      'session-1',
      workspacePath,
      'project-1',
      'ask',
      'claude-code',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    )
    expect(runtime.respondToPermission).toHaveBeenCalledWith('permission-restored', 'allow-once', {
      sessionId: 'session-1',
      projectId: 'project-1'
    })
    expect(useSessionStore.getState().sessions[0].status).toBe('idle')
    await act(async () => staleResponder('permission-restored', 'allow-once'))
    expect(runtime.respondToPermission).toHaveBeenCalledOnce()
  })

  it('keeps a restored permission card actionable when its response fails', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Run the verification',
      cwd: workspacePath,
      projectId: 'project-1',
      agentFrameworkId: 'claude-code'
    })
    const request = {
      requestId: 'permission-restored',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      title: 'Run npm test',
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    }
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        status: 'waiting-permission',
        activeRun: undefined,
        runtimeContext: {
          version: 1,
          revision: 1,
          permission: {
            state: 'pending',
            request,
            originatingPromptMessageId: session.messages[0].id,
            fingerprint: 'a'.repeat(64),
            createdAt: 1
          }
        }
      }))
    }))
    const runtime = createRuntime(createSnapshot({ sessionIds: ['session-1'] }))
    runtime.respondToPermission.mockRejectedValue(new Error('Permission continuation unavailable'))
    runtimeMock.current = runtime
    await render()

    await act(async () => {
      await latest.respondToPermission('permission-restored', 'allow-once')
    })

    expect(useSessionStore.getState().sessions[0].status).toBe('waiting-permission')
    expect(latest.pendingPermissions).toEqual([request])
    expect(runtime.respondToPermission).toHaveBeenCalledWith('permission-restored', 'allow-once', {
      sessionId: 'session-1',
      projectId: 'project-1'
    })

    await act(async () => {
      await latest.respondToPermission('permission-restored', 'allow-once')
    })
    expect(runtime.respondToPermission).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent responses for the same restored permission request', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Run the verification',
      cwd: workspacePath,
      projectId: 'project-1',
      agentFrameworkId: 'claude-code'
    })
    const request = {
      requestId: 'permission-restored',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      title: 'Run npm test',
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    }
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        status: 'waiting-permission',
        activeRun: undefined,
        runtimeContext: {
          version: 1,
          revision: 1,
          permission: {
            state: 'pending',
            request,
            originatingPromptMessageId: session.messages[0].id,
            fingerprint: 'a'.repeat(64),
            createdAt: 1
          }
        }
      }))
    }))
    const deferred = createDeferred<AcpStateSnapshot>()
    const runtime = createRuntime(createSnapshot({ sessionIds: ['session-1'] }))
    runtime.respondToPermission.mockReturnValue(deferred.promise)
    runtimeMock.current = runtime
    await render()

    let first!: Promise<void>
    let duplicate!: Promise<void>
    act(() => {
      first = latest.respondToPermission('permission-restored', 'allow-once')
      duplicate = latest.respondToPermission('permission-restored', 'allow-once')
    })

    expect(runtime.respondToPermission).toHaveBeenCalledOnce()
    deferred.resolve(createSnapshot({ sessionIds: ['session-1'] }))
    await act(async () => Promise.all([first, duplicate]))
  })

  it('keeps a newly persisted permission card when its provider disconnects in-process', async () => {
    const prompt = useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Run the verification',
      cwd: workspacePath,
      projectId: 'project-1',
      agentFrameworkId: 'claude-code'
    })
    const request = {
      requestId: 'permission-live',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      title: 'Run npm test',
      durable: true as const,
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    }
    const runtime = createRuntime(
      createSnapshot({ sessionIds: ['session-1'], pendingPermissions: [request] })
    )
    runtimeMock.current = runtime
    await render()

    const source = useSessionStore.getState().sessions[0]
    act(() =>
      useSessionStore.getState().applyDurableSessionProjection({
        source,
        session: {
          ...toPersistedSession(source),
          status: 'waiting-permission',
          runtimeContext: {
            version: 1,
            revision: 1,
            permission: {
              state: 'pending',
              request,
              originatingPromptMessageId: prompt!.messageId,
              fingerprint: 'a'.repeat(64),
              createdAt: 1
            }
          }
        },
        mode: 'permission-authority'
      })
    )

    runtime.state = createSnapshot({
      status: 'closed',
      sessionConnectionStatuses: { 'session-1': 'closed' }
    })
    await render()

    expect(latest.pendingPermissions).toEqual([request])
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-permission',
      runtimeContext: { permission: { state: 'pending' } }
    })
    expect(useSessionStore.getState().sessions[0].interrupted).toBeUndefined()
  })

  it('keeps an accepted restored permission hidden across a newer pending projection', async () => {
    const { request, runtime } = arrangeRestoredPermission()
    const deferred = createDeferred<AcpStateSnapshot>()
    runtime.respondToPermission.mockReturnValue(deferred.promise)
    await render()

    let first!: Promise<void>
    act(() => {
      first = latest.respondToPermission('permission-restored', 'allow-once')
    })
    deferred.resolve(createSnapshot({ sessionIds: ['session-1'] }))
    await act(async () => first)
    act(() => projectRestoredPermissionPending(request))
    expect(latest.pendingPermissions).toEqual([])
    expect(runtime.respondToPermission).toHaveBeenCalledOnce()
    await act(async () => latest.respondToPermission('permission-restored', 'allow-once'))
    expect(runtime.respondToPermission).toHaveBeenCalledOnce()
  })

  it('preserves an explicit Main rearm that arrives before the restored response settles', async () => {
    const { request, runtime } = arrangeRestoredPermission()
    const deferred = createDeferred<AcpStateSnapshot>()
    runtime.respondToPermission.mockReturnValue(deferred.promise)
    await render()

    let first!: Promise<void>
    act(() => {
      first = latest.respondToPermission('permission-restored', 'allow-once')
      useSessionStore.getState().clearPermissionPending('session-1', {
        authority: 'continuing',
        requestId: request.requestId
      })
    })
    runtime.state = createSnapshot({
      sessionIds: ['session-1'],
      events: [
        {
          id: 'permission-rearmed',
          timestamp: 3,
          kind: 'permission',
          level: 'info',
          sessionId: 'session-1',
          permissionRequestId: request.requestId,
          title: ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE
        }
      ]
    })
    await render()

    deferred.resolve(createSnapshot({ sessionIds: ['session-1'] }))
    await act(async () => first)
    expect(latest.pendingPermissions).toEqual([request])
    expect(runtime.respondToPermission).toHaveBeenCalledOnce()

    await act(async () => latest.respondToPermission('permission-restored', 'allow-once'))
    expect(runtime.respondToPermission).toHaveBeenCalledTimes(2)

    runtime.state = createSnapshot({ sessionIds: ['session-1'], events: [] })
    await render()
    runtime.state = createSnapshot({
      sessionIds: ['session-1'],
      events: [
        {
          id: 'permission-rearmed',
          timestamp: 3,
          kind: 'permission',
          level: 'info',
          sessionId: 'session-1',
          permissionRequestId: request.requestId,
          title: ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE
        }
      ]
    })
    await render()

    expect(useSessionStore.getState().sessions[0].runtimeContext?.permission?.state).toBe(
      'continuing'
    )
    await act(async () => latest.respondToPermission('permission-restored', 'allow-once'))
    expect(runtime.respondToPermission).toHaveBeenCalledTimes(2)
  })

  it('keeps a terminal request hidden when an earlier rearm replays without a local attempt', async () => {
    const { request, runtime } = arrangeRestoredPermission()
    runtime.state = createSnapshot({
      sessionIds: ['session-1'],
      events: [
        {
          id: 'permission-rearmed-before-attempt',
          timestamp: 1,
          kind: 'permission',
          level: 'info',
          sessionId: request.sessionId,
          permissionRequestId: request.requestId,
          title: ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE
        }
      ]
    })
    await render()

    runtime.state = createSnapshot({
      sessionIds: ['session-1'],
      events: [
        {
          id: 'permission-settled-without-attempt',
          timestamp: 2,
          kind: 'permission',
          level: 'info',
          sessionId: request.sessionId,
          permissionRequestId: request.requestId,
          title: ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE
        }
      ]
    })
    await render()
    runtime.state = createSnapshot({ sessionIds: ['session-1'], events: [] })
    await render()
    runtime.state = createSnapshot({
      sessionIds: ['session-1'],
      events: [
        {
          id: 'permission-rearmed-before-attempt',
          timestamp: 1,
          kind: 'permission',
          level: 'info',
          sessionId: request.sessionId,
          permissionRequestId: request.requestId,
          title: ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE
        }
      ]
    })
    await render()
    act(() => projectRestoredPermissionPending(request))

    expect(latest.pendingPermissions).toEqual([])
    await act(async () => latest.respondToPermission(request.requestId, 'allow-once'))
    expect(runtime.respondToPermission).not.toHaveBeenCalled()
  })

  it('rejects an older quit-drain rearm that resolves after a newer terminal snapshot', async () => {
    const { request, runtime } = arrangeRestoredPermission()
    const olderPull = createDeferred<AcpStateSnapshot>()
    window.api = { acp: { getState: vi.fn().mockReturnValue(olderPull.promise) } } as never
    await render()
    await act(async () => latest.respondToPermission(request.requestId, 'allow-once'))

    const drain = drainWorkspaceRuntimeEventsForPersistence(request.sessionId)
    // The subscription reserves revision 2 synchronously before React commits its state/effects.
    expect(acceptAcpRuntimeSnapshotRevision({ revision: 2 })).toBe(true)
    await act(async () => {
      olderPull.resolve(
        createSnapshot({
          revision: 1,
          sessionIds: [request.sessionId],
          events: [
            {
              id: 'permission-rearmed-older-unseen',
              timestamp: 1,
              kind: 'permission',
              level: 'info',
              sessionId: request.sessionId,
              permissionRequestId: request.requestId,
              title: ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE
            }
          ]
        })
      )
      await drain
    })
    expect(useSessionStore.getState().sessions[0].runtimeContext?.permission?.state).toBe(
      'continuing'
    )

    runtime.state = createSnapshot({
      revision: 2,
      sessionIds: [request.sessionId],
      events: [
        {
          id: 'permission-settled-newer',
          timestamp: 2,
          kind: 'permission',
          level: 'info',
          sessionId: request.sessionId,
          permissionRequestId: request.requestId,
          title: ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE
        }
      ]
    })
    await render()

    expect(useSessionStore.getState().sessions[0].runtimeContext?.permission?.state).not.toBe(
      'pending'
    )
    expect(latest.pendingPermissions).toEqual([])
    await act(async () => latest.respondToPermission(request.requestId, 'allow-once'))
    expect(runtime.respondToPermission).toHaveBeenCalledOnce()
  })

  it('cleans an accepted tombstone when its continuing Session is deleted', async () => {
    const { request, runtime } = arrangeRestoredPermission()
    await render()
    await act(async () => latest.respondToPermission(request.requestId, 'allow-once'))
    expect(useSessionStore.getState().sessions[0].runtimeContext?.permission?.state).toBe(
      'continuing'
    )

    const deletedSession = structuredClone(useSessionStore.getState().sessions[0])
    act(() => useSessionStore.setState({ sessions: [] }))
    await render()
    act(() => useSessionStore.setState({ sessions: [deletedSession] }))
    act(() => projectRestoredPermissionPending(request))
    await render()

    expect(latest.pendingPermissions).toEqual([request])
    await act(async () => latest.respondToPermission(request.requestId, 'allow-once'))
    expect(runtime.respondToPermission).toHaveBeenCalledTimes(2)
  })

  it('releases an accepted response only for a matching Main rearm', async () => {
    const { request, runtime } = arrangeRestoredPermission()
    await render()

    await act(async () => latest.respondToPermission(request.requestId, 'allow-once'))
    runtime.state = createSnapshot({
      sessionIds: ['session-1'],
      events: [
        {
          id: 'permission-rearmed-mismatch',
          timestamp: 3,
          kind: 'permission',
          level: 'info',
          sessionId: 'session-1',
          permissionRequestId: 'permission-other',
          title: ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE
        }
      ]
    })
    await render()

    expect(latest.pendingPermissions).toEqual([])
    await act(async () => latest.respondToPermission(request.requestId, 'allow-once'))
    expect(runtime.respondToPermission).toHaveBeenCalledOnce()

    runtime.state = createSnapshot({
      sessionIds: ['session-1'],
      events: [
        {
          id: 'permission-settled',
          timestamp: 4,
          kind: 'permission',
          level: 'info',
          sessionId: 'session-1',
          permissionRequestId: request.requestId,
          title: ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE
        }
      ]
    })
    await render()
    act(() => projectRestoredPermissionPending(request))
    expect(latest.pendingPermissions).toEqual([])
    await act(async () => latest.respondToPermission(request.requestId, 'allow-once'))
    expect(runtime.respondToPermission).toHaveBeenCalledOnce()

    runtime.state = createSnapshot({
      sessionIds: ['session-1'],
      events: [
        {
          id: 'permission-rearm-failed',
          timestamp: 5,
          kind: 'permission',
          level: 'error',
          sessionId: 'session-1',
          permissionRequestId: request.requestId,
          title: ACP_RESTORED_PERMISSION_REARM_FAILED_EVENT_TITLE
        }
      ]
    })
    await render()
    act(() => projectRestoredPermissionPending(request))
    expect(latest.pendingPermissions).toEqual([])
    await act(async () => latest.respondToPermission(request.requestId, 'allow-once'))
    expect(runtime.respondToPermission).toHaveBeenCalledOnce()

    const deletedSession = structuredClone(useSessionStore.getState().sessions[0])
    act(() => useSessionStore.setState({ sessions: [] }))
    await render()
    act(() => useSessionStore.setState({ sessions: [deletedSession] }))
    await render()

    expect(latest.pendingPermissions).toEqual([request])
    const secondResponse = createDeferred<AcpStateSnapshot>()
    runtime.respondToPermission.mockReturnValueOnce(secondResponse.promise)
    let second!: Promise<void>
    act(() => {
      second = latest.respondToPermission(request.requestId, 'allow-once')
    })
    runtime.state = createSnapshot({
      sessionIds: ['session-1'],
      events: [
        {
          id: 'permission-clear-failed-before-acceptance',
          timestamp: 6,
          kind: 'permission',
          level: 'error',
          sessionId: 'session-1',
          permissionRequestId: request.requestId,
          title: ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE
        }
      ]
    })
    await render()
    secondResponse.resolve(createSnapshot({ sessionIds: ['session-1'] }))
    await act(async () => second)

    expect(runtime.respondToPermission).toHaveBeenCalledTimes(2)
    act(() => projectRestoredPermissionPending(request))
    expect(latest.pendingPermissions).toEqual([])
    await act(async () => latest.respondToPermission(request.requestId, 'allow-once'))
    expect(runtime.respondToPermission).toHaveBeenCalledTimes(2)
  })
})
