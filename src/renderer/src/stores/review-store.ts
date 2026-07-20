// Renderer-side store for reviewer state. Backed by SQLite (via IPC) and updated by push events
// from the main process as review lifecycle/checks change.

import { create } from 'zustand'

import type { ReviewWithChecks, ReviewUpdateEvent } from '../../../shared/reviewer'

type ReviewStoreData = {
  // Map from sessionId to that session's reviews (newest first).
  reviewsBySession: Record<string, ReviewWithChecks[]>
}

type ReviewStore = ReviewStoreData & {
  // Load existing reviews for a session from the DB at startup.
  loadReviewsForSession: (sessionId: string) => Promise<void>
  // Handle a push event from the main process (lifecycle/checks updated).
  handleReviewUpdate: (event: ReviewUpdateEvent) => void
  // Returns the reviews for a session, newest-first.
  getReviewsForSession: (sessionId: string) => ReviewWithChecks[]
  // Returns the most recent review for a given turn (by turnMessageId), if any.
  getReviewForTurn: (sessionId: string, turnMessageId: string) => ReviewWithChecks | undefined
}

// Inserts or replaces a review in the list by id, keeping the list in createdAt desc order.
const upsertReview = (
  reviews: ReviewWithChecks[],
  updated: ReviewWithChecks
): ReviewWithChecks[] => {
  const without = reviews.filter((r) => r.id !== updated.id)
  return [updated, ...without].sort((a, b) => b.createdAt - a.createdAt)
}

// Merges a freshly-loaded snapshot into the existing list. A focus-triggered load reads a DB snapshot
// and then does slow scope hashing; meanwhile a push (e.g. a fix-loop resolving a finding) can update
// the store. A load carries two kinds of information that must be merged differently:
//   - review/finding DATA: authoritative only when strictly newer than what's in the store. Fix-loop
//     finding updates bump Review.updatedAt, so a stale load is strictly older and must NOT overwrite.
//   - the `stale` flag: applied whenever the load actually COMPUTED it (an explicit boolean), even when
//     the load isn't newer — that's how a focus reload surfaces an edit to an otherwise-unchanged
//     review, and it only sets the flag on the retained review (never reverts finding data). A load that
//     could NOT compute staleness leaves it undefined; that is ignored so it can't clear a known flag.
// New reviews the snapshot didn't include (a just-created one) are preserved.
const mergeLoadedReviews = (
  existing: ReviewWithChecks[],
  loaded: ReviewWithChecks[]
): ReviewWithChecks[] => {
  const byId = new Map(existing.map((review) => [review.id, review]))
  for (const review of loaded) {
    const current = byId.get(review.id)
    if (!current || review.updatedAt > current.updatedAt) {
      byId.set(review.id, review)
    } else if (review.stale !== undefined && review.stale !== current.stale) {
      // Apply the load's staleness only when it was actually COMPUTED (an explicit boolean). A load
      // that failed to recompute (session/scope error) leaves stale undefined; using it would wrongly
      // clear a known outdated flag, re-presenting a stale verdict as valid.
      byId.set(review.id, { ...current, stale: review.stale })
    }
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt)
}

export const createInitialReviewState = (): ReviewStoreData => ({
  reviewsBySession: {}
})

// Session ids with a load in flight, so repeated focus events don't launch overlapping loads. Kept
// outside the store (transient control state, not rendered) and cleared in loadReviewsForSession.
const loadsInFlight = new Set<string>()

export const useReviewStore = create<ReviewStore>((set, get) => ({
  ...createInitialReviewState(),

  loadReviewsForSession: async (sessionId: string) => {
    // Dedup concurrent loads for the same session: focus can fire repeatedly, and each load runs slow
    // scope hashing in main — overlapping loads would amplify that and race each other back.
    if (loadsInFlight.has(sessionId)) return
    loadsInFlight.add(sessionId)
    try {
      const reviews = (await window.api.reviewer.getForSession(sessionId)) as ReviewWithChecks[]
      // Merge (not replace): a slow load must not overwrite a newer review a push delivered meanwhile.
      set((state) => ({
        reviewsBySession: {
          ...state.reviewsBySession,
          [sessionId]: mergeLoadedReviews(state.reviewsBySession[sessionId] ?? [], reviews)
        }
      }))
    } catch {
      // Silently ignore load errors — the card will just not appear until next push event.
    } finally {
      loadsInFlight.delete(sessionId)
    }
  },

  handleReviewUpdate: (event: ReviewUpdateEvent) => {
    const { review } = event
    set((state) => ({
      reviewsBySession: {
        ...state.reviewsBySession,
        [review.sessionId]: upsertReview(state.reviewsBySession[review.sessionId] ?? [], review)
      }
    }))
  },

  getReviewsForSession: (sessionId: string) => get().reviewsBySession[sessionId] ?? [],

  getReviewForTurn: (sessionId: string, turnMessageId: string) =>
    (get().reviewsBySession[sessionId] ?? []).find((r) => r.turnMessageId === turnMessageId)
}))
