import { describe, expect, it } from 'vitest'
import { piTurnAdapter } from './pi-turn-adapter'

const begin = (): ReturnType<typeof piTurnAdapter.begin> =>
  piTurnAdapter.begin({ providerSessionId: 'pi-1', cwd: '/workspace' })
const stop = { response: { stopReason: 'end_turn' as const } }
type NativeMessage = {
  sessionId: string
  update: {
    sessionUpdate: string
    messageId: string
    _meta: { pi: { event: string; usage: unknown } }
  }
}
const notification = (
  messageId = 'message-1',
  usage: unknown = {
    input: 100,
    output: 10,
    cacheRead: 20,
    cacheWrite: 5
  }
): NativeMessage => ({
  sessionId: 'pi-1',
  update: {
    sessionUpdate: 'agent_message_chunk',
    messageId,
    _meta: { pi: { event: 'assistant_message', usage } }
  }
})

describe('Pi native model-call observation', () => {
  it.each([
    undefined,
    null,
    {},
    { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 },
    { input: 1.5, output: 1, cacheRead: 0, cacheWrite: 0 },
    { input: 1, output: Number.NaN, cacheRead: 0, cacheWrite: 0 },
    { input: 1, output: 1, cacheRead: 0 },
    { input: Number.MAX_SAFE_INTEGER, output: 1, cacheRead: 1, cacheWrite: 0 }
  ])('does not invent counts from absent or invalid usage (%j)', async (usage) => {
    const probe = await begin()
    const event = notification()
    event.update._meta.pi.usage = usage
    probe.observe?.(event)
    expect(await probe.finalize(stop)).toEqual({})
  })

  it('ignores other sessions, non-native events and missing message identities', async () => {
    const probe = await begin()
    probe.observe?.({ ...notification(), sessionId: 'other-session' })
    const otherEvent = notification()
    otherEvent.update._meta.pi.event = 'tool_call'
    probe.observe?.(otherEvent)
    probe.observe?.(notification(''))
    expect(await probe.finalize(stop)).toEqual({})
  })

  it('isolates consecutive resumed prompts even when their native message ids match', async () => {
    for (let turn = 0; turn < 2; turn += 1) {
      const probe = await begin()
      probe.observe?.(notification())
      probe.observe?.(notification())
      const result = await probe.finalize(stop)
      expect(result.modelTurnCount).toBe(1)
      expect(result.modelCalls).toHaveLength(1)
      expect(result.contextUsedTokens).toBe(125)
      expect(await probe.finalize(stop)).toEqual({})
      probe.observe?.(notification('late-message'))
      expect(await probe.finalize(stop)).toEqual({})
    }
  })

  it('discards cancelled observations and ignores later provider updates', async () => {
    const probe = await begin()
    probe.observe?.(notification())
    await probe.cancel()
    probe.observe?.(notification('after-cancel'))
    expect(await probe.finalize(stop)).toEqual({})
  })

  it('rejects aggregate overflow instead of publishing unsafe token totals', async () => {
    const probe = await begin()
    const usage = { input: Number.MAX_SAFE_INTEGER, output: 1, cacheRead: 0, cacheWrite: 0 }
    probe.observe?.(notification('first', usage))
    probe.observe?.(notification('second', usage))
    expect(await probe.finalize(stop)).toEqual({})
  })
})
