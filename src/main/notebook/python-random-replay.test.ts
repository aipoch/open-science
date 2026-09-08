import { expect, it } from 'vitest'
import { validatePythonRandomState } from './python-random-replay'
import { framePythonRequest } from './kernel-protocol'

const snapshot = {
  state: 'available' as const,
  standard: { words: [...Array<number>(624).fill(1), 624], gaussian: 0.7 },
  numpy: { words: Array<number>(624).fill(1), position: 9, hasGaussian: 1, gaussian: -0.3 }
}

it('sends bounded RNG metadata separately from unmodified Python source', () => {
  const source = 'from __future__ import annotations\nprint(1)'
  const state = validatePythonRandomState(snapshot)
  expect(JSON.parse(framePythonRequest('run', source, undefined, undefined, state))).toMatchObject({
    code: source,
    python_random_state: snapshot
  })
  expect(validatePythonRandomState(undefined)).toBeUndefined()
})

it.each([
  { ...snapshot, standard: { words: [1], gaussian: null } },
  { ...snapshot, standard: { words: [...Array<number>(624).fill(1), 625], gaussian: null } },
  { ...snapshot, standard: { ...snapshot.standard, gaussian: Infinity } },
  { ...snapshot, numpy: { ...snapshot.numpy, words: Array(10000).fill(1) } },
  { ...snapshot, numpy: { ...snapshot.numpy, position: -1 } },
  { ...snapshot, numpy: { ...snapshot.numpy, hasGaussian: 2 } },
  { ...snapshot, numpy: { ...snapshot.numpy, words: Array(624).fill('execute code') } },
  { ...snapshot, objects: { huge: 'not RNG metadata' } }
])('rejects malformed and oversized RNG metadata', (state) => {
  expect(() => validatePythonRandomState(state)).toThrow('invalid')
})

it('does not silently ignore explicitly unavailable state', () => {
  expect(() => validatePythonRandomState({ state: 'unavailable', reason: 'modified-rng' })).toThrow(
    'modified-rng'
  )
})
