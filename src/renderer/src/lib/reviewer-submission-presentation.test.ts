import { describe, expect, it } from 'vitest'

import type { ReviewCheck, ReviewWithChecks } from '../../../shared/reviewer'
import { presentReviewSubmission } from './reviewer-submission-presentation'

const check = (overrides: Partial<ReviewCheck>): ReviewCheck => ({
  id: 'new-check',
  reviewId: 'review-2',
  status: 'pass',
  resolution: 'open',
  claim: 'New claim',
  evidence: 'New evidence',
  sortIndex: 1,
  reflagCount: 0,
  ...overrides
})

const review = (overrides: Partial<ReviewWithChecks>): ReviewWithChecks => ({
  id: 'review-2',
  projectId: 'project-1',
  sessionId: 'session-1',
  turnMessageId: 'turn-2',
  scope: { turnMessageId: 'turn-2', blocks: [], artifactVersionIds: [] },
  lifecycle: 'complete',
  outcome: 'flagged',
  model: 'reviewer',
  reviewerLog: [],
  checks: [],
  createdAt: 2,
  updatedAt: 2,
  ...overrides
})

describe('presentReviewSubmission', () => {
  it('owns mixed ordering and tracked assessment identity/content', () => {
    const source = check({
      id: 'source-finding',
      reviewId: 'review-1',
      status: 'warn',
      claim: 'Source claim',
      evidence: 'Source evidence',
      reflagCount: 2
    })
    const fresh = check({})
    const presented = presentReviewSubmission(
      review({
        checks: [fresh],
        submittedChecks: [
          { kind: 'new', submissionIndex: 1, check: fresh },
          {
            kind: 'tracked',
            submissionIndex: 0,
            sourceFindingId: source.id,
            dispositionOutcome: 'still_open',
            assessment: {
              status: 'fail',
              claim: 'Assessed claim',
              evidence: 'Assessed evidence',
              sortIndex: 0
            },
            sourceCheck: source
          }
        ]
      })
    )

    expect(presented.map((item) => item.findingId)).toEqual(['source-finding', 'new-check'])
    expect(presented[0]).toMatchObject({
      kindLabel: 'Tracked',
      status: 'fail',
      claim: 'Assessed claim',
      evidence: 'Assessed evidence',
      transcriptFindingId: 'source-finding',
      reflagCount: 2,
      dispositionLabel: 'still open'
    })
    expect(presented[1]).toMatchObject({
      kindLabel: 'New',
      status: 'pass'
    })
    expect(presented[1]).not.toHaveProperty('transcriptFindingId')
  })

  it('uses source content only for a legacy tracked assessment and sorts it last', () => {
    const source = check({
      id: 'legacy-source',
      reviewId: 'review-1',
      status: 'warn',
      claim: 'Legacy source claim',
      evidence: 'Legacy source evidence'
    })
    const fresh = check({ sortIndex: 0 })
    const presented = presentReviewSubmission(
      review({
        checks: [fresh],
        submittedChecks: [
          {
            kind: 'tracked',
            submissionIndex: null,
            sourceFindingId: source.id,
            dispositionOutcome: 'unaddressed',
            assessment: null,
            sourceCheck: source
          },
          { kind: 'new', submissionIndex: 0, check: fresh }
        ]
      })
    )

    expect(presented.map((item) => item.findingId)).toEqual(['new-check', 'legacy-source'])
    expect(presented[1]).toMatchObject({
      claim: 'Legacy source claim',
      evidence: 'Legacy source evidence',
      legacyAssessmentNote: 'Assessment details unavailable for this legacy review',
      isUnaddressed: true
    })
  })

  it('falls back to Review-owned checks using their sort index', () => {
    const presented = presentReviewSubmission(
      review({
        checks: [check({ id: 'later', sortIndex: 4 }), check({ id: 'earlier', sortIndex: 1 })]
      })
    )

    expect(presented.map((item) => item.findingId)).toEqual(['earlier', 'later'])
    expect(presented.every((item) => item.kind === 'new')).toBe(true)
  })
})
