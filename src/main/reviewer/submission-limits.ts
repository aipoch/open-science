import { Buffer } from 'node:buffer'

import type { NewCheck } from '../../shared/reviewer'

export const MAX_REVIEW_CHECKS = 5
export const MAX_REVIEW_CLAIM_CHARACTERS = 4_096
export const MAX_REVIEW_EVIDENCE_CHARACTERS = 16_384
export const MAX_REVIEW_SUBMISSION_BYTES = 256 * 1_024

type PersistableReviewCheck = Pick<NewCheck, 'claim' | 'evidence'> &
  Partial<Omit<NewCheck, 'claim' | 'evidence'>>

export const reviewSubmissionByteLength = (checks: readonly unknown[]): number =>
  Buffer.byteLength(JSON.stringify({ checks }), 'utf8')

// Required tracked dispositions expand only the item-count allowance; field and byte limits still
// apply to the complete re-review submission.
const assertReviewSubmissionWithinLimits = (
  checks: readonly PersistableReviewCheck[],
  trackedCheckAllowance = 0
): void => {
  const maxChecks = MAX_REVIEW_CHECKS + trackedCheckAllowance
  if (checks.length > maxChecks) {
    throw new RangeError(
      `A Reviewer result may contain at most ${maxChecks} checks (got ${checks.length}).`
    )
  }

  for (const check of checks) {
    if (check.claim.length > MAX_REVIEW_CLAIM_CHARACTERS) {
      throw new RangeError(
        `A Reviewer claim may contain at most ${MAX_REVIEW_CLAIM_CHARACTERS} characters.`
      )
    }
    if (check.evidence.length > MAX_REVIEW_EVIDENCE_CHARACTERS) {
      throw new RangeError(
        `Reviewer evidence may contain at most ${MAX_REVIEW_EVIDENCE_CHARACTERS} characters.`
      )
    }
  }

  const bytes = reviewSubmissionByteLength(checks)
  if (bytes > MAX_REVIEW_SUBMISSION_BYTES) {
    throw new RangeError(
      `A Reviewer result may contain at most ${MAX_REVIEW_SUBMISSION_BYTES} serialized UTF-8 bytes (got ${bytes}).`
    )
  }
}

export { assertReviewSubmissionWithinLimits }
