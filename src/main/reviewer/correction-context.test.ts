import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { ReviewCheck } from '../../shared/reviewer'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import {
  forkEditedConversationMessage,
  getActiveConversationContext
} from '../../shared/conversation-graph'
import type { ReviewerAcpRuntime } from './acp-runtime'
import type { ReviewRepository } from './repository'
import { runReviewerFixLoop } from './reviewer-fix-loop-owner'
import { resolveTurnScope } from './scope'

const assessment = vi.hoisted(() => vi.fn())
vi.mock('./review-assessment-owner', () => ({ runReviewAssessment: assessment }))

const message = (
  id: string,
  role: 'user' | 'agent',
  timestamp: number
): PersistedChatSession['messages'][number] => ({
  id,
  role,
  content: id,
  status: 'complete' as const,
  eventIds: [],
  createdAt: timestamp,
  updatedAt: timestamp
})

const finding: ReviewCheck = {
  id: 'finding-1',
  reviewId: 'original-review',
  status: 'warn',
  resolution: 'open',
  claim: 'The original answer is unsupported.',
  evidence: 'No supporting evidence.',
  sortIndex: 0,
  reflagCount: 0
}

describe('historical review correction context', () => {
  it.each(['newer turn', 'different branch'] as const)(
    'does not inject historical findings into a %s',
    async (change) => {
      const session: PersistedChatSession = materializeSessionConversationGraph({
        id: 'session-1',
        projectId: 'project-1',
        title: 'Historical review',
        cwd: join(tmpdir(), 'reviewer-context'),
        status: 'idle',
        createdAt: 1,
        updatedAt: 4,
        messages: [
          message('original-user', 'user', 1),
          { ...message('original-agent', 'agent', 2), responseToMessageId: 'original-user' },
          message('newer-user', 'user', 3),
          { ...message('newer-agent', 'agent', 4), responseToMessageId: 'newer-user' }
        ]
      })
      const correctionScope = resolveTurnScope(session, 'original-agent')
      if (change === 'different branch') {
        session.conversationGraph = forkEditedConversationMessage(
          session.conversationGraph!,
          'newer-user',
          'other-branch',
          5
        )
      }
      const currentContext = getActiveConversationContext(
        session.conversationGraph!,
        change === 'newer turn' ? 'newer-user' : 'original-user'
      )
      const sendApplicationPrompt = vi.fn().mockRejectedValue(new Error('test transport boundary'))
      const repository = {
        commitFindingDispositions: vi.fn(),
        getReviewsForProjectSession: vi.fn().mockResolvedValue([])
      } as unknown as ReviewRepository

      await runReviewerFixLoop({
        sessionId: session.id,
        originalTurnMessageId: 'original-agent',
        correctionScope,
        openChecks: [finding],
        projectId: session.projectId!,
        mainSessionId: session.id,
        getSession: async () => session,
        reviewRepository: repository,
        acpRuntime: { sendApplicationPrompt } as unknown as ReviewerAcpRuntime,
        artifactStorageRoot: join(tmpdir(), 'reviewer-context-artifacts'),
        model: 'test-model',
        reviewerTimeoutMs: 100,
        reviewerMaxUpdates: 10,
        maxRounds: 1,
        sessionRefreshTimeoutMs: 0
      })

      // Real graph resolution and the production correction owner reach the runtime send boundary.
      // No model is called, and no branch is switched by the test.
      expect(session.conversationGraph!.activeFrameId).toBe(currentContext.agentFrameId)
      expect(
        sendApplicationPrompt.mock.calls.map(([request]) => request.provenanceContext)
      ).not.toEqual([
        expect.objectContaining({
          messageBranchId: currentContext.messageBranchId,
          runtimeSegmentId: currentContext.runtimeSegmentId,
          messageAncestry: expect.arrayContaining(['newer-user'])
        })
      ])
      expect(sendApplicationPrompt).not.toHaveBeenCalled()
      expect(repository.commitFindingDispositions).toHaveBeenCalledWith([
        expect.objectContaining({
          trigger: 'aborted',
          outcome: 'unaddressed',
          note: 'Automatic correction stopped because the active conversation changed.'
        })
      ])
    }
  )
})
