import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

import { net } from 'electron'
import { WebSocket, WebSocketServer } from 'ws'

import {
  ApplicationCommandError,
  toApplicationCommandErrorEnvelope
} from '../../shared/application-command-contract'
import { PlanCommandError } from '../../shared/session-plan/contract'
import type { WebRpcErrorCode } from '../../shared/web-rpc-contract'
import {
  createTaskCallerContext,
  createWebCallerContext,
  type CallerContext
} from '../caller-context'
import { createApplicationCommandClient } from '../application-command-client'
import type { ApplicationCommandComposition } from '../application-command-composition'
import type { ApplicationEventSource } from '../application-events'
import type { PermissionApprovalPresence } from '../permission-approval-presence'
import { createLogger, diagnosticErrorFields, runWithDiagnosticCorrelation } from '../logger'
import {
  WEB_RPC_CAPABILITIES,
  WEB_EVENT_STREAM_PROTOCOL_VERSION,
  isWebRpcChannel,
  WEB_RPC_PROTOCOL_VERSION,
  webRpcRequestSchema
} from '../../shared/web-rpc-contract'
import { RENDERER_CONTRACT_CATALOG } from '../../shared/renderer-contract-catalog'
import {
  projectPublicTaskEvents,
  projectPublicTaskProgressEvent,
  projectWebRendererEvent
} from './application-event-projections'
import { InternalWebEventStream } from './internal-web-event-stream'
import { authenticateRequest, persistAuthCookie } from './auth'
import type {
  CreateTaskProjectRequest,
  StartTaskRunRequest,
  TaskPlanResponseRequest,
  UpdateProjectSessionDefaultsRequest,
  UpdateSessionConfigurationRequest,
  UpdateTaskAgentRoutingRequest,
  UpdateTaskProjectRequest
} from '../../shared/task-api'
import { TASK_EVENT_STREAM_PROTOCOL_VERSION } from '../../shared/task-api'
import { TaskApiError, type HeadlessTaskApi } from './task-api'
import { PublicTaskEventStream } from './public-task-event-stream'

const MAX_RPC_BODY_BYTES = 64 * 1024 * 1024
// Preserve one maximum-size request per logical client while leaving the same amount of capacity
// for other authenticated clients. Browser uploads use much smaller 8 MiB chunks in normal use.
const MAX_CLIENT_IN_FLIGHT_RPC_BODY_BYTES = 64 * 1024 * 1024
const MAX_SERVER_IN_FLIGHT_RPC_BODY_BYTES = 128 * 1024 * 1024
const MAX_WEB_RPC_RESPONSE_BYTES = 16 * 1024 * 1024
const MIN_GZIP_BYTES = 1_024
const INTERNAL_SERVER_ERROR_MESSAGE = 'Internal server error'
const DEFAULT_EVENT_HEARTBEAT_INTERVAL_MS = 10_000
// The replay stream retains 16 MiB. Keep 64 KiB for its mandatory ready frame and framing overhead.
const MAX_WEBSOCKET_BUFFERED_BYTES = 16 * 1024 * 1024 + 64 * 1024
const MAX_WEBSOCKET_INBOUND_BYTES = 1_024
const TASK_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000
const MAX_TASK_IDEMPOTENCY_ENTRIES = 1_024
const MAX_TASK_IDEMPOTENCY_BYTES = 64 * 1024 * 1024
const MAX_TASK_IDEMPOTENCY_ENTRIES_PER_PRINCIPAL = 128
const MAX_TASK_IDEMPOTENCY_BYTES_PER_PRINCIPAL = 8 * 1024 * 1024
const MIN_TASK_IDEMPOTENCY_ENTRY_BYTES = 16 * 1024
const MAX_IDEMPOTENCY_KEY_LENGTH = 255
const MAX_CACHED_TASK_ERROR_MESSAGE_LENGTH = 4_096
const MAX_WEB_CLIENTS_PER_PRINCIPAL = 64
const MAX_WEB_CLIENT_NONCE_LENGTH = 64
const DEFAULT_HTTP_CLIENT_IDLE_TTL_MS = 5 * 60_000
const WEB_CLIENT_NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const gzipAsync = promisify(gzip)
const log = createLogger('web-service')
const STATIC_RESPONSE_SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; media-src 'self' https: blob:; frame-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer'
} as const

// Remote Browser access is an application session, not authority over native host lifecycle and
// shell integration. The catalog keeps that authority decision aligned with renderer installation.
export const REMOTE_LOCAL_ONLY_RPC_CHANNELS = new Set(
  RENDERER_CONTRACT_CATALOG.flatMap(({ channel, surfaceInstallation }) =>
    channel !== null &&
    surfaceInstallation.localWeb === 'web-rpc' &&
    surfaceInstallation.remoteWeb === 'rejecting-stub'
      ? [channel]
      : []
  )
)

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2'
}

const COMPRESSIBLE_EXTENSIONS = new Set(['.css', '.html', '.js', '.mjs', '.json', '.svg'])

type WebServerOptions = {
  host: string
  port: number
  token: string
  staticRoot: string
  applicationCommands: Pick<ApplicationCommandComposition, 'localWeb' | 'remoteWeb'>
  applicationEvents: ApplicationEventSource
  permissionApprovalPresence?: PermissionApprovalPresence
  eventHeartbeatIntervalMs?: number
  requestBodyBudgets?: RequestBodyBudgets
  webClientRetention?: Readonly<{
    maxClientsPerPrincipal?: number
    httpIdleTtlMs?: number
  }>
  externalAccess?: ExternalWebAccess
  tasks?: Pick<
    HeadlessTaskApi,
    | 'listProjects'
    | 'createProject'
    | 'updateProject'
    | 'listSessions'
    | 'getSession'
    | 'startRun'
    | 'getRun'
    | 'cancelRun'
    | 'subscribeProgress'
    | 'listArtifacts'
    | 'acquireArtifact'
    | 'releaseArtifact'
    | 'runWithCallerContext'
  > &
    Partial<
      Pick<
        HeadlessTaskApi,
        | 'getSessionPlan'
        | 'respondSessionPlan'
        | 'resolveActiveRun'
        | 'getProjectSessionDefaults'
        | 'updateProjectSessionDefaults'
        | 'getSessionConfiguration'
        | 'updateSessionConfiguration'
        | 'getAgentRouting'
        | 'updateAgentRouting'
      >
    >
  onShutdownRequest?: () => void
  bootstrap: {
    appName: string
    appVersion: string
    configRoot: string
    platform: string
    versions: { electron: string; chrome: string; node: string }
  }
}

type RequestBodyBudgets = Readonly<{
  perRequestBytes: number
  perClientInFlightBytes: number
  serverInFlightBytes: number
}>

type RequestBodyBudgetDimension = 'request' | 'client' | 'server'

type RequestBodyBudgetLease = {
  clientId: string
  reservedBytes: number
  released: boolean
}

class RequestBodyBudgetExceededError extends Error {
  readonly name = 'RequestBodyBudgetExceededError'

  constructor(readonly dimension: RequestBodyBudgetDimension) {
    super(
      dimension === 'request'
        ? 'Request body is too large.'
        : dimension === 'client'
          ? 'Too many request body bytes are already in flight for this client.'
          : 'The server is temporarily at its request body capacity.'
    )
  }
}

class RequestBodyBudgetRegistry {
  private serverInFlightBytes = 0
  private readonly clientInFlightBytes = new Map<string, number>()
  private readonly requestLeases = new WeakMap<IncomingMessage, RequestBodyBudgetLease>()

