import type { PromptResponse, SessionNotification } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { codeBuddyTurnAdapter } from './codebuddy-turn-adapter'

const usageUpdate = (
  messageId: string,
  usage: Record<string, unknown>,
  sessionId = 'provider-session-1'
): SessionNotification => ({
  sessionId,
  update: {
    sessionUpdate: 'usage_update',
    used: 0,
    size: 128_000,
    _meta: {
      'codebuddy.ai/messageId': messageId,
      usage
    }
  }
})

describe('CodeBuddy turn adapter', () => {
  it('sums every model call into turn usage and keeps the last call as context usage', async () => {
    const probe = await codeBuddyTurnAdapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })

    probe.observe?.(
      usageUpdate('message-1', {
        prompt_tokens: 120,
        prompt_tokens_details: { cached_tokens: 20 },
        completion_tokens: 10,
        total_tokens: 130
      })
    )
    probe.observe?.(
      usageUpdate('message-2', {
        prompt_tokens: 180,
        prompt_tokens_details: { cached_tokens: 50 },
        completion_tokens: 15,
        total_tokens: 195
      })
    )

    expect(probe.finalize({ response: { stopReason: 'end_turn' } as PromptResponse })).toEqual({
      turnUsage: {
        inputTokens: 230,
        cacheTokens: 70,
        cachedReadTokens: 70,
        cachedWriteTokens: 0,
        outputTokens: 25
      },
      modelTurnCount: 2,
      modelCalls: [
        {
          inputTokens: 100,
          cacheTokens: 20,
          cachedReadTokens: 20,
          cachedWriteTokens: 0,
          outputTokens: 10,
          sourceInvocationId: 'message-1'
        },
        {
          inputTokens: 130,
          cacheTokens: 50,
          cachedReadTokens: 50,
          cachedWriteTokens: 0,
          outputTokens: 15,
          sourceInvocationId: 'message-2'
        }
      ],
      contextUsedTokens: 180,
      lastModelStepUsage: {
        inputTokens: 130,
        cacheTokens: 50,
        cachedReadTokens: 50,
        cachedWriteTokens: 0,
        outputTokens: 15
      }
    })
  })

  it('replaces duplicate message snapshots and ignores unrelated or malformed usage', async () => {
    const probe = await codeBuddyTurnAdapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })

    probe.observe?.(usageUpdate('message-1', { prompt_tokens: 10, completion_tokens: 2 }))
    probe.observe?.(usageUpdate('message-1', { prompt_tokens: 12, completion_tokens: 3 }))
    probe.observe?.(
      usageUpdate('other-message', { prompt_tokens: 1_000, completion_tokens: 1_000 }, 'other')
    )
    probe.observe?.(usageUpdate('', { prompt_tokens: 1_000, completion_tokens: 1_000 }))
    probe.observe?.(usageUpdate('invalid', { prompt_tokens: 5, completion_tokens: -1 }))

    expect(probe.finalize({ response: { stopReason: 'end_turn' } as PromptResponse })).toEqual({
      turnUsage: {
        inputTokens: 12,
        cacheTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        outputTokens: 3
      },
      modelTurnCount: 1,
      modelCalls: [
        {
          inputTokens: 12,
          cacheTokens: 0,
          cachedReadTokens: 0,
          cachedWriteTokens: 0,
          outputTokens: 3,
          sourceInvocationId: 'message-1'
        }
      ],
      contextUsedTokens: 12,
      lastModelStepUsage: {
        inputTokens: 12,
        cacheTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        outputTokens: 3
      }
    })
  })

  it('drops turn-scoped model usage after cancellation', async () => {
    const probe = await codeBuddyTurnAdapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    probe.observe?.(usageUpdate('message-1', { prompt_tokens: 10, completion_tokens: 2 }))

    await probe.cancel()
    probe.observe?.(usageUpdate('message-2', { prompt_tokens: 20, completion_tokens: 4 }))

    expect(probe.finalize({ response: { stopReason: 'cancelled' } as PromptResponse })).toEqual({})
  })
})
