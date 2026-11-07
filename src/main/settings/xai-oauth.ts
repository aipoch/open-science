import { fetchProviderRequest, readBoundedResponseText } from '@aipoch/providers/transport'
import { isCurrentInFlight } from '../../shared/in-flight-promise'
import type { XaiOAuthDeviceAuthorization } from '../../shared/settings'
import { netFetchStandard } from '../network-fetch'

const OAUTH_REQUEST_TIMEOUT_MS = 15_000
const MAX_OAUTH_RESPONSE_BYTES = 1024 * 1024

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
  completion?: Promise<{ accountEmail?: string }>
}

export type XaiOAuthCredentialStore = {
  load: () => Promise<{ keyRef?: string; refreshToken?: string; accountEmail?: string }>
  // Return the committed keyRef; evaluate isCurrent inside the serialized storage mutation.
  save: (
    expectedKeyRef: string | undefined,
    refreshToken: string,
    accountEmail?: string,
    clearValidation?: boolean,
    isCurrent?: () => boolean
  ) => Promise<string | false>
  clear: () => Promise<void>
}

export type XaiAccessCredential = { token: string; keyRef?: string }

export type XaiOAuthControllerPort = {
  quiesce: () => { settled: Promise<void>; release: () => void }
  beginLogin: () => Promise<XaiOAuthDeviceAuthorization>
  waitForLogin: () => Promise<{ accountEmail?: string }>
  cancelLogin: () => void
  getAccessToken: (forceRefresh?: boolean) => Promise<string>
  getAccessCredential: (forceRefresh?: boolean) => Promise<XaiAccessCredential>
  logout: () => Promise<void>
  dispose: () => Promise<void>
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
    signal.throwIfAborted()
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

async function withOAuthDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
  timeoutMs = OAUTH_REQUEST_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController()
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
  signal.throwIfAborted()
  const timer = setTimeout(
    () => controller.abort(new Error('xAI OAuth request timed out.')),
    timeoutMs
  )
  timer.unref?.()
  try {
    return await work(signal)
  } finally {
    clearTimeout(timer)
  }
}

export class XaiOAuthController implements XaiOAuthControllerPort {
  private readonly fetch: typeof netFetchStandard
  private readonly now: () => number
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private discovery?: Discovery
  private beginAbort?: AbortController
  private pending?: PendingLogin
  private access?: XaiAccessCredential & { expiresAt: number }
  private refreshPromise?: Promise<XaiAccessCredential>
  private refreshGeneration = 0
  private readonly active = new Map<Promise<unknown>, 'login' | 'credential'>()
  private disposed = false
  private admissionHolds = 0
  private disposal?: Promise<void>

  constructor(private readonly options: XaiOAuthControllerOptions) {
    this.fetch = options.fetch ?? netFetchStandard
    this.now = options.now ?? Date.now
    this.wait = options.wait ?? defaultWait
  }

  async beginLogin(): Promise<XaiOAuthDeviceAuthorization> {
    this.assertOpen()
    return this.track(this.beginDeviceLogin(), 'login')
  }

