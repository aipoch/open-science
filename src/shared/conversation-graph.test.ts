import { describe, expect, it } from 'vitest'

import type { PersistedChatMessage } from './session-persistence'
import {
  activateConversationBranch,
  createLinearConversationGraph,
  ensureConversationRuntimeSegment,
  forkEditedConversationMessage,
  getActiveConversationContext,
  resolveActiveConversationMessages,
  synchronizeActiveConversationMessages
} from './conversation-graph'

const message = (
  id: string,
  role: PersistedChatMessage['role'],
  content: string,
  at: number
): PersistedChatMessage => ({
  id,
  role,
  content,
  status: 'complete',
  eventIds: [],
  createdAt: at,
  updatedAt: at
})

describe('conversation graph', () => {
  it('forks an edited user Message without deleting the original downstream path', () => {
    const originalMessages = [
      message('u1', 'user', 'original question', 1),
      message('a1', 'agent', 'original answer', 2)
    ]
    const original = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: originalMessages,
      frameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 2
    })
    const originalBranchId = original.branches[0].id
    const forked = forkEditedConversationMessage(original, 'u1', 'branch-edited', 3)
    const edited = synchronizeActiveConversationMessages(
      forked,
      [message('u2', 'user', 'edited question', 3), message('a2', 'agent', 'edited answer', 4)],
      4
    )

    expect(resolveActiveConversationMessages(edited).map((node) => node.id)).toEqual(['u2', 'a2'])
    expect(edited.messages.find((node) => node.id === 'u2')).toMatchObject({
      revisionRootMessageId: 'u1',
      supersedesMessageId: 'u1',
      introducedOnBranchId: 'branch-edited'
    })
    expect(getActiveConversationContext(edited, 'u2').messageBranchAncestry).toEqual([
      originalBranchId,
      'branch-edited'
    ])
    expect(getActiveConversationContext(edited, 'u2').messageAncestry).toEqual(['u2', 'a2'])

    const restored = activateConversationBranch(edited, originalBranchId)
    expect(resolveActiveConversationMessages(restored).map((node) => node.id)).toEqual(['u1', 'a1'])
    expect(restored.messages.map((node) => node.id).sort()).toEqual(['a1', 'a2', 'u1', 'u2'])
  })

  it('starts a new Runtime Segment on framework changes without forking Messages', () => {
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [message('u1', 'user', 'question', 1)],
      frameworkId: 'claude-code',
      backendId: 'claude-profile',
      createdAt: 1,
      updatedAt: 1
    })
    const switched = ensureConversationRuntimeSegment(graph, {
      id: 'runtime-codex',
      frameworkId: 'codex',
      backendId: 'codex-profile',
      model: 'gpt-5',
      startedAt: 2
    })

    expect(switched.branches).toHaveLength(1)
    expect(switched.runtimeSegments).toHaveLength(2)
    expect(switched.runtimeSegments[0].endedAt).toBe(2)
    expect(getActiveConversationContext(switched, 'u2')).toMatchObject({
      promptMessageId: 'u2',
      messageBranchId: graph.branches[0].id,
      runtimeSegmentId: 'runtime-codex'
    })
  })

  it('keeps graph-owned history when a stale flat projection is shorter or older', () => {
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [
        message('u1', 'user', 'canonical question', 10),
        message('a1', 'agent', 'canonical answer', 20)
      ],
      frameworkId: 'claude-code',
      createdAt: 10,
      updatedAt: 20
    })
    const stale = synchronizeActiveConversationMessages(
      graph,
      [message('u1', 'user', 'stale question', 1)],
      21
    )

    expect(
      resolveActiveConversationMessages(stale).map(({ id, content }) => ({ id, content }))
    ).toEqual([
      { id: 'u1', content: 'canonical question' },
      { id: 'a1', content: 'canonical answer' }
    ])
    expect(stale.branches[0].headMessageId).toBe('a1')
  })

  it('rejects Branch cycles and cross-Frame Runtime Segment attribution', () => {
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [message('u1', 'user', 'question', 1)],
      frameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 1
    })
    const branchCycle = structuredClone(graph)
    branchCycle.branches[0].parentBranchId = branchCycle.branches[0].id
    expect(() => activateConversationBranch(branchCycle, branchCycle.branches[0].id)).toThrow(
      /Branch graph contains a cycle/
    )

    const invalidSegment = structuredClone(graph)
    invalidSegment.messages[0].runtimeSegmentId = 'missing-runtime-segment'
    expect(() => activateConversationBranch(invalidSegment, invalidSegment.branches[0].id)).toThrow(
      /Message Runtime Segment is invalid/
    )
  })

  it('selects the nearest visible ancestor when a Branch switch hides the active child Frame', () => {
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [message('u1', 'user', 'original', 1), message('a1', 'agent', 'answer', 2)],
      frameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 2
    })
    const originalBranchId = graph.branches[0].id
    const forked = forkEditedConversationMessage(graph, 'u1', 'branch-edited', 3)
    const edited = synchronizeActiveConversationMessages(
      forked,
      [message('u2', 'user', 'revision', 3), message('a2', 'agent', 'new answer', 4)],
      4
    )
    edited.branches.push({
      id: 'reviewer-branch',
      agentFrameId: 'reviewer-frame',
      createdAt: 5,
      updatedAt: 5
    })
    edited.frames.push({
      id: 'reviewer-frame',
      parentFrameId: edited.rootFrameId,
      originMessageId: 'a1',
      originBindingState: 'validated',
      kind: 'reviewer',
      status: 'completed',
      activeBranchId: 'reviewer-branch',
      createdAt: 5
    })
    edited.activeFrameId = 'reviewer-frame'

    const hidden = activateConversationBranch(edited, 'branch-edited')
    expect(hidden.activeFrameId).toBe(hidden.rootFrameId)

    const visibleAgain = activateConversationBranch(hidden, originalBranchId)
    expect(visibleAgain.activeFrameId).toBe(hidden.rootFrameId)
  })
})
