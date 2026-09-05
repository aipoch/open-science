import { describe, expect, it } from 'vitest'

import { SessionPlanInteractionOwner } from './session-plan-interaction-owner'

describe('SessionPlanInteractionOwner', () => {
  it('resolves only the current Artifact Version interaction', () => {
    const owner = new SessionPlanInteractionOwner()

    owner.register({
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      interactionId: 'interaction-1'
    })

    expect(owner.interactionIdFor('session-1', 'version-1')).toBe('interaction-1')
    expect(owner.interactionIdFor('session-1', 'stale-version')).toBeUndefined()
  })

  it('does not release a replacement interaction through a stale Artifact Version', () => {
    const owner = new SessionPlanInteractionOwner()
    owner.register({
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      interactionId: 'interaction-1'
    })
    owner.register({
      sessionId: 'session-1',
      artifactVersionId: 'version-2',
      interactionId: 'interaction-2'
    })

    owner.release('session-1', 'version-1')

    expect(owner.interactionIdFor('session-1', 'version-2')).toBe('interaction-2')
    expect(owner.release('session-1', 'version-2')).toBe(true)
    expect(owner.interactionIdFor('session-1', 'version-2')).toBeUndefined()
  })

  it('authorizes an Agent decision only for one exact Artifact Version and interaction', () => {
    const owner = new SessionPlanInteractionOwner()

    owner.authorizeAgentDecision({
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      interactionSequence: 7
    })

    expect(
      owner.isAgentDecisionAuthorized({
        sessionId: 'session-1',
        artifactVersionId: 'version-1',
        interactionSequence: 7
      })
    ).toBe(true)
    expect(
      owner.isAgentDecisionAuthorized({
        sessionId: 'session-1',
        artifactVersionId: 'version-2',
        interactionSequence: 7
      })
    ).toBe(false)
    expect(
      owner.consumeAgentDecisionAuthorization({
        sessionId: 'session-1',
        artifactVersionId: 'version-1',
        interactionSequence: 7
      })
    ).toBe(true)
    expect(
      owner.consumeAgentDecisionAuthorization({
        sessionId: 'session-1',
        artifactVersionId: 'version-1',
        interactionSequence: 7
      })
    ).toBe(false)
  })

  it('invalidates Agent decision correlation on Plan replacement and exact interaction release', () => {
    const owner = new SessionPlanInteractionOwner()
    owner.authorizeAgentDecision({
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      interactionSequence: 7
    })

    expect(owner.releaseAgentDecisionAuthorization('session-1', 6)).toBe(false)
    owner.register({
      sessionId: 'session-1',
      artifactVersionId: 'version-2',
      interactionId: 'interaction-2'
    })
    expect(
      owner.isAgentDecisionAuthorized({
        sessionId: 'session-1',
        artifactVersionId: 'version-1',
        interactionSequence: 7
      })
    ).toBe(false)

    owner.authorizeAgentDecision({
      sessionId: 'session-1',
      artifactVersionId: 'version-2',
      interactionSequence: 8
    })
    expect(owner.releaseAgentDecisionAuthorization('session-1', 7)).toBe(false)
    expect(owner.releaseAgentDecisionAuthorization('session-1', 8)).toBe(true)
  })

  it('settles a parked approval exactly once', async () => {
    const owner = new SessionPlanInteractionOwner()
    const approval = owner.parkApproval('session-1', 'interaction-1')

    expect(owner.approvalInteractionIdFor('session-1')).toBe('interaction-1')
    expect(() => owner.parkApproval('session-1', 'interaction-2')).toThrow(
      expect.objectContaining({
        name: 'PlanCommandError',
        code: 'approval-already-pending'
      })
    )
    expect(owner.resolveApproval('session-1', { decision: 'approved' })).toBe(true)
    expect(owner.resolveApproval('session-1', { decision: 'rejected' })).toBe(false)
    await expect(approval).resolves.toEqual({ decision: 'approved' })
  })

  it('reserves approval generation atomically before parking becomes visible', async () => {
    const owner = new SessionPlanInteractionOwner()

    owner.reserveApproval('session-1', 'interaction-1')

    expect(owner.approvalInteractionIdFor('session-1')).toBeUndefined()
    expect(() => owner.reserveApproval('session-1', 'interaction-2')).toThrow(
      expect.objectContaining({
        name: 'PlanCommandError',
        code: 'approval-already-pending'
      })
    )
    expect(() => owner.parkApproval('session-1', 'interaction-2')).toThrow(
      expect.objectContaining({
        name: 'PlanCommandError',
        code: 'approval-already-pending'
      })
    )
    const approval = owner.parkReservedApproval('session-1', 'interaction-1')
    expect(owner.approvalInteractionIdFor('session-1')).toBe('interaction-1')
    owner.resolveApproval('session-1', { decision: 'approved' })
    await expect(approval).resolves.toEqual({ decision: 'approved' })
  })

  it('releases a failed approval generation reservation for retry', () => {
    const owner = new SessionPlanInteractionOwner()
    owner.reserveApproval('session-1', 'interaction-1')

    expect(owner.releaseApprovalReservation('session-1', 'interaction-1')).toBe(true)
    expect(owner.releaseApprovalReservation('session-1', 'interaction-1')).toBe(false)
    expect(() => owner.parkReservedApproval('session-1', 'interaction-1')).toThrow(
      'The Session Plan approval reservation is no longer available.'
    )
    expect(() => owner.reserveApproval('session-1', 'interaction-2')).not.toThrow()
  })

  it('rejects a parked approval exactly once', async () => {
    const owner = new SessionPlanInteractionOwner()
    const approval = owner.parkApproval('session-1', 'interaction-1')
    const rejected = approval.catch((error) => error)

    expect(owner.rejectApproval('session-1', 'approval cancelled')).toBe(true)
    expect(owner.rejectApproval('session-1', 'duplicate cleanup')).toBe(false)
    await expect(rejected).resolves.toMatchObject({ message: 'approval cancelled' })
  })

  it('clears every live row and rejects a parked approval for a Session', async () => {
    const owner = new SessionPlanInteractionOwner()
    owner.register({
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      interactionId: 'interaction-1'
    })
    const approval = owner.parkApproval('session-1', 'interaction-1')
    const rejected = expect(approval).rejects.toThrow('interaction was deleted')

    owner.clearSession('session-1', 'The Session Plan interaction was deleted.')

    await rejected
    expect(owner.interactionIdFor('session-1', 'version-1')).toBeUndefined()
    expect(owner.rejectApproval('session-1', 'duplicate cleanup')).toBe(false)
  })

  it('clears every Session when a generation disconnects', async () => {
    const owner = new SessionPlanInteractionOwner()
    owner.register({
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      interactionId: 'interaction-1'
    })
    const first = owner.parkApproval('session-1', 'interaction-1').catch((error) => error)
    const second = owner.parkApproval('session-2', 'interaction-2').catch((error) => error)

    owner.clearAll('The Session Plan interaction was disconnected.')

    await expect(first).resolves.toMatchObject({
      message: 'The Session Plan interaction was disconnected.'
    })
    await expect(second).resolves.toMatchObject({
      message: 'The Session Plan interaction was disconnected.'
    })
    expect(owner.interactionIdFor('session-1', 'version-1')).toBeUndefined()
  })
})
