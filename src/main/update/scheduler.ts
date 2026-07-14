import type { UpdateService } from './service'

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

// Checks once at startup, then every `intervalMs`. The service swallows its own errors (status:error),
// so a failed check never becomes an uncaught rejection or nags the user. Returns a stop function.
export const startUpdateScheduler = (
  service: UpdateService,
  intervalMs: number = SIX_HOURS_MS
): (() => void) => {
  void service.check()
  const timer = setInterval(() => void service.check(), intervalMs)
  return () => clearInterval(timer)
}
