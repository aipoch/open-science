// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AcpAgentRuntimeUpdate } from '../../../../shared/acp'
import type { ChatSession } from '../../stores/session-store'
import * as sessionStoreModule from '../../stores/session-store'
import { isExternallyHydratedSession } from '../../stores/session-store-persistence-owner'
import { useSubagentRuntimePresentation } from './workspace-subagent-runtime-presentation'

const session: ChatSession = {
  id: 'session-1',
  projectId: 'project-1',
  title: 'Delegated work',
  cwd: '/tmp/project',
  status: 'running',
  messages: [],
  createdAt: 1,
  updatedAt: 1
}

const detail: Parameters<typeof useSubagentRuntimePresentation>[2] = {
  frameId: 'child-1',
  status: 'running',
  attempt: {
    id: 'attempt-1',
    status: 'running',
    resolvedAgent: { kind: 'main' },
    runtimeSegmentIds: ['runtime-1'],
    startedAt: 2
  },
  messages: [
    {
      id: 'prompt-1',
      role: 'user',
      content: 'Research this topic',
      status: 'complete',
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    }
  ]
}

const update = (index: number): AcpAgentRuntimeUpdate => ({
  scope: {
    projectId: 'project-1',
    sessionId: 'session-1',
    agentFrameId: 'child-1',
    attemptId: 'attempt-1',
    runtimeSegmentId: 'runtime-1',
    promptMessageId: 'prompt-1'
  },
  event: {
    id: `chunk-${index}`,
    timestamp: 10 + index,
    kind: 'message',
    level: 'info',
    role: 'assistant',
    messageId: 'same-stream',
    text: `chunk ${index} `
  }
})

afterEach(cleanup)

describe('subagent streaming presentation', () => {
  it('hydrates the initial child once and reconciles live and later durable output', () => {
    const createStore = sessionStoreModule.createSessionStore
    const stores: ReturnType<typeof createStore>[] = []
    const createStoreSpy = vi
      .spyOn(sessionStoreModule, 'createSessionStore')
      .mockImplementation(() => {
        const store = createStore()
        const upsert = store.getState().upsertPersistedSession
        store.setState({ upsertPersistedSession: vi.fn(upsert) })
        stores.push(store)
        return store
      })
    const listeners = new Set<(runtimeUpdate: AcpAgentRuntimeUpdate) => void>()
    const subscribe = (listener: (runtimeUpdate: AcpAgentRuntimeUpdate) => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    try {
      const view = renderHook(
        ({ currentSession, currentDetail }) =>
          useSubagentRuntimePresentation(subscribe, currentSession, currentDetail),
        { initialProps: { currentSession: session, currentDetail: detail } }
      )
      expect(stores).toHaveLength(1)
      const presentationStore = stores[0]
      expect(presentationStore.getState().upsertPersistedSession).toHaveBeenCalledTimes(1)
      expect(presentationStore.getState().selectedSessionId).toBe(session.id)
      expect(isExternallyHydratedSession(presentationStore.getState().sessions[0])).toBe(true)
      expect(view.result.current).toMatchObject({
        status: 'running',
        agentPromptInFlight: true,
        activeRun: { promptMessageId: 'prompt-1', startedAt: 2 },
        messages: [{ id: 'prompt-1', content: 'Research this topic' }]
      })

      act(() => {
        for (const listener of listeners) listener(update(0))
      })
      expect(view.result.current.messages.at(-1)?.content).toBe('chunk 0 ')

      const completedSession = { ...session, revision: 1, updatedAt: 20 }
      const completedDetail = {
        ...detail,
        status: 'completed' as const,
        attempt: { ...detail.attempt!, status: 'completed' as const, endedAt: 20 },
        messages: [
          ...detail.messages,
          {
            id: 'same-stream',
            role: 'agent' as const,
            content: 'Durable final answer',
            status: 'complete' as const,
            eventIds: [],
            createdAt: 20,
            updatedAt: 20
          }
        ]
      }
      view.rerender({ currentSession: completedSession, currentDetail: completedDetail })
      expect(presentationStore.getState().upsertPersistedSession).toHaveBeenCalledTimes(2)
      expect(view.result.current.status).toBe('idle')
      expect(view.result.current.messages.at(-1)?.content).toBe('Durable final answer')
    } finally {
      createStoreSpy.mockRestore()
    }
  })

  it('receives hidden chunks without presenting them and materializes the latest on activation', () => {
    const listeners = new Set<(update: AcpAgentRuntimeUpdate) => void>()
    const subscribe = (listener: (update: AcpAgentRuntimeUpdate) => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
    let renderCount = 0
    const view = renderHook(
      ({ active }) => {
        renderCount += 1
        return useSubagentRuntimePresentation(subscribe, session, detail, active)
      },
      { initialProps: { active: false } }
    )
    const hiddenRenderCount = renderCount

    act(() => {
      for (let index = 0; index < 10; index += 1) {
        for (const listener of listeners) listener(update(index))
      }
    })
    expect(renderCount).toBe(hiddenRenderCount)
    expect(view.result.current.messages.map((message) => message.content)).toEqual([
      'Research this topic'
    ])

    view.rerender({ active: true })
    expect(view.result.current.messages.at(-1)?.content).toBe(
      Array.from({ length: 10 }, (_, index) => `chunk ${index} `).join('')
    )
  })

  it.each([false, true])('shows later text chunks while mounted with hidden=%s', (hidden) => {
    const listeners = new Set<(update: AcpAgentRuntimeUpdate) => void>()
    const subscribe = (listener: (update: AcpAgentRuntimeUpdate) => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
    const view = renderHook(() => useSubagentRuntimePresentation(subscribe, session, detail), {
      wrapper: ({ children }) => <section hidden={hidden}>{children}</section>
    })

    act(() => {
      for (const listener of listeners) listener(update(0))
    })
    expect(view.result.current.messages.at(-1)?.content).toBe('chunk 0 ')

    act(() => {
      for (const listener of listeners) listener(update(1))
      for (const listener of listeners) listener(update(2))
    })
    expect(view.result.current.messages.at(-1)?.content).toBe('chunk 0 chunk 1 chunk 2 ')
  })
})
