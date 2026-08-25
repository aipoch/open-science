import { randomBytes, randomUUID } from 'node:crypto'
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'

import { createLogger, errorLogFields, type Logger } from '../logger'

// A turn may contain up to 24 MiB of base64 image data before frameworks add text, replayed history,
// and tool declarations. Keep every authenticated Provider bridge on one memory-bounded envelope.
const MAX_PROVIDER_LOOPBACK_REQUEST_BYTES = 64 * 1024 * 1024

type ProviderLoopbackConnection = Readonly<{
  baseUrl: string
  token: string
}>

type ProviderLoopbackJsonObject = Record<string, unknown>

type ProviderLoopbackHttpRequest = Readonly<{
  method: string | undefined
  path: string
  url: URL
  headers: IncomingHttpHeaders
  signal: AbortSignal
  readJsonObject: () => Promise<ProviderLoopbackJsonObject>
}>

type ProviderLoopbackHttpHostOptions<Connection extends ProviderLoopbackConnection> = Readonly<{
  diagnosticName: string
  diagnostics?: Pick<Logger, 'info' | 'error'>
  credentialMode: 'bearer' | 'bearer-or-api-key'
  createConnection: (origin: string, token: string) => Connection
  handle: (request: ProviderLoopbackHttpRequest, response: ServerResponse) => Promise<void>
  onUnauthorized: (response: ServerResponse) => void
  onError: (error: unknown, response: ServerResponse) => void
}>

const defaultDiagnostics = createLogger('provider-loopback')

class ProviderLoopbackRequestError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options)
    this.name = 'ProviderLoopbackRequestError'
  }
}

const writeProviderLoopbackJson = (
  response: ServerResponse,
  status: number,
  body: unknown
): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const oversizedRequestError = (): ProviderLoopbackRequestError =>
  new ProviderLoopbackRequestError('Provider loopback request exceeds the 64 MiB size limit.')

const closeRequestAfterResponse = (request: IncomingMessage, response: ServerResponse): void => {
  response.shouldKeepAlive = false
  if (!response.headersSent) response.setHeader('connection', 'close')
  if (response.writableFinished) request.destroy()
  else response.once('finish', () => request.destroy())
}

const readJsonObject = async (
  request: IncomingMessage,
  response: ServerResponse
): Promise<ProviderLoopbackJsonObject> => {
  const declaredLength = request.headers['content-length']
  if (
    declaredLength !== undefined &&
    Number(declaredLength) > MAX_PROVIDER_LOOPBACK_REQUEST_BYTES
  ) {
    closeRequestAfterResponse(request, response)
    throw oversizedRequestError()
  }

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_PROVIDER_LOOPBACK_REQUEST_BYTES) {
      request.destroy()
      throw oversizedRequestError()
    }
    chunks.push(bytes)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    throw new ProviderLoopbackRequestError('Provider loopback request must contain valid JSON.', {
      cause: error
    })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProviderLoopbackRequestError('Provider loopback request body must be a JSON object.')
  }
  return parsed as ProviderLoopbackJsonObject
}

const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) return
  const closing = new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  server.closeAllConnections()
  await closing
}

class ProviderLoopbackHttpHost<Connection extends ProviderLoopbackConnection> {
  private server: Server | undefined
  private connection: Connection | undefined
  private startPromise: Promise<Connection> | undefined
  private closePromise: Promise<void> | undefined
  private closingStartPromise: Promise<Connection> | undefined
  private lifecycle: { expectedClose: boolean } | undefined

  constructor(private readonly options: ProviderLoopbackHttpHostOptions<Connection>) {}

  start(): Promise<Connection> {
    if (!this.closePromise && this.connection) return Promise.resolve(this.connection)
    if (this.startPromise && this.startPromise !== this.closingStartPromise) {
      return this.startPromise
    }

    const closing = this.closePromise
    const starting = (async (): Promise<Connection> => {
      if (closing) await closing
      if (this.connection) return this.connection
      return this.startServer()
    })()
    this.startPromise = starting
    void starting.then(
      () => {
        if (this.startPromise === starting) this.startPromise = undefined
      },
      () => {
        if (this.startPromise === starting) this.startPromise = undefined
      }
    )
    return starting
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    const starting = this.startPromise
    this.closingStartPromise = starting
    const closing = this.closeAfterStart(starting)
    this.closePromise = closing
    void closing.then(
      () => this.finishClose(closing, starting),
      () => this.finishClose(closing, starting)
    )
    return closing
  }

