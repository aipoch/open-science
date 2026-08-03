import { describe, expect, it } from 'vitest'

import { createLogoParticles, resolveLogoFrame } from './open-science-logo-motion'

describe('OpenScience logo motion', () => {
  it('moves through gather, hold, release, and field phases in one loop', () => {
    expect(resolveLogoFrame(0, 4800, false).mode).toBe('gather')
    expect(resolveLogoFrame(2016, 4800, false)).toEqual({ mode: 'hold', progress: 1 })
    expect(resolveLogoFrame(2784, 4800, false).mode).toBe('release')
    expect(resolveLogoFrame(4128, 4800, false).mode).toBe('field')
  })

  it('resolves to a static complete logo when reduced motion is requested', () => {
    expect(resolveLogoFrame(0, 4800, true)).toEqual({ mode: 'hold', progress: 1 })
    expect(resolveLogoFrame(2400, 4800, true)).toEqual({ mode: 'hold', progress: 1 })
  })

  it('creates a deterministic particle field for a given canvas and seed', () => {
    const metrics = { width: 448, height: 448, dpr: 2 }

    const first = createLogoParticles(metrics, 42)
    const second = createLogoParticles(metrics, 42)
    const different = createLogoParticles(metrics, 43)

    expect(first).toHaveLength(1512)
    expect(second).toEqual(first)
    expect(different).not.toEqual(first)
  })
})
