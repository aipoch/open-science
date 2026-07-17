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

export const createInitialReviewState = (): ReviewStoreData => ({
  reviewsBySession: {}
})

export const useReviewStore = create<ReviewStore>((set, get) => ({
  ...createInitialReviewState(),

  loadReviewsForSession: async (sessionId: string) => {
    try {
      const reviews = (await window.api.reviewer.getForSession(sessionId)) as ReviewWithChecks[]
      set((state) => ({
        reviewsBySession: { ...state.reviewsBySession, [sessionId]: reviews }
      }))
    } catch {
      // Silently ignore load errors — the card will just not appear until next push event.
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