  constructor(private readonly budgets: RequestBodyBudgets) {
    for (const [name, value] of Object.entries(budgets)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer.`)
      }
    }
  }

  reserve(request: IncomingMessage, clientId: string, bytes: number): RequestBodyBudgetLease {
    const lease: RequestBodyBudgetLease = { clientId, reservedBytes: 0, released: false }
    this.increase(lease, bytes)
    this.requestLeases.set(request, lease)
    return lease
  }

  increase(lease: RequestBodyBudgetLease, bytes: number): void {
    if (lease.released) throw new Error('Cannot increase a released request body budget lease.')
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new TypeError('Request body budget increments must be non-negative safe integers.')
    }

    const requestBytes = lease.reservedBytes + bytes
    if (requestBytes > this.budgets.perRequestBytes) {
      throw new RequestBodyBudgetExceededError('request')
    }
    const clientBytes = (this.clientInFlightBytes.get(lease.clientId) ?? 0) + bytes
    if (clientBytes > this.budgets.perClientInFlightBytes) {
      throw new RequestBodyBudgetExceededError('client')
    }
    const serverBytes = this.serverInFlightBytes + bytes
    if (serverBytes > this.budgets.serverInFlightBytes) {
      throw new RequestBodyBudgetExceededError('server')
    }

    lease.reservedBytes = requestBytes
    this.serverInFlightBytes = serverBytes
    if (clientBytes === 0) this.clientInFlightBytes.delete(lease.clientId)
    else this.clientInFlightBytes.set(lease.clientId, clientBytes)
  }

  release(request: IncomingMessage): void {
    const lease = this.requestLeases.get(request)
    if (!lease) return
    this.requestLeases.delete(request)
    if (lease.released) return
    lease.released = true
    this.serverInFlightBytes -= lease.reservedBytes
    const clientBytes = (this.clientInFlightBytes.get(lease.clientId) ?? 0) - lease.reservedBytes
    if (clientBytes === 0) this.clientInFlightBytes.delete(lease.clientId)
    else this.clientInFlightBytes.set(lease.clientId, clientBytes)
  }
}

class WebClientCapacityExceededError extends Error {
  readonly name = 'WebClientCapacityExceededError'

  constructor() {
    super('Too many active Web clients for this authenticated principal.')
  }
}

class InvalidWebClientNonceError extends Error {
  readonly name = 'InvalidWebClientNonceError'

  constructor() {
    super('Web client identifier must be one ASCII token of at most 64 characters.')
  }
}

type RetainedWebClient = {
  clientId: string
  httpRequests: number
  sockets: number
  idleTimer?: ReturnType<typeof setTimeout>
}

type WebClientLease = Readonly<{ release: (disconnected?: boolean) => void }>

class WebClientLeaseRegistry {
  private readonly clientsByPrincipal = new Map<string, Map<string, RetainedWebClient>>()
  private disposed = false

  constructor(
    private readonly releaseClient: (clientId: string) => void,
    private readonly maxClientsPerPrincipal = MAX_WEB_CLIENTS_PER_PRINCIPAL,
    private readonly httpIdleTtlMs = DEFAULT_HTTP_CLIENT_IDLE_TTL_MS
  ) {
    if (!Number.isSafeInteger(maxClientsPerPrincipal) || maxClientsPerPrincipal <= 0) {
      throw new TypeError('maxClientsPerPrincipal must be a positive safe integer.')
    }
    if (!Number.isSafeInteger(httpIdleTtlMs) || httpIdleTtlMs <= 0) {
      throw new TypeError('httpIdleTtlMs must be a positive safe integer.')
    }
  }

  acquireHttp(principalId: string, clientNonce: string, clientId: string): WebClientLease {
    return this.acquire(principalId, clientNonce, clientId, 'httpRequests')
  }

  acquireSocket(principalId: string, clientNonce: string, clientId: string): WebClientLease {
    return this.acquire(principalId, clientNonce, clientId, 'sockets')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const principalClients = [...this.clientsByPrincipal.values()]
    const clients = principalClients.flatMap((clients) => [...clients.values()])
    for (const clients of principalClients) clients.clear()
    this.clientsByPrincipal.clear()
    const failures: unknown[] = []
    for (const client of clients) {
      if (client.idleTimer) clearTimeout(client.idleTimer)
      try {
        this.releaseClient(client.clientId)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Web client cleanup failed.')
  }

  private acquire(
    principalId: string,
    clientNonce: string,
    clientId: string,
    kind: 'httpRequests' | 'sockets'
  ): WebClientLease {
    if (this.disposed) throw new Error('Web client lease registry is disposed.')
    const clients = this.clientsByPrincipal.get(principalId) ?? new Map<string, RetainedWebClient>()
    let client = clients.get(clientNonce)
    if (!client) {
      if (clients.size >= this.maxClientsPerPrincipal) {
        const idle = [...clients].find(
          ([, candidate]) => candidate.httpRequests === 0 && candidate.sockets === 0
        )
        if (!idle) throw new WebClientCapacityExceededError()
        clients.delete(idle[0])
        if (idle[1].idleTimer) clearTimeout(idle[1].idleTimer)
        this.releaseClient(idle[1].clientId)
      }
      client = { clientId, httpRequests: 0, sockets: 0 }
    } else if (client.clientId !== clientId) {
      throw new Error('Web client identity changed within one principal scope.')
    }
    if (client.idleTimer) {
      clearTimeout(client.idleTimer)
      delete client.idleTimer
    }
    clients.delete(clientNonce)
    clients.set(clientNonce, client)
    this.clientsByPrincipal.set(principalId, clients)
    client[kind] += 1
    let released = false

    return Object.freeze({
      release: (disconnected = false) => {
        if (released) return
        released = true
        if (clients.get(clientNonce) !== client) return
        client[kind] -= 1
        if (
          (kind === 'sockets' || disconnected) &&
          client.sockets === 0 &&
          client.httpRequests === 0
        ) {
          clients.delete(clientNonce)
          if (clients.size === 0) this.clientsByPrincipal.delete(principalId)
          if (client.idleTimer) clearTimeout(client.idleTimer)
          this.releaseClient(client.clientId)
          return
        }
        clients.delete(clientNonce)
        clients.set(clientNonce, client)
        if (client.httpRequests === 0 && client.sockets === 0) {
          client.idleTimer = setTimeout(() => {
            if (
              clients.get(clientNonce) !== client ||
              client.httpRequests !== 0 ||
              client.sockets !== 0
            ) {
              return
            }
            clients.delete(clientNonce)
            if (clients.size === 0) this.clientsByPrincipal.delete(principalId)
            delete client.idleTimer
            this.releaseClient(client.clientId)
          }, this.httpIdleTtlMs)
          client.idleTimer.unref()
        }
      }
    })
  }
}

// Keep the remote payload allowlisted: the full bootstrap also carries host-local diagnostics.
const remoteWebBootstrap = ({
  appName,
  appVersion,
  platform,
  versions
}: WebServerOptions['bootstrap']): Omit<WebServerOptions['bootstrap'], 'configRoot'> => ({
  appName,
  appVersion,
  platform,
  versions
})

const publicApplicationCommandError = (
  error: unknown
): ReturnType<typeof toApplicationCommandErrorEnvelope> =>
  error instanceof ApplicationCommandError
    ? toApplicationCommandErrorEnvelope(error)
    : { code: 'command-failed', message: INTERNAL_SERVER_ERROR_MESSAGE }

const applicationCommandErrorStatus = (error: ApplicationCommandError): number => {
  if (error.code === 'invalid-command-arguments') return 400
  if (error.code === 'command-unavailable') return 404
  if (error.code === 'session-details-conflict') return 409
  if (error.code === 'session-revision-conflict') return 409
  return 500
}

const sendWebSocketMessage = (socket: WebSocket, message: string): boolean => {
  if (socket.readyState !== WebSocket.OPEN) return false
  if (socket.bufferedAmount + Buffer.byteLength(message) > MAX_WEBSOCKET_BUFFERED_BYTES) {
    socket.terminate()
    return false
  }

  try {
    socket.send(message, (error) => {
      if (error) socket.terminate()
    })
    return true
  } catch {
    socket.terminate()
    return false
  }
}

export type ExternalWebAccessAuthorization = {
  kind: 'authorized' | 'authorized-pairing-manager'
  principalId: string
  isCurrent: () => boolean
}

export type ExternalWebAccessDecision = ExternalWebAccessAuthorization | 'handled' | 'denied'

export type ExternalWebSocketAccess = {
  principalId: string
  isCurrent: () => boolean
}

// Optional authentication boundary for a loopback reverse proxy. The normal localhost token path
// remains unchanged; an isolated remote-access adapter can authenticate its own origin/cookies or
// render a pairing page without coupling the web server to a tunnel provider.
export type ExternalWebAccess = {
  authorizeHttp: (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) => Promise<ExternalWebAccessDecision>
  authorizeWebSocket: (
    request: IncomingMessage,
    url: URL
  ) => Promise<ExternalWebSocketAccess | undefined>
}

export type RunningWebServer = {
  port: number
  // Invalidates retained replay access before closing the matching remotely authorized sockets.
  closeExternalConnections: (principalId?: string) => void
  close: () => Promise<void>
}

class WebRpcResponseBudgetExceededError extends Error {
  readonly name = 'WebRpcResponseBudgetExceededError'

  constructor() {
    super('RPC response exceeds the 16 MiB byte budget.')
  }
}

const json = (
  response: ServerResponse,
  status: number,
  value: unknown,
  maxBytes = Number.POSITIVE_INFINITY
): void => {
  const content = JSON.stringify(value ?? null, (_key, child) => {
    if (child instanceof ArrayBuffer || ArrayBuffer.isView(child)) {
      const bytes =
        child instanceof ArrayBuffer
          ? new Uint8Array(child)
          : new Uint8Array(child.buffer, child.byteOffset, child.byteLength)
      return { $binary: Buffer.from(bytes).toString('base64') }
    }
    return child
  })
  const contentBytes = Buffer.byteLength(content)
  if (contentBytes > maxBytes) throw new WebRpcResponseBudgetExceededError()
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(contentBytes),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  response.end(content)
}

const hasValidUrlPathEncoding = (pathname: string): boolean => {
  try {
    decodeURI(pathname)
    return true
  } catch {
    return false
  }
}

const webRpcError = (
  response: ServerResponse,
  status: number,
  code: WebRpcErrorCode,
  message: string
): void => {
  json(response, status, {
    protocolVersion: WEB_RPC_PROTOCOL_VERSION,
    ok: false,
    error: { code, message }
  })
}

const declaredContentLength = (request: IncomingMessage): number | undefined => {
  const value = request.headers['content-length']
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return undefined
  const length = Number(value)
  return Number.isSafeInteger(length) ? length : undefined
}

const closeRequestAfterResponse = (request: IncomingMessage, response: ServerResponse): void => {
  response.shouldKeepAlive = false
  if (!response.headersSent) response.setHeader('connection', 'close')
  if (response.writableFinished) request.destroy()
  else response.once('finish', () => request.destroy())
}

const parseClientNonce = (values: readonly string[]): string => {
  if (values.length === 0) return 'web'
  const value = values[0]
  if (
    values.length !== 1 ||
    value.length > MAX_WEB_CLIENT_NONCE_LENGTH ||
    !WEB_CLIENT_NONCE_PATTERN.test(value)
  ) {
    throw new InvalidWebClientNonceError()
  }
  return value
}

const requestClientNonce = (request: IncomingMessage): string =>
  parseClientNonce(request.headersDistinct['x-open-science-client'] ?? [])

const authorizedClientId = (principalId: string, clientNonce: string): string =>
  `${principalId}:${clientNonce}`

const readJsonBody = async (
  request: IncomingMessage,
  response: ServerResponse,
  registry: RequestBodyBudgetRegistry,
  clientId: string
): Promise<unknown> => {
  const declared = declaredContentLength(request)
  let lease: RequestBodyBudgetLease
  try {
    lease = registry.reserve(request, clientId, declared ?? 0)
  } catch (error) {
    if (error instanceof RequestBodyBudgetExceededError) {
      closeRequestAfterResponse(request, response)
    }
    throw error
  }
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (declared === undefined) registry.increase(lease, buffer.length)
      chunks.push(buffer)
    }
  } catch (error) {
    if (error instanceof RequestBodyBudgetExceededError) {
      closeRequestAfterResponse(request, response)
    }
    throw error
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'), (_key, child) => {
    if (
      child &&
      typeof child === 'object' &&
      '$binary' in child &&
      typeof child.$binary === 'string'
    ) {
      return Uint8Array.from(Buffer.from(child.$binary, 'base64'))
    }
    return child
  })
}

const taskErrorStatus = (error: TaskApiError): number => {
  if (error.code === 'invalid_request') return 400
  if (error.code === 'invalid_configuration') return 400
  if (
    error.code === 'session_busy' ||
    error.code === 'session_revision_conflict' ||
    error.code === 'project_conflict' ||
    error.code === 'session_archived' ||
    error.code === 'project_archived'
  ) {
    return 409
  }
  return 404
}

const parseTaskPlanResponseRequest = (value: unknown): TaskPlanResponseRequest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskApiError('invalid_request', 'Plan response must be an object.')
  }
  const candidate = value as Record<string, unknown>
  if ('feedback' in candidate) {
    if (
      typeof candidate.feedback !== 'string' ||
      candidate.feedback.trim().length === 0 ||
      'decision' in candidate ||
      'artifactVersionId' in candidate ||
      'expectedRevision' in candidate
    ) {
      throw new TaskApiError(
        'invalid_request',
        'Plan feedback must be a non-empty string without decision fields.'
      )
    }
    return { feedback: candidate.feedback.trim() }
  }
  if (
    (candidate.decision !== 'approved' && candidate.decision !== 'rejected') ||
    typeof candidate.artifactVersionId !== 'string' ||
    candidate.artifactVersionId.trim().length === 0 ||
    !Number.isInteger(candidate.expectedRevision) ||
    (candidate.expectedRevision as number) < 0
  ) {
    throw new TaskApiError(
      'invalid_request',
      'Plan decision requires approved or rejected, a non-empty artifact version, and a non-negative integer revision.'
    )
  }
  return {
    decision: candidate.decision,
    artifactVersionId: candidate.artifactVersionId.trim(),
    expectedRevision: candidate.expectedRevision as number
  }
}

class ExternalAuthorizationExpiredError extends Error {
  constructor() {
    super('Remote authorization expired before the request was executed.')
    this.name = 'ExternalAuthorizationExpiredError'
  }
}

class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency-Key was already used with a different request body.')
    this.name = 'IdempotencyConflictError'
  }
}

class IdempotencyUnavailableError extends Error {
  constructor() {
    super('Idempotency replay capacity is temporarily unavailable.')
    this.name = 'IdempotencyUnavailableError'
  }
}

type TaskIdempotencyEntry = {
  ownerScope: string
  fingerprint: string
  expiresAt: number
  reservedBytes: number
  result: Promise<unknown>
}

export class TaskIdempotencyRegistry {
  private readonly entries = new Map<string, TaskIdempotencyEntry>()
  private readonly usageByOwner = new Map<string, { entries: number; reservedBytes: number }>()
  private reservedBytes = 0

  constructor(
    private readonly maxEntries = MAX_TASK_IDEMPOTENCY_ENTRIES,
    private readonly maxBytes = MAX_TASK_IDEMPOTENCY_BYTES,
    private readonly now: () => number = Date.now,
    private readonly maxEntriesPerOwner = MAX_TASK_IDEMPOTENCY_ENTRIES_PER_PRINCIPAL,
    private readonly maxBytesPerOwner = MAX_TASK_IDEMPOTENCY_BYTES_PER_PRINCIPAL
  ) {}

  async run<Result>(
    scope: string,
    fingerprint: string,
    reservedBytes: number,
    operation: () => Promise<Result>,
    ownerScope = 'default'
  ): Promise<Result> {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.delete(key, entry)
    }

    const existing = this.entries.get(scope)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new IdempotencyConflictError()
      return existing.result as Promise<Result>
    }

    const ownerUsage = this.usageByOwner.get(ownerScope) ?? { entries: 0, reservedBytes: 0 }
    if (
      this.entries.size >= this.maxEntries ||
      reservedBytes > this.maxBytes - this.reservedBytes ||
      ownerUsage.entries >= this.maxEntriesPerOwner ||
      reservedBytes > this.maxBytesPerOwner - ownerUsage.reservedBytes
    ) {
      throw new IdempotencyUnavailableError()
    }

    const result = Promise.resolve()
      .then(operation)
      .catch((error: unknown) => {
        if (error instanceof TaskApiError) {
          throw new TaskApiError(
            error.code,
            error.message.slice(0, MAX_CACHED_TASK_ERROR_MESSAGE_LENGTH)
          )
        }
        throw new Error(INTERNAL_SERVER_ERROR_MESSAGE)
      })
    this.entries.set(scope, {
      ownerScope,
      fingerprint,
      expiresAt: now + TASK_IDEMPOTENCY_TTL_MS,
      reservedBytes,
      result
    })
    this.reservedBytes += reservedBytes
    this.usageByOwner.set(ownerScope, {
      entries: ownerUsage.entries + 1,
      reservedBytes: ownerUsage.reservedBytes + reservedBytes
    })
    return result
  }

  clear(): void {
    this.entries.clear()
    this.usageByOwner.clear()
    this.reservedBytes = 0
  }

  private delete(key: string, entry: TaskIdempotencyEntry): void {
    if (!this.entries.delete(key)) return
    this.reservedBytes -= entry.reservedBytes
    const ownerUsage = this.usageByOwner.get(entry.ownerScope)
    if (!ownerUsage) return
    if (ownerUsage.entries === 1) {
      this.usageByOwner.delete(entry.ownerScope)
      return
    }
    this.usageByOwner.set(entry.ownerScope, {
      entries: ownerUsage.entries - 1,
      reservedBytes: ownerUsage.reservedBytes - entry.reservedBytes
    })
  }
}

const idempotencyKey = (request: IncomingMessage): string | undefined => {
  const value = request.headers['idempotency-key']
  if (value === undefined) return undefined
  if (Array.isArray(value) || value.length === 0 || value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new TaskApiError(
      'invalid_request',
      `Idempotency-Key must contain between 1 and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`
    )
  }
  return value
}

const runIdempotentTask = <Result>(
  registry: TaskIdempotencyRegistry,
  request: IncomingMessage,
  url: URL,
  callerContext: CallerContext,
  ownerScope: string,
  body: unknown,
  operation: () => Promise<Result>
): Promise<Result> => {
  const key = idempotencyKey(request)
  if (key === undefined) return operation()
  const scope = JSON.stringify([
    callerContext.location,
    callerContext.clientId,
    request.method,
    url.pathname,
    key
  ])
  const serializedBody = JSON.stringify(body)
  const fingerprint = createHash('sha256').update(serializedBody).digest('hex')
  // Project responses may retain request-derived strings; reserve twice the UTF-8 body plus fixed
  // Promise/result/error overhead so the registry has both an entry limit and a memory budget.
  const reservedBytes = Math.max(
    MIN_TASK_IDEMPOTENCY_ENTRY_BYTES,
    Buffer.byteLength(serializedBody) * 2 + MIN_TASK_IDEMPOTENCY_ENTRY_BYTES
  )
  return registry.run(scope, fingerprint, reservedBytes, operation, ownerScope)
}

const assertExternalAuthorizationCurrent = (
  authorization: ExternalWebAccessAuthorization | undefined
): void => {
  if (authorization && !authorization.isCurrent()) {
    throw new ExternalAuthorizationExpiredError()
  }
}

const taskError = (response: ServerResponse, error: unknown): void => {
  if (error instanceof RequestBodyBudgetExceededError) {
    const status = error.dimension === 'request' ? 413 : error.dimension === 'client' ? 429 : 503
    json(response, status, {
      error: {
        code:
          error.dimension === 'request'
            ? 'payload_too_large'
            : error.dimension === 'client'
              ? 'client_busy'
              : 'server_busy',
        message: error.message
      }
    })
    return
  }
  if (error instanceof SyntaxError) {
    json(response, 400, {
      error: { code: 'invalid_request', message: 'Request body must be valid JSON.' }
    })
    return
  }
  if (error instanceof ExternalAuthorizationExpiredError) {
    json(response, 401, {
      error: { code: 'unauthorized', message: error.message }
    })
    return
  }
  if (error instanceof IdempotencyConflictError) {
    json(response, 409, {
      error: { code: 'idempotency_conflict', message: error.message }
    })
    return
  }
  if (error instanceof IdempotencyUnavailableError) {
    json(response, 503, {
      error: { code: 'idempotency_unavailable', message: error.message }
    })
    return
  }
  if (error instanceof PlanCommandError) {
    json(response, error.code === 'invalid-plan' ? 400 : 409, {
      error: { code: error.code, message: error.message }
    })
    return
  }
  if (error instanceof TaskApiError) {
    json(response, taskErrorStatus(error), {
      error: { code: error.code, message: error.message }
    })
    return
  }
  json(response, 500, {
    error: {
      code: 'internal_error',
      message: INTERNAL_SERVER_ERROR_MESSAGE
    }
  })
}

const streamPreview = async (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<void> => {
  const previewPath = url.pathname.slice('/preview/'.length)
  const slash = previewPath.indexOf('/')
  const resourceId = slash === -1 ? previewPath : previewPath.slice(0, slash)
  const suffix = slash === -1 ? '' : previewPath.slice(slash)
  if (!resourceId) {
    response.writeHead(404).end()
    return
  }

  await streamPreviewResource(
    request,
    response,
    `open-science-preview://${encodeURIComponent(resourceId)}${suffix}`
  )
}

const streamPreviewResource = async (
  request: IncomingMessage,
  response: ServerResponse,
  resourceUrl: string,
  responseOverrides: Record<string, string> = {}
): Promise<void> => {
  const abortController = new AbortController()
  const abortOnDisconnect = (): void => {
    if (!response.writableFinished) abortController.abort()
  }
  response.once('close', abortOnDisconnect)
  response.once('error', abortOnDisconnect)
  const headers = new Headers()
  if (request.headers.range) headers.set('range', request.headers.range)
  try {
    const upstream = await net.fetch(resourceUrl, {
      method: request.method,
      headers,
      signal: abortController.signal
    })
    if (abortController.signal.aborted) return
    const responseHeaders: Record<string, string> = {}
    upstream.headers.forEach((value, key) => {
      if (!['connection', 'transfer-encoding'].includes(key.toLowerCase()))
        responseHeaders[key] = value
    })
    Object.assign(responseHeaders, responseOverrides)
    response.writeHead(upstream.status, responseHeaders)
    if (!upstream.body || request.method === 'HEAD') {
      response.end()
      return
    }
    try {
      const source = Readable.fromWeb(upstream.body as unknown as NodeReadableStream<Uint8Array>)
      await pipeline(source, response, { signal: abortController.signal })
    } catch (error) {
      if (!abortController.signal.aborted) throw error
    }
  } finally {
    response.off('close', abortOnDisconnect)
    response.off('error', abortOnDisconnect)
  }
}

const handleTaskApiRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  tasks: NonNullable<WebServerOptions['tasks']>,
  callerContext: CallerContext,
  idempotencyOwnerScope: string,
  requestBodyClientId: string,
  requestBodyBudgetRegistry: RequestBodyBudgetRegistry,
  idempotencyRegistry: TaskIdempotencyRegistry,
  externalAuthorization?: ExternalWebAccessAuthorization
): Promise<boolean> =>
  tasks.runWithCallerContext(callerContext, async () => {
    try {
      if (url.pathname === '/api/v1/projects' && request.method === 'GET') {
        assertExternalAuthorizationCurrent(externalAuthorization)
        json(response, 200, { data: await tasks.listProjects() })
        return true
      }
      if (url.pathname === '/api/v1/projects' && request.method === 'POST') {
        const body = (await readJsonBody(
          request,
          response,
          requestBodyBudgetRegistry,
          requestBodyClientId
        )) as CreateTaskProjectRequest
        assertExternalAuthorizationCurrent(externalAuthorization)
        json(response, 201, {
          data: await runIdempotentTask(
            idempotencyRegistry,
            request,
            url,
            callerContext,
            idempotencyOwnerScope,
            body,
            () => tasks.createProject(body)
          )
        })
        return true
      }
      const projectSessionDefaultsMatch = url.pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/session-defaults$/
      )
      if (
        projectSessionDefaultsMatch &&
        request.method === 'GET' &&
        tasks.getProjectSessionDefaults
      ) {
        assertExternalAuthorizationCurrent(externalAuthorization)
        json(response, 200, {
          data: await tasks.getProjectSessionDefaults(
            decodeURIComponent(projectSessionDefaultsMatch[1])
          )
        })
        return true
      }
      if (
        projectSessionDefaultsMatch &&
        request.method === 'PATCH' &&
        tasks.updateProjectSessionDefaults
      ) {
        const body = (await readJsonBody(
          request,
          response,
          requestBodyBudgetRegistry,
          requestBodyClientId
        )) as UpdateProjectSessionDefaultsRequest
        assertExternalAuthorizationCurrent(externalAuthorization)
        json(response, 200, {
          data: await tasks.updateProjectSessionDefaults(
            decodeURIComponent(projectSessionDefaultsMatch[1]),
            body
          )
        })
        return true
      }
      const projectMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)$/)
      if (projectMatch && request.method === 'PATCH') {
        const body = (await readJsonBody(
          request,
          response,
          requestBodyBudgetRegistry,
          requestBodyClientId
        )) as UpdateTaskProjectRequest
        assertExternalAuthorizationCurrent(externalAuthorization)
        json(response, 200, {
          data: await tasks.updateProject(decodeURIComponent(projectMatch[1]), body)
        })
        return true
      }
      if (url.pathname === '/api/v1/sessions' && request.method === 'GET') {
        assertExternalAuthorizationCurrent(externalAuthorization)
        json(response, 200, {
          data: await tasks.listSessions(url.searchParams.get('project') ?? undefined)
        })
        return true
      }
      if (
        url.pathname === '/api/v1/settings/agent-routing' &&
        request.method === 'GET' &&
        tasks.getAgentRouting
      ) {
        assertExternalAuthorizationCurrent(externalAuthorization)
        json(response, 200, { data: await tasks.getAgentRouting() })
        return true
      }
      if (
        url.pathname === '/api/v1/settings/agent-routing' &&
        request.method === 'PATCH' &&
        tasks.updateAgentRouting
      ) {
        const body = (await readJsonBody(
          request,
          response,
          requestBodyBudgetRegistry,
          requestBodyClientId
        )) as UpdateTaskAgentRoutingRequest
        assertExternalAuthorizationCurrent(externalAuthorization)
        json(response, 200, { data: await tasks.updateAgentRouting(body) })
        return true
      }
      if (url.pathname === '/api/v1/runs' && request.method === 'POST') {
        const body = (await readJsonBody(
          request,
          response,
          requestBodyBudgetRegistry,
          requestBodyClientId
        )) as StartTaskRunRequest
        assertExternalAuthorizationCurrent(externalAuthorization)
        json(response, 202, {
          data: await runIdempotentTask(
            idempotencyRegistry,
            request,
            url,
            callerContext,
            idempotencyOwnerScope,
            body,
            () => tasks.startRun(body)
          )
        })
        return true
      }

      const runMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)$/)
      if (runMatch && request.method === 'GET') {
        assertExternalAuthorizationCurrent(externalAuthorization)
        json(response, 200, { data: tasks.getRun(decodeURIComponent(runMatch[1])) })
        return true
      }
      const cancelRunMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/cancel$/)
      if (cancelRunMatch && request.method === 'POST') {
        await readJsonBody(request, response, requestBodyBudgetRegistry, requestBodyClientId)
        assertExternalAuthorizationCurrent(externalAuthorization)
        json(response, 200, {
          data: await tasks.cancelRun(decodeURIComponent(cancelRunMatch[1]))
        })
        return true
      }
      const sessionPlanMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/plan$/)
      if (sessionPlanMatch && request.method === 'GET' && tasks.getSessionPlan) {
        assertExternalAuthorizationCurrent(externalAuthorization)
        json(response, 200, {
          data: await tasks.getSessionPlan(decodeURIComponent(sessionPlanMatch[1]))
        })
        return true
      }
      const sessionPlanResponseMatch = url.pathname.match(
        /^\/api\/v1\/sessions\/([^/]+)\/plan\/respond$/
      )
      if (sessionPlanResponseMatch && request.method === 'POST' && tasks.respondSessionPlan) {
        const body = parseTaskPlanResponseRequest(
          await readJsonBody(request, response, requestBodyBudgetRegistry, requestBodyClientId)
        )
        assertExternalAuthorizationCurrent(externalAuthorization)
        json(response, 200, {
          data: await tasks.respondSessionPlan(
            decodeURIComponent(sessionPlanResponseMatch[1]),
            body
          )
        })
        return true
      }
      const sessionArtifactsMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/artifacts$/)
      if (sessionArtifactsMatch && request.method === 'GET') {
        assertExternalAuthorizationCurrent(externalAuthorization)
        json(response, 200, {
          data: await tasks.listArtifacts(decodeURIComponent(sessionArtifactsMatch[1]))
        })
        return true
      }
      const sessionConfigMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/config$/)
      if (sessionConfigMatch && request.method === 'GET' && tasks.getSessionConfiguration) {
        assertExternalAuthorizationCurrent(externalAuthorization)
        json(response, 200, {
          data: await tasks.getSessionConfiguration(decodeURIComponent(sessionConfigMatch[1]))
        })
        return true
      }
      if (sessionConfigMatch && request.method === 'PATCH' && tasks.updateSessionConfiguration) {
        const body = (await readJsonBody(
          request,
          response,
          requestBodyBudgetRegistry,
          requestBodyClientId
        )) as UpdateSessionConfigurationRequest
        assertExternalAuthorizationCurrent(externalAuthorization)
        json(response, 200, {
          data: await tasks.updateSessionConfiguration(
            decodeURIComponent(sessionConfigMatch[1]),
            body
          )
        })
        return true
      }
      const sessionMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/)
      if (sessionMatch && request.method === 'GET') {
        assertExternalAuthorizationCurrent(externalAuthorization)
        json(response, 200, { data: await tasks.getSession(decodeURIComponent(sessionMatch[1])) })
        return true
      }
      const artifactMatch = url.pathname.match(/^\/api\/v1\/artifacts\/([^/]+)\/content$/)
      if (artifactMatch && (request.method === 'GET' || request.method === 'HEAD')) {
        assertExternalAuthorizationCurrent(externalAuthorization)
        const artifact = await tasks.acquireArtifact(decodeURIComponent(artifactMatch[1]))
        try {
          await streamPreviewResource(request, response, artifact.url, {
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`
          })
        } finally {
          await tasks.releaseArtifact(artifact.resourceId)
        }
        return true
      }
    } catch (error) {
      log.warn('task http request rejected', {
        method: request.method,
        surface: callerContext.surface,
        location: callerContext.location,
        ...diagnosticErrorFields(error)
      })
      taskError(response, error)
      return true
    }
    return false
  })

const serveStatic = async (
  request: IncomingMessage,
  response: ServerResponse,
  staticRoot: string,
  pathname: string
): Promise<void> => {
  const root = resolve(staticRoot)
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1))
  let filePath = resolve(root, requested)
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    response.writeHead(404).end()
    return
  }

  try {
    if (!(await stat(filePath)).isFile()) throw new Error('Not a file')
  } catch {
    filePath = resolve(root, 'index.html')
  }

  try {
    const content = await readFile(filePath)
    const extension = extname(filePath).toLowerCase()
    const canCompress =
      content.byteLength >= MIN_GZIP_BYTES && COMPRESSIBLE_EXTENSIONS.has(extension)
    const acceptsGzip = /\bgzip\b/i.test(String(request.headers['accept-encoding'] ?? ''))
    const body = canCompress && acceptsGzip ? await gzipAsync(content) : content
    response.writeHead(200, {
      ...STATIC_RESPONSE_SECURITY_HEADERS,
      'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
      'content-length': String(body.byteLength),
      'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000',
      'x-content-type-options': 'nosniff',
      ...(canCompress ? { vary: 'Accept-Encoding' } : {}),
      ...(body !== content ? { 'content-encoding': 'gzip' } : {})
    })
    response.end(request.method === 'HEAD' ? undefined : body)
  } catch {
    const message = 'Web UI is not built. Run npm run build:web first.'
    response.writeHead(503, {
      ...STATIC_RESPONSE_SECURITY_HEADERS,
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(Buffer.byteLength(message))
    })
    response.end(request.method === 'HEAD' ? undefined : message)
  }
}

const startWebHttpServer = async (options: WebServerOptions): Promise<RunningWebServer> => {
  const sockets = new Set<WebSocket>()
  const externalSockets = new Map<WebSocket, ExternalWebSocketAccess>()
  const publicEventSockets = new Map<WebSocket, 'legacy' | 'replay'>()
  const internalEventSockets = new Map<WebSocket, 'legacy' | 'replay'>()
  const livenessSockets = new Set<WebSocket>()
  const awaitingPong = new WeakSet<WebSocket>()
  const internalEventStream = new InternalWebEventStream()
  const publicTaskEventStream = new PublicTaskEventStream()
  // A current remote authorization grants replay only from the first sequence that principal saw.
  // Local Web clients keep the process-wide cursor so remote lifecycle changes never reload them.
  const remoteReplayFloors = new Map<
    string,
    Readonly<{
      internalAfter: number
      publicTaskAfter: number
    }>
  >()
  const replayFloorFor = (
    principalId: string
  ): Readonly<{
    internalAfter: number
    publicTaskAfter: number
  }> => {
    const existing = remoteReplayFloors.get(principalId)
    if (existing) return existing
    const created = {
      internalAfter: internalEventStream.cursor().latestSequence,
      publicTaskAfter: publicTaskEventStream.cursor().latestSequence
    }
    remoteReplayFloors.set(principalId, created)
    return created
  }
  const commandClient = createApplicationCommandClient()
  const taskIdempotencyRegistry = new TaskIdempotencyRegistry()
  const requestBodyBudgetRegistry = new RequestBodyBudgetRegistry(
    options.requestBodyBudgets ?? {
      perRequestBytes: MAX_RPC_BODY_BYTES,
      perClientInFlightBytes: MAX_CLIENT_IN_FLIGHT_RPC_BODY_BYTES,
      serverInFlightBytes: MAX_SERVER_IN_FLIGHT_RPC_BODY_BYTES
    }
  )
  const webClientLeases = new WebClientLeaseRegistry(
    (clientId) => {
      commandClient.releaseClient('web', clientId)
    },
    options.webClientRetention?.maxClientsPerPrincipal,
    options.webClientRetention?.httpIdleTtlMs
  )
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_INBOUND_BYTES
  })

  const isWebSocketAuthorizationCurrent = (socket: WebSocket): boolean => {
    const authorization = externalSockets.get(socket)
    if (!authorization) return true
    try {
      if (authorization.isCurrent()) return true
    } catch {
      // A failed runtime authorization check is stale by default.
    }
    socket.close(1008, 'Remote access expired')
    return false
  }

  const sendCurrentWebSocketMessage = (socket: WebSocket, message: string): boolean =>
    isWebSocketAuthorizationCurrent(socket) && sendWebSocketMessage(socket, message)

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
      const auth = authenticateRequest(request, url, options.token)
      let authorized = auth.ok
      let externalAuthorization: ExternalWebAccessAuthorization | undefined
      if (!authorized && options.externalAccess) {
        const decision = await options.externalAccess.authorizeHttp(request, response, url)
        if (decision === 'handled') return
        authorized = typeof decision === 'object'
        if (typeof decision === 'object') {
          externalAuthorization = decision
        }
      }
      if (!authorized || (externalAuthorization && !externalAuthorization.isCurrent())) {
        response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Unauthorized')
        return
      }
      if (externalAuthorization) replayFloorFor(externalAuthorization.principalId)
      let clientNonce: string
      try {
        clientNonce = requestClientNonce(request)
      } catch (error) {
        if (error instanceof InvalidWebClientNonceError) {
          json(response, 400, { error: error.message })
          return
        }
        throw error
      }
      const clientId = externalAuthorization
        ? authorizedClientId(externalAuthorization.principalId, clientNonce)
        : clientNonce
      const clientPrincipalId = externalAuthorization
        ? `remote:${externalAuthorization.principalId}`
        : 'local'
      const requestBodyClientId = externalAuthorization?.principalId ?? clientId
      if (!hasValidUrlPathEncoding(url.pathname)) {
        json(response, 400, { error: 'Malformed URL encoding.' })
        return
      }
      if (auth.ok && auth.queryToken && request.method === 'GET' && url.pathname === '/') {
        persistAuthCookie(response, options.token)
        url.searchParams.delete('token')
        response.writeHead(302, { location: `${url.pathname}${url.search}${url.hash}` })
        response.end()
        return
      }

      if (url.pathname === '/api/bootstrap' && request.method === 'GET') {
        const rpcChannels = auth.ok
          ? options.applicationCommands.localWeb.commandNames()
          : options.applicationCommands.remoteWeb.commandNames()
        const restrictedRpcChannels = auth.ok
          ? []
          : options.applicationCommands.remoteWeb.rejectedCommandNames()
        json(response, 200, {
          ...(auth.ok ? options.bootstrap : remoteWebBootstrap(options.bootstrap)),
          rpcProtocolVersion: WEB_RPC_PROTOCOL_VERSION,
          rpcCapabilities: auth.ok ? WEB_RPC_CAPABILITIES : [],
          rpcChannels,
          eventStream: internalEventStream.cursor(),
          restrictedRpcChannels
        })
        return
      }

      if (url.pathname === '/api/shutdown' && request.method === 'POST') {
        if (!auth.ok) {
          json(response, 403, { ok: false, error: 'Shutdown is only available locally.' })
          return
        }
        if (!options.onShutdownRequest) {
          json(response, 404, { ok: false, error: 'Shutdown is not available.' })
          return
        }
        const onShutdownRequest = options.onShutdownRequest
        let shutdownScheduled = false
        const scheduleShutdown = (): void => {
          if (shutdownScheduled) return
          shutdownScheduled = true
          setImmediate(onShutdownRequest)
        }
        response.once('finish', scheduleShutdown)
        response.once('close', scheduleShutdown)
        json(response, 202, { ok: true })
        return
      }

      if (
        url.pathname.startsWith('/api/v1/') &&
        options.tasks &&
        (await handleTaskApiRequest(
          request,
          response,
          url,
          options.tasks,
          createTaskCallerContext({
            ...(externalAuthorization
              ? {
                  clientId,
                  location: 'remote' as const,
                  isAuthorizationCurrent: externalAuthorization.isCurrent
                }
              : {})
          }),
          clientPrincipalId,
          requestBodyClientId,
          requestBodyBudgetRegistry,
          taskIdempotencyRegistry,
          externalAuthorization
        ))
      ) {
        return
      }
      if (url.pathname.startsWith('/api/v1/')) {
        json(response, 404, {
          error: { code: 'not_found', message: 'Task API endpoint not found.' }
        })
        return
      }

      if (url.pathname.startsWith('/rpc/') && request.method === 'POST') {
        const channel = decodeURIComponent(url.pathname.slice('/rpc/'.length))
        if (!isWebRpcChannel(channel)) {
          webRpcError(response, 404, 'method_not_found', 'Web RPC method not found.')
          return
        }
        let body: unknown
        try {
          body = await readJsonBody(
            request,
            response,
            requestBodyBudgetRegistry,
            requestBodyClientId
          )
        } catch (error) {
          if (error instanceof RequestBodyBudgetExceededError) {
            webRpcError(
              response,
              error.dimension === 'request' ? 413 : error.dimension === 'client' ? 429 : 503,
              error.dimension === 'request' ? 'invalid_request' : 'handler_error',
              error.message
            )
            return
          }
          webRpcError(
            response,
            400,
            'invalid_request',
            error instanceof SyntaxError ? 'Request body must be valid JSON.' : String(error)
          )
          return
        }
        if (
          body &&
          typeof body === 'object' &&
          'protocolVersion' in body &&
          body.protocolVersion !== WEB_RPC_PROTOCOL_VERSION
        ) {
          webRpcError(
            response,
            426,
            'invalid_request',
            `Unsupported Web RPC protocol version. Expected ${WEB_RPC_PROTOCOL_VERSION}.`
          )
          return
        }
        const parsed = webRpcRequestSchema.safeParse(body)
        if (!parsed.success) {
          webRpcError(
            response,
            400,
            'invalid_request',
            'Request does not match the Web RPC schema.'
          )
          return
        }
        if (!auth.ok && REMOTE_LOCAL_ONLY_RPC_CHANNELS.has(channel)) {
          webRpcError(
            response,
            403,
            'method_not_found',
            `Channel only available from the local app: ${channel}`
          )
          return
        }
        const callerContext = createWebCallerContext(clientId, {
          ...(externalAuthorization
            ? {
                location: 'remote' as const,
                authorities:
                  externalAuthorization.kind === 'authorized-pairing-manager'
                    ? (['manage-remote-pairing'] as const)
                    : [],
                isAuthorizationCurrent: externalAuthorization.isCurrent
              }
            : {})
        })
        let clientLease: WebClientLease
        try {
          clientLease = webClientLeases.acquireHttp(clientPrincipalId, clientNonce, clientId)
        } catch (error) {
          if (error instanceof WebClientCapacityExceededError) {
            webRpcError(response, 429, 'handler_error', error.message)
            return
          }
          throw error
        }
        const releaseDisconnectedClient = (): void => clientLease.release(true)
        request.once('aborted', releaseDisconnectedClient)
        response.once('close', releaseDisconnectedClient)
        try {
          assertExternalAuthorizationCurrent(externalAuthorization)
          const dispatcher = auth.ok
            ? options.applicationCommands.localWeb
            : options.applicationCommands.remoteWeb
          const result = await commandClient.invoke(
            dispatcher,
            channel,
            callerContext,
            parsed.data.args
          )
          json(
            response,
            200,
            {
              protocolVersion: WEB_RPC_PROTOCOL_VERSION,
              ok: true,
              result: result ?? null
            },
            MAX_WEB_RPC_RESPONSE_BYTES
          )
        } catch (error) {
          log.warn('web rpc rejected', {
            channel,
            surface: callerContext.surface,
            location: callerContext.location,
            ...diagnosticErrorFields(error)
          })
          if (error instanceof ExternalAuthorizationExpiredError) {
            webRpcError(response, 401, 'invalid_request', error.message)
            return
          }
          if (error instanceof WebRpcResponseBudgetExceededError) {
            webRpcError(response, 500, 'handler_error', error.message)
            return
          }
          const publicError = publicApplicationCommandError(error)
          const status =
            error instanceof ApplicationCommandError ? applicationCommandErrorStatus(error) : 500
          webRpcError(response, status, publicError.code, publicError.message)
        } finally {
          request.off('aborted', releaseDisconnectedClient)
          response.off('close', releaseDisconnectedClient)
          clientLease.release()
        }
        return
      }

      if (
        url.pathname.startsWith('/preview/') &&
        (request.method === 'GET' || request.method === 'HEAD')
      ) {
        await streamPreview(request, response, url)
        return
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        await serveStatic(request, response, options.staticRoot, url.pathname)
        return
      }

      response.writeHead(404).end()
    } catch {
      json(response, 500, {
        error: INTERNAL_SERVER_ERROR_MESSAGE
      })
    } finally {
      requestBodyBudgetRegistry.release(request)
    }
  }
  const server = createServer((request, response) =>
    runWithDiagnosticCorrelation(() => handleRequest(request, response))
  )

  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
        const auth = authenticateRequest(request, url, options.token)
        const externalAuthorization =
          !auth.ok && options.externalAccess
            ? await options.externalAccess.authorizeWebSocket(request, url)
            : undefined
        if (
          (!auth.ok && (!externalAuthorization || !externalAuthorization.isCurrent())) ||
          !['/events', '/api/v1/events'].includes(url.pathname)
        ) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        try {
          parseClientNonce(url.searchParams.getAll('client'))
        } catch (error) {
          if (!(error instanceof InvalidWebClientNonceError)) throw error
          socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        wsServer.handleUpgrade(request, socket, head, (webSocket) => {
          if (externalAuthorization) {
            externalSockets.set(webSocket, externalAuthorization)
          }
          wsServer.emit('connection', webSocket, request)
        })
      } catch {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
      }
    })()
  })

  wsServer.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    const clientNonce = parseClientNonce(url.searchParams.getAll('client'))
    const externalAuthorization = externalSockets.get(socket)
    if (externalAuthorization && !externalAuthorization.isCurrent()) {
      externalSockets.delete(socket)
      socket.close(1008, 'Remote access expired')
      return
    }
    const replayFloor = externalAuthorization
      ? replayFloorFor(externalAuthorization.principalId)
      : undefined
    const clientId =
      externalAuthorization === undefined
        ? clientNonce
        : authorizedClientId(externalAuthorization.principalId, clientNonce)
    const clientPrincipalId =
      externalAuthorization === undefined ? 'local' : `remote:${externalAuthorization.principalId}`
    let lease: WebClientLease
    try {
      lease = webClientLeases.acquireSocket(clientPrincipalId, clientNonce, clientId)
    } catch (error) {
      if (error instanceof WebClientCapacityExceededError) {
        externalSockets.delete(socket)
        socket.close(1013, 'Too many active Web clients')
        return
      }
      throw error
    }
    let releaseApprovalPresence: (() => void) | undefined
    socket.on('close', () => {
      sockets.delete(socket)
      externalSockets.delete(socket)
      publicEventSockets.delete(socket)
      internalEventSockets.delete(socket)
      livenessSockets.delete(socket)
      releaseApprovalPresence?.()
      lease.release()
    })
    // This is a server-to-client event stream. `ws` performs the protocol close for oversized
    // messages before emitting `error`; consuming it here prevents an attacker-triggered exception.
    socket.on('error', () => undefined)
    socket.on('message', () => socket.close(1002, 'Inbound messages are not supported'))
    socket.on('pong', () => awaitingPong.delete(socket))
    if (url.searchParams.get('liveness') === '1') livenessSockets.add(socket)
    if (url.pathname === '/api/v1/events') {
      const requestedProtocol = url.searchParams.get('eventProtocol')
      if (requestedProtocol === null) {
        publicEventSockets.set(socket, 'legacy')
      } else if (requestedProtocol !== String(TASK_EVENT_STREAM_PROTOCOL_VERSION)) {
        socket.close(1002, 'Unsupported event stream protocol')
        return
      } else {
        publicEventSockets.set(socket, 'replay')
        const streamId = url.searchParams.get('stream')
        const afterValue = url.searchParams.get('after')
        const messages =
          streamId === null && afterValue === null
            ? [publicTaskEventStream.ready()]
            : publicTaskEventStream.resume(
                {
                  streamId: streamId ?? '',
                  after: afterValue === null ? Number.NaN : Number(afterValue)
                },
                replayFloor?.publicTaskAfter
              )
        for (const message of messages) {
          if (!sendCurrentWebSocketMessage(socket, message)) break
        }
      }
    } else {
      const requestedProtocol = url.searchParams.get('eventProtocol')
      // A page loaded before this server upgrade has no cursor query. Keep it live-only until its
      // next reload instead of breaking an already-open Web surface.
      if (requestedProtocol === null) {
        internalEventSockets.set(socket, 'legacy')
      } else if (requestedProtocol !== String(WEB_EVENT_STREAM_PROTOCOL_VERSION)) {
        socket.close(1002, 'Unsupported event stream protocol')
        return
      } else {
        internalEventSockets.set(socket, 'replay')
        const streamId = url.searchParams.get('stream') ?? ''
        const afterValue = url.searchParams.get('after')
        const after = afterValue === null ? Number.NaN : Number(afterValue)
        for (const message of internalEventStream.resume(
          { streamId, after },
          replayFloor?.internalAfter
        )) {
          if (!sendCurrentWebSocketMessage(socket, message)) break
        }
      }
      if (url.searchParams.get('liveness') !== '1') {
        releaseApprovalPresence = options.permissionApprovalPresence?.acquire()
      }
    }
    if (socket.readyState === WebSocket.OPEN) sockets.add(socket)
  })

  const removeBroadcastSink = options.applicationEvents.subscribe((event) => {
    const internalProjection = projectWebRendererEvent(event)
    const publicMessages = projectPublicTaskEvents(event, (sessionId, promptMessageId) =>
      options.tasks?.resolveActiveRun?.(sessionId, promptMessageId)
    ).map((projection) => publicTaskEventStream.publish(projection))
    const legacyInternalMessage = internalProjection
      ? JSON.stringify(internalProjection)
      : undefined
    const replayInternalMessage = internalProjection
      ? internalEventStream.publish(internalProjection)
      : undefined
    for (const socket of sockets) {
      if (publicEventSockets.has(socket)) {
        for (const publicMessage of publicMessages) {
          if (!sendCurrentWebSocketMessage(socket, publicMessage)) break
        }
      } else if (internalEventSockets.get(socket) === 'replay') {
        if (replayInternalMessage) sendCurrentWebSocketMessage(socket, replayInternalMessage)
      } else if (legacyInternalMessage) {
        sendCurrentWebSocketMessage(socket, legacyInternalMessage)
      }
    }
  })
  const removeTaskProgressSink = options.tasks?.subscribeProgress((event) => {
    const message = publicTaskEventStream.publish(projectPublicTaskProgressEvent(event))
    for (const socket of publicEventSockets.keys()) {
      sendCurrentWebSocketMessage(socket, message)
    }
  })

  try {
    await new Promise<void>((resolveListening, reject) => {
      server.once('error', reject)
      server.listen(options.port, options.host, () => {
        server.off('error', reject)
        resolveListening()
      })
    })
  } catch (error) {
    taskIdempotencyRegistry.clear()
    removeBroadcastSink()
    removeTaskProgressSink?.()
    try {
      webClientLeases.dispose()
    } finally {
      commandClient.dispose()
    }
    throw error
  }

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  const eventHeartbeatInterval = setInterval(() => {
    const publicHeartbeat = JSON.stringify({
      type: 'connection.heartbeat',
      data: { timestamp: Date.now() }
    })
    const internalHeartbeat = internalEventStream.heartbeat()
    for (const socket of livenessSockets) {
      if (socket.readyState !== WebSocket.OPEN) continue
      if (!isWebSocketAuthorizationCurrent(socket)) continue
      if (awaitingPong.has(socket)) {
        socket.terminate()
        continue
      }
      awaitingPong.add(socket)
      socket.ping()
      if (publicEventSockets.has(socket)) sendCurrentWebSocketMessage(socket, publicHeartbeat)
      else if (internalEventSockets.has(socket)) {
        sendCurrentWebSocketMessage(socket, internalHeartbeat)
      }
    }
  }, options.eventHeartbeatIntervalMs ?? DEFAULT_EVENT_HEARTBEAT_INTERVAL_MS)

  return {
    port,
    closeExternalConnections: (principalId) => {
      if (principalId === undefined) remoteReplayFloors.clear()
      else remoteReplayFloors.delete(principalId)
      for (const [socket, authorization] of externalSockets) {
        if (principalId === undefined || authorization.principalId === principalId) {
          socket.close(1008, 'Remote access revoked')
        }
      }
    },
    close: async () => {
      taskIdempotencyRegistry.clear()
      remoteReplayFloors.clear()
      clearInterval(eventHeartbeatInterval)
      removeBroadcastSink()
      removeTaskProgressSink?.()
      for (const socket of sockets) socket.close()
      wsServer.close()
      // Stop accepting connections before force-closing handlers that ignore caller cancellation.
      const closePromise = new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      let cleanupError: unknown
      try {
        webClientLeases.dispose()
      } catch (error) {
        cleanupError = error
      } finally {
        try {
          commandClient.dispose()
        } catch (error) {
          cleanupError = cleanupError
            ? new AggregateError([cleanupError, error], 'Web command client cleanup failed.')
            : error
        }
      }
      server.closeAllConnections()
      await closePromise
      if (cleanupError) throw cleanupError
    }
  }
}

export { startWebHttpServer }
