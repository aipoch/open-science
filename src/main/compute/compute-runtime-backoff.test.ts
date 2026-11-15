import { describe, expect, it } from 'vitest'
import { nextComputeRuntimeBackoff, nextComputeRuntimeWakeAfter } from './compute-runtime-backoff'

describe('compute runtime backoff', () => {
  it('doubles with bounded symmetric jitter', () => {
    expect(nextComputeRuntimeBackoff(undefined, 1_000, { random: () => 0.5 })).toEqual({
      delayMs: 2_500,
      retryAt: 3_500
    })
    expect(
      nextComputeRuntimeBackoff({ delayMs: 2_500, retryAt: 0 }, 1_000, { random: () => 0.5 })
    ).toEqual({ delayMs: 5_000, retryAt: 6_000 })
    expect(
      nextComputeRuntimeBackoff(undefined, 1_000, { jitterRatio: 1, random: () => 0.4 })
    ).toEqual({ delayMs: 2_000, retryAt: 3_000 })
  })

  it('returns the earliest retry wake', () => {
    expect(
      nextComputeRuntimeWakeAfter(
        [
          { delayMs: 1_000, retryAt: 8_000 },
          { delayMs: 2_000, retryAt: 4_000 }
        ],
        3_000
      )
    ).toBe(1_000)
    expect(nextComputeRuntimeWakeAfter([], 3_000)).toBeUndefined()
  })

  it('falls back to finite timing when inputs are invalid', () => {
    expect(
      nextComputeRuntimeBackoff({ delayMs: Number.NaN, retryAt: Number.NaN }, Number.NaN, {
        random: () => Number.NaN
      })
    ).toEqual({ delayMs: 2_500, retryAt: expect.any(Number) })
    expect(
      nextComputeRuntimeWakeAfter(
        [
          { delayMs: 1_000, retryAt: Number.NaN },
          { delayMs: 1_000, retryAt: 5_000 }
        ],
        4_000
      )
    ).toBe(1_000)
  })
})
