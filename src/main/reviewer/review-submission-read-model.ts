import type { Finding as PrismaFinding, PrismaClient } from '@prisma/client'

import type {
  CheckStatus,
  FindingLocator,
  ReviewCheck,
  ReviewCheckAssessment,
  ReviewFindingDispositionTrigger,
  ReviewFindingDispositionOutcome,
  SubmittedReviewCheck
} from '../../shared/reviewer'

type ReviewSubmissionReadClient = Pick<PrismaClient, 'finding' | 'reviewFindingDisposition'>
type PersistedReviewCheckAssessment = ReviewCheckAssessment & { schemaVersion: 1 }
type ReviewSubmissionProjection = {
  checks: ReviewCheck[]
  submittedChecks: SubmittedReviewCheck[]
}

const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const asCheckStatus = (value: string): CheckStatus => {
  if (value === 'fail' || value === 'warn' || value === 'pass') return value
  // The retired inconclusive severity and any corrupt value degrade to a visible warning.
  return 'warn'
}

const toReviewCheck = (
  row: PrismaFinding,
  unaddressedTrigger?: Exclude<ReviewFindingDispositionTrigger, 'review_submission'>
): ReviewCheck => {
  const locatorRaw = parseJson<FindingLocator | Record<string, never>>(row.locator, {})
  const hasLocator = 'blockRef' in locatorRaw && locatorRaw.blockRef !== undefined
  return {
    id: row.id,
    reviewId: row.reviewId,
    status: asCheckStatus(row.status),
    resolution:
      row.resolution === 'resolved' || row.resolution === 'unaddressed' ? row.resolution : 'open',
    claim: row.claim,
    evidence: row.evidence,
    locator: hasLocator ? (locatorRaw as FindingLocator) : undefined,
    artifactVersionId: row.artifactVersionId ?? undefined,
    artifactBindingState:
      row.artifactBindingState === 'scope_validated' ? 'scope_validated' : 'legacy_unverified',
    sortIndex: row.sortIndex,
    reflagCount: row.reflagCount ?? 0,
    ...(row.resolution === 'unaddressed' && unaddressedTrigger ? { unaddressedTrigger } : {})
  }
}

const parseAssessmentSnapshot = (value: string | null): ReviewCheckAssessment | null => {
  if (!value) return null
  const parsed = parseJson<Partial<PersistedReviewCheckAssessment> | null>(value, null)
  if (
    !parsed ||
    parsed.schemaVersion !== 1 ||
    (parsed.status !== 'pass' && parsed.status !== 'warn' && parsed.status !== 'fail') ||
    typeof parsed.claim !== 'string' ||
    typeof parsed.evidence !== 'string' ||
    typeof parsed.sortIndex !== 'number'
  ) {
    return null
  }
  return {
    status: parsed.status,
    claim: parsed.claim,
    evidence: parsed.evidence,
    ...(parsed.locator ? { locator: parsed.locator } : {}),
    ...(parsed.artifactVersionId ? { artifactVersionId: parsed.artifactVersionId } : {}),
    sortIndex: parsed.sortIndex
  }
}

const compareSubmittedChecks = (
  left: SubmittedReviewCheck,
  right: SubmittedReviewCheck
): number => {
  if (left.submissionIndex === null) return right.submissionIndex === null ? 0 : 1
  if (right.submissionIndex === null) return -1
  return (
    left.submissionIndex - right.submissionIndex ||
    (left.kind === right.kind ? 0 : left.kind === 'tracked' ? -1 : 1)
  )
}

