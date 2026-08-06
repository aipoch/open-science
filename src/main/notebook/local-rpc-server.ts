import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { NotebookRunProvenanceContext } from '../../shared/notebook'
import type { NotebookRpcConnection } from './mcp-server'
import { NotebookControlCompletionCapturedError } from './execution-owner'
import {
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
  ArtifactVersionFile,
  CreateArtifactVersionRequest,
  ReplayArtifactVersionRequest
} from '../../shared/artifact-provenance'
import {
  stripAgentsReservedParams,
  type TrustedCallingSession,
  type TrustedControlInvocationIdentity
} from '../../shared/agents-contract'
import {
  listenForLocalRpc,
  localRpcServerLogFields,
  type LocalRpcListenOptions
} from '../local-rpc-transport'
import { createLogger, errorLogFields } from '../logger'
import { PlanCommandError } from '../../shared/session-plan/contract'

const log = createLogger('notebook:local-rpc')

type NotebookLocalRpcServerOptions = {
  token?: string
  host?: string
  now?: () => number
  onSessionReleased?: (sessionId: string) => void
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
      }
    ): Promise<unknown>
  }
  computeService?: {
    callCommand(
      providerId: string,
      cmd: string,
      intent: string,
      loginShell?: boolean,
      timeoutSeconds?: number,
      context?: { sessionId: string; projectId: string }
    ): Promise<unknown>
    list(): Promise<unknown>
    getDetails(providerId: string): Promise<unknown>
    appendDetails(providerId: string, args: { text: string; author: string }): Promise<void>
    replaceDetails(
      providerId: string,
      args: { text: string; oldText: string; author: string }
    ): Promise<void>
    download(
      providerId: string,
      remotePath: string,
      dest: { kind: 'session-cache' },
      context?: { sessionId: string; projectId: string }
    ): Promise<unknown>
    submitJob(
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
      context: { sessionId: string; projectId: string }
    ): Promise<unknown>
    getJobStatus(jobId: string): Promise<unknown>
    getJobResult(jobId: string): Promise<unknown>
    // Returns the provider ids of compute hosts enabled for the given session (issue 06).
    getEnabledComputeHosts(sessionId: string): string[]
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
    }): Promise<unknown>
  }
  artifactProvenance?: {
    createVersion(request: CreateArtifactVersionRequest): Promise<ArtifactVersionFile>
    replayVersion?(request: ReplayArtifactVersionRequest): Promise<ArtifactVersionFile | undefined>
  }
  inputRegistry?: Pick<NotebookInputRegistry, 'registerTurn' | 'getTurnInputs' | 'clearSession'> &
    Partial<Pick<NotebookInputRegistry, 'openRun'>>
  // host.agents control-plane SDK (issue 02): exposes the Specialist/catalog surface to the
  // JavaScript control-plane REPL via the extensible dispatcher. Never routed through host.mcp();
  // carries the trusted calling session identity captured outside the sandbox so switch()
  // (added later) cannot be forged. `read` is kept for backward compatibility and delegates to the
  // same dispatcher; the route calls it so existing wiring and tests stay green.
  agentsService?: {
    read(op: unknown, context: TrustedCallingSession): Promise<unknown>
    dispatch?(op: unknown, context: TrustedCallingSession): Promise<unknown>
  }
}

type NotebookRpcPayload = {
  method?: unknown
  params?: unknown
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
  allowedMethods?: ReadonlySet<string>
  activeControlInvocation?: TrustedControlInvocationIdentity
}

class RpcHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message)
  }
}

const ARTIFACT_RPC_METHODS = new Set<ArtifactRpcMethod>([
  'artifactCreateVersion',
  'artifactReplayVersion'
])

