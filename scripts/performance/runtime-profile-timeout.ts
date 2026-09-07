// Startup, two Electron restarts, idle/recovery waits, and ACP setup on Windows CI.
const RUNTIME_PERFORMANCE_BASE_TIMEOUT_MS = 240_000
// Later soak cycles render every prior 90-chunk stress payload in one Session; 15s/cycle is not enough.
const RUNTIME_PERFORMANCE_PER_STRESS_CYCLE_TIMEOUT_MS = 90_000
const RUNTIME_PERFORMANCE_PROMPT_TIMEOUT_MS = 120_000

const runtimePerformanceTestTimeoutMs = (stressCycles: number): number => {
  if (!Number.isSafeInteger(stressCycles) || stressCycles < 1) {
    throw new Error('stressCycles must be a positive integer.')
  }
  return (
    RUNTIME_PERFORMANCE_BASE_TIMEOUT_MS +
    stressCycles * RUNTIME_PERFORMANCE_PER_STRESS_CYCLE_TIMEOUT_MS
  )
}

export { RUNTIME_PERFORMANCE_PROMPT_TIMEOUT_MS, runtimePerformanceTestTimeoutMs }
