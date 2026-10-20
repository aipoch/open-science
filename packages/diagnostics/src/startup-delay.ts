export type StartupDelayKind = 'cpu' | 'io-or-wait' | 'mixed'

export type StartupDelayClassification = {
  waitMs: number
  delayKind: StartupDelayKind
}

// Classifies one timed interval when both wall time and CPU time are known. `io-or-wait` means the
// process spent most of the interval off-CPU (disk, antivirus, locks, or blocking syscalls) rather
// than executing JavaScript. Intervals under 1ms are omitted as timer noise.
export const classifyStartupDelay = (
  durationMs: number,
  cpuMs: number
): StartupDelayClassification | undefined => {
  if (!Number.isFinite(durationMs) || durationMs < 1) return undefined
  if (!Number.isFinite(cpuMs) || cpuMs < 0) return undefined
  const waitMs = Math.max(0, Math.round(durationMs - cpuMs))
  const waitShare = waitMs / durationMs
  const delayKind: StartupDelayKind =
    waitShare >= 0.75 ? 'io-or-wait' : waitShare <= 0.25 ? 'cpu' : 'mixed'
  return { waitMs, delayKind }
}
