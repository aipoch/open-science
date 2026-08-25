import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'

import type {
  OAuthClientProvider,
  OAuthDiscoveryState
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'

import type { StoredCustomMcpOAuthConfig, StoredCustomMcpOAuthState } from '../settings/types'
import {
  DEFAULT_LOOPBACK_OAUTH_REDIRECT_URI,
  normalizeLoopbackOAuthRedirectUri
} from '../../shared/oauth-redirect'

export type OAuthCallback = {
  code?: string
  error?: string
  state?: string
}

type PendingCallback = {
  resolve: (value: OAuthCallback) => void
  reject: (error: Error) => void
}

const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000
const DEFAULT_OAUTH_CALLBACK_PATH = new URL(DEFAULT_LOOPBACK_OAUTH_REDIRECT_URI).pathname

// One loopback listener is shared by all custom MCP OAuth logins. The callback state is matched to
// the pending flow before handing the authorization code back to the caller.
export class OAuthCallbackServer {
  private server: Server | undefined
  private redirectUrl: string | undefined
  private starting: Promise<string> | undefined
  private readonly pending = new Map<string, PendingCallback>()
  private readonly callbackPaths = new Set([DEFAULT_OAUTH_CALLBACK_PATH])

  async ensureStarted(registeredRedirectUri?: string): Promise<string> {
    if (this.redirectUrl) return this.runtimeRedirectUrl(registeredRedirectUri)

    const starting = this.starting ?? this.start()
    this.starting = starting
    try {
      await starting
      return this.runtimeRedirectUrl(registeredRedirectUri)
    } finally {
      if (this.starting === starting) this.starting = undefined
    }
  }

  private runtimeRedirectUrl(registeredRedirectUri?: string): string {
    if (!this.redirectUrl) throw new Error('OAuth callback server did not start')
    if (!registeredRedirectUri) return this.redirectUrl

    const registered = new URL(normalizeLoopbackOAuthRedirectUri(registeredRedirectUri))
    const runtime = new URL(this.redirectUrl)
    registered.port = runtime.port
    this.callbackPaths.add(registered.pathname)
    return registered.toString()
  }

  private async start(): Promise<string> {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (!this.callbackPaths.has(url.pathname)) {
        response.writeHead(404)
        response.end('Not found')
        return
      }

      const state = url.searchParams.get('state') ?? ''
      const pending = this.pending.get(state)
      if (!pending) {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<h1>Open Science authorization expired</h1><p>You can close this window.</p>')
        return
      }

      this.pending.delete(state)
      const error = url.searchParams.get('error') ?? undefined
      const code = url.searchParams.get('code') ?? undefined
      response.writeHead(error ? 400 : 200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        error
          ? '<h1>Authorization failed</h1><p>You can close this window.</p>'
          : '<h1>Authorization complete</h1><p>You can close this window.</p>'
      )
      pending.resolve({ code, error, state })
    })

    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('OAuth callback server did not bind')
    this.redirectUrl = `http://127.0.0.1:${address.port}${DEFAULT_OAUTH_CALLBACK_PATH}`
    return this.redirectUrl
  }

  waitFor(
    state: string,
    timeoutMs = OAUTH_CALLBACK_TIMEOUT_MS
  ): { promise: Promise<OAuthCallback>; cancel: () => void } {
    let cancelled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const promise = new Promise<OAuthCallback>((resolve, reject) => {
      const clear = (): void => {
        if (timeout) clearTimeout(timeout)
      }
      this.pending.set(state, {
        resolve: (value) => {
          clear()
          resolve(value)
        },
        reject: (error) => {
          clear()
          reject(error)
        }
      })
      timeout = setTimeout(() => {
        this.pending.delete(state)
        reject(new Error('OAuth authorization timed out. Try Sign in again.'))
      }, timeoutMs)
    })
    return {
      promise,
      cancel: () => {
        if (cancelled) return
        cancelled = true
        if (timeout) clearTimeout(timeout)
        const pending = this.pending.get(state)
        this.pending.delete(state)
        pending?.resolve({ error: 'authorization_cancelled', state })
      }
    }
  }

  async close(): Promise<void> {
    for (const entry of this.pending.values())
      entry.reject(new Error('OAuth callback server closed'))
    this.pending.clear()
    const server = this.server
    this.server = undefined
    this.redirectUrl = undefined
    this.callbackPaths.clear()
    this.callbackPaths.add(DEFAULT_OAUTH_CALLBACK_PATH)
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

export type OAuthClientProviderOptions = {
  serverId: string
  redirectUrl: string
  config: StoredCustomMcpOAuthConfig
  clientSecret?: string
  state?: StoredCustomMcpOAuthState
  saveState?: (state: StoredCustomMcpOAuthState) => Promise<void>
  openExternal?: (url: string) => Promise<void> | void
}

// Persistent provider backed by the app's encrypted state callback. The SDK owns discovery, PKCE,
// dynamic registration, token exchange, and refresh; this class only supplies storage and browser IO.
export class PersistentOAuthClientProvider implements OAuthClientProvider {
  private readonly oauthState: StoredCustomMcpOAuthState
  private readonly oauthStateId: string
  private readonly saveState?: (state: StoredCustomMcpOAuthState) => Promise<void>
  private readonly openExternal?: (url: string) => Promise<void> | void
  private codeVerifierValue: string | undefined
  private readonly stateValue = randomUUID()

  constructor(private readonly options: OAuthClientProviderOptions) {
    if (options.config.clientId && !options.config.authorizationServerUrl) {
      throw new Error('Authorization server URL is required for a pre-registered client.')
    }
    if (options.clientSecret && !options.config.clientId) {
      throw new Error('Client ID is required when a client secret is configured.')
    }
    this.oauthState = { ...(options.state ?? {}) }
    this.oauthStateId = options.serverId
    this.saveState = options.saveState
    this.openExternal = options.openExternal
  }

  get redirectUrl(): string {
    return this.options.redirectUrl
  }

  get clientMetadataUrl(): string | undefined {
    return this.options.config.clientMetadataUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Open Science',
      redirect_uris: [this.options.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // This metadata is used only for CIMD/DCR. For a pre-registered client the SDK selects the
      // token-endpoint auth method from its client information and the authorization-server metadata.
      token_endpoint_auth_method: 'none',
      ...(this.options.config.scopes?.length ? { scope: this.options.config.scopes.join(' ') } : {})
    }
  }

  state(): string {
    return this.stateValue
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    // If pre-registered client credentials are configured, use them directly.
    // This bypasses both URL-based client IDs (SEP-991) and dynamic client registration (RFC 7591).
    if (this.options.config.clientId) {
      return {
        client_id: this.options.config.clientId,
        ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {})
      }
    }

    const clientInformation = this.oauthState.clientInformation
    if (
      clientInformation &&
      'redirect_uris' in clientInformation &&
      !clientInformation.redirect_uris.includes(this.options.redirectUrl)
    ) {
      // auth() reads client information only after the current request was rejected. A dynamic
      // registration and its refresh token cannot safely cross client IDs, so replace both.
      delete this.oauthState.clientInformation
      delete this.oauthState.tokens
      await this.persist()
      return undefined
    }
    return clientInformation
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    this.oauthState.clientInformation = clientInformation
    await this.persist()
  }

  tokens(): OAuthTokens | undefined {
    return this.oauthState.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.oauthState.tokens = tokens
    await this.persist()
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // The SDK only redirects after the current token cannot authorize the connection. Clear that
    // proven-stale token before opening the browser so a fast Cancel cannot preserve it by racing
    // the manager's generation guard. A valid token never reaches this method.
    if (this.oauthState.tokens) {
      delete this.oauthState.tokens
      await this.persist()
    }
    const hostname = authorizationUrl.hostname
    if (
      authorizationUrl.protocol !== 'https:' &&
      !(
        authorizationUrl.protocol === 'http:' &&
        ((isIP(hostname) === 4 && hostname.startsWith('127.')) || hostname === '[::1]')
      )
    ) {
      throw new Error('OAuth authorization URL must use HTTPS or loopback HTTP.')
    }
    if (!this.openExternal) {
      throw new Error('OAuth authentication required. Sign in from Settings > Connectors.')
    }
    await this.openExternal(authorizationUrl.toString())
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.codeVerifierValue = codeVerifier
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue)
      throw new Error(`OAuth code verifier is missing for ${this.oauthStateId}`)
    return this.codeVerifierValue
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.assertStaticClientIssuer(state)
    this.oauthState.discoveryState = state
    await this.persist()
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    const state =
      this.oauthState.discoveryState ??
      (this.options.config.authorizationServerUrl
        ? { authorizationServerUrl: this.options.config.authorizationServerUrl }
        : undefined)
    if (state) this.assertStaticClientIssuer(state)
    return state
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'
  ): Promise<void> {
    if (scope === 'all' || scope === 'client') delete this.oauthState.clientInformation
    if (scope === 'all' || scope === 'tokens') delete this.oauthState.tokens
    if (scope === 'all' || scope === 'discovery') delete this.oauthState.discoveryState
    if (scope === 'all' || scope === 'verifier') this.codeVerifierValue = undefined
    await this.persist()
  }

  private persist(): Promise<void> {
    return this.saveState?.({ ...this.oauthState }) ?? Promise.resolve()
  }

  private assertStaticClientIssuer(state: OAuthDiscoveryState): void {
    const configuredIssuer = this.options.config.clientId
      ? this.options.config.authorizationServerUrl
      : undefined
    if (!configuredIssuer) return

    const expected = new URL(configuredIssuer).toString()
    const discovered = [
      state.authorizationServerUrl,
      state.authorizationServerMetadata?.issuer
    ].filter((value): value is string => Boolean(value))
    if (discovered.some((value) => new URL(value).toString() !== expected)) {
      throw new Error(
        'Discovered authorization server does not match the pre-registered client issuer'
      )
    }
  }
}
