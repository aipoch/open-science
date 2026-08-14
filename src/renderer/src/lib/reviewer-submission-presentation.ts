import type {
  FindingLocator,
  ReviewCheck,
  ReviewWithChecks,
  SubmittedReviewCheck
} from '../../../shared/reviewer'

export type PresentedReviewCheck = {
  key: string
  kind: 'new' | 'tracked'
  kindLabel: 'New' | 'Tracked'
  findingId: string
  status: ReviewCheck['status']
  claim: string
  evidence: string
  locator?: FindingLocator
  reflagCount: number
  isWarnOrFail: boolean
  isUnaddressed: boolean
  unaddressedTrigger?: ReviewCheck['unaddressedTrigger']
  transcriptFindingId?: string
  legacyAssessmentNote?: string
  dispositionLabel?: string
}

type OrderedPresentedReviewCheck = PresentedReviewCheck & { submissionIndex: number | null }

const presentSubmittedCheck = (item: SubmittedReviewCheck): OrderedPresentedReviewCheck => {
  if (item.kind === 'new') {
    const isWarnOrFail = item.check.status === 'warn' || item.check.status === 'fail'
    return {
      key: `new:${item.check.id}`,
      kind: 'new',
      kindLabel: 'New',
      submissionIndex: item.submissionIndex,
      findingId: item.check.id,
      status: item.check.status,
      claim: item.check.claim,
      evidence: item.check.evidence,
      ...(item.check.locator ? { locator: item.check.locator } : {}),
      reflagCount: item.check.reflagCount,
      isWarnOrFail,
      isUnaddressed: isWarnOrFail && item.check.resolution === 'unaddressed',
      ...(item.check.unaddressedTrigger
        ? { unaddressedTrigger: item.check.unaddressedTrigger }
        : {}),
      ...(isWarnOrFail ? { transcriptFindingId: item.check.id } : {})
    }
  }

  const assessment = item.assessment
  const status = assessment?.status ?? item.sourceCheck.status
  return {
    key: `tracked:${item.sourceFindingId}:${item.submissionIndex}`,
    kind: 'tracked',
    kindLabel: 'Tracked',
    submissionIndex: item.submissionIndex,
    findingId: item.sourceFindingId,
    status,
    claim: assessment?.claim ?? item.sourceCheck.claim,
    evidence: assessment?.evidence ?? item.sourceCheck.evidence,
    ...((assessment?.locator ?? item.sourceCheck.locator)
      ? { locator: assessment?.locator ?? item.sourceCheck.locator }
      : {}),
    reflagCount: item.sourceCheck.reflagCount,
    isWarnOrFail: status === 'warn' || status === 'fail',
    isUnaddressed: item.dispositionOutcome === 'unaddressed',
    ...(item.sourceCheck.unaddressedTrigger
      ? { unaddressedTrigger: item.sourceCheck.unaddressedTrigger }
      : {}),
    transcriptFindingId: item.sourceFindingId,
    ...(assessment === null
      ? { legacyAssessmentNote: 'Assessment details unavailable for this legacy review' }
      : {}),
    dispositionLabel: item.dispositionOutcome.replaceAll('_', ' ')
  }
}

const comparePresentedChecks = (
  left: OrderedPresentedReviewCheck,
  right: OrderedPresentedReviewCheck
): number => {
  if (left.submissionIndex === null) return right.submissionIndex === null ? 0 : 1
  if (right.submissionIndex === null) return -1
  return (
    left.submissionIndex - right.submissionIndex ||
    (left.kind === right.kind ? 0 : left.kind === 'tracked' ? -1 : 1)
  )
}

// The single renderer seam for exact Review-submission presentation. It absorbs legacy fallback,
// tracked identity/content rules, navigation identity, labels, and mixed-submission ordering so every
// Review surface tells the same historical story.
export const presentReviewSubmission = (review: ReviewWithChecks): PresentedReviewCheck[] =>
  (
    review.submittedChecks ??
    review.checks.map((check): SubmittedReviewCheck => ({
      kind: 'new',
      submissionIndex: check.sortIndex,
      check
    }))
  )
    .map(presentSubmittedCheck)
    .sort(comparePresentedChecks)
    .map(({ submissionIndex, ...check }) => {
      void submissionIndex
      return check
    })
