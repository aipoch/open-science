import type { ArtifactFile } from './artifacts'
import type { PermissionProfileId } from './permission-profiles'
import type { CreateProjectRequest, Project, UpdateProjectRequest } from './projects'
import type { ReviewLifecycle, ReviewOutcome, ReviewRunNotStartedReason } from './reviewer'
import type {
  ProjectSessionDefaults,
  SessionAgentConfigurationPatch,
  SessionAgentConfigurationValue,
  SessionComputeHosts,
  UpdateProjectSessionDefaultsRequest,
  UpdateSessionConfigurationRequest
} from './session-configuration'
import type { DelegationPolicy, PersistedSessionStatus } from './session-persistence'
import type { ActivePlanProjection } from './session-plan/contract'
import type {
  AgentFrameworkId,
  ReviewerModelConfiguration,
  SubagentModelConfiguration
} from './settings'

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
  agentConfiguration?: SessionAgentConfigurationPatch
  memoryEnabled?: boolean
  /** Selected execution-target provider IDs for this Session. Omit to preserve. */
  computeHostIds?: string[]
  /** Enabled execution targets; selected ids must be a subset. Used by Project defaults. */
  enabledComputeHostIds?: string[]
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

export type TaskProject = Omit<Project, 'agentContext' | 'sessionDefaults'> & {
  hasAgentContext: boolean
}

export type TaskReferenceAvailability = Readonly<{
  available: boolean
  reason?: string
}>

export type TaskSessionConfiguration = Readonly<{
  sessionId: string
  projectId: string
  revision: number
  cwd: string
  specialistId?: string
  persisted: Readonly<{
    agentConfiguration?: SessionAgentConfigurationValue
    permissionProfile?: PermissionProfileId
    autoReviewEnabled?: boolean
    memoryEnabled?: boolean
    delegationPolicy?: DelegationPolicy
    computeHosts: SessionComputeHosts
  }>
  effective: Readonly<{
    agentConfiguration?: SessionAgentConfigurationValue
    permissionProfile: PermissionProfileId
    autoReviewEnabled: boolean
    memoryEnabled: boolean
    delegationPolicy: DelegationPolicy
    computeHosts: SessionComputeHosts
  }>
  availability: Readonly<{
    agentConfiguration?: TaskReferenceAvailability
    specialist?: TaskReferenceAvailability
    computeHosts: Readonly<Record<string, TaskReferenceAvailability>>
  }>
}>

export type TaskProjectSessionDefaults = Readonly<{
  projectId: string
  updatedAt: number
  configured: ProjectSessionDefaults
  availability: Readonly<{
    agentConfiguration?: TaskReferenceAvailability
    specialist?: TaskReferenceAvailability
    computeHosts: Readonly<Record<string, TaskReferenceAvailability>>
  }>
}>

export type TaskAgentRouting = Readonly<{
  configured: Readonly<{
    framework: AgentFrameworkId
    reviewer: ReviewerModelConfiguration
    subagent: SubagentModelConfiguration
  }>
  effective: Readonly<{
    reviewer:
      | Readonly<{ source: 'application_main'; providerId?: string; model?: string }>
      | Readonly<{
          source: 'fixed'
          providerId: string
          model: string
          reasoningEffort: SessionAgentConfigurationValue['reasoningEffort']
        }>
    subagent:
      | Readonly<{ source: 'session_main' }>
      | Readonly<{
          source: 'fixed'
          providerId: string
          model: string
          reasoningEffort: SessionAgentConfigurationValue['reasoningEffort']
        }>
  }>
}>

export type UpdateTaskAgentRoutingRequest = Readonly<{
  framework?: AgentFrameworkId
  reviewer?: ReviewerModelConfiguration
  subagent?: SubagentModelConfiguration
}>

export type { UpdateProjectSessionDefaultsRequest, UpdateSessionConfigurationRequest }

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
  | 'session_revision_conflict'
  | 'invalid_configuration'
  | 'session_archived'
  | 'project_archived'
  | 'run_not_found'
  | 'artifact_not_found'
  | 'specialist_not_found'
