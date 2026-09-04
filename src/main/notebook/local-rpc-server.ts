import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import {
  computeProbeSnapshot,
  type AgentComputeHostSummary,
  type ComputeHost,
  type ComputeHostDetails
} from '../../shared/compute'
import type { HostLineageGraph, HostLineageVersion } from '../../shared/host-lineage'
import { isCurrentInFlight } from '../../shared/in-flight-promise'
import type { NotebookRunProvenanceContext } from '../../shared/notebook'
import type { HostArtifactCatalogItem } from '../../shared/project-files'
import {
  createArtifactVersionLocator,
  parseArtifactVersionLocator
} from '../../shared/artifact-provenance'
import { createUploadVersionReference, parseUploadVersionReference } from '../../shared/uploads'
import type { NotebookRpcConnection } from './mcp-server'
import { NotebookControlCompletionCapturedError } from './execution-owner'
import {
  NOTEBOOK_LOCAL_RPC_METHODS,
  isNotebookLocalRpcMethod,
  opensNotebookInputRun,
  resolveNotebookLocalRpcHandler,
  type NotebookLocalRpcCapability
} from './local-rpc-notebook-adapter'
import type {
  NotebookInputRegistry,
  NotebookInputRunLease,
  RegisterNotebookTurnInputsRequest
} from './input-registry'
import type {
  ConversationSkillImporter,
  ConversationSkillImportRequest
} from '../skills/conversation-import'
import type {
  ArtifactRpcCapabilityBinding,
  ArtifactRpcMethod,
  ArtifactWriteReservation,
  ArtifactVersionFile,
  CreateArtifactVersionRequest,
  ReleaseArtifactWriteReservationRequest,
  ReserveArtifactWriteRequest,
  ReplayArtifactVersionRequest
} from '../../shared/artifact-provenance'
import {
  sanitizeAgentUserChoiceRequest,
  type AgentUserChoiceRequest,
  type AgentUserChoiceResult
} from '../../shared/elicitation'
import {
  stripAgentsReservedParams,
  type TrustedCallingSession,
  type TrustedControlInvocationIdentity
} from '../../shared/agents-contract'
import {
  NOTEBOOK_REPL_DEFAULT_TIMEOUT_MS,
  NOTEBOOK_SHELL_DEFAULT_TIMEOUT_MS,
  type NotebookExecutionRpcMethod
} from '../../shared/notebook'
import {
  listenForLocalRpc,
  localRpcServerLogFields,
  type LocalRpcListenOptions
} from '../local-rpc-transport'
import { createLogger, errorLogFields } from '../logger'
import {
  LOCAL_RESOURCE_BUDGETS,
  ResourceBudgetExceededError,
  readBoundedJsonBody
} from '../resource-budget'
import { PlanCommandError } from '../../shared/session-plan/contract'
import type { HostLlmCallInput, HostLlmResult, HostLlmBatchItem } from './host-model-service'
import type {
  AuthenticatedDelegateCaller,
  DurableDelegateRequest,
  DurableDelegatedWork
} from '../delegation/durable-delegated-work'
import {
  DELEGATION_INPUT_UNAVAILABLE_MESSAGE,
  assertDelegateInputShape,
  assertDelegateRequestShape
} from '../delegation/delegated-work-admission'
import { hostSdkHelp } from '../host-sdk/help'
import {
  projectHostCapabilities,
  type HostCapabilityProjection
} from '../host-sdk/capability-projection'
import { parseCollectRpcCall, parseDelegateRpcCall } from '../host-sdk/delegate-contract'
import { createNestedDelegateInvocationId } from '../../shared/delegated-caller-source'
import { StructuredOutputError } from '../delegation/structured-output'
import type {
  HostViewImageContext,
  HostViewImageResult,
  TransientViewImage
} from './host-view-image-service'
import {
  memoryAgentRememberRequestSchema,
  memoryAgentSearchRequestSchema,
  type MemoryAgentContext
} from '../../shared/memory'
import type { MemoryService } from '../memory/service'
import { withDataRootWrite } from '../storage/migration-state'
import { isRecord } from '../value-guards'

const log = createLogger('notebook:local-rpc')
const MAX_COMPLETED_COMPUTE_SUBMISSIONS_PER_SESSION = 100

type NotebookLocalRpcServerOptions = {
  token?: string
  host?: string
  requestBytes?: number
  now?: () => number
  onSessionReleased?: (sessionId: string) => void
  isHostSkillsAvailable?: (sessionId: string) => boolean
  resolveSpecialistSkillIds?: (specialistId: string) => Promise<readonly string[]>
  transport?: LocalRpcListenOptions['transport']
  connectorService?: {
    call(
      server: string,
      method: string,
      args: Record<string, unknown>,
      context?: {
        sessionId?: string
        projectId?: string
        origin?: 'agent' | 'internal'
        specialistId?: string
      },
      signal?: AbortSignal
    ): Promise<unknown>
  }
  memoryService?: Pick<
    MemoryService,
    'listCategoriesForAgent' | 'searchForAgent' | 'rememberForAgent'
  >
  isMemoryEnabledForSession?: (sessionId: string) => boolean | Promise<boolean>
  computeService?: {
    callCommand(
      context: { sessionId: string; projectId: string },
      providerId: string,
      cmd: string,
      intent: string,
      loginShell?: boolean,
      timeoutSeconds?: number,
      signal?: AbortSignal
    ): Promise<unknown>
    list(sessionId: string): Promise<ComputeHost[]>
    listHosts(sessionId: string): Promise<AgentComputeHostSummary[]>
    listRegistered(sessionId: string): Promise<AgentComputeHostSummary[]>
    listPreferred(sessionId: string): Promise<AgentComputeHostSummary[]>
    listCompute(sessionId: string): string[]
    getDetails(sessionId: string, providerId: string): Promise<ComputeHostDetails>
    appendDetails(
      sessionId: string,
      providerId: string,
      args: { text: string; author: 'agent' }
    ): Promise<void>
    replaceDetails(
      sessionId: string,
      providerId: string,
      args: { text: string; oldText: string; author: 'agent' }
    ): Promise<void>
    download(
      context: { sessionId: string; projectId: string },
      providerId: string,
      remotePath: string,
      dest: { kind: 'session-cache' },
      signal?: AbortSignal
    ): Promise<unknown>
    submitJob(
      context: { sessionId: string; projectId: string },
      providerId: string,
      intent: string,
      command: string,
      options: {
        environment?: string
        resourceRequest?: string
        inputs?: unknown[]
        outputManifest?: string
        harvestConfig?: string
        timeoutSeconds?: number
        workspaceCwd?: string
      },
      signal?: AbortSignal
    ): Promise<unknown>
    getJobStatus(
      context: { sessionId: string; projectId: string },
      providerId: string,
      jobId: string
    ): Promise<unknown>
    cancelJob(
      context: { sessionId: string; projectId: string },
      providerId: string,
      jobId: string
    ): Promise<unknown>
    getJobResult(
      context: { sessionId: string; projectId: string },
      providerId: string,
      jobId: string
    ): Promise<unknown>
    // Session-level concurrency control (Phase 3c, issue 05).
    setSessionConcurrencyLimit(sessionId: string, limit: number): Promise<void>
    getSessionConcurrencyStatus(sessionId: string): Promise<{
      session_limit: number | null
      active_count: number
      queued_count: number
      provider_ceilings: Record<string, number>
    }>
  }
  skillImporter?: Pick<ConversationSkillImporter, 'request'>
  planService?: {
    call(input: {
      projectId: string
      sessionId: string
      operation: 'generate' | 'approve' | 'reject' | 'updateStepStatus'
      input?: unknown
      signal: AbortSignal
    }): Promise<unknown>
  }
  requestUserInput?: (request: AgentUserChoiceRequest) => Promise<AgentUserChoiceResult>
  artifactProvenance?: {
    createVersion(
      request: CreateArtifactVersionRequest,
      signal?: AbortSignal
    ): Promise<ArtifactVersionFile>
    replayVersion?(request: ReplayArtifactVersionRequest): Promise<ArtifactVersionFile | undefined>
    reserveWrite?(request: ReserveArtifactWriteRequest): Promise<ArtifactWriteReservation>
    releaseWriteReservation?(request: ReleaseArtifactWriteReservationRequest): Promise<void>
    releaseRunWriteReservations?(request: {
      projectId: string
      appSessionId: string
      artifactStorageSessionId: string
      artifactRunId: string
    }): Promise<void>
    releaseAllWriteReservations?(): Promise<void>
  }
  inputRegistry?: Pick<NotebookInputRegistry, 'registerTurn' | 'getTurnInputs' | 'clearSession'> &
    Partial<Pick<NotebookInputRegistry, 'openRun'>>
  hostArtifacts?: {
    list(options: unknown, context: { projectId: string; sessionId: string }): Promise<unknown>
    resolvePath(
      versionId: unknown,
      context: { projectId: string; sessionId: string }
    ): Promise<string>
  }
  delegationInputCatalog?: {
    readHostArtifactCatalog(request: {
      projectId: string
      versionId: string
      finalizedArtifactsOnly: true
    }): Promise<HostArtifactCatalogItem[]>
  }
  hostLineage?: {
    graph(
      versionId: unknown,
      options: unknown,
      context: { projectId: string; sessionId: string }
    ): Promise<HostLineageGraph>
    get(
      versionId: unknown,
      context: { projectId: string; sessionId: string }
    ): Promise<HostLineageVersion>
  }
  hostFrames?: {
    list(options: unknown, context: { projectId: string; sessionId: string }): Promise<unknown>
    get(
      frameId: unknown,
      options: unknown,
      context: { projectId: string; sessionId: string }
    ): Promise<unknown>
  }
  hostSessions?: {
    list(
      options: unknown,
      context: { projectId: string; sessionId: string; callerRole: 'main' }
    ): Promise<unknown>
    inspect(
      sessionId: unknown,
      context: { projectId: string; sessionId: string; callerRole: 'main' }
    ): Promise<unknown>
  }
  // host.agents control-plane SDK (issue 02): exposes the Specialist/catalog surface to the
  // JavaScript control-plane REPL via the extensible dispatcher. Never routed through host.mcp();
  // carries the trusted calling session identity captured outside the sandbox so switch()
  // (added later) cannot be forged. `read` is kept for backward compatibility and delegates to the
  // same dispatcher; the route calls it so existing wiring and tests stay green.
  agentsService?: {
    read(op: unknown, context: TrustedCallingSession): Promise<unknown>
    dispatch?(op: unknown, context: TrustedCallingSession): Promise<unknown>
  }
  delegatedWorkService?: Pick<DurableDelegatedWork, 'delegate'> &
    Partial<
      Pick<
        DurableDelegatedWork,
        | 'children'
        | 'collect'
        | 'stopChildren'
        | 'sendMessage'
        | 'messageReceipt'
        | 'resolveMessage'
        | 'submitOutput'
        | 'requestUserInput'
      >
    > &
    Readonly<{
      isDelegationAllowed?(session: { projectId: string; sessionId: string }): Promise<boolean>
    }>
  skillsService?: {
    dispatch(op: unknown, context: TrustedCallingSession): Promise<unknown>
  }
  hostModel?: {
    isLlmAvailable(): Promise<boolean>
    isCurrentModelAvailable(sessionId: string): Promise<boolean>
    isListModelsAvailable(): Promise<boolean>
    currentModel(sessionId: string): Promise<string>
    listModels(): Promise<readonly string[]>
    call(
      input: HostLlmCallInput,
      signal?: AbortSignal,
      context?: Readonly<{ projectId: string; sessionId: string }>
    ): Promise<HostLlmResult | readonly HostLlmBatchItem[]>
  }
  hostViewImage?: {
    isAvailable(context: { sessionId: string }): Promise<boolean>
    stage(
      source: unknown,
      options: unknown,
      context: HostViewImageContext
    ): Promise<HostViewImageResult>
    complete(controlInvocationId: string): Promise<readonly TransientViewImage[]>
    discard(controlInvocationId: string): void
    discardSession(sessionId: string): void
    shutdown(): void
  }
}

type ArtifactRpcCapability = Omit<ArtifactRpcCapabilityBinding, 'allowedMethods'> & {
  allowedMethods: Set<ArtifactRpcMethod>
  expiresAt: number
  inFlightRequests: number
  drainWaiters: Set<() => void>
}

type NotebookRpcSessionBinding = {
  sessionId: string
  projectId?: string
  agentFrameId?: string
  memoryTools?: boolean
  delegatedWorkRole?: 'main' | 'delegate'
  delegatedWorkAttemptId?: string
  allowedMethods?: ReadonlySet<string>
  activeControlInvocation?: TrustedControlInvocationIdentity
  executionCwd?: string
  isControl?: true
  delegatedNotebook?: {
    attemptId: string
    workspaceCwd: string
    provenanceContext: NotebookRunProvenanceContext
    isAttemptWritable: () => boolean | Promise<boolean>
    revoked: boolean
    inFlightRequests: number
    drainWaiters: Set<() => void>
  }
}

type NotebookExecutionAuthorization = Readonly<{
  executionInvocationId: string
  toolCallId: string
  promptMessageId: string
  inputFingerprint: string
}>

type ActiveArtifactTurnBinding = Readonly<{
  ownerExecutionId: string
  projectId: string
  provenanceContext: NotebookRunProvenanceContext
}>

type DelegatedNotebookConnectionRequest = Readonly<{
  projectId: string
  sessionId: string
  rootFrameId: string
  agentFrameId: string
  attemptId: string
  messageBranchId: string
  runtimeSegmentId: string
  promptMessageId: string
  workspaceCwd: string
  isAttemptWritable(): boolean | Promise<boolean>
}>

type DelegatedNotebookConnection = NotebookRpcConnection & {
  revoke(): Promise<void>
}

type NotebookRpcRequestLifecycle = {
  request: IncomingMessage
  response: ServerResponse
  disconnect: AbortController
  bodyComplete: boolean
  method?: string
}

type NotebookRpcServerLifecycle = {
  server: Server
  closing: boolean
  activeRequests: Set<NotebookRpcRequestLifecycle>
}

class RpcHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message)
  }
}

// Only wrap synchronous request parsers, never an owner/service call: an internal schema or JSON
// failure must remain a server error rather than being blamed on the caller.
const parseRpcParams = <Result>(parse: () => Result): Result => {
  try {
    return parse()
  } catch (error) {
    throw new RpcHttpError(400, error instanceof Error ? error.message : String(error))
  }
}

