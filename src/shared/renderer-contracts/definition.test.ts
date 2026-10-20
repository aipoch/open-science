import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  callable,
  composeRendererApiContract,
  value,
  type RendererApiFromContract
} from './definition'

describe('typed renderer contract composition', () => {
  it('preserves insertion order, draft identity and optional API members across capabilities', () => {
    const first = { 'feature.run': callable<(id: string) => Promise<number>>()('feature', ['run']) }
    const second = {
      'optional.listen': callable<(listener: () => void) => () => void>()('optional', ['listen'], {
        optionalRoot: true,
        optionalMember: true
      }),
      platform: value<string>()('platform')
    }
    const contract = composeRendererApiContract(first, second)
    expect(Object.keys(contract)).toEqual(['feature.run', 'optional.listen', 'platform'])
    expect(contract['feature.run']).toBe(first['feature.run'])
    expect(Object.isFrozen(contract)).toBe(true)
    type Api = RendererApiFromContract<typeof contract>
    expectTypeOf<Api['feature']['run']>().toEqualTypeOf<(id: string) => Promise<number>>()
    expectTypeOf<Api['platform']>().toEqualTypeOf<string>()
    expectTypeOf<Api['optional']>().toEqualTypeOf<
      { listen?: (listener: () => void) => () => void } | undefined
    >()
  })

  it('rejects duplicate paths before a later capability can overwrite the first', () => {
    const first = { 'feature.run': callable<() => void>()('feature', ['first']) }
    const second = { 'feature.run': callable<() => void>()('other', ['second']) }
    expect(() => composeRendererApiContract(first, second)).toThrow(
      'Duplicate renderer contract path: feature.run'
    )
  })
})
