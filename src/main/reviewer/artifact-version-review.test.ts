import { describe, expect, it } from 'vitest'

import type { ReviewFindingDisposition, ReviewWithProvenanceEvidence } from '../../shared/reviewer'
import { selectReviewChainForArtifactVersion } from './artifact-version-review'

const review = (
  id: string,
  createdAt: number,
  versionIds: string[],
  outcome: 'pass' | 'flagged',
  checkVersionId?: string
): ReviewWithProvenanceEvidence => ({
  id,
  projectId: 'project-1',
  sessionId: 'session-1',
  turnMessageId: 'message-1',
  scope: { turnMessageId: `scope-${id}`, blocks: [], artifactVersionIds: versionIds },
  lifecycle: 'complete',
  outcome,
  model: 'reviewer',
  reviewerLog: [],
  createdAt,
  updatedAt: createdAt,
  scopeSnapshot: { state: 'available', blocks: [] },
  checks: checkVersionId
    ? [
        {
          id: `finding-${id}`,
          reviewId: id,
          status: outcome === 'pass' ? 'pass' : 'warn',
          claim: id,
          evidence: id,
          artifactVersionId: checkVersionId,
          artifactBindingState: 'scope_validated',
          resolution: outcome === 'pass' ? 'open' : 'resolved',
          sortIndex: 0,
          reflagCount: 0
        }
      ]
    : []
})

describe('selectReviewChainForArtifactVersion', () => {
  it('keeps the selected Version warning while reporting the later workflow review separately', () => {
    const initial = review('review-v1', 1, ['v1'], 'flagged', 'v1')
    const correction = review('review-v2', 2, ['v2'], 'pass', 'v2')
    const disposition: ReviewFindingDisposition = {
      id: 'disposition-1',
      sourceFindingId: 'finding-review-v1',
      causeReviewId: 'review-v2',
      sequence: 1,
      trigger: 'review_submission',
      outcome: 'resolved',
      assessedArtifactVersionId: 'v2',
      createdAt: 3
    }

    const projection = selectReviewChainForArtifactVersion({
      selectedVersionId: 'v1',
      versionMessageId: 'message-1',
      reviews: [initial, correction],
      dispositions: [disposition]
    })

    expect(projection?.currentDirectAssessment?.id).toBe('review-v1')
    expect(projection?.selectedVersionChecks[0]?.status).toBe('warn')
    expect(projection?.latestChainReview.id).toBe('review-v2')
    expect(projection?.latestChainReview.outcome).toBe('pass')
    expect(projection?.selectedVersionDispositions).toEqual([disposition])
  })

  it('labels a message-only legacy binding without treating another Version check as direct', () => {
    const legacy = review('legacy', 1, [], 'flagged', 'v1')
    legacy.checks[0]!.artifactBindingState = 'legacy_unverified'
    const projection = selectReviewChainForArtifactVersion({
      selectedVersionId: 'v1',
      versionMessageId: 'message-1',
      reviews: [legacy],
      dispositions: []
    })
    expect(projection?.binding).toBe('legacy-turn')
    expect(projection?.currentDirectAssessment).toBeUndefined()
    expect(projection?.selectedVersionChecks).toHaveLength(1)
  })
})
