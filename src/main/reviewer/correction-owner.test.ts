import { describe, expect, it, vi } from 'vitest'

import type { ReviewerAcpRuntime } from './acp-runtime'
import { ReviewerCorrectionOwner } from './correction'

describe('ReviewerCorrectionOwner', () => {
  it('sends one attributed application turn containing only open checks', async () => {
    const sendApplicationPrompt = vi.fn<ReviewerAcpRuntime['sendApplicationPrompt']>(async () => ({
      stopReason: 'end_turn' as const
    }))
    const owner = new ReviewerCorrectionOwner({
      acpRuntime: { sendApplicationPrompt } as unknown as ReviewerAcpRuntime,
      createPromptMessageId: () => 'correction-message-2'
    })

    const provenanceContext = {
      rootFrameId: 'root-frame-1',
      agentFrameId: 'root-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'segment-1',
      promptMessageId: 'originating-message-1',
      messageBranchAncestry: ['root-branch'],
      messageAncestry: ['originating-message-1']
    }

    const result = await owner.request({
      projectId: 'project-1',
      sessionId: 'session-1',
      causeReviewId: 'review-1',
      checks: [
        {
          id: 'check-pass',
          reviewId: 'review-1',
          status: 'pass',
          claim: 'Supported',
          evidence: 'Evidence exists.',
          resolution: 'resolved',
          sortIndex: 0,
          reflagCount: 0
        },
        {
          id: 'check-fail',
          reviewId: 'review-1',
          status: 'fail',
          claim: 'Unsupported',
          evidence: 'No evidence.',
          resolution: 'open',
          sortIndex: 1,
          reflagCount: 0
        }
      ],
      provenanceContext
    })

    expect(result).toEqual({ status: 'completed', promptMessageId: 'correction-message-2' })
    expect(sendApplicationPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        text: expect.stringContaining('[fail] "Unsupported"'),
        provenanceContext: {
          ...provenanceContext,
          promptMessageId: 'correction-message-2'
        }
      }),
      {
        kind: 'application',
        feature: 'reviewer',
        purpose: 'correction',
        causeReviewId: 'review-1'
      }
    )
    expect(provenanceContext.promptMessageId).toBe('originating-message-1')
    expect(sendApplicationPrompt.mock.calls[0][0].text).not.toContain('Supported')
  })

  it('returns failed without creating a ghost completion when application prompt send rejects', async () => {
    const sendApplicationPrompt = vi.fn<ReviewerAcpRuntime['sendApplicationPrompt']>(async () => {
      throw new Error('provider unavailable')
    })
    const owner = new ReviewerCorrectionOwner({
      acpRuntime: { sendApplicationPrompt } as unknown as ReviewerAcpRuntime
    })

    await expect(
      owner.request({
        projectId: 'project-1',
        sessionId: 'session-1',
        causeReviewId: 'review-1',
        checks: [
          {
            id: 'check-fail',
            reviewId: 'review-1',
            status: 'fail',
            claim: 'Unsupported',
            evidence: 'No evidence.',
            resolution: 'open',
            sortIndex: 0,
            reflagCount: 0
          }
        ],
        provenanceContext: { promptMessageId: 'correction-message-1' }
      })
    ).resolves.toEqual({ status: 'failed', error: 'provider unavailable' })
    expect(sendApplicationPrompt).toHaveBeenCalledOnce()
  })

  it('skips cleanly when a Review has no open checks', async () => {
    const sendApplicationPrompt = vi.fn<ReviewerAcpRuntime['sendApplicationPrompt']>()
    const owner = new ReviewerCorrectionOwner({
      acpRuntime: { sendApplicationPrompt } as unknown as ReviewerAcpRuntime
    })

    await expect(
      owner.request({
        projectId: 'project-1',
        sessionId: 'session-1',
        causeReviewId: 'review-1',
        checks: [],
        provenanceContext: { promptMessageId: 'correction-message-1' }
      })
    ).resolves.toEqual({ status: 'skipped', reason: 'no-open-checks' })
    expect(sendApplicationPrompt).not.toHaveBeenCalled()
  })
})
