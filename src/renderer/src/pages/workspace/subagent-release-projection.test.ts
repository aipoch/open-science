import { describe, expect, it } from 'vitest'

import type { AcpPermissionRequest } from '../../../../shared/acp'
import type {
  DelegatedQuestionRequest,
  PersistedChatSession
} from '../../../../shared/session-persistence'

import {
  projectDelegatedQuestionQueue,
  projectSessionSubagents,
  selectSubagentFrame
} from './subagent-release-projection'

const createSession = (count = 3): PersistedChatSession => {
  const now = 1_700_000_000_000
  const frames = [
    {
      id: 'root',
      originBindingState: 'root' as const,
      kind: 'root' as const,
      status: 'completed' as const,
      activeBranchId: 'root-branch',
      createdAt: now
    },
    ...Array.from({ length: count }, (_, index) => ({
      id: `child-${index}`,
      parentFrameId: 'root',
      originMessageId: 'root-prompt',
      originBindingState: 'validated' as const,
      kind: 'delegate' as const,
      delegateName: `Child ${String(index + 1).padStart(2, '0')}`,
      agentName: index === 1 ? 'Literature Specialist' : 'Main Agent',
      status: (['running', 'completed', 'cancelled', 'error'] as const)[index % 4],
      activeBranchId: `branch-${index}`,
      createdAt: now + index
    }))
  ]
  const messages = [
    {
      id: 'root-prompt',
      role: 'user' as const,
      content: 'Delegate this work',
      status: 'complete' as const,
      eventIds: [],
      createdAt: now,
      updatedAt: now,
      agentFrameId: 'root',
      introducedOnBranchId: 'root-branch',
      runtimeSegmentId: 'root-runtime'
    },
    ...Array.from({ length: count }, (_, index) => ({
      id: `child-message-${index}`,
      role: index % 2 === 0 ? ('user' as const) : ('agent' as const),
      content: `Child message ${index}`,
      status: 'complete' as const,
      eventIds: [],
      createdAt: now + index + 1,
      updatedAt: now + index + 1,
      agentFrameId: `child-${index}`,
      introducedOnBranchId: `branch-${index}`,
      runtimeSegmentId: `runtime-${index}`
    }))
  ]

  return {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Release gate',
    cwd: '/tmp/release-gate',
    status: 'idle',
    messages: [],
    createdAt: now,
    updatedAt: now,
    conversationGraph: {
      schemaVersion: 1,
      rootFrameId: 'root',
      activeFrameId: 'root',
      frames,
      branches: [
        {
          id: 'root-branch',
          agentFrameId: 'root',
          headMessageId: 'root-prompt',
          createdAt: now,
          updatedAt: now
        },
        ...Array.from({ length: count }, (_, index) => ({
          id: `branch-${index}`,
          agentFrameId: `child-${index}`,
          headMessageId: `child-message-${index}`,
          createdAt: now + index,
          updatedAt: now + index
        }))
      ],
      messages,
      activities: [],
      activityGroups: [],
      runtimeSegments: [
        {
          id: 'root-runtime',
          agentFrameId: 'root',
          frameworkId: 'claude-code',
          startedAt: now
        },
        ...Array.from({ length: count }, (_, index) => ({
          id: `runtime-${index}`,
          agentFrameId: `child-${index}`,
          frameworkId: 'claude-code' as const,
          startedAt: now + index
        }))
      ]
    },
    runtimeContext: {
      version: 1,
      revision: count,
      delegatedWork: {
        records: Array.from({ length: count }, (_, index) => ({
          agentFrameId: `child-${index}`,
          attempts: [
            {
              id: `attempt-${index}`,
              status: frames[index + 1].status,
              resolvedAgent:
                index === 1
                  ? {
                      kind: 'specialist' as const,
                      profileId: 'literature',
                      revision: 4,
                      displayName: 'Literature Specialist'
                    }
                  : { kind: 'main' as const },
              runtimeSegmentIds: [`runtime-${index}`],
              startedAt: now + index
            }
          ]
        }))
      }
    }
  }
}

