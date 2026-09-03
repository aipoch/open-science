export type PermissionProfile = 'ask' | 'auto' | 'full'
export type DelegationPolicy = 'allow' | 'deny'
export type TurnIntent = 'plan-first'
export type ReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AgentFramework = 'claude-code' | 'opencode' | 'codex' | 'codebuddy'
export type AgentConfiguration = {
  providerId: string
  model?: string
  reasoningEffort: ReasoningEffort
}
export type ComputeHosts = { enabled: string[]; selected: string[] }
export type ProjectSessionDefaults = {
  agentConfiguration?: AgentConfiguration
  permissionProfile?: PermissionProfile
  autoReviewEnabled?: boolean
  memoryEnabled?: boolean
  delegationPolicy?: DelegationPolicy
  specialistId?: string
  computeHosts?: ComputeHosts
}
export type ProjectSessionDefaultsPatch = {
  agentConfiguration?: {
    providerId?: string
    model?: string | null
    reasoningEffort?: ReasoningEffort
  } | null
  permissionProfile?: PermissionProfile | null
  autoReviewEnabled?: boolean | null
  memoryEnabled?: boolean | null
  delegationPolicy?: DelegationPolicy | null
  specialistId?: string | null
  computeHosts?: ComputeHosts | null
}
export type ModelRouting =
  | { mode: 'inherit' }
  | {
      mode: 'fixed'
      providerId: string
      model: string
      reasoningEffort: ReasoningEffort
    }
export type RequestOptions = {
  idempotencyKey?: string
  signal?: AbortSignal
  timeoutMs?: number
}
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled'
export type RunFailureCode = 'process_restarted'
export type RunProgressPhase =
  | 'accepted'
  | 'session-ready'
  | 'prompt-dispatched'
  | 'provider-accepted'
  | 'first-visible-output'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type RunProgress = {
  runId: string
  sessionId: string
  projectId: string
  phase: RunProgressPhase
  timestamp: number
  elapsedMs: number
  heartbeat: boolean
}

export type TaskEventIdentity = {
  sequence: number
  runId: string
  sessionId: string
  projectId: string
}

export type TaskEvent =
  | (TaskEventIdentity & { type: 'run.progress'; data: RunProgress })
  | (TaskEventIdentity & { type: 'run.event' | 'permission.requested'; data: unknown })
  | {
      type: 'stream.resync-required'
      data: {
        protocolVersion: 1
        streamId: string
        latestSequence: number
        reason: 'stream-changed' | 'cursor-expired'
      }
    }

export type Project = {
  id: string
  name: string
  description: string
  hasAgentContext: boolean
  isExample: boolean
  createdAt: number
  updatedAt: number
}

export type PlanLifecycle =
  | 'awaiting_approval'
  | 'approved'
  | 'in_progress'
  | 'interrupted'
  | 'blocked'
  | 'completed'
  | 'rejected'

export type SessionPlan = {
  artifactId: string
  artifactVersionId: string
  artifactChecksum: string
  originatingPromptMessageId?: string
  materializedAt?: number
  revision: number
  approval: 'pending' | 'approved' | 'rejected'
  lifecycle: PlanLifecycle
  requiresExplicitContinuation: boolean
  document: unknown
  stepStatuses: Record<string, unknown>
  stepStates: Record<string, unknown>
  counts: {
    phases: number
    delegations: number
    steps: number
    completed: number
    inProgress: number
  }
}

export type RunAttention = { kind: 'plan-approval'; plan: SessionPlan }

export type PlanDecisionResponse = {
  projection: SessionPlan
  changed: boolean
  continuationCommandId?: string
}

export type PlanFeedbackResponse = {
  kind: 'feedback'
  routeToInteractionId: string
  artifactVersionId: string
  text: string
  message: {
    id: string
    role: 'user'
    content: string
    status: 'complete'
    responseToMessageId: string
    eventIds: string[]
    createdAt: number
    updatedAt: number
  }
  planRevision: number
  continuationProjection?: SessionPlan
  continuationCommandId: string
}

export type PlanResponse = PlanDecisionResponse | PlanFeedbackResponse

export type Run = {
  id: string
  sessionId: string
  projectId: string
  cwd: string
  status: RunStatus
  startedAt: number
  cancelRequestedAt?: number
  cancelledAt?: number
  completedAt?: number
  output?: string
  error?: string
  failureCode?: RunFailureCode
  artifacts: Artifact[]
  attention?: RunAttention
  review?: {
    started: boolean
    reason?: string
    id?: string
    lifecycle?: 'running' | 'complete' | 'error'
    outcome?: 'pass' | 'flagged' | null
    errorMessage?: string
  }
  preferredComputeHostIds: string[]
}

export type SessionStatus =
  'idle' | 'running' | 'waiting-for-user' | 'waiting-permission' | 'waiting-plan-approval' | 'error'

