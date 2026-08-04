import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { normalizeAnthropicBaseUrl } from './base-url'

const MAX_REQUEST_BYTES = 64 * 1024 * 1024
const ALLOWED_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens'])
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

export type AnthropicProviderBridgeTarget = Readonly<{
  id: string
  baseUrl: string
  key?: string
  model: string
}>

export type AnthropicProviderBridgeConnection = Readonly<{
  baseUrl: string
  token: string
}>

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error('Anthropic bridge request exceeds the size limit.'))
        request.destroy()
        return
      }
      chunks.push(buffer)
    })
    request.once('end', () => resolve(Buffer.concat(chunks)))
    request.once('error', reject)
    request.once('aborted', () => reject(new Error('Anthropic bridge request was aborted.')))
  })

const requestHeaders = (request: IncomingMessage, key?: string): Headers => {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    const normalized = name.toLowerCase()
    if (
      HOP_BY_HOP_HEADERS.has(normalized) ||
      normalized === 'authorization' ||
      normalized === 'x-api-key' ||
      value === undefined
    ) {
      continue
    }
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else {
      headers.set(name, value)
    }
  }
  if (key) headers.set('authorization', `Bearer ${key}`)
  headers.set('content-type', 'application/json')
  return headers
}

const copyResponseHeaders = (source: Headers, response: ServerResponse): void => {
  for (const [name, value] of source) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) response.setHeader(name, value)
  }
}

export class AnthropicProviderBridge {
  private readonly targets: ReadonlyMap<string, AnthropicProviderBridgeTarget>
  private target: AnthropicProviderBridgeTarget
  private server: Server | undefined
  private connection: AnthropicProviderBridgeConnection | undefined

  constructor(targets: readonly AnthropicProviderBridgeTarget[], initialTargetId: string) {
    this.targets = new Map(targets.map((target) => [target.id, target]))
    const initial = this.targets.get(initialTargetId)
    if (!initial) throw new Error('The initial Anthropic bridge target is not registered.')
    this.target = initial
  }

  setTarget(targetId: string): boolean {
    const target = this.targets.get(targetId)
    if (!target) return false
    this.target = target
    return true
  }

  async start(): Promise<AnthropicProviderBridgeConnection> {
    if (this.connection) return this.connection
    const token = randomBytes(24).toString('hex')
    const server = createServer((request, response) => {
      void this.handle(request, response, token).catch((error: unknown) => {
        if (response.destroyed || response.writableEnded) return
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined)
          return
        }
        json(response, 502, {
          error: {
            type: 'api_error',
            message: error instanceof Error ? error.message : 'Anthropic provider request failed.'
          }
        })
      })
    })
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      server.unref()
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Anthropic provider bridge did not bind a port.')
      }
      this.connection = Object.freeze({
        baseUrl: `http://127.0.0.1:${address.port}`,
        token
      })
      return this.connection
    } catch (error) {
      await this.close().catch(() => undefined)
      throw error
    }
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.connection = undefined
    if (!server) return
    const closing = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    server.closeAllConnections()
    await closing
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
    token: string
  ): Promise<void> {
    const authorization = request.headers.authorization
    const apiKey = request.headers['x-api-key']
    if (authorization !== `Bearer ${token}` && apiKey !== token) {
      json(response, 401, { error: { type: 'authentication_error', message: 'Unauthorized' } })
      return
    }
    if (request.method !== 'POST') {
      json(response, 405, {
        error: { type: 'invalid_request_error', message: 'Method not allowed' }
      })
      return
    }

    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (!ALLOWED_PATHS.has(requestUrl.pathname)) {
      json(response, 404, { error: { type: 'not_found_error', message: 'Not found' } })
      return
    }

    const rawBody = await readBody(request)
    const parsed = JSON.parse(rawBody.toString('utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      json(response, 400, {
        error: { type: 'invalid_request_error', message: 'Expected a JSON object request body.' }
      })
      return
    }

    const target = this.target
    const body = JSON.stringify({ ...(parsed as Record<string, unknown>), model: target.model })
    const baseUrl = normalizeAnthropicBaseUrl(target.baseUrl)
    if (!baseUrl) throw new Error('The Anthropic provider target has no valid base URL.')
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    response.once('close', () => {
      if (!response.writableEnded) abort()
    })

    const upstream = await fetch(`${baseUrl}${requestUrl.pathname}${requestUrl.search}`, {
      method: 'POST',
      headers: requestHeaders(request, target.key),
      body,
      redirect: 'manual',
      signal: controller.signal
    })
    response.statusCode = upstream.status
    response.statusMessage = upstream.statusText
    copyResponseHeaders(upstream.headers, response)
    if (!upstream.body) {
      response.end()
      return
    }
    await pipeline(Readable.from(upstream.body as AsyncIterable<Uint8Array>), response)
  }
}
