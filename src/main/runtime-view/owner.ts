import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import type { Socket } from 'node:net'
import { Transform } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type {
  RuntimeViewAccess,
  RuntimeViewDescriptor,
  RuntimeViewScope
} from '../../shared/runtime-view'
import { isRuntimeViewPath } from '../../shared/runtime-view'
import { OwnedRuntimeViewService, sameRuntimeViewScope } from './owned-service'
import type {
  ObservationFramePort,
  ObservationFrameRegistration
} from '../observation-desktop/frame-port'

interface RuntimeViewLimits {
  maxViews: number
  maxConnections: number
  maxRequests: number
  maxRequestBytes: number
  maxResponseBytes: number
  maxStreamBytes: number
  maxWebSocketMessageBytes: number
  requestTimeoutMs: number
  lifetimeMs: number
}
export interface OpenRuntimeViewOptions {
  scope: RuntimeViewScope
  service: OwnedRuntimeViewService
  title: string
  entryPath?: string
  allowedParentOrigins: readonly string[]
  /** Application-specific headers, such as a project's own CSRF header; never management headers. */
  allowedRequestHeaders?: readonly string[]
  webSocketProtocols?: readonly string[]
  /** Partitioned is for a cross-site embedded viewer; support requires a real host test. */
  cookiePolicy?: 'strict' | 'partitioned'
  /** Explicit per-run compatibility consent. Only framing directives change; other CSP survives. */
  adaptFrameAncestors?: boolean
  /** Main-owned viewer lease check; never accepted in a public project declaration. */
  assertAuthorized?(): void
}
interface ViewRecord {
  descriptor: RuntimeViewDescriptor
  service: OwnedRuntimeViewService
  assertAuthorized(): void
  server: Server
  origin: string
  entryPath: string
  parents: readonly string[]
  grants: Map<string, number>
  requestHeaders: readonly string[]
  protocols: ReadonlySet<string>
  cookiePolicy: 'strict' | 'partitioned'
  cookie: string
  credential: string
  active: Set<() => void>
  sockets: Set<Socket>
  requests: number
  expiry?: ReturnType<typeof setTimeout>
  onAbort: () => void
  webSockets: WebSocketServer
  desktopFrames?: ObservationFrameRegistration
}
const defaults: RuntimeViewLimits = {
  maxViews: 8,
  maxConnections: 12,
  maxRequests: 20000,
  maxRequestBytes: 1024 * 1024,
  maxResponseBytes: 16 * 1024 * 1024,
  maxStreamBytes: 64 * 1024 * 1024,
  maxWebSocketMessageBytes: 512 * 1024,
  requestTimeoutMs: 30000,
  lifetimeMs: 60 * 60 * 1000
}
const allowedRequestHeaders = [
  'accept',
  'accept-language',
  'content-type',
  'if-none-match',
  'if-modified-since',
  'range',
  'last-event-id'
]
const allowedResponseHeaders = [
  'content-type',
  'content-length',
  'content-encoding',
  'etag',
  'last-modified',
  'accept-ranges',
  'content-range',
  'content-disposition',
  'content-security-policy',
  'x-frame-options'
]
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
function equalSecret(actual: string | undefined, expected: string): boolean {
  if (!actual || actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}
function safePath(raw: string): string | undefined {
  return isRuntimeViewPath(raw) ? raw : undefined
}
function publicError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer'
  })
  response.end(message)
}
function normalizeParent(value: string): string {
  if (value === 'file:') return value
  const parsed = new URL(value)
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.origin !== value ||
    parsed.hostname.includes('*') ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('Runtime view parent must be an explicit HTTP origin.')
  }
  return value
}

function declaredHeaders(names: readonly string[]): string[] {
  if (
    names.length > 16 ||
    names.some(
      (name) =>
        !/^x-[a-z0-9-]{1,80}$/.test(name) ||
        /^x-(?:forwarded|proxy|open-science|os-runtime)/.test(name)
    )
  ) {
    throw new Error('Invalid project header declaration.')
  }
  return [...new Set([...allowedRequestHeaders, ...names])]
}

