import type { UpdateStrategy } from './strategy'

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

// Checks once at startup, then every `intervalMs`. The strategy swallows its own errors (status:error),
// so a failed check never becomes an uncaught rejection or nags the user. Returns a stop function.
export const startUpdateScheduler = (
  strategy: UpdateStrategy,
  intervalMs: number = SIX_HOURS_MS
): (() => void) => {
  void strategy.check()
  const timer = setInterval(() => void strategy.check(), intervalMs)
  return () => clearInterval(timer)
}
