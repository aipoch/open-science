import { useEffect, useEffectEvent, useRef } from 'react'

// Count only time spent unpaused. Owner identity resets a notice; callback changes do not.
export const useNoticeCountdown = (
  durationMs: number | undefined | (() => number),
  paused: boolean,
  onExpire: () => void,
  resetKey: unknown = durationMs
): void => {
  const remaining = useRef<number | undefined>(undefined)
  const duration = useEffectEvent(() =>
    typeof durationMs === 'function' ? durationMs() : durationMs
  )
  const expire = useEffectEvent(onExpire)
  useEffect(() => {
    remaining.current = duration()
  }, [resetKey])
  useEffect(() => {
    if (paused || remaining.current === undefined) return
    const startedAt = Date.now()
    const timeout = window.setTimeout(expire, Math.max(0, remaining.current))
    return () => {
      window.clearTimeout(timeout)
      if (remaining.current !== undefined) {
        remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt))
      }
    }
  }, [paused, resetKey])
}
