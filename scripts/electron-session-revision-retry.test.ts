import { describe, expect, it, vi } from 'vitest'

import { retrySessionRevisionConflict } from '../e2e/fixtures/session-revision-retry'
import { SessionRevisionConflictError } from '../src/shared/session-persistence'

describe('direct fixture session updates', () => {
  it('reloads after a concurrent save and preserves the newly persisted output', async () => {
    let durable = { revision: 14, branch: 'source', messages: ['prompt'] }
    const revisions: number[] = []
    const operation = vi.fn(async () => {
      const snapshot = structuredClone(durable)
      revisions.push(snapshot.revision)
      if (revisions.length === 1) {
        durable = { ...durable, revision: 15, messages: ['prompt', 'late reply'] }
      }
      if (snapshot.revision !== durable.revision) {
        throw new SessionRevisionConflictError(snapshot.revision, durable.revision)
      }
      durable = { ...snapshot, branch: 'other', revision: snapshot.revision + 1 }
    })

    await retrySessionRevisionConflict(operation)

    expect(revisions).toEqual([14, 15])
    expect(durable).toEqual({ revision: 16, branch: 'other', messages: ['prompt', 'late reply'] })
  })

  it('propagates non-conflict failures without retrying', async () => {
    const error = new Error('Message response target is invalid.')
    const operation = vi.fn().mockRejectedValue(error)
    await expect(retrySessionRevisionConflict(operation)).rejects.toBe(error)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('fails when competing saves exhaust the bounded attempts', async () => {
    const error = new SessionRevisionConflictError(14, 15)
    const operation = vi.fn().mockRejectedValue(error)
    await expect(retrySessionRevisionConflict(operation)).rejects.toBe(error)
    expect(operation).toHaveBeenCalledTimes(5)
  })
})