const ARTIFACT_RPC_METHODS = new Set<ArtifactRpcMethod>([
  'artifactReserveWrite',
  'artifactReleaseWrite',
  'artifactCreateVersion',
  'artifactReplayVersion'
])

// Capabilities are revoked when the turn ends. This upper bound only limits abandoned tokens, so
// it must comfortably exceed long notebook executions that remain inside one active turn.
const DEFAULT_ARTIFACT_RPC_CAPABILITY_TTL_MS = 2 * 60 * 60 * 1_000
// Let ordinary RPCs that are already producing a result drain before forcing the transport closed.
// This remains comfortably inside the application module's one-second disposal budget.
const LOCAL_RPC_CLOSE_GRACE_MS = 100
const CONTROL_RPC_METHODS = new Set([
  'capabilitiesCall',
  'artifactsCall',
  'lineageCall',
  'framesCall',
  'sessionsCall',
  'mcpCall',
  'computeCall',
  'agentsCall',
  'hostSdkHelp',
  'delegatedWorkCall',
  'skillsCall',
  'llmCall',
  'currentModelCall',
  'listModelsCall',
  'viewImageCall',
  'requestUserInput',
  'memoryListCategories',
  'memorySearch',
  'memoryRemember'
])
const MEMORY_RPC_METHODS = new Set(['memoryListCategories', 'memorySearch', 'memoryRemember'])
const DELEGATED_CONTROL_RPC_METHODS = new Set([
  ...[...CONTROL_RPC_METHODS].filter((method) => !MEMORY_RPC_METHODS.has(method)),
  'delegatedOutputCall'
])
const SKILL_IMPORT_RPC_METHODS = new Set(['skillImport'])
const PLAN_RPC_METHODS = new Set(['planCall'])

const RPC_METHODS = new Set<string>([
  ...NOTEBOOK_LOCAL_RPC_METHODS,
  ...CONTROL_RPC_METHODS,
  ...ARTIFACT_RPC_METHODS,
  ...SKILL_IMPORT_RPC_METHODS,
  ...PLAN_RPC_METHODS,
  'delegatedOutputCall',
  'resolveNotebookInput'
])

const isArtifactRpcMethod = (method: string): method is ArtifactRpcMethod =>
  ARTIFACT_RPC_METHODS.has(method as ArtifactRpcMethod)

// Narrows parsed JSON into a plain object before dispatching RPC params.
// Session, prompt, method, and one-shot ownership are checked separately. This digest binds the
// authorization to executable input so a racing same-method request cannot take another Tool's join.
const notebookExecutionInputFingerprint = (
  method: NotebookExecutionRpcMethod,
  rawInput: unknown
): string | undefined => {
  const outer = isRecord(rawInput) ? rawInput : undefined
  const input = isRecord(outer?.arguments) ? outer.arguments : outer
  const executable = input?.[method === 'executeShell' ? 'command' : 'code']
  if (typeof executable !== 'string') return undefined
  const timeoutMs =
    method === 'executeControl'
      ? typeof input?.timeoutMs === 'number'
        ? input.timeoutMs
        : NOTEBOOK_REPL_DEFAULT_TIMEOUT_MS
      : method === 'executeShell'
        ? typeof input?.timeoutMs === 'number'
          ? input.timeoutMs
          : NOTEBOOK_SHELL_DEFAULT_TIMEOUT_MS
        : null
  // Match host request normalization: omission and [] are equivalent, duplicates collapse, and
  // first-request order remains significant because it is also skill initialization order.
  const kernelSkillIds =
    method !== 'execute' || input?.kernelSkillIds === undefined
      ? []
      : Array.isArray(input.kernelSkillIds) &&
          input.kernelSkillIds.every((skillId): skillId is string => typeof skillId === 'string')
        ? [...new Set(input.kernelSkillIds)]
        : undefined
  if (kernelSkillIds === undefined) return undefined
  const artifactVersionInputs =
    method !== 'execute' || input?.artifactVersionInputs === undefined
      ? []
      : Array.isArray(input.artifactVersionInputs) &&
          input.artifactVersionInputs.every(
            (versionId): versionId is string => typeof versionId === 'string'
          )
        ? [...new Set(input.artifactVersionInputs)]
        : undefined
  if (artifactVersionInputs === undefined) return undefined

  return createHash('sha256')
    .update(
      JSON.stringify([
        method,
        executable,
        timeoutMs,
        method === 'execute' && typeof input?.language === 'string'
          ? input.language.toLowerCase()
          : method === 'execute'
            ? 'python'
            : null,
        method === 'execute' && typeof input?.cellId === 'string' ? input.cellId : null,
        kernelSkillIds,
        artifactVersionInputs
      ])
    )
    .digest('hex')
}

// Writes one JSON response with an explicit HTTP status code.
const writeJson = (response: ServerResponse, statusCode: number, payload: unknown): void => {
  response.writeHead(statusCode, { 'content-type': 'application/json' })
  response.end(`${JSON.stringify(payload)}\n`)
}

const closeRequestAfterResponse = (request: IncomingMessage, response: ServerResponse): void => {
  response.shouldKeepAlive = false
  if (!response.headersSent) response.setHeader('connection', 'close')
  if (response.writableFinished) request.destroy()
  else response.once('finish', () => request.destroy())
}

// Hosts an authenticated app-local bridge between MCP stdio tools and the runtime service. The wire
// protocol is HTTP/JSON; Windows carries it over a named pipe instead of loopback TCP.
class NotebookLocalRpcServer {
  private readonly token: string
  private readonly host: string
  private readonly requestBytes: number
  private readonly now: () => number
  private readonly onSessionReleased: NotebookLocalRpcServerOptions['onSessionReleased']
  private readonly isHostSkillsAvailable: NotebookLocalRpcServerOptions['isHostSkillsAvailable']
  private readonly transport: NotebookLocalRpcServerOptions['transport']
  private readonly connectorService: NotebookLocalRpcServerOptions['connectorService']
  private readonly memoryService: NotebookLocalRpcServerOptions['memoryService']
  private readonly isMemoryEnabledForSession: NotebookLocalRpcServerOptions['isMemoryEnabledForSession']
  private readonly computeService: NotebookLocalRpcServerOptions['computeService']
  private readonly skillImporter: NotebookLocalRpcServerOptions['skillImporter']
  private readonly planService: NotebookLocalRpcServerOptions['planService']
  private readonly requestUserInput: NotebookLocalRpcServerOptions['requestUserInput']
  private readonly artifactProvenance: NotebookLocalRpcServerOptions['artifactProvenance']
  private readonly inputRegistry: NotebookLocalRpcServerOptions['inputRegistry']
  private readonly hostArtifacts: NotebookLocalRpcServerOptions['hostArtifacts']
  private readonly delegationInputCatalog: NotebookLocalRpcServerOptions['delegationInputCatalog']
  private readonly hostLineage: NotebookLocalRpcServerOptions['hostLineage']
  private readonly hostFrames: NotebookLocalRpcServerOptions['hostFrames']
  private readonly hostSessions: NotebookLocalRpcServerOptions['hostSessions']
  private readonly agentsService: NotebookLocalRpcServerOptions['agentsService']
  private readonly delegatedWorkService: NotebookLocalRpcServerOptions['delegatedWorkService']
  private readonly skillsService: NotebookLocalRpcServerOptions['skillsService']
  private readonly hostModel: NotebookLocalRpcServerOptions['hostModel']
  private readonly hostViewImage: NotebookLocalRpcServerOptions['hostViewImage']
  private readonly resolveSpecialistSkillIds: NotebookLocalRpcServerOptions['resolveSpecialistSkillIds']
  private server: Server | undefined
  private serverLifecycle: NotebookRpcServerLifecycle | undefined
  private startPromise: Promise<NotebookRpcConnection> | undefined
  private closePromise: Promise<void> | undefined
  private readonly sessionAliases = new Map<string, string>()
  private readonly sessionRpcCapabilities = new Map<string, NotebookRpcSessionBinding>()
  private readonly sessionRpcTokens = new Map<string, string>()
  private readonly skillImportRpcTokens = new Map<string, string>()
  private readonly planRpcTokens = new Map<string, string>()
  // The session → Specialist relationship is established by the ACP runtime, not supplied by the
  // notebook process. Keeping it here prevents an agent from selecting another Specialist's scope
  // by forging an RPC parameter.
  private readonly sessionSpecialists = new Map<string, string>()
  private readonly activeArtifactTurnBindings = new Map<string, ActiveArtifactTurnBinding>()
  private readonly activeInputRunLeases = new Map<string, Set<NotebookInputRunLease>>()
  private readonly inputRunLeaseIds = new WeakMap<NotebookInputRunLease, string>()
  private readonly artifactRpcCapabilities = new Map<string, ArtifactRpcCapability>()
  private readonly drainingArtifactRpcCapabilities = new Map<string, Promise<void>>()
  private readonly executionAuthorizations = new Map<
    string,
    Map<NotebookExecutionRpcMethod, NotebookExecutionAuthorization | 'ambiguous'>
  >()
  private readonly consumedExecutionToolCalls = new Map<string, Set<string>>()
  private readonly computeSubmissionInvocations = new Map<
    string,
    Map<string, { fingerprint: string; submission: Promise<unknown>; completed: boolean }>
  >()

  constructor(
    private readonly service: NotebookLocalRpcCapability,
    options: NotebookLocalRpcServerOptions = {}
  ) {
    this.token = options.token ?? randomUUID()
    this.host = options.host ?? '127.0.0.1'
    this.requestBytes = options.requestBytes ?? LOCAL_RESOURCE_BUDGETS.requestBytes
    this.now = options.now ?? Date.now
    this.onSessionReleased = options.onSessionReleased
    this.isHostSkillsAvailable = options.isHostSkillsAvailable
    this.resolveSpecialistSkillIds = options.resolveSpecialistSkillIds
    this.transport = options.transport
    this.connectorService = options.connectorService
    this.memoryService = options.memoryService
    this.isMemoryEnabledForSession = options.isMemoryEnabledForSession
    this.computeService = options.computeService
    this.skillImporter = options.skillImporter
    this.planService = options.planService
    this.requestUserInput = options.requestUserInput
    this.artifactProvenance = options.artifactProvenance
    this.inputRegistry = options.inputRegistry
    this.hostArtifacts = options.hostArtifacts
    this.delegationInputCatalog = options.delegationInputCatalog
    this.hostLineage = options.hostLineage
    this.hostFrames = options.hostFrames
    this.hostSessions = options.hostSessions
    this.agentsService = options.agentsService
    this.delegatedWorkService = options.delegatedWorkService
    this.skillsService = options.skillsService
    this.hostModel = options.hostModel
    this.hostViewImage = options.hostViewImage
  }

