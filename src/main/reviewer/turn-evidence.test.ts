import { describe, expect, it, vi } from 'vitest'

import type { ActivePlanProjection } from '../../shared/session-plan/contract'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { TurnScope } from '../../shared/reviewer'
import { buildReviewScopeSnapshot } from './scope-snapshot'
import { resolveReviewerTurnEvidence } from './turn-evidence'

const plan = (overrides: Partial<ActivePlanProjection> = {}): ActivePlanProjection => ({
  artifactId: 'plan-artifact',
  artifactVersionId: 'plan-version',
  artifactChecksum: 'plan-checksum',
  originatingPromptMessageId: 'user-1',
  revision: 1,
  approval: 'approved',
  lifecycle: 'completed',
  document: {
    schema_version: 1,
    task_summary: 'Produce a report',
    phases: [
      {
        name: 'Delivery',
        delegations: [
          { name: 'Writer', steps: [{ title: 'Write', description: 'Write the report.' }] }
        ]
      }
    ],
    desired_outputs: ['report.csv'],
    feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
  },
  stepStatuses: { Write: { status: 'completed', updatedAt: 3 } },
  stepStates: { Write: { status: 'completed' } },
  counts: { phases: 1, delegations: 1, steps: 1, completed: 1, inProgress: 0 },
  ...overrides
})

const session = (plans: ActivePlanProjection[] = [plan()]): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  cwd: '/tmp',
  status: 'idle',
  planHistoryProjections: plans,
  ...(plans.at(-1)
    ? {
        runtimeContext: {
          version: 1,
          revision: plans.at(-1)!.revision,
          plan: {
            artifactId: plans.at(-1)!.artifactId,
            artifactVersionId: plans.at(-1)!.artifactVersionId,
            artifactChecksum: plans.at(-1)!.artifactChecksum,
            originatingPromptMessageId: plans.at(-1)!.originatingPromptMessageId,
            approval: plans.at(-1)!.approval,
            stepStatuses: plans.at(-1)!.stepStatuses
          }
        }
      }
    : {}),
  messages: [
    {
      id: 'user-1',
      role: 'user',
      content: 'Produce the report.',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'agent-1',
      role: 'agent',
      content: 'Done.',
      status: 'complete',
      eventIds: [],
      artifactIds: ['work-1'],
      createdAt: 3,
      updatedAt: 3
    }
  ],
  activities: [
    {
      id: 'activity-1',
      kind: 'tool',
      title: 'Notebook Run',
      status: 'completed',
      sortIndex: 1,
      eventIds: [],
      rawOutput: { runId: 'run-1' },
      createdAt: 2,
      updatedAt: 2
    }
  ],
  createdAt: 1,
  updatedAt: 3
})

const scope: TurnScope = {
  turnMessageId: 'agent-1',
  artifactVersionIds: ['work-1'],
  blocks: [
    { id: 'message:user-1', kind: 'message', sourceId: 'user-1', blockIndex: 0, contentHash: 'u' },
    {
      id: 'activity:activity-1',
      kind: 'activity',
      sourceId: 'activity-1',
      blockIndex: 1,
      contentHash: 'x'
    },
    {
      id: 'message:agent-1',
      kind: 'message',
      sourceId: 'agent-1',
      blockIndex: 2,
      contentHash: 'a'
    }
  ]
}

