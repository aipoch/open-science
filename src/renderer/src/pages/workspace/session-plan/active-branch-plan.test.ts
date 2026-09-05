import { describe, expect, it } from 'vitest'

import type { ChatSession } from '@/stores/session-store'
import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'
import {
  activateConversationBranch,
  createLinearConversationGraph,
  forkEditedConversationMessage,
  projectConversationMessage,
  resolveActiveConversationMessages,
  synchronizeActiveConversationMessages
} from '../../../../../shared/conversation-graph'

import { selectActiveBranchPlan } from './active-branch-plan'

const projection = (
  artifactVersionId: string,
  originatingPromptMessageId?: string
): ActivePlanProjection => ({
  artifactId: `artifact-${artifactVersionId}`,
  artifactVersionId,
  artifactChecksum: 'a'.repeat(64),
  ...(originatingPromptMessageId ? { originatingPromptMessageId } : {}),
  revision: 1,
  approval: 'approved',
  lifecycle: 'approved',
  document: {
    schema_version: 1,
    task_summary: artifactVersionId,
    phases: [
      {
        name: 'Phase',
        delegations: [
          {
            name: 'Main',
            steps: [{ title: `Step ${artifactVersionId}`, description: 'Execute the plan.' }]
          }
        ]
      }
    ],
    desired_outputs: [],
    feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
  },
  stepStatuses: {},
  stepStates: { [`Step ${artifactVersionId}`]: { status: 'not_started' } },
  counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
})

const session = (
  visiblePromptMessageIds: string[],
  activePlanProjection: ActivePlanProjection,
  planHistoryProjections: ActivePlanProjection[] = []
): ChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  cwd: '/workspace',
  status: 'idle',
  messages: visiblePromptMessageIds.map((id, index) => ({
    id,
    role: 'user',
    content: id,
    status: 'complete',
    eventIds: [],
    createdAt: index + 1,
    updatedAt: index + 1
  })),
  activePlanProjection,
  planHistoryProjections,
  createdAt: 1,
  updatedAt: 1
})

describe('active Message Branch Plan selection', () => {
  it('selects the authoritative Plan only when its originating Message is visible', () => {
    const planA = projection('plan-a', 'prompt-a')
    const planB = projection('plan-b', 'prompt-b')

    expect(selectActiveBranchPlan(session(['prompt-a'], planB, [planA]))).toBeUndefined()
    expect(selectActiveBranchPlan(session(['prompt-b'], planB, [planA]))).toBe(planB)
  })

  it('returns no Plan entrance when the active path contains no Plan-generating Message', () => {
    const planA = projection('plan-a', 'prompt-a')
    const planB = projection('plan-b', 'prompt-b')

    expect(selectActiveBranchPlan(session(['prompt-c'], planB, [planA]))).toBeUndefined()
  })

  it('never exposes a legacy Plan without an originating Message as actionable', () => {
    const legacy = projection('legacy')

    expect(selectActiveBranchPlan(session(['prompt-a'], legacy))).toBeUndefined()
  })

  it('follows the active conversationGraph Branch and never exposes an unbound legacy Plan', () => {
    const message = (
      id: string,
      content: string,
      createdAt: number
    ): ChatSession['messages'][number] => ({
      id,
      role: 'user' as const,
      content,
      status: 'complete' as const,
      eventIds: [],
      createdAt,
      updatedAt: createdAt
    })
    const originalGraph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [message('prompt-a', 'Plan branch A', 1)],
      createdAt: 1,
      updatedAt: 1
    })
    const originalBranchId = originalGraph.branches[0].id
    const forked = forkEditedConversationMessage(originalGraph, 'prompt-a', 'branch-b', 2)
    const branchBGraph = synchronizeActiveConversationMessages(
      forked,
      [message('prompt-b', 'Plan branch B', 2)],
      2
    )
    const planA = projection('plan-a', 'prompt-a')
    const planB = projection('plan-b', 'prompt-b')
    const projectSession = (conversationGraph: typeof branchBGraph): ChatSession => ({
      ...session([], planB, [planA]),
      conversationGraph,
      messages: resolveActiveConversationMessages(conversationGraph).map(projectConversationMessage)
    })

    expect(selectActiveBranchPlan(projectSession(branchBGraph))).toBe(planB)

    const branchAGraph = activateConversationBranch(branchBGraph, originalBranchId)
    expect(selectActiveBranchPlan(projectSession(branchAGraph))).toBeUndefined()

    expect(
      selectActiveBranchPlan({
        ...projectSession(branchAGraph),
        activePlanProjection: projection('legacy'),
        planHistoryProjections: undefined
      })
    ).toBeUndefined()
  })
})
