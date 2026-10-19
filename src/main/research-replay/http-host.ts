import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Socket } from 'node:net'
import { z } from 'zod'
import type { CallerContext } from '../caller-context'
import type { ResearchReplayAccess } from '../../shared/research-replay'
import { ResearchReplayService, ResearchReplayError } from './service'

type Asset = { body: Uint8Array; mimeType: string }
type Binding = {
  access: ResearchReplayAccess
  caller: CallerContext
  server: Server
  grant: string
  grantExpiresAt: number
  capability: string
  cookie: string
  origin: string
  sockets: Set<Socket>
  requests: number
  active: number
  timer: ReturnType<typeof setInterval>
}
const equal = (left: string, right: string): boolean =>
  Buffer.byteLength(left) === Buffer.byteLength(right) &&
  timingSafeEqual(Buffer.from(left), Buffer.from(right))
const empty = z.object({}).strict()
const headers = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff'
}
function json(response: ServerResponse, value: unknown): void {
  const body = JSON.stringify(value)
  if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new ResearchReplayError('oversized', 413)
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...headers })
  response.end(body)
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? ''))
    throw new ResearchReplayError('invalid')
  const chunks: Buffer[] = []
  let size = 0
  for await (const part of request) {
    const chunk = Buffer.from(part)
    size += chunk.length
    if (size > 8192) throw new ResearchReplayError('oversized', 413)
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ResearchReplayError('invalid')
  }
}
/** Session-scoped, read-only origin. It cannot dispatch execution, management, or filesystem APIs. */
export class ResearchReplayHttpHost {
  private readonly bindings = new Map<string, Binding>()
  private closed = false
  constructor(
    readonly service: ResearchReplayService,
    private readonly readAsset: (path: string) => Promise<Asset | undefined>
  ) {}
  async open(target: unknown, caller: CallerContext): Promise<ResearchReplayAccess> {
    if (this.closed) throw new ResearchReplayError('unavailable', 410)
    const descriptor = await this.service.open(target, caller)
    let binding: Binding
    const server = createServer((request, response) => {
      void this.handle(binding, request, response)
    })
    const sockets = new Set<Socket>()
    server.maxHeadersCount = 64
    server.headersTimeout = 10000
    server.requestTimeout = 15000
    server.on('connection', (socket) => {
      if (sockets.size >= 32) {
        socket.destroy()
        return
      }
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    server.on('clientError', (_error, socket) => socket.destroy())
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new ResearchReplayError('unavailable', 503)
      const origin = `http://viewer-${descriptor.viewerId}.localhost:${address.port}`,
        grant = randomBytes(32).toString('base64url')
      const access: ResearchReplayAccess = {
        ...descriptor,
        mode: 'research',
        url: `${origin}/__open_science_viewer?grant=${grant}`
      }
      binding = {
        access,
        caller,
        server,
        sockets,
        origin,
        grant,
        grantExpiresAt: Date.now() + 60000,
        capability: randomBytes(32).toString('base64url'),
        cookie: `os_research_${descriptor.viewerId.replaceAll('-', '')}`,
        requests: 0,
        active: 0,
        timer: setInterval(() => {
          if (!caller.isAuthorizationCurrent() || Date.now() >= descriptor.expiresAt)
            this.closeViewer(descriptor.viewerId)
        }, 500)
      }
      binding.timer.unref()
      this.bindings.set(descriptor.viewerId, binding)
      await this.service.read(descriptor.viewerId, { kind: 'overview' }, caller)
      return access
    } catch (error) {
      this.closeViewer(descriptor.viewerId)
      this.service.discard(descriptor.viewerId)
      server.closeAllConnections()
      server.close()
      await this.service.revoke(descriptor.viewerId, caller).catch(() => undefined)
      throw error
    }
  }
  private current(binding: Binding): void {
    if (
      this.closed ||
      this.bindings.get(binding.access.viewerId) !== binding ||
      binding.access.expiresAt <= Date.now()
    )
      throw new ResearchReplayError('unavailable', 410)
    if (!binding.caller.isAuthorizationCurrent()) throw new ResearchReplayError('unauthorized', 401)
  }
  closeViewer(viewerId: string): void {
    const row = this.bindings.get(viewerId)
    if (!row) return
    this.bindings.delete(viewerId)
    this.service.discard(viewerId)
    clearInterval(row.timer)
    for (const socket of row.sockets) socket.destroy()
    row.server.closeAllConnections()
    row.server.close()
  }
  close(): void {
    this.closed = true
    for (const id of this.bindings.keys()) this.closeViewer(id)
    this.service.close()
  }
  private async handle(
    binding: Binding | undefined,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    let reserved = false
    const timeout = setTimeout(() => response.destroy(), 30000)
    timeout.unref()
    try {
      if (!binding) throw new ResearchReplayError('unavailable', 410)
      this.current(binding)
      if (request.headers.host !== new URL(binding.origin).host)
        throw new ResearchReplayError('forbidden', 403)
      const raw = request.url ?? ''
      if (!raw.startsWith('/') || raw.startsWith('//') || raw.length > 2048 || raw.includes('\\'))
        throw new ResearchReplayError('invalid')
      let decoded: string
      try {
        decoded = decodeURIComponent(raw.split('?')[0])
      } catch {
        throw new ResearchReplayError('invalid')
      }
      if (
        decoded.split('/').some((part) => part === '.' || part === '..') ||
        [...decoded].some((character) => character === '\\' || character.charCodeAt(0) < 32)
      )
        throw new ResearchReplayError('invalid')
      const url = new URL(raw, binding.origin)
      if (++binding.requests > 20000 || binding.active >= 16)
        throw new ResearchReplayError('unavailable', 429)
      binding.active++
      reserved = true
      if (url.pathname === '/__open_science_viewer') {
        if (
          request.method !== 'GET' ||
          [...url.searchParams.keys()].some((key) => key !== 'grant') ||
          url.searchParams.getAll('grant').length !== 1 ||
          !binding.grant ||
          binding.grantExpiresAt < Date.now() ||
          !equal(url.searchParams.get('grant') ?? '', binding.grant)
        )
          throw new ResearchReplayError('unauthorized', 401)
        await this.service.read(binding.access.viewerId, { kind: 'overview' }, binding.caller)
        this.current(binding)
        binding.grant = ''
        response.writeHead(303, {
          ...headers,
          location: '/',
          'set-cookie': `${binding.cookie}=${binding.capability}; HttpOnly; Secure; SameSite=None; Partitioned; Path=/`
        })
        response.end()
        return
      }
      if (
        (request.headers.origin !== undefined && request.headers.origin !== binding.origin) ||
        (!['GET', 'HEAD'].includes(request.method ?? '') &&
          request.headers.origin !== binding.origin)
      )
        throw new ResearchReplayError('forbidden', 403)
      const capability =
        request.headers.cookie
          ?.split(';')
          .map((item) => item.trim())
          .find((item) => item.startsWith(`${binding.cookie}=`))
          ?.slice(binding.cookie.length + 1) ?? ''
      if (!equal(capability, binding.capability)) throw new ResearchReplayError('unauthorized', 401)
      const viewerId = binding.access.viewerId,
        caller = binding.caller
      // Every request checks the original lease and receiving Session, including static assets.
      await this.service.read(viewerId, { kind: 'overview' }, caller)
      this.current(binding)
      if (url.pathname === '/api/context' && request.method === 'GET') {
        if (url.search) throw new ResearchReplayError('invalid')
        const { mode, viewerId: contextViewerId, target, expiresAt } = binding.access
        const access = { mode, viewerId: contextViewerId, target, expiresAt }
        json(response, {
          ...access,
          presentation: 'browser',
          canInteract: false,
          canCancel: false,
          canReadArtifacts: true
        })
        return
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/research/') && !url.search) {
        const input = await body(request)
        const result =
          url.pathname === '/api/research/document'
            ? (empty.parse(input), await this.service.document(viewerId, caller))
            : url.pathname === '/api/research/read'
              ? await this.service.read(viewerId, input, caller)
              : url.pathname === '/api/research/select'
                ? await this.service.select(viewerId, input, caller)
                : url.pathname === '/api/research/selection'
                  ? (empty.parse(input), await this.service.selection(viewerId, caller))
                  : undefined
        if (result === undefined) throw new ResearchReplayError('not-found', 404)
        this.current(binding)
        json(response, result)
        return
      }
      if (!['GET', 'HEAD'].includes(request.method ?? ''))
        throw new ResearchReplayError('forbidden', 403)
      let asset: Asset | undefined,
        isResource = false
      if (url.pathname === '/api/research/media') {
        if (
          [...url.searchParams.keys()].some((key) => !['recordingId', 'mediaKey'].includes(key)) ||
          url.searchParams.getAll('recordingId').length !== 1 ||
          url.searchParams.getAll('mediaKey').length !== 1
        )
          throw new ResearchReplayError('invalid')
        asset = await this.service.media(
          viewerId,
          url.searchParams.get('recordingId')!,
          url.searchParams.get('mediaKey')!,
          caller
        )
        isResource = true
      } else if (url.pathname === '/api/research/resource') {
        if (
          [...url.searchParams.keys()].some((key) => key !== 'resourceId') ||
          url.searchParams.getAll('resourceId').length !== 1
        )
          throw new ResearchReplayError('invalid')
        asset = await this.service.resource(viewerId, url.searchParams.get('resourceId')!, caller)
        isResource = true
      } else {
        if (url.search) throw new ResearchReplayError('invalid')
        const path =
          url.pathname === '/'
            ? 'index.html'
            : url.pathname === '/favicon.ico'
              ? 'favicon.ico'
              : /^\/assets\/[A-Za-z0-9/_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:js|css|woff2?|png|jpe?g|svg|gif|ico|webp)$/.test(
                    url.pathname
                  )
                ? url.pathname.slice(1)
                : undefined
        if (path) asset = await this.readAsset(path)
      }
      if (!asset) throw new ResearchReplayError('not-found', 404)
      if (asset.body.byteLength > 32 * 1024 * 1024 || /[\r\n]/.test(asset.mimeType))
        throw new ResearchReplayError('oversized', 413)
      this.current(binding)
      // The client may have cancelled while the immutable bytes were being read. Keep its
      // work reserved until that read settles, but never wait for events on a closed response.
      if (response.destroyed || response.writableEnded) return
      const size = asset.body.byteLength,
        range = request.headers.range
      let start = 0,
        end = size - 1
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range)
        let invalid = size === 0 || !match || (!match[1] && !match[2])
        if (match && !invalid) {
          if (!match[1]) {
            const suffix = Number(match[2])
            invalid = !Number.isSafeInteger(suffix) || suffix <= 0
            start = Math.max(0, size - suffix)
          } else {
            start = Number(match[1])
            end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
            invalid =
              !Number.isSafeInteger(start) ||
              !Number.isSafeInteger(end) ||
              start > end ||
              start >= size
          }
        }
        if (invalid) {
          response.writeHead(416, {
            ...headers,
            'content-range': `bytes */${size}`,
            'accept-ranges': 'bytes',
            'content-length': '0'
          })
          response.end()
          return
        }
      }
      response.writeHead(range ? 206 : 200, {
        ...headers,
        'content-type': asset.mimeType,
        'content-length': String(Math.max(0, end - start + 1)),
        'accept-ranges': 'bytes',
        ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
        ...(isResource
          ? { 'content-disposition': 'attachment; filename="recorded-resource"' }
          : {}),
        'content-security-policy': isResource
          ? "sandbox; default-src 'none'"
          : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-src blob:; frame-ancestors 'none'; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'",
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
      })
      if (request.method !== 'HEAD')
        for (let offset = start; offset <= end; offset += 65536) {
          this.current(binding)
          if (response.destroyed || response.writableEnded) return
          if (!response.write(asset.body.subarray(offset, Math.min(end + 1, offset + 65536))))
            await new Promise<void>((resolve, reject) => {
              const done = (): void => {
                  cleanup()
                  resolve()
                },
                closed = (): void => {
                  cleanup()
                  reject(new ResearchReplayError('unavailable', 410))
                },
                cleanup = (): void => {
                  response.off('drain', done)
                  response.off('close', closed)
                  response.off('error', closed)
                }
              response.once('drain', done)
              response.once('close', closed)
              response.once('error', closed)
              if (response.destroyed || response.writableEnded) closed()
            })
        }
      if (response.destroyed || response.writableEnded) return
      response.end()
    } catch (error) {
      if (response.destroyed || response.writableEnded || response.headersSent) {
        response.destroy()
        return
      }
      const known =
        error instanceof ResearchReplayError
          ? error
          : error instanceof z.ZodError
            ? new ResearchReplayError('invalid')
            : new ResearchReplayError('unavailable', 503)
      response.writeHead(known.status, { 'content-type': 'application/json', ...headers })
      response.end(
        JSON.stringify({
          error: {
            code: known.code,
            message: 'The research replay request could not be completed.'
          }
        })
      )
    } finally {
      clearTimeout(timeout)
      if (binding && reserved) binding.active--
    }
  }
}
