// Keep these standalone published types aligned with the safe Settings contracts.
// connector-types.test.ts verifies complete request and response equivalence.
export type ToolPermission = 'allow' | 'ask' | 'block'

export type ConnectorToolView = {
  id: string // "<connector>/<method>"
  method: string
  description: string
  permission: ToolPermission
}

export type ConnectorGroup = 'featured' | 'directory'

export type ConnectorView = {
  id: string
  // Immutable invocation/export name. Bundled Connectors currently use the same value as id.
  name: string
  displayName: string
  description: string
  sources: string[]
  requiresNcbi: boolean
  enabled: boolean // !disabledConnectorIds.includes(id)
  autoAllow: boolean // autoAllowIds.includes(id) — "Skip approvals"
  group: ConnectorGroup
}

export type ConnectorDetailView = ConnectorView & {
  useWhen: string
  termsUrl?: string
  tools: ConnectorToolView[]
}

export type NcbiCredentialsView = { contactEmail?: string; hasApiKey: boolean }

export type OpenAlexCredentialView = { hasApiKey: boolean }

export type CustomServerTransport = 'stdio' | 'streamable_http' | 'sse'

export type CustomServerView = {
  id: string
  // Immutable agent-facing name used by host.mcp, Specialists, and generated MCP skills.
  name: string
  // User-facing label; spaces, punctuation, and duplicates are allowed.
  displayName: string
  description?: string
  transport: CustomServerTransport
  enabled: boolean
  // Physical availability is independent of Main's enabled toggle. An invalid persisted server may
  // remain visible to a Specialist but can never be selected or dispatched.
  availability?: 'unavailable' | 'unauthenticated' | 'credential_unavailable'
  // Background discovery is transient and does not make the Connector unavailable by itself.
  checking?: boolean
  // Display-only config summary. Environment/header names are safe to show; values stay write-only.
  command?: string
  args?: string[]
  url?: string
  hasHeaders?: boolean
  headerNames?: string[]
  hasEnv?: boolean
  environmentNames?: string[]
  // Opaque device credential reference used to preselect a shared OAuth credential in Configure.
  oauthCredentialId?: string
  oauth?: {
    clientMetadataUrl?: string
    authorizationServerUrl?: string
    scopes?: string[]
    clientId?: string
    redirectUri?: string
    hasTokens: boolean
    // Optional for compatibility with snapshots from an older main process during development.
    hasClientSecret?: boolean
    sharedCredential?: boolean
  }
}

export type ConnectorsSnapshot = {
  connectors: ConnectorView[]
  customServers: CustomServerView[]
  // Derived Agent Skill documents can fail independently after durable Connector settings save.
  skillProjectionStatus?: 'degraded'
  // Local IDs reserved until interrupted custom Connector deletion cleanup completes.
  reservedCustomServerIds?: string[]
  ncbi: NcbiCredentialsView
  // Optional only for compatibility with an older main process during local development.
  openAlex?: OpenAlexCredentialView
}

export type DeviceCredentialKind = 'api_key' | 'token' | 'oauth'

export type DeviceOAuthTransport = Extract<CustomServerTransport, 'streamable_http' | 'sse'>

export type DeviceOAuthRegistration = {
  clientMetadataUrl?: string
  authorizationServerUrl?: string
  scopes?: string[]
  clientId?: string
  redirectUri?: string
}

export type DeviceCredentialView = {
  id: string
  displayName: string
  kind: DeviceCredentialKind
  status: 'stored' | 'connected' | 'disconnected'
  needsSecret: boolean
  resourceUri?: string
  transport?: DeviceOAuthTransport
  oauth?: DeviceOAuthRegistration
  hasClientSecret?: boolean
  // Derived separately from unreadable OAuth login state; never persisted.
  needsClientSecret?: boolean
  consumerCount: number
  consumerNames: string[]
  createdAt: number
  updatedAt: number
}

export type DeviceCredentialsSnapshot = { credentials: DeviceCredentialView[] }

export type CreateDeviceCredentialResult = {
  // Missing when creation committed but the full consumer projection could not be read.
  credentials?: DeviceCredentialView[]
  createdCredential: DeviceCredentialView
}

export type CreateDeviceCredentialRequest =
  | { displayName: string; kind: 'api_key' | 'token'; secret: string }
  | {
      displayName: string
      kind: 'oauth'
      resourceUri: string
      transport: DeviceOAuthTransport
      oauth: DeviceOAuthRegistration & {
        clientSecret?: string
      }
    }

