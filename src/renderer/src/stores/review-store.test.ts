import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReviewCheck, ReviewWithChecks, TurnScope } from '../../../shared/reviewer'
import { createInitialReviewState, useReviewStore } from './review-store'

const emptyScope = (turnMessageId: string): TurnScope => ({
  turnMessageId,
  blocks: [],
  artifactVersionIds: []
})

// Builds a minimal-but-valid ReviewWithChecks; overrides win so tests can vary id/session/time.
const makeReview = (overrides: Partial<ReviewWithChecks> = {}): ReviewWithChecks => {
  const turnMessageId = overrides.turnMessageId ?? 'turn-1'
  return {
    id: 'review-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    turnMessageId,
    scope: emptyScope(turnMessageId),
    lifecycle: 'complete',
    outcome: 'pass',
    model: 'test-model',
    reviewerLog: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    checks: [],
    ...overrides
  }
}

const makeCheck = (overrides: Partial<ReviewCheck> = {}): ReviewCheck => ({
  id: 'check-1',
  reviewId: 'review-1',
  status: 'fail',
  claim: 'the table has 33 rows',
  evidence: 'the artifact shows 12 rows',
  resolution: 'open',
  sortIndex: 0,
  reflagCount: 0,
  ...overrides
})

describe('review store', () => {
  // Reset the store so each assertion starts from an empty reviewsBySession map.
  beforeEach(() => {
    useReviewStore.setState(createInitialReviewState())
  })

  it('starts empty and returns [] for an unknown session', () => {
    expect(useReviewStore.getState().reviewsBySession).toEqual({})
    expect(useReviewStore.getState().getReviewsForSession('missing')).toEqual([])
  })

  it('stores a pushed review under its session id', () => {
    const review = makeReview({ checks: [makeCheck()] })
    useReviewStore.getState().handleReviewUpdate({ review })

    const stored = useReviewStore.getState().getReviewsForSession('session-1')
    expect(stored).toHaveLength(1)
    expect(stored[0]).toBe(review)
  })

  it('replaces a review with the same id instead of appending a duplicate', () => {
    const running = makeReview({ id: 'review-1', lifecycle: 'running', outcome: null })
    useReviewStore.getState().handleReviewUpdate({ review: running })

    const complete = makeReview({ id: 'review-1', lifecycle: 'complete', outcome: 'flagged' })
    useReviewStore.getState().handleReviewUpdate({ review: complete })

    const stored = useReviewStore.getState().getReviewsForSession('session-1')
    expect(stored).toHaveLength(1)
    expect(stored[0]?.lifecycle).toBe('complete')
    expect(stored[0]?.outcome).toBe('flagged')
  })

  it('keeps a session list ordered newest-first by createdAt', () => {
    const older = makeReview({ id: 'review-old', turnMessageId: 'turn-old', createdAt: 1_000 })
    const newer = makeReview({ id: 'review-new', turnMessageId: 'turn-new', createdAt: 2_000 })

    // Push the older one last to prove ordering is by createdAt, not insertion order.
    useReviewStore.getState().handleReviewUpdate({ review: newer })
    useReviewStore.getState().handleReviewUpdate({ review: older })

    const stored = useReviewStore.getState().getReviewsForSession('session-1')
    expect(stored.map((r) => r.id)).toEqual(['review-new', 'review-old'])
  })

  it('keeps reviews from different sessions isolated', () => {
    useReviewStore
      .getState()
      .handleReviewUpdate({ review: makeReview({ id: 'a', sessionId: 's1' }) })
    useReviewStore
      .getState()
      .handleReviewUpdate({ review: makeReview({ id: 'b', sessionId: 's2' }) })

    expect(
      useReviewStore
        .getState()
        .getReviewsForSession('s1')
        .map((r) => r.id)
    ).toEqual(['a'])
    expect(
      useReviewStore
        .getState()
        .getReviewsForSession('s2')
        .map((r) => r.id)
    ).toEqual(['b'])
  })

  it('finds the review for a specific turn', () => {
    useReviewStore
      .getState()
      .handleReviewUpdate({ review: makeReview({ id: 'a', turnMessageId: 'turn-a' }) })
    useReviewStore
      .getState()
      .handleReviewUpdate({ review: makeReview({ id: 'b', turnMessageId: 'turn-b' }) })

    expect(useReviewStore.getState().getReviewForTurn('session-1', 'turn-b')?.id).toBe('b')
    expect(useReviewStore.getState().getReviewForTurn('session-1', 'turn-missing')).toBeUndefined()
  })

  it('loads persisted reviews for a session from the IPC bridge', async () => {
    const persisted = [makeReview({ id: 'persisted-1' })]
    const getForSession = vi.fn().mockResolvedValue(persisted)
    vi.stubGlobal('window', { api: { reviewer: { getForSession } } })

    await useReviewStore.getState().loadReviewsForSession('session-1')

    expect(getForSession).toHaveBeenCalledWith('session-1')
    expect(
      useReviewStore
        .getState()
        .getReviewsForSession('session-1')
        .map((r) => r.id)
    ).toEqual(['persisted-1'])
    vi.unstubAllGlobals()
  })

  it('swallows load errors and leaves the session without reviews', async () => {
    const getForSession = vi.fn().mockRejectedValue(new Error('db down'))
    vi.stubGlobal('window', { api: { reviewer: { getForSession } } })

    await expect(
      useReviewStore.getState().loadReviewsForSession('session-1')
    ).resolves.toBeUndefined()
    expect(useReviewStore.getState().getReviewsForSession('session-1')).toEqual([])
    vi.unstubAllGlobals()
  })

  it('keeps pushed finding data on an equal-timestamp load but still applies the load stale flag', async () => {
    // A fix loop resolved a finding and pushed it. A focus-load, mid-flight, holds the OLDER snapshot
    // (finding still open) at the SAME updatedAt (the concerning case) but freshly computed stale=true.
    const resolvedCheck = makeCheck({ id: 'c1', resolution: 'resolved' })
    const pushed = makeReview({
      id: 'review-1',
      updatedAt: 1_000,
      checks: [resolvedCheck],
      stale: false
    })
    useReviewStore.getState().handleReviewUpdate({ review: pushed })

    const staleSnapshot = [
      makeReview({
        id: 'review-1',
        updatedAt: 1_000,
        checks: [makeCheck({ id: 'c1', resolution: 'open' })],
        stale: true
      })
    ]
    const getForSession = vi.fn().mockResolvedValue(staleSnapshot)
    vi.stubGlobal('window', { api: { reviewer: { getForSession } } })

    await useReviewStore.getState().loadReviewsForSession('session-1')

    const stored = useReviewStore.getState().getReviewsForSession('session-1')
    // Finding data is NOT reverted (still resolved), but the freshly-computed stale flag is applied.
    expect(stored[0]?.checks[0]?.resolution).toBe('resolved')
    expect(stored[0]?.stale).toBe(true)
    vi.unstubAllGlobals()
  })

  it('does not let a stale load overwrite a newer review delivered by a push', async () => {
    // A push completes the review while a slow focus-load is mid-flight holding an older snapshot.
    useReviewStore.getState().handleReviewUpdate({
      review: makeReview({ id: 'review-1', lifecycle: 'complete', updatedAt: 2_000 })
    })

    const staleSnapshot = [
      makeReview({ id: 'review-1', lifecycle: 'running', outcome: null, updatedAt: 1_000 })
    ]
    const getForSession = vi.fn().mockResolvedValue(staleSnapshot)
    vi.stubGlobal('window', { api: { reviewer: { getForSession } } })

    await useReviewStore.getState().loadReviewsForSession('session-1')

    // The newer pushed review (updatedAt 2000, complete) survives the merge.
    const stored = useReviewStore.getState().getReviewsForSession('session-1')
    expect(stored).toHaveLength(1)
    expect(stored[0]?.lifecycle).toBe('complete')
    expect(stored[0]?.updatedAt).toBe(2_000)
    vi.unstubAllGlobals()
  })

  it('dedupes concurrent loads for the same session', async () => {
    let resolveLoad: ((value: ReviewWithChecks[]) => void) | undefined
    const getForSession = vi.fn().mockReturnValue(
      new Promise<ReviewWithChecks[]>((resolve) => {
        resolveLoad = resolve
      })
    )
    vi.stubGlobal('window', { api: { reviewer: { getForSession } } })

    const first = useReviewStore.getState().loadReviewsForSession('session-1')
    const second = useReviewStore.getState().loadReviewsForSession('session-1')

    resolveLoad?.([makeReview({ id: 'r' })])
    await Promise.all([first, second])

    // The in-flight guard drops the overlapping second call.
    expect(getForSession).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })
})