export type Session = {
  id: string
  projectId: string
  title: string
  status: SessionStatus
  permissionProfile?: PermissionProfile
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

export type SessionConfiguration = {
  sessionId: string
  projectId: string
  revision: number
  cwd: string
  specialistId?: string
  persisted: {
    agentConfiguration?: AgentConfiguration
    permissionProfile?: PermissionProfile
    autoReviewEnabled?: boolean
    memoryEnabled?: boolean
    delegationPolicy?: DelegationPolicy
    computeHosts: ComputeHosts
  }
  effective: {
    agentConfiguration?: AgentConfiguration
    permissionProfile: PermissionProfile
    autoReviewEnabled: boolean
    memoryEnabled: boolean
    delegationPolicy: DelegationPolicy
    computeHosts: ComputeHosts
  }
  availability: {
    agentConfiguration?: { available: boolean; reason?: string }
    specialist?: { available: boolean; reason?: string }
    computeHosts: Record<string, { available: boolean; reason?: string }>
  }
}

export type AgentRouting = {
  configured: { framework: AgentFramework; reviewer: ModelRouting; subagent: ModelRouting }
  effective: {
    reviewer:
      | { source: 'application_main'; providerId?: string; model?: string }
      | ({ source: 'fixed' } & Omit<Extract<ModelRouting, { mode: 'fixed' }>, 'mode'>)
    subagent:
      | { source: 'session_main' }
      | ({ source: 'fixed' } & Omit<Extract<ModelRouting, { mode: 'fixed' }>, 'mode'>)
  }
}

export type Artifact = {
  id: string
  kind: 'workspace-file' | 'external-file' | 'managed-file'
  path: string
  name?: string
  mimeType?: string
  size?: number
  mtimeMs?: number
  sha256?: string
}

export class OpenScienceApiError extends Error {
  code: string
  status?: number
}

export class OpenScienceClient {
  constructor(options: {
    baseUrl: string
    token: string
    fetch?: typeof globalThis.fetch
    sleep?: (milliseconds: number) => Promise<void>
    requestTimeoutMs?: number
  })
  health(options?: RequestOptions): Promise<unknown>
  listProjects(options?: RequestOptions): Promise<Project[]>
  createProject(
    request: {
      name: string
      description?: string
      agentContext?: string
    },
    options?: RequestOptions
  ): Promise<Project>
  updateProject(
    projectId: string,
    request: {
      expectedUpdatedAt: number
      name?: string
      description?: string
      agentContext?: string
    },
    options?: RequestOptions
  ): Promise<Project>
  getProjectSessionDefaults(
    projectId: string,
    options?: RequestOptions
  ): Promise<{
    projectId: string
    updatedAt: number
    configured: ProjectSessionDefaults
    availability: {
      agentConfiguration?: { available: boolean; reason?: string }
      specialist?: { available: boolean; reason?: string }
      computeHosts: Record<string, { available: boolean; reason?: string }>
    }
  }>
  updateProjectSessionDefaults(
    projectId: string,
    request: {
      expectedUpdatedAt: number
      patch: ProjectSessionDefaultsPatch
    },
    options?: RequestOptions
  ): ReturnType<OpenScienceClient['getProjectSessionDefaults']>
  listSessions(projectId?: string, options?: RequestOptions): Promise<Session[]>
  getSession(sessionId: string, options?: RequestOptions): Promise<Session>
  getSessionConfiguration(
    sessionId: string,
    options?: RequestOptions
  ): Promise<SessionConfiguration>
  updateSessionConfiguration(
    sessionId: string,
    request: {
      expectedRevision: number
      agentConfiguration?: {
        providerId?: string
        model?: string | null
        reasoningEffort?: ReasoningEffort
      }
      permissionProfile?: PermissionProfile
      autoReviewEnabled?: boolean
      memoryEnabled?: boolean
      delegationPolicy?: DelegationPolicy
      computeHosts?: ComputeHosts
    },
    options?: RequestOptions
  ): Promise<SessionConfiguration>
  getAgentRouting(options?: RequestOptions): Promise<AgentRouting>
  updateAgentRouting(
    request: { framework?: AgentFramework; reviewer?: ModelRouting; subagent?: ModelRouting },
    options?: RequestOptions
  ): Promise<AgentRouting>
  getSessionPlan(sessionId: string, options?: RequestOptions): Promise<SessionPlan | null>
  respondSessionPlan(
    sessionId: string,
    response:
      | {
          decision: 'approved' | 'rejected'
          artifactVersionId: string
          expectedRevision: number
        }
      | { feedback: string },
    options?: RequestOptions
  ): Promise<PlanResponse>
  startRun(
    request: {
      project: string
      prompt: string
      cwd?: string
      sessionId?: string
      permissionProfile?: PermissionProfile
      skillIds?: string[]
      turnIntent?: TurnIntent
      autoReviewEnabled?: boolean
      specialist?: string
      delegationPolicy?: DelegationPolicy
      agentConfiguration?: Partial<AgentConfiguration> & { model?: string | null }
      memoryEnabled?: boolean
      computeHostIds?: string[]
      enabledComputeHostIds?: string[]
    },
    options?: RequestOptions
  ): Promise<Run>
  getRun(runId: string, options?: RequestOptions): Promise<Run>
  cancelRun(runId: string, options?: RequestOptions): Promise<Run>
  waitForRun(
    runId: string,
    options?: {
      pollIntervalMs?: number
      returnOnAttention?: boolean
      signal?: AbortSignal
      timeoutMs?: number
    }
  ): Promise<Run>
  listArtifacts(sessionId: string, options?: RequestOptions): Promise<Artifact[]>
  downloadArtifact(artifactId: string, options?: RequestOptions): Promise<Response>
  events(options?: {
    idleTimeoutMs?: number
    signal?: AbortSignal
    WebSocket?: typeof globalThis.WebSocket
  }): AsyncIterable<TaskEvent> & { ready: Promise<void> }
}

export function connectToOpenScience(options?: {
  configRoot?: string
  env?: Record<string, string | undefined>
  fetch?: typeof globalThis.fetch
  requestTimeoutMs?: number
  signal?: AbortSignal
}): Promise<OpenScienceClient>
