import { describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ReviewWithChecks } from '../../shared/reviewer'
import { createDelegatedReviewEvidence } from './delegated-review-evidence'

const session = (): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Delegated review',
  cwd: '/tmp/project',
  status: 'idle',
  messages: [],
  activities: [],
  artifacts: [],
  createdAt: 1,
  updatedAt: 9,
  conversationGraph: {
    schemaVersion: 1,
    rootFrameId: 'root-frame',
    activeFrameId: 'child-frame',
    frames: [
      {
        id: 'root-frame',
        originBindingState: 'root',
        kind: 'root',
        status: 'completed',
        activeBranchId: 'root-branch',
        createdAt: 1,
        completedAt: 9
      },
      {
        id: 'child-frame',
        parentFrameId: 'root-frame',
        originMessageId: 'root-user',
        originBindingState: 'validated',
        kind: 'delegate',
        status: 'completed',
        activeBranchId: 'child-branch',
        createdAt: 2,
        completedAt: 8
      }
    ],
    branches: [
      {
        id: 'root-branch',
        agentFrameId: 'root-frame',
        headMessageId: 'root-user',
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'child-branch',
        agentFrameId: 'child-frame',
        headMessageId: 'child-terminal',
        createdAt: 2,
        updatedAt: 8
      }
    ],
    messages: [
      {
        id: 'root-user',
        role: 'user',
        content: 'delegate this',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1,
        agentFrameId: 'root-frame',
        introducedOnBranchId: 'root-branch',
        revisionRootMessageId: 'root-user',
        runtimeSegmentId: 'root-runtime'
      },
      {
        id: 'child-user',
        role: 'user',
        content: 'produce evidence',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2,
        agentFrameId: 'child-frame',
        introducedOnBranchId: 'child-branch',
        revisionRootMessageId: 'child-user',
        runtimeSegmentId: 'child-runtime'
      },
      {
        id: 'child-terminal',
        role: 'agent',
        content: 'evidence complete',
        status: 'complete',
        eventIds: [],
        artifactIds: ['version-1'],
        createdAt: 8,
        completedAt: 8,
        updatedAt: 8,
        agentFrameId: 'child-frame',
        introducedOnBranchId: 'child-branch',
        parentMessageId: 'child-user',
        runtimeSegmentId: 'child-runtime'
      }
    ],
    activities: [],
    activityGroups: [],
    runtimeSegments: [
      {
        id: 'root-runtime',
        agentFrameId: 'root-frame',
        frameworkId: 'claude-code',
        startedAt: 1,
        endedAt: 2
      },
      {
        id: 'child-runtime',
        agentFrameId: 'child-frame',
        frameworkId: 'claude-code',
        startedAt: 2,
        endedAt: 8
      }
    ]
  },
  runtimeContext: {
    version: 1,
    revision: 3,
    delegatedWork: {
      records: [
        {
          agentFrameId: 'child-frame',
          attempts: [
            {
              id: 'attempt-1',
              status: 'completed',
              resolvedAgent: { kind: 'main' },
              runtimeSegmentIds: ['child-runtime'],
              startedAt: 2,
              endedAt: 8,
              terminalMessageId: 'child-terminal'
            }
          ]
        }
      ]
    }
  }
})

const scope = {
  session: { projectId: 'project-1', sessionId: 'session-1' },
  attemptId: 'attempt-1',
  agentFrameId: 'child-frame',
  messageBranchId: 'child-branch',
  terminalMessageId: 'child-terminal',
  artifactVersionIds: ['version-1']
} as const

const review = (reviewScope: ReviewWithChecks['scope']): ReviewWithChecks => ({
  id: 'review-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  turnMessageId: 'child-terminal',
  scope: reviewScope,
  lifecycle: 'complete',
  outcome: 'pass',
  model: 'reviewer-model',
  reviewerLog: [],
  createdAt: 10,
  updatedAt: 11,
  checks: []
})

describe('delegated Review evidence adapter', () => {
  it('starts the existing Reviewer owner with the exact completed child evidence scope', async () => {
    const run = vi.fn(async () => ({ started: true as const }))
    const evidence = createDelegatedReviewEvidence({
      loadSession: async () => session(),
      reviews: { run, getForSession: async () => [] }
    })

    await expect(evidence.audit(scope)).resolves.toEqual({ started: true })
    expect(run).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'child-terminal',
      evidenceScope: {
        attemptId: 'attempt-1',
        agentFrameId: 'child-frame',
        messageBranchId: 'child-branch',
        terminalMessageId: 'child-terminal',
        artifactVersionIds: ['version-1']
      }
    })
  })

  it('projects only Reviews persisted by the existing owner for the exact child provenance', async () => {
    const exact = review({
      turnMessageId: 'child-terminal',
      agentFrameId: 'child-frame',
      messageBranchId: 'child-branch',
      blocks: [],
      artifactVersionIds: ['version-1']
    })
    const evidence = createDelegatedReviewEvidence({
      loadSession: async () => session(),
      reviews: {
        run: async () => ({ started: true }),
        getForSession: async () => [
          exact,
          review({
            turnMessageId: 'child-terminal',
            agentFrameId: 'another-frame',
            messageBranchId: 'another-branch',
            blocks: [],
            artifactVersionIds: ['version-1']
          })
        ]
      }
    })

    await expect(evidence.project(scope)).resolves.toEqual([exact])
  })

  it('reviews a completed child with no Artifact from its Conversation Turn evidence', async () => {
    const withoutArtifact = session()
    withoutArtifact.conversationGraph!.messages.find(
      (message) => message.id === 'child-terminal'
    )!.artifactIds = []
    const run = vi.fn(async () => ({ started: true as const }))
    const evidence = createDelegatedReviewEvidence({
      loadSession: async () => withoutArtifact,
      reviews: { run, getForSession: async () => [] }
    })

    await expect(evidence.audit({ ...scope, artifactVersionIds: [] })).resolves.toEqual({
      started: true
    })
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceScope: expect.objectContaining({ artifactVersionIds: [] })
      })
    )
  })

  it.each([
    ['cross-Frame', { agentFrameId: 'root-frame' }],
    ['wrong Branch', { messageBranchId: 'root-branch' }],
    ['non-terminal Message', { terminalMessageId: 'child-user' }],
    ['stale Artifact Version', { artifactVersionIds: ['version-stale'] }]
  ])('fails closed for %s scope without invoking the Reviewer owner', async (_label, mutation) => {
    const run = vi.fn(async () => ({ started: true as const }))
    const evidence = createDelegatedReviewEvidence({
      loadSession: async () => session(),
      reviews: { run, getForSession: async () => [] }
    })

    await expect(evidence.audit({ ...scope, ...mutation })).rejects.toThrow(/Delegated Review/)
    expect(run).not.toHaveBeenCalled()
  })
})