export type UpdateDeviceCredentialRequest = {
  id: string
  displayName?: string
  secret?: string
}

export type AddCustomServerRequest = {
  // Optional immutable local ID. Omission lets main infer one from `name` and fall back to a UUID.
  id?: string
  name: string
  displayName: string
  description?: string
  transport: CustomServerTransport
  command?: string
  args?: string[]
  envCredentialIds?: Record<string, string>
  url?: string
  headerCredentialIds?: Record<string, string>
  oauthCredentialId?: string
  // Non-secret registration requirements checked against a selected shared OAuth credential.
  // They are validation input only and are not persisted on the Connector.
  oauthRequirements?: DeviceOAuthRegistration
  // Request-only marker from an imported template. Main validates the selected shared credential;
  // the marker is never persisted on the Connector.
  requiresOAuthClientSecret?: boolean
}

export type UpdateCustomServerRequest = {
  id: string
  displayName?: string
  description?: string
  transport: CustomServerTransport
  command?: string
  // Omitted keeps saved args while staying on stdio; [] explicitly clears them.
  args?: string[]
  env?: Record<string, string>
  envCredentialIds?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  headerCredentialIds?: Record<string, string>
  // Omitted retains the current shared OAuth binding; a value selects or replaces it.
  oauthCredentialId?: string
  oauth?: {
    clientMetadataUrl?: string
    authorizationServerUrl?: string
    scopes?: string[]
    clientId?: string
    redirectUri?: string
    // Omitted keeps the stored secret; null explicitly removes it.
    clientSecret?: string | null
  } | null
}

export type ConnectorTransport = CustomServerTransport
export type ConnectorConfiguration = Omit<UpdateCustomServerRequest, 'id'>
export type ConnectorTestResult = { success: boolean; toolCount?: number; message: string }
export type CredentialInput = CreateDeviceCredentialRequest
export type CredentialView = DeviceCredentialView
export type CredentialsSnapshot = DeviceCredentialsSnapshot

export type PermissionProfile = 'ask' | 'auto' | 'full'
export type DelegationPolicy = 'allow' | 'deny'
export type TurnIntent = 'plan-first'
export type ReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AgentFramework = 'claude-code' | 'opencode' | 'codex' | 'codebuddy'
export type DoctorReport = {
  ready: boolean
  checks: {
    daemon: { status: 'ready' }
    runtime: { status: 'ready' | 'missing'; framework: AgentFramework }
    provider: { status: 'ready' | 'missing' }
    skills: { status: 'ready'; enabled: string[] }
  }
  next: Array<{ code: 'runtime_missing' | 'provider_missing' }>
}
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
  'awaiting_approval' | 'approved' | 'in_progress' | 'blocked' | 'completed' | 'rejected'

export type SessionPlan = {
  artifactId: string
  artifactVersionId: string
  artifactChecksum: string
  originatingPromptMessageId?: string
  materializedAt?: number
  revision: number
  approval: 'pending' | 'approved' | 'rejected'
  lifecycle: PlanLifecycle
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
  doctor(options?: RequestOptions): Promise<DoctorReport>
  listConnectors(options?: RequestOptions): Promise<ConnectorsSnapshot>
  getConnector(
    id: string,
    options?: RequestOptions
  ): Promise<ConnectorDetailView | CustomServerView>
  setConnectorEnabled(
    id: string,
    enabled: boolean,
    options?: RequestOptions
  ): Promise<ConnectorsSnapshot>
  addConnector(
    request: AddCustomServerRequest,
    options?: RequestOptions
  ): Promise<ConnectorsSnapshot>
  updateConnector(
    id: string,
    request: ConnectorConfiguration,
    options?: RequestOptions
  ): Promise<ConnectorsSnapshot>
  removeConnector(id: string, options?: RequestOptions): Promise<ConnectorsSnapshot>
  testConnector(id: string, options?: RequestOptions): Promise<ConnectorTestResult>
  listCredentials(options?: RequestOptions): Promise<CredentialsSnapshot>
  createCredential(
    request: CredentialInput,
    options?: RequestOptions
  ): Promise<CreateDeviceCredentialResult>
  updateCredential(
    id: string,
    request: { displayName?: string; secret?: string },
    options?: RequestOptions
  ): Promise<CredentialsSnapshot>
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
