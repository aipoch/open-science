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
  type StoredRemoteAccess,
  type StoredTrustedBrowser
} from './repository'

const PAIRING_COOKIE = 'open_science_remote_pairing'
const SESSION_COOKIE = 'open_science_remote_session'
const PAIRING_TTL_MS = 10 * 60 * 1_000
const ONE_TIME_SESSION_TTL_MS = 12 * 60 * 60 * 1_000
const TRUSTED_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60
const MAX_PENDING_REQUESTS = 20
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000

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
    persistent ? `; Max-Age=${TRUSTED_COOKIE_MAX_AGE_SECONDS}` : ''
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
  private readonly now: () => number
  private storedMutationQueue: Promise<void> = Promise.resolve()
  private authorizationGeneration = 0

  private constructor(
    private readonly options: PairingManagerOptions,
    stored: StoredRemoteAccess
  ) {
    this.stored = stored
    this.now = options.now ?? Date.now
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
    return [...this.stored.trustedBrowsers]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map(({ id, browser, platform, createdAt, lastSeenAt }) => ({
        id,
        browser,
        platform,
        createdAt,
        lastSeenAt
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
        const trusted: StoredTrustedBrowser = {
          id: sessionId,
          browser: request.browser,
          platform: request.platform,
          tokenHash: hash(secret),
          createdAt: this.now(),
          lastSeenAt: this.now()
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
        else await this.removeStoredTrustedBrowsers(new Set([sessionId]))
        throw new Error('This pairing request has expired or is no longer pending.')
      }

      request.status = 'approved'
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
    this.options.onChanged()
    if (unclaimedTrustedBrowsers.size === 0) return
    const changed = await this.removeStoredTrustedBrowsers(unclaimedTrustedBrowsers)
    if (changed) this.options.onChanged()
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
      return this.httpAuthorization(
        request,
        needsOrigin,
        authorizationGeneration,
        sessionAccess.kind === 'trusted'
      )
    }

    if (url.pathname === REMOTE_PAIR_STATUS_PATH && request.method === 'GET') {
      await this.handlePairingStatus(request, response)
      return 'handled'
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return 'denied'

    const pending = this.ensurePending(request, response)
    if (!pending) {
      const retryAt = Math.min(...[...this.pending.values()].map((entry) => entry.expiresAt))
      response.setHeader(
        'retry-after',
        String(Math.max(1, Math.ceil((retryAt - this.now()) / 1_000)))
      )
      json(response, 429, { error: 'Too many pairing requests. Try again later.' })
      return 'handled'
    }
    const page = renderPairingPage(pending)
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${page.nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    })
    response.end(request.method === 'HEAD' ? undefined : page.html)
    return 'handled'
  }

  private httpAuthorization(
    request: IncomingMessage,
    needsOrigin: boolean,
    authorizationGeneration: number,
    canManagePairing: boolean
  ): ExternalWebAccessAuthorization {
    return {
      kind: canManagePairing ? 'authorized-pairing-manager' : 'authorized',
      isCurrent: () =>
        authorizationGeneration === (this.options.authorizationGeneration?.() ?? 0) &&
        this.isExpectedRemoteRequest(request, needsOrigin)
    }
  }

  private async authorizeWebSocket(
    request: IncomingMessage,
    url: URL
  ): ReturnType<ExternalWebAccess['authorizeWebSocket']> {
    const authorizationGeneration = this.options.authorizationGeneration?.() ?? 0
    if (url.pathname !== '/events' || !this.isExpectedRemoteRequest(request, true)) {
      return undefined
    }
    const sessionAccess = await this.getSessionAccess(request)
    if (
      authorizationGeneration !== (this.options.authorizationGeneration?.() ?? 0) ||
      !this.isExpectedRemoteRequest(request, true)
    ) {
      return undefined
    }
    return sessionAccess ? { sessionId: sessionAccess.sessionId } : undefined
  }

  private ensurePending(
    request: IncomingMessage,
    response: ServerResponse
  ): PendingPairing | undefined {
    this.pruneExpired()
    const existing = this.readPendingCookie(request)
    if (existing) return existing

    if (this.pending.size >= MAX_PENDING_REQUESTS) return undefined

    const id = randomUUID()
    const secret = randomBytes(24).toString('base64url')
    const description = describeBrowser(request.headers['user-agent'])
    const requestedAt = this.now()
    const pending: PendingPairing = {
      id,
      secretHash: hash(secret),
      code: randomInt(0, 1_000_000).toString().padStart(6, '0'),
      ...description,
      address: clientAddress(request),
      requestedAt,
      expiresAt: requestedAt + PAIRING_TTL_MS,
      status: 'pending'
    }
    this.pending.set(id, pending)
    response.setHeader('set-cookie', pairingCookie(`${id}.${secret}`))
    this.options.onChanged()
    return pending
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
      json(response, 200, { status: 'pending', expiresAt: pending.expiresAt })
      return
    }
    if (pending.status === 'rejected' || !pending.grant) {
      this.pending.delete(pending.id)
      response.setHeader('set-cookie', clearCookie(PAIRING_COOKIE))
      json(response, 200, { status: 'rejected' })
      return
    }

    response.setHeader('set-cookie', [
      sessionCookie(pending.grant.cookieValue, pending.grant.decision === 'always'),
      clearCookie(PAIRING_COOKIE)
    ])
    this.pending.delete(pending.id)
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
    if (!trusted || !safeHashEqual(trusted.tokenHash, tokenHash)) return undefined
    if (this.now() - trusted.lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
      let authorized = false
      const changed = await this.commitStoredMutation((stored) => {
        const current = stored.trustedBrowsers.find((browser) => browser.id === id)
        if (!current || !safeHashEqual(current.tokenHash, tokenHash)) return undefined
        authorized = true
        const lastSeenAt = this.now()
        if (lastSeenAt - current.lastSeenAt < LAST_SEEN_WRITE_INTERVAL_MS) return undefined
        return {
          ...stored,
          trustedBrowsers: stored.trustedBrowsers.map((browser) =>
            browser.id === id ? { ...browser, lastSeenAt } : browser
          )
        }
      })
      if (!authorized) return undefined
      if (changed) this.options.onChanged()
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

  private pruneExpired(): void {
    const now = this.now()
    for (const [id, request] of this.pending) {
      if (request.expiresAt <= now) this.pending.delete(id)
    }
    for (const [id, session] of this.oneTimeSessions) {
      if (session.expiresAt <= now) this.oneTimeSessions.delete(id)
    }
  }
}

export { describeBrowser, normalizeHost, readCookies }
