import { describe, expect, it, vi } from 'vitest'
import {
  createLinearConversationGraph,
  validateConversationGraph
} from '../../../../shared/conversation-graph'
import type { AcpAgentRuntimeUpdate } from '../../../../shared/acp'
import type { ChatSession, SessionStoreApi } from '../../stores/session-store'
import {
  createSubagentTranscriptOwner,
  type WorkspaceSubagentFrameProjection
} from './workspace-subagent-runtime-presentation'

const root: ChatSession = {
  id: 'session',
  projectId: 'project',
  title: 'Root',
  cwd: '/tmp',
  status: 'running',
  createdAt: 1,
  updatedAt: 1,
  messages: []
}
const detail: WorkspaceSubagentFrameProjection = {
  frameId: 'child',
  status: 'running',
  attempt: {
    id: 'attempt',
    status: 'running',
    resolvedAgent: { kind: 'main' },
    runtimeSegmentIds: ['segment'],
    startedAt: 1
  },
  messages: [
    {
      id: 'prompt',
      role: 'user',
      content: 'Real task',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
  ]
}
const update = (id: string, text: string): AcpAgentRuntimeUpdate => ({
  scope: {
    projectId: 'project',
    sessionId: 'session',
    agentFrameId: 'child',
    attemptId: 'attempt',
    runtimeSegmentId: 'segment',
    promptMessageId: 'prompt'
  },
  event: {
    id,
    kind: 'message',
    role: 'assistant',
    messageId: 'response',
    text,
    timestamp: 2,
    level: 'info'
  }
})
const texts = (store: SessionStoreApi): string[] => {
  const state = store.getState()
  return state.sessions[0].messages.map(
    (message) => state.streamingMessages[message.id]?.content ?? message.content
  )
}

describe('App-owned Subagent transcript lifecycle', () => {
  it.each(['stop', 'error'] as const)(
    'keeps a resumed root execution out of the child %s projection',
    (kind) => {
      const rootPrompt = { ...detail.messages[0], id: 'root-prompt', content: 'Root task' }
      const graph = createLinearConversationGraph({
        sessionId: root.id,
        messages: [rootPrompt],
        createdAt: 1,
        updatedAt: 1
      })
      const child = createLinearConversationGraph({
        sessionId: 'child',
        messages: [...detail.messages],
        createdAt: 1,
        updatedAt: 1
      })
      const childFrameId = child.rootFrameId
      const childSegmentId = child.runtimeSegments[0].id
      graph.frames.push({
        ...child.frames[0],
        kind: 'delegate',
        parentFrameId: graph.rootFrameId,
        originMessageId: rootPrompt.id,
        originBindingState: 'validated'
      })
      graph.branches.push(...child.branches)
      graph.messages.push(...child.messages)
      graph.runtimeSegments.push(...child.runtimeSegments)
      validateConversationGraph(graph)
      const resumed: ChatSession = {
        ...root,
        messages: [rootPrompt],
        conversationGraph: graph,
        activeRun: { promptMessageId: rootPrompt.id, startedAt: 3 },
        activeRunRuntimeSegmentId: graph.runtimeSegments[0].id
      }
      const projection = {
        ...detail,
        frameId: childFrameId,
        attempt: { ...detail.attempt!, runtimeSegmentIds: [childSegmentId] }
      }
      const scopedUpdate = (id: string, text: string): AcpAgentRuntimeUpdate => ({
        ...update(id, text),
        scope: {
          ...update(id, text).scope,
          agentFrameId: childFrameId,
          runtimeSegmentId: childSegmentId
        }
      })
      const owner = createSubagentTranscriptOwner()
      const store = owner.select(resumed, projection)
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        owner.ingest(scopedUpdate('child-output', 'Child result'))
        // A new root snapshot must not reintroduce its resumed execution into the child store.
        owner.select({ ...resumed, updatedAt: 4 }, projection)
        const terminal = scopedUpdate('child-terminal', 'Child failed')
        owner.ingest({
          scope: terminal.scope,
          event: { id: 'child-terminal', kind, text: 'Child failed', timestamp: 5, level: 'info' }
        })
        const childSession = store.getState().sessions[0]
        expect(errors).not.toHaveBeenCalled()
        expect(childSession.conversationGraphSyncBlocked).toBeUndefined()
        expect(childSession.status).toBe(kind === 'stop' ? 'idle' : 'error')
        const response = childSession.conversationGraph!.messages.find(
          (message) => message.content === 'Child result'
        )
        expect(response).toMatchObject({
          agentFrameId: childFrameId,
          runtimeSegmentId: childSegmentId
        })
        validateConversationGraph(childSession.conversationGraph!)
        expect(resumed.activeRun?.promptMessageId).toBe(rootPrompt.id)
        expect(resumed.activeRunRuntimeSegmentId).toBe(graph.runtimeSegments[0].id)
        expect(resumed.conversationGraph).toEqual(graph)
      } finally {
        errors.mockRestore()
      }
    }
  )

  it('materializes output before the first reader, and retains the same store without any readers', () => {
    const owner = createSubagentTranscriptOwner()
    owner.ingest(update('one', 'Before opening'))
    const store = owner.select(root, detail)
    expect(texts(store)).toEqual(['Real task', 'Before opening'])
    owner.ingest(update('two', ' while closed'))
    owner.reconcileSessions([])
    expect(owner.select({ ...root, updatedAt: 3 }, detail)).toBe(store)
    expect(texts(store)).toEqual(['Real task', 'Before opening while closed'])
  })

  it('hydrates earlier durable turns ahead of output received before the graph arrives', () => {
    const owner = createSubagentTranscriptOwner()
    owner.ingest(update('one', 'New output'))
    const earlier = {
      ...detail,
      messages: [
        {
          ...detail.messages[0],
          id: 'earlier-prompt',
          content: 'Earlier task',
          createdAt: -2,
          updatedAt: -2
        },
        {
          ...detail.messages[0],
          id: 'earlier-answer',
          role: 'agent' as const,
          content: 'Earlier result',
          createdAt: -1,
          updatedAt: -1
        },
        ...detail.messages
      ]
    }
    expect(texts(owner.select(root, earlier))).toEqual([
      'Earlier task',
      'Earlier result',
      'Real task',
      'New output'
    ])
  })

  it('retains tool start, completion and message order across reader lifetimes', () => {
    const owner = createSubagentTranscriptOwner()
    owner.ingest(update('one', 'Plan'))
    for (const status of ['in_progress', 'completed'] as const) {
      owner.ingest({
        ...update(status, ''),
        event: {
          id: status,
          kind: 'tool',
          level: 'info',
          timestamp: 3,
          toolCallId: 'read',
          title: 'Read evidence',
          status,
          rawOutput: status === 'completed' ? { result: 'Evidence' } : undefined
        }
      })
    }
    owner.ingest({
      ...update('two', 'Findings'),
      event: { ...update('two', 'Findings').event, messageId: 'response-2' }
    })
    const store = owner.select(root, detail)
    expect(texts(store)).toEqual(['Real task', 'Plan', 'Findings'])
    expect(store.getState().sessions[0].activities).toEqual([
      expect.objectContaining({
        title: 'Read evidence',
        status: 'completed',
        rawOutput: { result: 'Evidence' }
      })
    ])
  })

  it('isolates project, child, attempt, segment and prompt identities even with reused provider IDs', () => {
    const owner = createSubagentTranscriptOwner()
    owner.ingest(update('same-id', 'Correct'))
    for (const field of [
      'projectId',
      'sessionId',
      'agentFrameId',
      'attemptId',
      'runtimeSegmentId',
      'promptMessageId'
    ] as const) {
      const other = update('same-id', 'Wrong')
      owner.ingest({ ...other, scope: { ...other.scope, [field]: 'other' } })
    }
    owner.ingest(update('same-id', 'Duplicate'))
    expect(texts(owner.select(root, detail))).toEqual(['Real task', 'Correct'])
  })

  it('deduplicates staged records and gives the durable terminal snapshot authority', () => {
    const owner = createSubagentTranscriptOwner()
    owner.ingest(update('one', 'Live'))
    const store = owner.select(root, detail)
    const durable = {
      ...detail,
      status: 'completed' as const,
      attempt: { ...detail.attempt!, status: 'completed' as const, endedAt: 4 },
      messages: [
        ...detail.messages,
        {
          id: 'durable-response',
          role: 'agent' as const,
          content: 'Live',
          status: 'complete' as const,
          responseToMessageId: 'prompt',
          eventIds: ['one'],
          createdAt: 2,
          updatedAt: 4
        }
      ]
    }
    expect(owner.select({ ...root, updatedAt: 4 }, durable)).toBe(store)
    owner.ingest(update('late', 'Must not reopen settled history'))
    expect(texts(store)).toEqual(['Real task', 'Live'])
    owner.reconcileSessions([])
    const rehydrated = owner.select({ ...root, updatedAt: 5 }, durable)
    expect(rehydrated).not.toBe(store)
    expect(texts(rehydrated)).toEqual(['Real task', 'Live'])
  })
  it('retires earlier runtime segments when a continued Attempt settles and the Session is evicted', () => {
    const owner = createSubagentTranscriptOwner()
    owner.ingest(update('one', 'First turn'))
    const firstStore = owner.select(root, detail)
    const nextPrompt = {
      ...detail.messages[0],
      id: 'next-prompt',
      content: 'Continue',
      createdAt: 3,
      updatedAt: 3
    }
    const nextAttempt = { ...detail.attempt!, runtimeSegmentIds: ['segment', 'next-segment'] }
    const nextDetail = { ...detail, attempt: nextAttempt, messages: [nextPrompt] }
    const nextUpdate = update('two', 'Second turn')
    owner.ingest({
      ...nextUpdate,
      scope: {
        ...nextUpdate.scope,
        runtimeSegmentId: 'next-segment',
        promptMessageId: 'next-prompt'
      }
    })
    const nextStore = owner.select({ ...root, updatedAt: 3 }, nextDetail)
    const terminalAttempt = { ...nextAttempt, status: 'completed' as const, endedAt: 5 }
    const messages = [
      detail.messages[0],
      {
        ...detail.messages[0],
        id: 'first-answer',
        role: 'agent' as const,
        content: 'First turn',
        eventIds: ['one'],
        createdAt: 2,
        updatedAt: 2
      },
      nextPrompt,
      {
        ...nextPrompt,
        id: 'next-answer',
        role: 'agent' as const,
        content: 'Second turn',
        eventIds: ['two'],
        createdAt: 4,
        updatedAt: 4
      }
    ]
    const terminal: ChatSession = {
      ...root,
      updatedAt: 5,
      runtimeContext: {
        version: 1,
        revision: 2,
        delegatedWork: { records: [{ agentFrameId: 'child', attempts: [terminalAttempt] }] }
      },
      conversationGraph: {
        schemaVersion: 1,
        rootFrameId: 'child',
        activeFrameId: 'child',
        frames: [
          {
            id: 'child',
            kind: 'root',
            originBindingState: 'root',
            status: 'completed',
            activeBranchId: 'branch',
            createdAt: 1
          }
        ],
        branches: [
          {
            id: 'branch',
            agentFrameId: 'child',
            headMessageId: 'next-answer',
            createdAt: 1,
            updatedAt: 5
          }
        ],
        messages: messages.map((message, index) => ({
          ...message,
          agentFrameId: 'child',
          introducedOnBranchId: 'branch',
          parentMessageId: messages[index - 1]?.id
        })),
        runtimeSegments: [],
        activities: [],
        activityGroups: []
      }
    }
    owner.reconcileSessions([terminal])
    owner.reconcileSessions([])
    const historicalDetail = {
      ...detail,
      status: 'completed' as const,
      attempt: { ...detail.attempt!, status: 'completed' as const },
      messages: messages.slice(0, 2)
    }
    expect(owner.select(terminal, historicalDetail)).not.toBe(firstStore)
    const rehydrated = owner.select(terminal, {
      ...nextDetail,
      status: 'completed',
      attempt: terminalAttempt,
      messages
    })
    expect(rehydrated).not.toBe(nextStore)
    expect(texts(rehydrated)).toEqual(['Real task', 'First turn', 'Continue', 'Second turn'])
  })
})
