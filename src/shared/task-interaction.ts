import type { ActivePlanProjection } from './session-plan/contract'
import type { AcpPermissionOption } from './acp-permission-contract'

export type TaskInteractionScope = { runId: string } | { projectId: string; sessionId: string }
export type TaskInteractionDecisionSource = 'user_relay' | 'delegated_agent'
export type TaskInteractionMode = 'relay' | 'delegate'
export type TaskInteractionPolicy = Readonly<{ mode: TaskInteractionMode; revision: number }>
export type SetTaskInteractionModeRequest = {
  expectedRevision: number
  interactionMode: TaskInteractionMode
}

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

export type TaskPermissionResponse = {
  expectedRevision: number
  expectedBranchId: string
  expectedModeRevision?: number
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
    continuation?: { taskRunStatus: 'unconfirmed' }
  }
}

export type TaskNotebookStopInteraction = TaskInteractionReference & {
  kind: 'notebook-continuation'
  refusalId: string
  reason?: string
}

export type TaskInteraction =
  TaskPlanInteraction | TaskPermissionInteraction | TaskNotebookStopInteraction
