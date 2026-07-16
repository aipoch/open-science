import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { createArtifactMcpServer, type ArtifactMcpEnvironment } from '../artifacts/mcp-server'
import { ArtifactRepository } from '../artifacts/repository'
import { createNotebookMcpServer, type NotebookMcpEnvironment } from '../notebook/mcp-server'
import { createLogger } from '../logger'

const log = createLogger('mcp-http-host')

type HostConnection = {
  endpoint: string
  token: string
}

// The MCP server kinds this host serves; each maps to a factory + a per-session environment.
const SERVER_KINDS = ['artifact', 'notebook'] as const
type ServerKind = (typeof SERVER_KINDS)[number]

const isServerKind = (value: string): value is ServerKind =>
  (SERVER_KINDS as readonly string[]).includes(value)

// The per-session environment registered for each kind, used to build a fresh MCP server per request.
type SessionEntry = {
  artifact?: ArtifactMcpEnvironment
  notebook?: NotebookMcpEnvironment
}

// Reads and JSON-parses a POST body so it can be handed to the transport as a pre-parsed payload.
const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  if (chunks.length === 0) return undefined

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

const writeJson = (response: ServerResponse, statusCode: number, payload: unknown): void => {
  response.writeHead(statusCode, { 'content-type': 'application/json' })
  response.end(`${JSON.stringify(payload)}\n`)
}

// Hosts the app's artifact + notebook MCP servers over a local, token-authenticated HTTP endpoint, for
// agent frameworks that only accept http/sse MCP (opencode advertises no stdio). The runtime registers
// each session's per-kind environment and passes the agent an http McpServer config pointing here;
// requests are routed by `/mcp/<kind>/<sessionId>`. Stateless: a fresh MCP server + transport is built
// per request from the registered environment, mirroring the one-server-per-spawn stdio model.
class AgentMcpHttpHost {
  private readonly token: string
  private readonly host: string
  private server: Server | undefined
  private startPromise: Promise<HostConnection> | undefined
  private endpoint: string | undefined
  private readonly sessions = new Map<string, SessionEntry>()

  constructor(options: { token?: string; host?: string } = {}) {
    this.token = options.token ?? randomUUID()
    this.host = options.host ?? '127.0.0.1'
  }

  // Starts the HTTP server once on an ephemeral port and returns its connection details.
  async ensureStarted(): Promise<HostConnection> {
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
    this.sessions.clear()

    if (!server) return

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  // Registers (or replaces) the artifact environment for one routing id; re-registration on resume
  // simply overwrites, mirroring the stdio path which respawns with fresh env each connect.
  registerArtifact(routingId: string, environment: ArtifactMcpEnvironment): void {
    const entry = this.sessions.get(routingId) ?? {}
    entry.artifact = environment
    this.sessions.set(routingId, entry)
  }

  registerNotebook(routingId: string, environment: NotebookMcpEnvironment): void {
    const entry = this.sessions.get(routingId) ?? {}
    entry.notebook = environment
    this.sessions.set(routingId, entry)
  }

  // Drops a routing id's registered environments once its session is gone.
  unregister(routingId: string): void {
    this.sessions.delete(routingId)
  }

  // Drops every registered environment (e.g. on runtime disconnect); the server keeps running for reuse.
  clear(): void {
    this.sessions.clear()
  }

  // Builds the per-session MCP endpoint URL the agent connects to for one kind.
  urlFor(kind: ServerKind, routingId: string): string {
    if (!this.endpoint) {
      throw new Error('MCP HTTP host is not started.')
    }

    return `${this.endpoint}/mcp/${kind}/${encodeURIComponent(routingId)}`
  }

  // Constructs a fresh MCP server for one request from the registered environment, or undefined when
  // the routing id / kind was never registered.
  private buildServer(kind: ServerKind, routingId: string): ModelContextProtocolServer | undefined {
    const entry = this.sessions.get(routingId)

    if (!entry) return undefined

    if (kind === 'artifact') {
      if (!entry.artifact) return undefined

      return createArtifactMcpServer(
        new ArtifactRepository(entry.artifact.storageRoot),
        entry.artifact
      )
    }

    if (!entry.notebook) return undefined

    return createNotebookMcpServer(entry.notebook)
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
    const server = this.buildServer(kind, routingId)

    if (!server) {
      writeJson(response, 404, { error: `No registered ${kind} MCP session: ${routingId}` })
      return
    }

    // Stateless: JSON responses, no persisted transport session. One server+transport per request,
    // torn down when the response closes.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    })
    response.on('close', () => {
      void transport.close()
      void server.close()
    })

    try {
      await server.connect(transport)
      const body = request.method === 'POST' ? await readJsonBody(request) : undefined
      await transport.handleRequest(request, response, body)
    } catch (error) {
      log.error('MCP host request failed', { kind, error })

      if (!response.headersSent) {
        writeJson(response, 500, {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
}

export { AgentMcpHttpHost }
export type { HostConnection, ServerKind }
