import type { ArtifactFile } from './artifacts'
import type { PermissionProfileId } from './permission-profiles'
import type { CreateProjectRequest, Project, UpdateProjectRequest } from './projects'
import type { ReviewLifecycle, ReviewOutcome, ReviewRunNotStartedReason } from './reviewer'
import type { DelegationPolicy, PersistedSessionStatus } from './session-persistence'
import type { ActivePlanProjection } from './session-plan/contract'

export type TaskRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

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
  artifacts: ArtifactFile[]
  attention?: TaskRunAttention
  review?: TaskRunReview
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
  | 'run_not_found'
  | 'artifact_not_found'
  | 'specialist_not_found'
