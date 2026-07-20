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

  return Promise.all(
    reviews.map(async (review) => {
      if (review.lifecycle !== 'complete') return review
      try {
        const current = await resolveTurnScopeWithArtifactDigests(
          currentSession,
          review.turnMessageId,
          artifactStorageRoot
        )
        return isTurnScopeStale(review.scope, current) ? { ...review, stale: true } : review
      } catch {
        return review
      }
    })
  )
}
