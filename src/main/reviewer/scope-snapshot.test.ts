import { describe, expect, it } from 'vitest'

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { resolveTurnScope } from './scope'
import { buildReviewScopeSnapshot } from './scope-snapshot'

describe('Review scope snapshot', () => {
  it('freezes payloads from the active conversation Branch rather than a stale flat projection', () => {
    const oldUser = {
      id: 'user-old',
      role: 'user' as const,
      content: 'old prompt',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const oldAgent = {
      id: 'agent-old',
      role: 'agent' as const,
      content: 'old answer',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 3,
      updatedAt: 3
    }
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [oldUser, oldAgent],
      createdAt: 1,
      updatedAt: 3
    })
    const frame = graph.frames[0]
    const runtimeSegmentId = graph.runtimeSegments[0].id
    frame.activeBranchId = 'edited-branch'
    graph.branches.push({
      id: 'edited-branch',
      agentFrameId: frame.id,
      parentBranchId: graph.branches[0].id,
      supersededMessageId: oldUser.id,
      headMessageId: 'agent-edited',
      createdAt: 4,
      updatedAt: 6
    })
    graph.messages.push(
      {
        ...oldUser,
        id: 'user-edited',
        content: 'edited prompt',
        createdAt: 4,
        updatedAt: 4,
        agentFrameId: frame.id,
        introducedOnBranchId: 'edited-branch',
        revisionRootMessageId: oldUser.id,
        supersedesMessageId: oldUser.id,
        runtimeSegmentId
      },
      {
        ...oldAgent,
        id: 'agent-edited',
        content: 'edited answer',
        createdAt: 6,
        updatedAt: 6,
        agentFrameId: frame.id,
        introducedOnBranchId: 'edited-branch',
        parentMessageId: 'user-edited',
        runtimeSegmentId
      }
    )
    graph.activities.push({
      id: 'activity-edited',
      kind: 'tool',
      title: 'Edited branch tool',
      status: 'completed',
      sortIndex: 1,
      eventIds: [],
      rawOutput: { value: 'edited evidence' },
      createdAt: 5,
      updatedAt: 5,
      agentFrameId: frame.id,
      messageBranchId: 'edited-branch',
      promptMessageId: 'user-edited',
      runtimeSegmentId
    })
    const session = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Session',
      cwd: '/tmp',
      status: 'idle',
      messages: [oldUser, oldAgent],
      activities: [],
      conversationGraph: graph,
      createdAt: 1,
      updatedAt: 6
    } satisfies PersistedChatSession
    const scope = resolveTurnScope(session, 'agent-edited')

    expect(buildReviewScopeSnapshot(session, scope).map((block) => block.payload)).toEqual([
      { role: 'user', content: 'edited prompt', artifactIds: undefined },
      {
        title: 'Edited branch tool',
        status: 'completed',
        toolKind: undefined,
        rawInput: undefined,
        rawOutput: { value: 'edited evidence' },
        terminalOutput: undefined,
        terminalExitCode: undefined
      },
      { role: 'agent', content: 'edited answer', artifactIds: undefined }
    ])
  })

  it('preserves cited text while stripping secrets, paths and media bytes', () => {
    const session = {
      id: 'session-1',
      projectId: 'project-1',
      messages: [],
      activities: [
        {
          id: 'activity-1',
          title: 'Read result',
          status: 'completed',
          rawInput: {
            path: '/Users/researcher/private/result.csv',
            authorization: 'Bearer secret'
          },
          rawOutput: {
            summary: '42 rows verified',
            image: `data:image/png;base64,${'a'.repeat(2_000)}`
          },
          createdAt: 1,
          updatedAt: 2
        }
      ]
    } as unknown as PersistedChatSession
    const [block] = buildReviewScopeSnapshot(session, {
      turnMessageId: 'message-1',
      artifactVersionIds: [],
      blocks: [
        {
          id: 'activity:activity-1',
          kind: 'activity',
          sourceId: 'activity-1',
          blockIndex: 0,
          contentHash: 'hash-1'
        }
      ]
    })

    expect(block?.payload).toMatchObject({
      rawInput: { path: '[path]', authorization: '[redacted]' },
      rawOutput: { summary: '42 rows verified', image: '[omitted: embedded media]' }
    })
  })

  it('bounds collection payloads exposed to the reviewer and immutable snapshot', () => {
    const session = {
      id: 'session-1',
      projectId: 'project-1',
      messages: [],
      activities: [
        {
          id: 'activity-1',
          title: 'Large result',
          status: 'completed',
          rawOutput: {
            rows: Array.from({ length: 250 }, (_, index) => index),
            ...Object.fromEntries(
              Array.from({ length: 220 }, (_, index) => [`field${index}`, index])
            )
          },
          createdAt: 1,
          updatedAt: 2
        }
      ]
    } as unknown as PersistedChatSession
    const [block] = buildReviewScopeSnapshot(session, {
      turnMessageId: 'message-1',
      artifactVersionIds: [],
      blocks: [
        {
          id: 'activity:activity-1',
          kind: 'activity',
          sourceId: 'activity-1',
          blockIndex: 0,
          contentHash: 'hash-1'
        }
      ]
    })

    const rawOutput = block?.payload.rawOutput as Record<string, unknown>
    expect(rawOutput.rows).toHaveLength(201)
    expect((rawOutput.rows as unknown[]).at(-1)).toBe('[omitted: 50 array entries]')
    expect(rawOutput.__omitted_entries__).toBe(21)
  })
})
