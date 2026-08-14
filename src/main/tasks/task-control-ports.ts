import type { ReviewRunRequest, ReviewRunResult, ReviewWithChecks } from '../../shared/reviewer'
import type { ActivePlanProjection, PlanResponseCommand } from '../../shared/session-plan/contract'
import type { PlanResponseResult } from '../session-plan/plan-service'

type TaskControlPorts = {
  specialists: {
    resolve(reference: string): Promise<{ id: string }>
  }
  plans: {
    getProjection(projectId: string, sessionId: string): Promise<ActivePlanProjection | null>
    respond(input: PlanResponseCommand): Promise<PlanResponseResult>
  }
  reviewer: {
    triggerReview(request: ReviewRunRequest): Promise<ReviewRunResult>
    getForSession(request: { projectId: string; appSessionId: string }): Promise<ReviewWithChecks[]>
  }
}

export type { TaskControlPorts }
