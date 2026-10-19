import {
  browserImportTransferId,
  parseBrowserImportUrl,
  type BrowserImportRequest
} from './browser-import-protocol'
export { parseBrowserImportUrl } from './browser-import-protocol'
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, open, readdir, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserPackageTransfer } from '../../shared/session-package'

// Version 1 deliberately bounds browser staging independently of the research archive format.
const MAX_BYTES = 2 * 1024 ** 3
const CHUNK_BYTES = 4 * 1024 ** 2
const MAX_SESSIONS = 16
const HEX_SECRET = /^[a-f0-9]{64}$/
type BrowserImportOptions = {
  root: string
  receive: (path: string, consumed: () => void) => void | boolean | Promise<boolean>
  idleMs?: number
  onChanged?: (transfers: BrowserPackageTransfer[]) => void
  cancelReceived?: (path: string) => Promise<void>
}
type Transfer = {
  id: string
  state: BrowserPackageTransfer['state']
  cancelled?: boolean
  cancellation?: Promise<void>
  cleanupPending?: boolean
  sourceCleanup?: Promise<void>
  incoming?: IncomingMessage
  response?: ServerResponse
  request: BrowserImportRequest
  server?: Server
  file?: FileHandle
  directory?: string
  path?: string
  offset: number
  receivedBytes: number
  busy: boolean
  accepted: boolean
  removed: boolean
  timer?: NodeJS.Timeout
  consumed?: boolean
  resources?: Promise<void>
  work?: Promise<void>
  io?: Promise<void>
}

const equal = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
const reply = (response: ServerResponse, status: number, value?: unknown): void => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(value === undefined ? undefined : JSON.stringify(value))
}

// This receiver never fetches a URL. Its only input is an authenticated, bounded byte stream from the
// browser that holds the protocol secret. It has no access to the general web API or its token.
export class BrowserPackageImport {
  private readonly transfers = new Map<string, Transfer>()
  private initialized?: Promise<void>
  private closed = false
  private discovery?: Server
  private discoveryStarting?: Promise<void>
  private validOrigin(origin: unknown): origin is string {
    if (typeof origin !== 'string' || origin.length > 2048) return false
    try {
      const site = new URL(origin)
      return (
        site.origin === origin &&
        (site.protocol === 'https:' ||
          (site.protocol === 'http:' &&
            ['127.0.0.1', 'localhost', '[::1]'].includes(site.hostname)))
      )
    } catch {
      return false
    }
  }

