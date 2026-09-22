import { describe, expect, it } from 'vitest'
import { cancellationProjection } from './cancellation-feedback'
describe('cancellation operation projection', () => {
  const now = new Date('2026-09-21T12:00:00Z')
  const active = { phase: 'active', outcome: null, createdAt: now, updatedAt: now }
  it('reports a stalled queue and expired lease as failed without changing job execution', () => {
    expect(cancellationProjection(active, now.getTime() + 90_000)).toMatchObject({
      cancellation_status: 'cancel_failed',
      cancellation: { failureCode: 'timeout' }
    })
    expect(cancellationProjection({ ...active, claimExpiresAt: now }, now.getTime())).toMatchObject(
      { cancellation_status: 'cancel_failed' }
    )
  })
  it('only reports cancelled for a fulfilled operation', () => {
    expect(cancellationProjection({ ...active, phase: 'settled', outcome: 'superseded' })).toEqual({
      cancellation_status: undefined
    })
    expect(cancellationProjection({ ...active, phase: 'settled', outcome: 'fulfilled' })).toEqual({
      cancellation_status: 'cancelled'
    })
  })
})
