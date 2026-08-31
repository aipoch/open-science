import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type {
  RemotePairingDecision,
  RemotePairingRequestView,
  TrustedRemoteBrowserView
} from '../../shared/remote-access'
import type {
  ExternalWebAccess,
  ExternalWebAccessAuthorization,
  ExternalWebAccessDecision
} from '../web-service/http-server'
import { REMOTE_PAIR_STATUS_PATH, renderPairingPage } from './pairing-page'
import {
  defaultRemoteAccessState,
  RemoteAccessRepository,
  TRUSTED_BROWSER_TTL_MS,
  type StoredRemoteAccess,
  type StoredTrustedBrowser
} from './repository'

const PAIRING_COOKIE = 'open_science_remote_pairing'
const SESSION_COOKIE = 'open_science_remote_session'
const PAIRING_TTL_MS = 10 * 60 * 1_000
const PAIRING_IDLE_TTL_MS = 30_000
const PAIRING_RATE_WINDOW_MS = 10 * 60 * 1_000
const ONE_TIME_SESSION_TTL_MS = 12 * 60 * 60 * 1_000
const MAX_PENDING_REQUESTS = 20
const MAX_PAIRING_REQUESTS_PER_SOURCE = 3
const MAX_PAIRING_REQUESTS_PER_WINDOW = 40
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000
const MAX_TIMER_DELAY_MS = 2_147_483_647
const CLEANUP_RETRY_MS = 1_000

type BrowserDescription = { browser: string; platform: string }

type PairingGrant = {
  decision: RemotePairingDecision
  sessionId: string
  cookieValue: string
}

type PendingPairing = BrowserDescription & {
  id: string
  secretHash: string
  code: string
  address?: string
  requestedAt: number
  expiresAt: number
  lastPolledAt?: number
  status: 'pending' | 'approving' | 'approved' | 'rejected'
  grant?: PairingGrant
}

type OneTimeSession = {
  tokenHash: string
  expiresAt: number
}

type RemoteSessionAccess =
  ({ kind: 'once'; sessionId: string } | { kind: 'trusted'; sessionId: string }) | undefined

