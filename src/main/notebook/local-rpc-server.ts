import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type {
  AppendNotebookCodeCellRequest,
  BeginNotebookCodeCellRequest,
  ExecuteNotebookCodeRequest,
  FinishNotebookCodeCellRequest,
  NotebookRunProvenanceContext,
  RunNotebookCellRequest
} from '../../shared/notebook'
import type { NotebookRpcConnection } from './mcp-server'
import type { NotebookRuntimeService } from './runtime-service'
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

type NotebookLocalRpcServerOptions = {
  token?: string
  host?: string
  now?: () => number
  connectorService?: {
    call(
      server: string,
      method: string,
      args: Record<string, unknown>,
      context?: { sessionId?: string }
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
  artifactProvenance?: {
    createVersion(request: CreateArtifactVersionRequest): Promise<ArtifactVersionFile>
    replayVersion?(request: ReplayArtifactVersionRequest): Promise<ArtifactVersionFile | undefined>
  }
  inputRegistry?: Pick<NotebookInputRegistry, 'registerTurn' | 'getTurnInputs' | 'clearSession'> &
    Partial<Pick<NotebookInputRegistry, 'openRun'>>
}

type NotebookRpcPayload = {
  method?: unknown
  params?: unknown
}

type ArtifactRpcCapability = Omit<ArtifactRpcCapabilityBinding, 'allowedMethods'> & {
  allowedMethods: Set<ArtifactRpcMethod>
  expiresAt: number
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

// Ensures every runtime command carries the session routing fields the service needs.
const assertSessionParams = (params: Record<string, unknown>): void => {
  if (typeof params.sessionId !== 'string' || typeof params.workspaceCwd !== 'string') {
    throw new Error('Notebook RPC params must include sessionId and workspaceCwd.')
  }
}

// Hosts an app-local authenticated HTTP bridge between MCP stdio tools and the runtime service.
class NotebookLocalRpcServer {
  private readonly token: string
  private readonly host: string
  private readonly now: () => number
  private readonly connectorService: NotebookLocalRpcServerOptions['connectorService']
  private readonly computeService: NotebookLocalRpcServerOptions['computeService']
  private readonly skillImporter: NotebookLocalRpcServerOptions['skillImporter']
  private readonly artifactProvenance: NotebookLocalRpcServerOptions['artifactProvenance']
  private readonly inputRegistry: NotebookLocalRpcServerOptions['inputRegistry']
  private server: Server | undefined
  private startPromise: Promise<NotebookRpcConnection> | undefined
  private readonly sessionAliases = new Map<string, string>()
  private readonly artifactProvenanceContexts = new Map<string, NotebookRunProvenanceContext>()
  private readonly activeTurnProjectIds = new Map<string, string>()
  private readonly activeInputRunLeases = new Map<string, Set<NotebookInputRunLease>>()
  private readonly artifactRpcCapabilities = new Map<string, ArtifactRpcCapability>()

  constructor(
    private readonly service: NotebookRuntimeService,
    options: NotebookLocalRpcServerOptions = {}
  ) {
    this.token = options.token ?? randomUUID()
    this.host = options.host ?? '127.0.0.1'
    this.now = options.now ?? Date.now
    this.connectorService = options.connectorService
    this.computeService = options.computeService
    this.skillImporter = options.skillImporter
    this.artifactProvenance = options.artifactProvenance
    this.inputRegistry = options.inputRegistry
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
      expiresAt: this.now() + ttlMs
    })
    return token
  }

  revokeArtifactRunCapability(token: string): void {
    this.artifactRpcCapabilities.delete(token)
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
    this.startPromise = new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, this.host, () => {
        const address = server.address()

        if (typeof address !== 'object' || address === null) {
          reject(new Error('Notebook RPC server did not return a TCP address.'))
          return
        }

        resolve({
          endpoint: `http://${address.address}:${address.port}`,
          token: this.token
        })
      })
    })

    return this.startPromise
  }

  // Stops the local HTTP server without touching notebook history or runtime state.
  async close(): Promise<void> {
    const server = this.server

    this.server = undefined
    this.startPromise = undefined
    this.artifactRpcCapabilities.clear()

    if (!server) return

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  // Remembers the final ACP session id for notebook aliases created before session start.
  registerSessionAlias(aliasSessionId: string, sessionId: string): void {
    this.sessionAliases.set(aliasSessionId, sessionId)
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

  private bindArtifactRpcParams(
    method: ArtifactRpcMethod,
    token: string,
    params: Record<string, unknown>
  ): Record<string, unknown> {
    const capability = this.artifactRpcCapabilities.get(token)
    if (!capability) throw new RpcHttpError(401, 'Invalid Artifact RPC capability.')
    if (capability.expiresAt <= this.now()) {
      this.artifactRpcCapabilities.delete(token)
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

    const trustedParams = { ...params }
    delete trustedParams.messageBranchAncestry
    delete trustedParams.messageAncestry
    delete trustedParams.agentName
    delete trustedParams.notebookSessionId

    return {
      ...trustedParams,
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
  }

  // Authenticates one HTTP request, dispatches it, and serializes either result or error.
  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'Notebook RPC only accepts POST requests.' })
      return
    }

    try {
      const payload = await readJsonBody(request)
      const method = typeof payload.method === 'string' ? payload.method : ''
      let params = isRecord(payload.params) ? payload.params : {}
      const authorization = request.headers.authorization
      const bearerToken = authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : ''
      if (isArtifactRpcMethod(method)) {
        params = this.bindArtifactRpcParams(method, bearerToken, params)
      } else if (authorization !== `Bearer ${this.token}`) {
        throw new RpcHttpError(401, 'Invalid notebook RPC token.')
      }
      // Resolve pre-session aliases before the runtime service looks up persistent state.
      const result = await this.dispatch(method, this.resolveSessionAlias(params))

      writeJson(response, 200, { result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      writeJson(response, error instanceof RpcHttpError ? error.statusCode : 500, {
        error: message
      })
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
        typeof params.sessionId !== 'string' ||
        typeof params.turnToken !== 'string' ||
        typeof params.attachmentUri !== 'string'
      ) {
        throw new Error(
          'Skill import RPC params must include sessionId, turnToken and attachmentUri.'
        )
      }
      const request: ConversationSkillImportRequest = {
        sessionId: params.sessionId,
        turnToken: params.turnToken,
        attachmentUri: params.attachmentUri
      }
      return this.skillImporter.request(request)
    }

    if (method === 'resolveNotebookInput') {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
      const sourceKind = params.sourceKind
      const inputFileVersionId = params.inputFileVersionId
      if (
        !sessionId ||
        (sourceKind !== 'upload-version' && sourceKind !== 'artifact-version') ||
        typeof inputFileVersionId !== 'string'
      ) {
        throw new Error(
          'Notebook input resolution requires sessionId, sourceKind and inputFileVersionId.'
        )
      }
      const leases = this.activeInputRunLeases.get(sessionId)
      if (!leases || leases.size === 0) {
        throw new Error('Notebook input resolution requires an active run lease.')
      }
      const matchingLeases = [...leases].filter((lease) =>
        lease
          .getRunInputFiles()
          .some(
            (input) =>
              input.sourceKind === sourceKind && input.inputFileVersionId === inputFileVersionId
          )
      )
      if (matchingLeases.length === 0) {
        throw new Error(`Notebook input is not registered for an active run: ${inputFileVersionId}`)
      }
      // Control and data-kernel RPCs may overlap for one Session. Every matching lease is bound to
      // the same immutable Version; resolve each so its execution snapshot records the dependency,
      // then reject if a corrupt registry ever maps that identity to different bytes.
      const resolvedPaths = await Promise.all(
        matchingLeases.map((lease) => lease.resolve({ sourceKind, inputFileVersionId }))
      )
      if (new Set(resolvedPaths).size !== 1) {
        throw new Error(
          `Notebook input leases disagree on immutable content: ${inputFileVersionId}`
        )
      }
      return {
        path: resolvedPaths[0]
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
      return this.connectorService.call(server, toolMethod, args, { sessionId })
    }

    // computeCall routes compute API operations to ComputeService (design.md §2). The `op` field
    // allows future ops (list, details) to be added without breaking the contract (design.md §5).
    // Not session-scoped — like mcpCall it bypasses the session routing below.
    if (method === 'computeCall') {
      if (!this.computeService) throw new Error('Compute service is not configured.')
      const op = typeof params.op === 'string' ? params.op : ''
      if (op === 'call_command') {
        const providerId = typeof params.provider_id === 'string' ? params.provider_id : ''
        const cmd = typeof params.cmd === 'string' ? params.cmd : ''
        const intent = typeof params.intent === 'string' ? params.intent : ''
        const loginShell = typeof params.login_shell === 'boolean' ? params.login_shell : true
        const timeoutSeconds =
          typeof params.timeout_seconds === 'number' ? params.timeout_seconds : undefined
        // Optional session/project context for grant-scope approval memory (issue 05).
        // When absent, callCommand falls back to the legacy 'once'-only behaviour.
        const sessionId = typeof params.session_id === 'string' ? params.session_id : undefined
        const projectId = typeof params.project_id === 'string' ? params.project_id : undefined
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
        // Optional session/project context for grant-scope approval memory (matching call_command).
        const sessionId = typeof params.session_id === 'string' ? params.session_id : undefined
        const projectId = typeof params.project_id === 'string' ? params.project_id : undefined
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
        const sessionId = typeof params.session_id === 'string' ? params.session_id : ''
        const projectId = typeof params.project_id === 'string' ? params.project_id : ''
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
        const sessionId = typeof params.session_id === 'string' ? params.session_id : ''
        return this.computeService.getEnabledComputeHosts(sessionId)
      }

      // op='set_concurrency_limit' — set session-level concurrency limit (Phase 3c, issue 05).
      // Limits the number of non-terminal jobs across all providers in this session. Jobs exceeding
      // the limit enter 'queued' state and auto-dispatch when slots free up.
      if (op === 'set_concurrency_limit') {
        const sessionId = typeof params.session_id === 'string' ? params.session_id : ''
        const limit = typeof params.limit === 'number' ? params.limit : 0
        return this.computeService.setSessionConcurrencyLimit(sessionId, limit)
      }

      // op='concurrency_status' — query session concurrency status (Phase 3c, issue 05).
      // Returns session_limit (user-set or null), active_count (non-terminal jobs in session),
      // queued_count (queued jobs in session), and provider_ceilings (per-provider hard limits).
      if (op === 'concurrency_status') {
        const sessionId = typeof params.session_id === 'string' ? params.session_id : ''
        return this.computeService.getSessionConcurrencyStatus(sessionId)
      }

      throw new Error(`Unknown computeCall op: ${op}`)
    }

    assertSessionParams(params)

    const handlers: Record<string, (request: Record<string, unknown>) => Promise<unknown>> = {
      beginCodeCell: (request) =>
        this.service.beginCodeCell(request as unknown as BeginNotebookCodeCellRequest),
      appendCodeCell: (request) =>
        this.service.appendCodeCell(request as unknown as AppendNotebookCodeCellRequest),
      finishCodeCell: (request) =>
        this.service.finishCodeCell(request as unknown as FinishNotebookCodeCellRequest),
      runCell: (request) => this.service.runCell(request as unknown as RunNotebookCellRequest),
      execute: (request) => this.service.execute(request as unknown as ExecuteNotebookCodeRequest),
      executeControl: (request) =>
        this.service.executeControl(
          request as unknown as Parameters<NotebookRuntimeService['executeControl']>[0]
        ),
      executeShell: (request) =>
        this.service.executeShell(
          request as unknown as Parameters<NotebookRuntimeService['executeShell']>[0]
        ),
      state: (request) =>
        this.service.state(request as Parameters<NotebookRuntimeService['state']>[0]),
      restart: (request) =>
        this.service.restart(request as Parameters<NotebookRuntimeService['restart']>[0]),
      shutdown: (request) =>
        this.service.shutdown(request as Parameters<NotebookRuntimeService['shutdown']>[0]),
      managePackages: (request) =>
        this.service.managePackages(
          request as unknown as Parameters<NotebookRuntimeService['managePackages']>[0]
        ),
      manageEnvironments: (request) =>
        this.service.manageEnvironments(
          request as unknown as Parameters<NotebookRuntimeService['manageEnvironments']>[0]
        ),
      listRuntimes: (request) =>
        this.service.listRuntimes(request as Parameters<NotebookRuntimeService['listRuntimes']>[0]),
      bindRuntime: (request) =>
        this.service.bindRuntime(
          request as unknown as Parameters<NotebookRuntimeService['bindRuntime']>[0]
        ),
      switchRuntime: (request) =>
        this.service.switchRuntime(
          request as unknown as Parameters<NotebookRuntimeService['switchRuntime']>[0]
        )
    }

    const handler = handlers[method]

    if (!handler) {
      throw new Error(`Unknown notebook RPC method: ${method}`)
    }

    const projectId =
      typeof params.sessionId === 'string'
        ? this.activeTurnProjectIds.get(params.sessionId)
        : undefined
    const provenanceContext = params.provenanceContext
    const opensInputRun = ['runCell', 'execute', 'executeControl', 'executeShell'].includes(method)
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
      leases.add(lease)
      this.activeInputRunLeases.set(sessionId, leases)
      try {
        return await handler({ ...params, registeredInputFiles: lease.getRunInputFiles() })
      } finally {
        lease.close()
        leases.delete(lease)
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
