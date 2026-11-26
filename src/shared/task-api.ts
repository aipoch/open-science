import type { ProvisionPhase } from '@aipoch/environment/contracts'
import type { ArtifactFile } from './artifacts'
import type { NotebookLanguage } from './notebook-language-contract'
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
  TaskInteractionDecisionSource,
  TaskInteractionMode,
  TaskInteractionPolicy,
  TaskInteractionReference
} from './task-interaction'
import type {
  AgentFrameworkId,
  ProviderReadinessReason,
  ReadinessStatus,
  ReviewerModelConfiguration,
  SubagentModelConfiguration
} from './settings'

export class TaskRunTracingError extends Error {
  constructor(
    message = 'Set OPEN_SCIENCE_AGENT_OTLP_TRACES_ENDPOINT to a full HTTP(S) traces URL and check the OTLP headers or credentials for that configuration. Restart the backend and retry --otel-traces.'
  ) {
    super(message)
  }
}

export type TaskAgentRuntime = Readonly<{
  framework: AgentFrameworkId
  status: ReadinessStatus
  version?: string
  source?: 'managed' | 'external'
}>

export type TaskReadinessCheck = Readonly<{
  status: 'ready' | 'blocked' | 'checking' | 'unconfirmed'
  reason?: string
}>

export type TaskNotebookReadiness = Readonly<{
  platform: NodeJS.Platform
  environment: TaskReadinessCheck & {
    pythonReady?: boolean
    rReady?: boolean
    python?: TaskReadinessCheck
    r?: TaskReadinessCheck
  }
  dependencies: TaskReadinessCheck
  sandbox: TaskReadinessCheck
  memoryPolicy: TaskReadinessCheck & { source?: string; executionScope?: string }
}>

export type TaskNotebookEnvironmentTarget = Readonly<{
  language: NotebookLanguage
  operationId: string
}>

export type TaskNotebookRuntimeSelection = Readonly<{
  language: NotebookLanguage
  runtimeId: string
}>

export type TaskNotebookRuntime = TaskNotebookRuntimeSelection & {
  source: 'managed' | 'external'
  provenance: 'app-managed' | 'agent-created' | 'user-own'
  interpreterPath: string
  label: string
  version?: string
  runnable: boolean
  enabled: boolean
  detail?: string
}

export type TaskNotebookEnvironmentRequest = TaskNotebookEnvironmentTarget &
  Readonly<{ action: 'prepare' | 'repair' }>

export type TaskNotebookEnvironmentOperation = TaskNotebookEnvironmentTarget &
  Readonly<{
    action?: TaskNotebookEnvironmentRequest['action']
    status: 'preparing' | 'completed' | 'failed' | 'cancelled' | 'unconfirmed'
    progress?: { phase: ProvisionPhase; fraction: number }
    cancelRequested?: boolean
    reason?: 'notebook_setup_failed' | 'notebook_environment_recovery_required'
  }>

export type TaskDoctorReport = Readonly<{
  ready: boolean
  checks: Readonly<{
    daemon: Readonly<{ status: 'ready' }>
    runtime: Readonly<{
      status: ReadinessStatus
      framework: AgentFrameworkId
      selectedFramework?: AgentFrameworkId | null
    }>
    provider: Readonly<
      (
        { status: 'ready' | 'missing' } | { status: 'not_ready'; reason?: ProviderReadinessReason }
      ) & { keylessKiloAvailable?: boolean }
    >
    skills: Readonly<{ status: 'ready'; enabled: string[] }>
    notebook?: TaskNotebookReadiness
  }>
  next: ReadonlyArray<
    Readonly<{
      code: 'runtime_missing' | 'runtime_not_ready' | 'provider_missing' | 'provider_not_ready'
      argv?: readonly string[]
    }>
  >
}>

export const TASK_EVENT_STREAM_PROTOCOL_VERSION = 1 as const

export type TaskNotebookContinuation = Readonly<{
  runId: string
  branchId: string
  refusalId: string
  source: 'user_relay'
}>

