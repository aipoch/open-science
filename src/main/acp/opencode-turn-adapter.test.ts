import type { PromptResponse } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import { AcpOpenCodeTurnAdapter } from './opencode-turn-adapter'
import type { OpenCodeUsageSnapshot } from './opencode-turn-usage'

describe('ACP OpenCode turn adapter', () => {
  it('verifies 2.x compaction from SDK-compatible metadata when usage is unavailable', async () => {
    const adapter = new AcpOpenCodeTurnAdapter(vi.fn(async () => undefined))
    const probe = await adapter.begin({ providerSessionId: 'session', cwd: '/workspace' })
    for (const status of ['started', 'completed'])
      probe.observe?.({
        sessionId: 'session',
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { 'opencode/compaction': { status, messageId: 'summary', reason: 'manual' } }
        }
      })
    expect(await probe.finalize({ response: { stopReason: 'end_turn' } })).toEqual({
      compaction: { succeeded: true }
    })
  })

  it('ignores replayed, unrelated, unpaired and cancelled 2.x compaction notifications', async () => {
    const snapshot = { assistantMessageIds: new Set(['old']), usageByMessageId: new Map() }
    const probe = await new AcpOpenCodeTurnAdapter(async () => snapshot).begin({
      providerSessionId: 'session',
      cwd: '/workspace'
    })
    const notify = (sessionId: string, messageId: string, status: string): void =>
      probe.observe?.({
        sessionId,
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { 'opencode/compaction': { messageId, status } }
        }
      })
    notify('session', 'old', 'started')
    notify('session', 'old', 'completed')
    notify('other', 'new', 'started')
    notify('other', 'new', 'completed')
    notify('session', 'unpaired', 'completed')
    expect(await probe.finalize({ response: { stopReason: 'end_turn' } })).toEqual({})
    const cancelled = await new AcpOpenCodeTurnAdapter(async () => undefined).begin({
      providerSessionId: 'session',
      cwd: '/workspace'
    })
    cancelled.cancel?.()
    cancelled.observe?.({
      sessionId: 'session',
      update: {
        sessionUpdate: 'session_info_update',
        _meta: {
          'opencode/compaction': { messageId: 'new', status: 'failed', error: { message: 'late' } }
        }
      }
    })
    expect(await cancelled.finalize({ response: { stopReason: 'cancelled' } })).toEqual({})
  })

  it('ignores historical compaction errors and returns only the current summary outcome', async () => {
    const before = { assistantMessageIds: new Set(['old']), usageByMessageId: new Map() }
    const after = {
      assistantMessageIds: new Set(['old', 'new']),
      usageByMessageId: new Map(),
      compactionByMessageId: new Map([
        ['old', { succeeded: false, error: 'old failure' }],
        ['new', { succeeded: true }]
      ])
    }
    const adapter = new AcpOpenCodeTurnAdapter(
      vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after)
    )
    const probe = await adapter.begin({ providerSessionId: 'session', cwd: '/workspace' })
    expect(await probe.finalize({ response: { stopReason: 'end_turn' } })).toEqual({
      compaction: { succeeded: true }
    })
  })

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
          contextUsedTokens: 15
        },
        {
          sourceInvocationId: 'step-2',
          inputTokens: 19,
          cacheTokens: 5,
          cachedReadTokens: 4,
          cachedWriteTokens: 1,
          outputTokens: 3,
          contextUsedTokens: 24
        }
      ],
      contextUsedTokens: 24,
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