  private async beginDeviceLogin(): Promise<XaiOAuthDeviceAuthorization> {
    this.cancelLogin()
    const beginAbort = new AbortController()
    this.beginAbort = beginAbort
    try {
      const discovery = await this.getDiscovery(beginAbort.signal)
      const { ok, body } = await this.readOAuthJson(discovery.device_authorization_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ client_id: CLIENT_ID, scope: SCOPE }),
        signal: beginAbort.signal
      })
      if (!ok || typeof body.device_code !== 'string' || typeof body.user_code !== 'string') {
        throw new Error('xAI could not start device sign-in.')
      }
      const verificationUri =
        typeof body.verification_uri === 'string'
          ? trustedVerificationUri(body.verification_uri)
          : undefined
      if (!verificationUri) throw new Error('xAI returned an invalid verification address.')
      const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 900
      const interval = typeof body.interval === 'number' ? Math.max(1, body.interval) : 5
      if (!Number.isFinite(expiresIn) || expiresIn <= 0 || !Number.isFinite(interval))
        throw new Error('xAI returned an invalid device-code lifetime.')
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
    this.assertOpen()
    const pending = this.pending
    if (!pending) throw new Error('No xAI sign-in is pending.')
    return (pending.completion ??= this.track(this.completeDeviceLogin(pending), 'login'))
  }

  private async completeDeviceLogin(pending: PendingLogin): Promise<{ accountEmail?: string }> {
    let interval = pending.public.intervalSeconds
    try {
      const discovery = await this.getDiscovery(pending.abort.signal)
      while (this.now() < pending.public.expiresAt) {
        await this.wait(
          Math.min(interval * 1000, pending.public.expiresAt - this.now()),
          pending.abort.signal
        )
        pending.abort.signal.throwIfAborted()
        if (this.now() >= pending.public.expiresAt) break
        const { ok, body } = await this.readOAuthJson(
          discovery.token_endpoint,
          {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: form({
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
              client_id: CLIENT_ID,
              device_code: pending.deviceCode
            }),
            signal: pending.abort.signal
          },
          Math.min(OAUTH_REQUEST_TIMEOUT_MS, pending.public.expiresAt - this.now())
        )
        if (!ok) {
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
        const isCurrent = (): boolean => this.pending === pending && !pending.abort.signal.aborted
        const accountEmail = await this.loadAccountEmail(
          discovery,
          tokens.access_token,
          pending.abort.signal
        )
        if (!isCurrent()) throw new Error('xAI sign-in was cancelled.')
        const saved = await this.options.store.save(
          pending.expectedKeyRef,
          tokens.refresh_token,
          accountEmail,
          true,
          isCurrent
        )
        if (!isCurrent()) throw new Error('xAI sign-in was cancelled.')
        if (!saved) throw new Error('The xAI provider changed while sign-in was pending.')
        this.refreshGeneration += 1
        this.refreshPromise = undefined
        this.cache(tokens, saved)
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
    return (await this.getAccessCredential(forceRefresh)).token
  }

  async getAccessCredential(forceRefresh = false): Promise<XaiAccessCredential> {
    this.assertOpen()
    if (!forceRefresh && this.access && this.access.expiresAt - this.now() > 60_000) {
      return this.access
    }
    if (this.refreshPromise) return this.refreshPromise
    const generation = this.refreshGeneration
    const pending = this.track(this.refreshAccessToken(generation))
    this.refreshPromise = pending
    try {
      return await pending
    } finally {
      if (isCurrentInFlight(this.refreshPromise, pending)) this.refreshPromise = undefined
    }
  }

  async logout(): Promise<void> {
    this.assertOpen()
    this.refreshGeneration += 1
    this.refreshPromise = undefined
    this.cancelLogin()
    this.access = undefined
    await this.track(this.options.store.clear())
  }

  private async refreshAccessToken(generation: number): Promise<XaiAccessCredential> {
    const stored = await this.options.store.load()
    this.assertCurrentRefresh(generation)
    if (!stored.refreshToken) throw new Error('Sign in to xAI (Grok) OAuth to continue.')
    // A caller's cancellation must not discard a token already rotated by the provider.
    const tokens = await withOAuthDeadline(async (signal) => {
      const discovery = await this.getDiscovery(signal)
      this.assertCurrentRefresh(generation)
      const { ok, body } = await this.readOAuthJson(discovery.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({
          grant_type: 'refresh_token',
          client_id: CLIENT_ID,
          refresh_token: stored.refreshToken!
        }),
        signal
      })
      this.assertCurrentRefresh(generation)
      if (!ok) throw new Error('Your xAI sign-in expired. Sign in again.')
      return this.parseTokens(body)
    })
    let keyRef = stored.keyRef
    if (tokens.refresh_token && tokens.refresh_token !== stored.refreshToken) {
      this.assertCurrentRefresh(generation)
      const saved = await this.options.store.save(
        stored.keyRef,
        tokens.refresh_token,
        undefined,
        false,
        () => generation === this.refreshGeneration
      )
      if (!saved) throw new Error('The xAI provider changed while refreshing sign-in.')
      keyRef = saved
    }
    this.assertCurrentRefresh(generation)
    return this.cache(tokens, keyRef)
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.cancelLogin()
    // Refresh promises include the durable write, even if logout replaced refreshPromise.
    this.disposal = Promise.allSettled(this.active.keys()).then(() => {
      this.access = undefined
    })
    return this.disposal
  }

  quiesce(): { settled: Promise<void>; release: () => void } {
    if (this.disposed) throw new Error('xAI authentication is disposed.')
    this.admissionHolds += 1
    this.cancelLogin()
    let released = false
    const active = [...this.active]
    return {
      // Operations include writes; cancellation of a quit must not cancel token rotation.
      settled: Promise.allSettled(active.map(([operation]) => operation)).then((outcomes) => {
        for (const [index, outcome] of outcomes.entries()) {
          // Cancelling interactive sign-in is expected; failed refresh/removal is not a clean drain.
          if (outcome.status === 'rejected' && active[index]![1] === 'credential')
            throw outcome.reason
        }
      }),
      release: () => {
        if (released) return
        released = true
        this.admissionHolds -= 1
      }
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('xAI authentication is disposed.')
    if (this.admissionHolds > 0) throw new Error('xAI authentication is paused for shutdown.')
  }

  private track<T>(operation: Promise<T>, kind: 'login' | 'credential' = 'credential'): Promise<T> {
    this.active.set(operation, kind)
    void operation.then(
      () => this.active.delete(operation),
      () => this.active.delete(operation)
    )
    return operation
  }

  private readOAuthJson(
    url: string,
    init: RequestInit = {},
    timeoutMs = OAUTH_REQUEST_TIMEOUT_MS
  ): Promise<{ ok: boolean; body: Record<string, unknown> }> {
    return withOAuthDeadline(
      async (signal) => {
        const response = await fetchProviderRequest(this.fetch, url, { ...init, signal })
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel()
          throw new Error('xAI OAuth redirects are not supported.')
        }
        let body: unknown
        try {
          body = JSON.parse(
            await readBoundedResponseText(
              response,
              MAX_OAUTH_RESPONSE_BYTES,
              'xAI OAuth response',
              undefined,
              signal
            )
          )
        } catch {
          signal.throwIfAborted()
          throw new Error('xAI returned an invalid OAuth response.')
        }
        signal.throwIfAborted()
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new Error('xAI returned an invalid OAuth response.')
        return { ok: response.ok, body: body as Record<string, unknown> }
      },
      init.signal ?? undefined,
      timeoutMs
    )
  }

  private assertCurrentRefresh(generation: number): void {
    if (generation !== this.refreshGeneration) {
      throw new Error('Sign in to xAI (Grok) OAuth to continue.')
    }
  }

  private async getDiscovery(signal?: AbortSignal): Promise<Discovery> {
    if (this.discovery) return this.discovery
    const { ok, body } = await this.readOAuthJson(`${ISSUER}/.well-known/openid-configuration`, {
      signal
    })
    if (signal?.aborted) throw new Error('xAI sign-in was cancelled.')
    if (
      !ok ||
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

  private cache(tokens: TokenPayload, keyRef: string | undefined): XaiAccessCredential {
    this.access = {
      token: tokens.access_token,
      keyRef,
      expiresAt: this.now() + (tokens.expires_in ?? 3600) * 1000
    }
    return this.access
  }

  private async loadAccountEmail(
    discovery: Discovery,
    accessToken: string,
    signal: AbortSignal
  ): Promise<string | undefined> {
    if (!discovery.userinfo_endpoint) return undefined
    try {
      const { ok, body } = await this.readOAuthJson(
        discovery.userinfo_endpoint,
        {
          headers: { authorization: `Bearer ${accessToken}` },
          signal
        },
        5_000
      )
      if (!ok) return undefined
      return typeof body.email === 'string' ? body.email : undefined
    } catch {
      return undefined
    }
  }
}
