import type { XaiOAuthDeviceAuthorization } from '../../shared/settings'
import { netFetchStandard } from '../skills/net-fetch'

const ISSUER = 'https://auth.x.ai'
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const SCOPE = 'openid profile email offline_access grok-cli:access api:access'

type Discovery = {
  device_authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
}

type TokenPayload = {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

type PendingLogin = {
  deviceCode: string
  expectedKeyRef?: string
  public: XaiOAuthDeviceAuthorization
  abort: AbortController
}

export type XaiOAuthCredentialStore = {
  load: () => Promise<{ keyRef?: string; refreshToken?: string; accountEmail?: string }>
  save: (
    expectedKeyRef: string | undefined,
    refreshToken: string,
    accountEmail?: string,
    clearValidation?: boolean
  ) => Promise<boolean>
  clear: () => Promise<void>
}

export type XaiOAuthControllerPort = {
  beginLogin: () => Promise<XaiOAuthDeviceAuthorization>
  waitForLogin: () => Promise<{ accountEmail?: string }>
  cancelLogin: () => void
  getAccessToken: (forceRefresh?: boolean) => Promise<string>
  logout: () => Promise<void>
}

type XaiOAuthControllerOptions = {
  store: XaiOAuthCredentialStore
  fetch?: typeof netFetchStandard
  now?: () => number
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

const XAI_OAUTH_API_HOSTS = new Set(['auth.x.ai'])
// Device-code user pages are issued by auth.x.ai but hosted on the accounts origin.
const XAI_VERIFICATION_HOSTS = new Set(['auth.x.ai', 'accounts.x.ai'])

const trustedHttpsHost = (value: string, allowedHosts: ReadonlySet<string>): string => {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    !allowedHosts.has(url.hostname.toLowerCase())
  ) {
    throw new Error('xAI returned an untrusted OAuth endpoint.')
  }
  return url.toString()
}

const trustedEndpoint = (value: string): string => trustedHttpsHost(value, XAI_OAUTH_API_HOSTS)

const trustedVerificationUri = (value: string): string =>
  trustedHttpsHost(value, XAI_VERIFICATION_HOSTS)

const form = (values: Record<string, string>): URLSearchParams => new URLSearchParams(values)

const defaultWait = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('xAI sign-in was cancelled.'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })

export class XaiOAuthController implements XaiOAuthControllerPort {
  private readonly fetch: typeof netFetchStandard
  private readonly now: () => number
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private discovery?: Discovery
  private beginAbort?: AbortController
  private pending?: PendingLogin
  private access?: { token: string; expiresAt: number }
  private refreshPromise?: Promise<string>
  private refreshGeneration = 0

  constructor(private readonly options: XaiOAuthControllerOptions) {
    this.fetch = options.fetch ?? netFetchStandard
    this.now = options.now ?? Date.now
    this.wait = options.wait ?? defaultWait
  }