type PairingManagerOptions = {
  repository: RemoteAccessRepository
  isAllowedRemoteHost: (hostname: string) => boolean
  isEnabled: () => boolean
  authorizationGeneration?: () => number
  onChanged: () => void
  onAuthorizationExpired?: (principalId: string) => void
  now?: () => number
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

const safeHashEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

const readCookies = (request: IncomingMessage): Map<string, string> => {
  const result = new Map<string, string>()
  for (const part of request.headers.cookie?.split(';') ?? []) {
    const [name, ...rawValue] = part.trim().split('=')
    if (!name) continue
    try {
      result.set(name, decodeURIComponent(rawValue.join('=')))
    } catch {
      // Ignore malformed cookies; they are treated as absent.
    }
  }
  return result
}

const sessionCookie = (value: string, persistent: boolean): string =>
  `${SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=${persistent ? 'Lax' : 'Strict'}; Path=/${
    persistent ? `; Max-Age=${TRUSTED_BROWSER_TTL_MS / 1_000}` : ''
  }`

const pairingCookie = (value: string): string =>
  `${PAIRING_COOKIE}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${
    PAIRING_TTL_MS / 1_000
  }`

const clearCookie = (name: string): string =>
  `${name}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`

const normalizeHost = (host: string | undefined): string | undefined => {
  if (!host) return undefined
  try {
    return new URL(`https://${host}`).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

const describeBrowser = (userAgent: string | undefined): BrowserDescription => {
  const value = userAgent ?? ''
  const browser = /Edg\//i.test(value)
    ? 'Microsoft Edge'
    : /CriOS\//i.test(value)
      ? 'Chrome on iOS'
      : /Chrome\//i.test(value)
        ? 'Google Chrome'
        : /FxiOS\//i.test(value)
          ? 'Firefox on iOS'
          : /Firefox\//i.test(value)
            ? 'Mozilla Firefox'
            : /Safari\//i.test(value)
              ? 'Safari'
              : 'Unknown browser'
  const platform = /HarmonyOS|OpenHarmony/i.test(value)
    ? 'HarmonyOS'
    : /Android/i.test(value)
      ? 'Android'
      : /iPhone|iPad|iPod/i.test(value)
        ? 'iOS/iPadOS'
        : /Windows/i.test(value)
          ? 'Windows'
          : /Macintosh|Mac OS X/i.test(value)
            ? 'macOS'
            : /Linux/i.test(value)
              ? 'Linux'
              : 'Unknown platform'
  return { browser, platform }
}

const clientAddress = (request: IncomingMessage): string | undefined => {
  const forwarded = request.headers['x-forwarded-for']
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
  return first || request.socket.remoteAddress || undefined
}

const json = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  response.end(JSON.stringify(value))
}

export class RemoteSessionPairingManager {
  private stored: StoredRemoteAccess
  private readonly pending = new Map<string, PendingPairing>()
  private readonly oneTimeSessions = new Map<string, OneTimeSession>()
  private readonly pendingRevocations = new Set<string>()
  private readonly unclaimedTrustedBrowserCleanup = new Set<string>()
  private readonly pairingAdmissions: number[] = []
  private readonly pairingAdmissionsBySource = new Map<string, number[]>()
  private readonly now: () => number
  private storedMutationQueue: Promise<void> = Promise.resolve()
  private unclaimedTrustedBrowserCleanupTask: Promise<void> | undefined
  private expirationTimer: ReturnType<typeof setTimeout> | undefined
  private authorizationGeneration = 0
  private disposed = false

  private constructor(
    private readonly options: PairingManagerOptions,
    stored: StoredRemoteAccess
  ) {
    this.stored = stored
    this.now = options.now ?? Date.now
    this.scheduleExpirationTimer()
  }

  static async create(options: PairingManagerOptions): Promise<RemoteSessionPairingManager> {
    return new RemoteSessionPairingManager(options, await options.repository.load())
  }

  static createUnavailable(options: PairingManagerOptions): RemoteSessionPairingManager {
    return new RemoteSessionPairingManager(options, defaultRemoteAccessState())
  }

  get preferences(): Pick<
    StoredRemoteAccess,
    'mode' | 'remoteItAppServiceId' | 'remoteItBrowserServiceId' | 'remoteItPublicUrl'
  > {
    return {
      mode: this.stored.mode,
      remoteItAppServiceId: this.stored.remoteItAppServiceId,
      remoteItBrowserServiceId: this.stored.remoteItBrowserServiceId,
      remoteItPublicUrl: this.stored.remoteItPublicUrl
    }
  }

  async setModePreference(mode: StoredRemoteAccess['mode']): Promise<void> {
    await this.commitStoredMutation((stored) => ({ ...stored, mode }))
  }

  async setRemoteItServiceId(
    mode: Extract<StoredRemoteAccess['mode'], 'remoteit' | 'remoteit-public'>,
    serviceId: string | undefined
  ): Promise<void> {
    await this.setRemoteItServiceIds(
      mode === 'remoteit' ? { appServiceId: serviceId } : { browserServiceId: serviceId }
    )
  }

  async setRemoteItServiceIds(services: {
    appServiceId?: string
    browserServiceId?: string
  }): Promise<void> {
    await this.commitStoredMutation((stored) => {
      const remoteItAppServiceId = services.appServiceId ?? stored.remoteItAppServiceId
      const remoteItBrowserServiceId = services.browserServiceId ?? stored.remoteItBrowserServiceId
      if (
        remoteItAppServiceId === stored.remoteItAppServiceId &&
        remoteItBrowserServiceId === stored.remoteItBrowserServiceId
      ) {
        return undefined
      }
      return {
        ...stored,
        remoteItAppServiceId,
        remoteItBrowserServiceId
      }
    })
  }

  async setRemoteItPublicUrl(url: string | undefined): Promise<void> {
    await this.commitStoredMutation((stored) => ({ ...stored, remoteItPublicUrl: url }))
  }

  pendingViews(): RemotePairingRequestView[] {
    this.pruneExpired()
    return [...this.pending.values()]
      .filter((request) => request.status === 'pending')
      .sort((a, b) => a.requestedAt - b.requestedAt)
      .map(({ id, code, browser, platform, address, requestedAt, expiresAt }) => ({
        id,
        code,
        browser,
        platform,
        address,
        requestedAt,
        expiresAt
      }))
  }

  trustedViews(): TrustedRemoteBrowserView[] {
    // Snapshot reads should not start persistence work; the cleanup timer retries failed cleanup.
    this.pruneExpired(false)
    return [...this.stored.trustedBrowsers]
      .filter((browser) => !this.unclaimedTrustedBrowserCleanup.has(browser.id))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map(({ id, browser, platform, createdAt, lastSeenAt, expiresAt }) => ({
        id,
        browser,
        platform,
        createdAt,
        lastSeenAt,
        expiresAt
      }))
  }

  async approve(requestId: string, decision: RemotePairingDecision): Promise<void> {
    if (decision !== 'once' && decision !== 'always') {
      throw new Error('Pairing decision must be once or always.')
    }
    this.pruneExpired()
    const request = this.pending.get(requestId)
    if (!request || request.status !== 'pending') {
      throw new Error('This pairing request has expired or is no longer pending.')
    }

    const sessionId = randomUUID()
    const secret = randomBytes(32).toString('base64url')
    const cookieValue = `${sessionId}.${secret}`
    const authorizationGeneration = this.authorizationGeneration
    request.status = 'approving'
    request.grant = { decision, sessionId, cookieValue }

    try {
      if (decision === 'once') {
        this.oneTimeSessions.set(sessionId, {
          tokenHash: hash(secret),
          expiresAt: this.now() + ONE_TIME_SESSION_TTL_MS
        })
      } else {
        const createdAt = this.now()
        const trusted: StoredTrustedBrowser = {
          id: sessionId,
          browser: request.browser,
          platform: request.platform,
          tokenHash: hash(secret),
          createdAt,
          lastSeenAt: createdAt,
          expiresAt: createdAt + TRUSTED_BROWSER_TTL_MS
        }
        await this.commitStoredMutation((stored) => ({
          ...stored,
          trustedBrowsers: [...stored.trustedBrowsers, trusted]
        }))
      }

      if (
        authorizationGeneration !== this.authorizationGeneration ||
        this.pending.get(requestId) !== request
      ) {
        if (decision === 'once') this.oneTimeSessions.delete(sessionId)
        else await this.cleanupUnclaimedTrustedBrowsers([sessionId])
        throw new Error('This pairing request has expired or is no longer pending.')
      }

      request.status = 'approved'
      this.scheduleExpirationTimer()
      this.options.onChanged()
    } catch (error) {
      if (
        authorizationGeneration === this.authorizationGeneration &&
        this.pending.get(requestId) === request
      ) {
        request.status = 'pending'
        request.grant = undefined
      }
      throw error
    }
  }

  reject(requestId: string): void {
    this.pruneExpired()
    const request = this.pending.get(requestId)
    if (!request || request.status !== 'pending') {
      throw new Error('This pairing request has expired or is no longer pending.')
    }
    request.status = 'rejected'
    this.options.onChanged()
  }

  async revoke(browserId: string): Promise<void> {
    if (
      this.pendingRevocations.has(browserId) ||
      !this.stored.trustedBrowsers.some((browser) => browser.id === browserId)
    ) {
      throw new Error('Trusted browser not found.')
    }
    this.pendingRevocations.add(browserId)
    try {
      await this.commitStoredMutation((stored) => {
        const trustedBrowsers = stored.trustedBrowsers.filter((browser) => browser.id !== browserId)
        if (trustedBrowsers.length === stored.trustedBrowsers.length) {
          throw new Error('Trusted browser not found.')
        }
        return { ...stored, trustedBrowsers }
      })
      this.scheduleExpirationTimer()
      this.options.onChanged()
    } finally {
      this.pendingRevocations.delete(browserId)
    }
  }

  async clearTransientAccess(): Promise<void> {
    this.authorizationGeneration += 1
    const unclaimedTrustedBrowsers = new Set(
      [...this.pending.values()].flatMap((request) =>
        request.grant?.decision === 'always' ? [request.grant.sessionId] : []
      )
    )
    this.pending.clear()
    this.oneTimeSessions.clear()
    this.scheduleExpirationTimer()
    this.options.onChanged()
    const changed = await this.cleanupUnclaimedTrustedBrowsers(unclaimedTrustedBrowsers)
    this.scheduleExpirationTimer()
    if (changed) this.options.onChanged()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.expirationTimer) clearTimeout(this.expirationTimer)
    this.expirationTimer = undefined
  }

  readonly webAccess: ExternalWebAccess = {
    authorizeHttp: (request, response, url) => this.authorizeHttp(request, response, url),
    authorizeWebSocket: (request, url) => this.authorizeWebSocket(request, url)
  }

  private isExpectedRemoteRequest(request: IncomingMessage, requireOrigin: boolean): boolean {
    if (!this.options.isEnabled()) return false
    const remoteHost = normalizeHost(request.headers.host)
    if (!remoteHost || !this.options.isAllowedRemoteHost(remoteHost)) return false

    const origin = request.headers.origin
    if (!origin) return !requireOrigin
    try {
      const parsed = new URL(origin)
      return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === remoteHost
    } catch {
      return false
    }
  }

  private async authorizeHttp(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ): Promise<ExternalWebAccessDecision> {
    const authorizationGeneration = this.options.authorizationGeneration?.() ?? 0
    const needsOrigin = request.method !== 'GET' && request.method !== 'HEAD'
    // Provider hosts identify an expected route but are forgeable by local callers. Only the
    // unguessable Open Science session checked below authenticates external workspace access.
    if (!this.isExpectedRemoteRequest(request, needsOrigin)) return 'denied'
    const sessionAccess = await this.getSessionAccess(request)
    if (
      authorizationGeneration !== (this.options.authorizationGeneration?.() ?? 0) ||
      !this.isExpectedRemoteRequest(request, needsOrigin)
    ) {
      return 'denied'
    }
    if (sessionAccess) {
      return this.httpAuthorization(request, needsOrigin, authorizationGeneration, sessionAccess)
    }

    if (url.pathname === REMOTE_PAIR_STATUS_PATH && request.method === 'GET') {
      await this.handlePairingStatus(request, response)
      return 'handled'
    }
    if (request.method !== 'GET' || url.pathname !== '/') return 'denied'

    const admission = this.ensurePending(request, response)
    if ('retryAt' in admission) {
      response.setHeader(
        'retry-after',
        String(Math.max(1, Math.ceil((admission.retryAt - this.now()) / 1_000)))
      )
      json(response, 429, { error: 'Too many pairing requests. Try again later.' })
      return 'handled'
    }
    const pending = admission.pending
    const page = renderPairingPage(pending)
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${page.nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    })
    response.end(page.html)
    return 'handled'
  }

  private httpAuthorization(
    request: IncomingMessage,
    needsOrigin: boolean,
    authorizationGeneration: number,
    sessionAccess: Exclude<RemoteSessionAccess, undefined>
  ): ExternalWebAccessAuthorization {
    return {
      kind: sessionAccess.kind === 'trusted' ? 'authorized-pairing-manager' : 'authorized',
      principalId: sessionAccess.sessionId,
      isCurrent: () =>
        authorizationGeneration === (this.options.authorizationGeneration?.() ?? 0) &&
        this.isExpectedRemoteRequest(request, needsOrigin) &&
        this.isSessionAccessCurrent(sessionAccess)
    }
  }

  private async authorizeWebSocket(
    request: IncomingMessage,
    url: URL
  ): ReturnType<ExternalWebAccess['authorizeWebSocket']> {
    const authorizationGeneration = this.options.authorizationGeneration?.() ?? 0
    const pairingAuthorizationGeneration = this.authorizationGeneration
    if (
      !['/events', '/api/v1/events'].includes(url.pathname) ||
      !this.isExpectedRemoteRequest(request, true)
    ) {
      return undefined
    }
    const sessionAccess = await this.getSessionAccess(request)
    if (
      authorizationGeneration !== (this.options.authorizationGeneration?.() ?? 0) ||
      pairingAuthorizationGeneration !== this.authorizationGeneration ||
      !this.isExpectedRemoteRequest(request, true)
    ) {
      return undefined
    }
    return sessionAccess
      ? {
          principalId: sessionAccess.sessionId,
          isCurrent: () =>
            authorizationGeneration === (this.options.authorizationGeneration?.() ?? 0) &&
            pairingAuthorizationGeneration === this.authorizationGeneration &&
            this.isExpectedRemoteRequest(request, true) &&
            this.isSessionAccessCurrent(sessionAccess)
        }
      : undefined
  }

  private isSessionAccessCurrent(access: Exclude<RemoteSessionAccess, undefined>): boolean {
    const now = this.now()
    if (access.kind === 'once') {
      const session = this.oneTimeSessions.get(access.sessionId)
      return Boolean(session && session.expiresAt > now)
    }
    if (
      this.pendingRevocations.has(access.sessionId) ||
      this.unclaimedTrustedBrowserCleanup.has(access.sessionId)
    ) {
      return false
    }
    const browser = this.stored.trustedBrowsers.find(({ id }) => id === access.sessionId)
    return Boolean(browser && browser.expiresAt > now)
  }

  private ensurePending(
    request: IncomingMessage,
    response: ServerResponse
  ): { pending: PendingPairing } | { retryAt: number } {
    this.pruneExpired()
    const existing = this.readPendingCookie(request)
    if (existing) return { pending: existing }

    const requestedAt = this.now()
    const address = clientAddress(request) ?? '<unknown>'
    const retryAt = this.pairingAdmissionRetryAt(address, requestedAt)
    if (retryAt !== undefined) return { retryAt }

    const id = randomUUID()
    const secret = randomBytes(24).toString('base64url')
    const description = describeBrowser(request.headers['user-agent'])
    const pending: PendingPairing = {
      id,
      secretHash: hash(secret),
      code: randomInt(0, 1_000_000).toString().padStart(6, '0'),
      ...description,
      address: address === '<unknown>' ? undefined : address,
      requestedAt,
      expiresAt: requestedAt + PAIRING_TTL_MS,
      status: 'pending'
    }
    this.pending.set(id, pending)
    this.pairingAdmissions.push(requestedAt)
    const sourceAdmissions = this.pairingAdmissionsBySource.get(address) ?? []
    sourceAdmissions.push(requestedAt)
    this.pairingAdmissionsBySource.set(address, sourceAdmissions)
    this.scheduleExpirationTimer()
    response.setHeader('set-cookie', pairingCookie(`${id}.${secret}`))
    this.options.onChanged()
    return { pending }
  }

  private pairingAdmissionRetryAt(address: string, now: number): number | undefined {
    const cutoff = now - PAIRING_RATE_WINDOW_MS
    while (this.pairingAdmissions[0] !== undefined && this.pairingAdmissions[0] <= cutoff) {
      this.pairingAdmissions.shift()
    }
    for (const [source, admissions] of this.pairingAdmissionsBySource) {
      while (admissions[0] !== undefined && admissions[0] <= cutoff) admissions.shift()
      if (admissions.length === 0) this.pairingAdmissionsBySource.delete(source)
    }

    const retryDeadlines: number[] = []
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      retryDeadlines.push(
        Math.min(...[...this.pending.values()].map((entry) => this.pendingExpiration(entry)))
      )
    }
    if (this.pairingAdmissions.length >= MAX_PAIRING_REQUESTS_PER_WINDOW) {
      retryDeadlines.push(this.pairingAdmissions[0] + PAIRING_RATE_WINDOW_MS)
    }
    const sourceAdmissions = this.pairingAdmissionsBySource.get(address) ?? []
    if (sourceAdmissions.length >= MAX_PAIRING_REQUESTS_PER_SOURCE) {
      retryDeadlines.push(sourceAdmissions[0] + PAIRING_RATE_WINDOW_MS)
    }
    return retryDeadlines.length === 0 ? undefined : Math.max(...retryDeadlines)
  }

  private pendingExpiration(request: PendingPairing): number {
    if (request.status !== 'pending') return request.expiresAt
    return Math.min(
      request.expiresAt,
      (request.lastPolledAt ?? request.requestedAt) + PAIRING_IDLE_TTL_MS
    )
  }

  private readPendingCookie(request: IncomingMessage): PendingPairing | undefined {
    const value = readCookies(request).get(PAIRING_COOKIE)
    if (!value) return undefined
    const separator = value.indexOf('.')
    if (separator <= 0) return undefined
    const id = value.slice(0, separator)
    const secret = value.slice(separator + 1)
    const pending = this.pending.get(id)
    if (!pending || pending.expiresAt <= this.now()) return undefined
    return safeHashEqual(pending.secretHash, hash(secret)) ? pending : undefined
  }

  private async handlePairingStatus(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const pending = this.readPendingCookie(request)
    if (!pending) {
      response.setHeader('set-cookie', clearCookie(PAIRING_COOKIE))
      json(response, 200, { status: 'expired' })
      return
    }
    if (pending.status === 'pending' || pending.status === 'approving') {
      if (pending.status === 'pending') {
        pending.lastPolledAt = this.now()
        this.scheduleExpirationTimer()
      }
      json(response, 200, { status: 'pending', expiresAt: pending.expiresAt })
      return
    }
    if (pending.status === 'rejected' || !pending.grant) {
      this.pending.delete(pending.id)
      this.scheduleExpirationTimer()
      response.setHeader('set-cookie', clearCookie(PAIRING_COOKIE))
      json(response, 200, { status: 'rejected' })
      return
    }

    response.setHeader('set-cookie', [
      sessionCookie(pending.grant.cookieValue, pending.grant.decision === 'always'),
      clearCookie(PAIRING_COOKIE)
    ])
    this.pending.delete(pending.id)
    this.scheduleExpirationTimer()
    json(response, 200, { status: 'approved' })
  }

  private async getSessionAccess(request: IncomingMessage): Promise<RemoteSessionAccess> {
    this.pruneExpired()
    const value = readCookies(request).get(SESSION_COOKIE)
    if (!value) return undefined
    const separator = value.indexOf('.')
    if (separator <= 0) return undefined
    const id = value.slice(0, separator)
    const tokenHash = hash(value.slice(separator + 1))

    const once = this.oneTimeSessions.get(id)
    if (once && once.expiresAt > this.now() && safeHashEqual(once.tokenHash, tokenHash)) {
      return { kind: 'once', sessionId: id }
    }
    if (this.pendingRevocations.has(id)) return undefined

    const trusted = this.stored.trustedBrowsers.find((browser) => browser.id === id)
    if (!trusted) return undefined
    if (this.unclaimedTrustedBrowserCleanup.has(id)) return undefined
    if (trusted.expiresAt <= this.now()) {
      const changed = await this.removeStoredTrustedBrowsers(new Set([id]))
      this.scheduleExpirationTimer()
      if (changed) this.options.onChanged()
      return undefined
    }
    if (!safeHashEqual(trusted.tokenHash, tokenHash)) return undefined
    if (this.now() - trusted.lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
      let authorized = false
      let expired = false
      let authorizedExpiresAt: number | undefined
      let changed = await this.commitStoredMutation((stored) => {
        const current = stored.trustedBrowsers.find((browser) => browser.id === id)
        if (!current || !safeHashEqual(current.tokenHash, tokenHash)) return undefined
        const lastSeenAt = this.now()
        if (current.expiresAt <= lastSeenAt) {
          expired = true
          return {
            ...stored,
            trustedBrowsers: stored.trustedBrowsers.filter((browser) => browser.id !== id)
          }
        }
        authorized = true
        authorizedExpiresAt = current.expiresAt
        if (lastSeenAt - current.lastSeenAt < LAST_SEEN_WRITE_INTERVAL_MS) return undefined
        return {
          ...stored,
          trustedBrowsers: stored.trustedBrowsers.map((browser) =>
            browser.id === id ? { ...browser, lastSeenAt } : browser
          )
        }
      })
      if (authorizedExpiresAt !== undefined && authorizedExpiresAt <= this.now()) {
        authorized = false
        expired = true
        changed = (await this.removeStoredTrustedBrowsers(new Set([id]))) || changed
      }
      if (expired) this.scheduleExpirationTimer()
      if (changed) this.options.onChanged()
      if (!authorized) return undefined
    }
    return { kind: 'trusted', sessionId: id }
  }

  private commitStoredMutation(
    update: (stored: StoredRemoteAccess) => StoredRemoteAccess | undefined
  ): Promise<boolean> {
    const operation = this.storedMutationQueue.then(async () => {
      const stored = update(this.stored)
      if (!stored) return false
      await this.options.repository.save(stored)
      this.stored = stored
      return true
    })
    this.storedMutationQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private removeStoredTrustedBrowsers(browserIds: Set<string>): Promise<boolean> {
    return this.commitStoredMutation((stored) => {
      const trustedBrowsers = stored.trustedBrowsers.filter(
        (browser) => !browserIds.has(browser.id)
      )
      return trustedBrowsers.length === stored.trustedBrowsers.length
        ? undefined
        : { ...stored, trustedBrowsers }
    })
  }

  private async cleanupUnclaimedTrustedBrowsers(browserIds: Iterable<string>): Promise<boolean> {
    for (const browserId of browserIds) this.unclaimedTrustedBrowserCleanup.add(browserId)
    if (this.unclaimedTrustedBrowserCleanup.size === 0) return false

    const cleanup = new Set(this.unclaimedTrustedBrowserCleanup)
    const changed = await this.removeStoredTrustedBrowsers(cleanup)
    for (const browserId of cleanup) this.unclaimedTrustedBrowserCleanup.delete(browserId)
    return changed
  }

  private scheduleUnclaimedTrustedBrowserCleanup(): void {
    if (this.unclaimedTrustedBrowserCleanupTask || this.unclaimedTrustedBrowserCleanup.size === 0) {
      return
    }

    let succeeded = false
    const cleanupTask = this.cleanupUnclaimedTrustedBrowsers([])
      .then((changed) => {
        succeeded = true
        if (changed) this.options.onChanged()
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.unclaimedTrustedBrowserCleanupTask !== cleanupTask) return
        this.unclaimedTrustedBrowserCleanupTask = undefined
        if (succeeded) this.scheduleUnclaimedTrustedBrowserCleanup()
        this.scheduleExpirationTimer()
      })
    this.unclaimedTrustedBrowserCleanupTask = cleanupTask
  }

  private pruneExpired(retryUnclaimedCleanup = true): void {
    const now = this.now()
    let pendingViewsChanged = false
    const expiredPrincipalIds = new Set<string>()
    for (const [id, request] of this.pending) {
      if (this.pendingExpiration(request) > now) continue
      if (request.status === 'pending' || request.status === 'approving') {
        pendingViewsChanged = true
      }
      if (request.grant?.decision === 'always') {
        expiredPrincipalIds.add(request.grant.sessionId)
        this.unclaimedTrustedBrowserCleanup.add(request.grant.sessionId)
      } else if (request.grant?.decision === 'once') {
        expiredPrincipalIds.add(request.grant.sessionId)
        this.oneTimeSessions.delete(request.grant.sessionId)
      }
      this.pending.delete(id)
    }
    for (const [id, session] of this.oneTimeSessions) {
      if (session.expiresAt <= now) {
        this.oneTimeSessions.delete(id)
        expiredPrincipalIds.add(id)
      }
    }
    for (const browser of this.stored.trustedBrowsers) {
      if (browser.expiresAt <= now && !this.unclaimedTrustedBrowserCleanup.has(browser.id)) {
        this.unclaimedTrustedBrowserCleanup.add(browser.id)
        expiredPrincipalIds.add(browser.id)
      }
    }
    for (const principalId of expiredPrincipalIds) {
      this.options.onAuthorizationExpired?.(principalId)
    }
    if (retryUnclaimedCleanup) this.scheduleUnclaimedTrustedBrowserCleanup()
    this.scheduleExpirationTimer()
    if (pendingViewsChanged) this.options.onChanged()
  }

  private scheduleExpirationTimer(): void {
    if (this.expirationTimer) clearTimeout(this.expirationTimer)
    this.expirationTimer = undefined
    if (this.disposed) return

    const now = this.now()
    const deadlines = [
      ...[...this.pending.values()].map((request) => this.pendingExpiration(request)),
      ...[...this.oneTimeSessions.values()].map((session) => session.expiresAt),
      ...this.stored.trustedBrowsers.flatMap((browser) =>
        this.unclaimedTrustedBrowserCleanup.has(browser.id) ||
        this.pendingRevocations.has(browser.id)
          ? []
          : [browser.expiresAt]
      ),
      ...(this.unclaimedTrustedBrowserCleanup.size > 0 && !this.unclaimedTrustedBrowserCleanupTask
        ? [now + CLEANUP_RETRY_MS]
        : [])
    ]
    if (deadlines.length === 0) return

    const delay = Math.max(0, Math.min(Math.min(...deadlines) - now, MAX_TIMER_DELAY_MS))
    const timer = setTimeout(() => {
      if (this.expirationTimer !== timer) return
      this.expirationTimer = undefined
      this.pruneExpired()
    }, delay)
    timer.unref()
    this.expirationTimer = timer
  }
}

export { describeBrowser, normalizeHost, readCookies }