  issueArtifactRunCapability(
    binding: ArtifactRpcCapabilityBinding,
    ttlMs = DEFAULT_ARTIFACT_RPC_CAPABILITY_TTL_MS
  ): string {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('Artifact RPC capability lifetime must be positive.')
    }
    const token = randomUUID()
    this.artifactRpcCapabilities.set(token, {
      ...binding,
      messageBranchAncestry: binding.messageBranchAncestry
        ? [...binding.messageBranchAncestry]
        : undefined,
      messageAncestry: binding.messageAncestry ? [...binding.messageAncestry] : undefined,
      allowedMethods: new Set(
        binding.allowedMethods ?? [
          'artifactReserveWrite',
          'artifactReleaseWrite',
          'artifactCreateVersion',
          'artifactReplayVersion'
        ]
      ),
      expiresAt: this.now() + ttlMs,
      inFlightRequests: 0,
      drainWaiters: new Set()
    })
    return token
  }

  async revokeArtifactRunCapability(token: string): Promise<void> {
    const draining = this.drainingArtifactRpcCapabilities.get(token)
    if (draining) return draining

    const capability = this.artifactRpcCapabilities.get(token)
    this.artifactRpcCapabilities.delete(token)
    if (!capability) return
    const releaseReservations = (): Promise<void> =>
      this.artifactProvenance?.releaseRunWriteReservations?.({
        projectId: capability.projectId,
        appSessionId: capability.appSessionId,
        artifactStorageSessionId: capability.artifactStorageSessionId,
        artifactRunId: capability.artifactRunId
      }) ?? Promise.resolve()
    if (capability.inFlightRequests === 0) {
      await releaseReservations()
      return
    }

    const drain = new Promise<void>((resolve) => {
      capability.drainWaiters.add(resolve)
    })
    this.drainingArtifactRpcCapabilities.set(token, drain)
    void drain.then(() => {
      if (this.drainingArtifactRpcCapabilities.get(token) === drain) {
        this.drainingArtifactRpcCapabilities.delete(token)
      }
    })
    await drain
    await releaseReservations()
  }

  // Starts the server once on an ephemeral port and returns the connection details for MCP env.
  async ensureStarted(): Promise<NotebookRpcConnection> {
    if (this.startPromise) {
      return this.startPromise
    }
    if (this.closePromise) {
      await this.closePromise
      if (this.startPromise) return this.startPromise
    }

    const server = createServer((request, response) => {
      void this.handleRequest(lifecycle, request, response)
    })
    const lifecycle: NotebookRpcServerLifecycle = {
      server,
      closing: false,
      activeRequests: new Set()
    }
    this.server = server
    this.serverLifecycle = lifecycle
    log.info('notebook RPC server starting', {
      transport: this.transport ?? (process.platform === 'win32' ? 'pipe' : 'tcp'),
      listening: server.listening
    })
    this.startPromise = listenForLocalRpc(server, {
      name: 'notebook-rpc',
      host: this.host,
      transport: this.transport
    })
      .then((connection) => {
        log.info('notebook RPC server listening', localRpcServerLogFields(server))
        return { ...connection, token: this.token }
      })
      .catch((error) => {
        log.error('notebook RPC server failed to listen', {
          ...localRpcServerLogFields(server),
          ...errorLogFields(error)
        })
        throw error
      })

    return this.startPromise
  }

  // Stops the local HTTP server without touching notebook history or runtime state.
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    const lifecycle = this.serverLifecycle
    const server = lifecycle?.server ?? this.server

    this.server = undefined
    this.serverLifecycle = undefined
    this.startPromise = undefined
    this.artifactRpcCapabilities.clear()
    for (const binding of this.sessionRpcCapabilities.values()) {
      if (binding.activeControlInvocation) {
        this.hostViewImage?.discard(binding.activeControlInvocation.toolInvocationId)
      }
      this.hostViewImage?.discardSession(binding.sessionId)
    }
    this.sessionRpcCapabilities.clear()
    this.hostViewImage?.shutdown()
    this.sessionRpcTokens.clear()
    this.skillImportRpcTokens.clear()
    this.executionAuthorizations.clear()
    this.consumedExecutionToolCalls.clear()
    this.computeSubmissionInvocations.clear()

    if (!server || !lifecycle) {
      return this.artifactProvenance?.releaseAllWriteReservations?.() ?? Promise.resolve()
    }

    lifecycle.closing = true

    const connection = localRpcServerLogFields(server)
    let beginClose!: () => void
    let forceCloseTimer: ReturnType<typeof setTimeout> | undefined
    const operation = new Promise<void>((resolve, reject) => {
      beginClose = () => {
        for (const active of lifecycle.activeRequests) {
          if (!active.bodyComplete) {
            active.disconnect.abort()
            active.request.destroy()
            active.response.destroy()
          } else if (active.method === 'planCall') {
            active.disconnect.abort()
          }
        }
        forceCloseTimer = setTimeout(() => {
          for (const active of lifecycle.activeRequests) {
            active.disconnect.abort()
            active.request.destroy()
            active.response.destroy()
          }
          // A socket with incomplete HTTP headers has not emitted `request` and therefore is absent
          // from activeRequests. Force-close the server's remaining connections so malformed or
          // stalled clients cannot hold shutdown open past the grace window.
          server.closeAllConnections()
        }, LOCAL_RPC_CLOSE_GRACE_MS)
        log.info('notebook RPC server stopping', connection)
        try {
          server.close((error) => {
            if (forceCloseTimer) clearTimeout(forceCloseTimer)
            if (error) reject(error)
            else {
              log.info('notebook RPC server stopped', {
                ...connection,
                listening: server.listening
              })
              resolve()
            }
          })
          server.closeIdleConnections()
        } catch (error) {
          if (forceCloseTimer) clearTimeout(forceCloseTimer)
          reject(error)
        }
      }
    })
    const operationWithReservationCleanup = operation.finally(() =>
      this.artifactProvenance?.releaseAllWriteReservations?.()
    )
    const ownedClose = operationWithReservationCleanup.finally(() => {
      if (forceCloseTimer) clearTimeout(forceCloseTimer)
      if (this.closePromise === ownedClose) this.closePromise = undefined
    })
    this.closePromise = ownedClose
    beginClose()
    return ownedClose
  }

  // Remembers the final ACP session id for notebook aliases created before session start.
  registerSessionAlias(aliasSessionId: string, sessionId: string): void {
    this.sessionAliases.set(aliasSessionId, sessionId)
    const activeRootContext = this.activeArtifactTurnBindings.get(sessionId)?.provenanceContext
    const canonicalRootFrameId =
      activeRootContext && activeRootContext.agentFrameId === activeRootContext.rootFrameId
        ? activeRootContext.agentFrameId
        : `root-frame-${sessionId}`

    // Root capabilities are created before the provider returns the canonical app Session id, and
    // the provider retains the original Agent-facing MCP route. Adopt only their exact provisional
    // root Frame alongside the Session alias; delegated child capabilities have independent durable
    // Frame ownership and are never rewritten here.
    for (const binding of this.sessionRpcCapabilities.values()) {
      if (
        binding.delegatedNotebook ||
        (binding.allowedMethods && binding.allowedMethods !== CONTROL_RPC_METHODS) ||
        binding.sessionId !== aliasSessionId ||
        binding.agentFrameId !== `root-frame-${aliasSessionId}`
      ) {
        continue
      }
      binding.sessionId = sessionId
      binding.agentFrameId = canonicalRootFrameId
    }
  }

  private resolveSessionCapabilityOwners(sessionId: string): Set<string> {
    const ownedSessionIds = new Set([sessionId])

    // Alias chains are not expected, but computing the small transitive closure keeps rotation and
    // revocation correct if an adopted session is ever remapped more than once.
    let foundAlias = true
    while (foundAlias) {
      foundAlias = false
      for (const [aliasSessionId, targetSessionId] of this.sessionAliases) {
        if (!ownedSessionIds.has(aliasSessionId) && !ownedSessionIds.has(targetSessionId)) continue
        if (!ownedSessionIds.has(aliasSessionId)) {
          ownedSessionIds.add(aliasSessionId)
          foundAlias = true
        }
        if (!ownedSessionIds.has(targetSessionId)) {
          ownedSessionIds.add(targetSessionId)
          foundAlias = true
        }
      }
    }

    return ownedSessionIds
  }

  private revokeAgentSessionCapabilities(sessionId: string): void {
    for (const ownedSessionId of this.resolveSessionCapabilityOwners(sessionId)) {
      const token = this.sessionRpcTokens.get(ownedSessionId)
      if (token) this.sessionRpcCapabilities.delete(token)
      this.sessionRpcTokens.delete(ownedSessionId)
    }
  }

  private revokeSkillImportSessionCapabilities(sessionId: string): void {
    for (const ownedSessionId of this.resolveSessionCapabilityOwners(sessionId)) {
      const token = this.skillImportRpcTokens.get(ownedSessionId)
      if (token) this.sessionRpcCapabilities.delete(token)
      this.skillImportRpcTokens.delete(ownedSessionId)
    }
  }

  private revokePlanSessionCapabilities(sessionId: string): void {
    for (const ownedSessionId of this.resolveSessionCapabilityOwners(sessionId)) {
      const token = this.planRpcTokens.get(ownedSessionId)
      if (token) this.sessionRpcCapabilities.delete(token)
      this.planRpcTokens.delete(ownedSessionId)
    }
  }

  // Releases ACP-owned session state without revoking the persistent control-plane capability. The
  // Notebook RuntimeSession owns that capability and revokes it through connection.release().
  releaseSessionCapabilities(sessionId: string): void {
    const ownedSessionIds = this.resolveSessionCapabilityOwners(sessionId)

    this.revokeAgentSessionCapabilities(sessionId)
    this.revokeSkillImportSessionCapabilities(sessionId)
    this.revokePlanSessionCapabilities(sessionId)
    for (const ownedSessionId of ownedSessionIds) {
      this.sessionSpecialists.delete(ownedSessionId)
      this.executionAuthorizations.delete(ownedSessionId)
      this.consumedExecutionToolCalls.delete(ownedSessionId)
      this.computeSubmissionInvocations.delete(ownedSessionId)
    }
    for (const [aliasSessionId, targetSessionId] of this.sessionAliases) {
      if (ownedSessionIds.has(aliasSessionId) || ownedSessionIds.has(targetSessionId)) {
        this.sessionAliases.delete(aliasSessionId)
      }
    }
    this.onSessionReleased?.(sessionId)
  }

  // Creates the app-owned half of an exact ACP-tool/Notebook-Run join before permission is released.
  // The authenticated RPC bridge consumes it only for the matching method and active prompt. Two
  // different unclaimed calls for the same lane become ambiguous and therefore never show running.
  authorizeExecution(authorization: {
    sessionId: string
    toolCallId: string
    promptMessageId: string
    method: NotebookExecutionRpcMethod
    rawInput?: unknown
  }): string | undefined {
    const sessionId = this.sessionAliases.get(authorization.sessionId) ?? authorization.sessionId
    const inputFingerprint = notebookExecutionInputFingerprint(
      authorization.method,
      authorization.rawInput
    )
    if (
      !inputFingerprint ||
      this.activeArtifactTurnBindings.get(sessionId)?.provenanceContext.promptMessageId !==
        authorization.promptMessageId ||
      this.consumedExecutionToolCalls.get(sessionId)?.has(authorization.toolCallId)
    ) {
      return undefined
    }

    const byMethod = this.executionAuthorizations.get(sessionId) ?? new Map()
    const existing = byMethod.get(authorization.method)
    if (existing === 'ambiguous') return undefined
    if (
      existing?.toolCallId === authorization.toolCallId &&
      existing.inputFingerprint === inputFingerprint
    ) {
      return existing.executionInvocationId
    }
    if (existing) {
      byMethod.set(authorization.method, 'ambiguous')
      this.executionAuthorizations.set(sessionId, byMethod)
      return undefined
    }

    const executionInvocationId = randomUUID()
    byMethod.set(authorization.method, {
      executionInvocationId,
      toolCallId: authorization.toolCallId,
      promptMessageId: authorization.promptMessageId,
      inputFingerprint
    })
    this.executionAuthorizations.set(sessionId, byMethod)
    return executionInvocationId
  }

  private claimExecutionAuthorization(
    sessionId: string,
    method: string,
    params: Record<string, unknown>
  ): string | undefined {
    if (method !== 'execute' && method !== 'executeControl' && method !== 'executeShell') {
      return undefined
    }
    const byMethod = this.executionAuthorizations.get(sessionId)
    const authorization = byMethod?.get(method)
    byMethod?.delete(method)
    if (byMethod?.size === 0) this.executionAuthorizations.delete(sessionId)
    if (!authorization || authorization === 'ambiguous') return undefined
    const consumed = this.consumedExecutionToolCalls.get(sessionId) ?? new Set<string>()
    consumed.add(authorization.toolCallId)
    this.consumedExecutionToolCalls.set(sessionId, consumed)
    if (
      this.activeArtifactTurnBindings.get(sessionId)?.provenanceContext.promptMessageId !==
        authorization.promptMessageId ||
      notebookExecutionInputFingerprint(method, params) !== authorization.inputFingerprint
    ) {
      return undefined
    }
    return authorization.executionInvocationId
  }

  private async canonicalizeDelegationInputs(
    requestOrRequests: DurableDelegateRequest | readonly DurableDelegateRequest[],
    caller: AuthenticatedDelegateCaller
  ): Promise<DurableDelegateRequest | readonly DurableDelegateRequest[]> {
    const requests = parseRpcParams(() => assertDelegateRequestShape(requestOrRequests))
    parseRpcParams(() => assertDelegateInputShape(requests))
    const bareIdentityLookups = new Map<string, Promise<string>>()
    const canonicalizeBareIdentity = (identity: string): Promise<string> => {
      const pending = bareIdentityLookups.get(identity)
      if (pending) return pending
      const lookup = (async () => {
        if (!this.delegationInputCatalog) {
          throw new Error(DELEGATION_INPUT_UNAVAILABLE_MESSAGE)
        }
        const candidates = await this.delegationInputCatalog.readHostArtifactCatalog({
          projectId: caller.session.projectId,
          versionId: identity,
          finalizedArtifactsOnly: true
        })
        const item = candidates.length === 1 ? candidates[0] : undefined
        if (
          !item ||
          item.projectId !== caller.session.projectId ||
          item.sessionId !== caller.session.sessionId
        ) {
          throw new RpcHttpError(403, DELEGATION_INPUT_UNAVAILABLE_MESSAGE)
        }
        return item.source === 'upload'
          ? createUploadVersionReference(item.versionId, {
              projectId: item.projectId,
              sessionId: item.sessionId
            })
          : createArtifactVersionLocator({
              projectId: item.projectId,
              appSessionId: item.sessionId,
              artifactId: item.sourceFileId,
              versionId: item.versionId
            })
      })()
      bareIdentityLookups.set(identity, lookup)
      return lookup
    }
    const canonicalized = await Promise.all(
      requests.map(async (request) => {
        if (!Array.isArray(request.inputs) || request.inputs.length === 0) return request
        const inputs = await Promise.all(
          request.inputs.map((identity) =>
            parseUploadVersionReference(identity) || parseArtifactVersionLocator(identity)
              ? identity
              : canonicalizeBareIdentity(identity)
          )
        )
        return { ...request, inputs }
      })
    )
    return Array.isArray(requestOrRequests) ? canonicalized : canonicalized[0]
  }

  async issueSessionConnection(
    sessionId: string,
    projectId: string,
    agentFrameId: string,
    memoryTools = true
  ): Promise<NotebookRpcConnection> {
    if (!agentFrameId.trim()) {
      throw new Error('Notebook RPC capabilities require an explicit Agent Frame owner.')
    }
    const connection = await this.ensureStarted()
    // A context reset issues the replacement under the final ACP id, while the original token can be
    // keyed by its pre-start notebook-session-* alias. Rotate the complete Agent-facing alias closure;
    // dedicated control-plane capabilities stay valid for the live Notebook runtime.
    this.revokeAgentSessionCapabilities(sessionId)

    const token = randomUUID()
    const resolvedSessionId = this.sessionAliases.get(sessionId) ?? sessionId
    const resolvedAgentFrameId =
      resolvedSessionId !== sessionId && agentFrameId === `root-frame-${sessionId}`
        ? `root-frame-${resolvedSessionId}`
        : agentFrameId
    this.sessionRpcTokens.set(sessionId, token)
    this.sessionRpcCapabilities.set(token, {
      sessionId: resolvedSessionId,
      projectId,
      agentFrameId: resolvedAgentFrameId,
      memoryTools,
      delegatedWorkRole: 'main'
    })
    return {
      endpoint: connection.endpoint,
      socketPath: connection.socketPath,
      token,
      release: () => {
        // A stale startup may release after a same-ID successor has rotated the current token. Revoke
        // only this concrete capability and clear the owner projection only while it still points here.
        if (this.sessionRpcTokens.get(sessionId) === token) {
          this.sessionRpcTokens.delete(sessionId)
        }
        this.sessionRpcCapabilities.delete(token)
      }
    }
  }

  // Provisions one fail-closed child capability. The caller supplies the durable Attempt check;
  // revocation closes admission before tearing down only this Frame's lane and draining its request.
  async issueDelegatedNotebookConnection(
    scope: DelegatedNotebookConnectionRequest
  ): Promise<DelegatedNotebookConnection> {
    const required = [
      scope.projectId,
      scope.sessionId,
      scope.rootFrameId,
      scope.agentFrameId,
      scope.attemptId,
      scope.messageBranchId,
      scope.runtimeSegmentId,
      scope.promptMessageId,
      scope.workspaceCwd
    ]
    if (required.some((value) => !value.trim()) || scope.agentFrameId === scope.rootFrameId) {
      throw new Error('Delegated Notebook capability scope is incomplete or not a child Frame.')
    }
    const connection = await this.ensureStarted()
    const token = randomUUID()
    const delegatedNotebook: NonNullable<NotebookRpcSessionBinding['delegatedNotebook']> = {
      attemptId: scope.attemptId,
      workspaceCwd: scope.workspaceCwd,
      provenanceContext: {
        rootFrameId: scope.rootFrameId,
        agentFrameId: scope.agentFrameId,
        messageBranchId: scope.messageBranchId,
        runtimeSegmentId: scope.runtimeSegmentId,
        promptMessageId: scope.promptMessageId
      },
      isAttemptWritable: scope.isAttemptWritable,
      revoked: false,
      inFlightRequests: 0,
      drainWaiters: new Set()
    }
    this.sessionRpcCapabilities.set(token, {
      sessionId: scope.sessionId,
      projectId: scope.projectId,
      agentFrameId: scope.agentFrameId,
      allowedMethods: new Set([
        ...NOTEBOOK_LOCAL_RPC_METHODS,
        'capabilitiesCall',
        'hostSdkHelp',
        'delegatedWorkCall',
        'delegatedOutputCall',
        'requestUserInput'
      ]),
      delegatedWorkRole: 'delegate',
      delegatedWorkAttemptId: scope.attemptId,
      delegatedNotebook
    })
    let revokePromise: Promise<void> | undefined
    const revoke = (): Promise<void> => {
      if (revokePromise) return revokePromise
      delegatedNotebook.revoked = true
      this.sessionRpcCapabilities.delete(token)
      const drained =
        delegatedNotebook.inFlightRequests === 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => delegatedNotebook.drainWaiters.add(resolve))
      const shutdown = this.service.shutdown({
        projectId: scope.projectId,
        sessionId: scope.sessionId,
        workspaceCwd: scope.workspaceCwd,
        provenanceContext: delegatedNotebook.provenanceContext,
        delegatedWorkAttemptId: scope.attemptId
      } as Parameters<NotebookLocalRpcCapability['shutdown']>[0] & {
        delegatedWorkAttemptId: string
      })
      revokePromise = Promise.all([drained, shutdown]).then(() => undefined)
      return revokePromise
    }
    return {
      endpoint: connection.endpoint,
      socketPath: connection.socketPath,
      token,
      release: () => void revoke().catch(() => undefined),
      revoke
    }
  }

  async issueSkillImportConnection(sessionId: string): Promise<NotebookRpcConnection> {
    const connection = await this.ensureStarted()
    this.revokeSkillImportSessionCapabilities(sessionId)

    const token = randomUUID()
    this.skillImportRpcTokens.set(sessionId, token)
    this.sessionRpcCapabilities.set(token, {
      sessionId,
      allowedMethods: SKILL_IMPORT_RPC_METHODS
    })
    return {
      endpoint: connection.endpoint,
      socketPath: connection.socketPath,
      token,
      release: () => {
        if (this.skillImportRpcTokens.get(sessionId) === token) {
          this.skillImportRpcTokens.delete(sessionId)
        }
        this.sessionRpcCapabilities.delete(token)
      }
    }
  }

  async issuePlanConnection(sessionId: string, projectId: string): Promise<NotebookRpcConnection> {
    const connection = await this.ensureStarted()
    this.revokePlanSessionCapabilities(sessionId)

    const token = randomUUID()
    this.planRpcTokens.set(sessionId, token)
    this.sessionRpcCapabilities.set(token, {
      sessionId,
      projectId,
      allowedMethods: PLAN_RPC_METHODS
    })
    return {
      endpoint: connection.endpoint,
      socketPath: connection.socketPath,
      token,
      release: () => {
        if (this.planRpcTokens.get(sessionId) === token) this.planRpcTokens.delete(sessionId)
        this.sessionRpcCapabilities.delete(token)
      }
    }
  }

  // Issues a dedicated capability for the persistent control-plane REPL. Unlike the Agent-facing
  // session connection, this does not rotate `sessionRpcTokens`: both callers remain valid, and the
  // narrower capability cannot invoke Notebook lifecycle or execution RPC methods.
  async issueControlConnection(
    sessionId: string,
    projectId: string,
    agentFrameId: string,
    delegatedWorkIdentity: Readonly<{
      role: 'main' | 'delegate'
      attemptId?: string
    }> = { role: 'main' },
    executionCwd?: string
  ): Promise<
    NotebookRpcConnection & {
      beginControlInvocation(context: TrustedControlInvocationIdentity): () => void
      completeControlInvocation(controlInvocationId: string): Promise<readonly TransientViewImage[]>
      discardControlInvocation(controlInvocationId: string): void
      release: () => void
    }
  > {
    if (!agentFrameId.trim()) {
      throw new Error('Notebook control capabilities require an explicit Agent Frame owner.')
    }
    const connection = await this.ensureStarted()
    const token = randomUUID()
    const resolvedSessionId = this.sessionAliases.get(sessionId) ?? sessionId
    const resolvedAgentFrameId =
      resolvedSessionId !== sessionId && agentFrameId === `root-frame-${sessionId}`
        ? `root-frame-${resolvedSessionId}`
        : agentFrameId
    const binding: NotebookRpcSessionBinding = {
      sessionId: resolvedSessionId,
      projectId,
      agentFrameId: resolvedAgentFrameId,
      memoryTools: delegatedWorkIdentity.role === 'main',
      delegatedWorkRole: delegatedWorkIdentity.role,
      ...(delegatedWorkIdentity.attemptId
        ? { delegatedWorkAttemptId: delegatedWorkIdentity.attemptId }
        : {}),
      allowedMethods:
        delegatedWorkIdentity.role === 'delegate'
          ? DELEGATED_CONTROL_RPC_METHODS
          : CONTROL_RPC_METHODS,
      isControl: true,
      ...(executionCwd ? { executionCwd } : {})
    }
    this.sessionRpcCapabilities.set(token, binding)
    const ownedControlInvocationIds = new Set<string>()

    return {
      endpoint: connection.endpoint,
      socketPath: connection.socketPath,
      token,
      beginControlInvocation: (context) => {
        binding.activeControlInvocation = context
        ownedControlInvocationIds.add(context.toolInvocationId)
        return () => {
          if (binding.activeControlInvocation === context) {
            delete binding.activeControlInvocation
          }
        }
      },
      completeControlInvocation: async (controlInvocationId) => {
        if (!ownedControlInvocationIds.has(controlInvocationId)) return []
        const images = this.hostViewImage
          ? await this.hostViewImage.complete(controlInvocationId)
          : []
        ownedControlInvocationIds.delete(controlInvocationId)
        return images
      },
      discardControlInvocation: (controlInvocationId) => {
        if (!ownedControlInvocationIds.has(controlInvocationId)) return
        this.hostViewImage?.discard(controlInvocationId)
        ownedControlInvocationIds.delete(controlInvocationId)
      },
      release: () => {
        for (const controlInvocationId of ownedControlInvocationIds) {
          this.hostViewImage?.discard(controlInvocationId)
        }
        ownedControlInvocationIds.clear()
        this.sessionRpcCapabilities.delete(token)
      }
    }
  }

  registerSessionSpecialist(sessionId: string, specialistId: string | undefined): void {
    if (specialistId) this.sessionSpecialists.set(sessionId, specialistId)
    else this.sessionSpecialists.delete(sessionId)
  }

  // Pins Notebook executions to one app-owned active Artifact turn. Project authority is installed
  // with provenance at turn activation, independently of whether the prompt carried attachments.
  setArtifactTurnBinding(sessionId: string, binding: ActiveArtifactTurnBinding): void {
    const previous = this.activeArtifactTurnBindings.get(sessionId)
    if (
      previous &&
      (previous.ownerExecutionId !== binding.ownerExecutionId ||
        previous.provenanceContext.promptMessageId !== binding.provenanceContext.promptMessageId)
    ) {
      this.executionAuthorizations.delete(sessionId)
      this.consumedExecutionToolCalls.delete(sessionId)
    }
    this.activeArtifactTurnBindings.set(sessionId, binding)
    const context = binding.provenanceContext
    if (context.agentFrameId === context.rootFrameId) {
      for (const capability of this.sessionRpcCapabilities.values()) {
        if (
          (!capability.allowedMethods || capability.allowedMethods === CONTROL_RPC_METHODS) &&
          !capability.delegatedNotebook &&
          capability.delegatedWorkRole !== 'delegate' &&
          (this.sessionAliases.get(capability.sessionId) ?? capability.sessionId) === sessionId &&
          capability.agentFrameId === `root-frame-${capability.sessionId}`
        ) {
          capability.sessionId = sessionId
          capability.agentFrameId = context.agentFrameId
        }
      }
    }
  }

  clearArtifactTurnBinding(sessionId: string, ownerExecutionId: string): void {
    if (this.activeArtifactTurnBindings.get(sessionId)?.ownerExecutionId !== ownerExecutionId)
      return
    this.activeArtifactTurnBindings.delete(sessionId)
    this.executionAuthorizations.delete(sessionId)
    this.consumedExecutionToolCalls.delete(sessionId)
  }

  async registerNotebookTurnInputs(
    request: RegisterNotebookTurnInputsRequest
  ): ReturnType<NotebookInputRegistry['registerTurn']> {
    if (!this.inputRegistry) return []
    return this.inputRegistry.registerTurn(request)
  }

  private acquireArtifactRpcRequest(
    method: ArtifactRpcMethod,
    token: string,
    params: Record<string, unknown>
  ): { params: Record<string, unknown>; release: () => void } {
    const capability = this.artifactRpcCapabilities.get(token)
    if (!capability) throw new RpcHttpError(401, 'Invalid Artifact RPC capability.')
    if (capability.expiresAt <= this.now()) {
      // Expiry closes admission just like an explicit runtime revoke. Keep the shared drain promise
      // reachable so a later turn teardown still waits for requests that acquired before expiry.
      void this.revokeArtifactRunCapability(token)
      throw new RpcHttpError(401, 'Artifact RPC capability expired.')
    }
    if (!capability.allowedMethods.has(method)) {
      throw new RpcHttpError(403, `Artifact RPC capability does not allow ${method}.`)
    }

    const boundFields =
      method === 'artifactCreateVersion'
        ? [
            'projectId',
            'appSessionId',
            'artifactStorageSessionId',
            'artifactRunId',
            'rootFrameId',
            'agentFrameId',
            'messageBranchId',
            'runtimeSegmentId',
            'promptMessageId'
          ]
        : ['projectId', 'appSessionId', 'artifactStorageSessionId', 'artifactRunId']
    for (const field of boundFields) {
      const expected = capability[field as keyof ArtifactRpcCapabilityBinding]
      if (params[field] !== expected) {
        throw new RpcHttpError(403, `Artifact RPC capability does not match ${field}.`)
      }
    }

    const sanitizedParams = { ...params }
    delete sanitizedParams.messageBranchAncestry
    delete sanitizedParams.messageAncestry
    delete sanitizedParams.agentName
    delete sanitizedParams.notebookSessionId

    const trustedParams = {
      ...sanitizedParams,
      projectId: capability.projectId,
      appSessionId: capability.appSessionId,
      artifactStorageSessionId: capability.artifactStorageSessionId,
      artifactRunId: capability.artifactRunId,
      ...(method === 'artifactCreateVersion'
        ? {
            rootFrameId: capability.rootFrameId,
            agentFrameId: capability.agentFrameId,
            messageBranchId: capability.messageBranchId,
            messageBranchAncestry: capability.messageBranchAncestry
              ? [...capability.messageBranchAncestry]
              : undefined,
            messageAncestry: capability.messageAncestry
              ? [...capability.messageAncestry]
              : undefined,
            runtimeSegmentId: capability.runtimeSegmentId,
            promptMessageId: capability.promptMessageId,
            agentName: capability.agentName,
            notebookSessionId: capability.notebookSessionId
          }
        : {})
    }
    capability.inFlightRequests += 1
    let released = false
    return {
      params: trustedParams,
      release: () => {
        if (released) return
        released = true
        capability.inFlightRequests -= 1
        if (capability.inFlightRequests === 0) {
          for (const resolve of capability.drainWaiters) resolve()
          capability.drainWaiters.clear()
        }
      }
    }
  }

  private async projectHostCapabilityState(
    sessionBinding: NotebookRpcSessionBinding
  ): Promise<Readonly<{ capabilities: HostCapabilityProjection; delegationAllowed: boolean }>> {
    const allowsMethod = (method: string): boolean =>
      !sessionBinding.allowedMethods || sessionBinding.allowedMethods.has(method)
    const callerRole = sessionBinding.delegatedWorkRole ?? 'main'
    const hasDelegatedIdentity = Boolean(
      sessionBinding.projectId &&
      sessionBinding.agentFrameId &&
      (callerRole !== 'delegate' || sessionBinding.delegatedWorkAttemptId)
    )
    const hasDelegatedOrigin = sessionBinding.delegatedNotebook
      ? Boolean(sessionBinding.delegatedNotebook.provenanceContext.promptMessageId)
      : Boolean(sessionBinding.activeControlInvocation?.originatingUserMessageId)
    const delegatedWorkReady =
      hasDelegatedIdentity &&
      hasDelegatedOrigin &&
      (sessionBinding.delegatedNotebook
        ? !sessionBinding.delegatedNotebook.revoked &&
          (await sessionBinding.delegatedNotebook.isAttemptWritable())
        : Boolean(sessionBinding.isControl && sessionBinding.activeControlInvocation))
    let delegationAllowed = true
    if (
      callerRole === 'main' &&
      sessionBinding.projectId &&
      this.delegatedWorkService?.isDelegationAllowed
    ) {
      delegationAllowed = await this.delegatedWorkService.isDelegationAllowed({
        projectId: sessionBinding.projectId,
        sessionId: sessionBinding.sessionId
      })
    }

    return {
      delegationAllowed,
      capabilities: projectHostCapabilities({
        callerRole,
        isControl: Boolean(sessionBinding.isControl),
        hasActiveControlInvocation: Boolean(sessionBinding.activeControlInvocation),
        hasWorkspace: Boolean(sessionBinding.executionCwd),
        allowsMethod,
        delegatedWorkReady,
        delegationAllowed,
        services: {
          mcp: Boolean(this.connectorService),
          compute: Boolean(this.computeService),
          agents: Boolean(this.agentsService),
          skills:
            Boolean(this.skillsService) &&
            (this.isHostSkillsAvailable?.(sessionBinding.sessionId) ?? true),
          artifacts: Boolean(this.hostArtifacts),
          lineage: Boolean(this.hostLineage),
          frames: Boolean(this.hostFrames),
          sessions: Boolean(this.hostSessions),
          llm: Boolean(this.hostModel) && (await this.hostModel!.isLlmAvailable()),
          currentModel:
            Boolean(this.hostModel) &&
            (await this.hostModel!.isCurrentModelAvailable(sessionBinding.sessionId)),
          listModels: Boolean(this.hostModel) && (await this.hostModel!.isListModelsAvailable()),
          viewImage:
            Boolean(this.hostViewImage) &&
            (await this.hostViewImage!.isAvailable({ sessionId: sessionBinding.sessionId })),
          delegate: Boolean(this.delegatedWorkService?.delegate),
          children: Boolean(this.delegatedWorkService?.children),
          collect: Boolean(this.delegatedWorkService?.collect),
          stopChild: Boolean(this.delegatedWorkService?.stopChildren),
          sendFrameMessage: Boolean(this.delegatedWorkService?.sendMessage),
          messageReceipt: Boolean(this.delegatedWorkService?.messageReceipt),
          resolveMessage: Boolean(this.delegatedWorkService?.resolveMessage),
          submitOutput: Boolean(this.delegatedWorkService?.submitOutput)
        }
      })
    }
  }

  // Authenticates one HTTP request, dispatches it, and serializes either result or error.
  private async handleRequest(
    lifecycle: NotebookRpcServerLifecycle,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const disconnect = new AbortController()
    const activeRequest: NotebookRpcRequestLifecycle = {
      request,
      response,
      disconnect,
      bodyComplete: false
    }
    lifecycle.activeRequests.add(activeRequest)
    const abortDisconnectedRequest = (): void => disconnect.abort()
    const abortDisconnectedResponse = (): void => {
      if (!response.writableFinished) disconnect.abort()
    }
    const closeIdleResponseDuringShutdown = (): void => {
      if (lifecycle.closing) lifecycle.server.closeIdleConnections()
    }
    request.once('aborted', abortDisconnectedRequest)
    response.once('close', abortDisconnectedResponse)
    response.once('finish', closeIdleResponseDuringShutdown)
    let releaseArtifactRequest: (() => void) | undefined
    let releaseDelegatedNotebookRequest: (() => void) | undefined
    let authenticatedSessionBinding: NotebookRpcSessionBinding | undefined
    try {
      if (lifecycle.closing) {
        disconnect.abort()
        request.destroy()
        response.destroy()
        return
      }
      if (request.method !== 'POST') {
        writeJson(response, 405, { error: 'Notebook RPC only accepts POST requests.' })
        return
      }
      const authorization = request.headers.authorization
      const bearerToken = authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : ''
      const artifactCapability = this.artifactRpcCapabilities.get(bearerToken)
      if (artifactCapability && artifactCapability.expiresAt <= this.now()) {
        void this.revokeArtifactRunCapability(bearerToken)
        closeRequestAfterResponse(request, response)
        writeJson(response, 401, { error: 'Artifact RPC capability expired.' })
        return
      }
      const hasKnownToken =
        authorization === `Bearer ${this.token}` ||
        this.sessionRpcCapabilities.has(bearerToken) ||
        Boolean(artifactCapability)
      if (!hasKnownToken) {
        closeRequestAfterResponse(request, response)
        writeJson(response, 401, { error: 'Invalid notebook RPC token.' })
        return
      }
      let payload: unknown
      try {
        payload = await readBoundedJsonBody(request, this.requestBytes)
      } catch (error) {
        if (error instanceof SyntaxError) throw new RpcHttpError(400, error.message)
        throw error
      }
      activeRequest.bodyComplete = true
      if (!isRecord(payload) || typeof payload.method !== 'string' || !payload.method.trim()) {
        throw new RpcHttpError(400, 'Notebook RPC payload must include a non-empty method string.')
      }
      const method = payload.method
      activeRequest.method = method
      if (!RPC_METHODS.has(method)) {
        throw new RpcHttpError(404, `Unknown notebook RPC method: ${method}`)
      }
      if (payload.params !== undefined && !isRecord(payload.params)) {
        throw new RpcHttpError(400, 'Notebook RPC params must be an object.')
      }
      let params = isRecord(payload.params) ? payload.params : {}
      if (method === 'hostSdkHelp') delete params.view_image_available
      let hostCapabilities: HostCapabilityProjection | undefined
      let delegationAllowed: boolean | undefined
      if (isArtifactRpcMethod(method)) {
        const acquired = this.acquireArtifactRpcRequest(method, bearerToken, params)
        params = acquired.params
        releaseArtifactRequest = acquired.release
      } else {
        const sessionBinding = this.sessionRpcCapabilities.get(bearerToken)
        if (sessionBinding) {
          authenticatedSessionBinding = sessionBinding
          if (sessionBinding.allowedMethods && !sessionBinding.allowedMethods.has(method)) {
            throw new RpcHttpError(403, `Notebook RPC capability does not allow ${method}.`)
          }
          if (MEMORY_RPC_METHODS.has(method)) {
            let memoryEnabled = sessionBinding.memoryTools === true
            if (this.isMemoryEnabledForSession) {
              memoryEnabled = false
              try {
                memoryEnabled = await this.isMemoryEnabledForSession(sessionBinding.sessionId)
              } catch (error) {
                log.warn('Memory Session gate read failed', errorLogFields(error))
              }
            }
            if (!memoryEnabled) {
              throw new RpcHttpError(403, 'Memory is disabled for this Session.')
            }
          }
          if (
            (method === 'artifactsCall' || method === 'lineageCall') &&
            !sessionBinding.isControl
          ) {
            throw new RpcHttpError(
              403,
              method === 'lineageCall'
                ? 'host.lineage requires a control-plane REPL capability.'
                : 'host.artifacts requires a control-plane REPL capability.'
            )
          }
          if (method === 'lineageCall') {
            const allowedKeys =
              params.op === 'graph'
                ? new Set(['op', 'version_id', 'options'])
                : new Set(['op', 'version_id'])
            if (Object.keys(params).some((key) => !allowedKeys.has(key))) {
              throw new RpcHttpError(400, 'host.lineage RPC params are invalid.')
            }
          }
          if (method === 'framesCall' && !sessionBinding.isControl) {
            throw new RpcHttpError(403, 'host.frames requires a control-plane REPL capability.')
          }
          if (
            method === 'sessionsCall' &&
            (!sessionBinding.isControl || sessionBinding.delegatedWorkRole === 'delegate')
          ) {
            throw new RpcHttpError(
              403,
              'host.sessions requires a Main control-plane REPL capability.'
            )
          }
          if (
            (method === 'llmCall' ||
              method === 'currentModelCall' ||
              method === 'listModelsCall') &&
            !sessionBinding.isControl
          ) {
            const hostMethod =
              method === 'currentModelCall'
                ? 'host.currentModel'
                : method === 'listModelsCall'
                  ? 'host.listModels'
                  : 'host.llm'
            throw new RpcHttpError(403, `${hostMethod} requires a control-plane REPL capability.`)
          }
          if (
            (method === 'currentModelCall' || method === 'listModelsCall') &&
            Object.keys(params).length > 0
          ) {
            throw new RpcHttpError(
              400,
              `${method === 'currentModelCall' ? 'host.currentModel' : 'host.listModels'} RPC params must be empty.`
            )
          }
          if (method === 'viewImageCall') {
            if (!sessionBinding.isControl || !sessionBinding.activeControlInvocation) {
              throw new RpcHttpError(
                403,
                'host.viewImage requires an active trusted control invocation.'
              )
            }
            if (!sessionBinding.executionCwd) {
              throw new RpcHttpError(403, 'host.viewImage requires a trusted execution workspace.')
            }
            if (Object.keys(params).some((key) => key !== 'source' && key !== 'options')) {
              throw new RpcHttpError(400, 'host.viewImage RPC params are invalid.')
            }
          }
          if (
            method === 'agentsCall' &&
            params.op === 'switch' &&
            !sessionBinding.activeControlInvocation
          ) {
            throw new RpcHttpError(
              403,
              'host.agents.switch requires an active trusted control invocation.'
            )
          }
          if (method === 'capabilitiesCall' || method === 'hostSdkHelp') {
            const state = await this.projectHostCapabilityState(sessionBinding)
            hostCapabilities = state.capabilities
            delegationAllowed = state.delegationAllowed
          }
          if (
            method === 'skillsCall' &&
            !(this.isHostSkillsAvailable?.(sessionBinding.sessionId) ?? true)
          ) {
            throw new RpcHttpError(403, 'host.skills is unavailable for this Agent framework.')
          }
          if (
            method === 'delegatedWorkCall' &&
            !sessionBinding.delegatedNotebook &&
            (!sessionBinding.projectId ||
              !sessionBinding.agentFrameId ||
              !sessionBinding.activeControlInvocation?.toolInvocationId ||
              !sessionBinding.activeControlInvocation.originatingUserMessageId)
          ) {
            throw new RpcHttpError(
              403,
              'host.delegate requires an active trusted control invocation.'
            )
          }
          const delegatedNotebook = sessionBinding.delegatedNotebook
          if (
            delegatedNotebook &&
            (isNotebookLocalRpcMethod(method) ||
              method === 'hostSdkHelp' ||
              method === 'delegatedWorkCall' ||
              method === 'delegatedOutputCall')
          ) {
            if (delegatedNotebook.revoked || !(await delegatedNotebook.isAttemptWritable())) {
              throw new RpcHttpError(
                403,
                `Notebook capability for Attempt ${delegatedNotebook.attemptId} is no longer writable.`
              )
            }
            delegatedNotebook.inFlightRequests += 1
            let released = false
            releaseDelegatedNotebookRequest = () => {
              if (released) return
              released = true
              delegatedNotebook.inFlightRequests -= 1
              if (delegatedNotebook.inFlightRequests === 0) {
                for (const resolve of delegatedNotebook.drainWaiters) resolve()
                delegatedNotebook.drainWaiters.clear()
              }
            }
          }
          // The request body is agent-controlled. Owner fields always come from the unforgeable,
          // per-session capability issued while building this session's Notebook environment.
          const delegatedQuestionInvocationId =
            method === 'requestUserInput' && sessionBinding.delegatedNotebook
              ? `delegated-question:${createHash('sha256')
                  .update(sessionBinding.delegatedNotebook.attemptId)
                  .update('\0')
                  .update(
                    typeof params._appToolRequestId === 'string'
                      ? params._appToolRequestId
                      : JSON.stringify(params.questions)
                  )
                  .digest('hex')}`
              : undefined
          params = {
            ...params,
            sessionId: sessionBinding.sessionId,
            ...(sessionBinding.projectId ? { projectId: sessionBinding.projectId } : {}),
            ...(method === 'viewImageCall'
              ? {
                  executionCwd: sessionBinding.executionCwd,
                  controlInvocationId: sessionBinding.activeControlInvocation?.toolInvocationId
                }
              : {}),
            ...(method === 'computeCall'
              ? {
                  // Bound by beginControlInvocation; an agent-controlled body value is overwritten.
                  producerRunId: sessionBinding.activeControlInvocation?.toolInvocationId
                }
              : {}),
            ...(method === 'agentsCall' || method === 'skillsCall'
              ? {
                  session_id: sessionBinding.sessionId,
                  caller_role:
                    sessionBinding.delegatedWorkRole === 'delegate' ? 'delegate' : 'main',
                  turn_id: sessionBinding.activeControlInvocation?.turnId,
                  control_invocation_generation:
                    sessionBinding.activeControlInvocation?.controlInvocationGeneration,
                  control_invocation_id: sessionBinding.activeControlInvocation?.toolInvocationId
                }
              : {}),
            ...(method === 'delegatedWorkCall' || method === 'requestUserInput'
              ? {
                  project_id: sessionBinding.projectId,
                  session_id: sessionBinding.sessionId,
                  frame_id: sessionBinding.agentFrameId,
                  caller_role: sessionBinding.delegatedWorkRole,
                  attempt_id: sessionBinding.delegatedWorkAttemptId,
                  origin_message_id:
                    sessionBinding.delegatedNotebook?.provenanceContext.promptMessageId ??
                    sessionBinding.activeControlInvocation?.originatingUserMessageId,
                  tool_invocation_id:
                    delegatedQuestionInvocationId ??
                    (sessionBinding.delegatedNotebook
                      ? `delegated-notebook-capability:${randomUUID()}`
                      : sessionBinding.activeControlInvocation?.toolInvocationId)
                }
              : method === 'delegatedOutputCall'
                ? {
                    project_id: sessionBinding.projectId,
                    session_id: sessionBinding.sessionId,
                    frame_id: sessionBinding.agentFrameId,
                    attempt_id: sessionBinding.delegatedWorkAttemptId,
                    origin_message_id:
                      sessionBinding.delegatedNotebook?.provenanceContext.promptMessageId ??
                      sessionBinding.activeControlInvocation?.originatingUserMessageId
                  }
                : method === 'hostSdkHelp'
                  ? {
                      caller_role: sessionBinding.delegatedWorkRole,
                      _hostCapabilityProjection: hostCapabilities,
                      _delegationAllowed: delegationAllowed
                    }
                  : {}),
            ...(MEMORY_RPC_METHODS.has(method)
              ? {
                  sessionId: sessionBinding.sessionId,
                  projectId: sessionBinding.projectId,
                  agentId: this.sessionSpecialists.get(sessionBinding.sessionId),
                  turnId:
                    sessionBinding.activeControlInvocation?.turnId ??
                    this.activeArtifactTurnBindings.get(sessionBinding.sessionId)?.provenanceContext
                      .promptMessageId
                }
              : {})
          }
        } else {
          if (authorization !== `Bearer ${this.token}`) {
            throw new RpcHttpError(401, 'Invalid notebook RPC token.')
          }
          if (
            CONTROL_RPC_METHODS.has(method) ||
            SKILL_IMPORT_RPC_METHODS.has(method) ||
            PLAN_RPC_METHODS.has(method) ||
            method === 'delegatedOutputCall'
          ) {
            throw new RpcHttpError(401, 'A session-bound notebook RPC token is required.')
          }
        }
      }
      // Resolve pre-session aliases before the runtime service looks up persistent state.
      if (method === 'planCall' && lifecycle.closing) disconnect.abort()
      let resolvedParams = { ...this.resolveSessionAlias(params) }
      delete resolvedParams.executionInvocationId
      delete resolvedParams.registeredHelperSkillIds
      const authenticatedBinding = authenticatedSessionBinding
      if (authenticatedBinding?.delegatedNotebook && isNotebookLocalRpcMethod(method)) {
        resolvedParams = {
          ...resolvedParams,
          sessionId: authenticatedBinding.sessionId,
          projectId: authenticatedBinding.projectId,
          workspaceCwd: authenticatedBinding.delegatedNotebook.workspaceCwd,
          provenanceContext: authenticatedBinding.delegatedNotebook.provenanceContext,
          delegatedWorkAttemptId: authenticatedBinding.delegatedNotebook.attemptId
        }
      }
      if (authenticatedBinding?.agentFrameId && isNotebookLocalRpcMethod(method)) {
        const resolvedSessionId = resolvedParams.sessionId
        const activeContext =
          typeof resolvedSessionId === 'string'
            ? this.activeArtifactTurnBindings.get(resolvedSessionId)?.provenanceContext
            : undefined
        const hasProvenRootOwner =
          typeof resolvedSessionId === 'string' &&
          (this.sessionAliases.get(authenticatedBinding.sessionId) ??
            authenticatedBinding.sessionId) === resolvedSessionId &&
          authenticatedBinding.agentFrameId === `root-frame-${authenticatedBinding.sessionId}`
        if (
          !authenticatedBinding.delegatedNotebook &&
          (!authenticatedBinding.allowedMethods ||
            authenticatedBinding.allowedMethods === CONTROL_RPC_METHODS) &&
          authenticatedBinding.delegatedWorkRole !== 'delegate' &&
          hasProvenRootOwner &&
          typeof resolvedSessionId === 'string' &&
          activeContext &&
          activeContext.agentFrameId === activeContext.rootFrameId
        ) {
          authenticatedBinding.sessionId = resolvedSessionId
          authenticatedBinding.agentFrameId = activeContext.agentFrameId
        }
        if (
          !authenticatedBinding.delegatedNotebook &&
          activeContext &&
          activeContext.agentFrameId !== authenticatedBinding.agentFrameId
        ) {
          throw new RpcHttpError(403, 'Notebook RPC capability does not match active Agent Frame.')
        }
      }
      if (
        authenticatedBinding &&
        !authenticatedBinding.delegatedNotebook &&
        !authenticatedBinding.isControl &&
        authenticatedBinding.delegatedWorkRole === 'main' &&
        !authenticatedBinding.allowedMethods &&
        typeof resolvedParams.sessionId === 'string' &&
        (method === 'execute' || method === 'executeControl' || method === 'executeShell')
      ) {
        const executionInvocationId = this.claimExecutionAuthorization(
          resolvedParams.sessionId,
          method,
          resolvedParams
        )
        if (executionInvocationId) {
          resolvedParams = { ...resolvedParams, executionInvocationId }
        }
      }
      const result =
        method === 'capabilitiesCall'
          ? hostCapabilities
          : isNotebookLocalRpcMethod(method) && method !== 'requestNetworkAccess'
            ? await withDataRootWrite(() =>
                this.dispatch(method, resolvedParams, disconnect.signal)
              )
            : await this.dispatch(method, resolvedParams, disconnect.signal)

      writeJson(response, 200, { result })
    } catch (error) {
      // A captured control completion belongs to the approved handoff, not to this legacy RPC
      // caller. Do not serialize it as a tool error (or any result): cancellation of the old prompt
      // closes this request, at which point the transport ownership has been released.
      if (error instanceof NotebookControlCompletionCapturedError) {
        response.destroy()
        return
      }
      if (response.destroyed) return
      const message = error instanceof Error ? error.message : String(error)
      const serializedError =
        error instanceof PlanCommandError
          ? { code: error.code, message }
          : error instanceof StructuredOutputError
            ? {
                code: error.code,
                ...(error.keyword ? { keyword: error.keyword } : {}),
                ...(error.instancePath !== undefined ? { instance_path: error.instancePath } : {}),
                ...(error.property ? { property: error.property } : {})
              }
            : message

      if (error instanceof ResourceBudgetExceededError) {
        closeRequestAfterResponse(request, response)
      }

      writeJson(
        response,
        error instanceof RpcHttpError
          ? error.statusCode
          : error instanceof ResourceBudgetExceededError
            ? 413
            : 500,
        { error: serializedError }
      )
    } finally {
      request.off('aborted', abortDisconnectedRequest)
      response.off('close', abortDisconnectedResponse)
      lifecycle.activeRequests.delete(activeRequest)
      releaseArtifactRequest?.()
      releaseDelegatedNotebookRequest?.()
    }
  }

  // Maps the narrow RPC method names to strongly-typed runtime service calls.
  private async dispatch(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<unknown> {
    if (MEMORY_RPC_METHODS.has(method)) {
      if (!this.memoryService) throw new Error('Memory service is not configured.')
      if (typeof params.sessionId !== 'string') {
        throw new RpcHttpError(403, 'Memory RPC requires a trusted session binding.')
      }
      if (typeof params.projectId !== 'string') {
        throw new RpcHttpError(403, 'Memory RPC requires a trusted project binding.')
      }
      const context: MemoryAgentContext = {
        projectId: params.projectId,
        sessionId: params.sessionId,
        ...(typeof params.agentId === 'string' ? { agentId: params.agentId } : {}),
        ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {})
      }
      if (method === 'memoryListCategories') {
        return this.memoryService.listCategoriesForAgent(context)
      }
      if (method === 'memorySearch') {
        return this.memoryService.searchForAgent(
          parseRpcParams(() =>
            memoryAgentSearchRequestSchema.parse({
              query: params.query,
              categoryIds: params.categoryIds,
              limit: params.limit
            })
          ),
          context
        )
      }
      return this.memoryService.rememberForAgent(
        parseRpcParams(() =>
          memoryAgentRememberRequestSchema.parse({
            categoryId: params.categoryId,
            content: params.content,
            analysis: params.analysis
          })
        ),
        context
      )
    }

    // Artifact stdio/HTTP MCP handlers cannot own SQLite connections. Route the trusted run-bound
    // save envelope back into the main process, where the Provenance repository owns transactions,
    // immutable Version publication, and idempotency.
    if (method === 'artifactCreateVersion') {
      if (!this.artifactProvenance) {
        throw new Error('Artifact Provenance persistence is not configured.')
      }
      const request = params as CreateArtifactVersionRequest
      if (!request.resourceReservationId) {
        throw new RpcHttpError(400, 'Artifact Version creation requires a write reservation.')
      }
      return this.artifactProvenance.createVersion(request, signal)
    }
    if (method === 'artifactReserveWrite') {
      if (!this.artifactProvenance?.reserveWrite) {
        throw new Error('Artifact write reservation is not configured.')
      }
      return this.artifactProvenance.reserveWrite(params as ReserveArtifactWriteRequest)
    }
    if (method === 'artifactReleaseWrite') {
      if (!this.artifactProvenance?.releaseWriteReservation) {
        throw new Error('Artifact write reservation is not configured.')
      }
      await this.artifactProvenance.releaseWriteReservation(
        params as ReleaseArtifactWriteReservationRequest
      )
      return { released: true }
    }
    if (method === 'artifactReplayVersion') {
      if (!this.artifactProvenance?.replayVersion) {
        throw new Error('Artifact Provenance persistence is not configured.')
      }

      return this.artifactProvenance.replayVersion(params as ReplayArtifactVersionRequest)
    }

    if (method === 'skillImport') {
      if (!this.skillImporter) throw new Error('Conversation Skill import is not configured.')
      if (
        typeof params.sessionId === 'string' &&
        typeof params.githubUrl === 'string' &&
        params.turnToken === undefined &&
        params.attachmentUri === undefined
      ) {
        const request: ConversationSkillImportRequest = {
          sessionId: params.sessionId,
          githubUrl: params.githubUrl
        }
        return this.skillImporter.request(request)
      }
      if (
        typeof params.sessionId !== 'string' ||
        params.githubUrl !== undefined ||
        typeof params.turnToken !== 'string' ||
        typeof params.attachmentUri !== 'string'
      ) {
        throw new RpcHttpError(
          400,
          'Skill import RPC params must include sessionId and exactly one supported source.'
        )
      }
      const request: ConversationSkillImportRequest = {
        sessionId: params.sessionId,
        turnToken: params.turnToken,
        attachmentUri: params.attachmentUri
      }
      return this.skillImporter.request(request)
    }

    if (method === 'planCall') {
      if (!this.planService) throw new Error('Session Plan service is not configured.')
      if (
        typeof params.projectId !== 'string' ||
        typeof params.sessionId !== 'string' ||
        !['generate', 'approve', 'reject', 'updateStepStatus'].includes(String(params.operation))
      ) {
        throw new RpcHttpError(400, 'Session Plan RPC params are invalid.')
      }
      return this.planService.call({
        projectId: params.projectId,
        sessionId: params.sessionId,
        operation: params.operation as 'generate' | 'approve' | 'reject' | 'updateStepStatus',
        input: params.input,
        signal
      })
    }

    if (method === 'requestUserInput') {
      const request = sanitizeAgentUserChoiceRequest(params)
      if (!request) throw new RpcHttpError(400, 'Invalid user choice request.')
      if (params.caller_role === 'delegate') {
        if (!this.delegatedWorkService?.requestUserInput) {
          throw new Error('Delegated user input is not configured.')
        }
        const projectId = typeof params.project_id === 'string' ? params.project_id : ''
        const sessionId = typeof params.session_id === 'string' ? params.session_id : ''
        const frameId = typeof params.frame_id === 'string' ? params.frame_id : ''
        const attemptId = typeof params.attempt_id === 'string' ? params.attempt_id : ''
        const originMessageId =
          typeof params.origin_message_id === 'string' ? params.origin_message_id : ''
        const toolInvocationId =
          typeof params.tool_invocation_id === 'string' ? params.tool_invocation_id : ''
        if (
          !projectId ||
          !sessionId ||
          !frameId ||
          !attemptId ||
          !originMessageId ||
          !toolInvocationId
        ) {
          throw new RpcHttpError(403, 'delegated user question capability identity is incomplete.')
        }
        return this.delegatedWorkService.requestUserInput(
          {
            session: { projectId, sessionId },
            frameId,
            attemptId,
            role: 'delegate',
            originMessageId,
            toolInvocationId
          },
          request,
          toolInvocationId
        )
      }
      if (!this.requestUserInput) throw new Error('User input is not configured.')
      return this.requestUserInput(request)
    }

    if (method === 'artifactsCall') {
      if (!this.hostArtifacts) throw new Error('Host Artifact reads are not configured.')
      const projectId = typeof params.projectId === 'string' ? params.projectId : ''
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
      if (!projectId || !sessionId) {
        throw new RpcHttpError(403, 'Host Artifact reads require a session-bound Project scope.')
      }
      const context = { projectId, sessionId }
      if (params.op === 'list') return this.hostArtifacts.list(params.options, context)
      if (params.op === 'path') {
        return this.hostArtifacts.resolvePath(params.version_id, context)
      }
      throw new RpcHttpError(400, 'Unknown host Artifact operation.')
    }

    if (method === 'lineageCall') {
      if (!this.hostLineage) throw new Error('Host Lineage reads are not configured.')
      const projectId = typeof params.projectId === 'string' ? params.projectId : ''
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
      if (!projectId || !sessionId) {
        throw new RpcHttpError(403, 'Host Lineage reads require a session-bound Project scope.')
      }
      const context = { projectId, sessionId }
      if (params.op === 'graph') {
        return this.hostLineage.graph(params.version_id, params.options, context)
      }
      if (params.op === 'get') return this.hostLineage.get(params.version_id, context)
      throw new RpcHttpError(400, 'Unknown host.lineage operation.')
    }

    if (method === 'framesCall') {
      if (!this.hostFrames) throw new Error('Host Frame reads are not configured.')
      const projectId = typeof params.projectId === 'string' ? params.projectId : ''
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
      if (!projectId || !sessionId) {
        throw new RpcHttpError(403, 'Host Frame reads require a session-bound Project scope.')
      }
      const context = { projectId, sessionId }
      if (params.op === 'list') return this.hostFrames.list(params.options, context)
      if (params.op === 'get') return this.hostFrames.get(params.frame_id, params.options, context)
      throw new RpcHttpError(400, 'Unknown host Frame operation.')
    }

    if (method === 'sessionsCall') {
      if (!this.hostSessions) throw new Error('Host Session diagnostics are not configured.')
      const projectId = typeof params.projectId === 'string' ? params.projectId : ''
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
      if (!projectId || !sessionId) {
        throw new RpcHttpError(
          403,
          'Host Session diagnostics require a session-bound Project scope.'
        )
      }
      const context = { projectId, sessionId, callerRole: 'main' as const }
      if (params.op === 'list') return this.hostSessions.list(params.options, context)
      if (params.op === 'inspect') return this.hostSessions.inspect(params.session_id, context)
      throw new RpcHttpError(400, 'Unknown host Session operation.')
    }

    if (method === 'llmCall') {
      if (!this.hostModel) throw new Error('host.llm is not configured.')
      const {
        sessionId,
        projectId,
        provenanceContext: _provenanceContext,
        registeredInputFiles: _registeredInputFiles,
        ...input
      } = params
      if (
        typeof sessionId !== 'string' ||
        !sessionId ||
        typeof projectId !== 'string' ||
        !projectId
      ) {
        throw new RpcHttpError(403, 'host.llm trusted Session identity is incomplete.')
      }
      void _provenanceContext
      void _registeredInputFiles
      return this.hostModel.call(input as HostLlmCallInput, signal, { projectId, sessionId })
    }

    if (method === 'currentModelCall') {
      if (!this.hostModel) throw new Error('host.currentModel is not configured.')
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
      if (!sessionId) {
        throw new RpcHttpError(403, 'host.currentModel trusted Session identity is incomplete.')
      }
      return this.hostModel.currentModel(sessionId)
    }

    if (method === 'listModelsCall') {
      if (!this.hostModel) throw new Error('host.listModels is not configured.')
      return this.hostModel.listModels()
    }

    if (method === 'viewImageCall') {
      if (!this.hostViewImage) throw new Error('host.viewImage is not configured.')
      const projectId = typeof params.projectId === 'string' ? params.projectId : ''
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
      const executionCwd = typeof params.executionCwd === 'string' ? params.executionCwd : ''
      const controlInvocationId =
        typeof params.controlInvocationId === 'string' ? params.controlInvocationId : ''
      if (!projectId || !sessionId || !executionCwd || !controlInvocationId) {
        throw new RpcHttpError(403, 'host.viewImage trusted capability identity is incomplete.')
      }
      return this.hostViewImage.stage(params.source, params.options, {
        projectId,
        sessionId,
        executionCwd,
        controlInvocationId,
        signal
      })
    }

    if (method === 'resolveNotebookInput') {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
      const inputRunLeaseId =
        typeof params.inputRunLeaseId === 'string' ? params.inputRunLeaseId : ''
      const sourceKind = params.sourceKind
      const inputFileVersionId = params.inputFileVersionId
      if (
        !sessionId ||
        !inputRunLeaseId ||
        (sourceKind !== 'upload-version' && sourceKind !== 'artifact-version') ||
        typeof inputFileVersionId !== 'string'
      ) {
        throw new RpcHttpError(
          400,
          'Notebook input resolution requires sessionId, inputRunLeaseId, sourceKind and inputFileVersionId.'
        )
      }
      const leases = this.activeInputRunLeases.get(sessionId)
      if (!leases || leases.size === 0) {
        throw new RpcHttpError(403, 'Notebook input resolution requires an active run lease.')
      }
      const lease = [...leases].find(
        (candidate) => this.inputRunLeaseIds.get(candidate) === inputRunLeaseId
      )
      if (!lease) {
        throw new RpcHttpError(403, 'Notebook input resolution does not match an active run lease.')
      }
      const registered = lease
        .getRunInputFiles()
        .some(
          (input) =>
            input.sourceKind === sourceKind && input.inputFileVersionId === inputFileVersionId
        )
      if (!registered) {
        throw new RpcHttpError(
          403,
          `Notebook input is not registered for this run: ${inputFileVersionId}`
        )
      }
      return {
        path: await lease.resolve({ sourceKind, inputFileVersionId })
      }
    }

    // mcpCall carries no runtime routing fields, so it bypasses assertSessionParams below. It does
    // forward the caller's session id (already alias-resolved above) as call context so a local tool
    // handler can attribute side effects to the session that invoked it.
    if (method === 'mcpCall') {
      if (!this.connectorService) throw new Error('Connector service is not configured.')
      if (typeof params.server !== 'string' || typeof params.method !== 'string') {
        throw new RpcHttpError(400, 'mcpCall requires string server and method names.')
      }
      const server = params.server
      const toolMethod = params.method
      const args = isRecord(params.args) ? params.args : {}
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
      const projectId = typeof params.projectId === 'string' ? params.projectId : undefined
      return this.connectorService.call(
        server,
        toolMethod,
        args,
        {
          sessionId,
          ...(projectId ? { projectId } : {}),
          origin: 'agent',
          ...(sessionId && this.sessionSpecialists.get(sessionId)
            ? { specialistId: this.sessionSpecialists.get(sessionId) }
            : {})
        },
        signal
      )
    }

    // computeCall routes compute API operations to ComputeService. Ownership comes only from the
    // session-bound RPC capability; snake_case owner fields in the agent-controlled body are never
    // accepted as authority.
    if (method === 'computeCall') {
      if (!this.computeService) throw new Error('Compute service is not configured.')
      const op = typeof params.op === 'string' ? params.op : ''
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
      const projectId = typeof params.projectId === 'string' ? params.projectId : ''
      const producerRunId =
        typeof params.producerRunId === 'string' && params.producerRunId
          ? params.producerRunId
          : undefined
      const context = { sessionId, projectId, producerRunId }
      if (op === 'call_command') {
        const providerId = typeof params.provider_id === 'string' ? params.provider_id : ''
        const cmd = typeof params.cmd === 'string' ? params.cmd : ''
        const intent = typeof params.intent === 'string' ? params.intent : ''
        const loginShell = typeof params.login_shell === 'boolean' ? params.login_shell : true
        const timeoutSeconds =
          typeof params.timeout_seconds === 'number' ? params.timeout_seconds : undefined
        try {
          return await this.computeService.callCommand(
            context,
            providerId,
            cmd,
            intent,
            loginShell,
            timeoutSeconds,
            signal
          )
        } catch (err) {
          // Re-throw compute call errors as structured error objects so the Python shim can
          // distinguish them from unexpected failures.
          if (err instanceof Error && 'computeCallError' in err) {
            throw new Error(
              JSON.stringify((err as Error & { computeCallError: unknown }).computeCallError)
            )
          }
          throw err
        }
      }

      // op='list' — returns all registered compute hosts for agent discovery (design.md §5).
      if (op === 'list') {
        return this.computeService.list(sessionId)
      }

      // Canonical Agent discovery is Session-scoped. Disabled hosts are absent, while the role on
      // each enabled host communicates execution targeting without exposing persistence fields.
      if (op === 'list_hosts') {
        return this.computeService.listHosts(sessionId)
      }

      // Compatibility names remain available but are projected through the same admission facade.
      if (op === 'list_registered') {
        return this.computeService.listRegistered(sessionId)
      }

      if (op === 'list_preferred') {
        return this.computeService.listPreferred(sessionId)
      }

      // op='details' — agent-facing read/append/replace for host knowledge docs (design.md §5).
      // All writes set author='agent' so the repository records detailsUpdatedBy correctly.
      if (op === 'details') {
        const providerId = typeof params.provider_id === 'string' ? params.provider_id : ''
        const mode = typeof params.mode === 'string' ? params.mode : 'read'
        if (mode === 'read') {
          const { probeResult, ...details } = await this.computeService.getDetails(
            sessionId,
            providerId
          )
          return { ...details, probe: computeProbeSnapshot(probeResult) }
        }
        if (mode === 'append') {
          const text = typeof params.text === 'string' ? params.text : ''
          await this.computeService.appendDetails(sessionId, providerId, {
            text,
            author: 'agent'
          })
          return { ok: true }
        }
        if (mode === 'replace') {
          const text = typeof params.text === 'string' ? params.text : ''
          const oldText = typeof params.old_text === 'string' ? params.old_text : ''
          await this.computeService.replaceDetails(sessionId, providerId, {
            text,
            oldText,
            author: 'agent'
          })
          return { ok: true }
        }
        throw new RpcHttpError(400, `Unknown details mode: ${mode}`)
      }

      // op='download' — agent-initiated file download to session-cache (design.md §5).
      // Approval gate fires inside ComputeService.download() before scp starts.
      if (op === 'download') {
        const providerId = typeof params.provider_id === 'string' ? params.provider_id : ''
        const remotePath = typeof params.remote_path === 'string' ? params.remote_path : ''
        return this.computeService.download(
          context,
          providerId,
          remotePath,
          {
            kind: 'session-cache'
          },
          signal
        )
      }

      // op='submit_job' — non-blocking job submission (design.md §3a).
      // Approval fires inside ComputeService.submitJob() before any DB write or SSH.
      if (op === 'submit_job') {
        const providerId = typeof params.provider_id === 'string' ? params.provider_id : ''
        const intent = typeof params.intent === 'string' ? params.intent : ''
        const command = typeof params.command === 'string' ? params.command : ''
        const invocationId = typeof params.invocation_id === 'string' ? params.invocation_id : ''
        const options = {
          environment: typeof params.environment === 'string' ? params.environment : undefined,
          resourceRequest: isRecord(params.resources)
            ? JSON.stringify(params.resources)
            : undefined,
          inputs: Array.isArray(params.inputs) ? (params.inputs as unknown[]) : undefined,
          outputManifest: Array.isArray(params.outputs)
            ? JSON.stringify(params.outputs)
            : undefined,
          harvestConfig: isRecord(params.harvest) ? JSON.stringify(params.harvest) : undefined,
          timeoutSeconds:
            typeof params.timeout_seconds === 'number' ? params.timeout_seconds : undefined,
          workspaceCwd: typeof params.workspace_cwd === 'string' ? params.workspace_cwd : undefined
        }
        try {
          if (!invocationId) {
            return await this.computeService.submitJob(
              context,
              providerId,
              intent,
              command,
              options,
              signal
            )
          }

          const sessionInvocations = this.computeSubmissionInvocations.get(sessionId) ?? new Map()
          const fingerprint = createHash('sha256')
            .update(JSON.stringify([providerId, intent, command, options]))
            .digest('hex')
          const existing = sessionInvocations.get(invocationId)
          if (existing) {
            if (existing.fingerprint !== fingerprint) {
              throw new RpcHttpError(
                409,
                'invocation_id was already used with a different submit_job request.'
              )
            }
            return await existing.submission
          }

          const submission = this.computeService.submitJob(
            context,
            providerId,
            intent,
            command,
            options,
            signal
          )
          const invocation = { fingerprint, submission, completed: false }
          sessionInvocations.set(invocationId, invocation)
          this.computeSubmissionInvocations.set(sessionId, sessionInvocations)
          try {
            const result = await submission
            invocation.completed = true
            let completedCount = 0
            for (const cached of sessionInvocations.values()) {
              if (cached.completed) completedCount += 1
            }
            for (const [cachedInvocationId, cached] of sessionInvocations) {
              if (completedCount <= MAX_COMPLETED_COMPUTE_SUBMISSIONS_PER_SESSION) break
              if (!cached.completed) continue
              sessionInvocations.delete(cachedInvocationId)
              completedCount -= 1
            }
            return result
          } catch (error) {
            if (isCurrentInFlight(sessionInvocations.get(invocationId)?.submission, submission)) {
              sessionInvocations.delete(invocationId)
              if (
                sessionInvocations.size === 0 &&
                this.computeSubmissionInvocations.get(sessionId) === sessionInvocations
              ) {
                this.computeSubmissionInvocations.delete(sessionId)
              }
            }
            throw error
          }
        } catch (err) {
          // Re-throw compute call errors as structured error objects so the JS shim can parse them.
          if (err instanceof Error && 'computeCallError' in err) {
            throw new Error(
              JSON.stringify((err as Error & { computeCallError: unknown }).computeCallError)
            )
          }
          throw err
        }
      }

      // op='job_status' — non-blocking read from DB (no SSH) (design.md §3a).
      if (op === 'job_status') {
        const providerId = typeof params.provider_id === 'string' ? params.provider_id : ''
        const jobId = typeof params.job_id === 'string' ? params.job_id : ''
        return this.computeService.getJobStatus(context, providerId, jobId)
      }

      if (op === 'job_cancel') {
        const providerId = typeof params.provider_id === 'string' ? params.provider_id : ''
        const jobId = typeof params.job_id === 'string' ? params.job_id : ''
        return this.computeService.cancelJob(context, providerId, jobId)
      }

      // op='job_result' — full JobResult (spec §11.4, design §9). Non-blocking query: reads DB
      // row + scans the local harvest directory. No SSH, no harvest trigger (issue 04).
      if (op === 'job_result') {
        const providerId = typeof params.provider_id === 'string' ? params.provider_id : ''
        const jobId = typeof params.job_id === 'string' ? params.job_id : ''
        return this.computeService.getJobResult(context, providerId, jobId)
      }

      // op='list_compute' — returns session-enabled hosts (design.md §15.1, issue 06).
      // Differs from op='list' (all registered hosts): this returns only hosts the user enabled for
      // this conversation via the ComputeHostSelector. Session id comes from COMPUTE_SESSION_ID in
      // the repl spawn env (same passthrough used by submit_job / call_command).
      if (op === 'list_compute') {
        return this.computeService.listCompute(sessionId)
      }

      // op='set_concurrency_limit' — set session-level concurrency limit (Phase 3c, issue 05).
      // Limits the number of non-terminal jobs across all providers in this session. Jobs exceeding
      // the limit enter 'queued' state and auto-dispatch when slots free up.
      if (op === 'set_concurrency_limit') {
        const limit = typeof params.limit === 'number' ? params.limit : 0
        return this.computeService.setSessionConcurrencyLimit(sessionId, limit)
      }

      // op='concurrency_status' — query session concurrency status (Phase 3c, issue 05).
      // Returns session_limit (user-set or null), active_count (non-terminal jobs in session),
      // queued_count (queued jobs in session), and provider_ceilings (per-provider hard limits).
      if (op === 'concurrency_status') {
        return this.computeService.getSessionConcurrencyStatus(sessionId)
      }

      throw new RpcHttpError(400, `Unknown computeCall op: ${op}`)
    }

    // agentsCall: host.agents control-plane SDK (issue 02). Routes operations to the AgentsService
    // dispatcher.
    //
    // TRUSTED CONTROL IDENTITY: handleRequest authenticates a dedicated session-bound capability,
    // replaces request-body session/turn/control-generation/tool fields from that capability's active
    // executeControl binding, and rejects this method through the server master token. The fields
    // read below are therefore application-owned metadata rather than sandbox parameters.
    //
    // DISPATCH SEPARATION: this route owns ONLY auth + sandbox injection. It strips every reserved
    // routing/identity/switch key (AGENTS_RESERVED_PARAM_KEYS in src/shared/agents-contract.ts) and
    // forwards the op + sanitized params + trusted session to AgentsService.read() (which delegates
    // to the extensible dispatch()). Adding a new operation never touches this path — see
    // AgentsService.dispatch's extension-point comment.
    if (method === 'agentsCall') {
      if (!this.agentsService) throw new Error('Agents service is not configured.')
      const sessionId = typeof params.session_id === 'string' ? params.session_id : undefined
      const toolInvocationId =
        typeof params.control_invocation_id === 'string' ? params.control_invocation_id : undefined
      const resolvedSessionId = sessionId
        ? (this.sessionAliases.get(sessionId) ?? sessionId)
        : undefined
      const provenanceContext = resolvedSessionId
        ? this.activeArtifactTurnBindings.get(resolvedSessionId)?.provenanceContext
        : undefined
      const projectId = resolvedSessionId
        ? this.activeArtifactTurnBindings.get(resolvedSessionId)?.projectId
        : undefined
      const registeredInputs =
        provenanceContext && projectId && resolvedSessionId
          ? this.inputRegistry?.getTurnInputs({
              projectId,
              appSessionId: resolvedSessionId,
              promptMessageId: provenanceContext.promptMessageId
            })
          : undefined
      const turnId = typeof params.turn_id === 'string' ? params.turn_id : undefined
      const controlInvocationGeneration =
        typeof params.control_invocation_generation === 'number'
          ? params.control_invocation_generation
          : undefined
      const op = typeof params.op === 'string' ? params.op : ''
      const callerRole =
        params.caller_role === 'main'
          ? 'main'
          : params.caller_role === 'delegate'
            ? 'delegate'
            : undefined
      // Strip every reserved routing/identity/switch key before forwarding. The AgentsService and
      // its injected approval/switch seams only ever see the op + their own snake_case params; the
      // trusted session identity stays in the server context (NOT taken from the forwarded params).
      // Sandbox-supplied values for specialist_id, target_specialist_id, reconfigure, etc. are
      // provably ignored — note that session_id above is intentionally read from the request as the
      // trusted identity, not from the forwarded op-params.
      const strippedParams = stripAgentsReservedParams(params)
      const {
        provenanceContext: _provenanceContext,
        registeredInputFiles: _registeredInputFiles,
        inputRunLeaseId: _inputRunLeaseId,
        ...rest
      } = strippedParams
      void _provenanceContext
      void _registeredInputFiles
      void _inputRunLeaseId
      return this.agentsService.read(
        { op, params: rest },
        turnId && controlInvocationGeneration !== undefined && toolInvocationId
          ? {
              sessionId: resolvedSessionId,
              callerRole,
              turnId,
              controlInvocationGeneration,
              toolInvocationId,
              ...(provenanceContext
                ? {
                    originatingTurnId: provenanceContext.promptMessageId,
                    originatingUserMessageId: provenanceContext.promptMessageId
                  }
                : {}),
              attachmentIds:
                registeredInputs
                  ?.filter((input) => input.sourceKind === 'upload-version')
                  .map((input) => input.sourceFileId) ?? [],
              artifactIds:
                registeredInputs
                  ?.filter((input) => input.sourceKind === 'artifact-version')
                  .map((input) => input.sourceFileId) ?? []
            }
          : { sessionId: resolvedSessionId, callerRole }
      )
    }

    if (method === 'hostSdkHelp') {
      const capabilities = params._hostCapabilityProjection
      if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
        throw new Error('Host capability projection is unavailable.')
      }
      return hostSdkHelp.query(params.query, {
        callerRole: params.caller_role === 'delegate' ? 'delegate' : 'main',
        delegationAllowed: params._delegationAllowed !== false,
        capabilities: capabilities as HostCapabilityProjection
      })
    }

    if (method === 'delegatedOutputCall') {
      if (!this.delegatedWorkService?.submitOutput) {
        throw new Error('host.submit_output is not configured.')
      }
      const projectId = typeof params.project_id === 'string' ? params.project_id : ''
      const sessionId = typeof params.session_id === 'string' ? params.session_id : ''
      const frameId = typeof params.frame_id === 'string' ? params.frame_id : ''
      const attemptId = typeof params.attempt_id === 'string' ? params.attempt_id : ''
      const originMessageId =
        typeof params.origin_message_id === 'string' ? params.origin_message_id : ''
      if (!projectId || !sessionId || !frameId || !attemptId || !originMessageId) {
        throw new RpcHttpError(403, 'host.submit_output capability identity is incomplete.')
      }
      return this.delegatedWorkService.submitOutput(
        {
          session: { projectId, sessionId },
          frameId,
          attemptId,
          role: 'delegate',
          originMessageId,
          toolInvocationId: 'delegated-output-capability'
        },
        params.value
      )
    }

    if (method === 'delegatedWorkCall') {
      if (!this.delegatedWorkService) throw new Error('Delegated Work service is not configured.')
      const projectId = typeof params.project_id === 'string' ? params.project_id : ''
      const sessionId = typeof params.session_id === 'string' ? params.session_id : ''
      const frameId = typeof params.frame_id === 'string' ? params.frame_id : ''
      const originMessageId =
        typeof params.origin_message_id === 'string' ? params.origin_message_id : ''
      const toolInvocationId =
        typeof params.tool_invocation_id === 'string' ? params.tool_invocation_id : ''
      const delegationCallId =
        typeof params.delegation_call_id === 'string' &&
        /^[1-9]\d{0,15}$/.test(params.delegation_call_id)
          ? params.delegation_call_id
          : undefined
      const role = params.caller_role === 'delegate' ? 'delegate' : 'main'
      const attemptId = typeof params.attempt_id === 'string' ? params.attempt_id : undefined
      if (!projectId || !sessionId || !frameId || !originMessageId || !toolInvocationId) {
        throw new RpcHttpError(403, 'delegated-work caller identity is incomplete.')
      }
      const parentSpecialistId = this.sessionSpecialists.get(sessionId)
      const caller: AuthenticatedDelegateCaller = {
        session: { projectId, sessionId },
        frameId,
        role,
        ...(parentSpecialistId ? { parentSpecialistId } : {}),
        ...(attemptId ? { attemptId } : {}),
        originMessageId,
        toolInvocationId: delegationCallId
          ? createNestedDelegateInvocationId(toolInvocationId, delegationCallId)
          : toolInvocationId
      }
      if (params.operation === 'stop_children') {
        if (!this.delegatedWorkService.stopChildren) {
          throw new Error('host.stop_child is not configured.')
        }
        if (
          !Array.isArray(params.frame_ids) ||
          params.frame_ids.length === 0 ||
          params.frame_ids.some((candidate) => typeof candidate !== 'string' || !candidate.trim())
        ) {
          throw new RpcHttpError(400, 'host.stop_child requires one or more frame ids.')
        }
        return this.delegatedWorkService.stopChildren(caller, params.frame_ids as string[])
      }
      const op = params.op === undefined ? 'delegate' : params.op
      if (op === 'send_message') {
        if (!this.delegatedWorkService.sendMessage) {
          throw new Error('host.send_frame_message is unavailable.')
        }
        const target = typeof params.target === 'string' ? params.target : ''
        const message = typeof params.message === 'string' ? params.message : ''
        const rawOptions = params.options === undefined ? {} : params.options
        if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
          throw new RpcHttpError(400, 'host.send_frame_message options must be an object.')
        }
        const messageOptions = rawOptions as Record<string, unknown>
        if (
          messageOptions.kind !== undefined &&
          messageOptions.kind !== 'info' &&
          messageOptions.kind !== 'question'
        )
          throw new RpcHttpError(400, 'host.send_frame_message kind must be info or question.')
        if (
          messageOptions.request_id !== undefined &&
          typeof messageOptions.request_id !== 'string'
        )
          throw new RpcHttpError(400, 'host.send_frame_message request_id must be a string.')
        if (
          messageOptions.reply_to_message_id !== undefined &&
          typeof messageOptions.reply_to_message_id !== 'string'
        )
          throw new RpcHttpError(
            400,
            'host.send_frame_message reply_to_message_id must be a string.'
          )
        if (!target || !message.trim()) {
          throw new RpcHttpError(
            400,
            'host.send_frame_message requires a target Frame and non-empty message.'
          )
        }
        return this.delegatedWorkService.sendMessage(caller, target, message, {
          ...(messageOptions.kind ? { kind: messageOptions.kind as 'info' | 'question' } : {}),
          ...(messageOptions.request_id ? { requestId: messageOptions.request_id as string } : {}),
          ...(messageOptions.reply_to_message_id
            ? { replyToMessageId: messageOptions.reply_to_message_id as string }
            : {})
        })
      }
      if (op === 'message_receipt') {
        if (!this.delegatedWorkService.messageReceipt)
          throw new Error('host.message_receipt is unavailable.')
        const selector = typeof params.selector === 'string' ? params.selector : ''
        const rawOptions = params.options === undefined ? {} : params.options
        if (!selector || !rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions))
          throw new RpcHttpError(
            400,
            'host.message_receipt requires a selector and options object.'
          )
        const timeout = (rawOptions as Record<string, unknown>).timeout_seconds
        return this.delegatedWorkService.messageReceipt(
          caller,
          selector,
          timeout === undefined ? {} : { timeoutSeconds: timeout as number }
        )
      }
      if (op === 'resolve_message') {
        if (!this.delegatedWorkService.resolveMessage)
          throw new Error('host.resolve_message is unavailable.')
        const messageId = typeof params.message_id === 'string' ? params.message_id : ''
        if (!messageId || params.action !== 'acknowledge_uncertain')
          throw new RpcHttpError(
            400,
            'host.resolve_message requires message_id and acknowledge_uncertain.'
          )
        return this.delegatedWorkService.resolveMessage(caller, messageId, {
          action: 'acknowledge_uncertain'
        })
      }
      if (op === 'children' || op === 'collect') {
        if (op === 'collect') {
          if (!this.delegatedWorkService.collect) {
            throw new Error('host.collect is not configured.')
          }
          const call = parseRpcParams(() =>
            parseCollectRpcCall({
              selectors: params.selectors ?? params.frame_ids,
              options: params.options
            })
          )
          return this.delegatedWorkService.collect(caller, call.selectors, call.options)
        }
        if (
          params.frame_ids !== undefined &&
          (!Array.isArray(params.frame_ids) ||
            params.frame_ids.some((id) => typeof id !== 'string'))
        ) {
          throw new RpcHttpError(400, `host.${op} frame_ids must be an array of strings.`)
        }
        const frameIds = params.frame_ids as readonly string[] | undefined
        if (op === 'children') {
          if (!this.delegatedWorkService.children) {
            throw new Error('host.children is not configured.')
          }
          return this.delegatedWorkService.children(caller, frameIds)
        }
      }
      if (op !== 'delegate') throw new RpcHttpError(400, 'Delegated Work operation is invalid.')
      const call = parseRpcParams(() => parseDelegateRpcCall(params))
      const request = await this.canonicalizeDelegationInputs(call.request, caller)
      return this.delegatedWorkService.delegate(caller, request, call.options)
    }

    // skillsCall: native host.skills lifecycle. Authentication and session ownership are identical
    // to host.agents, but operation semantics live entirely in HostSkillsService. Reserved routing
    // fields are stripped before dispatch so delete approval can only target the server-bound Session.
    if (method === 'skillsCall') {
      if (!this.skillsService) throw new Error('Skills service is not configured.')
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
      const op = typeof params.op === 'string' ? params.op : ''
      return this.skillsService.dispatch(
        { op, params: stripAgentsReservedParams(params) },
        { sessionId }
      )
    }

    // Notebook execution requests reaching this server originate from the authenticated Agent bridge.
    // `source` controls policy admission and is therefore host-owned authority, not caller metadata.
    // Keep accepting the field on the wire for compatibility, but canonicalize every execution entry
    // point so an Agent cannot claim `user` and bypass Agent-only Runtime creation policy.
    let trustedParams =
      method === 'beginCodeCell' || method === 'runCell' || method === 'execute'
        ? { ...params, source: 'agent' }
        : params
    if (method === 'execute' && typeof params.sessionId === 'string') {
      const specialistId = this.sessionSpecialists.get(params.sessionId)
      if (specialistId) {
        const allowedSkillIds = this.resolveSpecialistSkillIds
          ? await this.resolveSpecialistSkillIds(specialistId).catch(() => [])
          : []
        trustedParams = {
          ...trustedParams,
          registeredHelperSkillIds: [...allowedSkillIds]
        }
      }
    }
    const handler = parseRpcParams(() =>
      resolveNotebookLocalRpcHandler(this.service, method, trustedParams)
    )

    const projectId =
      typeof params.sessionId === 'string'
        ? this.activeArtifactTurnBindings.get(params.sessionId)?.projectId
        : undefined
    const provenanceContext = params.provenanceContext
    const opensInputRun = opensNotebookInputRun(method)
    if (
      opensInputRun &&
      projectId &&
      isRecord(provenanceContext) &&
      typeof provenanceContext.promptMessageId === 'string' &&
      this.inputRegistry?.openRun
    ) {
      const sessionId = params.sessionId as string
      const lease = await this.inputRegistry.openRun({
        projectId,
        appSessionId: sessionId,
        promptMessageId: provenanceContext.promptMessageId,
        ...(method === 'execute' && Array.isArray(params.artifactVersionInputs)
          ? { artifactVersionInputs: params.artifactVersionInputs as string[] }
          : {})
      })
      const leases = this.activeInputRunLeases.get(sessionId) ?? new Set<NotebookInputRunLease>()
      const inputRunLeaseId = randomUUID()
      leases.add(lease)
      this.inputRunLeaseIds.set(lease, inputRunLeaseId)
      this.activeInputRunLeases.set(sessionId, leases)
      try {
        return await handler(
          {
            ...trustedParams,
            registeredInputFiles: lease.getRunInputFiles(),
            inputRunLeaseId
          },
          signal
        )
      } finally {
        await lease.close()
        leases.delete(lease)
        this.inputRunLeaseIds.delete(lease)
        if (leases.size === 0) this.activeInputRunLeases.delete(sessionId)
      }
    }

    if (
      method === 'execute' &&
      Array.isArray(params.artifactVersionInputs) &&
      params.artifactVersionInputs.length > 0
    ) {
      throw new Error(
        'artifactVersionInputs requires an active Artifact provenance context and input registry.'
      )
    }

    return handler(trustedParams, signal)
  }

  // Rewrites the temporary notebook session id to the final ACP session id when needed.
  private resolveSessionAlias(params: Record<string, unknown>): Record<string, unknown> {
    const sessionId = params.sessionId

    if (typeof sessionId !== 'string') {
      return params
    }

    const resolvedSessionId = this.sessionAliases.get(sessionId) ?? sessionId
    const activeTurn = this.activeArtifactTurnBindings.get(resolvedSessionId)
    const provenanceContext = activeTurn?.provenanceContext
    const projectId = activeTurn?.projectId
    const registeredInputFiles =
      provenanceContext && projectId
        ? this.inputRegistry?.getTurnInputs({
            projectId,
            appSessionId: resolvedSessionId,
            promptMessageId: provenanceContext.promptMessageId
          })
        : undefined

    return {
      ...params,
      sessionId: resolvedSessionId,
      ...(provenanceContext ? { provenanceContext } : {}),
      ...(registeredInputFiles ? { registeredInputFiles } : {})
    }
  }
}

export { NotebookLocalRpcServer }
export type {
  DelegatedNotebookConnection,
  DelegatedNotebookConnectionRequest,
  NotebookLocalRpcServerOptions
}
