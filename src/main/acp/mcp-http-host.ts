import { createWebMcpServer, type WebMcpHandler } from '../web/mcp-server'
import {
  HarnessToolReceipts,
  HARNESS_RECEIPTS,
  HARNESS_INVOCATION,
  HARNESS_RECEIPT_METHOD,
  receiptQuerySchema,
  type ReceiptQuery
} from '../harness-acp/tool-receipts'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { McpServer } from '@agentclientprotocol/sdk'
import {
  type SkillRuntimeEnvironment,
  environmentFromProcess,
  isOwnedSkillRuntimeAcpServer
} from '../skills/runtime-mcp-config'

import type { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { ArtifactMcpEnvironment } from '../artifacts/mcp-server'
import type { NotebookMcpEnvironment } from '../notebook/mcp-server'
import type { LiteratureLibraryMcpHandler } from '../literature/library-mcp-server'
import type { LiteratureMcpHandler } from '../literature/mcp-server'
import type { PptxMcpHandler } from '../pptx-edit/mcp-server'
import type { SkillImportMcpEnvironment } from '../skills/mcp-server'
import type { PlanMcpEnvironment } from '../session-plan/plan-mcp-server'
import type { HostMessageMcpHandler } from '../side-chat/host-message-mcp-server'
import type { ImageMcpEnvironment } from '../image-model/mcp-server'
import { createLogger } from '@aipoch/diagnostics/node'
import {
  LOCAL_RESOURCE_BUDGETS,
  ResourceBudgetExceededError,
  readBoundedJsonBody
} from '../resource-budget'

type StreamableHTTPServerTransport =
  import('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport

const log = createLogger('mcp-http-host')

type HostConnection = {
  endpoint: string
  token: string
}

// The MCP server kinds this host serves; each maps to a factory + a per-session environment.
const SERVER_KINDS = [
  'artifact',
  'image',
  'notebook',
  'skill-import',
  'skills',
  'plan',
  'host-message',
  'schedule',
  'library',
  'literature',
  'pptx',
  'web'
] as const
type ServerKind = (typeof SERVER_KINDS)[number]

const isServerKind = (value: string): value is ServerKind =>
  (SERVER_KINDS as readonly string[]).includes(value)

// The per-session environment registered for each kind, used to build a fresh MCP server per request.
type SessionEntry = {
  receiptScopes?: Partial<Record<ServerKind, string>>
  skills?: SkillRuntimeEnvironment
  artifact?: ArtifactMcpEnvironment
  image?: ImageMcpEnvironment
  notebook?: NotebookMcpEnvironment
  notebookRouteToken?: string
  skillImport?: SkillImportMcpEnvironment
  plan?: PlanMcpEnvironment
  planRouteToken?: string
  schedule?: { token: string; server: () => ModelContextProtocolServer }
  hostMessage?: HostMessageMcpHandler
  library?: { handler: LiteratureLibraryMcpHandler; token: symbol }
  web?: { handler: WebMcpHandler; token: string }
  literature?: { handler: LiteratureMcpHandler; token: symbol }
  pptx?: { handler: PptxMcpHandler; token: symbol }
}

const RECEIPT_AUTHORITY_KEYS = {
  artifact: 'artifact',
  image: 'image',
  notebook: 'notebook',
  'skill-import': 'skillImport',
  skills: 'skills',
  plan: 'planRouteToken',
  'host-message': 'hostMessage',
  schedule: 'schedule',
  library: 'library',
  literature: 'literature',
  pptx: 'pptx',
  web: 'web'
} as const
const receiptAuthority = (entry: SessionEntry | undefined, kind: ServerKind): unknown =>
  entry?.[RECEIPT_AUTHORITY_KEYS[kind]]

const writeJson = (response: ServerResponse, statusCode: number, payload: unknown): void => {
  response.writeHead(statusCode, { 'content-type': 'application/json' })
  response.end(`${JSON.stringify(payload)}\n`)
}

// Hosts the app's session-scoped MCP servers over a local, token-authenticated HTTP endpoint, for
// agent frameworks that only accept http/sse MCP. The runtime registers
// each session's per-kind environment and passes the agent an http McpServer config pointing here;
// requests are routed by `/mcp/<kind>/<sessionId>`. Stateless: a fresh MCP server + transport is built
// per request from the registered environment, mirroring the one-server-per-spawn stdio model.
class AgentMcpHttpHost {
  private readonly receipts?: HarnessToolReceipts
  private readonly token: string
  private readonly host: string
  private readonly requestBytes: number
  private server: Server | undefined
  private startPromise: Promise<HostConnection> | undefined
  private endpoint: string | undefined
  private readonly sessions = new Map<string, SessionEntry>()
  // HTTP POSTs are stateless, but cancellation must reach the still-running Library or linked-PDF POST.
  // Entries live only until that response closes; request IDs are scoped to the bound route.
  private readonly toolRequests = new Map<
    string,
    {
      routingId: string
      kind: ServerKind
      receive: NonNullable<StreamableHTTPServerTransport['onmessage']>
      response: ServerResponse
    }
  >()

  // Keep cancellations only for POSTs already arriving; never retain unknown IDs for future calls.
  private readonly readingToolRequests = new Map<
    ServerResponse,
    {
      routingId: string
      kind: ServerKind
      cancelledIds: Set<string>
      cancellationBytes: number
    }
  >()

  constructor(
    options: {
      token?: string
      host?: string
      requestBytes?: number
      receiptDirectory?: string
    } = {}
  ) {
    if (options.receiptDirectory) this.receipts = new HarnessToolReceipts(options.receiptDirectory)
    this.token = options.token ?? randomUUID()
    this.host = options.host ?? '127.0.0.1'
    this.requestBytes = options.requestBytes ?? LOCAL_RESOURCE_BUDGETS.requestBytes
  }

  // Starts the HTTP server once on an ephemeral port and returns its connection details.
  async ensureStarted(): Promise<HostConnection> {
    if (this.startPromise) {
      return this.startPromise
    }

    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch(() => {
        if (response.headersSent) response.destroy()
        else writeJson(response, 500, { error: 'MCP request failed.' })
      })
    })
    this.server = server
    this.startPromise = new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, this.host, () => {
        const address = server.address()

        if (typeof address !== 'object' || address === null) {
          reject(new Error('MCP HTTP host did not return a TCP address.'))
          return
        }

        this.endpoint = `http://${address.address}:${address.port}`
        resolve({ endpoint: this.endpoint, token: this.token })
      })
    })

    return this.startPromise
  }

  async close(): Promise<void> {
    const server = this.server

    this.server = undefined
    this.startPromise = undefined
    this.endpoint = undefined
    this.clear()

    if (!server) return

    const closing = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    server.closeAllConnections()
    await closing
  }

  // Registers (or replaces) the artifact environment for one routing id; re-registration on resume
  // simply overwrites, mirroring the stdio path which respawns with fresh env each connect.
  registerArtifact(routingId: string, environment: ArtifactMcpEnvironment): void {
    const entry = this.sessions.get(routingId) ?? {}
    entry.artifact = environment
    this.sessions.set(routingId, entry)
  }

  registerImage(routingId: string, environment: ImageMcpEnvironment): void {
    this.cancelToolRoute('image', routingId)
    const entry = this.sessions.get(routingId) ?? {}
    entry.image = environment
    this.sessions.set(routingId, entry)
  }

  registerNotebook(routingId: string, environment: NotebookMcpEnvironment): () => void {
    const entry = this.sessions.get(routingId) ?? {}
    const previousEnvironment = entry.notebook
    const previousRouteToken = entry.notebookRouteToken
    const routeToken = randomUUID()
    entry.notebook = environment
    entry.notebookRouteToken = routeToken
    this.sessions.set(routingId, entry)
    return () => {
      const current = this.sessions.get(routingId)
      if (current?.notebookRouteToken !== routeToken) return
      current.notebook = previousEnvironment
      current.notebookRouteToken = previousRouteToken
    }
  }

  registerSkillImport(routingId: string, environment: SkillImportMcpEnvironment): void {
    const entry = this.sessions.get(routingId) ?? {}
    entry.skillImport = environment
    this.sessions.set(routingId, entry)
  }

  registerReceiptScope(routingId: string, scope: string, kind: ServerKind = 'notebook'): void {
    // Optional services may be installed after Session commit; a scope alone exposes no endpoint.
    const entry = this.sessions.get(routingId) ?? {}
    entry.receiptScopes = { ...entry.receiptScopes, [kind]: scope }
    this.sessions.set(routingId, entry)
  }

  registerSkillRuntime(server: McpServer): {
    server: McpServer
    routingId: string
    release(): void
  } {
    if (!isOwnedSkillRuntimeAcpServer(server) || !('env' in server))
      throw new Error('Only host-owned Skill loaders may use the HTTP facade')
    const environment = environmentFromProcess(
      Object.fromEntries(server.env.map(({ name, value }) => [name, value]))
    )
    // Unique per provision: rollback or a stale generation cannot revoke its successor.
    const routingId = randomUUID()
    const url = this.urlFor('skills', routingId)
    this.sessions.set(routingId, { skills: environment })
    return {
      routingId,
      server: {
        type: 'http',
        name: server.name,
        url,
        headers: [{ name: 'authorization', value: `Bearer ${this.token}` }]
      },
      release: () => this.unregister(routingId)
    }
  }

  registerPlan(routingId: string, environment: PlanMcpEnvironment): () => (() => void) | undefined {
    const entry = this.sessions.get(routingId) ?? {}
    const previousPlan = entry.plan
    const previousRouteToken = entry.planRouteToken
    const routeToken = randomUUID()
    entry.plan = environment
    entry.planRouteToken = routeToken
    this.sessions.set(routingId, entry)
    return () => {
      if (this.sessions.get(routingId)?.planRouteToken !== routeToken) return undefined
      return () => {
        if (!previousPlan || !previousRouteToken) return
        const restored = this.sessions.get(routingId) ?? {}
        restored.plan = previousPlan
        restored.planRouteToken = previousRouteToken
        this.sessions.set(routingId, restored)
      }
    }
  }

  registerHostMessage(routingId: string, handler: HostMessageMcpHandler): void {
    const entry = this.sessions.get(routingId) ?? {}
    entry.hostMessage = handler
    this.sessions.set(routingId, entry)
  }

  registerWeb(routingId: string, handler: WebMcpHandler): () => void {
    this.cancelToolRoute('web', routingId)
    const entry = this.sessions.get(routingId) ?? {}
    const token = randomUUID()
    entry.web = { handler, token }
    this.sessions.set(routingId, entry)
    return () => {
      const current = this.sessions.get(routingId)
      if (current?.web?.token !== token) return
      delete current.web
      this.cancelToolRoute('web', routingId)
    }
  }

  rebindWeb(routingId: string, handler: WebMcpHandler): void {
    const entry = this.sessions.get(routingId)
    if (!entry?.web) throw new Error('No Web route to bind')
    entry.web = { ...entry.web, handler }
  }

  captureWebRoute(routingId: string): (() => void) | undefined {
    const entry = this.sessions.get(routingId)
    const web = entry?.web
    if (!web) return undefined
    const scope = entry.receiptScopes?.web
    return () => {
      this.cancelToolRoute('web', routingId)
      const restored = this.sessions.get(routingId) ?? {}
      restored.web = web
      if (scope) restored.receiptScopes = { ...restored.receiptScopes, web: scope }
      this.sessions.set(routingId, restored)
    }
  }

  webRouteRevision(routingId: string): string | undefined {
    return this.sessions.get(routingId)?.web?.token
  }

  private async recoverToolReceipt(
    scope: string,
    ownedQuery: ReceiptQuery,
    assertCurrent: () => void,
    handler?: WebMcpHandler
  ): Promise<{ status: 'unknown' | 'completed'; result?: CallToolResult }> {
    assertCurrent()
    let receipt = await this.receipts!.read(scope, ownedQuery)
    assertCurrent()
    if (receipt.status === 'unknown' && handler?.reconcileResult) {
      const known = await handler?.reconcileResult(ownedQuery)
      assertCurrent()
      if (known) {
        const { CallToolResultSchema } = await import('@modelcontextprotocol/sdk/types.js')
        assertCurrent()
        try {
          await this.receipts!.complete(scope, ownedQuery, CallToolResultSchema.parse(known))
        } catch (error) {
          if ((await this.receipts!.read(scope, ownedQuery)).status !== 'completed') throw error
        }
        receipt = await this.receipts!.read(scope, ownedQuery)
        assertCurrent()
      }
    }
    if (receipt.status === 'completed' && receipt.result) {
      receipt.result = (await handler?.receiptCommitted?.(receipt.result)) ?? receipt.result
      assertCurrent()
    }
    return receipt
  }

  registerLiterature(routingId: string, handler: LiteratureMcpHandler): () => void {
    this.cancelToolRoute('literature', routingId)
    const entry = this.sessions.get(routingId) ?? {}
    const token = Symbol('literature')
    entry.literature = { handler, token }
    this.sessions.set(routingId, entry)
    return () => {
      const current = this.sessions.get(routingId)
      if (current?.literature?.token !== token) return
      delete current.literature
      this.cancelToolRoute('literature', routingId)
    }
  }

  registerSchedule(
    routingId: string,
    create: (ownsRoute: () => boolean) => ModelContextProtocolServer
  ): string {
    const entry = this.sessions.get(routingId) ?? {}
    const token = randomUUID()
    entry.schedule = {
      token,
      server: () => create(() => this.sessions.get(routingId)?.schedule?.token === token)
    }
    this.sessions.set(routingId, entry)
    return this.urlFor('schedule', routingId) + '?token=' + encodeURIComponent(token)
  }

  captureScheduleRoute(routingId: string): (() => void) | undefined {
    const entry = this.sessions.get(routingId)
    const schedule = entry?.schedule
    if (!schedule) return
    const scope = entry.receiptScopes?.schedule
    return () => {
      const restored = this.sessions.get(routingId) ?? {}
      restored.schedule = schedule
      if (scope) restored.receiptScopes = { ...restored.receiptScopes, schedule: scope }
      this.sessions.set(routingId, restored)
    }
  }

  registerPptx(routingId: string, handler: PptxMcpHandler): () => void {
    const entry = this.sessions.get(routingId) ?? {}
    const token = Symbol('pptx')
    entry.pptx = { handler, token }
    this.sessions.set(routingId, entry)
    return () => {
      const current = this.sessions.get(routingId)
      if (current?.pptx?.token === token) delete current.pptx
    }
  }

  registerLiteratureLibrary(routingId: string, handler: LiteratureLibraryMcpHandler): () => void {
    this.cancelToolRoute('library', routingId)
    const entry = this.sessions.get(routingId) ?? {}
    const token = Symbol('library')
    entry.library = { handler, token }
    this.sessions.set(routingId, entry)
    return () => {
      const current = this.sessions.get(routingId)
      if (current?.library?.token !== token) return
      delete current.library
      this.cancelToolRoute('library', routingId)
    }
  }

  private cancelToolRoute(
    kind: 'literature' | 'library' | 'image' | 'web',
    routingId: string
  ): void {
    for (const [response, pending] of this.readingToolRequests) {
      if (pending.routingId !== routingId || pending.kind !== kind) continue
      this.readingToolRequests.delete(response)
      response.destroy()
    }
    for (const [key, active] of this.toolRequests) {
      if (active.routingId !== routingId || active.kind !== kind) continue
      this.toolRequests.delete(key)
      active.response.destroy()
    }
  }

  // Drops a routing id's registered environments once its session is gone.
  unregister(routingId: string): void {
    this.sessions.delete(routingId)
    for (const [response, pending] of this.readingToolRequests) {
      if (pending.routingId !== routingId) continue
      this.readingToolRequests.delete(response)
      response.destroy()
    }
    for (const [key, active] of this.toolRequests) {
      if (active.routingId !== routingId) continue
      this.toolRequests.delete(key)
      active.response.destroy()
    }
  }

  // Drops every registered environment (e.g. on runtime disconnect); the server keeps running for reuse.
  clear(): void {
    this.sessions.clear()
    for (const response of this.readingToolRequests.keys()) response.destroy()
    this.readingToolRequests.clear()
    for (const active of this.toolRequests.values()) active.response.destroy()
    this.toolRequests.clear()
  }

  // Builds the per-session MCP endpoint URL the agent connects to for one kind.
  urlFor(kind: ServerKind, routingId: string): string {
    if (!this.endpoint) {
      throw new Error('MCP HTTP host is not started.')
    }

    const route = `${this.endpoint}/mcp/${kind}/${encodeURIComponent(routingId)}`
    if (kind === 'web') {
      const token = this.sessions.get(routingId)?.web?.token
      if (!token) throw new Error('No registered Web route')
      return `${route}?token=${encodeURIComponent(token)}`
    }
    if (kind !== 'plan' && kind !== 'notebook') return route

    const entry = this.sessions.get(routingId)
    const routeToken = kind === 'plan' ? entry?.planRouteToken : entry?.notebookRouteToken
    if (!routeToken) throw new Error(`No registered ${kind} MCP session: ${routingId}`)
    // `token` is covered by the shared diagnostic URL redactor if this provider config is logged.
    return `${route}?token=${encodeURIComponent(routeToken)}`
  }

  // Constructs a fresh MCP server for one request from the registered environment, or undefined when
  // the routing id / kind was never registered.
  private async buildServer(
    kind: ServerKind,
    routingId: string,
    routeToken?: string
  ): Promise<ModelContextProtocolServer | undefined> {
    const entry = this.sessions.get(routingId)

    if (!entry) return undefined
    if (kind === 'skills') {
      if (!entry.skills) return undefined
      const { createSkillRuntimeMcpServer } = await import('../skills/runtime-mcp-server')
      return createSkillRuntimeMcpServer(entry.skills)
    }

    if (kind === 'artifact') {
      if (!entry.artifact) return undefined
      const [{ createArtifactMcpServer }, { ArtifactRepository }] = await Promise.all([
        import('../artifacts/mcp-server'),
        import('../artifacts/repository')
      ])

      return createArtifactMcpServer(
        new ArtifactRepository(entry.artifact.storageRoot),
        entry.artifact
      )
    }

    if (kind === 'image') {
      if (!entry.image) return undefined
      const { createImageMcpServer } = await import('../image-model/mcp-server')
      return createImageMcpServer(entry.image, `http:${routingId}`)
    }

    if (kind === 'notebook') {
      if (!entry.notebook || !routeToken || routeToken !== entry.notebookRouteToken)
        return undefined
      const { createNotebookMcpServer } = await import('../notebook/mcp-server')

      return createNotebookMcpServer(entry.notebook)
    }

    if (kind === 'plan') {
      if (!entry.plan || !routeToken || routeToken !== entry.planRouteToken) return undefined
      const { createPlanMcpServerForEnvironment } = await import('../session-plan/plan-mcp-server')
      return createPlanMcpServerForEnvironment(entry.plan)
    }

    if (kind === 'host-message') {
      if (!entry.hostMessage) return undefined
      const { createHostMessageMcpServer } = await import('../side-chat/host-message-mcp-server')
      return createHostMessageMcpServer(entry.hostMessage)
    }

    if (kind === 'web')
      return entry.web && routeToken === entry.web.token
        ? createWebMcpServer(entry.web.handler)
        : undefined
    if (kind === 'literature') {
      if (!entry.literature) return undefined
      const { createLiteratureMcpServer } = await import('../literature/mcp-server')
      return createLiteratureMcpServer(entry.literature.handler)
    }

    if (kind === 'schedule')
      return entry.schedule && entry.schedule.token === routeToken
        ? entry.schedule.server()
        : undefined
    if (kind === 'pptx') {
      if (!entry.pptx) return undefined
      const { createPptxMcpServer } = await import('../pptx-edit/mcp-server')
      return createPptxMcpServer(entry.pptx.handler)
    }

    if (kind === 'library') {
      if (!entry.library) return undefined
      const { createLiteratureLibraryMcpServer } = await import('../literature/library-mcp-server')
      return createLiteratureLibraryMcpServer(entry.library.handler)
    }

    const skillImportEnvironment = entry.skillImport
    if (!skillImportEnvironment) return undefined
    const { callGitHubSkillImportRpc, callSkillImportRpc, createSkillImportMcpServer } =
      await import('../skills/mcp-server')

    return createSkillImportMcpServer({
      requestImport: (attachmentUri, turnToken) =>
        callSkillImportRpc(skillImportEnvironment, attachmentUri, turnToken),
      requestGitHubImport: (githubUrl) =>
        callGitHubSkillImportRpc(skillImportEnvironment, githubUrl)
    })
  }

  // Authenticates, routes by path, and serves one MCP request from a fresh stateless server+transport.
  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      writeJson(response, 401, { error: 'Invalid MCP host token.' })
      return
    }

    const url = new URL(request.url ?? '', this.endpoint ?? 'http://127.0.0.1')
    const match = /^\/mcp\/([^/]+)\/(.+)$/.exec(url.pathname)

    if (!match || !isServerKind(match[1])) {
      writeJson(response, 404, { error: 'Unknown MCP endpoint.' })
      return
    }

    const kind = match[1]
    const routingId = decodeURIComponent(match[2])
    const registered = this.sessions.get(routingId)
    const authority = receiptAuthority(registered, kind)
    const server = await this.buildServer(
      kind,
      routingId,
      url.searchParams.get('token') ?? undefined
    )

    if (this.sessions.get(routingId) !== registered) {
      await server?.close()
      writeJson(response, 404, { error: 'MCP session was revoked during preparation.' })
      return
    }

    if (!server) {
      writeJson(response, 404, { error: `No registered ${kind} MCP session: ${routingId}` })
      return
    }

    const [{ StreamableHTTPServerTransport }, { CancelledNotificationSchema, isJSONRPCRequest }] =
      await Promise.all([
        import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
        import('@modelcontextprotocol/sdk/types.js')
      ])

    if (this.receipts) {
      server.server.registerCapabilities({ experimental: { [HARNESS_RECEIPTS]: {} } })
    }
    // Long-running Notebook/Plan/Image calls need SSE to deliver progress while work is pending.
    // Transport sessions remain stateless and are torn down when the response closes.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: kind !== 'notebook' && kind !== 'plan' && kind !== 'image'
    })
    response.on('close', () => {
      void transport.close()
      void server.close()
    })

    const reading = { routingId, kind, cancelledIds: new Set<string>(), cancellationBytes: 0 }
    if (
      (kind === 'library' || kind === 'literature' || kind === 'image' || kind === 'web') &&
      request.method === 'POST'
    ) {
      this.readingToolRequests.set(response, reading)
      response.once('close', () => this.readingToolRequests.delete(response))
    }
    let webReceiptCurrent: (() => boolean) | undefined
    let cancelUndispatchedWebCall: ((respond: boolean) => Promise<void>) | undefined
    try {
      await server.connect(transport)
      if (kind === 'library' || kind === 'literature' || kind === 'image' || kind === 'web') {
        const receive = transport.onmessage!
        transport.onmessage = (message, extra) => {
          this.readingToolRequests.delete(response)
          if (isJSONRPCRequest(message) && message.method === 'tools/call') {
            if (
              reading.cancelledIds.has(JSON.stringify(message.id)) ||
              (webReceiptCurrent && !webReceiptCurrent())
            ) {
              if (cancelUndispatchedWebCall) {
                void cancelUndispatchedWebCall(true).catch((error) => {
                  log.error('MCP Web cancellation receipt failed', { error })
                  response.destroy()
                })
              } else response.end()
              return
            }
            const key = JSON.stringify([kind, routingId, message.id])
            if (this.toolRequests.has(key)) {
              writeJson(response, 409, { error: 'Duplicate active MCP tool request id.' })
              return
            }
            const active = { routingId, kind, receive, response }
            this.toolRequests.set(key, active)
            response.once('close', () => {
              if (this.toolRequests.get(key) === active) this.toolRequests.delete(key)
            })
          } else {
            const cancellation = CancelledNotificationSchema.safeParse(message)
            if (cancellation.success) {
              const id = JSON.stringify(cancellation.data.params.requestId)
              for (const [pendingResponse, pending] of this.readingToolRequests) {
                if (
                  pending.kind !== kind ||
                  pending.routingId !== routingId ||
                  pending.cancelledIds.has(id)
                )
                  continue
                pending.cancellationBytes += Buffer.byteLength(id)
                if (pending.cancellationBytes > this.requestBytes) {
                  // Bound cancellation buffering by the same budget as the incoming body.
                  this.readingToolRequests.delete(pendingResponse)
                  pendingResponse.destroy()
                } else pending.cancelledIds.add(id)
              }
              const key = JSON.stringify([kind, routingId, cancellation.data.params.requestId])
              const active = this.toolRequests.get(key)
              if (active) {
                active.receive(message, extra)
                // Cancelled MCP handlers intentionally send no result. End the original POST
                // as well so its transport, server, and route entry can be released.
                active.response.end()
              }
            }
          }
          receive(message, extra)
        }
      }
      const body =
        request.method === 'POST'
          ? await readBoundedJsonBody<unknown>(request, this.requestBytes, {
              emptyValue: undefined
            })
          : undefined
      if (response.destroyed) return
      if (this.receipts && isJSONRPCRequest(body)) {
        const scope = registered?.receiptScopes?.[kind]
        const current = (): boolean =>
          this.sessions.get(routingId) === registered &&
          receiptAuthority(registered, kind) === authority &&
          registered?.receiptScopes?.[kind] === scope
        if (body.method === HARNESS_RECEIPT_METHOD) {
          if (!scope) throw new Error('Tool receipt scope is unavailable')
          const query = receiptQuerySchema.parse(body.params)
          const result = await this.recoverToolReceipt(
            scope,
            query,
            () => {
              if (!current()) throw new Error('Tool receipt scope was revoked')
            },
            kind === 'web' ? registered?.web?.handler : undefined
          )
          writeJson(response, 200, { jsonrpc: '2.0', id: body.id, result })
          return
        }
        const invocationId =
          body.params?._meta && (body.params._meta as Record<string, unknown>)[HARNESS_INVOCATION]
        if (body.method === 'tools/call' && invocationId !== undefined) {
          if (!scope) throw new Error('Tool receipt scope is unavailable')
          const query = receiptQuerySchema.parse({
            invocationId,
            name: body.params?.name,
            arguments: body.params?.arguments ?? {}
          })
          const webHandler = kind === 'web' ? registered?.web?.handler : undefined
          if (kind === 'web') {
            if (!current()) throw new Error('Tool receipt scope was revoked')
            webReceiptCurrent = current
          }
          await this.receipts.begin(scope, query)
          const send = transport.send.bind(transport)
          if (webHandler?.cancelUndispatched) {
            const cancel = webHandler.cancelUndispatched
            cancelUndispatchedWebCall = async (respond) => {
              // The route was current when this exact receipt was claimed. Even if the route
              // has since gone away, its old owner can settle only a never-dispatched outcome.
              const result = await cancel(query)
              await this.receipts!.complete(scope, query, result)
              if (!respond || response.destroyed) return
              if (!current()) response.destroy()
              else await send({ jsonrpc: '2.0', id: body.id, result })
            }
          }
          if (kind === 'web' && (!current() || response.destroyed)) {
            await cancelUndispatchedWebCall?.(false)
            if (response.destroyed) return
          }
          if (!current()) throw new Error('Tool receipt scope was revoked')
          transport.send = async (message, options) => {
            if ('id' in message && message.id === body.id && 'result' in message) {
              if (kind === 'web') {
                const assertCurrent = (): void => {
                  if (!current() || response.destroyed) throw new Error('Web invocation revoked')
                }
                assertCurrent()
                const handler = webHandler
                const signal = handler?.receiptSignal?.(query.invocationId)
                try {
                  await this.receipts!.complete(scope, query, message.result, signal)
                } catch (error) {
                  assertCurrent()
                  // Cancellation may have won before the write, or a recovery reader may have
                  // already committed its receipt. Only a journalled cancellation settles this call.
                  if (!(await handler?.reconcileResult?.(query))) throw error
                  const receipt = await this.recoverToolReceipt(
                    scope,
                    query,
                    assertCurrent,
                    handler
                  )
                  if (!receipt.result) throw error
                  return send({ ...message, result: receipt.result }, options)
                }
                assertCurrent()
                const result = (await handler?.receiptCommitted?.(message.result)) ?? message.result
                assertCurrent()
                return send({ ...message, result }, options)
              }
              await this.receipts!.complete(scope, query, message.result)
            }
            await send(message, options)
          }
        }
      }
      await transport.handleRequest(request, response, body)
    } catch (error) {
      this.readingToolRequests.delete(response)
      log.error('MCP host request failed', { kind, error })

      if (!response.headersSent) {
        if (error instanceof ResourceBudgetExceededError) {
          response.shouldKeepAlive = false
          response.setHeader('connection', 'close')
          response.once('finish', () => request.destroy())
        }
        writeJson(response, error instanceof ResourceBudgetExceededError ? 413 : 500, {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
}

export { AgentMcpHttpHost }
export type { HostConnection, ServerKind }
