import { useEffect, useState } from 'react'
import { resultId, type SearchResult } from './search-result'

// Only visible project/session rows need totals; keep their metadata requests bounded.
const loadCounts = async (
  targets: { key: string; projectId: string; sessionId?: string }[],
  active: () => boolean,
  onCount: (key: string, count: number | null) => void
): Promise<void> => {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(4, targets.length) }, async () => {
      while (active() && next < targets.length) {
        const target = targets[next++]!
        try {
          const page = target.sessionId
            ? await window.api.projectFiles.searchArtifacts({
                primaryProjectIds: [target.projectId],
                otherProjectIds: [],
                source: 'all',
                sessionId: target.sessionId,
                primaryLimit: 1,
                otherLimit: 0
              })
            : await window.api.projectFiles.getOverview({ projectId: target.projectId })
          if (active())
            onCount(
              target.key,
              page.isIndexComplete
                ? 'primary' in page
                  ? page.primary.totalCount
                  : page.totalCount
                : null
            )
        } catch {
          if (active()) onCount(target.key, null)
        }
      }
    })
  )
}

export const useSearchSummaryCounts = (
  open: boolean,
  results: SearchResult[]
): Record<string, number | null> => {
  const [counts, setCounts] = useState<Record<string, number | null>>({})
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
    let active = true
    void loadCounts(
      JSON.parse(key),
      () => active,
      (id, count) => setCounts((state) => (state[id] === count ? state : { ...state, [id]: count }))
    )
    return () => {
      active = false
    }
  }, [key])
  return counts
}
