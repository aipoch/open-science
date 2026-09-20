import { useLayoutEffect, useRef } from 'react'

// One subscription recipe for Literature consumers. The transport already owns replay/gap handling;
// focus and replay completion revalidate even when a client missed the original mutation event.
export const useLiteratureChanges = (invalidate: () => void): void => {
  const latest = useRef(invalidate)
  useLayoutEffect(() => {
    latest.current = invalidate
  })
  useLayoutEffect(() => {
    let active = true
    let queued = false
    const refresh = (): void => {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        if (active) latest.current()
      })
    }
    const visible = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    const remove = window.api?.literature?.onChanged?.(refresh)
    const removeProjectDeleted = window.api?.projects?.onDeleted?.(refresh)
    const removeProjectCleanup = window.api?.projects?.onDeletionCleanupChanged?.(refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('open-science:web-events-open', refresh)
    return () => {
      active = false
      remove?.()
      removeProjectDeleted?.()
      removeProjectCleanup?.()
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('open-science:web-events-open', refresh)
    }
  }, [])
}
