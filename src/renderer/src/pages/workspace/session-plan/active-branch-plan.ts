import type { ChatSession } from '@/stores/session-store'
import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'

// Plan execution authority remains Session-scoped. Historical projections are view-only and must
// never replace the authoritative Plan in an actionable branch surface.
const selectActiveBranchPlan = (
  session: ChatSession | undefined
): ActivePlanProjection | undefined => {
  if (!session?.activePlanProjection) return undefined

  const visibleMessageIds = new Set(session.messages.map((message) => message.id))
  const origin = session.activePlanProjection.originatingPromptMessageId
  return origin && visibleMessageIds.has(origin) ? session.activePlanProjection : undefined
}

export { selectActiveBranchPlan }
