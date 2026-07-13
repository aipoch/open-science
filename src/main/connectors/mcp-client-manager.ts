import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

// Config for a user-added custom MCP server. Phase 1 (stdio/local command) + Phase 2
// (streamable_http/sse remote, with static auth headers). OAuth and a dynamic headers-helper
// command are a later task — not modeled here.
// See docs/internal/2026-07-12-custom-mcp-connectors-plan4.md §3.1.
export type CustomMcpServerConfig = {
  id: string
  name: string
  transport: 'stdio' | 'streamable_http' | 'sse'
  // stdio (local command):
  command?: string
  args?: string[]
  env?: Record<string, string>
  // remote (streamable_http / sse):
  url?: string
  headers?: Record<string, string>
}

export type McpClientManagerTool = {
  name: string
  description?: string
  inputSchema?: unknown
}

type McpClientManagerDeps = {
  createClient?: (config: CustomMcpServerConfig) => Promise<Client>
}

// Pure factory: picks the transport for a custom server config. Exported so callers/tests can
// build a transport without a full connect, and so defaultCreateClient below stays a thin wrapper.
export function buildTransport(config: CustomMcpServerConfig): Transport {
  switch (config.transport) {
    case 'stdio': {
      if (!config.command) {
        throw new Error(`custom MCP server "${config.name}" is missing a command for stdio`)
      }
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env
      })
    }
    case 'streamable_http': {
      if (!config.url) {
        throw new Error(`custom MCP server "${config.name}" is missing a url for streamable_http`)
      }
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        config.headers ? { requestInit: { headers: config.headers } } : undefined
      )
    }
    case 'sse': {
      if (!config.url) {
        throw new Error(`custom MCP server "${config.name}" is missing a url for sse`)
      }
      return new SSEClientTransport(
        new URL(config.url),
        config.headers ? { requestInit: { headers: config.headers } } : undefined
      )
    }
  }
}

// Default factory: build the transport for the server's configured type and connect an MCP client.
async function defaultCreateClient(config: CustomMcpServerConfig): Promise<Client> {
  const transport = buildTransport(config)
  const client = new Client({ name: 'open-science', version: '0.0.0' })
  await client.connect(transport)
  return client
}

// MCP client for user-added custom servers (Phase 1: local/stdio). Mirrors the bundled
// ParserEngine's structured-dict + isError-throws call contract so ConnectorService can
// dispatch to either uniformly. Lazily connects and caches one client per server id.
export class McpClientManager {
  private readonly createClient: (config: CustomMcpServerConfig) => Promise<Client>
  private readonly clients = new Map<string, Client>()
  private readonly connecting = new Map<string, Promise<Client>>()

  constructor(deps?: McpClientManagerDeps) {
    this.createClient = deps?.createClient ?? defaultCreateClient
  }

  async listTools(config: CustomMcpServerConfig): Promise<McpClientManagerTool[]> {
    const client = await this.connect(config)
    const { tools } = await client.listTools()
    return tools
  }

  async call(
    config: CustomMcpServerConfig,
    method: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const client = await this.connect(config)
    const result = await client.callTool({ name: method, arguments: args })
    return unwrapToolResult(result)
  }

  async close(id: string): Promise<void> {
    const client = this.clients.get(id)
    this.clients.delete(id)
    this.connecting.delete(id)
    if (client) await client.close()
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((id) => this.close(id)))
  }

  // Lazily connects, caching the client by server id and deduping concurrent connect calls.
  private async connect(config: CustomMcpServerConfig): Promise<Client> {
    const cached = this.clients.get(config.id)
    if (cached) return cached

    const inFlight = this.connecting.get(config.id)
    if (inFlight) return inFlight

    const connectPromise = this.createClient(config)
      .then((client) => {
        this.clients.set(config.id, client)
        return client
      })
      .finally(() => {
        this.connecting.delete(config.id)
      })
    this.connecting.set(config.id, connectPromise)
    return connectPromise
  }
}

// Unwraps a callTool() result the same way the bundled engine's descriptors return data:
// isError -> throw; a single text content block -> JSON.parse (fallback to { text }); else raw.
function unwrapToolResult(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return result
  const { content, isError } = result as { content?: unknown; isError?: boolean }
  const first = Array.isArray(content) ? content[0] : undefined
  const text =
    typeof first === 'object' && first !== null && (first as { type?: unknown }).type === 'text'
      ? (first as { text?: unknown }).text
      : undefined

  if (isError) {
    throw new Error(typeof text === 'string' ? text : 'MCP tool call failed')
  }
  if (typeof text === 'string') {
    try {
      return JSON.parse(text)
    } catch {
      return { text }
    }
  }
  return result
}
