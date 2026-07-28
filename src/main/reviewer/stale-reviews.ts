// Staleness detection for persisted reviews, kept free of electron/IPC imports so it is directly
// unit-testable and usable from any loader (IPC handler, CLI, future batch job).

import type { ReviewWithChecks } from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { resolveTurnScopeWithArtifactDigests } from './artifact-digest'
import type { ArtifactVersionContentResolver } from './host-sdk'
import { isTurnScopeStale } from './scope'

// Marks each completed review whose audited turn no longer matches its current scope (e.g. an artifact
// was edited after the review ran). A deleted Session has no live evidence to recompute; a failure while
// reading an active Session's evidence instead fails closed as stale. Running/error reviews have no
// verdict to invalidate.
export const flagStaleReviews = async (
  reviews: ReviewWithChecks[],
  session: PersistedChatSession | undefined,
  artifactStorageRoot: string,
  resolveArtifactVersion?: ArtifactVersionContentResolver
): Promise<ReviewWithChecks[]> => {
  if (reviews.length === 0 || !session) return reviews
  const currentSession = session

  // Sequential across reviews: resolveTurnScopeWithArtifactDigests already bounds concurrency *within*
  // one scope, but a Promise.all here would multiply that by the number of reviews and could exhaust
  // file descriptors on a session with a long review history (then fail-open, hiding staleness).
  const flagged: ReviewWithChecks[] = []
  for (const review of reviews) {
    flagged.push(await flagOne(review, currentSession, artifactStorageRoot, resolveArtifactVersion))
  }
  return flagged
}

// Recomputes one review's scope and returns it with a DEFINITIVE stale flag (true/false) on success.
// A non-complete review has no verdict to invalidate. A completed review that cannot be recomputed is
// explicitly stale: continuing to present its old verdict as current would be a false audit claim.
const flagOne = async (
  review: ReviewWithChecks,
  session: PersistedChatSession,
  artifactStorageRoot: string,
  resolveArtifactVersion?: ArtifactVersionContentResolver
): Promise<ReviewWithChecks> => {
  if (review.lifecycle !== 'complete') return review
  try {
    // Recompute against the turn the stored scope was actually resolved for, not review.turnMessageId:
    // a fix-loop re-review is grouped under the ORIGINAL turn id but its scope belongs to the correction
    // turn, so using review.turnMessageId would resolve a different turn and mark it stale every time.
    const current = await resolveTurnScopeWithArtifactDigests(
      session,
      review.scope.turnMessageId,
      artifactStorageRoot,
      resolveArtifactVersion
    )
    return { ...review, stale: isTurnScopeStale(review.scope, current) }
  } catch {
    return { ...review, stale: true }
  }
}
