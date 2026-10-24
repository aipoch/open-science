import { timingSafeEqual } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { Agent, request, type ClientRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
import { validateLocalServiceLocation } from '@aipoch/notebook-network-sandbox'

type LocalServiceScope = Readonly<{
  projectId: string
  sessionId: string
  executionId: string
}>

type LocalServiceResponse = Readonly<{
  statusCode: number
  contentType: string | undefined
  body: Buffer
}>

type LocalServiceLeaseOptions = Readonly<{
  scope: LocalServiceScope
  socketPath: string
  /** Random proof obtained through the owned process's private startup channel, never from HTTP. */
  expectedProof: string
  proofPath: string
  allowedPaths: readonly string[]
  signal: AbortSignal
}>

const validPath = (path: string): boolean =>
  /^\/[A-Za-z0-9/_-]*$/.test(path) && !path.includes('//')

/**
 * Host-only GET capability for one proven service generation. It never forwards arbitrary URLs,
 * redirects, credentials or request bodies. A lost socket is terminal: path reuse cannot reconnect
 * this lease to a replacement listener. The existing Run owner supplies cancellation and teardown.
 */
class LocalServiceLease {
  readonly scope: LocalServiceScope
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 1, maxTotalSockets: 1 })
  private readonly requests = new Set<ClientRequest>()
  private readonly paths: Set<string>
  private socket?: Socket
  private closed = false
  private tail: Promise<unknown> = Promise.resolve()
  private readonly abort = (): void => this.close()

  private constructor(private readonly options: LocalServiceLeaseOptions) {
    this.scope = Object.freeze({ ...options.scope })
    this.paths = new Set(options.allowedPaths)
    this.agent.createConnection = () => {
      // Even an unexpected Agent retry cannot transfer this authority to a new listener.
      if (this.closed || this.socket) throw new Error('Local service lease cannot reconnect.')
      const socket = connect({ path: options.socketPath })
      this.socket = socket
      socket.once('close', this.abort)
      return socket
    }
    options.signal.addEventListener('abort', this.abort, { once: true })
  }

  static async open(options: LocalServiceLeaseOptions): Promise<LocalServiceLease> {
    if (
      !/^[a-f0-9]{64}$/.test(options.expectedProof) ||
      !validPath(options.proofPath) ||
      options.allowedPaths.length === 0 ||
      options.allowedPaths.length > 16 ||
      !options.allowedPaths.every(validPath) ||
      Object.values(options.scope).length !== 3 ||
      !['projectId', 'sessionId', 'executionId'].every((key) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(
          options.scope[key as keyof LocalServiceScope] ?? ''
        )
      )
    ) {
      throw new Error('Invalid local service lease capability.')
    }
    validateLocalServiceLocation({
      executionId: options.scope.executionId,
      socketPath: options.socketPath
    })
    if (!lstatSync(options.socketPath).isSocket()) {
      throw new Error('Local service lease requires the owned Unix socket.')
    }
    options.signal.throwIfAborted()
    const lease = new LocalServiceLease({
      ...options,
      scope: Object.freeze({ ...options.scope }),
      allowedPaths: Object.freeze([...options.allowedPaths])
    })
    const expected = Buffer.from(options.expectedProof)
    try {
      const response = await lease.read(options.proofPath)
      if (
        response.statusCode !== 200 ||
        response.body.length !== expected.length ||
        !timingSafeEqual(response.body, expected)
      ) {
        throw new Error('Local service generation could not be verified.')
      }
      lease.assertOpen()
      return lease
    } catch (error) {
      lease.close()
      throw error
    }
  }

  get(path: string): Promise<LocalServiceResponse> {
    if (!this.paths.has(path) || !validPath(path)) {
      return Promise.reject(new Error('Path is not authorized by this local service lease.'))
    }
    const next = this.tail.then(() => this.read(path))
    this.tail = next.catch(() => undefined)
    return next
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.options.signal.removeEventListener('abort', this.abort)
    for (const pending of this.requests) pending.destroy(new Error('Local service lease closed.'))
    this.agent.destroy()
    this.socket?.destroy()
  }

  private assertOpen(): void {
    this.options.signal.throwIfAborted()
    if (this.closed) throw new Error('Local service lease closed.')
  }

  private async read(path: string): Promise<LocalServiceResponse> {
    this.assertOpen()
    return new Promise((resolve, reject) => {
      const pending = request(
        {
          socketPath: this.options.socketPath,
          path,
          method: 'GET',
          agent: this.agent
        },
        (response) => {
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > 1024 * 1024) {
              pending.destroy(new Error('Local service response exceeds the size limit.'))
              return
            }
            chunks.push(chunk)
          })
          response.once('error', reject)
          response.once('end', () => {
            try {
              this.assertOpen()
              resolve({
                statusCode: response.statusCode ?? 0,
                contentType: response.headers['content-type'],
                body: Buffer.concat(chunks)
              })
            } catch (error) {
              reject(error)
            }
          })
        }
      )
      this.requests.add(pending)
      const timeout = setTimeout(
        () => pending.destroy(new Error('Local service request timed out.')),
        2000
      )
      pending.once('close', () => {
        clearTimeout(timeout)
        this.requests.delete(pending)
      })
      pending.on('error', (error) => {
        this.requests.delete(pending)
        this.close()
        reject(error)
      })
      pending.end()
    })
  }
}

export { LocalServiceLease }
export type { LocalServiceLeaseOptions, LocalServiceScope, LocalServiceResponse }
