import type { PromptResponse } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import {
  ACP_MODEL_CALL_USAGE_META_KEY,
  ACP_MODEL_TURN_COUNT_META_KEY,
  ACP_TURN_TOKEN_USAGE_META_KEY
} from '../../shared/acp'
import { createCodexTurnAdapter } from './codex-turn-adapter'

describe('Codex turn adapter', () => {
  it('normalizes the whole-turn usage metadata through the provider turn interface', async () => {
    const probe = await createCodexTurnAdapter().begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    const response = {
      stopReason: 'end_turn',
      _meta: {
        [ACP_TURN_TOKEN_USAGE_META_KEY]: {
          totalTokens: 110,
          inputTokens: 40,
          cachedReadTokens: 40,
          cachedWriteTokens: 20,
          outputTokens: 10
        }
      }
    } satisfies PromptResponse

    expect(await probe.finalize({ response })).toEqual({
      turnUsage: {
        inputTokens: 40,
        cacheTokens: 60,
        cachedReadTokens: 40,
        cachedWriteTokens: 20,
        outputTokens: 10
      }
    })
  })

  it('falls back to terminal response usage when whole-turn metadata is missing', async () => {
    const probe = await createCodexTurnAdapter().begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    const response = {
      stopReason: 'max_tokens',
      usage: {
        totalTokens: 32_212,
        inputTokens: 174,
        cachedReadTokens: 32_000,
        outputTokens: 38
      }
    } satisfies PromptResponse

    expect(await probe.finalize({ response })).toMatchObject({
      turnUsage: {
        inputTokens: 174,
        cacheTokens: 32_000,
        cachedReadTokens: 32_000,
        cachedWriteTokens: 0,
        outputTokens: 38
      }
    })
  })

  it('reports the managed adapter model-turn count separately from token usage', async () => {
    const probe = await createCodexTurnAdapter().begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    const response = {
      stopReason: 'end_turn',
      _meta: { [ACP_MODEL_TURN_COUNT_META_KEY]: 3 }
    } satisfies PromptResponse

    expect(await probe.finalize({ response })).toEqual({ modelTurnCount: 3 })
  })

  it('publishes managed per-request metadata when it proves complete call coverage', async () => {
    const probe = await createCodexTurnAdapter().begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    const response = {
      stopReason: 'end_turn',
      _meta: {
        [ACP_MODEL_TURN_COUNT_META_KEY]: 2,
        [ACP_TURN_TOKEN_USAGE_META_KEY]: {
          inputTokens: 31,
          cachedReadTokens: 8,
          outputTokens: 6
        },
        [ACP_MODEL_CALL_USAGE_META_KEY]: [
          { inputTokens: 12, cachedReadTokens: 3, outputTokens: 3 },
          { inputTokens: 19, cachedReadTokens: 5, outputTokens: 3 }
        ]
      }
    } satisfies PromptResponse

    expect(await probe.finalize({ response })).toMatchObject({
      modelTurnCount: 2,
      modelCalls: [
        { inputTokens: 12, cacheTokens: 3, outputTokens: 3 },
        { inputTokens: 19, cacheTokens: 5, outputTokens: 3 }
      ]
    })
  })

  it('uses terminal usage as one exact call only when the reported count proves one request', async () => {
    const probe = await createCodexTurnAdapter().begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    const response = {
      stopReason: 'end_turn',
      usage: { totalTokens: 18, inputTokens: 12, cachedReadTokens: 3, outputTokens: 3 },
      _meta: { [ACP_MODEL_TURN_COUNT_META_KEY]: 1 }
    } satisfies PromptResponse

    expect(await probe.finalize({ response })).toMatchObject({
      modelTurnCount: 1,
      modelCalls: [{ inputTokens: 12, cacheTokens: 3, outputTokens: 3 }]
    })
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3'])(
    'omits the invalid model-turn count %s',
    async (modelTurnCount) => {
      const probe = await createCodexTurnAdapter().begin({
        providerSessionId: 'provider-session-1',
        cwd: '/workspace'
      })
      const response = {
        stopReason: 'end_turn',
        _meta: { [ACP_MODEL_TURN_COUNT_META_KEY]: modelTurnCount }
      } satisfies PromptResponse

      expect(await probe.finalize({ response })).toEqual({})
    }
  )

  it('recombines uncached and cached-read input for the exact context numerator', async () => {
    const probe = await createCodexTurnAdapter().begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    const response = {
      stopReason: 'end_turn',
      usage: {
        totalTokens: 32_712,
        inputTokens: 174,
        cachedReadTokens: 32_000,
        cachedWriteTokens: 500,
        outputTokens: 38
      },
      _meta: {
        [ACP_TURN_TOKEN_USAGE_META_KEY]: {
          totalTokens: 110,
          inputTokens: 60,
          cachedReadTokens: 40,
          outputTokens: 10
        }
      }
    } satisfies PromptResponse

    expect(await probe.finalize({ response })).toEqual({
      turnUsage: {
        inputTokens: 60,
        cacheTokens: 40,
        cachedReadTokens: 40,
        cachedWriteTokens: 0,
        outputTokens: 10
      },
      contextUsedTokens: 32_174,
      lastModelStepUsage: {
        inputTokens: 174,
        cacheTokens: 32_500,
        cachedReadTokens: 32_000,
        cachedWriteTokens: 500,
        outputTokens: 38
      }
    })
  })

  it('omits an unsafe context numerator without discarding otherwise valid usage', async () => {
    const probe = await createCodexTurnAdapter().begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    const response = {
      stopReason: 'end_turn',
      usage: {
        totalTokens: Number.MAX_SAFE_INTEGER,
        inputTokens: Number.MAX_SAFE_INTEGER,
        cachedReadTokens: 1,
        outputTokens: 0
      }
    } satisfies PromptResponse

    expect(await probe.finalize({ response })).toEqual({
      turnUsage: {
        inputTokens: Number.MAX_SAFE_INTEGER,
        cacheTokens: 1,
        cachedReadTokens: 1,
        cachedWriteTokens: 0,
        outputTokens: 0
      },
      lastModelStepUsage: {
        inputTokens: Number.MAX_SAFE_INTEGER,
        cacheTokens: 1,
        cachedReadTokens: 1,
        cachedWriteTokens: 0,
        outputTokens: 0
      }
    })
  })

  it('publishes terminal facts at most once and closes cancelled probes', async () => {
    const input = { providerSessionId: 'provider-session-1', cwd: '/workspace' }
    const response = {
      stopReason: 'end_turn',
      _meta: { [ACP_MODEL_TURN_COUNT_META_KEY]: 2 }
    } satisfies PromptResponse
    const cancelledProbe = await createCodexTurnAdapter().begin(input)
    const finalizedProbe = await createCodexTurnAdapter().begin(input)

    await cancelledProbe.cancel()
    expect(await cancelledProbe.finalize({ response })).toEqual({})
    expect(await finalizedProbe.finalize({ response })).toEqual({ modelTurnCount: 2 })
    expect(await finalizedProbe.finalize({ response })).toEqual({})
  })

  it('keeps the raw terminal response caller-owned and returns no provider payload', async () => {
    const probe = await createCodexTurnAdapter().begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    const response = {
      stopReason: 'refusal',
      usage: {
        totalTokens: 12,
        inputTokens: 7,
        cachedReadTokens: 2,
        outputTokens: 3
      },
      _meta: { quota: { remaining: 42 } }
    } satisfies PromptResponse
    const originalResponse = structuredClone(response)

    const result = await probe.finalize({ response })

    expect(response).toEqual(originalResponse)
    expect(result).not.toHaveProperty('response')
    expect(probe.observe).toBeUndefined()
    expect(await probe.cancel()).toBeUndefined()
  })
})
