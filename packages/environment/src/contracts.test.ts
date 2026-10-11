import { describe, it, expect } from 'vitest'
import { packageToolFor } from './contracts'
describe('packageToolFor', () => {
  it('routes app-owned envs (any language) to micromamba', () => {
    expect(packageToolFor('python', true)).toBe('micromamba')
    expect(packageToolFor('r', true)).toBe('micromamba')
  })

  it("routes the user's own envs to their own pip / R library, never micromamba", () => {
    expect(packageToolFor('python', false)).toBe('pip')
    expect(packageToolFor('r', false)).toBe('r-library')
  })
})
