// Staleness detection for persisted reviews, kept free of electron/IPC imports so it is directly
// unit-testable and usable from any loader (IPC handler, CLI, future batch job).

import type { ReviewWithChecks } from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { resolveTurnScopeWithArtifactDigests } from './artifact-digest'
import { isTurnScopeStale } from './scope'

// Marks each completed review whose audited turn no longer matches its current scope (e.g. an artifact
// was edited after the review ran). Fail-open: a missing session or a recompute error leaves reviews
// unflagged rather than hiding a real verdict. Running/error reviews have no verdict to invalidate.
export const flagStaleReviews = async (
  reviews: ReviewWithChecks[],
  session: PersistedChatSession | undefined,
  artifactStorageRoot: string
): Promise<ReviewWithChecks[]> => {
  if (reviews.length === 0 || !session) return reviews
  const currentSession = session

  // Sequential across reviews: resolveTurnScopeWithArtifactDigests already bounds concurrency *within*
  // one scope, but a Promise.all here would multiply that by the number of reviews and could exhaust
  // file descriptors on a session with a long review history (then fail-open, hiding staleness).
  const flagged: ReviewWithChecks[] = []
  for (const review of reviews) {
    flagged.push(await flagOne(review, currentSession, artifactStorageRoot))
  }
  return flagged
}

// Recomputes one review's scope and returns it with a DEFINITIVE stale flag (true/false) on success.
// On failure — or for a non-complete review that has no verdict to invalidate — it leaves `stale`
// untouched (typically undefined), which the renderer merge treats as "not computed" and therefore
// must NOT use to clear an existing outdated flag. This is why success always sets an explicit boolean:
// only an explicit value distinguishes "computed not-stale" from "couldn't compute".
const flagOne = async (
  review: ReviewWithChecks,
  session: PersistedChatSession,
  artifactStorageRoot: string
): Promise<ReviewWithChecks> => {
  if (review.lifecycle !== 'complete') return review
  try {
    // Recompute against the turn the stored scope was actually resolved for, not review.turnMessageId:
    // a fix-loop re-review is grouped under the ORIGINAL turn id but its scope belongs to the correction
    // turn, so using review.turnMessageId would resolve a different turn and mark it stale every time.
    const current = await resolveTurnScopeWithArtifactDigests(
      session,
      review.scope.turnMessageId,
      artifactStorageRoot
    )
    return { ...review, stale: isTurnScopeStale(review.scope, current) }
  } catch {
    return review
  }
}
