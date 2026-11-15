export type ComputeRuntimeBackoffState = Readonly<{
  delayMs: number
  retryAt: number
}>

type BackoffOptions = Readonly<{
  baseMs?: number
  maxMs?: number
  jitterRatio?: number
  random?: () => number
}>

const DEFAULT_BASE_MS = 2_500
const DEFAULT_MAX_MS = 5 * 60_000
const DEFAULT_JITTER_RATIO = 0.2
const finiteNow = (now: number): number => (Number.isFinite(now) ? now : Date.now())

export const nextComputeRuntimeBackoff = (
  previous: ComputeRuntimeBackoffState | undefined,
  now: number,
  options: BackoffOptions = {}
): ComputeRuntimeBackoffState => {
  const finiteOr = (value: number | undefined, fallback: number): number =>
    value !== undefined && Number.isFinite(value) ? value : fallback
  const baseMs = Math.max(1, finiteOr(options.baseMs, DEFAULT_BASE_MS))
  const maxMs = Math.max(baseMs, finiteOr(options.maxMs, DEFAULT_MAX_MS))
  const jitterRatio = Math.max(0, Math.min(1, finiteOr(options.jitterRatio, DEFAULT_JITTER_RATIO)))
  const random = options.random ?? Math.random
  const previousDelay = previous && Number.isFinite(previous.delayMs) ? previous.delayMs : undefined
  const exponential = Math.min(maxMs, previousDelay === undefined ? baseMs : previousDelay * 2)
  const sample = finiteOr(random(), 0.5)
  const jitter = exponential * jitterRatio * (sample * 2 - 1)
  const delayMs = Math.max(1, Math.min(maxMs, Math.round(exponential + jitter)))
  return { delayMs, retryAt: finiteOr(now, Date.now()) + delayMs }
}

export const nextComputeRuntimeWakeAfter = (
  states: Iterable<ComputeRuntimeBackoffState>,
  now: number
): number | undefined => {
  let earliest: number | undefined
  for (const state of states) {
    if (!Number.isFinite(state.retryAt)) continue
    const delay = Math.max(0, state.retryAt - finiteNow(now))
    if (earliest === undefined || delay < earliest) earliest = delay
  }
  return earliest
}
