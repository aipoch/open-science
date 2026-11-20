import type { UpdateStrategy } from './strategy'
import { MAC_INSTALLATION_RESUME_UPDATE_ARG } from '../../shared/mac-installation'

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

// Checks once at startup, then every `intervalMs`. The strategy swallows its own errors (status:error),
// so a failed check never becomes an uncaught rejection or nags the user. Returns a stop function.
export const startUpdateScheduler = (
  strategy: UpdateStrategy,
  intervalMs: number = SIX_HOURS_MS,
  background?: { isInBackground(): boolean; canDownload(bytes: number): Promise<boolean> }
): (() => void) => {
  let stopped = false
  void strategy.check().then((status) => {
    if (
      !stopped &&
      process.argv.includes(MAC_INSTALLATION_RESUME_UPDATE_ARG) &&
      status.state === 'available'
    ) {
      return strategy.download()
    }
    return undefined
  })
  const timer = setInterval(() => void strategy.check(), intervalMs)
  let probing = false
  const considerDownload = async (): Promise<void> => {
    if (probing || !background || !strategy.downloadInBackground || !background.isInBackground())
      return
    const offer = strategy.getBackgroundDownloadOffer?.()
    if (!offer?.latest || !offer.totalBytes) return
    probing = true
    try {
      if (
        (await background.canDownload(offer.totalBytes)) &&
        !stopped &&
        background.isInBackground() &&
        strategy.getBackgroundDownloadOffer?.() === offer
      ) {
        await strategy.downloadInBackground(offer.latest)
      }
    } finally {
      probing = false
    }
  }
  const backgroundTimer = background
    ? setInterval(() => void considerDownload(), 60_000)
    : undefined
  return () => {
    stopped = true
    clearInterval(timer)
    clearInterval(backgroundTimer)
  }
}
