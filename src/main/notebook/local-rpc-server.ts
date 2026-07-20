import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type {
  AppendNotebookCodeCellRequest,
  BeginNotebookCodeCellRequest,
  ExecuteNotebookCodeRequest,
  FinishNotebookCodeCellRequest,
  RunNotebookCellRequest
} from '../../shared/notebook'
import type { NotebookRpcConnection } from './mcp-server'
import type { NotebookRuntimeService } from './runtime-service'

type NotebookLocalRpcServerOptions = {
  token?: string
  host?: string
  connectorService?: {
    call(
      server: string,
      method: string,
      args: Record<string, unknown>,
      context?: { sessionId?: string }
    ): Promise<unknown>
  }
}

type NotebookRpcPayload = {
  method?: unknown
  params?: unknown
}

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
  private readonly connectorService: NotebookLocalRpcServerOptions['connectorService']
  private server: Server | undefined
  private startPromise: Promise<NotebookRpcConnection> | undefined
  private readonly sessionAliases = new Map<string, string>()

  constructor(
    private readonly service: NotebookRuntimeService,
    options: NotebookLocalRpcServerOptions = {}
  ) {
    this.token = options.token ?? randomUUID()
    this.host = options.host ?? '127.0.0.1'
    this.connectorService = options.connectorService
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

  // Authenticates one HTTP request, dispatches it, and serializes either result or error.
  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'Notebook RPC only accepts POST requests.' })
      return
    }

    if (request.headers.authorization !== `Bearer ${this.token}`) {
      writeJson(response, 401, { error: 'Invalid notebook RPC token.' })
      return
    }

    try {
      const payload = await readJsonBody(request)
      const method = typeof payload.method === 'string' ? payload.method : ''
      const params = isRecord(payload.params) ? payload.params : {}
      // Resolve pre-session aliases before the runtime service looks up persistent state.
      const result = await this.dispatch(method, this.resolveSessionAlias(params))

      writeJson(response, 200, { result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      writeJson(response, 500, { error: message })
    }
  }

  // Maps the narrow RPC method names to strongly-typed runtime service calls.
  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
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
      state: (request) =>
        this.service.state(request as Parameters<NotebookRuntimeService['state']>[0]),
      restart: (request) =>
        this.service.restart(request as Parameters<NotebookRuntimeService['restart']>[0]),
      shutdown: (request) =>
        this.service.shutdown(request as Parameters<NotebookRuntimeService['shutdown']>[0])
    }

    const handler = handlers[method]

    if (!handler) {
      throw new Error(`Unknown notebook RPC method: ${method}`)
    }

    return handler(params)
  }

  // Rewrites the temporary notebook session id to the final ACP session id when needed.
  private resolveSessionAlias(params: Record<string, unknown>): Record<string, unknown> {
    const sessionId = params.sessionId

    if (typeof sessionId !== 'string') {
      return params
    }

    const resolvedSessionId = this.sessionAliases.get(sessionId)

    if (!resolvedSessionId) {
      return params
    }

    return {
      ...params,
      sessionId: resolvedSessionId
    }
  }
}

export { NotebookLocalRpcServer }
export type { NotebookLocalRpcServerOptions }
