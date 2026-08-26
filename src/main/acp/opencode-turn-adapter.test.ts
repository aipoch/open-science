import type { PromptResponse } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import { AcpOpenCodeTurnAdapter } from './opencode-turn-adapter'
import type { OpenCodeUsageSnapshot } from './opencode-turn-usage'

describe('ACP OpenCode turn adapter', () => {
  it('captures one provider Session and cwd before and after the turn', async () => {
    const snapshots: OpenCodeUsageSnapshot[] = [
      {
        assistantMessageIds: new Set(['old']),
        usageByMessageId: new Map()
      },
      {
        assistantMessageIds: new Set(['old', 'step-1', 'step-2']),
        usageByMessageId: new Map([
          [
            'step-1',
            {
              inputTokens: 12,
              cacheTokens: 3,
              cachedReadTokens: 2,
              cachedWriteTokens: 1,
              outputTokens: 2
            }
          ],
          [
            'step-2',
            {
              inputTokens: 19,
              cacheTokens: 5,
              cachedReadTokens: 4,
              cachedWriteTokens: 1,
              outputTokens: 3
            }
          ]
        ])
      }
    ]
    const readUsageSnapshot = vi.fn(async () => snapshots.shift())
    const adapter = new AcpOpenCodeTurnAdapter(readUsageSnapshot)

    const probe = await adapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    const result = await probe.finalize({
      response: { stopReason: 'end_turn' } as PromptResponse
    })

    expect(readUsageSnapshot).toHaveBeenNthCalledWith(1, 'provider-session-1', '/workspace')
    expect(readUsageSnapshot).toHaveBeenNthCalledWith(2, 'provider-session-1', '/workspace')
    expect(result).toEqual({
      turnUsage: {
        inputTokens: 31,
        cacheTokens: 8,
        cachedReadTokens: 6,
        cachedWriteTokens: 2,
        outputTokens: 5
      },
      modelTurnCount: 2,
      modelCalls: [
        {
          sourceInvocationId: 'step-1',
          inputTokens: 12,
          cacheTokens: 3,
          cachedReadTokens: 2,
          cachedWriteTokens: 1,
          outputTokens: 2,
          contextUsedTokens: 14
        },
        {
          sourceInvocationId: 'step-2',
          inputTokens: 19,
          cacheTokens: 5,
          cachedReadTokens: 4,
          cachedWriteTokens: 1,
          outputTokens: 3,
          contextUsedTokens: 23
        }
      ],
      contextUsedTokens: 23,
      lastModelStepUsage: {
        inputTokens: 19,
        cacheTokens: 5,
        cachedReadTokens: 4,
        cachedWriteTokens: 1,
        outputTokens: 3
      }
    })
  })

  it('returns empty facts when the final usage snapshot fails', async () => {
    const readUsageSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        assistantMessageIds: new Set<string>(),
        usageByMessageId: new Map()
      })
      .mockRejectedValueOnce(new Error('loopback connection closed'))
    const adapter = new AcpOpenCodeTurnAdapter(readUsageSnapshot)

    const probe = await adapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })

    await expect(
      probe.finalize({ response: { stopReason: 'end_turn' } as PromptResponse })
    ).resolves.toEqual({})
  })

  it('returns empty facts when the baseline usage snapshot fails', async () => {
    const readUsageSnapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error('loopback connection closed'))
      .mockResolvedValueOnce({
        assistantMessageIds: new Set(['step-1']),
        usageByMessageId: new Map([
          ['step-1', { inputTokens: 12, cacheTokens: 3, outputTokens: 2 }]
        ])
      })
    const adapter = new AcpOpenCodeTurnAdapter(readUsageSnapshot)

    const probe = await adapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })

    await expect(
      probe.finalize({ response: { stopReason: 'end_turn' } as PromptResponse })
    ).resolves.toEqual({})
  })

  it('does not publish a partial delta when the baseline snapshot is missing', async () => {
    const readUsageSnapshot = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        assistantMessageIds: new Set(['step-1']),
        usageByMessageId: new Map([
          ['step-1', { inputTokens: 12, cacheTokens: 3, outputTokens: 2 }]
        ])
      })
    const adapter = new AcpOpenCodeTurnAdapter(readUsageSnapshot)

    const probe = await adapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })

    await expect(
      probe.finalize({ response: { stopReason: 'end_turn' } as PromptResponse })
    ).resolves.toEqual({})
  })

  it('drops the attempt snapshot when the probe is cancelled', async () => {
    const readUsageSnapshot = vi.fn(async () => ({
      assistantMessageIds: new Set<string>(),
      usageByMessageId: new Map()
    }))
    const adapter = new AcpOpenCodeTurnAdapter(readUsageSnapshot)
    const probe = await adapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })

    await probe.cancel()

    await expect(
      probe.finalize({ response: { stopReason: 'cancelled' } as PromptResponse })
    ).resolves.toEqual({})
    expect(readUsageSnapshot).toHaveBeenCalledTimes(1)
  })
})
