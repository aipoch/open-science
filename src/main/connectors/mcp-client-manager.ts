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
import { redactSensitiveText } from '../diagnostic-redaction'
import { createLogger } from '../logger'
import { assertSecureCustomMcpUrl } from './custom-mcp-url'

const log = createLogger('connectors:mcp-client')
const STDERR_LINE_LIMIT = 4 * 1024
const STDERR_TOTAL_LIMIT = 64 * 1024
const STDERR_REDACTION_COMPARISON_LIMIT = 4 * 1024 * 1024
const STDERR_TRUNCATION_MARKER = '…[truncated]'
const MAX_MCP_REDIRECTS = 5
const MCP_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

// Config for a user-added custom MCP server. OAuth state is a transient main-process projection;
// stdio remains non-OAuth and remote servers can use OAuth, static headers, or neither.
export type CustomMcpServerConfig = {
  id: string
  name: string
  configurationFingerprint?: string
  oauthClientSecretRef?: string
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
    // Device-global OAuth credential identity. It is never sent to the remote server.
    credentialId?: string
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

const createCustomMcpFetch = (
  configuredUrl: URL,
  configuredHeaders?: Record<string, string>
): typeof fetch =>
  async function customMcpFetch(input, init): Promise<Response> {
    const inputRequest = typeof input === 'string' || input instanceof URL ? undefined : input
    let target = new URL(inputRequest?.url ?? input.toString())
    const requestOrigin = target.origin
    let requestInit = init

    if (target.origin === configuredUrl.origin && configuredHeaders) {
      const headers = new Headers(inputRequest?.headers)
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
      new Headers(configuredHeaders).forEach((value, name) => headers.set(name, value))
      requestInit = { ...init, headers }
    }

    for (let redirects = 0; ; redirects += 1) {
      assertSecureCustomMcpUrl(target.toString())
      if (target.origin !== requestOrigin) {
        throw new Error('Remote MCP server redirects must stay on the configured origin.')
      }

      const response = await netFetchStandard(target, { ...requestInit, redirect: 'manual' })
      if (!MCP_REDIRECT_STATUSES.has(response.status)) return response

      const location = response.headers.get('location')
      if (!location || redirects >= MAX_MCP_REDIRECTS) {
        await response.body?.cancel()
        throw new Error('Remote MCP server redirect is invalid.')
      }

      const next = new URL(location, target)
      assertSecureCustomMcpUrl(next.toString())
      if (next.origin !== requestOrigin) {
        await response.body?.cancel()
        throw new Error('Remote MCP server redirects must stay on the configured origin.')
      }

      const method = (requestInit?.method ?? inputRequest?.method ?? 'GET').toUpperCase()
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === 'POST')
      ) {
        const headers = new Headers(requestInit?.headers ?? inputRequest?.headers)
        headers.delete('content-encoding')
        headers.delete('content-language')
        headers.delete('content-location')
        headers.delete('content-type')
        requestInit = { ...requestInit, body: undefined, headers, method: 'GET' }
      }

      await response.body?.cancel()
      target = next
    }
  }

type McpClientManagerDeps = {
  createClient?: (
    config: CustomMcpServerConfig,
    authProvider?: PersistentOAuthClientProvider,
    signal?: AbortSignal
  ) => Promise<Client>
  openExternal?: (url: string) => Promise<void> | void
  saveOAuthState?: (
    serverId: string,
    state: StoredCustomMcpOAuthState,
    expectedConfigurationFingerprint?: string,
    expectedOAuthClientSecretRef?: string
  ) => Promise<void>
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

const uniqueKnownValues = (values: readonly string[]): string[] =>
  [
    ...new Set(
      values
        .filter(Boolean)
        .flatMap((value) => [value, value.replace(/\r/gu, '\\r').replace(/\n/gu, '\\n')])
    )
  ].sort((a, b) => b.length - a.length)

const truncateUtf8 = (value: string, maxBytes: number): string => {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const markerBytes = Buffer.byteLength(STDERR_TRUNCATION_MARKER, 'utf8')
  let result = ''
  let resultBytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (resultBytes + characterBytes > maxBytes - markerBytes) break
    result += character
    resultBytes += characterBytes
  }
  return `${result}${STDERR_TRUNCATION_MARKER}`
}

