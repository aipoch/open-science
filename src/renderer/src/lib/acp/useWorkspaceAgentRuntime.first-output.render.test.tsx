// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AcpStateSnapshot } from '../../../../shared/acp'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import { resetDeferredArtifactEventsForTests } from './workspace-events'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const runtimeMock = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))

vi.mock('./useAcpRuntime', () => ({
  useAcpRuntime: () => runtimeMock.current
}))

import { useWorkspaceAgentRuntime } from './useWorkspaceAgentRuntime'

const createSnapshot = (overrides: Partial<AcpStateSnapshot> = {}): AcpStateSnapshot => ({
  status: 'connected',
  cwd: '/workspace',
  sessionIds: ['session-1'],
  events: [],
  pendingPermissions: [],
  permissionProfiles: {},
  permissionGrants: {},
  contextUsageBySession: {},
  promptInFlight: false,
  promptInFlightSessionIds: [],
  ...overrides
})

const createRuntime = (state: AcpStateSnapshot): Record<string, unknown> => ({
  state,
  actionError: null,
  isConnecting: false,
  createSession: vi.fn(),
  resumeSession: vi.fn(),
  resetSessionContext: vi.fn(),
  sendPrompt: vi.fn(),
  compactSession: vi.fn(),
  cancel: vi.fn(),
  deleteSession: vi.fn(),
  respondToPermission: vi.fn(),
  setPermissionProfile: vi.fn(),
  revokePermissionGrant: vi.fn()
})

const Probe = (): null => {
  useWorkspaceAgentRuntime()
  return null
}

describe('workspace Agent first-output runtime sync', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    resetDeferredArtifactEventsForTests()
    useSessionStore.setState(createInitialSessionState())
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Original request'
    })
    useSessionStore.getState().finishRun('session-1')
    runtimeMock.current = createRuntime(createSnapshot())
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('starts waiting when the runtime takes a foreground prompt without a new active run', async () => {
    await act(async () => root.render(<Probe />))
    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()

    runtimeMock.current = createRuntime(
      createSnapshot({
        promptInFlight: true,
        promptInFlightSessionIds: ['session-1']
      })
    )
    await act(async () => root.render(<Probe />))

    expect(useSessionStore.getState().sessions[0].activeRun).toBeUndefined()
    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBe(true)
  })
})
