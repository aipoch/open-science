import { describe, expect, it } from 'vitest'
import {
  applyRunObservationChanges,
  type RunObservationChanges,
  type RunObservationSnapshot
} from './run-observation'

const initial: RunObservationSnapshot = {
  identity: { projectId: 'project', sessionId: 'session', operationId: 'operation' },
  cursor: { epoch: 'epoch', sequence: 0 },
  observedAt: 100,
  phase: 'preparing',
  stepId: 'operation:operation',
  run: null,
  artifacts: [],
  artifactsTruncated: false
}
const update: RunObservationChanges = {
  kind: 'delta',
  from: initial.cursor,
  cursor: { epoch: 'epoch', sequence: 2 },
  changes: [
    { cursor: { epoch: 'epoch', sequence: 1 }, observedAt: 101, phase: 'queued' },
    { cursor: { epoch: 'epoch', sequence: 2 }, observedAt: 102, phase: 'running' }
  ]
}
describe('applyRunObservationChanges', () => {
  it('applies contiguous changes and makes duplicate or overlapping deliveries idempotent', () => {
    const current = applyRunObservationChanges(initial, update)
    expect(current.phase).toBe('running')
    expect(applyRunObservationChanges(current, update)).toBe(current)
    const intermediate = {
      ...initial,
      cursor: { epoch: 'epoch', sequence: 1 },
      phase: 'queued' as const
    }
    expect(applyRunObservationChanges(intermediate, update)).toEqual(current)
    expect(initial.phase).toBe('preparing')
  })
  it('rejects missing changes, future starts, cursor gaps and foreign epochs', () => {
    for (const bad of [
      { ...update, changes: [] },
      { ...update, from: { epoch: 'epoch', sequence: 1 } },
      { ...update, changes: [update.changes[1]] },
      { ...update, from: { epoch: 'other', sequence: 0 } }
    ])
      expect(() => applyRunObservationChanges(initial, bad)).toThrow()
  })
  it('rejects a delta or resync that replaces a known execution identity', () => {
    const foreign = { ...initial.identity, operationId: 'foreign' }
    expect(() =>
      applyRunObservationChanges(initial, {
        ...update,
        changes: [{ ...update.changes[0], identity: foreign }, update.changes[1]]
      })
    ).toThrow('selected execution')
    expect(() =>
      applyRunObservationChanges(initial, {
        kind: 'resync',
        reason: 'epoch-changed',
        snapshot: { ...initial, identity: foreign }
      })
    ).toThrow('selected execution')
  })
  it('accepts a new epoch for the same execution and ignores an obsolete same-epoch resync', () => {
    const renewed = { ...initial, cursor: { epoch: 'renewed', sequence: 0 } }
    expect(
      applyRunObservationChanges(initial, {
        kind: 'resync',
        reason: 'epoch-changed',
        snapshot: renewed
      })
    ).toBe(renewed)
    const current = applyRunObservationChanges(initial, update)
    expect(
      applyRunObservationChanges(current, {
        kind: 'resync',
        reason: 'cursor-expired',
        snapshot: initial
      })
    ).toBe(current)
  })
})
