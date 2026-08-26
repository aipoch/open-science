import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'

import { OAuthCallbackServer, PersistentOAuthClientProvider } from './oauth-client'
import type { StoredCustomMcpOAuthState } from '../settings/types'
import { augmentedPathEnv } from '../settings/shell-path'
import { netFetchStandard } from '../skills/net-fetch'

// Config for a user-added custom MCP server. OAuth state is a transient main-process projection;
// stdio remains non-OAuth and remote servers can use OAuth, static headers, or neither.
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
  oauth?: {
    clientMetadataUrl?: string
    authorizationServerUrl?: string
    scopes?: string[]
    clientId?: string
    clientSecret?: string
    redirectUri?: string
    state?: StoredCustomMcpOAuthState
  }
}

export type McpClientManagerTool = {
  name: string
  description?: string
  inputSchema?: unknown
}

// Marks an MCP server's structured tool-level failure separately from connection/transport errors.
// Callers can report a safe category without treating a reachable server as physically unavailable.
export class McpToolCallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpToolCallError'
  }
}

type McpClientManagerDeps = {
  createClient?: (
    config: CustomMcpServerConfig,
    authProvider?: PersistentOAuthClientProvider,
    signal?: AbortSignal
  ) => Promise<Client>
  openExternal?: (url: string) => Promise<void> | void
  saveOAuthState?: (serverId: string, state: StoredCustomMcpOAuthState) => Promise<void>
}

type ConnectionAttempt = {
  controller: AbortController
  promise: Promise<Client>
  waiters: number
  settled: boolean
}

function waitForConnection(promise: Promise<Client>, signal?: AbortSignal): Promise<Client> {
  if (!signal) return promise
  signal.throwIfAborted()

  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', abort)
    const abort = (): void => {
      cleanup()
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (client) => {
        cleanup()
        resolve(client)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
    if (signal.aborted) abort()
  })
}

// Pure factory: picks the transport for a custom server config. Exported so callers/tests can
// build a transport without a full connect, and so defaultCreateClient below stays a thin wrapper.
export function buildTransport(
  config: CustomMcpServerConfig,
  authProvider?: PersistentOAuthClientProvider
): Transport {
  switch (config.transport) {
    case 'stdio': {
      if (!config.command) {
        throw new Error(`custom MCP server "${config.name}" is missing a command for stdio`)
      }
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: augmentedPathEnv({
          ...getDefaultEnvironment(),
          ...config.env
        }) as Record<string, string>
      })
    }
    case 'streamable_http': {
      if (!config.url) {
        throw new Error(`custom MCP server "${config.name}" is missing a url for streamable_http`)
      }
      return new StreamableHTTPClientTransport(new URL(config.url), {
        fetch: netFetchStandard,
        ...(authProvider ? { authProvider } : {}),
        ...(config.headers ? { requestInit: { headers: config.headers } } : {})
      })
    }
    case 'sse': {
      if (!config.url) {
        throw new Error(`custom MCP server "${config.name}" is missing a url for sse`)
      }
      return new SSEClientTransport(new URL(config.url), {
        fetch: netFetchStandard,
        ...(authProvider ? { authProvider } : {}),
        ...(config.headers ? { requestInit: { headers: config.headers } } : {})
      })
    }
  }
}

// Default factory: build the transport for the server's configured type and connect an MCP client.
async function defaultCreateClient(
  config: CustomMcpServerConfig,
  authProvider?: PersistentOAuthClientProvider,
  signal?: AbortSignal
): Promise<Client> {
  const transport = buildTransport(config, authProvider)
  const client = new Client({ name: 'open-science', version: '0.0.0' })
  await client.connect(transport, signal ? { signal } : undefined)
  return client
}

// MCP client for user-added custom servers (Phase 1: local/stdio). Mirrors the bundled
// ParserEngine's structured-dict + isError-throws call contract so ConnectorService can
// dispatch to either uniformly. Lazily connects and caches one client per server id.
export class McpClientManager {
  private readonly createClient: (
    config: CustomMcpServerConfig,
    authProvider?: PersistentOAuthClientProvider,
    signal?: AbortSignal
  ) => Promise<Client>
  private readonly clients = new Map<string, Client>()
  private readonly connecting = new Map<string, ConnectionAttempt>()
  private readonly authenticationCancels = new Map<string, () => Promise<void>>()
  private readonly generations = new Map<string, number>()
  private readonly callbackServer = new OAuthCallbackServer()
  private readonly openExternal: (url: string) => Promise<void> | void
  private readonly saveOAuthState?: (
    serverId: string,
    state: StoredCustomMcpOAuthState
  ) => Promise<void>

