import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MAX_REQUEST_BYTES = 64 * 1024 * 1024
const WIRE_PATH = {
  'chat-completions': '/v1/chat/completions',
  responses: '/v1/responses'
} as const
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

export type OpenAiProviderBridgeTarget = Readonly<{
  id: string
  wire: keyof typeof WIRE_PATH
  endpoint: string
  key?: string
  model: string
}>

export type OpenAiProviderBridgeConnection = Readonly<{
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
        reject(new Error('OpenAI bridge request exceeds the size limit.'))
        request.destroy()
        return
      }
      chunks.push(buffer)
    })
    request.once('end', () => resolve(Buffer.concat(chunks)))
    request.once('error', reject)
    request.once('aborted', () => reject(new Error('OpenAI bridge request was aborted.')))
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

export class OpenAiProviderBridge {
  private readonly targets: ReadonlyMap<string, OpenAiProviderBridgeTarget>
  private readonly wire: OpenAiProviderBridgeTarget['wire']
  private target: OpenAiProviderBridgeTarget
  private server: Server | undefined
  private connection: OpenAiProviderBridgeConnection | undefined

  constructor(targets: readonly OpenAiProviderBridgeTarget[], initialTargetId: string) {
    this.targets = new Map(targets.map((target) => [target.id, target]))
    const initial = this.targets.get(initialTargetId)
    if (!initial) throw new Error('The initial OpenAI bridge target is not registered.')
    this.target = initial
    this.wire = initial.wire
  }

  setTarget(targetId: string): boolean {
    const target = this.targets.get(targetId)
    if (!target || target.wire !== this.wire) return false
    this.target = target
    return true
  }

  async start(): Promise<OpenAiProviderBridgeConnection> {
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
            message: error instanceof Error ? error.message : 'OpenAI provider request failed.'
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
        throw new Error('OpenAI provider bridge did not bind a port.')
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
    if (requestUrl.pathname !== WIRE_PATH[this.wire]) {
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
    const endpoint = new URL(target.endpoint)
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
      throw new Error('The OpenAI provider target has no valid endpoint URL.')
    }
    const body = JSON.stringify({ ...(parsed as Record<string, unknown>), model: target.model })
    const controller = new AbortController()
    response.once('close', () => {
      if (!response.writableEnded) controller.abort()
    })

    const upstream = await fetch(endpoint, {
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
