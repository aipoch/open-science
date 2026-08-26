import { describe, expect, it } from 'vitest'

import { sanitizeAcpModelCallUsage, toAcpTurnTokenUsage } from './acp'

describe('ACP turn token usage', () => {
  it('preserves cache details only when the agent reports both read and write categories', () => {
    expect(
      toAcpTurnTokenUsage({
        totalTokens: 160,
        inputTokens: 100,
        cachedReadTokens: 30,
        cachedWriteTokens: 20,
        outputTokens: 10
      })
    ).toEqual({
      inputTokens: 100,
      cacheTokens: 50,
      cachedReadTokens: 30,
      cachedWriteTokens: 20,
      outputTokens: 10
    })

    expect(
      toAcpTurnTokenUsage({
        totalTokens: 140,
        inputTokens: 100,
        cachedReadTokens: 30,
        outputTokens: 10
      })
    ).toEqual({ inputTokens: 100, cacheTokens: 30, outputTokens: 10 })
  })

  it('normalizes model-call identities before durable projection', () => {
    const call = {
      id: '  call-1  ',
      index: 0,
      sourceInvocationId: '   ',
      inputTokens: 4,
      cacheTokens: 2,
      outputTokens: 3
    }

    expect(sanitizeAcpModelCallUsage(call)).toEqual({
      id: 'call-1',
      index: 0,
      inputTokens: 4,
      cacheTokens: 2,
      outputTokens: 3
    })
    expect(sanitizeAcpModelCallUsage({ ...call, id: '   ' })).toBeUndefined()
  })
})