  async beginLogin(): Promise<XaiOAuthDeviceAuthorization> {
    this.cancelLogin()
    const beginAbort = new AbortController()
    this.beginAbort = beginAbort
    try {
      const discovery = await this.getDiscovery(beginAbort.signal)
      const response = await this.fetch(discovery.device_authorization_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ client_id: CLIENT_ID, scope: SCOPE }),
        signal: beginAbort.signal
      })
      const body = (await response.json()) as Record<string, unknown>
      if (
        !response.ok ||
        typeof body.device_code !== 'string' ||
        typeof body.user_code !== 'string'
      ) {
        throw new Error('xAI could not start device sign-in.')
      }
      const verificationUri =
        typeof body.verification_uri === 'string'
          ? trustedVerificationUri(body.verification_uri)
          : undefined
      if (!verificationUri) throw new Error('xAI returned an invalid verification address.')
      const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 900
      const interval = typeof body.interval === 'number' ? Math.max(1, body.interval) : 5
      const stored = await this.options.store.load()
      if (beginAbort.signal.aborted) throw new Error('xAI sign-in was cancelled.')
      const publicSession: XaiOAuthDeviceAuthorization = {
        userCode: body.user_code,
        verificationUri,
        ...(typeof body.verification_uri_complete === 'string'
          ? { verificationUriComplete: trustedVerificationUri(body.verification_uri_complete) }
          : {}),
        expiresAt: this.now() + expiresIn * 1000,
        intervalSeconds: interval
      }
      this.pending = {
        deviceCode: body.device_code,
        expectedKeyRef: stored.keyRef,
        public: publicSession,
        abort: new AbortController()
      }
      return publicSession
    } catch (error) {
      if (beginAbort.signal.aborted) throw new Error('xAI sign-in was cancelled.')
      throw error
    } finally {
      if (this.beginAbort === beginAbort) this.beginAbort = undefined
    }
  }

  async waitForLogin(): Promise<{ accountEmail?: string }> {
    const pending = this.pending
    if (!pending) throw new Error('No xAI sign-in is pending.')
    const discovery = await this.getDiscovery()
    let interval = pending.public.intervalSeconds
    try {
      while (this.now() < pending.public.expiresAt) {
        await this.wait(interval * 1000, pending.abort.signal)
        const response = await this.fetch(discovery.token_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            client_id: CLIENT_ID,
            device_code: pending.deviceCode
          }),
          signal: pending.abort.signal
        })
        const body = (await response.json()) as Record<string, unknown>
        if (!response.ok) {
          if (body.error === 'authorization_pending') continue
          if (body.error === 'slow_down') {
            interval += 5
            continue
          }
          if (body.error === 'access_denied') throw new Error('xAI sign-in was denied.')
          throw new Error('xAI sign-in failed. Please try again.')
        }
        const tokens = this.parseTokens(body)
        if (!tokens.refresh_token) throw new Error('xAI did not return a refresh token.')
        const accountEmail = await this.loadAccountEmail(discovery, tokens.access_token)
        const saved = await this.options.store.save(
          pending.expectedKeyRef,
          tokens.refresh_token,
          accountEmail,
          true
        )
        if (!saved) throw new Error('The xAI provider changed while sign-in was pending.')
        this.cache(tokens)
        return accountEmail ? { accountEmail } : {}
      }
      throw new Error('The xAI device code expired. Start sign-in again.')
    } finally {
      if (this.pending === pending) this.pending = undefined
    }
  }

  cancelLogin(): void {
    this.beginAbort?.abort()
    this.beginAbort = undefined
    this.pending?.abort.abort()
    this.pending = undefined
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.access && this.access.expiresAt - this.now() > 60_000) {
      return this.access.token
    }
    if (this.refreshPromise) return this.refreshPromise
    const generation = this.refreshGeneration
    const pending = this.refreshAccessToken(generation)
    this.refreshPromise = pending
    try {
      return await pending
    } finally {
      if (this.refreshPromise === pending) this.refreshPromise = undefined
    }
  }

  async logout(): Promise<void> {
    this.refreshGeneration += 1
    this.refreshPromise = undefined
    this.cancelLogin()
    this.access = undefined
    await this.options.store.clear()
  }

  private async refreshAccessToken(generation: number): Promise<string> {
    const stored = await this.options.store.load()
    this.assertCurrentRefresh(generation)
    if (!stored.refreshToken) throw new Error('Sign in to xAI (Grok) OAuth to continue.')
    const discovery = await this.getDiscovery()
    this.assertCurrentRefresh(generation)
    const response = await this.fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: stored.refreshToken
      })
    })
    const body = (await response.json()) as Record<string, unknown>
    this.assertCurrentRefresh(generation)
    if (!response.ok) throw new Error('Your xAI sign-in expired. Sign in again.')
    const tokens = this.parseTokens(body)
    if (tokens.refresh_token && tokens.refresh_token !== stored.refreshToken) {
      this.assertCurrentRefresh(generation)
      const saved = await this.options.store.save(stored.keyRef, tokens.refresh_token)
      if (!saved) throw new Error('The xAI provider changed while refreshing sign-in.')
    }
    this.assertCurrentRefresh(generation)
    this.cache(tokens)
    return tokens.access_token
  }

  private assertCurrentRefresh(generation: number): void {
    if (generation !== this.refreshGeneration) {
      throw new Error('Sign in to xAI (Grok) OAuth to continue.')
    }
  }

  private async getDiscovery(signal?: AbortSignal): Promise<Discovery> {
    if (this.discovery) return this.discovery
    const response = await this.fetch(`${ISSUER}/.well-known/openid-configuration`, { signal })
    const body = (await response.json()) as Record<string, unknown>
    if (signal?.aborted) throw new Error('xAI sign-in was cancelled.')
    if (
      !response.ok ||
      body.issuer !== ISSUER ||
      typeof body.device_authorization_endpoint !== 'string' ||
      typeof body.token_endpoint !== 'string'
    ) {
      throw new Error('xAI OAuth discovery failed.')
    }
    this.discovery = {
      device_authorization_endpoint: trustedEndpoint(body.device_authorization_endpoint),
      token_endpoint: trustedEndpoint(body.token_endpoint),
      ...(typeof body.userinfo_endpoint === 'string'
        ? { userinfo_endpoint: trustedEndpoint(body.userinfo_endpoint) }
        : {})
    }
    return this.discovery
  }

  private parseTokens(body: Record<string, unknown>): TokenPayload {
    if (typeof body.access_token !== 'string') throw new Error('xAI returned an invalid token.')
    return {
      access_token: body.access_token,
      ...(typeof body.refresh_token === 'string' ? { refresh_token: body.refresh_token } : {}),
      ...(typeof body.expires_in === 'number' ? { expires_in: body.expires_in } : {})
    }
  }

  private cache(tokens: TokenPayload): void {
    this.access = {
      token: tokens.access_token,
      expiresAt: this.now() + (tokens.expires_in ?? 3600) * 1000
    }
  }

  private async loadAccountEmail(
    discovery: Discovery,
    accessToken: string
  ): Promise<string | undefined> {
    if (!discovery.userinfo_endpoint) return undefined
    try {
      const response = await this.fetch(discovery.userinfo_endpoint, {
        headers: { authorization: `Bearer ${accessToken}` }
      })
      if (!response.ok) return undefined
      const body = (await response.json()) as Record<string, unknown>
      return typeof body.email === 'string' ? body.email : undefined
    } catch {
      return undefined
    }
  }
}
