import { useCallback, useLayoutEffect, useRef } from 'react'
import type { LiteratureChangedEvent } from '../../../../shared/literature'

export const isCollectionOnlyChange = (event?: LiteratureChangedEvent): boolean =>
  Boolean(event?.collectionIds?.length && !event.itemIds?.length && !event.candidateIds?.length)

// One subscription recipe for Literature consumers. The transport already owns replay/gap handling;
// focus and replay completion revalidate even when a client missed the original mutation event.
export const useLiteratureChanges = (
  invalidate: (event?: LiteratureChangedEvent) => void
): ((collectionId: string) => void) => {
  const consume = useRef<(collectionId: string) => void>(() => {})
  const consumePendingCollection = useCallback(
    (collectionId: string) => consume.current(collectionId),
    []
  )
  const latest = useRef(invalidate)
  useLayoutEffect(() => {
    latest.current = invalidate
  })
  useLayoutEffect(() => {
    let active = true
    let queued = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let pending: LiteratureChangedEvent | undefined
    // The command owner is about to read fresh rows/counts itself. Consume only already
    // queued events for that collection; later events and other scopes still invalidate.
    consume.current = (collectionId) => {
      if (!pending) return
      const collectionIds = pending.collectionIds?.filter((id) => id !== collectionId) ?? []
      if (collectionIds.length) pending = { ...pending, collectionIds }
      else {
        pending = undefined
        clearTimeout(timer)
        timer = undefined
      }
    }
    const refresh = (): void => {
      clearTimeout(timer)
      timer = undefined
      pending = undefined
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        if (active) latest.current()
      })
    }
    const changed = (event?: LiteratureChangedEvent): void => {
      if (!isCollectionOnlyChange(event)) return refresh()
      if (queued) return // A full invalidation already covers this change.
      pending = {
        revision: event!.revision,
        collectionIds: [...new Set([...(pending?.collectionIds ?? []), ...event!.collectionIds!])]
      }
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        const event = pending
        pending = undefined
        if (active) latest.current(event)
      }, 100)
    }
    const visible = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    const remove = window.api?.literature?.onChanged?.(changed)
    const removeProjectDeleted = window.api?.projects?.onDeleted?.(refresh)
    const removeProjectCleanup = window.api?.projects?.onDeletionCleanupChanged?.(refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('open-science:web-events-open', refresh)
    return () => {
      active = false
      consume.current = () => {}
      clearTimeout(timer)
      remove?.()
      removeProjectDeleted?.()
      removeProjectCleanup?.()
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('open-science:web-events-open', refresh)
    }
  }, [])
  return consumePendingCollection
}
