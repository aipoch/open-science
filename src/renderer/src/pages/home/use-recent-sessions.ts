import { useState } from 'react'

import type { ChatSession } from '@/stores/session-store'

const RECENT_SESSION_LIMIT = 5

const newestFirst = (left: ChatSession, right: ChatSession): number =>
  right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

// This order belongs to one Home visit. Keep only IDs so titles, timestamps and
// activity always come from the current catalog rather than a frozen session copy.
export const useRecentSessions = (
  eligibleSessions: readonly ChatSession[],
  isCatalogReady: boolean
): ChatSession[] => {
  const [order, setOrder] = useState<{ ids: string[]; hasCompleteCatalog: boolean }>({
    ids: [],
    hasCompleteCatalog: false
  })
  const sessionsById = new Map(eligibleSessions.map((session) => [session.id, session]))
  let nextIds = order.ids

  if (isCatalogReady || !order.hasCompleteCatalog) {
    // Recovery may remain partial while sessions are usable: keep that provisional
    // order stable too. Only the first complete snapshot replaces its ranking.
    // Partial snapshots cannot prove removals, so retain their absent IDs.
    nextIds = isCatalogReady
      ? order.hasCompleteCatalog
        ? order.ids.filter((id) => sessionsById.has(id))
        : []
      : [...order.ids]
    if (nextIds.length < RECENT_SESSION_LIMIT) {
      const retainedIds = new Set(nextIds)
      const candidates = eligibleSessions
        .filter((session) => !retainedIds.has(session.id))
        .sort(newestFirst)
      nextIds.push(
        ...candidates.slice(0, RECENT_SESSION_LIMIT - nextIds.length).map((session) => session.id)
      )
    }

    if (
      (isCatalogReady && !order.hasCompleteCatalog) ||
      nextIds.length !== order.ids.length ||
      nextIds.some((id, index) => id !== order.ids[index])
    ) {
      // Adjust before committing children, so removal/backfill never paints an
      // intermediate order. No effect or mutable render-time ref is needed.
      setOrder({
        ids: nextIds,
        hasCompleteCatalog: order.hasCompleteCatalog || isCatalogReady
      })
    }
  }

  return nextIds.flatMap((id) => {
    const session = sessionsById.get(id)
    return session ? [session] : []
  })
}