  private async startServer(): Promise<Connection> {
    const token = randomBytes(24).toString('hex')
    const diagnostics = this.options.diagnostics ?? defaultDiagnostics
    const bridgeId = randomUUID()
    const startedAt = Date.now()
    const lifecycle = { expectedClose: false }
    let port: number | undefined
    const diagnosticFields = (): Record<string, unknown> => ({
      bridge: this.options.diagnosticName,
      bridgeId,
      ...(port === undefined ? {} : { port })
    })
    const server = createServer((request, response) => {
      void this.serve(request, response, token).catch((error: unknown) => {
        if (response.destroyed || response.writableEnded) return
        try {
          this.options.onError(error, response)
        } catch {
          response.destroy()
        }
      })
    })
    server.on('error', (error) =>
      diagnostics.error('provider loopback server error', {
        ...diagnosticFields(),
        ...errorLogFields(error)
      })
    )
    server.once('close', () =>
      diagnostics.info('provider loopback closed', {
        ...diagnosticFields(),
        expected: lifecycle.expectedClose,
        lifetimeMs: Date.now() - startedAt
      })
    )
    this.server = server
    this.lifecycle = lifecycle
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error)
        server.once('error', onError)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', onError)
          resolve()
        })
      })
      server.unref()
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Provider loopback HTTP host did not bind a port.')
      }
      port = address.port
      diagnostics.info('provider loopback listening', diagnosticFields())
      const connection = this.options.createConnection(`http://127.0.0.1:${address.port}`, token)
      this.connection = connection
      return connection
    } catch (error) {
      lifecycle.expectedClose = true
      diagnostics.error('provider loopback failed to start', {
        ...diagnosticFields(),
        ...errorLogFields(error)
      })
      if (this.server === server) this.server = undefined
      this.connection = undefined
      await closeServer(server).catch(() => undefined)
      if (this.lifecycle === lifecycle) this.lifecycle = undefined
      throw error
    }
  }

  private async closeAfterStart(starting: Promise<Connection> | undefined): Promise<void> {
    await starting?.catch(() => undefined)
    const server = this.server
    const lifecycle = this.lifecycle
    this.server = undefined
    this.connection = undefined
    if (lifecycle) lifecycle.expectedClose = true
    if (server) await closeServer(server)
    if (this.lifecycle === lifecycle) this.lifecycle = undefined
  }

  private finishClose(closing: Promise<void>, starting: Promise<Connection> | undefined): void {
    if (this.closePromise === closing) this.closePromise = undefined
    if (this.closingStartPromise === starting) this.closingStartPromise = undefined
  }

  private async serve(
    request: IncomingMessage,
    response: ServerResponse,
    token: string
  ): Promise<void> {
    const bearerAccepted = request.headers.authorization === `Bearer ${token}`
    const apiKeyAccepted =
      this.options.credentialMode === 'bearer-or-api-key' && request.headers['x-api-key'] === token
    if (!bearerAccepted && !apiKeyAccepted) {
      this.options.onUnauthorized(response)
      return
    }

    const controller = new AbortController()
    const abort = (): void => controller.abort()
    const abortOnRequestClose = (): void => {
      if (request.aborted || !request.complete) abort()
    }
    const abortOnResponseClose = (): void => {
      if (!response.writableEnded) abort()
    }
    request.once('aborted', abort)
    request.once('close', abortOnRequestClose)
    response.once('close', abortOnResponseClose)

    let body: Promise<ProviderLoopbackJsonObject> | undefined
    try {
      const path = request.url ?? '/'
      await this.options.handle(
        Object.freeze({
          method: request.method,
          path,
          url: new URL(path, 'http://127.0.0.1'),
          headers: request.headers,
          signal: controller.signal,
          readJsonObject: () => (body ??= readJsonObject(request, response))
        }),
        response
      )
    } finally {
      request.off('aborted', abort)
      request.off('close', abortOnRequestClose)
      response.off('close', abortOnResponseClose)
    }
  }
}

export { ProviderLoopbackHttpHost, ProviderLoopbackRequestError, writeProviderLoopbackJson }
export type { ProviderLoopbackConnection, ProviderLoopbackHttpRequest, ProviderLoopbackJsonObject }
