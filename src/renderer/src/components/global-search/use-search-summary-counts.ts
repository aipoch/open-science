import { useEffect, useRef, useState } from 'react'
import { resultId, type SearchResult } from './search-result'

type Target = { key: string; projectId: string; sessionId?: string }
type Entry = Target & { pending?: boolean; count?: number | null }

// One queue per open dialog bounds reads even when pagination or invalidation arrives mid-request.
export const useSearchSummaryCounts = (
  open: boolean,
  results: SearchResult[]
): Record<string, number | null> => {
  const [counts, setCounts] = useState<Record<string, number | null>>({})
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    setCounts({})
  }
  const updateTargets = useRef<(targets: Target[]) => void>(() => {})
  const key = JSON.stringify(
    open
      ? results.flatMap((result) =>
          result.kind === 'projects'
            ? [{ key: resultId(result), projectId: result.item.id }]
            : result.kind === 'sessions'
              ? [
                  {
                    key: resultId(result),
                    projectId: result.item.projectId,
                    sessionId: result.item.id
                  }
                ]
              : []
        )
      : []
  )
  useEffect(() => {
    if (!open) return
    let active = true
    let running = 0
    const entries = new Map<string, Entry>()
    let queue: Entry[] = []
    let next = 0
    const drain = (): void => {
      if (!active) return
      while (running < 4) {
        const entry = queue[next++]
        if (!entry) break
        if (entries.get(entry.key) !== entry || entry.pending || entry.count !== undefined) continue
        entry.pending = true
        running++
        void (async () => {
          let count: number | null = null
          try {
            const page = entry.sessionId
              ? await window.api.projectFiles.searchArtifacts({
                  primaryProjectIds: [entry.projectId],
                  otherProjectIds: [],
                  source: 'all',
                  sessionId: entry.sessionId,
                  primaryLimit: 1,
                  otherLimit: 0
                })
              : await window.api.projectFiles.getOverview({ projectId: entry.projectId })
            if (page.isIndexComplete)
              count = 'primary' in page ? page.primary.totalCount : page.totalCount
          } catch {
            // Unavailable totals are omitted, never presented as an authoritative zero.
          }
          if (active && entries.get(entry.key) === entry) {
            entry.count = count
            setCounts((state) =>
              state[entry.key] === count ? state : { ...state, [entry.key]: count }
            )
          }
          running--
          drain()
        })()
      }
    }
    const schedule = (): void => {
      queue = [...entries.values()].filter((entry) => !entry.pending && entry.count === undefined)
      next = 0
      drain()
    }
    updateTargets.current = (targets) => {
      const keys = new Set(targets.map((target) => target.key))
      for (const key of entries.keys()) if (!keys.has(key)) entries.delete(key)
      for (const target of targets) if (!entries.has(target.key)) entries.set(target.key, target)
      setCounts((state) =>
        Object.keys(state).some((key) => !keys.has(key))
          ? Object.fromEntries(Object.entries(state).filter(([key]) => keys.has(key)))
          : state
      )
      schedule()
    }
    const invalidate = (projectId?: string): void => {
      const invalidated = new Set<string>()
      for (const [key, entry] of entries) {
        if (projectId !== undefined && entry.projectId !== projectId) continue
        // Replace the entry so an older in-flight read cannot publish after the event.
        entries.set(key, { key, projectId: entry.projectId, sessionId: entry.sessionId })
        invalidated.add(key)
      }
      if (!invalidated.size) return
      setCounts((state) =>
        Object.fromEntries(Object.entries(state).filter(([key]) => !invalidated.has(key)))
      )
      schedule()
    }
    const refresh = (): void => invalidate()
    const visible = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    const unsubscribe = window.api.projectFiles.onChanged?.((event) => invalidate(event.projectId))
    // Remote event replay and returning to a hidden window may reveal missed file changes.
    window.addEventListener('open-science:web-events-open', refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', visible)
    return () => {
      active = false
      entries.clear()
      updateTargets.current = () => {}
      unsubscribe?.()
      window.removeEventListener('open-science:web-events-open', refresh)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [open])
  useEffect(() => {
    if (open) updateTargets.current(JSON.parse(key) as Target[])
  }, [open, key])
  return counts
}
