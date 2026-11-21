import type { ActivePlanProjection } from './session-plan/contract'
import type { AcpPermissionOption } from './acp-permission-contract'
import type { ElicitationAnswer, ElicitationField, TaskQuestionSource } from './elicitation'
import type { TaskInteractionDecisionSource } from './task-interaction-decision-source'

export type { TaskInteractionDecisionSource } from './task-interaction-decision-source'

export type TaskInteractionScope = { runId: string } | { projectId: string; sessionId: string }
export type TaskInteractionMode = 'relay' | 'delegate'
export type TaskInteractionPolicy = Readonly<{ mode: TaskInteractionMode; revision: number }>
export type SetTaskInteractionModeRequest = {
  expectedRevision: number
  interactionMode: TaskInteractionMode
}

export type TaskDelegatedInteraction = {
  frameId: string
  attemptId: string
  branchId: string
  attemptStatus: 'running' | 'completed' | 'cancelled' | 'error'
  continuation?: {
    attemptId: string
    status: TaskDelegatedInteraction['attemptStatus'] | 'unconfirmed'
  }
}

export type TaskNotebookReviewLanguage = 'python' | 'r' | 'repl' | 'bash'

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
  interactionPolicy?: TaskInteractionPolicy
  delegated?: TaskDelegatedInteraction
  notebookReview?: { kind: 'runtime' | 'code'; language: TaskNotebookReviewLanguage }
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

export type TaskPermissionResponse = {
  expectedRevision: number
  expectedBranchId: string
  expectedModeRevision?: number
  expectedLanguage?: TaskNotebookReviewLanguage
  optionId: string
  source: TaskInteractionDecisionSource
}

export type TaskPermissionInteraction = TaskInteractionReference & {
  kind: 'permission'
  recovery?: 'original_run' | 'new_continuation'
  request?: {
    title: string
    toolCallId: string
    tool?: string
    input?: unknown
    options: readonly AcpPermissionOption[]
  }
  response?: {
    optionId: string
    source: TaskInteractionDecisionSource
    status: 'released' | 'unconfirmed'
    continuation?: {
      id: string
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
  | TaskPlanInteraction
  | TaskPermissionInteraction
  | TaskQuestionInteraction
  | TaskNotebookStopInteraction
