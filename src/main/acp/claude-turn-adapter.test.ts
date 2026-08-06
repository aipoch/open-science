import type { PromptResponse } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { claudeCodeTurnAdapter } from './claude-turn-adapter'

describe('Claude Code turn adapter', () => {
  it('returns generic ACP usage and the matching terminal SDK model-turn count', async () => {
    const probe = await claudeCodeTurnAdapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })

    probe.observe?.({
      sessionId: 'provider-session-1',
      message: {
        type: 'result',
        num_turns: 3,
        origin: { kind: 'human' }
      }
    })

    const result = await probe.finalize({
      response: {
        stopReason: 'end_turn',
        usage: {
          totalTokens: 60,
          inputTokens: 31,
          cachedReadTokens: 8,
          cachedWriteTokens: 7,
          outputTokens: 14
        }
      } as PromptResponse
    })

    expect(result).toEqual({
      turnUsage: {
        inputTokens: 31,
        cacheTokens: 15,
        cachedReadTokens: 8,
        cachedWriteTokens: 7,
        outputTokens: 14
      },
      modelTurnCount: 3
    })
  })

  it('sums user-driven results while excluding every autonomous Claude origin', async () => {
    const probe = await claudeCodeTurnAdapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    const observeResult = (numTurns: number, origin?: string): void =>
      probe.observe?.({
        sessionId: 'provider-session-1',
        message: {
          type: 'result',
          num_turns: numTurns,
          ...(origin === undefined ? {} : { origin: { kind: origin } })
        }
      })

    for (const origin of [
      'task-notification',
      'peer',
      'coordinator',
      'observer',
      'observer-activity'
    ]) {
      observeResult(100, origin)
    }
    observeResult(2, 'human')
    observeResult(3, 'future-user-lane')

    await expect(
      Promise.resolve(probe.finalize({ response: { stopReason: 'end_turn' } as PromptResponse }))
    ).resolves.toEqual({ modelTurnCount: 5 })
  })

  it('ignores stale Sessions and missing or malformed SDK result facts', async () => {
    const probe = await claudeCodeTurnAdapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    const observations: unknown[] = [
      undefined,
      null,
      [],
      {},
      { sessionId: 'provider-session-1' },
      { sessionId: 'provider-session-1', message: null },
      { sessionId: 'provider-session-1', message: [] },
      { sessionId: 'provider-session-1', message: { type: 'assistant', num_turns: 100 } },
      { sessionId: 'provider-session-1', message: { type: 'result' } },
      { sessionId: 'provider-session-1', message: { type: 'result', num_turns: 0 } },
      { sessionId: 'provider-session-1', message: { type: 'result', num_turns: -1 } },
      { sessionId: 'provider-session-1', message: { type: 'result', num_turns: 1.5 } },
      { sessionId: 'provider-session-1', message: { type: 'result', num_turns: '2' } },
      {
        sessionId: 'stale-provider-session',
        message: { type: 'result', num_turns: 100, origin: { kind: 'human' } }
      }
    ]

    for (const observation of observations) probe.observe?.(observation)
    probe.observe?.({
      sessionId: 'provider-session-1',
      message: { type: 'result', num_turns: 2 }
    })

    expect(
      await probe.finalize({ response: { stopReason: 'end_turn' } as PromptResponse })
    ).toEqual({ modelTurnCount: 2 })
  })

  it('drops turn-scoped observation when the probe is cancelled', async () => {
    const probe = await claudeCodeTurnAdapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    probe.observe?.({
      sessionId: 'provider-session-1',
      message: { type: 'result', num_turns: 2 }
    })

    await probe.cancel()
    probe.observe?.({
      sessionId: 'provider-session-1',
      message: { type: 'result', num_turns: 100 }
    })

    expect(
      await probe.finalize({
        response: {
          stopReason: 'end_turn',
          usage: { inputTokens: 3, outputTokens: 1 }
        } as PromptResponse
      })
    ).toEqual({})
  })
})
