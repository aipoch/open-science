import type { ActivePlanProjection } from '../../../../../shared/session-plan/contract'

/** Lifecycle states that surface the inline plan-progress chip in the notebook bar.
    Awaiting-approval relies on the plan card in the message stream; terminal states
    (completed/blocked/rejected) hide the chip — the plan stays viewable via “View plan”. */
const PLAN_PROGRESS_CHIP_LIFECYCLES: ReadonlySet<ActivePlanProjection['lifecycle']> = new Set([
  'approved',
  'in_progress'
])

export const isPlanProgressVisible = (projection: ActivePlanProjection): boolean =>
  PLAN_PROGRESS_CHIP_LIFECYCLES.has(projection.lifecycle)
