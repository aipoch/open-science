import type { ArtifactFile } from './artifacts'
import type { PermissionProfileId } from './permission-profiles'
import type { CreateProjectRequest, Project, UpdateProjectRequest } from './projects'
import type { ReviewLifecycle, ReviewOutcome, ReviewRunNotStartedReason } from './reviewer'
import type { DelegationPolicy, PersistedSessionStatus } from './session-persistence'
import type { ActivePlanProjection } from './session-plan/contract'

export const TASK_EVENT_STREAM_PROTOCOL_VERSION = 1 as const

export type TaskRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export type TaskRunFailureCode = 'process_restarted'

export type TaskRunProgressPhase =
  | 'accepted'
  | 'session-ready'
  | 'prompt-dispatched'
  | 'provider-accepted'
  | 'first-visible-output'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type TaskRunProgressEvent = {
  runId: string
  sessionId: string
  projectId: string
  phase: TaskRunProgressPhase
  timestamp: number
  elapsedMs: number
  heartbeat: boolean
}

export type TaskRunIdentity = Pick<TaskRunProgressEvent, 'runId' | 'sessionId' | 'projectId'>

export type StartTaskRunRequest = {
  /** Project ID. The external field name remains `project`. */
  project: string
  prompt: string
  sessionId?: string
  cwd?: string
  permissionProfile?: PermissionProfileId
  skillIds?: string[]
  turnIntent?: 'plan-first'
  autoReviewEnabled?: boolean
  // Accepts an immutable Specialist ID or its stable Profile name. displayName is presentation-only.
  specialist?: string
  delegationPolicy?: DelegationPolicy
  /** Selected execution-target provider IDs for this Session. Omit to preserve. */
  computeHostIds?: string[]
}

export type TaskRunAttention = { kind: 'plan-approval'; plan: ActivePlanProjection }

export type TaskRunReview = {
  started: boolean
  reason?: ReviewRunNotStartedReason
  id?: string
  lifecycle?: ReviewLifecycle
  outcome?: ReviewOutcome | null
  errorMessage?: string
}

export type TaskPlanResponseRequest =
  | {
      decision: 'approved' | 'rejected'
      artifactVersionId: string
      expectedRevision: number
      feedback?: never
    }
  | { feedback: string; decision?: never; artifactVersionId?: never; expectedRevision?: never }

export type TaskRun = {
  id: string
  sessionId: string
  projectId: string
  cwd: string
  status: TaskRunStatus
  startedAt: number
  cancelRequestedAt?: number
  cancelledAt?: number
  completedAt?: number
  output?: string
  error?: string
  failureCode?: TaskRunFailureCode
  artifacts: ArtifactFile[]
  attention?: TaskRunAttention
  review?: TaskRunReview
  /** Final selected execution-target provider IDs committed by the Session authority. */
  preferredComputeHostIds: string[]
}

export type TaskSessionSummary = {
  id: string
  projectId: string
  title: string
  status: PersistedSessionStatus
  permissionProfile?: PermissionProfileId
  autoReviewEnabled: boolean
  specialistId?: string
  delegationPolicy: DelegationPolicy
  pinned: boolean
  archivedAt?: number
  createdAt: number
  updatedAt: number
  output?: string
  error?: string
  artifactCount: number
}

export type TaskProject = Omit<Project, 'agentContext'> & {
  hasAgentContext: boolean
}

export type CreateTaskProjectRequest = Pick<
  CreateProjectRequest,
  'name' | 'description' | 'agentContext'
>

export type UpdateTaskProjectRequest = Pick<
  UpdateProjectRequest,
  'name' | 'description' | 'agentContext' | 'expectedUpdatedAt'
>

export type AcquiredTaskArtifact = {
  resourceId: string
  url: string
  name: string
  mimeType?: string
  size: number
}

export type TaskApiErrorCode =
  | 'invalid_request'
  | 'project_not_found'
  | 'project_conflict'
  | 'session_not_found'
  | 'session_busy'
  | 'session_archived'
  | 'project_archived'
  | 'run_not_found'
  | 'artifact_not_found'
  | 'specialist_not_found'
