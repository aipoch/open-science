import { describe, expect, it } from 'vitest'

import { toCodexTurnTokenUsage } from './codex-turn-usage'

describe('Codex turn token usage', () => {
  it("preserves the pinned adapter's already-exclusive input and cache categories", () => {
    expect(
      toCodexTurnTokenUsage({
        totalTokens: 110,
        inputTokens: 60,
        cachedReadTokens: 40,
        outputTokens: 10
      })
    ).toEqual({
      inputTokens: 60,
      cacheTokens: 40,
      cachedReadTokens: 40,
      cachedWriteTokens: 0,
      outputTokens: 10
    })

    expect(
      toCodexTurnTokenUsage({
        totalTokens: 110,
        inputTokens: 40,
        cachedReadTokens: 40,
        cachedWriteTokens: 20,
        outputTokens: 10
      })
    ).toEqual({
      inputTokens: 40,
      cacheTokens: 60,
      cachedReadTokens: 40,
      cachedWriteTokens: 20,
      outputTokens: 10
    })
  })

  it('keeps a valid cache-heavy response instead of subtracting cache twice', () => {
    expect(
      toCodexTurnTokenUsage({
        totalTokens: 32_212,
        inputTokens: 174,
        cachedReadTokens: 32_000,
        outputTokens: 38
      })
    ).toEqual({
      inputTokens: 174,
      cacheTokens: 32_000,
      cachedReadTokens: 32_000,
      cachedWriteTokens: 0,
      outputTokens: 38
    })
  })
})
