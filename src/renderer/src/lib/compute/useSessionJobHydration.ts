import { useCallback, useEffect, useRef } from 'react'

import { useSessionJobStore } from '@/stores/session-job-store'

const HYDRATION_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const

type SessionJobHydration = Readonly<{
  error: string | undefined
  retry: () => void
}>

// Owns bounded recovery for the active Session's full Job projection. Broadcast delivery and the
// cross-Session pending scan are independent fast paths; this hydrate repairs missed/out-of-order
// projections for visible cards and details.
export const useSessionJobHydration = (sessionId: string | undefined): SessionJobHydration => {
  const hydrate = useSessionJobStore((state) => state.hydrate)
  const error = useSessionJobStore((state) =>
    sessionId ? state.loadErrorBySession.get(sessionId) : undefined
  )
  const retryRef = useRef<() => void>(() => undefined)
  const retry = useCallback(() => retryRef.current(), [])

  useEffect(() => {
    if (!sessionId || typeof window.api?.compute?.jobsList !== 'function') return
    let active = true
    let running = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const run = (): void => {
      if (running) return
      running = true
      void hydrate(sessionId).finally(() => {
        running = false
        if (!active) return
        const failed = useSessionJobStore.getState().loadErrorBySession.has(sessionId)
        if (!failed) {
          attempt = 0
          return
        }
        if (attempt >= HYDRATION_RETRY_DELAYS_MS.length) return
        timer = setTimeout(() => {
          timer = undefined
          run()
        }, HYDRATION_RETRY_DELAYS_MS[attempt++])
      })
    }
    const retryNow = (): void => {
      if (timer) clearTimeout(timer)
      timer = undefined
      attempt = 0
      run()
    }

    retryRef.current = retryNow
    window.addEventListener('focus', retryNow)
    run()
    return () => {
      active = false
      retryRef.current = () => undefined
      window.removeEventListener('focus', retryNow)
      if (timer) clearTimeout(timer)
    }
  }, [hydrate, sessionId])

  return { error, retry }
}
