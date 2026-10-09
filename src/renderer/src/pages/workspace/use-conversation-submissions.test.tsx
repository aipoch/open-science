// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hydrateSession, useSessionStore, type ChatSession } from '@/stores/session-store'
import { materializeSessionConversationGraph } from '../../../../shared/session-persistence'
import {
  useConversationSubmissions,
  type ConversationSubmissions
} from './use-conversation-submissions'

const runningSession = (): ChatSession => ({
  id: 'session-a',
  projectId: 'project',
  title: 'Thinking',
  cwd: '/workspace',
  status: 'running',
  activeRun: { promptMessageId: 'prompt-a', startedAt: 1 },
  agentPromptInFlight: true,
  messages: [],
  createdAt: 1,
  updatedAt: 1
})

const delegatedSession = (): ChatSession => {
  const session = materializeSessionConversationGraph({
    ...runningSession(),
    messages: [
      {
        id: 'prompt-a',
        role: 'user',
        content: 'Delegate analysis',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })
  session.conversationGraph!.frames.push({
    id: 'child',
    kind: 'delegate',
    parentFrameId: session.conversationGraph!.rootFrameId,
    originMessageId: 'prompt-a',
    originBindingState: 'validated',
    activeBranchId: 'child-branch',
    status: 'running',
    createdAt: 2
  })
  session.conversationGraph!.branches.push({
    id: 'child-branch',
    agentFrameId: 'child',
    createdAt: 2,
    updatedAt: 2
  })
  return { ...hydrateSession(session), agentPromptInFlight: true }
}

let root: Root
let submissions: ConversationSubmissions
let renderCount: number
const Harness = (): null => {
  const current = useConversationSubmissions()
  useLayoutEffect(() => {
    submissions = current
    renderCount += 1
  })
  return null
}
const updateSession = (patch: Partial<ChatSession>): void => {
  act(() => {
    useSessionStore.setState(({ sessions }) => ({
      sessions: sessions.map((session) => ({ ...session, ...patch }))
    }))
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useSessionStore.setState({ sessions: [runningSession()] })
  renderCount = 0
  root = createRoot(document.createElement('div'))
  act(() => root.render(<Harness />))
})
afterEach(() => act(() => root.unmount()))

describe('Stop submission lifecycle', () => {
  it.each(['agentPromptInFlight', 'compacting', 'fixLoopActive'] as const)(
    'tracks %s ownership even without an activeRun',
    async (flag) => {
      act(() =>
        useSessionStore.setState({
          sessions: [
            {
              ...runningSession(),
              status: 'idle',
              activeRun: undefined,
              agentPromptInFlight: false,
              [flag]: true
            }
          ]
        })
      )
      const stop = vi.fn(async () => {})
      await act(async () => submissions.submitStop('session-a', stop))
      expect(submissions.stopBySessionId.get('session-a')?.pending).toBe(true)
      act(() => submissions.submitStop('session-a', stop))
      expect(stop).toHaveBeenCalledOnce()
      updateSession({ [flag]: false })
      expect(submissions.stopBySessionId.has('session-a')).toBe(false)
      updateSession({ [flag]: true })
      expect(submissions.stopBySessionId.has('session-a')).toBe(false)
      await act(async () => submissions.submitStop('session-a', stop))
      expect(stop).toHaveBeenCalledTimes(2)
      expect(submissions.stopBySessionId.get('session-a')?.pending).toBe(true)
    }
  )

  it('keeps the first Stop pending after acknowledgement until execution really settles', async () => {
    const stop = vi.fn(async () => {})
    await act(async () => submissions.submitStop('session-a', stop))
    expect(submissions.stopBySessionId.get('session-a')).toEqual({ pending: true })
    act(() => submissions.submitStop('session-a', stop))
    expect(stop).toHaveBeenCalledOnce()

    updateSession({ status: 'idle' })
    expect(submissions.stopBySessionId.get('session-a')?.pending).toBe(true)
    const rendersBeforeChunk = renderCount
    updateSession({ agentStatus: 'Thinking harder', updatedAt: 2 })
    expect(renderCount).toBe(rendersBeforeChunk)

    updateSession({ activeRun: undefined })
    expect(submissions.stopBySessionId.get('session-a')?.pending).toBe(true)
    updateSession({ agentPromptInFlight: false })
    expect(submissions.stopBySessionId.has('session-a')).toBe(false)
  })

  it('waits for branch-owned delegation after the root execution settles', async () => {
    const session = delegatedSession()
    act(() => useSessionStore.setState({ sessions: [session] }))
    await act(async () => submissions.submitStop('session-a', async () => {}))
    updateSession({ status: 'idle', activeRun: undefined, agentPromptInFlight: false })
    expect(submissions.stopBySessionId.get('session-a')?.pending).toBe(true)

    const graph = structuredClone(session.conversationGraph!)
    graph.frames.find(({ id }) => id === 'child')!.status = 'cancelled'
    updateSession({ conversationGraph: graph })
    expect(submissions.stopBySessionId.has('session-a')).toBe(false)
  })

  it('does not apply a detached-child Stop to a later root execution', async () => {
    act(() =>
      useSessionStore.setState({
        sessions: [
          {
            ...delegatedSession(),
            status: 'idle',
            activeRun: undefined,
            agentPromptInFlight: false
          }
        ]
      })
    )
    await act(async () => submissions.submitStop('session-a', async () => {}))
    expect(submissions.stopBySessionId.get('session-a')?.pending).toBe(true)
    updateSession({
      status: 'running',
      activeRun: { promptMessageId: 'prompt-b', startedAt: 3 },
      agentPromptInFlight: true
    })
    expect(submissions.stopBySessionId.has('session-a')).toBe(false)
  })

  it.each(['settled', 'superseded'] as const)(
    'waits for the captured durable Attempt until %s when its frame appears cancelled early',
    async (result) => {
      const session: ChatSession = {
        ...delegatedSession(),
        status: 'idle',
        activeRun: undefined,
        agentPromptInFlight: false,
        runtimeContext: {
          version: 1,
          revision: 1,
          delegatedWork: {
            records: [
              {
                agentFrameId: 'child',
                attempts: [
                  {
                    id: 'attempt-a',
                    status: 'running',
                    resolvedAgent: { kind: 'main' },
                    runtimeSegmentIds: [],
                    startedAt: 2
                  }
                ]
              }
            ]
          }
        }
      }
      act(() => useSessionStore.setState({ sessions: [session] }))
      await act(async () => submissions.submitStop('session-a', async () => {}))
      const graph = structuredClone(session.conversationGraph!)
      graph.frames.find(({ id }) => id === 'child')!.status = 'cancelled'
      updateSession({ conversationGraph: graph })
      expect(submissions.stopBySessionId.get('session-a')?.pending).toBe(true)
      updateSession({
        runtimeContext: {
          ...session.runtimeContext!,
          delegatedWork: {
            records: [
              {
                agentFrameId: 'child',
                attempts:
                  result === 'settled'
                    ? [
                        {
                          ...session.runtimeContext!.delegatedWork!.records[0].attempts[0],
                          status: 'cancelled',
                          endedAt: 3
                        }
                      ]
                    : [
                        session.runtimeContext!.delegatedWork!.records[0].attempts[0],
                        {
                          ...session.runtimeContext!.delegatedWork!.records[0].attempts[0],
                          id: 'attempt-b',
                          startedAt: 3
                        }
                      ]
              }
            ]
          }
        }
      })
      expect(submissions.stopBySessionId.has('session-a')).toBe(false)
    }
  )

  it('restores retry after failure and does not carry its error into a later execution', async () => {
    await act(async () =>
      submissions.submitStop('session-a', async () => {
        throw new Error('Stop request failed')
      })
    )
    expect(submissions.stopBySessionId.get('session-a')).toEqual({
      pending: false,
      error: 'Stop request failed'
    })
    updateSession({ activeRun: { promptMessageId: 'prompt-b', startedAt: 2 } })
    expect(submissions.stopBySessionId.has('session-a')).toBe(false)
    const retry = vi.fn(async () => {})
    await act(async () => submissions.submitStop('session-a', retry))
    expect(retry).toHaveBeenCalledOnce()
    expect(submissions.stopBySessionId.get('session-a')).toEqual({ pending: true })
  })

  it.each(['acknowledgement', 'failure'] as const)(
    'ignores a late old %s after another execution has its own Stop',
    async (result) => {
      let acknowledge!: () => void
      let fail!: (error: Error) => void
      act(() =>
        submissions.submitStop(
          'session-a',
          () =>
            new Promise<void>((resolve, reject) => {
              acknowledge = resolve
              fail = reject
            })
        )
      )
      updateSession({ status: 'idle', activeRun: undefined, agentPromptInFlight: false })
      expect(submissions.stopBySessionId.has('session-a')).toBe(false)
      updateSession({
        status: 'running',
        activeRun: { promptMessageId: 'prompt-b', startedAt: 2 },
        agentPromptInFlight: true
      })
      const stopNewRun = vi.fn(async () => {})
      await act(async () => submissions.submitStop('session-a', stopNewRun))
      await act(async () => {
        if (result === 'acknowledgement') acknowledge()
        else fail(new Error('Old cancellation failed'))
      })
      expect(submissions.stopBySessionId.get('session-a')).toEqual({ pending: true })
      act(() => submissions.submitStop('session-a', stopNewRun))
      expect(stopNewRun).toHaveBeenCalledOnce()
      updateSession({ status: 'idle', activeRun: undefined, agentPromptInFlight: false })
      expect(submissions.stopBySessionId.has('session-a')).toBe(false)
    }
  )

  it('allows retrying a synchronous cancellation failure while the same execution still runs', async () => {
    act(() =>
      submissions.submitStop('session-a', () => {
        throw new Error('Cannot deliver cancellation')
      })
    )
    expect(submissions.stopBySessionId.get('session-a')).toEqual({
      pending: false,
      error: 'Cannot deliver cancellation'
    })
    const retry = vi.fn(() => {})
    act(() => submissions.submitStop('session-a', retry))
    expect(retry).toHaveBeenCalledOnce()
    expect(submissions.stopBySessionId.get('session-a')).toEqual({ pending: true })
    act(() => submissions.submitStop('session-a', retry))
    expect(retry).toHaveBeenCalledOnce()
    updateSession({ status: 'idle', activeRun: undefined, agentPromptInFlight: false })
    expect(submissions.stopBySessionId.has('session-a')).toBe(false)
  })
})
