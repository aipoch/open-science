// @vitest-environment jsdom

import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AcpStateSnapshot } from '../../../../shared/acp'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import { getAgentLoadingPhase } from '../../pages/workspace/agent-loading-message'
import { resetDeferredArtifactEventsForTests } from './workspace-events'
import { resetWorkspaceRuntimeEventOwnerForTests } from './workspace-runtime-event-owner'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const runtimeMock = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))

vi.mock('./useAcpRuntime', () => ({
  useAcpRuntime: () => runtimeMock.current
}))

import { useWorkspaceAgentRuntime, WorkspaceAgentRuntimeProvider } from './useWorkspaceAgentRuntime'

const createSnapshot = (overrides: Partial<AcpStateSnapshot> = {}): AcpStateSnapshot => ({
  status: 'connected',
  cwd: '/workspace',
  sessionIds: ['session-1'],
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

const Harness = (): JSX.Element => (
  <WorkspaceAgentRuntimeProvider>
    <Probe />
  </WorkspaceAgentRuntimeProvider>
)

describe('workspace Agent first-output runtime sync', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    resetDeferredArtifactEventsForTests()
    resetWorkspaceRuntimeEventOwnerForTests()
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
    await act(async () => root.render(<Harness />))
    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()

    runtimeMock.current = createRuntime(
      createSnapshot({
        promptInFlight: true,
        promptInFlightSessionIds: ['session-1'],
        agentPromptInFlightSessionIds: ['session-1']
      })
    )
    await act(async () => root.render(<Harness />))

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'running',
      activeRun: undefined,
      agentPromptInFlight: true,
      awaitingFirstAgentOutput: true
    })
    expect(container.textContent).toBe('thinking')
  })

  it('projects a pending user choice and resumes running before the next Agent output', async () => {
    await act(async () => root.render(<Harness />))

    runtimeMock.current = createRuntime(
      createSnapshot({
        promptInFlight: true,
        promptInFlightSessionIds: ['session-1'],
        agentPromptInFlightSessionIds: ['session-1'],
        pendingElicitations: [
          {
            requestId: 'choice-1',
            sessionId: 'session-1',
            toolCallId: 'choice-tool-1',
            message: 'Choose an approach',
            fields: [{ id: 'approach', label: 'Approach', kind: 'text' }],
            durable: { kind: 'agent-user-choice', requestId: 'choice-1' }
          }
        ]
      })
    )
    await act(async () => root.render(<Harness />))

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-for-user',
      agentPromptInFlight: true
    })
    expect(container.textContent).toBe('waiting-for-response')

    runtimeMock.current = createRuntime(
      createSnapshot({
        promptInFlight: true,
        promptInFlightSessionIds: ['session-1'],
        agentPromptInFlightSessionIds: ['session-1']
      })
    )
    await act(async () => root.render(<Harness />))

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'running',
      agentPromptInFlight: true,
      awaitingFirstAgentOutput: true
    })
    expect(container.textContent).toBe('thinking')

    runtimeMock.current = createRuntime(
      createSnapshot({
        events: [
          {
            id: 'choice-continuation-stop',
            timestamp: 1710000000000,
            kind: 'stop',
            level: 'info',
            sessionId: 'session-1',
            text: 'end_turn'
          }
        ]
      })
    )
    await act(async () => root.render(<Harness />))

    expect(useSessionStore.getState().sessions[0]).toMatchObject({ status: 'idle' })
    expect(container.textContent).toBe('')
  })

  it('does not project an unrendered generic ACP form as waiting for the user', async () => {
    await act(async () => root.render(<Harness />))

    runtimeMock.current = createRuntime(
      createSnapshot({
        promptInFlight: true,
        promptInFlightSessionIds: ['session-1'],
        agentPromptInFlightSessionIds: ['session-1'],
        pendingElicitations: [
          {
            requestId: 'generic-form-1',
            sessionId: 'session-1',
            toolCallId: 'generic-form-tool-1',
            message: 'Provide additional input',
            fields: [{ id: 'detail', label: 'Detail', kind: 'text' }]
          }
        ]
      })
    )
    await act(async () => root.render(<Harness />))

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'running',
      agentPromptInFlight: true
    })
    expect(container.textContent).toBe('thinking')
  })

  it('does not rearm waiting when prompt ownership and the first visible output share a snapshot', async () => {
    await act(async () => root.render(<Harness />))

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
    await act(async () => root.render(<Harness />))

    expect(useSessionStore.getState().sessions[0].messages.at(-1)).toMatchObject({
      role: 'agent',
      content: 'First visible token'
    })
    expect(useSessionStore.getState().sessions[0].agentPromptInFlight).toBe(true)
    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()
    expect(container.textContent).toBe('')
  })

  it('restarts runtime-owned waiting only after an active tool completes', async () => {
    await act(async () => root.render(<Harness />))
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
    await act(async () => root.render(<Harness />))
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
    await act(async () => root.render(<Harness />))
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
    await act(async () => root.render(<Harness />))

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      activeRun: undefined,
      agentPromptInFlight: true
    })
    expect(container.textContent).toBe('thinking')
  })

  it('unmounts runtime-owned waiting after the first visible image without an active run', async () => {
    await act(async () => root.render(<Harness />))

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
            text: '',
            messageId: 'assistant-image-1',
            image: { mimeType: 'image/png', data: 'AQID', byteLength: 3 }
          }
        ]
      })
    )
    await act(async () => root.render(<Harness />))

    expect(useSessionStore.getState().sessions[0].messages.at(-1)?.images).toHaveLength(1)
    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()
    expect(container.textContent).toBe('')
  })

  it('shows a runtime-owned approval wait while permission input is pending', async () => {
    await act(async () => root.render(<Harness />))

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
    await act(async () => root.render(<Harness />))

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'waiting-permission',
      awaitingFirstAgentOutput: true
    })
    expect(container.textContent).toBe('waiting-for-approval')
  })

  it('does not start waiting for a compaction-only runtime interaction', async () => {
    await act(async () => root.render(<Harness />))

    runtimeMock.current = createRuntime(
      createSnapshot({
        promptInFlight: true,
        promptInFlightSessionIds: ['session-1'],
        agentPromptInFlightSessionIds: []
      })
    )
    await act(async () => root.render(<Harness />))

    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()
    expect(container.textContent).toBe('')
  })

  it('does not infer foreground prompt ownership when the prompt-only field is absent', async () => {
    await act(async () => root.render(<Harness />))

    runtimeMock.current = createRuntime(
      createSnapshot({
        promptInFlight: true,
        promptInFlightSessionIds: ['session-1'],
        agentPromptInFlightSessionIds: undefined
      })
    )
    await act(async () => root.render(<Harness />))

    expect(useSessionStore.getState().sessions[0].awaitingFirstAgentOutput).toBeUndefined()
    expect(container.textContent).toBe('')
  })
})
