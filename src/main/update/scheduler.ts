import type { UpdateStrategy } from './strategy'
import { MAC_INSTALLATION_RESUME_UPDATE_ARG } from '../../shared/mac-installation'

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

// Checks once at startup, then every `intervalMs`. The strategy swallows its own errors (status:error),
// so a failed check never becomes an uncaught rejection or nags the user. Returns a stop function.
export const startUpdateScheduler = (
  strategy: UpdateStrategy,
  intervalMs: number = SIX_HOURS_MS
): (() => void) => {
  void strategy.check().then((status) => {
    if (process.argv.includes(MAC_INSTALLATION_RESUME_UPDATE_ARG) && status.state === 'available') {
      return strategy.download()
    }
    return undefined
  })
  const timer = setInterval(() => void strategy.check(), intervalMs)
  return () => clearInterval(timer)
}
