import { describe, expect, it } from 'vitest'

import { classifyStartupDelay } from './startup-delay'

describe('classifyStartupDelay', () => {
  it('omits sub-millisecond intervals', () => {
    expect(classifyStartupDelay(0, 0)).toBeUndefined()
    expect(classifyStartupDelay(0.4, 0.1)).toBeUndefined()
  })

  it('labels mostly off-CPU time as io-or-wait', () => {
    expect(classifyStartupDelay(120_000, 4_000)).toEqual({
      waitMs: 116_000,
      delayKind: 'io-or-wait'
    })
  })

  it('labels mostly on-CPU time as cpu', () => {
    expect(classifyStartupDelay(80, 76)).toEqual({ waitMs: 4, delayKind: 'cpu' })
  })

  it('labels balanced intervals as mixed', () => {
    expect(classifyStartupDelay(1000, 500)).toEqual({ waitMs: 500, delayKind: 'mixed' })
  })
})
