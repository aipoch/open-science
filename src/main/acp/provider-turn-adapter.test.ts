import type { PromptResponse } from '@agentclientprotocol/sdk'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type {
  AcpProviderTurnAdapter,
  AcpProviderTurnBeginInput,
  AcpProviderTurnFinalizationInput,
  AcpProviderTurnProbe,
  AcpProviderTurnResult
} from './provider-turn-adapter'

type IfEquals<Left, Right, Yes = Left, No = never> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? Yes
    : No

type WritableKeys<Value> = {
  [Key in keyof Value]-?: IfEquals<
    { [Property in Key]: Value[Key] },
    { -readonly [Property in Key]: Value[Key] },
    Key
  >
}[keyof Value]

describe('ACP provider turn adapter interface', () => {
  it('exposes only the turn-scoped probe lifecycle', () => {
    expectTypeOf<keyof AcpProviderTurnAdapter>().toEqualTypeOf<'begin'>()
    expectTypeOf<keyof AcpProviderTurnProbe>().toEqualTypeOf<'observe' | 'finalize' | 'cancel'>()
  })

  it('keeps inputs and normalized results immutable', () => {
    expectTypeOf<WritableKeys<AcpProviderTurnBeginInput>>().toEqualTypeOf<never>()
    expectTypeOf<WritableKeys<AcpProviderTurnFinalizationInput>>().toEqualTypeOf<never>()
    expectTypeOf<WritableKeys<AcpProviderTurnResult>>().toEqualTypeOf<never>()
    expectTypeOf<
      WritableKeys<NonNullable<AcpProviderTurnResult['turnUsage']>>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      'turnCount' extends keyof NonNullable<AcpProviderTurnResult['turnUsage']> ? true : false
    >().toEqualTypeOf<false>()
  })

  it('supports optional observation, cancellation, and best-effort missing facts', async () => {
    const cancel = vi.fn()
    const adapter: AcpProviderTurnAdapter = {
      begin: ({ providerSessionId, cwd }) => {
        expect(providerSessionId).toBe('provider-session-1')
        expect(cwd).toBe('/workspace')
        return {
          finalize: ({ response }) => {
            expect(response.stopReason).toBe('end_turn')
            return {}
          },
          cancel
        }
      }
    }

    const finalizedProbe = await adapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    const result = await finalizedProbe.finalize({
      response: { stopReason: 'end_turn' } as PromptResponse
    })

    expect(result).toEqual({})
    expect(finalizedProbe.observe).toBeUndefined()

    const cancelledProbe = await adapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    await cancelledProbe.cancel()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('normalizes complete usage, model-turn, and context facts without provider payloads', async () => {
    const observe = vi.fn()
    const adapter: AcpProviderTurnAdapter = {
      begin: async () => ({
        observe,
        finalize: async () => ({
          turnUsage: {
            inputTokens: 10,
            cacheTokens: 4,
            cachedReadTokens: 3,
            cachedWriteTokens: 1,
            outputTokens: 2
          },
          modelTurnCount: 3,
          contextUsedTokens: 14
        }),
        cancel: async () => undefined
      })
    }

    const probe = await adapter.begin({
      providerSessionId: 'provider-session-1',
      cwd: '/workspace'
    })
    const observation = { sessionId: 'provider-session-1', message: { type: 'result' } }
    probe.observe?.(observation)

    await expect(
      probe.finalize({ response: { stopReason: 'end_turn' } as PromptResponse })
    ).resolves.toEqual({
      turnUsage: {
        inputTokens: 10,
        cacheTokens: 4,
        cachedReadTokens: 3,
        cachedWriteTokens: 1,
        outputTokens: 2
      },
      modelTurnCount: 3,
      contextUsedTokens: 14
    })
    expect(observe).toHaveBeenCalledWith(observation)
  })
})
