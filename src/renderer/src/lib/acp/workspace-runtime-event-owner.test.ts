// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AcpRuntimeEvent, AcpStateSnapshot } from '../../../../shared/acp'
import type { PersistedChatSession } from '../../../../shared/session-persistence'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import { getAgentLoadingPhase } from '../../pages/workspace/agent-loading-message'
import { acceptAcpRuntimeSnapshotRevision } from './runtime-snapshot-revision-owner'
import {
  processIncrementalWorkspaceRuntimeEvents,
  refreshDelegatedWorkSessions,
  resetWorkspaceRuntimeEventOwnerForTests,
  syncWorkspaceInteractionStateFromSnapshot,
  useWorkspaceRuntimeEventIngest
} from './workspace-runtime-event-owner'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const renderHook = <Value>(
  hook: () => Value
): { result: { current: Value }; rerender: () => void; unmount: () => void } => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const result = { current: undefined as unknown as Value }
  const HookHarness = (): null => {
    result.current = hook()
    return null
  }
  act(() => {
    root.render(createElement(HookHarness))
  })
  return {
    result,
    rerender: () => act(() => root.render(createElement(HookHarness))),
    unmount: () =>
      act(() => {
        root.unmount()
      })
  }
}

const createSnapshot = (overrides: Partial<AcpStateSnapshot> = {}): AcpStateSnapshot => ({
  status: 'connected',
  cwd: '/workspace',
  sessionIds: [],
  events: [],
  pendingPermissions: [],
  permissionProfiles: {},
  permissionGrants: {},
  contextUsageBySession: {},
  promptInFlight: false,
  promptInFlightSessionIds: [],
  ...overrides
})

const createSession = (id: string, projectId: string, revision: number): PersistedChatSession => ({
  id,
  projectId,
  title: id,
  cwd: '/workspace',
  status: 'running',
  messages: [],
  runtimeContext: {
    version: 1,
    revision,
    delegatedWork: { records: [] }
  },
  createdAt: 1,
  updatedAt: revision
})

describe('delegated-work Session refresh', () => {
  beforeEach(() => {
    useSessionStore.setState(createInitialSessionState())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads only the runtime-owned Sessions instead of scanning all durable Sessions', async () => {
    const first = createSession('session-1', 'project-1', 1)
    const second = createSession('session-2', 'project-2', 1)
    const refreshedFirst = createSession('session-1', 'project-1', 2)
    useSessionStore.getState().hydrateSessions([first, second])

    const loadOne = vi.fn().mockResolvedValue(refreshedFirst)
    const loadAll = vi.fn().mockResolvedValue({
      sessions: [refreshedFirst, second],
      manifest: { version: 1 }
    })
    vi.stubGlobal('window', {
      api: { sessions: { loadOne, loadAll } }
    } as unknown as Window)

    await refreshDelegatedWorkSessions(['session-1'])

    expect(loadOne).toHaveBeenCalledOnce()
    expect(loadOne).toHaveBeenCalledWith({ projectId: 'project-1', sessionId: 'session-1' })
    expect(loadAll).not.toHaveBeenCalled()
    const sessions = useSessionStore.getState().sessions
    expect(sessions).toHaveLength(2)
    expect(sessions[0]).toMatchObject({ id: 'session-1', runtimeContext: { revision: 2 } })
    expect(sessions[1]).toMatchObject({ id: 'session-2', runtimeContext: { revision: 1 } })
  })

  it('uses the existing Web load-all path when load-one is unavailable', async () => {
    const first = createSession('session-1', 'project-1', 1)
    const refreshedFirst = createSession('session-1', 'project-1', 2)
    useSessionStore.getState().hydrateSessions([first])

    const loadAll = vi.fn().mockResolvedValue({
      sessions: [refreshedFirst],
      manifest: { version: 1 }
    })
    vi.stubGlobal('window', {
      api: { sessions: { loadAll } }
    } as unknown as Window)

    await refreshDelegatedWorkSessions(['session-1'])

    expect(loadAll).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'session-1',
      runtimeContext: { revision: 2 }
    })
  })
})