// Capabilities are revoked when the turn ends. This upper bound only limits abandoned tokens, so
// it must comfortably exceed long notebook executions that remain inside one active turn.
const DEFAULT_ARTIFACT_RPC_CAPABILITY_TTL_MS = 2 * 60 * 60 * 1_000
const CONTROL_RPC_METHODS = new Set(['mcpCall', 'computeCall', 'agentsCall'])
const SKILL_IMPORT_RPC_METHODS = new Set(['skillImport'])
const PLAN_RPC_METHODS = new Set(['planCall'])

const isArtifactRpcMethod = (method: string): method is ArtifactRpcMethod =>
  ARTIFACT_RPC_METHODS.has(method as ArtifactRpcMethod)

// Narrows parsed JSON into a plain object before dispatching RPC params.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Reads the full HTTP request body and parses it as the notebook RPC payload.
const readJsonBody = async (request: IncomingMessage): Promise<NotebookRpcPayload> => {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as NotebookRpcPayload
}

// Writes one JSON response with an explicit HTTP status code.
const writeJson = (response: ServerResponse, statusCode: number, payload: unknown): void => {
  response.writeHead(statusCode, { 'content-type': 'application/json' })
  response.end(`${JSON.stringify(payload)}\n`)
}

// Hosts an authenticated app-local bridge between MCP stdio tools and the runtime service. The wire
// protocol is HTTP/JSON; Windows carries it over a named pipe instead of loopback TCP.
class NotebookLocalRpcServer {
  private readonly token: string
  private readonly host: string
  private readonly now: () => number
  private readonly onSessionReleased: NotebookLocalRpcServerOptions['onSessionReleased']
  private readonly transport: NotebookLocalRpcServerOptions['transport']
  private readonly connectorService: NotebookLocalRpcServerOptions['connectorService']
  private readonly computeService: NotebookLocalRpcServerOptions['computeService']
  private readonly skillImporter: NotebookLocalRpcServerOptions['skillImporter']
  private readonly planService: NotebookLocalRpcServerOptions['planService']
  private readonly artifactProvenance: NotebookLocalRpcServerOptions['artifactProvenance']
  private readonly inputRegistry: NotebookLocalRpcServerOptions['inputRegistry']
  private readonly agentsService: NotebookLocalRpcServerOptions['agentsService']
  private server: Server | undefined
  private startPromise: Promise<NotebookRpcConnection> | undefined
  private readonly sessionAliases = new Map<string, string>()
  private readonly sessionRpcCapabilities = new Map<string, NotebookRpcSessionBinding>()
  private readonly sessionRpcTokens = new Map<string, string>()
  private readonly skillImportRpcTokens = new Map<string, string>()
  private readonly planRpcTokens = new Map<string, string>()
  // The session → Specialist relationship is established by the ACP runtime, not supplied by the
  // notebook process. Keeping it here prevents an agent from selecting another Specialist's scope
  // by forging an RPC parameter.
  private readonly sessionSpecialists = new Map<string, string>()
  private readonly artifactProvenanceContexts = new Map<string, NotebookRunProvenanceContext>()
  private readonly activeTurnProjectIds = new Map<string, string>()
  private readonly activeInputRunLeases = new Map<string, Set<NotebookInputRunLease>>()
  private readonly inputRunLeaseIds = new WeakMap<NotebookInputRunLease, string>()
  private readonly artifactRpcCapabilities = new Map<string, ArtifactRpcCapability>()
  private readonly drainingArtifactRpcCapabilities = new Map<string, Promise<void>>()

