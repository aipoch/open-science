import { expect, it } from 'vitest'
import { restoreRRandomState } from './r-random-replay'
import { rRandomStateSchema } from '../../shared/notebook-execution-context'

const snapshot = {
  state: 'available',
  kinds: ["L'Ecuyer-CMRG", 'Inversion', 'Rejection'],
  seed: [10407, 1, 2, 3, 4, 5, 6]
}

it('restores a bounded native RNG snapshot and preserves legacy source', () => {
  expect(restoreRRandomState('cat(runif(3))', snapshot)).toContain('10407L,1L,2L,3L,4L,5L,6L')
  expect(restoreRRandomState('cat(runif(3))', snapshot)).toMatch(/cat\(runif\(3\)\)$/)
  expect(restoreRRandomState('cat(runif(3))', undefined)).toBe('cat(runif(3))')
})

it.each([
  { ...snapshot, seed: [10407, 1] },
  { ...snapshot, seed: Array(10000).fill(1) },
  { ...snapshot, seed: [10407, 1, 2, 3, 4, 5, 'system("bad")'] },
  { ...snapshot, seed: [10403, 1, 2, 3, 4, 5, 6] },
  {
    ...snapshot,
    kinds: ["L'Ecuyer-CMRG", 'Box-Muller', 'Rejection'],
    seed: [10207, 1, 2, 3, 4, 5, 6]
  }
])('rejects invalid or incompletely recoverable RNG state', (value) => {
  expect(rRandomStateSchema.safeParse(value).success).toBe(false)
  expect(() => restoreRRandomState('cat(1)', value)).toThrow('invalid')
})

it('does not silently ignore an explicitly unavailable snapshot', () => {
  expect(() =>
    restoreRRandomState('cat(1)', {
      state: 'unavailable',
      reason: 'unsupported-rng'
    })
  ).toThrow('unsupported-rng')
})
