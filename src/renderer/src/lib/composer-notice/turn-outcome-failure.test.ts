import { describe, expect, it } from 'vitest'
import { presentTurnOutcomeFailure } from './turn-outcome-failure'

const oldProviderFailure =
  'Internal error: {"message":"供应商流式响应为空或未完整结束","code":400008}'

describe('presentTurnOutcomeFailure', () => {
  it('presents the stored ACP wrapper as a model service failure without modifying diagnostics', () => {
    const diagnostics = Object.freeze({ code: '-32603', raw: oldProviderFailure })
    const failure = Object.freeze({ category: 'internal' as const, diagnostics })
    expect(presentTurnOutcomeFailure({ failure })).toEqual({
      category: 'service',
      reason: 'service/response-interrupted',
      diagnostics
    })
    expect(failure.category).toBe('internal')
    expect(presentTurnOutcomeFailure({ error: oldProviderFailure }).reason).toBe(
      'service/response-interrupted'
    )
  })

  it.each([
    'Could not decode tool record 400008',
    oldProviderFailure.replace('400008', '400009'),
    'Internal error: {"code":400008,"message":"Tool history read failed"}',
    `${oldProviderFailure} trailing text`,
    oldProviderFailure.slice('Internal error: '.length)
  ])('does not relabel unrelated errors: %s', (error) => {
    expect(presentTurnOutcomeFailure({ error })).toEqual({
      category: 'internal',
      diagnostics: { raw: error }
    })
  })

  it('keeps an authoritative reason even if the provider wrapper is present', () => {
    const failure = {
      category: 'internal' as const,
      reason: 'internal/reconfigure' as const,
      diagnostics: { raw: oldProviderFailure }
    }
    expect(presentTurnOutcomeFailure({ failure })).toEqual(failure)
  })
})
