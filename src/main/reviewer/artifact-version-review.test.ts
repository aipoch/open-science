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

  it('projects selected-Version and turn-level submissions without mutating frozen Review history', () => {
    const assessment = review('assessment', 1, ['v1'], 'flagged')
    const selectedNew = {
      ...review('selected-new', 1, ['v1'], 'pass', 'v1').checks[0]!,
      reviewId: assessment.id,
      id: 'selected-new'
    }
    const otherNew = {
      ...selectedNew,
      id: 'other-new',
      artifactVersionId: 'v2',
      sortIndex: 1
    }
    const turnNew = {
      ...selectedNew,
      id: 'turn-new',
      artifactVersionId: undefined,
      sortIndex: 2
    }
    const sourceV1 = {
      ...selectedNew,
      id: 'source-v1',
      reviewId: 'source-review'
    }
    const sourceV2 = { ...sourceV1, id: 'source-v2', artifactVersionId: 'v2' }
    const submittedChecks: NonNullable<ReviewWithProvenanceEvidence['submittedChecks']> = [
      {
        kind: 'tracked',
        submissionIndex: 0,
        sourceFindingId: 'priority-selected',
        dispositionOutcome: 'still_open',
        assessedArtifactVersionId: 'v1',
        assessment: {
          status: 'fail',
          claim: 'Snapshot points elsewhere',
          evidence: 'Disposition binding wins',
          artifactVersionId: 'v2',
          sortIndex: 0
        },
        sourceCheck: sourceV2
      },
      {
        kind: 'tracked',
        submissionIndex: 1,
        sourceFindingId: 'priority-other',
        dispositionOutcome: 'still_open',
        assessedArtifactVersionId: 'v2',
        assessment: {
          status: 'fail',
          claim: 'Snapshot points selected',
          evidence: 'Disposition binding still wins',
          artifactVersionId: 'v1',
          sortIndex: 1
        },
        sourceCheck: sourceV1
      },
      {
        kind: 'tracked',
        submissionIndex: 2,
        sourceFindingId: 'snapshot-selected',
        dispositionOutcome: 'still_open',
        assessment: {
          status: 'warn',
          claim: 'Snapshot-selected',
          evidence: 'Snapshot binding is the fallback',
          artifactVersionId: 'v1',
          sortIndex: 2
        },
        sourceCheck: sourceV2
      },
      {
        kind: 'tracked',
        submissionIndex: null,
        sourceFindingId: 'legacy-selected',
        dispositionOutcome: 'still_open',
        assessment: null,
        sourceCheck: sourceV1
      },
      {
        kind: 'tracked',
        submissionIndex: null,
        sourceFindingId: 'legacy-turn',
        dispositionOutcome: 'still_open',
        assessment: null,
        sourceCheck: { ...sourceV1, id: 'source-turn', artifactVersionId: undefined }
      },
      { kind: 'new', submissionIndex: 3, check: selectedNew },
      { kind: 'new', submissionIndex: 4, check: otherNew },
      { kind: 'new', submissionIndex: 5, check: turnNew }
    ]
    assessment.checks = Object.freeze([
      selectedNew,
      otherNew,
      turnNew
    ]) as unknown as typeof assessment.checks
    assessment.submittedChecks = Object.freeze(submittedChecks) as unknown as typeof submittedChecks

    const projection = selectReviewChainForArtifactVersion({
      selectedVersionId: 'v1',
      versionMessageId: 'message-1',
      reviews: [assessment],
      dispositions: []
    })!

    expect(
      projection.selectedVersionAssessment.submittedChecks?.map((item) =>
        item.kind === 'new' ? item.check.id : item.sourceFindingId
      )
    ).toEqual([
      'priority-selected',
      'snapshot-selected',
      'legacy-selected',
      'legacy-turn',
      'selected-new',
      'turn-new'
    ])
    expect(projection.selectedVersionAssessment.checks.map((check) => check.id)).toEqual([
      'selected-new',
      'turn-new'
    ])
    expect(projection.selectedVersionAssessment).not.toBe(assessment)
    expect(projection.currentDirectAssessment).toBe(assessment)
    expect(projection.history[0]).toMatchObject({ kind: 'review', review: assessment })
    expect(assessment.submittedChecks).toBe(submittedChecks)
    expect(assessment.submittedChecks).toHaveLength(8)
  })
})
