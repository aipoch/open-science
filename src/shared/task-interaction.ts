import type { ActivePlanProjection } from './session-plan/contract'

export type TaskInteractionScope = { runId: string } | { projectId: string; sessionId: string }
export type TaskInteractionDecisionSource = 'user_relay' | 'delegated_agent'

export type TaskInteractionReference = {
  id: string
  kind: string
  state: 'pending' | 'responded' | 'expired' | 'unconfirmed'
  projectId: string
  sessionId: string
  runId?: string
  promptMessageId?: string
  branchId?: string
  revision: number
  owner: 'user' | 'agent' | 'service'
  responseCapability?: string
  actions: readonly string[]
  next?: string
}

export type TaskPlanInteraction = TaskInteractionReference & {
  kind: 'plan'
  plan?: ActivePlanProjection
  response?: {
    source: TaskInteractionDecisionSource
    action: 'approved' | 'rejected' | 'revise'
    reviewedRevision: number
    continuation: {
      id: string
      promptMessageId: string
      status: 'queued' | 'accepted' | 'interrupted' | 'unconfirmed'
      taskRunStatus: 'unconfirmed'
    }
  }
}

export type TaskInteraction = TaskPlanInteraction
