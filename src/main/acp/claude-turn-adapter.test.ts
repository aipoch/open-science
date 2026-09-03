import type { PromptResponse } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import { claudeCodeTurnAdapter, createClaudeCodeTurnAdapter } from './claude-turn-adapter'

describe('Claude Code turn adapter', () => {
  it('returns generic ACP usage and the matching terminal SDK model-turn count', async () => {
    const probe = await claudeCodeTurnAdapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })

    probe.observe?.({
      sessionId: 'provider-session-1',
      message: {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          usage: {
            input_tokens: 12,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 2,
            output_tokens: 4
          }
        }
      }
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
      modelTurnCount: 3,
      lastModelStepUsage: {
        inputTokens: 12,
        cacheTokens: 32,
        cachedReadTokens: 30,
        cachedWriteTokens: 2,
        outputTokens: 4
      }
    })
  })

  it('keeps the latest top-level assistant usage and ignores subagent usage', async () => {
    const probe = await claudeCodeTurnAdapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    const observeAssistant = (
      inputTokens: number,
      cachedReadTokens: number,
      parentToolUseId: string | null
    ): void =>
      probe.observe?.({
        sessionId: 'provider-session-1',
        message: {
          type: 'assistant',
          parent_tool_use_id: parentToolUseId,
          message: {
            usage: {
              input_tokens: inputTokens,
              cache_read_input_tokens: cachedReadTokens,
              cache_creation_input_tokens: 3,
              output_tokens: 5
            }
          }
        }
      })

    observeAssistant(10, 20, null)
    observeAssistant(1_000, 2_000, 'tool-use-1')
    observeAssistant(14, 40, null)

    await expect(
      Promise.resolve(probe.finalize({ response: { stopReason: 'end_turn' } as PromptResponse }))
    ).resolves.toEqual({
      lastModelStepUsage: {
        inputTokens: 14,
        cacheTokens: 43,
        cachedReadTokens: 40,
        cachedWriteTokens: 3,
        outputTokens: 5
      }
    })
  })

  it('publishes exact top-level calls only when Claude count and aggregate usage prove coverage', async () => {
    const readTranscriptMessages = vi.fn(async () => [])
    const probe = await createClaudeCodeTurnAdapter({ readTranscriptMessages }).begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    const observeAssistant = (
      id: string,
      inputTokens: number,
      cachedReadTokens: number,
      cachedWriteTokens: number,
      outputTokens: number
    ): void =>
      probe.observe?.({
        sessionId: 'provider-session-1',
        message: {
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            id,
            usage: {
              input_tokens: inputTokens,
              cache_read_input_tokens: cachedReadTokens,
              cache_creation_input_tokens: cachedWriteTokens,
              output_tokens: outputTokens
            }
          }
        }
      })

    observeAssistant('claude-call-1', 10, 2, 1, 3)
    observeAssistant('claude-call-2', 20, 4, 2, 5)
    probe.observe?.({
      sessionId: 'provider-session-1',
      message: { type: 'result', num_turns: 2, origin: { kind: 'human' } }
    })

    await expect(
      Promise.resolve(
        probe.finalize({
          response: {
            stopReason: 'end_turn',
            usage: {
              inputTokens: 30,
              cachedReadTokens: 6,
              cachedWriteTokens: 3,
              outputTokens: 8
            }
          } as PromptResponse
        })
      )
    ).resolves.toMatchObject({
      modelTurnCount: 2,
      modelCalls: [
        {
          sourceInvocationId: 'claude-call-1',
          inputTokens: 10,
          cacheTokens: 3,
          cachedReadTokens: 2,
          cachedWriteTokens: 1,
          outputTokens: 3
        },
        {
          sourceInvocationId: 'claude-call-2',
          inputTokens: 20,
          cacheTokens: 6,
          cachedReadTokens: 4,
          cachedWriteTokens: 2,
          outputTokens: 5
        }
      ]
    })
    expect(readTranscriptMessages).not.toHaveBeenCalled()
  })

  it('publishes exact calls from repeated provider messages that omit the parent tool id', async () => {
    const probe = await claudeCodeTurnAdapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })

    for (let index = 1; index <= 7; index += 1) {
      const observation = {
        sessionId: 'provider-session-1',
        message: {
          type: 'assistant',
          message: {
            id: `provider-call-${index}`,
            usage: {
              input_tokens: index,
              cache_read_input_tokens: index,
              cache_creation_input_tokens: 0,
              output_tokens: index
            }
          }
        }
      }
      probe.observe?.(observation)
      probe.observe?.(observation)
    }
    probe.observe?.({
      sessionId: 'provider-session-1',
      message: { type: 'result', num_turns: 7, origin: { kind: 'human' } }
    })

    const result = await probe.finalize({
      response: {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 28,
          cachedReadTokens: 28,
          cachedWriteTokens: 0,
          outputTokens: 28
        }
      } as PromptResponse
    })

    expect(result.modelTurnCount).toBe(7)
    expect(result.modelCalls).toHaveLength(7)
    expect(result.modelCalls?.map((call) => call.sourceInvocationId)).toEqual(
      Array.from({ length: 7 }, (_, index) => `provider-call-${index + 1}`)
    )
  })

  it('recovers finalized calls after a transient incomplete MiniMax-M3 transcript read', async () => {
    const transcriptMessages = [
      ['minimax-call-1', 32_837, 128, 116],
      ['minimax-call-2', 1_195, 33_024, 66],
      ['minimax-call-3', 898, 34_176, 23]
    ].flatMap(([id, inputTokens, cachedReadTokens, outputTokens]) => {
      const message = {
        id,
        usage: {
          input_tokens: inputTokens,
          cache_read_input_tokens: cachedReadTokens,
          cache_creation_input_tokens: 0,
          output_tokens: outputTokens
        }
      }
      return [
        { type: 'assistant', parent_tool_use_id: null, message },
        { type: 'assistant', parent_tool_use_id: null, message }
      ]
    })
    const readTranscriptMessages = vi
      .fn()
      .mockRejectedValueOnce(new SyntaxError('Unexpected end of JSON input'))
      .mockResolvedValue(transcriptMessages)
    const adapter = createClaudeCodeTurnAdapter({ readTranscriptMessages })
    const probe = await adapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })

    for (const id of ['minimax-call-1', 'minimax-call-2', 'minimax-call-3']) {
      const observation = {
        sessionId: 'provider-session-1',
        message: {
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            id,
            usage: {
              input_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              output_tokens: 0
            }
          }
        }
      }
      probe.observe?.(observation)
      probe.observe?.(observation)
    }
    probe.observe?.({
      sessionId: 'provider-session-1',
      message: { type: 'result', num_turns: 3, origin: { kind: 'human' } }
    })

    const result = await probe.finalize({
      response: {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 34_930,
          cachedReadTokens: 67_328,
          cachedWriteTokens: 0,
          outputTokens: 205
        }
      } as PromptResponse
    })

    expect(result.modelCalls).toEqual([
      {
        sourceInvocationId: 'minimax-call-1',
        inputTokens: 32_837,
        cacheTokens: 128,
        cachedReadTokens: 128,
        cachedWriteTokens: 0,
        outputTokens: 116
      },
      {
        sourceInvocationId: 'minimax-call-2',
        inputTokens: 1_195,
        cacheTokens: 33_024,
        cachedReadTokens: 33_024,
        cachedWriteTokens: 0,
        outputTokens: 66
      },
      {
        sourceInvocationId: 'minimax-call-3',
        inputTokens: 898,
        cacheTokens: 34_176,
        cachedReadTokens: 34_176,
        cachedWriteTokens: 0,
        outputTokens: 23
      }
    ])
    expect(readTranscriptMessages).toHaveBeenCalledWith({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    expect(readTranscriptMessages).toHaveBeenCalledTimes(2)
  })

  it('rejects conflicting usage replayed under the same provider call id', async () => {
    const probe = await claudeCodeTurnAdapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    const observeAssistant = (inputTokens: number): void =>
      probe.observe?.({
        sessionId: 'provider-session-1',
        message: {
          type: 'assistant',
          message: {
            id: 'provider-call-1',
            usage: {
              input_tokens: inputTokens,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              output_tokens: 1
            }
          }
        }
      })

    observeAssistant(1)
    observeAssistant(2)
    probe.observe?.({
      sessionId: 'provider-session-1',
      message: { type: 'result', num_turns: 1, origin: { kind: 'human' } }
    })

    const result = await probe.finalize({
      response: {
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 }
      } as PromptResponse
    })

    expect(result.modelTurnCount).toBe(1)
    expect(result.modelCalls).toBeUndefined()
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