// Owns the complete database read for Review submissions. Keeping the relation include, ordering,
// legacy sanitization, and mixed new/tracked assembly here prevents command history and Artifact
// provenance from drifting into subtly different Review projections.
const loadReviewSubmissionProjections = async (
  client: ReviewSubmissionReadClient,
  reviewIds: readonly string[]
): Promise<Map<string, ReviewSubmissionProjection>> => {
  if (reviewIds.length === 0) return new Map()
  const findingRows = await client.finding.findMany({
    where: { reviewId: { in: [...reviewIds] } },
    orderBy: [{ reviewId: 'asc' }, { sortIndex: 'asc' }, { id: 'asc' }]
  })
  const [dispositionRows, terminalDispositionRows] = await Promise.all([
    client.reviewFindingDisposition.findMany({
      where: { causeReviewId: { in: [...reviewIds] }, trigger: 'review_submission' },
      orderBy: [{ createdAt: 'asc' }, { sequence: 'asc' }, { id: 'asc' }],
      include: { sourceFinding: true }
    }),
    client.reviewFindingDisposition.findMany({
      where: {
        sourceFinding: { reviewId: { in: [...reviewIds] } },
        trigger: { in: ['loop_terminated', 'correction_failed', 'aborted', 'interrupted'] },
        outcome: 'unaddressed'
      },
      orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]
    })
  ])
  const terminalTriggerByFindingId = new Map<
    string,
    Exclude<ReviewFindingDispositionTrigger, 'review_submission'>
  >()
  for (const disposition of terminalDispositionRows) {
    if (!terminalTriggerByFindingId.has(disposition.sourceFindingId)) {
      terminalTriggerByFindingId.set(
        disposition.sourceFindingId,
        disposition.trigger as Exclude<ReviewFindingDispositionTrigger, 'review_submission'>
      )
    }
  }
  const findingRowsByReviewId = new Map<string, typeof findingRows>()
  for (const row of findingRows) {
    const rows = findingRowsByReviewId.get(row.reviewId) ?? []
    rows.push(row)
    findingRowsByReviewId.set(row.reviewId, rows)
  }
  const dispositionRowsByReviewId = new Map<string, typeof dispositionRows>()
  for (const row of dispositionRows) {
    if (!row.causeReviewId) continue
    const rows = dispositionRowsByReviewId.get(row.causeReviewId) ?? []
    rows.push(row)
    dispositionRowsByReviewId.set(row.causeReviewId, rows)
  }

  return new Map(
    reviewIds.map((reviewId) => {
      const checks = (findingRowsByReviewId.get(reviewId) ?? []).map((row) =>
        toReviewCheck(row, terminalTriggerByFindingId.get(row.id))
      )
      const submittedChecks: SubmittedReviewCheck[] = [
        ...checks.map((check): SubmittedReviewCheck => ({
          kind: 'new',
          submissionIndex: check.sortIndex,
          check
        })),
        ...(dispositionRowsByReviewId.get(reviewId) ?? []).map(
          (disposition): SubmittedReviewCheck => {
            const assessment = parseAssessmentSnapshot(disposition.assessmentSnapshot)
            return {
              kind: 'tracked',
              submissionIndex: assessment?.sortIndex ?? null,
              sourceFindingId: disposition.sourceFindingId,
              dispositionOutcome: disposition.outcome as ReviewFindingDispositionOutcome,
              ...(disposition.assessedArtifactVersionId
                ? { assessedArtifactVersionId: disposition.assessedArtifactVersionId }
                : {}),
              assessment,
              sourceCheck: toReviewCheck(
                disposition.sourceFinding,
                terminalTriggerByFindingId.get(disposition.sourceFindingId)
              )
            }
          }
        )
      ].sort(compareSubmittedChecks)
      return [reviewId, { checks, submittedChecks }]
    })
  )
}

const loadReviewSubmissionProjection = async (
  client: ReviewSubmissionReadClient,
  reviewId: string
): Promise<ReviewSubmissionProjection> =>
  (await loadReviewSubmissionProjections(client, [reviewId])).get(reviewId)!

export { loadReviewSubmissionProjection, loadReviewSubmissionProjections, toReviewCheck }
export type { ReviewSubmissionReadClient }