export type TaskNotebookContinuationRequest = TaskNotebookContinuation & { prompt: string }

export type TaskSubmission = {
  requestId: string
  status: 'pending' | 'accepted' | 'failed' | 'interrupted'
  createdAt: number
  runId?: string
  notebookContinuation?: TaskNotebookContinuation
  error?: { code: string; message: string }
}

export type TaskRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export type TaskRunFailureCode = 'process_restarted'

export type TaskNotebookExecution = {
  status: 'unconfirmed' | 'preparing' | 'running' | 'completed' | 'failed' | 'waiting_for_user'
  projectId: string
  sessionId: string
  notebookRunId?: string
  promptMessageId?: string
  messageBranchId?: string
  language?: NotebookLanguage
  runtimeId?: string
  runtimeSource?: 'managed' | 'external'
  kernelDispatched?: boolean
  reasonCode?: string
  refusalId?: string
  refusalReason?: string
  continuedFromRefusalId?: string
  owner?: 'user' | 'agent'
  requiresUser?: true
  retryable?: false
  next?: {
    action:
      | 'continue_notebook'
      | 'continue_notebook_in_app'
      | 'respond_permission'
      | 'review_notebook_code_in_app'
      | 'review_notebook_runtime_in_app'
    message: string
  }
}

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
  notebookRuntime?: TaskNotebookRuntimeSelection
  permissionProfile?: PermissionProfileId
  /** Per-execution: deny unresolved human interactions instead of waiting. */
  permissionPrompts?: 'none'
  interactionMode?: TaskInteractionMode
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

export type SubmitTaskRunRequest = StartTaskRunRequest & { otelTraces?: true }

export type TaskRunAttention =
  | { kind: 'plan-approval'; plan: ActivePlanProjection }
  | { kind: 'interactions'; interactions: TaskInteractionReference[] }

export type TaskRunReview = {
  started: boolean
  reason?: ReviewRunNotStartedReason
  id?: string
  lifecycle?: ReviewLifecycle
  outcome?: ReviewOutcome | null
  errorMessage?: string
}

export type TaskPlanResponseRequest = {
  projectId?: string
  artifactVersionId: string
  expectedRevision: number
  expectedBranchId: string
  source: TaskInteractionDecisionSource
  expectedModeRevision?: number
} & (
  | {
      decision: 'approved' | 'rejected'
      feedback?: never
    }
  | { feedback: string; decision?: never }
)

export type TaskRun = {
  requestId?: string
  continuedFromRunId?: string
  /** Separate turns recorded under this Run. Follow a child Run for its own results and decisions. */
  continuations?: {
    runId: string
    requestId: string
    status: TaskRunStatus
    failureCode?: TaskRunFailureCode
  }[]
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
  /** Notebook evidence for this research turn, independent of the outer Run status. */
  execution?: TaskNotebookExecution
  artifacts: ArtifactFile[]
  attention?: TaskRunAttention
  interactionPolicy?: TaskInteractionPolicy
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
  readOnly: boolean
  packageOrigin?: TaskSessionOrigin
  forkOrigin?: TaskSessionOrigin
  /** Live Notebook intent, with evidence scoped to its prompt when available. */
  execution?: TaskNotebookExecution
}

export type TaskSessionOrigin = Omit<
  import('./session-package').SessionPackageOrigin,
  'excludedFiles'
>

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

/** Defaults for new Sessions created through Task automation (CLI/API), not desktop New drafts. */
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
  | 'notebook_setup_failed'
  | 'notebook_runtime_unavailable'
  | 'notebook_continuation_expired'
  | 'task_relay_required'
  | 'interaction_not_found'
  | 'interaction_revision_conflict'
  | 'task_delegation_required'
  | 'question_already_answered'
  | 'notebook_environment_operation_conflict'
  | 'submission_conflict'
  | 'submission_unavailable'
  | 'submission_not_found'
  | 'session_read_only'
  | 'session_project_mismatch'
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
