// @vitest-environment jsdom

import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AcpStateSnapshot } from '../../../../shared/acp'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import { getAgentLoadingPhase } from '../../pages/workspace/agent-loading-message'
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
  agentPromptInFlightSessionIds: [],
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

const Probe = (): JSX.Element | null => {
  useWorkspaceAgentRuntime()
  const activeSession = useSessionStore((state) =>
    state.sessions.find((session) => session.id === state.selectedSessionId)
  )

  const phase = getAgentLoadingPhase(activeSession)

  return phase === 'hidden' ? null : <div>{phase}</div>
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
        promptInFlightSessionIds: ['session-1'],
        agentPromptInFlightSessionIds: ['session-1']
      })
    )
    await act(async () => root.render(<Probe />))

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      activeRun: undefined,
      agentPromptInFlight: true,
      awaitingFirstAgentOutput: true
    })
    expect(container.textContent).toBe('thinking')
  })

  it('does not rearm waiting when prompt ownership and the first visible output share a snapshot', async () => {
    await act(async () => root.render(<Probe />))

    runtimeMock.current = createRuntime(
      createSnapshot({
        promptInFlight: true,
        promptInFlightSessionIds: ['session-1'],
        agentPromptInFlightSessionIds: ['session-1'],
        events: [
          {
            id: 'event-first-output',
            timestamp: 1710000000000,
            kind: 'message',
            level: 'info',
            sessionId: 'session-1',
            role: 'assistant',
            messageId: 'assistant-message-1',
            text: 'First visible token'
          }
        ]
      })
    )
    await act(async () => root.render(<Probe />))

    expect(useSessionStore.getState().sessions[0].messages.at(-1)).toMatchObject({
      role: 'agent',
      content: 'First visible token'
    })
    expect(useSessionStore.getState().sessions[0].agentPromptInFlight).toBe(true)
    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()
    expect(container.textContent).toBe('')
  })

  it('restarts runtime-owned waiting only after an active tool completes', async () => {
    await act(async () => root.render(<Probe />))
    const promptMessageId = useSessionStore.getState().sessions[0].messages[0].id
    const firstOutputEvent = {
      id: 'event-output-before-tool',
      timestamp: 1710000000000,
      kind: 'message' as const,
      level: 'info' as const,
      sessionId: 'session-1',
      role: 'assistant' as const,
      messageId: 'assistant-message-1',
      promptMessageId,
      text: 'I will inspect the file.'
    }

    runtimeMock.current = createRuntime(
      createSnapshot({
        promptInFlight: true,
        promptInFlightSessionIds: ['session-1'],
        agentPromptInFlightSessionIds: ['session-1'],
        events: [firstOutputEvent]
      })
    )
    await act(async () => root.render(<Probe />))
    expect(container.textContent).toBe('')

    const runningToolEvent = {
      id: 'event-tool-running',
      timestamp: 1710000000100,
      kind: 'tool' as const,
      level: 'info' as const,
      sessionId: 'session-1',
      promptMessageId,
      toolCallId: 'tool-1',
      title: 'Read file',
      status: 'in_progress' as const
    }
    runtimeMock.current = createRuntime(
      createSnapshot({
        promptInFlight: true,
        promptInFlightSessionIds: ['session-1'],
        agentPromptInFlightSessionIds: ['session-1'],
        events: [firstOutputEvent, runningToolEvent]
      })
    )
    await act(async () => root.render(<Probe />))
    expect(container.textContent).toBe('interacting-with-tools')

    runtimeMock.current = createRuntime(
      createSnapshot({
        promptInFlight: true,
        promptInFlightSessionIds: ['session-1'],
        agentPromptInFlightSessionIds: ['session-1'],
        events: [
          firstOutputEvent,
          runningToolEvent,
          {
            ...runningToolEvent,
            id: 'event-tool-completed',
            timestamp: 1710000000200,
            status: 'completed'
          }
        ]
      })
    )
    await act(async () => root.render(<Probe />))

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      activeRun: undefined,
      agentPromptInFlight: true
    })
    expect(container.textContent).toBe('thinking')
  })

  it('unmounts runtime-owned waiting after the first visible image without an active run', async () => {
    await act(async () => root.render(<Probe />))

    runtimeMock.current = createRuntime(
      createSnapshot({
        promptInFlight: true,
        promptInFlightSessionIds: ['session-1'],
        agentPromptInFlightSessionIds: ['session-1'],
        events: [
          {
            id: 'event-first-image',
            timestamp: 1710000000000,
            kind: 'message',
            level: 'info',
            sessionId: 'session-1',
            role: 'assistant',
            messageId: 'assistant-image-1',
            image: { mimeType: 'image/png', data: 'AQID', byteLength: 3 }
          }
        ]
      })
    )
    await act(async () => root.render(<Probe />))

    expect(useSessionStore.getState().sessions[0].messages.at(-1)?.images).toHaveLength(1)
    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()
    expect(container.textContent).toBe('')
  })

  it('shows runtime-owned tool interaction while permission input is pending', async () => {
    await act(async () => root.render(<Probe />))

    runtimeMock.current = createRuntime(
      createSnapshot({
        promptInFlight: true,
        promptInFlightSessionIds: ['session-1'],
        agentPromptInFlightSessionIds: ['session-1'],
        pendingPermissions: [
          {
            requestId: 'permission-1',
            sessionId: 'session-1',
            toolCallId: 'tool-1',
            title: 'Allow edit?',
            options: []
          }
        ]
      })
    )
    await act(async () => root.render(<Probe />))

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-permission',
      awaitingFirstAgentOutput: true
    })
    expect(container.textContent).toBe('interacting-with-tools')
  })

  it('does not start waiting for a compaction-only runtime interaction', async () => {
    await act(async () => root.render(<Probe />))

    runtimeMock.current = createRuntime(
      createSnapshot({
        promptInFlight: true,
        promptInFlightSessionIds: ['session-1'],
        agentPromptInFlightSessionIds: []
      })
    )
    await act(async () => root.render(<Probe />))

    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()
    expect(container.textContent).toBe('')
  })

  it('does not infer foreground prompt ownership when the prompt-only field is absent', async () => {
    await act(async () => root.render(<Probe />))

    runtimeMock.current = createRuntime(
      createSnapshot({
        promptInFlight: true,
        promptInFlightSessionIds: ['session-1'],
        agentPromptInFlightSessionIds: undefined
      })
    )
    await act(async () => root.render(<Probe />))

    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()
    expect(container.textContent).toBe('')
  })
})