describe('release-gate Subagent projection', () => {
  it('projects only active direct-child questions in durable admission order', () => {
    const session = createSession(2)
    Object.assign(session.runtimeContext!.delegatedWork!, {
      questionRequests: [
        {
          requestId: 'question-later',
          canonicalDigest: 'b'.repeat(64),
          sourceFrameId: 'child-1',
          sourceAttemptId: 'attempt-1',
          sourceRuntimeSegmentId: 'runtime-1',
          sourceMessageBranchId: 'branch-1',
          rootOriginMessageId: 'root-prompt',
          rootBranchId: 'root-branch',
          sourceName: 'Child 02',
          questions: [{ question: 'Second?', options: [{ label: 'A' }, { label: 'B' }] }],
          sequence: 2,
          askedAt: 20,
          status: 'pending',
          draftAnswers: [],
          draftQuestionIndex: 0
        },
        {
          requestId: 'question-first',
          canonicalDigest: 'a'.repeat(64),
          sourceFrameId: 'child-0',
          sourceAttemptId: 'attempt-0',
          sourceRuntimeSegmentId: 'runtime-0',
          sourceMessageBranchId: 'branch-0',
          rootOriginMessageId: 'root-prompt',
          rootBranchId: 'root-branch',
          sourceName: 'Child 01',
          questions: [{ question: 'First?', options: [{ label: 'A' }, { label: 'B' }] }],
          sequence: 1,
          askedAt: 10,
          status: 'pending',
          draftAnswers: [{ questionIndex: 0, value: 'A' }],
          draftQuestionIndex: 0
        }
      ]
    })

    expect(projectDelegatedQuestionQueue(session).map(({ requestId }) => requestId)).toEqual([
      'question-first',
      'question-later'
    ])

    const owner = session.runtimeContext!.delegatedWork!
    Object.assign(owner, {
      questionRequests: owner.questionRequests!.map((request) => ({
        ...request,
        sequence: 1,
        askedAt: 10
      }))
    })
    expect(projectDelegatedQuestionQueue(session).map(({ requestId }) => requestId)).toEqual([
      'question-first',
      'question-later'
    ])
    Object.assign(owner, {
      questionRequests: owner.questionRequests!.map((request) => {
        const withoutSequence = { ...request }
        delete withoutSequence.sequence
        return request.requestId === 'question-first'
          ? { ...withoutSequence, askedAt: 10 }
          : { ...withoutSequence, askedAt: 20 }
      })
    })
    expect(projectDelegatedQuestionQueue(session).map(({ requestId }) => requestId)).toEqual([
      'question-first',
      'question-later'
    ])
    expect(projectSessionSubagents(session, []).children[0].status).toBe('awaiting_user')
    expect(selectSubagentFrame(session, 'child-0')?.status).toBe('awaiting_user')

    const root = session.conversationGraph!.frames.find((frame) => frame.id === 'root')!
    session.conversationGraph!.messages.push({
      id: 'alternate-root-prompt',
      role: 'user',
      content: 'Alternate branch',
      status: 'complete',
      eventIds: [],
      agentFrameId: 'root',
      introducedOnBranchId: 'alternate-root-branch',
      createdAt: 20,
      updatedAt: 20
    })
    session.conversationGraph!.branches.push({
      id: 'alternate-root-branch',
      agentFrameId: 'root',
      headMessageId: 'alternate-root-prompt',
      createdAt: 20,
      updatedAt: 20
    })
    root.activeBranchId = 'alternate-root-branch'
    expect(projectDelegatedQuestionQueue(session)).toEqual([])
    root.activeBranchId = 'root-branch'
    expect(projectDelegatedQuestionQueue(session).map(({ requestId }) => requestId)).toEqual([
      'question-first',
      'question-later'
    ])

    session.conversationGraph!.activeFrameId = 'child-0'
    expect(projectDelegatedQuestionQueue(session)).toEqual([])
  })

  it('uses one stable fallback order for every permutation of a mixed-sequence queue', () => {
    const session = createSession(3)
    const request = (
      id: 'a' | 'b' | 'c',
      childIndex: number,
      askedAt: number,
      sequence?: number
    ): DelegatedQuestionRequest => ({
      requestId: `question-${id}`,
      canonicalDigest: id.repeat(64),
      sourceFrameId: `child-${childIndex}`,
      sourceAttemptId: `attempt-${childIndex}`,
      sourceRuntimeSegmentId: `runtime-${childIndex}`,
      sourceMessageBranchId: `branch-${childIndex}`,
      rootOriginMessageId: 'root-prompt',
      rootBranchId: 'root-branch',
      sourceName: `Child ${String(childIndex + 1).padStart(2, '0')}`,
      questions: [{ question: `${id}?`, options: [{ label: 'Yes' }, { label: 'No' }] }],
      ...(sequence === undefined ? {} : { sequence }),
      askedAt,
      status: 'pending' as const,
      draftAnswers: [],
      draftQuestionIndex: 0
    })
    const requests = [request('a', 0, 100, 1), request('b', 1, 50), request('c', 2, 0, 2)]
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0]
    ]

    for (const permutation of permutations) {
      Object.assign(session.runtimeContext!.delegatedWork!, {
        questionRequests: permutation.map((index) => requests[index])
      })
      expect(projectDelegatedQuestionQueue(session).map(({ requestId }) => requestId)).toEqual([
        'question-c',
        'question-b',
        'question-a'
      ])
    }
  })

  it('projects only the four raw statuses and keeps permission as running detail', () => {
    const permission = {
      requestId: 'permission-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      title: 'Read restricted file',
      options: [],
      delegated: {
        frameId: 'child-0',
        attemptId: 'attempt-0',
        childTitle: 'Child 01',
        riskScope: 'This call only'
      }
    } satisfies AcpPermissionRequest

    const projection = projectSessionSubagents(createSession(4), [permission])

    expect(projection.children.map(({ status }) => status)).toEqual([
      'running',
      'completed',
      'cancelled',
      'error'
    ])
    expect(projection.runningCount).toBe(1)
    expect(projection.children[0]).toMatchObject({ awaitingPermission: true })
    expect(projection.children.map(({ status }) => status)).not.toContain('waiting')
  })

  it('preserves dispatch order and stable titles for 24 children across status changes and reopen', () => {
    const first = projectSessionSubagents(createSession(24), [])
    const reopened = structuredClone(createSession(24))
    const child = reopened.conversationGraph?.frames.find((frame) => frame.id === 'child-20')
    if (child) child.status = 'completed'
    const record = reopened.runtimeContext?.delegatedWork?.records.find(
      (candidate) => candidate.agentFrameId === 'child-20'
    )
    const attempt = record?.attempts.at(-1)
    if (attempt) Object.assign(attempt, { status: 'completed' })

    const second = projectSessionSubagents(reopened, [])

    expect(second.children.map(({ frameId }) => frameId)).toEqual(
      Array.from({ length: 24 }, (_, index) => `child-${index}`)
    )
    expect(second.children.map(({ title }) => title)).toEqual(
      first.children.map(({ title }) => title)
    )
  })

  it('selects the exact child branch without mutating the root Session projection', () => {
    const session = createSession(3)
    const selected = selectSubagentFrame(session, 'child-1')

    expect(selected).toMatchObject({
      frameId: 'child-1',
      title: 'Child 02',
      status: 'completed',
      agentLabel: 'Literature Specialist'
    })
    expect(selected?.messages.map(({ content }) => content)).toEqual(['Child message 1'])
    expect(session.conversationGraph?.activeFrameId).toBe('root')
  })

  it('removes validated children when their origin leaves the active root Branch', () => {
    const session = createSession(1)
    const graph = session.conversationGraph!
    graph.messages.push({
      id: 'alternate-root',
      role: 'user',
      content: 'alternate',
      status: 'complete',
      eventIds: [],
      agentFrameId: graph.rootFrameId,
      introducedOnBranchId: 'root-branch',
      createdAt: 2,
      updatedAt: 2
    })
    graph.branches.find(({ id }) => id === 'root-branch')!.headMessageId = 'alternate-root'

    expect(projectSessionSubagents(session, []).children).toEqual([])
  })
})
