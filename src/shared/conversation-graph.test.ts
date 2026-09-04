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
  synchronizeActiveConversationMessages,
  validateConversationGraph
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

const graphWithActivityGroup = (): ReturnType<typeof synchronizeActiveConversationActivities> =>
  synchronizeActiveConversationActivities(
    createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [message('u1', 'user', 'question', 1)],
      frameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 1
    }),
    [
      {
        id: 'activity-1',
        kind: 'tool',
        title: 'Inspect context',
        activityGroupId: 'group-1',
        promptMessageId: 'u1',
        status: 'completed',
        sortIndex: 1,
        eventIds: [],
        createdAt: 2,
        updatedAt: 2
      }
    ],
    [
      {
        id: 'group-1',
        title: 'Inspection',
        sortIndex: 1,
        activityIds: ['activity-1'],
        promptMessageId: 'u1',
        createdAt: 2,
        updatedAt: 2,
        completedAt: 2
      }
    ]
  )

const graphWithChildFrame = (): ReturnType<typeof createLinearConversationGraph> => {
  const graph = createLinearConversationGraph({
    sessionId: 'session-1',
    messages: [message('u1', 'user', 'question', 1), message('a1', 'agent', 'answer', 2)],
    frameworkId: 'claude-code',
    createdAt: 1,
    updatedAt: 2
  })
  graph.frames.push({
    id: 'child-frame',
    parentFrameId: graph.rootFrameId,
    originMessageId: 'u1',
    originBindingState: 'validated',
    kind: 'delegate',
    status: 'completed',
    activeBranchId: 'child-branch',
    createdAt: 3,
    completedAt: 4
  })
  graph.branches.push({
    id: 'child-branch',
    agentFrameId: 'child-frame',
    headMessageId: 'child-u1',
    createdAt: 3,
    updatedAt: 4
  })
  graph.messages.push({
    ...message('child-u1', 'user', 'delegated question', 3),
    agentFrameId: 'child-frame',
    introducedOnBranchId: 'child-branch',
    revisionRootMessageId: 'child-u1'
  })
  return graph
}

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

  it('rejects a Branch path containing a Message introduced on a sibling Branch', () => {
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [
        message('u1', 'user', 'original question', 1),
        message('a1', 'agent', 'original answer', 2)
      ],
      frameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 2
    })
    const originalBranchId = graph.branches[0].id
    const firstSibling = synchronizeActiveConversationMessages(
      forkEditedConversationMessage(graph, 'u1', 'branch-a', 3),
      [
        message('u2', 'user', 'first revision', 3),
        message('a2', 'agent', 'first revised answer', 4)
      ],
      4
    )
    const secondSibling = synchronizeActiveConversationMessages(
      forkEditedConversationMessage(
        activateConversationBranch(firstSibling, originalBranchId),
        'u1',
        'branch-b',
        5
      ),
      [
        message('u3', 'user', 'second revision', 5),
        message('a3', 'agent', 'second revised answer', 6)
      ],
      6
    )
    const crossWired = structuredClone(secondSibling)
    crossWired.branches.find(({ id }) => id === 'branch-b')!.headMessageId = 'a2'

    expect(() => validateConversationGraph(crossWired)).toThrow(
      /Message introduction Branch is not on the containing Branch path/
    )
  })

  it('rejects an unreachable Message cycle', () => {
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [message('u1', 'user', 'question', 1)],
      frameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 1
    })
    const { agentFrameId, introducedOnBranchId, runtimeSegmentId } = graph.messages[0]
    graph.messages.push(
      {
        ...message('orphan-1', 'agent', 'orphan one', 2),
        agentFrameId,
        introducedOnBranchId,
        parentMessageId: 'orphan-2',
        runtimeSegmentId
      },
      {
        ...message('orphan-2', 'agent', 'orphan two', 3),
        agentFrameId,
        introducedOnBranchId,
        parentMessageId: 'orphan-1',
        runtimeSegmentId
      }
    )

    expect(() => validateConversationGraph(graph)).toThrow(
      /Conversation message graph contains a cycle/
    )
  })

  it('rejects an acyclic Message that is unreachable from every Branch head', () => {
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [message('u1', 'user', 'question', 1)],
      frameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 1
    })
    const { agentFrameId, introducedOnBranchId, runtimeSegmentId } = graph.messages[0]
    graph.messages.push({
      ...message('orphan', 'agent', 'orphan', 2),
      agentFrameId,
      introducedOnBranchId,
      runtimeSegmentId
    })

    expect(() => validateConversationGraph(graph)).toThrow(
      /Conversation Message is not reachable from any Branch/
    )
  })

  it('rejects duplicate Activity Group ids', () => {
    const graph = graphWithActivityGroup()
    graph.activityGroups.push(structuredClone(graph.activityGroups[0]))

    expect(() => validateConversationGraph(graph)).toThrow(
      /Conversation graph contains duplicate Activity Group ids/
    )
  })

  it.each([
    {
      relationship: 'Activity Frame',
      mutate: (graph) => {
        graph.activities[0].agentFrameId = 'missing-frame'
      },
      error: /Activity Branch is invalid/
    },
    {
      relationship: 'Activity Branch',
      mutate: (graph) => {
        graph.activities[0].messageBranchId = 'missing-branch'
      },
      error: /Activity Branch is invalid/
    },
    {
      relationship: 'Activity Prompt',
      mutate: (graph) => {
        graph.activities[0].promptMessageId = 'missing-prompt'
      },
      error: /Activity Prompt Message is invalid/
    },
    {
      relationship: 'Activity Runtime Segment',
      mutate: (graph) => {
        graph.activities[0].runtimeSegmentId = 'missing-runtime'
      },
      error: /Activity Runtime Segment is invalid/
    },
    {
      relationship: 'Activity Group reference',
      mutate: (graph) => {
        graph.activities[0].activityGroupId = 'missing-group'
      },
      error: /Activity Group membership is invalid/
    },
    {
      relationship: 'Activity Group Frame',
      mutate: (graph) => {
        graph.activityGroups[0].agentFrameId = 'missing-frame'
      },
      error: /Activity Group Branch is invalid/
    },
    {
      relationship: 'Activity Group Branch',
      mutate: (graph) => {
        graph.activityGroups[0].messageBranchId = 'missing-branch'
      },
      error: /Activity Group Branch is invalid/
    },
    {
      relationship: 'Activity Group Prompt',
      mutate: (graph) => {
        graph.activityGroups[0].promptMessageId = 'missing-prompt'
      },
      error: /Activity Group Prompt Message is invalid/
    },
    {
      relationship: 'Activity Group member',
      mutate: (graph) => {
        graph.activityGroups[0].activityIds = ['missing-activity']
      },
      error: /Activity Group member is invalid/
    },
    {
      relationship: 'Activity-to-Group reciprocity',
      mutate: (graph) => {
        graph.activityGroups[0].activityIds = []
      },
      error: /Activity Group membership is invalid/
    },
    {
      relationship: 'Group-to-Activity reciprocity',
      mutate: (graph) => {
        delete graph.activities[0].activityGroupId
      },
      error: /Activity Group member is invalid/
    }
  ] satisfies Array<{
    relationship: string
    mutate: (graph: ReturnType<typeof graphWithActivityGroup>) => void
    error: RegExp
  }>)('rejects an invalid $relationship relationship', ({ mutate, error }) => {
    const graph = graphWithActivityGroup()
    mutate(graph)

    expect(() => validateConversationGraph(graph)).toThrow(error)
  })

  it.each([
    {
      invariant: 'kind',
      mutate: (graph: ReturnType<typeof graphWithActivityGroup>) => {
        graph.frames[0].kind = 'delegate'
      }
    },
    {
      invariant: 'origin binding state',
      mutate: (graph: ReturnType<typeof graphWithActivityGroup>) => {
        graph.frames[0].originBindingState = 'validated'
      }
    },
    {
      invariant: 'origin Message',
      mutate: (graph: ReturnType<typeof graphWithActivityGroup>) => {
        graph.frames[0].originMessageId = 'u1'
      }
    },
    {
      invariant: 'parent Frame',
      mutate: (graph: ReturnType<typeof graphWithActivityGroup>) => {
        graph.frames[0].parentFrameId = 'missing-frame'
      }
    }
  ])('rejects an invalid root Frame $invariant', ({ mutate }) => {
    const graph = graphWithActivityGroup()
    mutate(graph)

    expect(() => validateConversationGraph(graph)).toThrow(/Conversation root Frame is invalid/)
  })

  it('rejects root-only state on a child Agent Frame', () => {
    const graph = graphWithActivityGroup()
    graph.branches.push({
      id: 'child-branch',
      agentFrameId: 'child-frame',
      createdAt: 3,
      updatedAt: 3
    })
    graph.frames.push({
      id: 'child-frame',
      parentFrameId: graph.rootFrameId,
      originMessageId: 'u1',
      originBindingState: 'root',
      kind: 'root',
      status: 'completed',
      activeBranchId: 'child-branch',
      createdAt: 3,
      completedAt: 3
    })

    expect(() => validateConversationGraph(graph)).toThrow(/Non-root Agent Frame is invalid/)
  })

  it.each([
    {
      relationship: 'validated Frame without an origin Message',
      mutate: (graph: ReturnType<typeof graphWithChildFrame>) => {
        delete graph.frames[1].originMessageId
      }
    },
    {
      relationship: 'validated Frame origin outside its parent Frame',
      mutate: (graph: ReturnType<typeof graphWithChildFrame>) => {
        graph.frames[1].originMessageId = 'child-u1'
      }
    },
    {
      relationship: 'legacy-unavailable Frame carrying an origin Message',
      mutate: (graph: ReturnType<typeof graphWithChildFrame>) => {
        graph.frames[1].originBindingState = 'legacy-unavailable'
      }
    }
  ])('rejects a $relationship', ({ mutate }) => {
    const graph = graphWithChildFrame()
    mutate(graph)

    expect(() => validateConversationGraph(graph)).toThrow(/Agent Frame origin Message is invalid/)
  })

  it('rejects an active child Frame whose origin is hidden on its parent current Branch', () => {
    const graph = graphWithChildFrame()
    const originalBranchId = graph.branches[0].id
    graph.activeFrameId = graph.rootFrameId
    const edited = synchronizeActiveConversationMessages(
      forkEditedConversationMessage(graph, 'u1', 'branch-edited', 5),
      [message('u2', 'user', 'revision', 5), message('a2', 'agent', 'new answer', 6)],
      6
    )
    expect(() => validateConversationGraph(edited)).not.toThrow()
    edited.activeFrameId = 'child-frame'

    expect(edited.frames[0].activeBranchId).not.toBe(originalBranchId)
    expect(() => validateConversationGraph(edited)).toThrow(
      /Active Agent Frame origin is not on its parent current Branch/
    )
  })

  it('rejects responseToMessageId outside the response Message path', () => {
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [message('u1', 'user', 'question', 1), message('a1', 'agent', 'answer', 2)],
      frameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 2
    })
    const edited = synchronizeActiveConversationMessages(
      forkEditedConversationMessage(graph, 'u1', 'branch-edited', 3),
      [
        message('u2', 'user', 'edited question', 3),
        { ...message('a2', 'agent', 'edited answer', 4), responseToMessageId: 'u2' }
      ],
      4
    )
    edited.messages.find(({ id }) => id === 'a2')!.responseToMessageId = 'u1'

    expect(() => validateConversationGraph(edited)).toThrow(/Message response target is invalid/)
  })

  it('accepts routed user Messages linked to an earlier user or Agent Message on the same path', () => {
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [
        message('u1', 'user', 'question', 1),
        { ...message('a1', 'agent', 'choose an option', 2), responseToMessageId: 'u1' },
        { ...message('u2', 'user', 'option one', 3), responseToMessageId: 'a1' },
        { ...message('u3', 'user', 'additional context', 4), responseToMessageId: 'u1' }
      ],
      frameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 4
    })

    expect(() => validateConversationGraph(graph)).not.toThrow()
  })

  it('rejects an Agent response linked to another Agent Message', () => {
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [
        message('u1', 'user', 'question', 1),
        { ...message('a1', 'agent', 'first part', 2), responseToMessageId: 'u1' },
        { ...message('a2', 'agent', 'second part', 3), responseToMessageId: 'a1' }
      ],
      frameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 3
    })

    expect(() => validateConversationGraph(graph)).toThrow(/Message response target is invalid/)
  })

  it('rejects revisionRootMessageId that does not identify a user Message', () => {
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [message('u1', 'user', 'question', 1), message('a1', 'agent', 'answer', 2)],
      frameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 2
    })
    graph.messages[0].revisionRootMessageId = 'a1'

    expect(() => validateConversationGraph(graph)).toThrow(/Message revision root is invalid/)
  })

  it('rejects an unrelated same-Frame revision root for an ordinary user Message', () => {
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [
        message('u1', 'user', 'first question', 1),
        message('a1', 'agent', 'first answer', 2),
        message('u2', 'user', 'second question', 3)
      ],
      frameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 3
    })
    graph.messages.find(({ id }) => id === 'u2')!.revisionRootMessageId = 'u1'

    expect(() => validateConversationGraph(graph)).toThrow(/Message revision root is invalid/)
  })

  it('rejects Branch and Message revision links from different chains', () => {
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [
        message('u1', 'user', 'first question', 1),
        message('a1', 'agent', 'first answer', 2),
        message('u2', 'user', 'second question', 3),
        message('a2', 'agent', 'second answer', 4)
      ],
      frameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 4
    })
    const edited = synchronizeActiveConversationMessages(
      forkEditedConversationMessage(graph, 'u2', 'branch-edited', 5),
      [message('u3', 'user', 'edited second question', 5)],
      5
    )
    edited.branches.find(({ id }) => id === 'branch-edited')!.supersededMessageId = 'u1'

    expect(() => validateConversationGraph(edited)).toThrow(/Message revision chain is invalid/)
  })

  it('rejects an Activity fork that is not on the Branch path', () => {
    const graph = synchronizeActiveConversationActivities(
      createLinearConversationGraph({
        sessionId: 'session-1',
        messages: [
          message('u1', 'user', 'first question', 1),
          message('a1', 'agent', 'first answer', 2),
          message('u2', 'user', 'second question', 3),
          message('a2', 'agent', 'second answer', 4)
        ],
        frameworkId: 'claude-code',
        createdAt: 1,
        updatedAt: 4
      }),
      [
        {
          id: 'activity-1',
          kind: 'tool',
          title: 'First activity',
          promptMessageId: 'u1',
          status: 'completed',
          sortIndex: 1,
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'activity-2',
          kind: 'tool',
          title: 'Later activity',
          promptMessageId: 'u2',
          status: 'completed',
          sortIndex: 2,
          eventIds: [],
          createdAt: 4,
          updatedAt: 4
        }
      ],
      []
    )
    const forked = forkConversationAfterActivity(graph, 'a1', 'activity-1', 'branch-revised', 5)
    forked.branches.find(({ id }) => id === 'branch-revised')!.forkActivityId = 'activity-2'

    expect(() => validateConversationGraph(forked)).toThrow(
      /Message Branch Activity fork is not on its path/
    )
  })

  it('rejects a Message fork introduced on the child Branch', () => {
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [
        message('u1', 'user', 'original question', 1),
        message('a1', 'agent', 'original answer', 2)
      ],
      frameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 2
    })
    const forked = synchronizeActiveConversationMessages(
      forkEditedConversationMessage(graph, 'u1', 'branch-edited', 3),
      [message('u2', 'user', 'edited question', 3), message('a2', 'agent', 'edited answer', 4)],
      4
    )
    forked.branches.find(({ id }) => id === 'branch-edited')!.forkMessageId = 'u2'

    expect(() => validateConversationGraph(forked)).toThrow(
      /Message Branch fork is not on its parent path/
    )
  })

  it('rejects an Activity fork introduced on the child Branch', () => {
    const graph = synchronizeActiveConversationActivities(
      createLinearConversationGraph({
        sessionId: 'session-1',
        messages: [
          message('u1', 'user', 'original question', 1),
          message('a1', 'agent', 'original answer', 2)
        ],
        frameworkId: 'claude-code',
        createdAt: 1,
        updatedAt: 2
      }),
      [
        {
          id: 'activity-1',
          kind: 'tool',
          title: 'Original activity',
          promptMessageId: 'u1',
          status: 'completed',
          sortIndex: 1,
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ],
      []
    )
    const forked = synchronizeActiveConversationActivities(
      forkConversationAfterActivity(graph, 'a1', 'activity-1', 'branch-revised', 3),
      [
        {
          id: 'activity-2',
          kind: 'tool',
          title: 'Child activity',
          promptMessageId: 'u1',
          status: 'completed',
          sortIndex: 2,
          eventIds: [],
          createdAt: 3,
          updatedAt: 3
        }
      ],
      []
    )
    forked.branches.find(({ id }) => id === 'branch-revised')!.forkActivityId = 'activity-2'

    expect(() => validateConversationGraph(forked)).toThrow(
      /Message Branch Activity fork is not on its parent path/
    )
  })

  it('rejects fork markers on a root Branch', () => {
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [message('u1', 'user', 'question', 1)],
      frameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: 1
    })
    graph.branches[0].forkMessageId = 'u1'

    expect(() => validateConversationGraph(graph)).toThrow(
      /Message Branch fork requires a parent Branch/
    )
  })

  it('keeps graph validation within a linear id-read budget', () => {
    const messageCount = 200
    const branchCount = 200
    const graph = createLinearConversationGraph({
      sessionId: 'session-scale',
      messages: Array.from({ length: messageCount }, (_, index) =>
        message(`message-${index}`, index === 0 ? 'user' : 'agent', `message ${index}`, index + 1)
      ),
      frameworkId: 'claude-code',
      createdAt: 1,
      updatedAt: messageCount
    })
    const rootBranch = graph.branches[0]
    let parentBranch = rootBranch
    for (let index = 1; index < branchCount; index += 1) {
      const branch = {
        id: `branch-${index}`,
        agentFrameId: graph.rootFrameId,
        parentBranchId: parentBranch.id,
        forkMessageId: rootBranch.headMessageId,
        headMessageId: rootBranch.headMessageId,
        createdAt: messageCount + index,
        updatedAt: messageCount + index
      }
      graph.branches.push(branch)
      parentBranch = branch
    }
    const frameCount = 200
    let parentFrameId = graph.rootFrameId
    for (let index = 1; index < frameCount; index += 1) {
      const frameId = `frame-${index}`
      const branchId = `frame-branch-${index}`
      graph.branches.push({
        id: branchId,
        agentFrameId: frameId,
        createdAt: messageCount + branchCount + index,
        updatedAt: messageCount + branchCount + index
      })
      graph.frames.push({
        id: frameId,
        parentFrameId,
        originBindingState: 'legacy-unavailable',
        kind: 'compatibility',
        status: 'completed',
        activeBranchId: branchId,
        createdAt: messageCount + branchCount + index,
        completedAt: messageCount + branchCount + index
      })
      parentFrameId = frameId
    }
    let idReads = 0
    for (const item of [...graph.messages, ...graph.branches, ...graph.frames]) {
      const id = item.id
      Object.defineProperty(item, 'id', {
        enumerable: true,
        get: () => {
          idReads += 1
          return id
        }
      })
    }

    validateConversationGraph(graph)

    expect(idReads).toBeLessThan(
      (graph.messages.length + graph.branches.length + graph.frames.length) * 20
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