  startDiscovery(port = 49151): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Browser import is closed.'))
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      return Promise.reject(new Error('Invalid browser discovery port.'))
    if (this.discoveryStarting) return this.discoveryStarting
    const server = createServer((request, response) => {
      void this.handleDiscovery(port, request, response).catch(() => {
        if (!response.headersSent) reply(response, 500)
        else response.destroy()
      })
    })
    this.discovery = server
    server.requestTimeout = 5000
    server.headersTimeout = 5000
    server.maxHeadersCount = 24
    this.discoveryStarting = new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    return this.discoveryStarting
  }

  private async handleDiscovery(
    port: number,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const origin = request.headers.origin
    if (this.closed || request.headers.host !== `127.0.0.1:${port}` || !this.validOrigin(origin)) {
      reply(response, 403)
      request.resume()
      return
    }
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
    // Discovery exposes only protocol compatibility, never desktop data or import authority.
    const path = request.url
    if (path !== '/v1/browser-import/capabilities') {
      reply(response, 404)
    } else if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET')
      response.setHeader('Access-Control-Allow-Private-Network', 'true')
      reply(response, 204)
    } else if (request.method === 'GET') {
      reply(response, 200, {
        service: 'open-science-browser-import',
        version: 1
      })
    } else reply(response, 405)
    request.resume()
  }
  constructor(private readonly options: BrowserImportOptions) {}

  get snapshot(): BrowserPackageTransfer[] {
    return [...this.transfers.values()]
      .filter((t) => t.cleanupPending || (!t.removed && (!t.accepted || t.cancelled)))
      .map((t) => ({
        id: t.id,
        filename: t.request.name,
        state: t.state,
        ...(t.cleanupPending ? { cleanupPending: true } : {}),
        completedBytes: t.receivedBytes,
        totalBytes: t.request.size
      }))
  }

  private publish(): void {
    try {
      this.options.onChanged?.(this.snapshot)
    } catch {
      /* Presentation cannot own file lifetime. */
    }
  }

  private replyCancelled(t: Transfer, response: ServerResponse): void {
    if (!response.headersSent)
      reply(response, 410, { code: 'cancelled', proof: this.proof(t, 'cancelled') })
  }

  cancel(id: string): Promise<void> {
    const t = [...this.transfers.values()].find((t) => t.id === id)
    if (!t || (t.removed && !t.cleanupPending)) return Promise.resolve()
    if (t.cancellation) return t.cancellation
    // A released queue source only needs cleanup; its authenticated receipt remains valid.
    if (t.accepted && t.consumed) {
      if (t.cleanupPending) t.sourceCleanup = this.cleanupSource(t)
      return t.sourceCleanup ?? Promise.resolve()
    }
    t.cancelled = true
    t.state = 'cancelling'
    t.cleanupPending = false
    clearTimeout(t.timer)
    // End an in-flight HTTP request promptly, but join its disk work before releasing the source.
    if (t.response && !t.response.headersSent) {
      const incoming = t.incoming
      if (incoming && !incoming.complete) t.response.once('finish', () => incoming.destroy())
      this.replyCancelled(t, t.response)
    }
    t.cancellation = (async () => {
      await t.resources?.catch(() => undefined)
      await t.io?.catch(() => undefined)
      if (t.accepted && !t.consumed) {
        // Queue admission is the ownership boundary, including admission that raced with cancel.
        await this.options.cancelReceived?.(t.path!)
        if (!t.consumed) throw new Error('The import queue has not released this source.')
      }
      // Once released, the receiver can join/retry source cleanup without touching queue-owned bytes.
      await t.sourceCleanup?.catch(() => undefined)
      if (!t.accepted || t.consumed) {
        await t.file?.close()
        t.file = undefined
        if (t.directory) await rm(t.directory, { recursive: true, force: true })
        t.consumed = true
      }
      t.state = 'cancelled'
      this.publish()
      // A short-lived signed tombstone lets the website distinguish cancellation from network loss.
      if (!this.closed && !t.removed) this.touch(t)
    })().catch((error: unknown) => {
      t.cancellation = undefined
      t.cleanupPending = true
      t.state = 'cancelled'
      this.publish()
      throw error
    })
    this.publish()
    return t.cancellation
  }

  get active(): boolean {
    return [...this.transfers.values()].some(
      (transfer) =>
        (!transfer.accepted && !transfer.cancelled) ||
        transfer.state === 'cancelling' ||
        Boolean(transfer.cleanupPending)
    )
  }

  begin(input: unknown, cancelled = false): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Browser import is closed.'))
    const request = parseBrowserImportUrl(input)
    if (!request) return Promise.reject(new Error('Invalid browser import request.'))
    const previous = this.transfers.get(request.secret)
    if (previous) return cancelled ? this.cancel(previous.id) : (previous.work ?? Promise.resolve())
    if (
      this.transfers.size >= MAX_SESSIONS ||
      [...this.transfers.values()].reduce(
        (total, t) => total + (t.consumed ? 0 : t.request.size),
        request.size
      ) > MAX_BYTES
    )
      return Promise.reject(
        new Error('Browser import staging limit reached. Finish pending imports first.')
      )
    const transfer: Transfer = {
      id: browserImportTransferId(request),
      state: 'waiting',
      request,
      offset: 0,
      receivedBytes: 0,
      busy: false,
      accepted: false,
      removed: false
    }
    this.transfers.set(request.secret, transfer)
    transfer.work = this.start(transfer).catch(async (error: unknown) => {
      await this.remove(transfer)
      throw error
    })
    if (cancelled) return this.cancel(transfer.id)
    this.publish()
    return transfer.work
  }

  private async start(transfer: Transfer): Promise<void> {
    if (this.closed) return
    transfer.resources = this.acquire(transfer)
    await transfer.resources
  }

  private async acquire(transfer: Transfer): Promise<void> {
    // Runtime ownership guarantees one writer for this configuration root. Previous-process
    // staging has no persisted import intent and must never be imported on startup.
    this.initialized ??= (async () => {
      await mkdir(this.options.root, { recursive: true, mode: 0o700 })
      for (const entry of await readdir(this.options.root)) {
        if (entry.startsWith('transfer-'))
          await rm(join(this.options.root, entry), { recursive: true, force: true })
      }
    })()
    await this.initialized
    if (this.closed || transfer.removed) return
    transfer.directory = await mkdtemp(join(this.options.root, 'transfer-'))
    if (this.closed || transfer.removed) return
    transfer.path = join(transfer.directory, transfer.request.name)
    transfer.file = await open(transfer.path, 'wx', 0o600)
    if (this.closed || transfer.removed) return
    const server = createServer((request, response) => {
      void this.handle(transfer, request, response).catch(() => {
        if (!response.headersSent) reply(response, 500, { error: 'Local package transfer failed.' })
        else response.destroy()
      })
    })
    transfer.server = server
    server.requestTimeout = 60_000
    server.headersTimeout = 15_000
    server.maxHeadersCount = 24
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(transfer.request.port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    if (!this.closed && !transfer.removed) this.touch(transfer)
  }

  private touch(transfer: Transfer): void {
    clearTimeout(transfer.timer)
    if (transfer.cleanupPending) return
    transfer.timer = setTimeout(() => {
      void this.remove(transfer, transfer.accepted && !transfer.consumed).catch(() => undefined)
    }, this.options.idleMs ?? 120_000)
    transfer.timer.unref()
  }

  private proof(t: Transfer, message: string): string {
    return createHmac('sha256', Buffer.from(t.request.secret, 'hex')).update(message).digest('hex')
  }

  private releaseSource(t: Transfer): void {
    t.consumed = true
    // Keep the receipt endpoint alive briefly so a lost completion response can be retried.
    t.sourceCleanup = this.cleanupSource(t)
    void t.sourceCleanup.catch(() => undefined)
  }

  private async cleanupSource(t: Transfer): Promise<void> {
    try {
      await t.io?.catch(() => undefined)
      if (t.directory) await rm(t.directory, { recursive: true, force: true })
      t.cleanupPending = false
      if (!t.server) this.transfers.delete(t.request.secret)
      else if (!this.closed && !t.removed) this.touch(t)
      this.publish()
    } catch (error) {
      clearTimeout(t.timer)
      t.cleanupPending = true
      this.publish()
      throw error
    }
  }

  private async handle(
    t: Transfer,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (t.removed || this.closed) {
      reply(response, 410)
      return
    }
    if (
      request.headers.host !== `127.0.0.1:${t.request.port}` ||
      request.headers.origin !== t.request.origin
    ) {
      reply(response, 403)
      request.resume()
      return
    }
    response.setHeader('Access-Control-Allow-Origin', t.request.origin)
    response.setHeader('Vary', 'Origin')
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${t.request.port}`)
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE')
      response.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-Chunk-SHA256'
      )
      response.setHeader('Access-Control-Allow-Private-Network', 'true')
      reply(response, 204)
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/import/ready') {
      const challenge = url.searchParams.get('challenge') ?? ''
      if (!HEX_SECRET.test(challenge)) {
        reply(response, 400)
        return
      }
      if (t.cancelled) {
        this.replyCancelled(t, response)
        return
      }
      const proof = this.proof(
        t,
        `open-science-import-v1:${challenge}:${t.offset}:${t.accepted ? 1 : 0}`
      )
      reply(response, 200, {
        proof,
        offset: t.offset,
        chunkBytes: CHUNK_BYTES,
        accepted: t.accepted
      })
      return
    }
    const signature = this.proof(
      t,
      `${request.method}\n${url.pathname}${url.search}\n${request.headers['x-chunk-sha256'] ?? ''}`
    )
    if (!equal(request.headers.authorization ?? '', `HMAC ${signature}`)) {
      reply(response, 403)
      request.resume()
      return
    }
    if (t.cancelled) {
      this.replyCancelled(t, response)
      request.resume()
      return
    }
    this.touch(t)
    if (request.method === 'DELETE' && url.pathname === '/v1/import' && !t.accepted) {
      // Completion may already be handing the source to the queue; admission owns its lifetime.
      if (t.busy && t.offset === t.request.size) {
        reply(response, 409)
        return
      }
      reply(response, 204)
      await this.remove(t)
      return
    }
    if (t.busy) {
      reply(response, 409)
      request.resume()
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/import/complete') {
      if (t.accepted) {
        reply(response, 202, { received: true, proof: this.proof(t, `received:${t.request.size}`) })
        return
      }
      if (t.offset !== t.request.size) {
        reply(response, 409)
        return
      }
      t.busy = true
      t.response = response
      t.incoming = request
      t.io = (async () => {
        await t.file!.sync()
        await t.file!.close()
        t.file = undefined
        if (t.removed || this.closed || t.cancelled) return
        const queued = await this.options.receive(t.path!, () => this.releaseSource(t))
        if (queued === false) {
          if (t.cancelled) return
          reply(response, 503, { error: 'Package import queue is full or closing.' })
          void this.remove(t).catch(() => undefined)
          return
        }
        t.accepted = true
        this.publish()
        if (t.cancelled) return
        reply(response, 202, { received: true, proof: this.proof(t, `received:${t.request.size}`) })
      })()
      try {
        await t.io
      } finally {
        t.busy = false
        t.response = undefined
        t.incoming = undefined
      }
      return
    }
    if (request.method !== 'PUT' || url.pathname !== '/v1/import/chunk' || t.accepted) {
      reply(response, 404)
      request.resume()
      return
    }
    const offset = url.searchParams.get('offset')
    if (offset !== String(t.offset)) {
      reply(response, 409, { offset: t.offset })
      request.resume()
      return
    }
    const digest = request.headers['x-chunk-sha256']
    if (typeof digest !== 'string' || !HEX_SECRET.test(digest)) {
      reply(response, 400)
      request.resume()
      return
    }
    const limit = Math.min(CHUNK_BYTES, t.request.size - t.offset)
    const contentLength = Number(request.headers['content-length'])
    if (contentLength > limit + 28) {
      reply(response, 413)
      request.resume()
      return
    }
    t.busy = true
    t.response = response
    t.incoming = request
    t.state = 'receiving'
    this.publish()
    const chunkOffset = t.offset
    t.io = (async () => {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        if (t.cancelled) return
        bytes += chunk.length
        if (bytes > limit + 28) {
          reply(response, 413)
          request.resume()
          return
        }
        chunks.push(chunk)
        // Count ciphertext payload only; unknown-length streams retain a 16-byte tag lookbehind.
        const payloadBytes = Math.max(
          0,
          Number.isSafeInteger(contentLength) && contentLength >= 28
            ? Math.min(bytes - 12, contentLength - 28)
            : bytes - 28
        )
        // Display a per-transfer high-water mark: a retried chunk is not new file content.
        const receivedBytes = Math.min(t.request.size, chunkOffset + payloadBytes)
        if (receivedBytes > t.receivedBytes) {
          t.receivedBytes = receivedBytes
          this.publish()
        }
      }
      const encrypted = Buffer.concat(chunks)
      let content: Buffer
      try {
        const key = createHash('sha256')
          .update(`open-science-encryption-v1:${t.request.secret}`)
          .digest()
        const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12))
        decipher.setAAD(Buffer.from(`offset:${t.offset}`))
        decipher.setAuthTag(encrypted.subarray(-16))
        content = Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()])
      } catch {
        reply(response, 422)
        return
      }
      bytes = content.length
      if (!bytes || createHash('sha256').update(content).digest('hex') !== digest) {
        reply(response, 422)
        return
      }
      if (t.removed || this.closed || t.cancelled) return
      let written = 0
      while (written < bytes) {
        if (t.cancelled) return
        const result = await t.file!.write(content, written, bytes - written, t.offset)
        if (!result.bytesWritten) throw new Error('Could not write browser package.')
        written += result.bytesWritten
        t.offset += result.bytesWritten
      }
      if (t.cancelled) return
      this.touch(t)
      reply(response, 200, { offset: t.offset, proof: this.proof(t, `offset:${t.offset}`) })
    })()
    try {
      await t.io
    } finally {
      t.busy = false
      t.response = undefined
      t.incoming = undefined
    }
  }

  private async remove(t: Transfer, retain = false): Promise<void> {
    // Accepted sources stay available to the queue and retry UI until consumed or runtime close.
    clearTimeout(t.timer)
    if (!retain) t.removed = true
    await t.resources?.catch(() => undefined)
    const server = t.server
    t.server = undefined
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    await t.io?.catch(() => undefined)
    // Admission may have completed while removal was waiting for the in-flight request.
    if (!this.closed && (retain || t.accepted) && !t.consumed) return
    t.removed = true
    await t.file?.close().catch(() => undefined)
    t.file = undefined
    if (t.directory) await rm(t.directory, { recursive: true, force: true })
    this.transfers.delete(t.request.secret)
    this.publish()
  }

  stop(): void {
    this.closed = true
    this.discovery?.closeAllConnections()
    if (this.discovery?.listening) this.discovery.close()
    for (const transfer of this.transfers.values()) {
      clearTimeout(transfer.timer)
      transfer.server?.closeAllConnections()
      if (transfer.server?.listening) transfer.server.close()
    }
  }

  async close(): Promise<void> {
    this.stop()
    await this.discoveryStarting?.catch(() => undefined)
    if (this.discovery?.listening) {
      this.discovery.closeAllConnections()
      await new Promise<void>((resolve) => this.discovery!.close(() => resolve()))
    }
    // Join all in-flight resource acquisition before removing staged bytes.
    await Promise.all(
      [...this.transfers.values()].map(async (transfer) => {
        await transfer.cancellation?.catch(() => undefined)
        await this.remove(transfer)
      })
    )
  }
}
