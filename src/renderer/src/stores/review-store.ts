// Renderer-side store for reviewer state. Backed by SQLite (via IPC) and updated by push events
// from the main process as review lifecycle/checks change.

import { create } from 'zustand'

import type { ReviewWithChecks, ReviewUpdateEvent } from '../../../shared/reviewer'

type ReviewStoreData = {
  // Map from projectId + sessionId to that session's reviews (newest first).
  reviewsBySession: Record<string, ReviewWithChecks[]>
}

type ReviewStore = ReviewStoreData & {
  // Load existing reviews for a session from the DB at startup.
  loadReviewsForSession: (sessionId: string, projectId?: string) => Promise<void>
  // Handle a push event from the main process (lifecycle/checks updated).
  handleReviewUpdate: (event: ReviewUpdateEvent) => void
  // Returns the reviews for a session, newest-first.
  getReviewsForSession: (sessionId: string, projectId?: string) => ReviewWithChecks[]
  // Returns the most recent review for a given turn (by turnMessageId), if any.
  getReviewForTurn: (
    sessionId: string,
    turnMessageId: string,
    projectId?: string
  ) => ReviewWithChecks | undefined
}

// Inserts or replaces a review in the list by id, keeping the list in createdAt desc order. `stale` is
// transient (never sent by a push and only computed on load), so a same-id update that doesn't carry an
// explicit stale result inherits the current one — otherwise a plain reviewer:updated push would drop a
// known "outdated" flag. An explicit false (a load that computed not-stale) still wins via ??.
const upsertReview = (
  reviews: ReviewWithChecks[],
  updated: ReviewWithChecks
): ReviewWithChecks[] => {
  const current = reviews.find((r) => r.id === updated.id)
  const merged =
    current && updated.stale === undefined ? { ...updated, stale: current.stale } : updated
  const without = reviews.filter((r) => r.id !== updated.id)
  return [merged, ...without].sort((a, b) => b.createdAt - a.createdAt)
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
    if (!current) {
      byId.set(review.id, review)
      continue
    }
    // `stale` is only meaningful when this load actually COMPUTED it (an explicit boolean); a load that
    // failed to recompute leaves it undefined and must inherit the current flag — otherwise it would
    // clear a known outdated marker. This holds on BOTH branches, so even a newer payload with a failed
    // recompute keeps the existing stale rather than replacing it with undefined.
    const stale = review.stale ?? current.stale
    const base = review.updatedAt > current.updatedAt ? review : current
    byId.set(review.id, base.stale === stale ? base : { ...base, stale })
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt)
}

export const createInitialReviewState = (): ReviewStoreData => ({
  reviewsBySession: {}
})

// Session ids with a load in flight, so repeated focus events don't launch overlapping loads. Kept
// outside the store (transient control state, not rendered) and cleared in loadReviewsForSession.
const loadsInFlight = new Set<string>()
const reviewSessionKey = (projectId: string, sessionId: string): string =>
  `${projectId}\0${sessionId}`

export const useReviewStore = create<ReviewStore>((set, get) => ({
  ...createInitialReviewState(),

  loadReviewsForSession: async (sessionId: string, projectId = '') => {
    // Dedup concurrent loads for the same session: focus can fire repeatedly, and each load runs slow
    // scope hashing in main — overlapping loads would amplify that and race each other back.
    const key = reviewSessionKey(projectId, sessionId)
    if (loadsInFlight.has(key)) return
    loadsInFlight.add(key)
    try {
      const reviews = (await window.api.reviewer.getForSession({
        projectId,
        appSessionId: sessionId
      })) as ReviewWithChecks[]
      // Merge (not replace): a slow load must not overwrite a newer review a push delivered meanwhile.
      set((state) => ({
        reviewsBySession: {
          ...state.reviewsBySession,
          [key]: mergeLoadedReviews(state.reviewsBySession[key] ?? [], reviews)
        }
      }))
    } catch {
      // Silently ignore load errors — the card will just not appear until next push event.
    } finally {
      loadsInFlight.delete(key)
    }
  },

  handleReviewUpdate: (event: ReviewUpdateEvent) => {
    const { review } = event
    const key = reviewSessionKey(review.projectId, review.sessionId)
    set((state) => ({
      reviewsBySession: {
        ...state.reviewsBySession,
        [key]: upsertReview(state.reviewsBySession[key] ?? [], review)
      }
    }))
  },

  getReviewsForSession: (sessionId: string, projectId?: string) =>
    projectId !== undefined
      ? (get().reviewsBySession[reviewSessionKey(projectId, sessionId)] ?? [])
      : Object.values(get().reviewsBySession)
          .flat()
          .filter((review) => review.sessionId === sessionId)
          .sort((left, right) => right.createdAt - left.createdAt),

  getReviewForTurn: (sessionId: string, turnMessageId: string, projectId?: string) =>
    get()
      .getReviewsForSession(sessionId, projectId)
      .find((review) => review.turnMessageId === turnMessageId)
}))
