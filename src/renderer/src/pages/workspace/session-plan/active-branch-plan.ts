import type { ChatSession } from '@/stores/session-store'
import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'

// Plan execution authority remains Session-scoped. This selector only projects the newest Plan whose
// originating user Message is present on the currently active Message Branch path.
const selectActiveBranchPlan = (
  session: ChatSession | undefined
): ActivePlanProjection | undefined => {
  if (!session?.activePlanProjection) return undefined

  const visibleMessageIds = new Set(session.messages.map((message) => message.id))
  const allowLegacyUnboundPlan = (session.conversationGraph?.branches.length ?? 1) <= 1
  const candidates = [...(session.planHistoryProjections ?? []), session.activePlanProjection]

  return candidates
    .toReversed()
    .find((plan) =>
      plan.originatingPromptMessageId
        ? visibleMessageIds.has(plan.originatingPromptMessageId)
        : allowLegacyUnboundPlan
    )
}

export { selectActiveBranchPlan }
