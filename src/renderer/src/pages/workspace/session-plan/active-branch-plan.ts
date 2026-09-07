import type { ChatSession } from '@/stores/session-store'
import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'

// The authoritative Plan is Session-scoped, while historical projections are view-only. Only its
// originating durable Message Branch may expose it as active context.
const selectActiveBranchPlan = (
  session: ChatSession | undefined
): ActivePlanProjection | undefined => {
  if (!session?.activePlanProjection) return undefined

  const visibleMessageIds = new Set(session.messages.map((message) => message.id))
  const origin = session.activePlanProjection.originatingPromptMessageId
  return origin && visibleMessageIds.has(origin) ? session.activePlanProjection : undefined
}

export { selectActiveBranchPlan }
