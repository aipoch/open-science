import { describe, expect, it } from 'vitest'

import type { PersistedChatMessage } from './session-persistence'
import {
  activateConversationBranch,
  createLinearConversationGraph,
  ensureConversationRuntimeSegment,
  forkConversationAfterActivity,
  forkEditedConversationMessage,
  getActiveConversationContext,
  resolveActiveConversationActivities,
  resolveActiveConversationMessages,
  synchronizeActiveConversationActivities,
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

  it('forks a continuation after a retained Message without replacing it', () => {
    const original = synchronizeActiveConversationActivities(
      createLinearConversationGraph({
        sessionId: 'session-1',
        messages: [
          message('u1', 'user', 'original question', 1),
          message('a1', 'agent', 'question preamble', 2),
          message('a2', 'agent', 'answer after the choice', 3)
        ],
        frameworkId: 'claude-code',
        createdAt: 1,
        updatedAt: 3
      }),
      [
        {
          id: 'before-choice',
          kind: 'tool',
          title: 'Inspect context',
          status: 'completed',
          sortIndex: 0,
          eventIds: [],
          promptMessageId: 'u1',
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'old-choice',
          kind: 'tool',
          title: 'Choose a direction',
          status: 'completed',
          sortIndex: 1,
          eventIds: [],
          promptMessageId: 'u1',
          createdAt: 2,
          updatedAt: 2
        }
      ],
      []
    )
    const originalBranchId = original.branches[0].id
    const forked = forkConversationAfterActivity(
      original,
      'a1',
      'old-choice',
      'branch-revised-choice',
      4
    )
    const revised = synchronizeActiveConversationActivities(
      synchronizeActiveConversationMessages(
        forked,
        [
          message('u1', 'user', 'original question', 1),
          message('a1', 'agent', 'question preamble', 2),
          message('a3', 'agent', 'revised answer', 5)
        ],
        5
      ),
      [
        {
          id: 'before-choice',
          kind: 'tool',
          title: 'Inspect context',
          status: 'completed',
          sortIndex: 0,
          eventIds: [],
          promptMessageId: 'u1',
          createdAt: 1,
          updatedAt: 5
        },
        {
          id: 'new-choice',
          kind: 'tool',
          title: 'Choose a direction',
          status: 'completed',
          sortIndex: 2,
          eventIds: [],
          promptMessageId: 'u1',
          createdAt: 5,
          updatedAt: 5
        }
      ],
      []
    )

    expect(resolveActiveConversationMessages(revised).map((node) => node.id)).toEqual([
      'u1',
      'a1',
      'a3'
    ])
    expect(getActiveConversationContext(revised, 'u1').messageBranchAncestry).toEqual([
      originalBranchId,
      'branch-revised-choice'
    ])
    expect(resolveActiveConversationActivities(revised).activities.map((item) => item.id)).toEqual([
      'before-choice',
      'new-choice'
    ])
    const restored = activateConversationBranch(revised, originalBranchId)
    expect(resolveActiveConversationMessages(restored).map((node) => node.id)).toEqual([
      'u1',
      'a1',
      'a2'
    ])
    expect(resolveActiveConversationActivities(restored).activities.map((item) => item.id)).toEqual(
      ['before-choice', 'old-choice']
    )
    expect(revised.activities.find((item) => item.id === 'before-choice')?.messageBranchId).toBe(
      originalBranchId
    )
  })

  it('keeps prompt-bound legacy activities visible after old saves moved them to a child Branch', () => {
    const legacy = synchronizeActiveConversationActivities(
      createLinearConversationGraph({
        sessionId: 'session-legacy',
        messages: [message('u1', 'user', 'question', 1)],
        frameworkId: 'claude-code',
        createdAt: 1,
        updatedAt: 1
      }),
      [
        {
          id: 'shared-legacy-activity',
          kind: 'tool',
          title: 'Shared activity',
          status: 'completed',
          sortIndex: 1,
          eventIds: [],
          promptMessageId: 'u1',
          createdAt: 1,
          updatedAt: 1
        }
      ],
      []
    )
    const parentBranchId = legacy.branches[0].id
    legacy.branches.push({
      id: 'legacy-child',
      agentFrameId: legacy.rootFrameId,
      parentBranchId,
      forkMessageId: 'u1',
      headMessageId: 'u1',
      createdAt: 2,
      updatedAt: 2
    })
    legacy.frames[0].activeBranchId = 'legacy-child'
    legacy.activities[0].messageBranchId = 'legacy-child'

    expect(resolveActiveConversationActivities(legacy).activities.map((item) => item.id)).toEqual([
      'shared-legacy-activity'
    ])
    expect(
      resolveActiveConversationActivities(
        activateConversationBranch(legacy, parentBranchId)
      ).activities.map((item) => item.id)
    ).toEqual(['shared-legacy-activity'])
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

  it('keeps a resumed Agent response on its Prompt Runtime Segment', () => {
    const prompt = message('u1', 'user', 'create a file', 1)
    const resumed = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [prompt],
      frameworkId: 'codex',
      backendId: 'codex-subscription',
      model: 'gpt-5.5',
      createdAt: 1,
      updatedAt: 1
    })
    const runtimeChangedBeforeResponse = ensureConversationRuntimeSegment(resumed, {
      id: 'runtime-later',
      frameworkId: 'codex',
      backendId: 'codex-subscription',
      startedAt: 2
    })
    const response = {
      ...message('a1', 'agent', 'done', 3),
      responseToMessageId: prompt.id
    }
    expect(getActiveConversationContext(runtimeChangedBeforeResponse, prompt.id)).toMatchObject({
      runtimeSegmentId: resumed.runtimeSegments[0].id
    })
    const completed = synchronizeActiveConversationMessages(
      runtimeChangedBeforeResponse,
      [prompt, response],
      3
    )

    expect(completed.messages.find(({ id }) => id === response.id)?.runtimeSegmentId).toBe(
      completed.messages.find(({ id }) => id === prompt.id)?.runtimeSegmentId
    )
  })

  it('attributes a fresh-context continuation response to an explicitly forced Runtime Segment', () => {
    const prompt = message('u1', 'user', 'continue this task', 1)
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [prompt],
      frameworkId: 'codex',
      backendId: 'codex-subscription',
      model: 'gpt-5.5',
      createdAt: 1,
      updatedAt: 1
    })
    const resumed = ensureConversationRuntimeSegment(graph, {
      id: 'runtime-resumed',
      frameworkId: 'codex',
      backendId: 'codex-subscription',
      model: 'gpt-5.5',
      startedAt: 2,
      forceNew: true
    })
    const response = {
      ...message('a1', 'agent', 'continued', 3),
      responseToMessageId: prompt.id
    }
    const completed = synchronizeActiveConversationMessages(
      resumed,
      [prompt, response],
      3,
      'runtime-resumed'
    )

    expect(completed.runtimeSegments).toHaveLength(2)
    expect(completed.messages.find(({ id }) => id === prompt.id)?.runtimeSegmentId).not.toBe(
      'runtime-resumed'
    )
    expect(completed.messages.find(({ id }) => id === response.id)?.runtimeSegmentId).toBe(
      'runtime-resumed'
    )

    const withPriorActivity = synchronizeActiveConversationActivities(
      completed,
      [
        {
          id: 'activity-prior',
          kind: 'tool',
          title: 'Initial analysis',
          promptMessageId: prompt.id,
          status: 'completed',
          sortIndex: 0,
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      []
    )

    const withActivity = synchronizeActiveConversationActivities(
      withPriorActivity,
      [
        {
          id: 'activity-prior',
          kind: 'tool',
          title: 'Initial analysis',
          promptMessageId: prompt.id,
          status: 'completed',
          sortIndex: 0,
          eventIds: [],
          createdAt: 1,
          updatedAt: 3
        },
        {
          id: 'activity-1',
          kind: 'tool',
          title: 'Continue analysis',
          promptMessageId: prompt.id,
          status: 'completed',
          sortIndex: 0,
          eventIds: [],
          createdAt: 3,
          updatedAt: 3
        }
      ],
      [],
      'runtime-resumed'
    )
    expect(withActivity.activities.find(({ id }) => id === 'activity-1')).toMatchObject({
      promptMessageId: prompt.id,
      runtimeSegmentId: 'runtime-resumed'
    })
    expect(
      withActivity.activities.find(({ id }) => id === 'activity-prior')?.runtimeSegmentId
    ).not.toBe('runtime-resumed')
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
