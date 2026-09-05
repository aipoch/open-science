import type {
  SessionPlanApproval,
  SessionPlanDelivery,
  SessionPlanRuntimeContext
} from '../../shared/session-persistence'

type PlanDeliverySubject = Readonly<{
  approval: SessionPlanApproval
  artifactVersionId: string
  originatingPromptMessageId?: string
  reviewFeedbackMessageId?: string
}>

type PlanDeliveryExpectation = Readonly<{
  commandId?: string
  artifactVersionId?: string
  state?: SessionPlanDelivery['state']
  kind?: SessionPlanDelivery['kind']
  originatingPromptMessageId?: string
}>

const matchesPlanDelivery = (
  plan: PlanDeliverySubject,
  delivery: SessionPlanDelivery,
  expected: PlanDeliveryExpectation = {}
): boolean => {
  const expectedOrigin =
    delivery.kind === 'review-feedback'
      ? plan.reviewFeedbackMessageId
      : plan.originatingPromptMessageId
  const kindMatchesApproval =
    (delivery.kind === 'approved-plan' && plan.approval === 'approved') ||
    (delivery.kind === 'rejected-plan' && plan.approval === 'rejected') ||
    (delivery.kind === 'review-feedback' && plan.approval === 'pending')
  return (
    kindMatchesApproval &&
    expectedOrigin !== undefined &&
    delivery.originatingPromptMessageId === expectedOrigin &&
    (expected.commandId === undefined || delivery.commandId === expected.commandId) &&
    (expected.artifactVersionId === undefined ||
      plan.artifactVersionId === expected.artifactVersionId) &&
    (expected.state === undefined || delivery.state === expected.state) &&
    (expected.kind === undefined || delivery.kind === expected.kind) &&
    (expected.originatingPromptMessageId === undefined ||
      delivery.originatingPromptMessageId === expected.originatingPromptMessageId)
  )
}

const matchPlanDelivery = (
  plan: SessionPlanRuntimeContext | undefined,
  expected: PlanDeliveryExpectation = {}
): SessionPlanDelivery | undefined => {
  const delivery = plan?.delivery
  return plan && delivery && matchesPlanDelivery(plan, delivery, expected) ? delivery : undefined
}

export { matchPlanDelivery, matchesPlanDelivery }
export type { PlanDeliveryExpectation, PlanDeliverySubject }
