import { describe, expect, it } from 'vitest'

import { resolveCustomTokenLimits } from './provider-token-limits'

describe('provider token limits', () => {
  it('preserves omitted values, replaces supplied values, and clears explicit nulls', () => {
    expect(
      resolveCustomTokenLimits(
        { type: 'custom', contextWindow: null, maxOutputTokens: 32_000 },
        { contextWindow: 200_000, maxInputTokens: 160_000, maxOutputTokens: 64_000 }
      )
    ).toEqual({ maxInputTokens: 160_000, maxOutputTokens: 32_000 })
  })

  it.each(['contextWindow', 'maxInputTokens', 'maxOutputTokens'] as const)(
    'rejects an invalid %s value',
    (field) => {
      expect(() => resolveCustomTokenLimits({ type: 'custom', [field]: 0 })).toThrowError(
        /positive whole number of tokens/
      )
    }
  )
})
