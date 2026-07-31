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
  cookieValue: string
}

type PendingPairing = BrowserDescription & {
  id: string
  secretHash: string
  code: string
  address?: string
  requestedAt: number
  expiresAt: number
  status: 'pending' | 'approved' | 'rejected'
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
  `${SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Strict; Path=/${
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
  private readonly now: () => number

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
    this.stored = { ...this.stored, mode }
    await this.options.repository.save(this.stored)
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
    const remoteItAppServiceId = services.appServiceId ?? this.stored.remoteItAppServiceId
    const remoteItBrowserServiceId =
      services.browserServiceId ?? this.stored.remoteItBrowserServiceId
    if (
      remoteItAppServiceId === this.stored.remoteItAppServiceId &&
      remoteItBrowserServiceId === this.stored.remoteItBrowserServiceId
    ) {
      return
    }
    this.stored = {
      ...this.stored,
      remoteItAppServiceId,
      remoteItBrowserServiceId
    }
    await this.options.repository.save(this.stored)
  }

  async setRemoteItPublicUrl(url: string | undefined): Promise<void> {
    this.stored = { ...this.stored, remoteItPublicUrl: url }
    await this.options.repository.save(this.stored)
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
      this.stored = {
        ...this.stored,
        trustedBrowsers: [...this.stored.trustedBrowsers, trusted]
      }
      await this.options.repository.save(this.stored)
    }
    request.status = 'approved'
    request.grant = { decision, cookieValue }
    this.options.onChanged()
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
    const next = this.stored.trustedBrowsers.filter((browser) => browser.id !== browserId)
    if (next.length === this.stored.trustedBrowsers.length) {
      throw new Error('Trusted browser not found.')
    }
    this.stored = { ...this.stored, trustedBrowsers: next }
    await this.options.repository.save(this.stored)
    this.options.onChanged()
  }

  clearTransientAccess(): void {
    this.pending.clear()
    this.oneTimeSessions.clear()
    this.options.onChanged()
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

  private ensurePending(request: IncomingMessage, response: ServerResponse): PendingPairing {
    this.pruneExpired()
    const existing = this.readPendingCookie(request)
    if (existing) return existing

    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      const oldest = [...this.pending.values()].sort((a, b) => a.requestedAt - b.requestedAt)[0]
      if (oldest) this.pending.delete(oldest.id)
    }

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
    if (pending.status === 'pending') {
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

    const trusted = this.stored.trustedBrowsers.find((browser) => browser.id === id)
    if (!trusted || !safeHashEqual(trusted.tokenHash, tokenHash)) return undefined
    if (this.now() - trusted.lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
      trusted.lastSeenAt = this.now()
      await this.options.repository.save(this.stored)
      this.options.onChanged()
    }
    return { kind: 'trusted', sessionId: id }
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
