import { describe, expect, expectTypeOf, it } from 'vitest'

import { isTerminalProvisionPhase, type ProvisionProgress } from './notebook-env'

describe('ProvisionProgress contract', () => {
  it('rejects arbitrary progress phases at compile time', () => {
    const progress: ProvisionProgress = {
      // @ts-expect-error progress phases crossing IPC are a closed protocol
      phase: 'arbitrary-future-phase',
      progress: 0
    }
    expectTypeOf(progress).toMatchTypeOf<ProvisionProgress>()
  })

  it('classifies terminal phases through the exhaustive protocol helper', () => {
    expect(isTerminalProvisionPhase('fetch-python')).toBe(false)
    expect(isTerminalProvisionPhase('done')).toBe(true)
    expect(isTerminalProvisionPhase('error')).toBe(true)
  })
})
