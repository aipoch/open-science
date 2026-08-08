// @vitest-environment jsdom

import { join } from 'node:path'
import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import type { AcpCreateSessionResponse, AcpStateSnapshot } from '../../../../shared/acp'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import { createInitialSettingsState, useSettingsStore } from '../../stores/settings-store'
import { resetDeferredArtifactEventsForTests } from './workspace-events'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const runtimeMock = vi.hoisted(() => ({ current: {} as unknown }))

vi.mock('./useAcpRuntime', () => ({
  useAcpRuntime: () => runtimeMock.current
}))

import { useWorkspaceAgentRuntime } from './useWorkspaceAgentRuntime'

const workspacePath = join('workspace', 'project')

const createSnapshot = (overrides: Partial<AcpStateSnapshot> = {}): AcpStateSnapshot => ({
  status: 'connected',
  cwd: workspacePath,
  sessionIds: [],
  events: [],
  pendingPermissions: [],
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
  actionError: string | null
  isConnecting: boolean
  createSession: Mock
  resumeSession: Mock
  resetSessionContext: Mock
  sendPrompt: Mock
  compactSession: Mock
  cancel: Mock
  deleteSession: Mock
  respondToPermission: Mock
  setPermissionProfile: Mock
  revokePermissionGrant: Mock
}

const createRuntime = (state: AcpStateSnapshot): RuntimeMock => ({
  state,
  actionError: null as string | null,
  isConnecting: false,
  createSession: vi.fn(),
  resumeSession: vi.fn(),
  resetSessionContext: vi.fn(),
  sendPrompt: vi.fn().mockResolvedValue(state),
  compactSession: vi.fn(),
  cancel: vi.fn(),
  deleteSession: vi.fn(),
  respondToPermission: vi.fn().mockResolvedValue(state),
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

  const render = async (): Promise<void> => {
    await act(async () => root.render(<Probe />))
  }

  beforeEach(() => {
    resetDeferredArtifactEventsForTests()
    useSessionStore.setState(createInitialSessionState())
    useSettingsStore.setState(createInitialSettingsState())
    runtimeMock.current = createRuntime(createSnapshot())
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

    expect(Object.keys(latest).sort()).toEqual(
      [
        'actionError',
        'isConnecting',
        'pendingPermissions',
        'permissionProfiles',
        'permissionGrants',
        'contextUsageBySession',
        'promptInFlightSessionIds',
        'sendPreparationInFlightSessionIds',
        'nativeContextCompactionSessionIds',
        'compactContext',
        'sendMessage',
        'resendEditedMessage',
        'cancelRun',
        'resumeInterruptedSession',
        'deleteRuntimeSession',
        'respondToPermission',
        'setPermissionProfile',
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
      promptInFlightSessionIds: ['session-1'],
      sendPreparationInFlightSessionIds: [],
      nativeContextCompactionSessionIds: ['session-1']
    })
  })

  it('publishes runtime adoption as preparation and releases it before opening the prompt', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Earlier turn',
      cwd: workspacePath,
      projectId: 'project-1',
      agentFrameworkId: 'claude-code'
    })
    useSessionStore.getState().finishRun('session-1')

    const resume = createDeferred<AcpCreateSessionResponse>()
    const runtime = createRuntime(createSnapshot())
    runtime.resumeSession.mockReturnValue(resume.promise)
    runtimeMock.current = runtime
    const getState = vi.fn().mockResolvedValue(createSnapshot({ sessionIds: ['session-1'] }))
    window.api = { acp: { getState } } as never
    await render()

    let request!: Promise<unknown>
    act(() => {
      request = latest.sendMessage({ sessionId: 'session-1', text: 'Continue' })
    })
    await act(async () => Promise.resolve())

    expect(runtime.resumeSession).toHaveBeenCalledOnce()
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

    expect(runtime.respondToPermission).toHaveBeenCalledWith('permission-1', 'allow-once')
    expect(runtime.setPermissionProfile).toHaveBeenCalledWith('session-1', 'full')
    expect(runtime.revokePermissionGrant).toHaveBeenCalledWith('session-1', 'shell:git')
    expect(useSessionStore.getState().sessions[0]?.permissionProfile).toBe('auto')
  })
})