describe('live runtime event ingest', () => {
  beforeEach(() => {
    useSessionStore.setState(createInitialSessionState())
    resetWorkspaceRuntimeEventOwnerForTests()
  })

  afterEach(() => {
    resetWorkspaceRuntimeEventOwnerForTests()
  })

  it('leaves snapshot-only runtimes on the legacy seam', () => {
    const processLifecycleEvents = vi.fn()
    const { result, unmount } = renderHook(() =>
      useWorkspaceRuntimeEventIngest(
        { state: createSnapshot() },
        processLifecycleEvents,
        true,
        () => undefined,
        () => true,
        () => ({ target: 'codex-bridge' })
      )
    )

    expect(result.current).toBe(false)
    expect(processLifecycleEvents).not.toHaveBeenCalled()
    unmount()
  })

  it('forwards subscribed events through the lifecycle sink with snapshot overlay', () => {
    let publish:
      ((events: readonly AcpRuntimeEvent[], snapshot?: AcpStateSnapshot) => void) | undefined
    const unsubscribe = vi.fn()
    const processLifecycleEvents = vi.fn()
    const snapshot = createSnapshot({
      sessionIds: ['session-1'],
      agentPromptInFlightSessionIds: ['session-1']
    })
    const event: AcpRuntimeEvent = {
      id: 'runtime-1:message-1',
      timestamp: 1,
      kind: 'message',
      level: 'info',
      role: 'assistant',
      sessionId: 'session-1',
      text: 'hello'
    }
    const { result, unmount } = renderHook(() =>
      useWorkspaceRuntimeEventIngest(
        {
          state: createSnapshot(),
          subscribeRuntimeEvents: (
            listener: (events: readonly AcpRuntimeEvent[], snapshot?: AcpStateSnapshot) => void
          ) => {
            publish = listener
            return unsubscribe
          }
        },
        processLifecycleEvents,
        true,
        () => undefined,
        () => true,
        () => ({ target: 'codex-bridge' })
      )
    )

    expect(result.current).toBe(true)
    act(() => {
      publish?.([event], snapshot)
    })
    expect(processLifecycleEvents).toHaveBeenCalledWith(
      expect.objectContaining({ state: snapshot }),
      [event],
      expect.objectContaining({ supportsImageRelay: true })
    )
    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('restores prompt ownership after a live stop and continuation tool arrive together', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Original request'
    })
    let publish:
      ((events: readonly AcpRuntimeEvent[], snapshot?: AcpStateSnapshot) => void) | undefined
    const ownedSnapshot = createSnapshot({
      sessionIds: ['session-1'],
      promptInFlight: true,
      promptInFlightSessionIds: ['session-1'],
      agentPromptInFlightSessionIds: ['session-1']
    })
    const { unmount } = renderHook(() =>
      useWorkspaceRuntimeEventIngest(
        {
          state: ownedSnapshot,
          subscribeRuntimeEvents: (
            listener: (events: readonly AcpRuntimeEvent[], snapshot?: AcpStateSnapshot) => void
          ) => {
            publish = listener
            return () => undefined
          }
        },
        () => undefined,
        true,
        () => undefined,
        () => true,
        () => ({ target: 'codex-bridge' })
      )
    )
    const promptMessageId = useSessionStore.getState().sessions[0].messages[0].id
    const events: AcpRuntimeEvent[] = [
      {
        id: 'choice-provider-stop',
        timestamp: 1,
        kind: 'stop',
        level: 'info',
        sessionId: 'session-1',
        promptMessageId,
        text: 'end_turn'
      },
      {
        id: 'choice-continuation-tool',
        timestamp: 2,
        kind: 'tool',
        level: 'info',
        sessionId: 'session-1',
        promptMessageId,
        toolCallId: 'continuation-tool-1',
        title: 'Continue after answer',
        status: 'in_progress'
      }
    ]

    await act(async () => {
      publish?.(events, { ...ownedSnapshot, events })
      await vi.waitFor(() => {
        expect(useSessionStore.getState().sessions[0].activities).toHaveLength(1)
      })
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'running',
      activeRun: undefined,
      agentPromptInFlight: true,
      awaitingFirstAgentOutput: true
    })
    unmount()
  })

  it('preserves a continuation when another Session releases ownership during its drain', async () => {
    const { messageId: promptMessageId } = useSessionStore.getState().appendUserMessage({
      sessionId: 'concurrent-session-a',
      content: 'Continue the first request'
    })!
    useSessionStore.getState().appendUserMessage({
      sessionId: 'concurrent-session-b',
      content: 'Complete the other request'
    })
    let snapshot = createSnapshot({
      revision: 1,
      agentPromptInFlightSessionIds: ['concurrent-session-a', 'concurrent-session-b']
    })
    let publish!: (events: readonly AcpRuntimeEvent[], snapshot?: AcpStateSnapshot) => void
    const subscribeRuntimeEvents = (listener: typeof publish): (() => void) => {
      publish = listener
      return () => undefined
    }
    const { rerender, unmount } = renderHook(() =>
      useWorkspaceRuntimeEventIngest(
        { state: snapshot, subscribeRuntimeEvents },
        () => undefined,
        true,
        () => undefined,
        () => true,
        () => ({ target: 'codex-bridge' })
      )
    )
    const events: AcpRuntimeEvent[] = [
      {
        id: 'concurrent-provider-stop',
        timestamp: 1,
        kind: 'stop',
        level: 'info',
        sessionId: 'concurrent-session-a',
        promptMessageId,
        text: 'end_turn'
      },
      {
        id: 'concurrent-continuation-tool',
        timestamp: 2,
        kind: 'tool',
        level: 'info',
        sessionId: 'concurrent-session-a',
        promptMessageId,
        toolCallId: 'concurrent-tool',
        title: 'Continue after answer',
        status: 'in_progress'
      }
    ]

    // Commit B's state-only release before A's asynchronous stop is applied.
    act(() => publish(events, snapshot))
    snapshot = createSnapshot({
      revision: 2,
      agentPromptInFlightSessionIds: ['concurrent-session-a']
    })
    rerender()
    await act(async () => processIncrementalWorkspaceRuntimeEvents(events))

    const session = useSessionStore
      .getState()
      .sessions.find((s) => s.id === 'concurrent-session-a')!
    expect(session.activities?.find((activity) => activity.id === 'concurrent-tool')?.status).toBe(
      'in_progress'
    )
    expect(session.agentPromptInFlight).toBe(true)
    expect(getAgentLoadingPhase(session)).toBe('interacting-with-tools')
    unmount()
  })

  it('returns to Thinking when a continuation tool completes in the provider-stop batch', async () => {
    const { messageId: promptMessageId } = useSessionStore.getState().appendUserMessage({
      sessionId: 'completed-continuation-session',
      content: 'Continue after the answer'
    })!
    const snapshot = createSnapshot({
      revision: 1,
      agentPromptInFlightSessionIds: ['completed-continuation-session']
    })
    let publish!: (events: readonly AcpRuntimeEvent[], snapshot?: AcpStateSnapshot) => void
    const { unmount } = renderHook(() =>
      useWorkspaceRuntimeEventIngest(
        {
          state: snapshot,
          subscribeRuntimeEvents: (listener) => {
            publish = listener
            return () => undefined
          }
        },
        () => undefined,
        true,
        () => undefined,
        () => true,
        () => ({ target: 'codex-bridge' })
      )
    )
    const runningTool: AcpRuntimeEvent = {
      id: 'completed-continuation-start',
      timestamp: 2,
      kind: 'tool',
      level: 'info',
      sessionId: 'completed-continuation-session',
      promptMessageId,
      toolCallId: 'completed-continuation-tool',
      title: 'Read result',
      status: 'in_progress'
    }
    const events: AcpRuntimeEvent[] = [
      {
        id: 'completed-continuation-provider-stop',
        timestamp: 1,
        kind: 'stop',
        level: 'info',
        sessionId: 'completed-continuation-session',
        promptMessageId,
        text: 'end_turn'
      },
      runningTool,
      { ...runningTool, id: 'completed-continuation-end', timestamp: 3, status: 'completed' }
    ]
    await act(async () => {
      publish(events, snapshot)
      await processIncrementalWorkspaceRuntimeEvents(events)
    })

    const session = useSessionStore
      .getState()
      .sessions.find((s) => s.id === 'completed-continuation-session')!
    expect(session.agentPromptInFlight).toBe(true)
    expect(
      session.activities?.find((activity) => activity.id === 'completed-continuation-tool')?.status
    ).toBe('completed')
    expect(getAgentLoadingPhase(session)).toBe('thinking')
    unmount()
  })

  it('does not restore ownership from a drained batch after a newer snapshot releases it', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Original request'
    })
    let publish:
      ((events: readonly AcpRuntimeEvent[], snapshot?: AcpStateSnapshot) => void) | undefined
    const ownedSnapshot = createSnapshot({
      sessionIds: ['session-1'],
      promptInFlight: true,
      promptInFlightSessionIds: ['session-1'],
      agentPromptInFlightSessionIds: ['session-1']
    })
    const { unmount } = renderHook(() =>
      useWorkspaceRuntimeEventIngest(
        {
          state: ownedSnapshot,
          subscribeRuntimeEvents: (
            listener: (events: readonly AcpRuntimeEvent[], snapshot?: AcpStateSnapshot) => void
          ) => {
            publish = listener
            return () => undefined
          }
        },
        () => undefined,
        true,
        () => undefined,
        () => true,
        () => ({ target: 'codex-bridge' })
      )
    )
    const promptMessageId = useSessionStore.getState().sessions[0].messages[0].id
    const events: AcpRuntimeEvent[] = [
      {
        id: 'stale-choice-provider-stop',
        timestamp: 1,
        kind: 'stop',
        level: 'info',
        sessionId: 'session-1',
        promptMessageId,
        text: 'end_turn'
      },
      {
        id: 'stale-choice-continuation-tool',
        timestamp: 2,
        kind: 'tool',
        level: 'info',
        sessionId: 'session-1',
        promptMessageId,
        toolCallId: 'stale-continuation-tool-1',
        title: 'Continue after answer',
        status: 'in_progress'
      }
    ]
    const releaseEvent: AcpRuntimeEvent = {
      id: 'ownership-release-stop',
      timestamp: 3,
      kind: 'stop',
      level: 'info',
      sessionId: 'session-1',
      promptMessageId,
      text: 'end_turn'
    }

    await act(async () => {
      publish?.(events, { ...ownedSnapshot, events })
      publish?.(
        [releaseEvent],
        createSnapshot({ sessionIds: ['session-1'], events: [...events, releaseEvent] })
      )
      await vi.waitFor(() => {
        expect(useSessionStore.getState().sessions[0].activities).toHaveLength(1)
      })
    })

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'idle',
      activeRun: undefined,
      agentPromptInFlight: undefined,
      awaitingFirstAgentOutput: undefined
    })
    unmount()
  })

  it.each(['live-event', 'stale-snapshot', 'stale-render'] as const)(
    'does not restore a released prompt from the previous React state through %s',
    async (delivery) => {
      const sessionId = `released-before-react-${delivery}`
      useSessionStore.getState().appendUserMessage({ sessionId, content: 'Complete this request' })
      useSessionStore.getState().finishRun(sessionId)
      let snapshot = createSnapshot({ revision: 1, agentPromptInFlightSessionIds: [sessionId] })
      let publish!: (events: readonly AcpRuntimeEvent[], snapshot?: AcpStateSnapshot) => void
      const subscribeRuntimeEvents = (listener: typeof publish): (() => void) => {
        publish = listener
        return () => undefined
      }
      const { rerender, unmount } = renderHook(() =>
        useWorkspaceRuntimeEventIngest(
          { state: snapshot, subscribeRuntimeEvents },
          () => undefined,
          true,
          () => undefined,
          () => true,
          () => ({ target: 'codex-bridge' })
        )
      )

      // The command result is authoritative before React commits the corresponding state update.
      act(() => {
        expect(
          syncWorkspaceInteractionStateFromSnapshot(
            createSnapshot({
              revision: 2,
              agentPromptInFlightSessionIds: []
            })
          )
        ).toBe(true)
      })
      const event: AcpRuntimeEvent = {
        id: `late-${delivery}`,
        timestamp: 1,
        kind: 'system',
        level: 'info',
        sessionId,
        text: 'Queued runtime event'
      }
      if (delivery === 'stale-render') {
        snapshot = { ...snapshot, agentPromptInFlightSessionIds: [sessionId] }
        rerender()
      } else {
        await act(async () => {
          publish([event], delivery === 'stale-snapshot' ? snapshot : undefined)
          await processIncrementalWorkspaceRuntimeEvents([event])
        })
      }

      const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)!
      expect(session.agentPromptInFlight).toBeUndefined()
      expect(session.awaitingFirstAgentOutput).toBeUndefined()
      expect(getAgentLoadingPhase(session)).toBe('hidden')
      unmount()
    }
  )

  it('does not revive prompt ownership from a stale initial snapshot', async () => {
    useSessionStore.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Original request'
    })
    useSessionStore.getState().finishRun('session-1')
    let publish:
      ((events: readonly AcpRuntimeEvent[], snapshot?: AcpStateSnapshot) => void) | undefined
    const currentSnapshot = createSnapshot({
      revision: 2,
      sessionIds: ['session-1']
    })
    const processLifecycleEvents = vi.fn()

    expect(acceptAcpRuntimeSnapshotRevision(currentSnapshot)).toBe(true)
    const { unmount } = renderHook(() =>
      useWorkspaceRuntimeEventIngest(
        {
          state: currentSnapshot,
          subscribeRuntimeEvents: (
            listener: (events: readonly AcpRuntimeEvent[], snapshot?: AcpStateSnapshot) => void
          ) => {
            publish = listener
            return () => undefined
          }
        },
        processLifecycleEvents,
        true,
        () => undefined,
        () => true,
        () => ({ target: 'codex-bridge' })
      )
    )
    const staleEvent: AcpRuntimeEvent = {
      id: 'stale-initial-message',
      timestamp: 1,
      kind: 'message',
      level: 'info',
      role: 'assistant',
      sessionId: 'session-1',
      text: 'Queued before the initial snapshot resolved'
    }
    const staleSnapshot = createSnapshot({
      revision: 1,
      sessionIds: ['session-1'],
      promptInFlight: true,
      promptInFlightSessionIds: ['session-1'],
      agentPromptInFlightSessionIds: ['session-1'],
      events: [staleEvent]
    })

    await act(async () => {
      publish?.([staleEvent], staleSnapshot)
      await vi.waitFor(() => {
        expect(useSessionStore.getState().sessions[0].messages).toHaveLength(2)
      })
    })

    expect(processLifecycleEvents).toHaveBeenCalledWith(
      expect.objectContaining({ state: currentSnapshot }),
      [staleEvent],
      expect.any(Object)
    )
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      status: 'running',
      activeRun: undefined,
      agentPromptInFlight: undefined,
      awaitingFirstAgentOutput: undefined
    })
    unmount()
  })
})