describe('Reviewer Turn evidence discovery', () => {
  it('adds the effective approved Plan and trusted block-scoped file descriptors', async () => {
    const resolveFiles = vi.fn().mockResolvedValue([
      {
        versionId: 'work-1',
        role: 'work_product',
        filename: 'report.csv',
        mimeType: 'text/csv',
        sizeBytes: 42,
        checksum: 'work-checksum',
        scopeReason: 'produced-by-turn',
        traceAvailable: true,
        contentStatus: 'available',
        messageId: 'agent-1',
        executionId: 'run-1',
        directlyRead: false
      },
      {
        versionId: 'source-1',
        role: 'source_document',
        filename: 'registered.csv',
        sizeBytes: 10,
        checksum: 'registered-checksum',
        scopeReason: 'artifact-input',
        traceAvailable: true,
        contentStatus: 'available',
        executionId: 'run-1',
        directlyRead: false
      },
      {
        versionId: 'source-1',
        role: 'source_document',
        filename: 'input.csv',
        mimeType: 'text/csv',
        sizeBytes: 20,
        checksum: 'source-checksum',
        scopeReason: 'read-by-turn',
        traceAvailable: true,
        contentStatus: 'available',
        executionId: 'run-1',
        directlyRead: true
      }
    ])

    const evidence = await resolveReviewerTurnEvidence(session(), scope, resolveFiles)
    const blocks = buildReviewScopeSnapshot(session(), scope, evidence)

    expect(blocks).toHaveLength(3)
    expect(blocks[0]?.payload.turnPlan).toMatchObject({
      versionId: 'plan-version',
      status: 'completed',
      binding: 'current-turn'
    })
    expect(blocks[1]?.payload.fileEvidence).toEqual([
      expect.objectContaining({ versionId: 'source-1', role: 'source_document' })
    ])
    expect(blocks[2]?.payload.fileEvidence).toEqual([
      expect.objectContaining({ versionId: 'work-1', role: 'work_product' })
    ])
    expect(evidence.sourceDocumentVersionIds).toEqual(['source-1'])
  })

  it('does not expose pending, replaced, or unrelated Plans as current-Turn requirements', async () => {
    const pending = plan({
      artifactVersionId: 'pending',
      approval: 'pending',
      lifecycle: 'awaiting_approval'
    })
    const unrelated = plan({
      artifactVersionId: 'unrelated',
      originatingPromptMessageId: 'other-user'
    })
    const replaced = plan({ artifactVersionId: 'replaced' })
    const rejectedReplacement = plan({
      artifactVersionId: 'replacement',
      approval: 'rejected',
      lifecycle: 'rejected'
    })

    const withoutApproved = await resolveReviewerTurnEvidence(session([pending, unrelated]), scope)
    const withRejectedReplacement = await resolveReviewerTurnEvidence(
      session([replaced, rejectedReplacement]),
      scope
    )
    expect(withoutApproved).not.toHaveProperty('turnPlan')
    expect(withRejectedReplacement).not.toHaveProperty('turnPlan')
  })

  it('keeps legacy ordered blocks unchanged when additive evidence is unavailable', async () => {
    const evidence = await resolveReviewerTurnEvidence(session([]), scope)
    const blocks = buildReviewScopeSnapshot(session([]), scope, evidence)

    expect(blocks.map(({ payload, ...block }) => ({ ...block, ...payload }))).toEqual([
      expect.objectContaining({ blockIndex: 0, sourceId: 'user-1', role: 'user' }),
      expect.objectContaining({ blockIndex: 1, sourceId: 'activity-1', title: 'Notebook Run' }),
      expect.objectContaining({ blockIndex: 2, sourceId: 'agent-1', role: 'agent' })
    ])
    expect(blocks.every((block) => !('turnPlan' in block.payload))).toBe(true)
    expect(blocks.every((block) => !('fileEvidence' in block.payload))).toBe(true)
  })

  it('exposes routed user requirements and cancellation history to the reviewer', async () => {
    const interrupted = session([])
    interrupted.messages[0].contextWindowSamples = [
      {
        id: 'cancel-1',
        timestamp: 2,
        termination: { kind: 'stop', stopReason: 'cancelled' },
        contextWindow: { used: 10, size: 100 },
        source: 'provider-response'
      },
      {
        id: 'complete-1',
        timestamp: 3,
        termination: { kind: 'stop', stopReason: 'end_turn' },
        contextWindow: { used: 12, size: 100 },
        source: 'provider-response'
      }
    ]
    interrupted.messages.splice(1, 0, {
      id: 'user-intervention',
      role: 'user',
      content: 'Stop generating the CSV; provide a prose summary instead.',
      responseToMessageId: 'user-1',
      status: 'complete',
      eventIds: [],
      createdAt: 2.5,
      updatedAt: 2.5
    })
    const interventionScope: TurnScope = {
      ...scope,
      blocks: [
        scope.blocks[0]!,
        {
          id: 'message:user-intervention',
          kind: 'message',
          sourceId: 'user-intervention',
          blockIndex: 1,
          contentHash: 'i'
        },
        { ...scope.blocks[1]!, blockIndex: 2 },
        { ...scope.blocks[2]!, blockIndex: 3 }
      ]
    }

    const evidence = await resolveReviewerTurnEvidence(interrupted, interventionScope)
    const blocks = buildReviewScopeSnapshot(interrupted, interventionScope, evidence)

    expect(blocks[0]?.payload.turnTerminationHistory).toEqual([
      { kind: 'stop', stopReason: 'cancelled', timestamp: 2 },
      { kind: 'stop', stopReason: 'end_turn', timestamp: 3 }
    ])
    expect(blocks[1]?.payload).toMatchObject({
      role: 'user',
      responseToMessageId: 'user-1',
      content: 'Stop generating the CSV; provide a prose summary instead.'
    })
  })
})
