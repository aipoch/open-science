import { describe, expect, it } from 'vitest'

import type {
  SessionPlanDelivery,
  SessionPlanRuntimeContext
} from '../../shared/session-persistence'
import { matchPlanDelivery, matchesPlanDelivery } from './plan-delivery'

const plan = (
  approval: SessionPlanRuntimeContext['approval'],
  delivery: SessionPlanDelivery,
  reviewFeedbackMessageId?: string
): SessionPlanRuntimeContext => ({
  artifactId: 'artifact-1',
  artifactVersionId: 'version-1',
  artifactChecksum: 'checksum-1',
  originatingPromptMessageId: 'plan-origin',
  approval,
  ...(reviewFeedbackMessageId ? { reviewFeedbackMessageId } : {}),
  delivery,
  stepStatuses: {}
})

const delivery = (
  kind: SessionPlanDelivery['kind'],
  originatingPromptMessageId = kind === 'review-feedback' ? 'feedback-origin' : 'plan-origin'
): SessionPlanDelivery => ({
  commandId: 'delivery-1',
  kind,
  state: 'queued',
  originatingPromptMessageId,
  createdAt: 42
})

describe('Plan delivery invariants', () => {
  it.each([
    ['approved-plan', 'approved', undefined],
    ['rejected-plan', 'rejected', undefined],
    ['review-feedback', 'pending', 'feedback-origin']
  ] as const)('matches a valid %s receipt', (kind, approval, feedbackOrigin) => {
    const current = plan(approval, delivery(kind), feedbackOrigin)

    expect(matchPlanDelivery(current)).toEqual(current.delivery)
  })

  it.each([
    ['approved-plan', 'pending', undefined],
    ['rejected-plan', 'approved', undefined],
    ['review-feedback', 'pending', 'different-feedback']
  ] as const)('rejects an invalid %s receipt', (kind, approval, feedbackOrigin) => {
    expect(matchPlanDelivery(plan(approval, delivery(kind), feedbackOrigin))).toBeUndefined()
  })

  it('applies identity and state expectations after domain validation', () => {
    const current = plan('approved', delivery('approved-plan'))

    expect(
      matchesPlanDelivery(current, current.delivery!, {
        commandId: 'delivery-1',
        artifactVersionId: 'version-1',
        state: 'queued',
        kind: 'approved-plan',
        originatingPromptMessageId: 'plan-origin'
      })
    ).toBe(true)
    expect(matchPlanDelivery(current, { commandId: 'other-delivery' })).toBeUndefined()
    expect(matchPlanDelivery(current, { artifactVersionId: 'other-version' })).toBeUndefined()
    expect(matchPlanDelivery(current, { state: 'accepted' })).toBeUndefined()
  })
})