function responsePolicies(response: IncomingMessage, adapted: boolean): string[] {
  // Preserve separately delivered policies. Flattening them changes their intersection semantics.
  return response.rawHeaders.flatMap((name, index, headers) => {
    if (index % 2 || name.toLowerCase() !== 'content-security-policy') return []
    const value = headers[index + 1]
    return adapted
      ? value
          .split(',')
          .map((policy) =>
            policy
              .split(';')
              .filter((part) => !/^\s*frame-ancestors(?:\s|$)/i.test(part))
              .join(';')
          )
          .filter((policy) => policy.trim())
      : [value]
  })
}

/** Isolated origins for interactive project pages. No management API, filesystem or global token. */
export class RuntimeViewOwner {
  private readonly views = new Map<string, ViewRecord>()
  private readonly limits: RuntimeViewLimits
  private closed = false

  constructor(
    limits: Partial<RuntimeViewLimits> = {},
    private readonly desktopFrames?: ObservationFramePort
  ) {
    this.limits = { ...defaults, ...limits }
    if (Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value < 1)) {
      throw new Error('Invalid runtime view limits.')
    }
  }

  async open(options: OpenRuntimeViewOptions): Promise<RuntimeViewAccess> {
    if (this.closed) throw new Error('Runtime view owner is closed.')
    OwnedRuntimeViewService.assertOwned(options.service, options.scope)
    options.assertAuthorized?.()
    if (
      [...this.views.values()].filter((view) => view.descriptor.state === 'ready').length >=
      this.limits.maxViews
    ) {
      throw new Error('Too many active runtime views.')
    }
    const entryPath = safePath(options.entryPath ?? '/')
    if (
      !entryPath ||
      !options.service.permitsPath(entryPath) ||
      !options.title ||
      options.title.length > 256 ||
      !options.allowedParentOrigins.length ||
      options.allowedParentOrigins.length > 4
    ) {
      throw new Error('Invalid runtime view configuration.')
    }
    const parents = Object.freeze([...new Set(options.allowedParentOrigins.map(normalizeParent))])
    if (parents.includes('file:') && options.adaptFrameAncestors !== true) {
      throw new Error('Desktop frame embedding requires explicit compatibility opt-in.')
    }
    const requestHeaders = Object.freeze(declaredHeaders(options.allowedRequestHeaders ?? []))
    const protocols = new Set(options.webSocketProtocols ?? [])
    if (
      protocols.size > 8 ||
      [...protocols].some((value) => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/.test(value)) ||
      (options.cookiePolicy !== undefined &&
        !['strict', 'partitioned'].includes(options.cookiePolicy))
    )
      throw new Error('Invalid project transport declaration.')
    // Closed descriptors are a bounded diagnostic cache, not durable research history.
    while (this.views.size >= this.limits.maxViews * 16) {
      const stale = [...this.views.values()].find((view) => view.descriptor.state !== 'ready')
      if (!stale) break
      this.views.delete(stale.descriptor.viewId)
    }
    const viewId = randomUUID()
    const server = createServer((request, response) => {
      void this.handle(viewId, request, response)
    })
    server.maxHeadersCount = 64
    server.headersTimeout = 10000
    server.requestTimeout = this.limits.requestTimeoutMs
    const webSockets = new WebSocketServer({
      noServer: true,
      maxPayload: this.limits.maxWebSocketMessageBytes,
      perMessageDeflate: false
    })
    const now = Date.now()
    const view: ViewRecord = {
      descriptor: {
        viewId,
        scope: Object.freeze({ ...options.scope }),
        title: options.title,
        state: 'ready',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.limits.lifetimeMs).toISOString(),
        embeddingAdapted: options.adaptFrameAncestors === true
      },
      service: options.service,
      assertAuthorized: options.assertAuthorized ?? (() => undefined),
      server,
      webSockets,
      origin: '',
      entryPath,
      parents,
      cookie: `os_runtime_view_${viewId.replaceAll('-', '')}`,
      credential: randomBytes(32).toString('hex'),
      active: new Set(),
      sockets: new Set(),
      requests: 0,
      grants: new Map(),
      requestHeaders,
      protocols,
      cookiePolicy: options.cookiePolicy ?? 'strict',
      onAbort: () => this.closeRecord(view, 'closed', 'run-ended')
    }
    this.views.set(viewId, view)
    options.service.signal.addEventListener('abort', view.onAbort, { once: true })
    server.on('connection', (socket) => {
      if (
        view.descriptor.state !== 'ready' ||
        view.sockets.size >= this.limits.maxConnections * 2
      ) {
        socket.destroy()
        return
      }
      view.sockets.add(socket)
      socket.once('close', () => view.sockets.delete(socket))
    })
    server.on('upgrade', (request, socket, head) => {
      void this.upgrade(view, request, socket as Socket, head)
    })
    server.on('clientError', (_error, socket) => socket.destroy())
    try {
      await new Promise<void>((resolve, reject) => {
        const onClose = (): void => reject(new Error('Runtime view closed during startup.'))
        server.once('close', onClose)
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject)
          server.removeListener('close', onClose)
          if (this.closed || view.descriptor.state !== 'ready') {
            server.close()
            reject(new Error('Runtime view closed during startup.'))
          } else resolve()
        })
      })
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Runtime view listener unavailable.')
      // A never-reused hostname keeps browser storage/cookies and old documents isolated even
      // after the operating system reassigns a released TCP port to another view generation.
      view.origin = `http://rv-${viewId}.localhost:${address.port}`
      OwnedRuntimeViewService.assertOwned(options.service, options.scope)
      view.desktopFrames = await this.desktopFrames?.registerRuntime({
        excludedPath: view.service.excludedPath,
        origin: view.origin,
        parents: view.parents,
        expiresAt: now + this.limits.lifetimeMs,
        assertCurrent: () => {
          this.assertAuthorization(view)
          view.service.assertCurrent()
        },
        allowsPath: (path) => !!safePath(path) && view.service.permitsPath(path)
      })
      view.expiry = setTimeout(
        () => this.closeRecord(view, 'closed', 'expired'),
        this.limits.lifetimeMs
      )
      view.expiry.unref()
      return await this.issueAccess(viewId, options.scope)
    } catch (error) {
      this.closeRecord(view, 'failed', 'unavailable')
      throw error
    }
  }

  list(
    scope: Pick<RuntimeViewScope, 'projectId' | 'sessionId' | 'runId'>
  ): RuntimeViewDescriptor[] {
    return [...this.views.values()]
      .filter(
        (view) =>
          view.descriptor.scope.projectId === scope.projectId &&
          view.descriptor.scope.sessionId === scope.sessionId &&
          view.descriptor.scope.runId === scope.runId
      )
      .map((view) => this.describe(view))
  }

  async issueAccess(viewId: string, scope: RuntimeViewScope): Promise<RuntimeViewAccess> {
    const view = this.require(viewId, scope)
    this.assertAuthorization(view)
    view.service.assertCurrent()
    if (view.descriptor.state !== 'ready') throw new Error('Runtime view is closed.')
    for (const [grant, expiry] of view.grants) if (expiry < Date.now()) view.grants.delete(grant)
    if (view.grants.size >= 8) throw new Error('Too many pending runtime view grants.')
    const grant = randomBytes(32).toString('hex')
    const expiresAt = Date.now() + 60000
    const url = `${view.origin}/__open_science_view?grant=${grant}`
    view.grants.set(grant, expiresAt)
    await view.desktopFrames?.issueGrant(url, expiresAt)
    this.assertAuthorization(view)
    view.service.assertCurrent()
    return { view: this.describe(view), url }
  }

  revoke(viewId: string, scope: RuntimeViewScope): void {
    this.closeRecord(this.require(viewId, scope), 'closed', 'revoked')
  }

  close(): void {
    this.closed = true
    for (const view of this.views.values()) this.closeRecord(view, 'closed', 'owner-closed')
    this.views.clear()
  }

  private require(viewId: string, scope: RuntimeViewScope): ViewRecord {
    const view = this.views.get(viewId)
    if (!view || !sameRuntimeViewScope(view.descriptor.scope, scope))
      throw new Error('Runtime view not found in this scope.')
    return view
  }
  private describe(view: ViewRecord): RuntimeViewDescriptor {
    return { ...view.descriptor, scope: { ...view.descriptor.scope } }
  }
  private closeRecord(view: ViewRecord, state: 'closed' | 'failed', reason: string): void {
    if (view.descriptor.state !== 'ready') return
    view.descriptor = { ...view.descriptor, state, closedReason: reason }
    view.desktopFrames?.close()
    view.grants.clear()
    if (view.expiry) clearTimeout(view.expiry)
    view.service.signal.removeEventListener('abort', view.onAbort)
    for (const close of view.active) close()
    view.active.clear()
    for (const socket of view.webSockets.clients) socket.terminate()
    view.webSockets.close()
    view.server.closeAllConnections()
    for (const socket of view.sockets) socket.destroy()
    view.server.close()
  }
  private assertAuthorization(view: ViewRecord): void {
    if (view.descriptor.state !== 'ready') throw new Error('Runtime view is closed.')
    try {
      view.assertAuthorized()
    } catch (error) {
      this.closeRecord(view, 'closed', 'authorization-revoked')
      throw error
    }
  }
  private authorize(view: ViewRecord, request: IncomingMessage): string {
    this.assertAuthorization(view)
    if (view.descriptor.state !== 'ready') throw new Error('Runtime view is closed.')
    view.service.assertCurrent()
    if (request.headers.host !== new URL(view.origin).host)
      throw new Error('Invalid runtime view host.')
    const path = safePath(request.url ?? '')
    if (!path || path.startsWith('/__open_science_view') || !view.service.permitsPath(path))
      throw new Error('Runtime view path is unavailable.')
    const origin = request.headers.origin
    if (origin !== undefined && origin !== view.origin)
      throw new Error('Cross-origin project request rejected.')
    if (!['GET', 'HEAD'].includes(request.method ?? '') && origin !== view.origin)
      throw new Error('Project mutations require the project origin.')
    const cookie = request.headers.cookie
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${view.cookie}=`))
      ?.slice(view.cookie.length + 1)
    if (!equalSecret(cookie, view.credential))
      throw new Error('Runtime view access is not authorized.')
    if (++view.requests > this.limits.maxRequests || view.active.size >= this.limits.maxConnections)
      throw new Error('Runtime view request budget exceeded.')
    return path
  }
  private async handle(
    id: string,
    incoming: IncomingMessage,
    outgoing: ServerResponse
  ): Promise<void> {
    const view = this.views.get(id)
    if (!view) {
      publicError(outgoing, 410, 'Runtime view has ended.')
      return
    }
    const bootstrap = incoming.url?.startsWith('/__open_science_view?')
    if (bootstrap) {
      const grant = new URL(incoming.url!, view.origin).searchParams.get('grant') ?? undefined
      try {
        this.assertAuthorization(view)
        view.service.assertCurrent()
      } catch {
        publicError(outgoing, 410, 'Runtime view has ended.')
        return
      }
      const expiry = grant && view.grants.get(grant)
      if (
        view.descriptor.state !== 'ready' ||
        incoming.method !== 'GET' ||
        incoming.headers.host !== new URL(view.origin).host ||
        !grant ||
        !expiry ||
        expiry < Date.now() ||
        (incoming.headers.origin &&
          !view.parents.includes(incoming.headers.origin) &&
          incoming.headers.origin !== view.origin)
      ) {
        publicError(outgoing, 403, 'Runtime view access is not authorized.')
        return
      }
      view.grants.delete(grant)
      await view.desktopFrames?.authenticateGrant(grant)
      this.assertAuthorization(view)
      view.service.assertCurrent()
      const cookiePolicy =
        view.cookiePolicy === 'partitioned'
          ? 'Secure; SameSite=None; Partitioned'
          : 'SameSite=Strict'
      outgoing.writeHead(303, {
        location: view.entryPath,
        'set-cookie': `${view.cookie}=${view.credential}; HttpOnly; ${cookiePolicy}; Path=/`,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer'
      })
      outgoing.end()
      return
    }
    let path: string
    try {
      path = this.authorize(view, incoming)
    } catch {
      publicError(outgoing, 403, 'Runtime view access is not authorized.')
      return
    }
    if (!methods.has(incoming.method ?? '')) {
      publicError(outgoing, 405, 'Unsupported project request.')
      return
    }
    if (Number(incoming.headers['content-length'] ?? 0) > this.limits.maxRequestBytes) {
      publicError(outgoing, 413, 'Project request is too large.')
      incoming.resume()
      return
    }
    let close: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let ended = false
    const cleanup = (): void => {
      ended = true
      if (timer) clearTimeout(timer)
      close?.()
      view.active.delete(reservation)
    }
    const reservation = (): void => {
      cleanup()
      incoming.destroy()
      outgoing.destroy()
    }
    view.active.add(reservation)
    outgoing.once('close', cleanup)
    incoming.once('aborted', reservation)
    try {
      const connection = await view.service.connect()
      close = connection.close
      if (ended || outgoing.destroyed || view.descriptor.state !== 'ready') {
        connection.close()
        cleanup()
        return
      }
      this.assertAuthorization(view)
      const upstream = new URL(connection.origin)
      const headers: Record<string, string | string[]> = {
        host: upstream.host,
        origin: upstream.origin
      }
      for (const name of view.requestHeaders)
        if (incoming.headers[name]) headers[name] = incoming.headers[name]!
      const pending = request(
        { ...connection.requestOptions, path, method: incoming.method, headers },
        (response) => {
          try {
            this.assertAuthorization(view)
            view.service.assertCurrent()
            const resultHeaders: Record<string, string | string[]> = {
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
              'x-content-type-options': 'nosniff',
              'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
            }
            for (const name of allowedResponseHeaders)
              if (response.headers[name]) resultHeaders[name] = response.headers[name]!
            const location = response.headers.location
            if (location) {
              const redirected = new URL(location, upstream)
              if (
                redirected.origin !== upstream.origin ||
                !safePath(redirected.pathname + redirected.search) ||
                !view.service.permitsPath(redirected.pathname)
              )
                throw new Error('External project redirect rejected.')
              resultHeaders.location = redirected.pathname + redirected.search
            }
            if (view.descriptor.embeddingAdapted) {
              delete resultHeaders['x-frame-options']
            }
            resultHeaders['content-security-policy'] = [
              ...responsePolicies(response, view.descriptor.embeddingAdapted),
              `frame-ancestors ${view.parents.join(' ')}; default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; form-action 'self'; worker-src 'none'; object-src 'none'; base-uri 'self'`
            ]
            const stream =
              response.headers['content-type']?.startsWith('text/event-stream') === true
            let received = 0
            const maxBytes = stream ? this.limits.maxStreamBytes : this.limits.maxResponseBytes
            const assertAuthorized = (): void => this.assertAuthorization(view)
            const bounded = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                try {
                  assertAuthorized()
                } catch {
                  callback(new Error('Runtime view authorization ended.'))
                  return
                }
                received += chunk.length
                if (received > maxBytes) callback(new Error('Project response budget exceeded.'))
                else callback(null, chunk)
              }
            })
            bounded.once('error', () => {
              pending.destroy()
              outgoing.destroy()
            })
            response.on('error', () => outgoing.destroy())
            outgoing.writeHead(response.statusCode ?? 502, resultHeaders)
            response.pipe(bounded).pipe(outgoing)
          } catch {
            response.destroy()
            publicError(outgoing, 502, 'Project response is unavailable.')
            connection.close()
          }
        }
      )
      close = (): void => {
        pending.destroy()
        connection.close()
      }
      timer = setTimeout(
        () => pending.destroy(new Error('Project request timed out.')),
        this.limits.requestTimeoutMs
      )
      pending.once('response', (response) => {
        if (response.headers['content-type']?.startsWith('text/event-stream')) clearTimeout(timer)
      })
      pending.on('error', () => publicError(outgoing, 502, 'Project service is unavailable.'))
      let sent = 0
      const maxRequestBytes = this.limits.maxRequestBytes
      const assertAuthorized = (): void => this.assertAuthorization(view)
      const bounded = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          try {
            assertAuthorized()
          } catch {
            callback(new Error('Runtime view authorization ended.'))
            return
          }
          sent += chunk.length
          if (sent > maxRequestBytes) callback(new Error('Project request budget exceeded.'))
          else callback(null, chunk)
        }
      })
      bounded.once('error', () => {
        publicError(outgoing, 413, 'Project request is too large.')
        pending.destroy()
        incoming.unpipe(bounded)
        incoming.resume()
      })
      incoming.pipe(bounded).pipe(pending)
    } catch {
      cleanup()
      publicError(outgoing, 502, 'Project service is unavailable.')
    }
  }

  private async upgrade(
    view: ViewRecord,
    incoming: IncomingMessage,
    socket: Socket,
    head: Buffer
  ): Promise<void> {
    let close: (() => void) | undefined
    const reservation = (): void => {
      close?.()
      socket.destroy()
    }
    const cleanup = (): void => {
      close?.()
      view.active.delete(reservation)
    }
    socket.once('close', cleanup)
    try {
      const path = this.authorize(view, incoming)
      const protocols =
        incoming.headers['sec-websocket-protocol']?.split(',').map((value) => value.trim()) ?? []
      if (
        incoming.method !== 'GET' ||
        incoming.headers.origin !== view.origin ||
        protocols.some((value) => !view.protocols.has(value))
      )
        throw new Error('Unsupported project WebSocket handshake.')
      view.active.add(reservation)
      const connection = await view.service.connect()
      close = connection.close
      if (socket.destroyed || view.descriptor.state !== 'ready')
        throw new Error('Runtime view ended.')
      this.assertAuthorization(view)
      const headers: Record<string, string | string[]> = {}
      for (const name of view.requestHeaders)
        if (incoming.headers[name]) headers[name] = incoming.headers[name]!
      const upstream = new WebSocket(
        `${connection.origin.replace(/^http:/, 'ws:')}${path}`,
        protocols,
        {
          ...connection.requestOptions,
          headers,
          origin: connection.origin,
          maxPayload: this.limits.maxWebSocketMessageBytes,
          perMessageDeflate: false,
          handshakeTimeout: 5000
        }
      )
      close = (): void => {
        upstream.terminate()
        connection.close()
      }
      upstream.once('error', () => socket.destroy())
      upstream.once('open', () => {
        try {
          this.assertAuthorization(view)
          view.service.assertCurrent()
        } catch {
          reservation()
          return
        }
        // Echo exactly the upstream-selected protocol, never independently pick another one.
        if (upstream.protocol) incoming.headers['sec-websocket-protocol'] = upstream.protocol
        else delete incoming.headers['sec-websocket-protocol']
        view.webSockets.handleUpgrade(incoming, socket, head, (client) => {
          let transferred = 0
          const forward = (
            target: WebSocket,
            data: Buffer | Buffer[] | ArrayBuffer,
            binary: boolean
          ): void => {
            try {
              this.assertAuthorization(view)
            } catch {
              reservation()
              return
            }
            const bytes = Buffer.isBuffer(data)
              ? data
              : Array.isArray(data)
                ? Buffer.concat(data)
                : Buffer.from(data)
            transferred += bytes.length
            if (
              transferred > this.limits.maxStreamBytes ||
              target.bufferedAmount > this.limits.maxWebSocketMessageBytes * 2 ||
              target.readyState !== WebSocket.OPEN
            ) {
              client.terminate()
              upstream.terminate()
              return
            }
            target.send(bytes, { binary })
          }
          client.on('message', (data, binary) => forward(upstream, data, binary))
          upstream.on('message', (data, binary) => forward(client, data, binary))
          client.once('close', () => upstream.close())
          upstream.once('close', () => client.close())
          client.on('error', () => upstream.terminate())
          upstream.on('error', () => client.terminate())
        })
      })
    } catch {
      cleanup()
      socket.destroy()
    }
  }
}
export type { RuntimeViewLimits }