  constructor(deps?: McpClientManagerDeps) {
    this.createClient = deps?.createClient ?? defaultCreateClient
    this.openExternal =
      deps?.openExternal ??
      (() => {
        throw new Error('No browser opener is configured for OAuth')
      })
    this.saveOAuthState = deps?.saveOAuthState
  }

  async listTools(
    config: CustomMcpServerConfig,
    signal?: AbortSignal
  ): Promise<McpClientManagerTool[]> {
    signal?.throwIfAborted()
    const client = await this.connect(config, signal)
    try {
      signal?.throwIfAborted()
      const { tools } = signal
        ? await client.listTools(undefined, { signal })
        : await client.listTools()
      return tools
    } catch (error) {
      if (!signal?.aborted) await this.discardClient(config.id, client)
      throw error
    }
  }

  async call(
    config: CustomMcpServerConfig,
    method: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    signal?.throwIfAborted()
    const client = await this.connect(config, signal)
    try {
      signal?.throwIfAborted()
      const input = { name: method, arguments: args }
      const result = signal
        ? await client.callTool(input, undefined, { signal })
        : await client.callTool(input)
      return unwrapToolResult(result)
    } catch (error) {
      if (!signal?.aborted && !(error instanceof McpToolCallError)) {
        await this.discardClient(config.id, client)
      }
      throw error
    }
  }