  constructor(
    private readonly service: NotebookLocalRpcCapability,
    options: NotebookLocalRpcServerOptions = {}
  ) {
    this.token = options.token ?? randomUUID()
    this.host = options.host ?? '127.0.0.1'
    this.now = options.now ?? Date.now
    this.onSessionReleased = options.onSessionReleased
    this.transport = options.transport
    this.connectorService = options.connectorService
    this.computeService = options.computeService
    this.skillImporter = options.skillImporter
    this.planService = options.planService
    this.artifactProvenance = options.artifactProvenance
    this.inputRegistry = options.inputRegistry
    this.agentsService = options.agentsService
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
        binding.allowedMethods ?? ['artifactCreateVersion', 'artifactReplayVersion']
      ),
      expiresAt: this.now() + ttlMs,
      inFlightRequests: 0,
      drainWaiters: new Set()
    })
    return token
  }

  revokeArtifactRunCapability(token: string): Promise<void> {
    const draining = this.drainingArtifactRpcCapabilities.get(token)
    if (draining) return draining

    const capability = this.artifactRpcCapabilities.get(token)
    this.artifactRpcCapabilities.delete(token)
    if (!capability || capability.inFlightRequests === 0) return Promise.resolve()

    const drain = new Promise<void>((resolve) => {
      capability.drainWaiters.add(resolve)
    })
    this.drainingArtifactRpcCapabilities.set(token, drain)
    void drain.then(() => {
      if (this.drainingArtifactRpcCapabilities.get(token) === drain) {
        this.drainingArtifactRpcCapabilities.delete(token)
      }
    })
    return drain
  }

  // Starts the server once on an ephemeral port and returns the connection details for MCP env.
  async ensureStarted(): Promise<NotebookRpcConnection> {
    if (this.startPromise) {
      return this.startPromise
    }

    const server = createServer((request, response) => {
      void this.handleRequest(request, response)
    })
    this.server = server
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
  async close(): Promise<void> {
    const server = this.server

    this.server = undefined
    this.startPromise = undefined
    this.artifactRpcCapabilities.clear()
    this.sessionRpcCapabilities.clear()
    this.sessionRpcTokens.clear()
    this.skillImportRpcTokens.clear()

    if (!server) return

    const connection = localRpcServerLogFields(server)
    log.info('notebook RPC server stopping', connection)

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    log.info('notebook RPC server stopped', { ...connection, listening: server.listening })
  }

  // Remembers the final ACP session id for notebook aliases created before session start.
  registerSessionAlias(aliasSessionId: string, sessionId: string): void {
    this.sessionAliases.set(aliasSessionId, sessionId)
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
    }
    for (const [aliasSessionId, targetSessionId] of this.sessionAliases) {
      if (ownedSessionIds.has(aliasSessionId) || ownedSessionIds.has(targetSessionId)) {
        this.sessionAliases.delete(aliasSessionId)
      }
    }
    this.onSessionReleased?.(sessionId)
  }

  async issueSessionConnection(
    sessionId: string,
    projectId: string
  ): Promise<NotebookRpcConnection> {
    const connection = await this.ensureStarted()
    // A context reset issues the replacement under the final ACP id, while the original token can be
    // keyed by its pre-start notebook-session-* alias. Rotate the complete Agent-facing alias closure;
    // dedicated control-plane capabilities stay valid for the live Notebook runtime.
    this.revokeAgentSessionCapabilities(sessionId)

    const token = randomUUID()
    this.sessionRpcTokens.set(sessionId, token)
    this.sessionRpcCapabilities.set(token, { sessionId, projectId })
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
    projectId: string
  ): Promise<
    NotebookRpcConnection & {
      beginControlInvocation(context: TrustedControlInvocationIdentity): () => void
      release: () => void
    }
  > {
    const connection = await this.ensureStarted()
    const token = randomUUID()
    const binding: NotebookRpcSessionBinding = {
      sessionId,
      projectId,
      allowedMethods: CONTROL_RPC_METHODS
    }
    this.sessionRpcCapabilities.set(token, binding)

    return {
      endpoint: connection.endpoint,
      socketPath: connection.socketPath,
      token,
      beginControlInvocation: (context) => {
        binding.activeControlInvocation = context
        return () => {
          if (binding.activeControlInvocation === context) {
            delete binding.activeControlInvocation
          }
        }
      },
      release: () => {
        this.sessionRpcCapabilities.delete(token)
      }
    }
  }

  registerSessionSpecialist(sessionId: string, specialistId: string | undefined): void {
    if (specialistId) this.sessionSpecialists.set(sessionId, specialistId)
    else this.sessionSpecialists.delete(sessionId)
  }

  // Pins Notebook executions to the app-owned active turn. The MCP caller cannot submit or override
  // these graph locators; clearing the turn removes the binding for later user-run cells.
  setArtifactProvenanceContext(
    sessionId: string,
    context: NotebookRunProvenanceContext | undefined
  ): void {
    if (context) this.artifactProvenanceContexts.set(sessionId, context)
    else {
      this.artifactProvenanceContexts.delete(sessionId)
      this.activeTurnProjectIds.delete(sessionId)
    }
  }

  async registerNotebookTurnInputs(request: RegisterNotebookTurnInputsRequest): Promise<void> {
    if (!this.inputRegistry) return
    await this.inputRegistry.registerTurn(request)
    this.activeTurnProjectIds.set(request.appSessionId, request.projectId)
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

  // Authenticates one HTTP request, dispatches it, and serializes either result or error.
  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'Notebook RPC only accepts POST requests.' })
      return
    }

    let releaseArtifactRequest: (() => void) | undefined
    try {
      const payload = await readJsonBody(request)
      const method = typeof payload.method === 'string' ? payload.method : ''
      let params = isRecord(payload.params) ? payload.params : {}
      const authorization = request.headers.authorization
      const bearerToken = authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : ''
      if (isArtifactRpcMethod(method)) {
        const acquired = this.acquireArtifactRpcRequest(method, bearerToken, params)
        params = acquired.params
        releaseArtifactRequest = acquired.release
      } else {
        const sessionBinding = this.sessionRpcCapabilities.get(bearerToken)
        if (sessionBinding) {
          if (sessionBinding.allowedMethods && !sessionBinding.allowedMethods.has(method)) {
            throw new RpcHttpError(403, `Notebook RPC capability does not allow ${method}.`)
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
          // The request body is agent-controlled. Owner fields always come from the unforgeable,
          // per-session capability issued while building this session's Notebook environment.
          params = {
            ...params,
            sessionId: sessionBinding.sessionId,
            ...(sessionBinding.projectId ? { projectId: sessionBinding.projectId } : {}),
            ...(method === 'agentsCall'
              ? {
                  session_id: sessionBinding.sessionId,
                  turn_id: sessionBinding.activeControlInvocation?.turnId,
                  control_invocation_generation:
                    sessionBinding.activeControlInvocation?.controlInvocationGeneration,
                  control_invocation_id: sessionBinding.activeControlInvocation?.toolInvocationId
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
            PLAN_RPC_METHODS.has(method)
          ) {
            throw new RpcHttpError(401, 'A session-bound notebook RPC token is required.')
          }
        }
      }
      // Resolve pre-session aliases before the runtime service looks up persistent state.
      const result = await this.dispatch(method, this.resolveSessionAlias(params))

      writeJson(response, 200, { result })
    } catch (error) {
      // A captured control completion belongs to the approved handoff, not to this legacy RPC
      // caller. Do not serialize it as a tool error (or any result): cancellation of the old prompt
      // closes this request, at which point the transport ownership has been released.
      if (error instanceof NotebookControlCompletionCapturedError) {
        response.destroy()
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      const serializedError =
        error instanceof PlanCommandError ? { code: error.code, message } : message

      writeJson(response, error instanceof RpcHttpError ? error.statusCode : 500, {
        error: serializedError
      })
    } finally {
      releaseArtifactRequest?.()
    }
  }

  // Maps the narrow RPC method names to strongly-typed runtime service calls.
  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    // Artifact stdio/HTTP MCP handlers cannot own SQLite connections. Route the trusted run-bound
    // save envelope back into the main process, where the Provenance repository owns transactions,
    // immutable Version publication, and idempotency.
    if (method === 'artifactCreateVersion') {
      if (!this.artifactProvenance) {
        throw new Error('Artifact Provenance persistence is not configured.')
      }

      return this.artifactProvenance.createVersion(params as CreateArtifactVersionRequest)
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
        throw new Error(
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
        throw new Error('Session Plan RPC params are invalid.')
      }
      return this.planService.call({
        projectId: params.projectId,
        sessionId: params.sessionId,
        operation: params.operation as 'generate' | 'approve' | 'reject' | 'updateStepStatus',
        input: params.input
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
        throw new Error(
          'Notebook input resolution requires sessionId, inputRunLeaseId, sourceKind and inputFileVersionId.'
        )
      }
      const leases = this.activeInputRunLeases.get(sessionId)
      if (!leases || leases.size === 0) {
        throw new Error('Notebook input resolution requires an active run lease.')
      }
      const lease = [...leases].find(
        (candidate) => this.inputRunLeaseIds.get(candidate) === inputRunLeaseId
      )
      if (!lease) {
        throw new Error('Notebook input resolution does not match an active run lease.')
      }
      const registered = lease
        .getRunInputFiles()
        .some(
          (input) =>
            input.sourceKind === sourceKind && input.inputFileVersionId === inputFileVersionId
        )
      if (!registered) {
        throw new Error(`Notebook input is not registered for this run: ${inputFileVersionId}`)
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
      const server = typeof params.server === 'string' ? params.server : ''
      const toolMethod = typeof params.method === 'string' ? params.method : ''
      const args = isRecord(params.args) ? params.args : {}
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
      const projectId = typeof params.projectId === 'string' ? params.projectId : undefined
      return this.connectorService.call(server, toolMethod, args, {
        sessionId,
        ...(projectId ? { projectId } : {}),
        origin: 'agent',
        ...(sessionId && this.sessionSpecialists.get(sessionId)
          ? { specialistId: this.sessionSpecialists.get(sessionId) }
          : {})
      })
    }

    // computeCall routes compute API operations to ComputeService. Ownership comes only from the
    // session-bound RPC capability; snake_case owner fields in the agent-controlled body are never
    // accepted as authority.
    if (method === 'computeCall') {
      if (!this.computeService) throw new Error('Compute service is not configured.')
      const op = typeof params.op === 'string' ? params.op : ''
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
      const projectId = typeof params.projectId === 'string' ? params.projectId : ''
      if (op === 'call_command') {
        const providerId = typeof params.provider_id === 'string' ? params.provider_id : ''
        const cmd = typeof params.cmd === 'string' ? params.cmd : ''
        const intent = typeof params.intent === 'string' ? params.intent : ''
        const loginShell = typeof params.login_shell === 'boolean' ? params.login_shell : true
        const timeoutSeconds =
          typeof params.timeout_seconds === 'number' ? params.timeout_seconds : undefined
        const context = sessionId && projectId ? { sessionId, projectId } : undefined
        try {
          return await this.computeService.callCommand(
            providerId,
            cmd,
            intent,
            loginShell,
            timeoutSeconds,
            context
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
        return this.computeService.list()
      }

      // op='details' — agent-facing read/append/replace for host knowledge docs (design.md §5).
      // All writes set author='agent' so the repository records detailsUpdatedBy correctly.
      if (op === 'details') {
        const providerId = typeof params.provider_id === 'string' ? params.provider_id : ''
        const mode = typeof params.mode === 'string' ? params.mode : 'read'
        if (mode === 'read') {
          return this.computeService.getDetails(providerId)
        }
        if (mode === 'append') {
          const text = typeof params.text === 'string' ? params.text : ''
          await this.computeService.appendDetails(providerId, { text, author: 'agent' })
          return { ok: true }
        }
        if (mode === 'replace') {
          const text = typeof params.text === 'string' ? params.text : ''
          const oldText = typeof params.old_text === 'string' ? params.old_text : ''
          await this.computeService.replaceDetails(providerId, { text, oldText, author: 'agent' })
          return { ok: true }
        }
        throw new Error(`Unknown details mode: ${mode}`)
      }

      // op='download' — agent-initiated file download to session-cache (design.md §5).
      // Approval gate fires inside ComputeService.download() before scp starts.
      if (op === 'download') {
        const providerId = typeof params.provider_id === 'string' ? params.provider_id : ''
        const remotePath = typeof params.remote_path === 'string' ? params.remote_path : ''
        const context = sessionId && projectId ? { sessionId, projectId } : undefined
        return this.computeService.download(
          providerId,
          remotePath,
          { kind: 'session-cache' },
          context
        )
      }

      // op='submit_job' — non-blocking job submission (design.md §3a).
      // Approval fires inside ComputeService.submitJob() before any DB write or SSH.
      if (op === 'submit_job') {
        const providerId = typeof params.provider_id === 'string' ? params.provider_id : ''
        const intent = typeof params.intent === 'string' ? params.intent : ''
        const command = typeof params.command === 'string' ? params.command : ''
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
          return await this.computeService.submitJob(providerId, intent, command, options, {
            sessionId,
            projectId
          })
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
        const jobId = typeof params.job_id === 'string' ? params.job_id : ''
        return this.computeService.getJobStatus(jobId)
      }

      // op='job_result' — full JobResult (spec §11.4, design §9). Non-blocking query: reads DB
      // row + scans the local harvest directory. No SSH, no harvest trigger (issue 04).
      if (op === 'job_result') {
        const jobId = typeof params.job_id === 'string' ? params.job_id : ''
        return this.computeService.getJobResult(jobId)
      }

      // op='list_compute' — returns session-enabled hosts (design.md §15.1, issue 06).
      // Differs from op='list' (all registered hosts): this returns only hosts the user enabled for
      // this conversation via the ComputeHostSelector. Session id comes from COMPUTE_SESSION_ID in
      // the repl spawn env (same passthrough used by submit_job / call_command).
      if (op === 'list_compute') {
        return this.computeService.getEnabledComputeHosts(sessionId)
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

      throw new Error(`Unknown computeCall op: ${op}`)
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
        ? this.artifactProvenanceContexts.get(resolvedSessionId)
        : undefined
      const projectId = resolvedSessionId
        ? this.activeTurnProjectIds.get(resolvedSessionId)
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
          : { sessionId: resolvedSessionId }
      )
    }

    const handler = resolveNotebookLocalRpcHandler(this.service, method, params)

    const projectId =
      typeof params.sessionId === 'string'
        ? this.activeTurnProjectIds.get(params.sessionId)
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
        promptMessageId: provenanceContext.promptMessageId
      })
      const leases = this.activeInputRunLeases.get(sessionId) ?? new Set<NotebookInputRunLease>()
      const inputRunLeaseId = randomUUID()
      leases.add(lease)
      this.inputRunLeaseIds.set(lease, inputRunLeaseId)
      this.activeInputRunLeases.set(sessionId, leases)
      try {
        return await handler({
          ...params,
          registeredInputFiles: lease.getRunInputFiles(),
          inputRunLeaseId
        })
      } finally {
        lease.close()
        leases.delete(lease)
        this.inputRunLeaseIds.delete(lease)
        if (leases.size === 0) this.activeInputRunLeases.delete(sessionId)
      }
    }

    return handler(params)
  }

  // Rewrites the temporary notebook session id to the final ACP session id when needed.
  private resolveSessionAlias(params: Record<string, unknown>): Record<string, unknown> {
    const sessionId = params.sessionId

    if (typeof sessionId !== 'string') {
      return params
    }

    const resolvedSessionId = this.sessionAliases.get(sessionId) ?? sessionId
    const provenanceContext = this.artifactProvenanceContexts.get(resolvedSessionId)
    const projectId = this.activeTurnProjectIds.get(resolvedSessionId)
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
export type { NotebookLocalRpcServerOptions }
