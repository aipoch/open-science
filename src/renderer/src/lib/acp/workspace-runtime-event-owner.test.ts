// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AcpRuntimeEvent, AcpStateSnapshot } from '../../../../shared/acp'
import type { PersistedChatSession } from '../../../../shared/session-persistence'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import {
  refreshDelegatedWorkSessions,
  resetWorkspaceRuntimeEventOwnerForTests,
  useWorkspaceRuntimeEventIngest
} from './workspace-runtime-event-owner'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const renderHook = <Value>(
  hook: () => Value
): { result: { current: Value }; unmount: () => void } => {
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
})