  async close(id: string): Promise<void> {
    this.generations.set(id, this.generation(id) + 1)
    const attempt = this.connecting.get(id)
    this.connecting.delete(id)
    attempt?.controller.abort()
    const cancelAuthentication = this.authenticationCancels.get(id)
    this.authenticationCancels.delete(id)
    await cancelAuthentication?.()
    const client = this.clients.get(id)
    this.clients.delete(id)
    if (client) await client.close()
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [
        ...new Set([
          ...this.clients.keys(),
          ...this.connecting.keys(),
          ...this.authenticationCancels.keys()
        ])
      ].map((id) => this.close(id))
    )
    await this.callbackServer.close()
  }

  async cancelAuthentication(id: string): Promise<void> {
    await this.close(id)
  }

  // Starts standard OAuth, waits for the loopback callback, and caches an authenticated client.
  async authenticate(config: CustomMcpServerConfig): Promise<void> {
    if (!config.oauth || config.transport === 'stdio') {
      throw new Error(`custom MCP server "${config.name}" is not configured for OAuth`)
    }
    let callback: ReturnType<OAuthCallbackServer['waitFor']> | undefined
    let activeClient: Client | undefined
    const cancelAuthentication = async (): Promise<void> => {
      callback?.cancel()
      const client = activeClient
      activeClient = undefined
      if (client) await client.close().catch(() => undefined)
    }
    const closing = this.close(config.id)
    const generation = this.generation(config.id)
    // Register before the first await so closeAll() can supersede startup during application exit.
    this.authenticationCancels.set(config.id, cancelAuthentication)
    try {
      await closing
      if (generation !== this.generation(config.id)) {
        throw new Error(`custom MCP server "${config.name}" connection was superseded`)
      }
      const redirectUrl = await this.callbackServer.ensureStarted(config.oauth.redirectUri)
      if (generation !== this.generation(config.id)) {
        throw new Error(`custom MCP server "${config.name}" connection was superseded`)
      }
      const provider = this.oauthProvider(config, redirectUrl, generation, true)
      callback = this.callbackServer.waitFor(provider.state())
      const transport = buildTransport(config, provider)
      const firstClient = new Client({ name: 'open-science', version: '0.0.0' })
      activeClient = firstClient
      try {
        await firstClient.connect(transport)
        if (generation !== this.generation(config.id)) {
          await firstClient.close().catch(() => undefined)
          throw new Error(`custom MCP server "${config.name}" connection was superseded`)
        }
        this.clients.set(config.id, firstClient)
        activeClient = undefined
        return
      } catch (error) {
        if (!(error instanceof UnauthorizedError)) throw error
        await firstClient.close().catch(() => undefined)
        if (activeClient === firstClient) activeClient = undefined
      }

      try {
        const result = await callback.promise
        if (result.error) throw new Error(`OAuth authorization failed: ${result.error}`)
        if (!result.code) throw new Error('OAuth callback did not include an authorization code')

        await (transport as StreamableHTTPClientTransport | SSEClientTransport).finishAuth(
          result.code
        )
      } finally {
        await provider.invalidateCredentials('verifier')
      }
      // Recreate the transport/client after the SDK has completed the authorization-code exchange.
      const client = new Client({ name: 'open-science', version: '0.0.0' })
      activeClient = client
      await client.connect(buildTransport(config, provider))
      if (generation !== this.generation(config.id)) {
        await client.close().catch(() => undefined)
        throw new Error(`custom MCP server "${config.name}" connection was superseded`)
      }
      this.clients.set(config.id, client)
      activeClient = undefined
    } finally {
      await cancelAuthentication()
      if (this.authenticationCancels.get(config.id) === cancelAuthentication) {
        this.authenticationCancels.delete(config.id)
      }
    }
  }

  // Lazily connects, caching the client by server id and deduping concurrent connect calls. Each
  // caller can stop waiting independently; the underlying connection is cancelled only once no
  // callers remain, so one disconnected RPC cannot interrupt another caller sharing the attempt.
  private async connect(config: CustomMcpServerConfig, signal?: AbortSignal): Promise<Client> {
    signal?.throwIfAborted()
    const cached = this.clients.get(config.id)
    if (cached) return cached

    let attempt = this.connecting.get(config.id)
    if (!attempt) {
      const generation = this.generation(config.id)
      const controller = new AbortController()
      const promise = this.createClientWithOAuth(config, generation, controller.signal)
        .then(async (client) => {
          if (generation !== this.generation(config.id)) {
            await client.close().catch(() => undefined)
            throw new Error(`custom MCP server "${config.name}" connection was superseded`)
          }
          if (controller.signal.aborted) {
            await client.close().catch(() => undefined)
            controller.signal.throwIfAborted()
          }
          this.clients.set(config.id, client)
          return client
        })
        .finally(() => {
          const current = this.connecting.get(config.id)
          if (current?.promise === promise) {
            current.settled = true
            this.connecting.delete(config.id)
          }
        })
      const entry: ConnectionAttempt = { controller, promise, waiters: 0, settled: false }
      this.connecting.set(config.id, entry)
      attempt = entry
    }

    attempt.waiters += 1
    try {
      return await waitForConnection(attempt.promise, signal)
    } finally {
      attempt.waiters -= 1
      if (attempt.waiters === 0 && !attempt.settled) {
        if (this.connecting.get(config.id) === attempt) {
          this.connecting.delete(config.id)
        }
        attempt.controller.abort(signal?.reason)
      }
    }
  }

  private async createClientWithOAuth(
    config: CustomMcpServerConfig,
    generation: number,
    signal: AbortSignal
  ): Promise<Client> {
    signal.throwIfAborted()
    if (!config.oauth) return this.createClient(config, undefined, signal)
    const redirectUrl = await this.callbackServer.ensureStarted(config.oauth.redirectUri)
    signal.throwIfAborted()
    return this.createClient(config, this.oauthProvider(config, redirectUrl, generation), signal)
  }

  private oauthProvider(
    config: CustomMcpServerConfig,
    redirectUrl: string,
    generation: number,
    interactive = false
  ): PersistentOAuthClientProvider {
    return new PersistentOAuthClientProvider({
      serverId: config.id,
      redirectUrl,
      config: config.oauth ?? {},
      clientSecret: config.oauth?.clientSecret,
      state: config.oauth?.state,
      ...(interactive ? { openExternal: this.openExternal } : {}),
      saveState: this.saveOAuthState
        ? (state) =>
            generation === this.generation(config.id)
              ? this.saveOAuthState!(config.id, state)
              : Promise.resolve()
        : undefined
    })
  }

  private generation(id: string): number {
    return this.generations.get(id) ?? 0
  }

  private async discardClient(id: string, expected: Client): Promise<void> {
    if (this.clients.get(id) !== expected) return
    this.clients.delete(id)
    await expected.close().catch(() => undefined)
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
    throw new McpToolCallError(typeof text === 'string' ? text : 'MCP tool call failed')
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
