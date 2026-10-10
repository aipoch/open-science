export type BootstrapRequest =
  | { action: 'status' | 'runtime' | 'codex-prepare' | 'codex-complete' }
  | { action: 'provider'; key: string; model: string }
  | { action: 'openalex'; key: string }
export type BootstrapResult =
  | { ok: true; providerId?: string; next?: { runtime?: string[]; provider?: string[] } }
  | {
      ok: false
      code:
        | 'invalid_request'
        | 'configuration_conflict'
        | 'runtime_unavailable'
        | 'credential_invalid'
        | 'bootstrap_failed'
    }

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
export type ReadinessStatus = 'ready' | 'missing' | 'not_ready'
export type ProviderReadinessReason =
  | 'credential_invalid'
  | 'network'
  | 'model-not-found'
  | 'bad-url'
  | 'timeout'
  | 'incompatible'
  | 'server-error'
  | 'unknown'
export type DoctorReport = {
  ready: boolean
  checks: {
    daemon: { status: 'ready' }
    runtime: { status: ReadinessStatus; framework: AgentFramework }
    provider:
      { status: 'ready' | 'missing' } | { status: 'not_ready'; reason?: ProviderReadinessReason }
    skills: { status: 'ready'; enabled: string[] }
  }
  next: Array<{
    code: 'runtime_missing' | 'runtime_not_ready' | 'provider_missing' | 'provider_not_ready'
    argv?: readonly string[]
  }>
}
export type AgentRuntime = {
  framework: AgentFramework
  status: ReadinessStatus
  version?: string
  source?: 'managed' | 'external'
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
  /** Aborts this request, not work already accepted by the service. */
  signal?: AbortSignal
  /** Per-request deadline in milliseconds, including response-body consumption. */
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

export type ManagedSessionScope = { projectId: string; sessionId: string }
export type CreateManagedSessionRequest = { projectId: string; requestId: string; title: string }
export type InspectManagedMaterialsRequest = ManagedSessionScope & {
  sourceSessionId: string
  sourceIdentity?: string
  versionIds?: string[]
  descriptorVersionId?: string
}
export type PrepareManagedEnvironmentRequest = ManagedSessionScope & {
  requestId: string
  sourceSessionId: string
  sourceIdentity: string
  versionIds?: string[]
  runtimeId: string
  materials:
    | { files: Array<{ versionId: string; restorePath: string }> }
    | {
        descriptorVersionId: string
        materialKeys: string[]
        materialVersions?: Record<string, string>
      }
}
export type ManagedEnvironmentReference = ManagedSessionScope & { environmentId: string }
export type ManagedCollectionReference = ManagedEnvironmentReference & { collectionId: string }
export type CollectManagedOutputsRequest = ManagedCollectionReference & { requestId: string }
export type ExecuteManagedEnvironmentRequest = ManagedEnvironmentReference & {
  requestId: string
  command: string
  /** Opaque local profile; configure credentials only in the trusted Open Science desktop. */
  profileId?: string
  /** Process deadline, distinct from a request or wait deadline. Maximum 600000 ms. */
  timeoutMs?: number
  localServicePort?: number
  /** Reserved for a project-view adapter; requests fail explicitly when it is unavailable. */
  projectView?: RuntimeViewLaunch
  /** Optional observation adapter request; rejected when this host has no adapter. */
  recordObservation?: boolean
  outputs?: Array<{ path: string; filename: string; contentType?: string; optional?: boolean }>
  description?: string
}
export type RuntimeViewLaunch = {
  title: string
  entryPath?: string
  allowedRequestHeaders?: string[]
  webSocketProtocols?: string[]
  /** Explicit per-run framing compatibility; does not modify original research files. */
  adaptFrameAncestors?: boolean
}
export type ManagedOperationReference = ManagedSessionScope & { requestId: string }
export type ManagedRuntime = {
  kind: 'node'
  version: string
  sha256: string
  platform: 'darwin' | 'linux' | 'win32'
  arch: string
}
export type ManagedRuntimeDiagnosticCode =
  | 'node_not_found'
  | 'node_version_unsupported'
  | 'node_host_mismatch'
  | 'node_not_independent'
  | 'node_unusable'
  | 'native_service_unsupported'
export type ManagedRuntimeDiagnostics = {
  /** Local HTTP service support, distinct from discovering a compatible Node. */
  nativeServiceSupported: boolean
  /** Fixed guidance without host paths, environment values or raw probe errors. */
  issues: Array<{ code: ManagedRuntimeDiagnosticCode; message: string; action: string }>
}
export type ManagedRuntimeDiscovery = {
  /** Whether at least one compatible independent Node was found. */
  available: boolean
  runtimes: Array<ManagedRuntime & { runtimeId: string }>
  /** Older applications may omit diagnostics. This does not install or configure a runtime. */
  diagnostics?: ManagedRuntimeDiagnostics
}
export type ManagedMaterialSource = ManagedSessionScope & { identity: string; title?: string }
export type ManagedMaterialVersion = {
  versionId: string
  sourceIdentity: string
  filename: string
  sha256: string
  sizeBytes: number
  contentAvailable?: boolean
  descriptor?: boolean
}
export type ManagedMaterialsInspection = {
  source: ManagedMaterialSource
  status: 'no-description' | 'choose-description' | 'ready' | 'unsupported' | 'invalid'
  descriptorCandidates: ManagedMaterialVersion[]
  descriptor?: ManagedMaterialVersion
  inspection?: unknown
  description?: unknown
  materials?: Array<{
    key: string
    status: 'available' | 'external' | 'withheld' | 'missing' | 'mismatch'
    versionIds?: string[]
  }>
  versions: ManagedMaterialVersion[]
}
export type ManagedEnvironment = ManagedEnvironmentReference & {
  source: ManagedMaterialSource
  state: 'preparing' | 'ready' | 'releasing' | 'cleanup-pending' | 'released' | 'failed'
  runtime: ManagedRuntime
  inputs: Array<ManagedMaterialVersion & { materialKey?: string; restorePath?: string }>
  /** Retained outputs await collection or publication; release preserves them until resolved. */
  pendingCollection?: { collectionId: string; executionInvocationId: string }
  discardedCollections?: Array<{
    collectionId: string
    executionInvocationId: string
    discardedAt: number
  }>
  error?: string
}
export type SessionOperationSnapshot = ManagedOperationReference & {
  schemaVersion: 1
  operationId: string
  requestFingerprint: string
  requestText: string
  status:
    'admitting' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  createdAt: number
  updatedAt: number
  provenance?: {
    rootFrameId: string
    agentFrameId: string
    messageBranchId: string
    runtimeSegmentId: string
    promptMessageId: string
  }
  notebookRunIds: string[]
  artifactVersionIds: string[]
  artifactRunId?: string
  resultText?: string
  error?: string
  recoveryPending?: boolean
}
export type ResearchExecutionBinding = {
  projectId: string
  sourceSessionId: string
  sourceIdentity: string
  descriptorVersionId: string
  descriptorSha256: string
  planKey: string
}
export type ResearchExecutionPreflightRequest = Omit<
  ResearchExecutionBinding,
  'descriptorSha256'
> & {
  sessionId: string
  profileId?: string
}
export type ResearchExecutionProfileView = {
  profileId: string
  binding: ResearchExecutionBinding
  displayName: string
  variables: Record<string, string>
  allowedNetworkHosts: string[]
  conditionChanges: string[]
  configuredCredentialKeys: string[]
  updatedAt: number
}
export type ResearchExecutionPreflight = {
  status: 'ready' | 'blocked'
  sourceTitle?: string
  planTitle?: string
  binding?: ResearchExecutionBinding
  issues: Array<{
    code:
      | 'description-unavailable'
      | 'plan-unavailable'
      | 'material-unavailable'
      | 'runtime-unavailable'
      | 'profile-required'
      | 'profile-unavailable'
      | 'credential-required'
      | 'credential-unavailable'
    key?: string
  }>
  compatibleRuntimeIds: string[]
  profiles: ResearchExecutionProfileView[]
  selectedProfileId?: string
  slots: Array<{
    key: string
    description: string
    environmentVariable: string
    required: boolean
    status: 'configured' | 'missing' | 'unavailable'
  }>
  remoteServicesVerified: false
}
/** Local authenticated operations. No model task is started by these methods. */
export type ResearchExecutionConfigurationSnapshot = {
  configurationId: string
  requestId: string
  scope: ResearchExecutionPreflightRequest
  status: 'pending' | 'configured' | 'dismissed' | 'expired'
  preflight: ResearchExecutionPreflight
  createdAt: number
  expiresAt: number
  profileId?: string
}
export type ManagedExecutionClient = {
  /** Ask the local user to configure services in the trusted desktop. Never executes a research run. */
  requestConfiguration(
    request: ResearchExecutionPreflightRequest & { requestId: string },
    options?: RequestOptions
  ): Promise<ResearchExecutionConfigurationSnapshot>
  getConfiguration(
    request: ManagedSessionScope & { configurationId: string },
    options?: RequestOptions
  ): Promise<ResearchExecutionConfigurationSnapshot>
  /** Inspect original research prerequisites without running, installing, or falling back to a demo. */
  preflight(
    request: ResearchExecutionPreflightRequest,
    options?: RequestOptions
  ): Promise<ResearchExecutionPreflight>
  runtimes(
    request?: Record<string, never>,
    options?: RequestOptions
  ): Promise<ManagedRuntimeDiscovery>
  createSession(
    request: CreateManagedSessionRequest,
    options?: RequestOptions
  ): Promise<ManagedSessionScope>
  inspectMaterials(
    request: InspectManagedMaterialsRequest,
    options?: RequestOptions
  ): Promise<ManagedMaterialsInspection>
  prepare(
    request: PrepareManagedEnvironmentRequest,
    options?: RequestOptions
  ): Promise<ManagedEnvironment>
  execute(
    request: ExecuteManagedEnvironmentRequest,
    options?: RequestOptions
  ): Promise<SessionOperationSnapshot>
  getOperation(
    request: ManagedOperationReference,
    options?: RequestOptions
  ): Promise<SessionOperationSnapshot | undefined>
  cancelOperation(
    request: ManagedOperationReference,
    options?: RequestOptions
  ): Promise<SessionOperationSnapshot | undefined>
  /** Wait 1..60000 ms (default 30000); timeout returns the current snapshot, without cancelling. */
  waitOperation(
    request: ManagedOperationReference & { timeoutMs?: number },
    options?: RequestOptions
  ): Promise<SessionOperationSnapshot | undefined>
  getEnvironment(
    request: ManagedEnvironmentReference,
    options?: RequestOptions
  ): Promise<ManagedEnvironment>
  /** Request cleanup; pending outputs remain until their exact Versions and receipt are published. */
  releaseEnvironment(
    request: ManagedEnvironmentReference,
    options?: RequestOptions
  ): Promise<ManagedEnvironment>
  /** Save retained outputs without rerunning the command; observe this operation by requestId. */
  collectOutputs(
    request: CollectManagedOutputsRequest,
    options?: RequestOptions
  ): Promise<SessionOperationSnapshot>
  /** Explicitly abandon this pending collection; already published Artifacts remain immutable. */
  discardOutputs(
    request: ManagedCollectionReference,
    options?: RequestOptions
  ): Promise<ManagedEnvironment>
}

export type PackageImportTarget =
  { projectId: string; projectName?: never } | { projectName: string; projectId?: never }
export type PackagePreview = {
  title: string
  projectName: string
  branchCount: number
  messageCount: number
  fileCount: number
  totalBytes: number
  omissions: Array<{ kind: 'missing' | 'excluded' | 'external'; description: string }>
}
export type PackageImportPreflightRequest = { filePath: string; target: PackageImportTarget }
export type PackageImportPreflight = {
  target: PackageImportTarget
  preflightId: string
  filename: string
  preview: PackagePreview
  expiresAt: number
}
export type PackageExportRequest = {
  projectId: string
  sessionId: string
  filePath: string
  excludedStorageKeys?: string[]
  includePdfNotes?: boolean
}
/** Authenticated local paths only. Import publishes nothing until an explicit commit. */
export type SessionPackagesClient = {
  preflightImport(
    request: PackageImportPreflightRequest,
    options?: RequestOptions
  ): Promise<PackageImportPreflight>
  commitImport(
    request: { preflightId: string },
    options?: RequestOptions
  ): Promise<{
    projectId: string
    sessionId: string
    cleanupPending: boolean
  }>
  cancelImport(
    request: { preflightId: string },
    options?: RequestOptions
  ): Promise<{ cancelled: boolean }>
  export(
    request: PackageExportRequest,
    options?: RequestOptions
  ): Promise<{
    filePath: string
    preview: PackagePreview
    cleanupPending: boolean
  }>
}

/** At least one exact operationId, executionInvocationId or runId is required at runtime. */
export class OpenScienceClient {
  readonly packages: SessionPackagesClient
  readonly execution: ManagedExecutionClient
  constructor(options: {
    baseUrl: string
    token: string
    fetch?: typeof globalThis.fetch
    sleep?: (milliseconds: number) => Promise<void>
    requestTimeoutMs?: number
  })
  health(options?: RequestOptions): Promise<unknown>
  bootstrap(request: BootstrapRequest, options?: RequestOptions): Promise<BootstrapResult>
  installCli(
    options?: RequestOptions
  ): Promise<{ installed: boolean; onPath: boolean; target: string; pathHint?: string }>
  doctor(options?: RequestOptions): Promise<DoctorReport>
  listRuntimes(options?: RequestOptions): Promise<AgentRuntime[]>
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
      /** Deny unresolved human interactions without changing the authorization profile. */
      permissionPrompts?: 'none'
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
  /** Explicitly cancels the server run and waits for finalization. */
  cancelRun(runId: string, options?: RequestOptions): Promise<Run>
  waitForRun(
    runId: string,
    options?: {
      /** Finite positive delay between polls; defaults to 250 milliseconds. */
      pollIntervalMs?: number
      /** Returns a still-running run when it needs attention; defaults to false. */
      returnOnAttention?: boolean
      /** Stops local waiting without cancelling the run. */
      signal?: AbortSignal
      /** Total wait budget; omitted means no total deadline. Each poll retains requestTimeoutMs. */
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
