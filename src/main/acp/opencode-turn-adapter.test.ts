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

  it('returns a framework Session title only when OpenCode changes it during the turn', async () => {
    const readUsageSnapshot = vi.fn(async () => undefined)
    const readSessionTitle = vi
      .fn()
      .mockResolvedValueOnce('Explain ACP session naming')
      .mockResolvedValueOnce('ACP Session Naming Explained')
    const adapter = new AcpOpenCodeTurnAdapter(readUsageSnapshot, readSessionTitle)

    const probe = await adapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })

    await expect(
      probe.finalize({ response: { stopReason: 'end_turn' } as PromptResponse })
    ).resolves.toEqual({ frameworkSessionTitle: 'ACP Session Naming Explained' })
    expect(readSessionTitle).toHaveBeenNthCalledWith(1, 'provider-session-1', '/workspace')
    expect(readSessionTitle).toHaveBeenNthCalledWith(
      2,
      'provider-session-1',
      '/workspace',
      expect.any(AbortSignal)
    )
  })

  it('waits briefly when OpenCode title generation finishes after the provider turn', async () => {
    const readSessionTitle = vi
      .fn()
      .mockResolvedValueOnce('Explain ACP session naming')
      .mockResolvedValueOnce('Explain ACP session naming')
      .mockResolvedValueOnce('ACP Session Naming Explained')
    const adapter = new AcpOpenCodeTurnAdapter(async () => undefined, readSessionTitle, {
      titlePollIntervalMs: 0,
      titlePollDeadlineMs: 100
    })

    const probe = await adapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })

    await expect(
      probe.finalize({ response: { stopReason: 'end_turn' } as PromptResponse })
    ).resolves.toEqual({ frameworkSessionTitle: 'ACP Session Naming Explained' })
    expect(readSessionTitle).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['unchanged', ['Prompt fallback', 'Prompt fallback']],
    ['blank after', ['Prompt fallback', '   ']],
    ['missing baseline', [undefined, 'Prompt fallback']]
  ])('does not publish a %s Session title snapshot', async (_case, titles) => {
    const readSessionTitle = vi
      .fn()
      .mockResolvedValueOnce(titles[0])
      .mockResolvedValueOnce(titles[1])
    const adapter = new AcpOpenCodeTurnAdapter(async () => undefined, readSessionTitle, {
      titlePollDeadlineMs: 0
    })

    const probe = await adapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })

    await expect(
      probe.finalize({ response: { stopReason: 'end_turn' } as PromptResponse })
    ).resolves.toEqual({})
  })

  it('keeps title lookup failures best-effort without losing usage facts', async () => {
    const snapshots: OpenCodeUsageSnapshot[] = [
      { assistantMessageIds: new Set(), usageByMessageId: new Map() },
      {
        assistantMessageIds: new Set(['step-1']),
        usageByMessageId: new Map([['step-1', { inputTokens: 4, cacheTokens: 1, outputTokens: 2 }]])
      }
    ]
    const readSessionTitle = vi.fn().mockRejectedValue(new Error('loopback unavailable'))
    const adapter = new AcpOpenCodeTurnAdapter(async () => snapshots.shift(), readSessionTitle, {
      titlePollDeadlineMs: 0
    })

    const probe = await adapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })

    await expect(
      probe.finalize({ response: { stopReason: 'end_turn' } as PromptResponse })
    ).resolves.toMatchObject({
      turnUsage: { inputTokens: 4, cacheTokens: 1, outputTokens: 2 },
      modelTurnCount: 1
    })
  })

  it('bounds a hanging native title request without failing the provider turn', async () => {
    const readSessionTitle = vi
      .fn()
      .mockResolvedValueOnce('Prompt fallback')
      .mockImplementationOnce(
        async (_providerSessionId: string, _cwd: string, signal?: AbortSignal) =>
          new Promise<string | undefined>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
      )
    const adapter = new AcpOpenCodeTurnAdapter(async () => undefined, readSessionTitle, {
      titlePollDeadlineMs: 5,
      titlePollIntervalMs: 0
    })

    const probe = await adapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })

    await expect(
      probe.finalize({ response: { stopReason: 'end_turn' } as PromptResponse })
    ).resolves.toEqual({})
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
