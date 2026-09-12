import { useEffect, useState } from 'react'
import type { NotebookNetworkStatus } from '../../../../shared/notebook-network'

// The banner and R authorization controls must use the same readiness snapshot.
export const useNotebookNetworkStatus = (
  enabled = true,
  checkedAt: number | null = null
): NotebookNetworkStatus => {
  const [snapshot, setSnapshot] = useState<{
    checkedAt: number | null
    status: NotebookNetworkStatus
  }>({
    checkedAt,
    status: { kind: 'checking' }
  })
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let retry: number | undefined
    const refresh = (): void => {
      const getStatus = window.api.settings?.getNotebookNetworkStatus
      if (typeof getStatus !== 'function') {
        setSnapshot({ checkedAt, status: { kind: 'error', reason: 'runtimeFailure' } })
        return
      }
      void getStatus().then(
        (next) => {
          if (cancelled) return
          setSnapshot({ checkedAt, status: next })
          if (next.kind === 'checking') retry = window.setTimeout(refresh, 1_000)
        },
        () => {
          if (!cancelled)
            setSnapshot({ checkedAt, status: { kind: 'error', reason: 'runtimeFailure' } })
        }
      )
    }
    refresh()
    return () => {
      cancelled = true
      if (retry !== undefined) window.clearTimeout(retry)
    }
  }, [enabled, checkedAt])
  return enabled && snapshot.checkedAt === checkedAt ? snapshot.status : { kind: 'checking' }
}
