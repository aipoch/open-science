import { describe, expect, it } from 'vitest'
import {
  RUNTIME_PERFORMANCE_PROMPT_TIMEOUT_MS,
  runtimePerformanceTestTimeoutMs
} from './runtime-profile-timeout'

describe('runtime performance timeout budget', () => {
  it('gives smoke and soak journeys enough time for later slower stress cycles', () => {
    // Smoke: 4 min base + 1.5 min for one Session/Notebook cycle.
    expect(runtimePerformanceTestTimeoutMs(1)).toBe(330_000)
    // Soak: six accumulating streamed turns on Windows CI need ~13 minutes, not 4.5.
    expect(runtimePerformanceTestTimeoutMs(6)).toBe(780_000)
    expect(RUNTIME_PERFORMANCE_PROMPT_TIMEOUT_MS).toBe(120_000)
  })

  it('rejects a non-positive cycle count', () => {
    expect(() => runtimePerformanceTestTimeoutMs(0)).toThrow(/positive integer/)
    expect(() => runtimePerformanceTestTimeoutMs(1.5)).toThrow(/positive integer/)
  })
})