const captureStdioStderr = (
  stderr: import('node:stream').Stream | null,
  config: CustomMcpServerConfig
): void => {
  if (!stderr) return
  const readable = stderr as unknown as NodeJS.ReadableStream

  const knownValues = uniqueKnownValues(Object.values(config.env ?? {}))
  const knownValuesByInitial = new Map<string, string[]>()
  for (const value of knownValues) {
    const initial = value[0]
    if (!initial) continue
    const matches = knownValuesByInitial.get(initial) ?? []
    matches.push(value)
    knownValuesByInitial.set(initial, matches)
  }
  let redactionPending = ''
  let heldKnownValuePrefixLength = 0
  let linePending = ''
  let receivedBytes = 0
  let totalTruncationLogged = false
  let redactionComparisonsRemaining = STDERR_REDACTION_COMPARISON_LIMIT
  let redactionBudgetExceeded = false

  const writeLine = (rawLine: string): void => {
    const redacted = redactSensitiveText(rawLine.replace(/\r$/u, ''))
    if (!redacted) return
    const line = truncateUtf8(redacted, STDERR_LINE_LIMIT)
    log.warn('custom MCP server stderr', { serverId: config.id, line })
  }

  const appendRedactedText = (text: string): void => {
    linePending += text
    const lines = linePending.split('\n')
    linePending = lines.pop() ?? ''
    for (const line of lines) writeLine(line)
  }

  const drainKnownValues = (): void => {
    if (knownValues.length === 0) {
      appendRedactedText(redactionPending)
      redactionPending = ''
      heldKnownValuePrefixLength = 0
      return
    }

    let ready = ''
    let cursor = 0
    let emittedStart = 0
    while (cursor < redactionPending.length) {
      const candidates = knownValuesByInitial.get(redactionPending[cursor] ?? '') ?? []
      if (candidates.length === 0) {
        cursor += 1
        continue
      }
      const remaining = redactionPending.slice(cursor)
      let complete: string | undefined
      let mayCompleteLongerValue = false
      for (const value of candidates) {
        const comparedCharacters = Math.min(value.length, remaining.length)
        if (comparedCharacters > redactionComparisonsRemaining) {
          if (ready) appendRedactedText(ready)
          appendRedactedText('[REDACTED]')
          redactionPending = ''
          heldKnownValuePrefixLength = 0
          redactionBudgetExceeded = true
          log.warn('custom MCP server stderr redaction budget exceeded', {
            serverId: config.id,
            limitCharacters: STDERR_REDACTION_COMPARISON_LIMIT
          })
          return
        }
        redactionComparisonsRemaining -= comparedCharacters
        if (value.length > remaining.length) {
          if (value.startsWith(remaining)) mayCompleteLongerValue = true
          continue
        }
        if (remaining.startsWith(value)) {
          complete = value
          break
        }
      }
      if (mayCompleteLongerValue) {
        ready += redactionPending.slice(emittedStart, cursor)
        redactionPending = remaining
        heldKnownValuePrefixLength = remaining.length
        if (ready) appendRedactedText(ready)
        return
      }
      if (
        complete &&
        (heldKnownValuePrefixLength === 0 || complete.length >= heldKnownValuePrefixLength)
      ) {
        ready += `${redactionPending.slice(emittedStart, cursor)}[REDACTED]`
        cursor += complete.length
        emittedStart = cursor
        heldKnownValuePrefixLength = 0
        continue
      }
      if (cursor === 0 && heldKnownValuePrefixLength > 0) {
        ready += '[REDACTED]'
        cursor = heldKnownValuePrefixLength
        emittedStart = cursor
        heldKnownValuePrefixLength = 0
        continue
      }
      cursor += 1
    }
    ready += redactionPending.slice(emittedStart)
    redactionPending = ''
    heldKnownValuePrefixLength = 0
    if (ready) appendRedactedText(ready)
  }

  const flushPending = (): void => {
    drainKnownValues()
    if (redactionPending) {
      appendRedactedText('[REDACTED]')
      redactionPending = ''
      heldKnownValuePrefixLength = 0
    }
    if (linePending) writeLine(linePending)
    linePending = ''
  }

  readable.setEncoding?.('utf8')
  readable.on('data', (chunk: string | Buffer) => {
    if (redactionBudgetExceeded) return
    if (receivedBytes >= STDERR_TOTAL_LIMIT) {
      if (!totalTruncationLogged) {
        totalTruncationLogged = true
        log.warn('custom MCP server stderr truncated', {
          serverId: config.id,
          limitBytes: STDERR_TOTAL_LIMIT
        })
      }
      return
    }
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const remaining = STDERR_TOTAL_LIMIT - receivedBytes
    const accepted = Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8')
    receivedBytes += Buffer.byteLength(accepted, 'utf8')
    redactionPending += accepted
    drainKnownValues()

    if (Buffer.byteLength(text, 'utf8') > remaining && !totalTruncationLogged) {
      flushPending()
      totalTruncationLogged = true
      log.warn('custom MCP server stderr truncated', {
        serverId: config.id,
        limitBytes: STDERR_TOTAL_LIMIT
      })
    }
  })
  readable.on('end', () => {
    flushPending()
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
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        stderr: 'pipe',
        env: augmentedPathEnv({
          ...getDefaultEnvironment(),
          ...config.env
        }) as Record<string, string>
      })
      captureStdioStderr(transport.stderr, config)
      return transport
    }
    case 'streamable_http': {
      if (!config.url) {
        throw new Error(`custom MCP server "${config.name}" is missing a url for streamable_http`)
      }
      assertSecureCustomMcpUrl(config.url)
      const url = new URL(config.url)
      return new StreamableHTTPClientTransport(url, {
        fetch: createCustomMcpFetch(url, config.headers),
        ...(authProvider ? { authProvider } : {})
      })
    }
    case 'sse': {
      if (!config.url) {
        throw new Error(`custom MCP server "${config.name}" is missing a url for sse`)
      }
      assertSecureCustomMcpUrl(config.url)
      const url = new URL(config.url)
      return new SSEClientTransport(url, {
        fetch: createCustomMcpFetch(url, config.headers),
        ...(authProvider ? { authProvider } : {})
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
  private readonly oauthCredentialIds = new Map<string, string>()
  private readonly oauthStateWrites = new Map<string, Promise<void>>()
  private readonly oauthCredentialStateWrites = new Map<string, Promise<void>>()
  private readonly callbackServer = new OAuthCallbackServer()
  private readonly openExternal: (url: string) => Promise<void> | void
  private readonly saveOAuthState?: (
    serverId: string,
    state: StoredCustomMcpOAuthState,
    expectedConfigurationFingerprint?: string,
    expectedOAuthClientSecretRef?: string
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
    await this.closeClientResources(id, true)
  }

  private async closeClientResources(id: string, waitForOAuthStateWrite: boolean): Promise<void> {
    const oauthStateWrite = this.oauthStateWrites.get(id)
    const attempt = this.connecting.get(id)
    this.connecting.delete(id)
    attempt?.controller.abort()
    const cancelAuthentication = this.authenticationCancels.get(id)
    this.authenticationCancels.delete(id)
    this.oauthCredentialIds.delete(id)
    await cancelAuthentication?.()
    const client = this.clients.get(id)
    this.clients.delete(id)
    if (client) await client.close()
    // Disconnect/reconfiguration persists after close returns. Wait for an already-started write so
    // stale OAuth state cannot land after the newer settings mutation.
    if (waitForOAuthStateWrite) await oauthStateWrite?.catch(() => undefined)
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [
        ...new Set([
          ...this.clients.keys(),
          ...this.connecting.keys(),
          ...this.authenticationCancels.keys(),
          ...this.oauthStateWrites.keys()
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
    if (config.oauth.credentialId) {
      this.oauthCredentialIds.set(config.id, config.oauth.credentialId)
    }
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
      if (
        generation === this.generation(config.id) &&
        !this.clients.has(config.id) &&
        this.oauthCredentialIds.get(config.id) === config.oauth.credentialId
      ) {
        this.oauthCredentialIds.delete(config.id)
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
      const credentialId = config.oauth?.credentialId
      if (credentialId) this.oauthCredentialIds.set(config.id, credentialId)
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
            if (
              !this.clients.has(config.id) &&
              this.oauthCredentialIds.get(config.id) === credentialId
            ) {
              this.oauthCredentialIds.delete(config.id)
            }
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
    const credentialId = config.oauth?.credentialId
    if (credentialId) this.oauthCredentialIds.set(config.id, credentialId)
    return new PersistentOAuthClientProvider({
      serverId: config.id,
      redirectUrl,
      config: config.oauth ?? {},
      clientSecret: config.oauth?.clientSecret,
      state: config.oauth?.state,
      ...(interactive ? { openExternal: this.openExternal } : {}),
      saveState: this.saveOAuthState
        ? async (state) => {
            if (generation !== this.generation(config.id)) return
            await this.persistOAuthState(
              config.id,
              generation,
              credentialId,
              state,
              config.configurationFingerprint,
              config.oauthClientSecretRef
            )
          }
        : undefined
    })
  }

  private async persistOAuthState(
    serverId: string,
    generation: number,
    credentialId: string | undefined,
    state: StoredCustomMcpOAuthState,
    configurationFingerprint: string | undefined,
    oauthClientSecretRef: string | undefined
  ): Promise<void> {
    // Shared credentials are one persistence stream even when several connector clients emit
    // state. Keep that stream ordered here so sibling invalidation happens before a queued writer
    // reaches the settings store.
    const previous = credentialId
      ? this.oauthCredentialStateWrites.get(credentialId)
      : this.oauthStateWrites.get(serverId)
    let invalidatedSiblings: string[] = []
    const write = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(
      async () => {
        if (generation !== this.generation(serverId)) return
        if (configurationFingerprint) {
          await this.saveOAuthState!(
            serverId,
            state,
            configurationFingerprint,
            oauthClientSecretRef
          )
        } else {
          await this.saveOAuthState!(serverId, state)
        }
        if (generation !== this.generation(serverId)) return
        if (credentialId) {
          invalidatedSiblings = this.invalidateOAuthSiblingGenerations(credentialId, serverId)
        }
      }
    )
    this.oauthStateWrites.set(serverId, write)
    if (credentialId) this.oauthCredentialStateWrites.set(credentialId, write)
    try {
      await write
    } finally {
      if (this.oauthStateWrites.get(serverId) === write) this.oauthStateWrites.delete(serverId)
      if (credentialId && this.oauthCredentialStateWrites.get(credentialId) === write) {
        this.oauthCredentialStateWrites.delete(credentialId)
      }
    }
    // Their queued writes are serialized behind this write and will fail the generation guard.
    // Do not wait for those writes while cleaning up their clients: that would make cleanup depend
    // on the successor of the write which initiated it.
    await Promise.all(invalidatedSiblings.map((id) => this.closeClientResources(id, false)))
  }

  private invalidateOAuthSiblingGenerations(credentialId: string, ownerId: string): string[] {
    const siblings = [...this.oauthCredentialIds.entries()]
      .filter(([serverId, sharedId]) => serverId !== ownerId && sharedId === credentialId)
      .map(([serverId]) => serverId)
    for (const serverId of siblings) {
      this.generations.set(serverId, this.generation(serverId) + 1)
    }
    return siblings
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
