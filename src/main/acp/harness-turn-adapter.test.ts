import { expect, it } from 'vitest'
import { harnessTurnAdapter } from './harness-turn-adapter'
import type { PromptResponse } from '@agentclientprotocol/sdk'

const finalize = async (requests: unknown): Promise<unknown> => {
  const probe = await harnessTurnAdapter.begin({ providerSessionId: 's', cwd: '/workspace' })
  return probe.finalize({
    response: {
      stopReason: 'end_turn',
      _meta: { 'open-science-agent/requests': requests }
    } as PromptResponse
  })
}
it('counts summary requests and leaves incomplete usage unknown', async () => {
  const requests = [
    {
      id: 'answer',
      status: 'completed',
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80 }
    },
    {
      id: 'summary',
      status: 'completed',
      usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 30 }
    }
  ]
  expect(await finalize(requests)).toMatchObject({
    modelTurnCount: 2,
    turnUsage: { inputTokens: 40, cacheTokens: 110, outputTokens: 15 },
    contextUsedTokens: 50
  })
  expect(await finalize([...requests, { id: 'unknown', status: 'completed' }])).toEqual({
    modelTurnCount: 3
  })
  expect(await finalize([requests[0], requests[0]])).toEqual({})
  expect(
    await finalize([
      { ...requests[0], usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 } }
    ])
  ).toEqual({ modelTurnCount: 1 })
})
