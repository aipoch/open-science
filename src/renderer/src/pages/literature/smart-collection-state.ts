import { createContext } from 'react'

// Only action controls subscribe; pending writes do not invalidate full table rows.
export const SmartDecisionPendingContext = createContext(false)

import type { SmartCollectionView } from '../../../../shared/literature-smart-collections'

// One owner for live progress and the last settled table summary. A write invalidates
// reads both before and after its receipt; reads during a write cannot publish stale counts.
export type SmartCollectionState = {
  readonly collectionId?: string
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => SmartCollectionView | undefined
  getSettledSnapshot: () => SmartCollectionView | undefined
  beginRead: () => number | undefined
  acceptRead: (token: number | undefined, view: SmartCollectionView | undefined) => boolean
  isCurrent: (token: number | undefined) => boolean
  beginWrite: () => void
  finishWrite: (view?: SmartCollectionView) => void
}
export function createSmartCollectionState(collectionId?: string): SmartCollectionState {
  let generation = 0
  let writing = false
  let live: SmartCollectionView | undefined
  let settled: SmartCollectionView | undefined
  const listeners = new Set<() => void>()
  const publish = (view: SmartCollectionView | undefined): void => {
    live = view
    if (view?.run?.state !== 'running' && view?.run?.state !== 'queued') settled = view
    listeners.forEach((listener) => listener())
  }
  return {
    collectionId,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => live,
    getSettledSnapshot: () => settled,
    beginRead: () => (writing ? undefined : ++generation),
    acceptRead: (token: number | undefined, view: SmartCollectionView | undefined) => {
      if (token === undefined || writing || token !== generation) return false
      publish(view)
      return true
    },
    isCurrent: (token: number | undefined) =>
      token !== undefined && !writing && token === generation,
    beginWrite: () => {
      generation++
      writing = true
    },
    finishWrite: (view?: SmartCollectionView) => {
      generation++
      writing = false
      if (view) publish(view)
    }
  }
}
