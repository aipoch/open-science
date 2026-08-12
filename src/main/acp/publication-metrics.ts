import { createLogger } from '../logger'

// Dev-facing counters for the acp:state trailing-edge coalescer (runtime-publication-owner.ts):
// before/after perf comparisons read them from the debug log line emitted per broadcast. Counting
// is two integer increments per event, so it stays on everywhere; the log line rides the existing
// logger level gating (debug is dev-only), leaving production unaffected.
const log = createLogger('acp')

let acpStateBroadcastsSent = 0
let acpStateBroadcastsSuppressed = 0

export const recordAcpStateBroadcastSuppressed = (): void => {
  acpStateBroadcastsSuppressed += 1
}

export const recordAcpStateBroadcastSent = (): void => {
  acpStateBroadcastsSent += 1
  // Throttled: streaming still emits ~one broadcast per frame, so log a periodic summary instead.
  if (acpStateBroadcastsSent % 100 === 0) {
    log.debug('acp:state broadcasts', {
      sent: acpStateBroadcastsSent,
      suppressed: acpStateBroadcastsSuppressed
    })
  }
}

export const getAcpStateBroadcastMetrics = (): Readonly<{
  sent: number
  suppressed: number
}> => ({ sent: acpStateBroadcastsSent, suppressed: acpStateBroadcastsSuppressed })

export const resetAcpStateBroadcastMetrics = (): void => {
  acpStateBroadcastsSent = 0
  acpStateBroadcastsSuppressed = 0
}
