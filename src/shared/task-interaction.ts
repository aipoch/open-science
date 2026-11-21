import type { ActivePlanProjection } from './session-plan/contract'
import type { ElicitationAnswer, ElicitationField, TaskQuestionSource } from './elicitation'

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
      taskRunStatus: 'tracked' | 'pending' | 'unconfirmed'
      requestId?: string
      runId?: string
    }
  }
}

export type TaskQuestionResponse = {
  expectedRevision: number
  expectedBranchId: string
  source: TaskQuestionSource
  action: 'accept' | 'decline'
  answers?: ElicitationAnswer[]
}

export type TaskQuestionInteraction = TaskInteractionReference & {
  kind: 'question'
  question?: { message: string; fields: ElicitationField[]; skipFieldIds: string[] }
  response?: {
    source: TaskQuestionSource
    action: TaskQuestionResponse['action']
    reviewedRevision: number
    continuation?: {
      id: string
      requestId?: string
      runId?: string
      status: 'unconfirmed' | 'pending' | 'accepted' | 'failed' | 'interrupted'
    }
  }
}

export type TaskNotebookStopInteraction = TaskInteractionReference & {
  kind: 'notebook-continuation'
  refusalId: string
  reason?: string
}

export type TaskInteraction =
  TaskPlanInteraction | TaskQuestionInteraction | TaskNotebookStopInteraction
