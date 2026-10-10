import { timingSafeEqual } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { Agent, request, type RequestOptions } from 'node:http'
import { connect, type Socket } from 'node:net'
import { validateLocalServiceLocation } from '@aipoch/notebook-network-sandbox'
import type { RuntimeViewScope } from '../../shared/runtime-view'

export interface OwnedRuntimeViewServiceOptions {
  scope: RuntimeViewScope
  /** Main obtains all three values from its owned process's private startup channel. */
  socketPath: string
  expectedProof: string
  proofPath: string
  /** Fixed upstream Host/Origin, never a browser-supplied destination. */
  upstreamOrigin: string
  signal: AbortSignal
  assertCurrent: () => void
}

export interface VerifiedRuntimeViewConnection {
  /** Main-only transport options. Proof and application request MUST use the same Agent key. */
  requestOptions: Readonly<Pick<RequestOptions, 'agent' | 'socketPath' | 'hostname' | 'port'>>
  origin: string
  close: () => void
}

const instances = new WeakSet<OwnedRuntimeViewService>()
const scopeKeys = ['projectId', 'sessionId', 'runId', 'environmentId', 'generationId'] as const
export function sameRuntimeViewScope(a: RuntimeViewScope, b: RuntimeViewScope): boolean {
  return scopeKeys.every((key) => a[key] === b[key])
}

/** Main-only capability: structural objects or public socket/URL arguments cannot impersonate it. */
export class OwnedRuntimeViewService {
  readonly scope: RuntimeViewScope
  readonly signal: AbortSignal
  private readonly abortController = new AbortController()
  private readonly identity: string
  private readonly connections = new Set<() => void>()
  private readonly abort = (): void => this.close()

  private constructor(private readonly options: OwnedRuntimeViewServiceOptions) {
    this.scope = Object.freeze({ ...options.scope })
    this.signal = this.abortController.signal
    this.identity = this.socketIdentity()
    options.signal.addEventListener('abort', this.abort, { once: true })
    instances.add(this)
  }

  static async open(options: OwnedRuntimeViewServiceOptions): Promise<OwnedRuntimeViewService> {
    const origin = new URL(options.upstreamOrigin)
    if (
      Object.keys(options.scope).length !== scopeKeys.length ||
      !scopeKeys.every((key) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(options.scope[key])) ||
      !/^[a-f0-9]{64}$/.test(options.expectedProof) ||
      !/^\/[A-Za-z0-9/_-]+$/.test(options.proofPath) ||
      options.proofPath.includes('//') ||
      origin.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
      origin.origin !== options.upstreamOrigin ||
      origin.username ||
      origin.password
    )
      throw new Error('Invalid owned runtime view service.')
    validateLocalServiceLocation({
      executionId: options.scope.runId,
      socketPath: options.socketPath
    })
    options.signal.throwIfAborted()
    options.assertCurrent()
    const service = new OwnedRuntimeViewService({ ...options, scope: { ...options.scope } })
    try {
      const connection = await service.connect()
      connection.close()
      return service
    } catch (error) {
      service.close()
      throw error
    }
  }

  static assertOwned(service: OwnedRuntimeViewService, scope: RuntimeViewScope): void {
    if (!instances.has(service) || !sameRuntimeViewScope(service.scope, scope)) {
      throw new Error('Runtime view service authority does not match this Run.')
    }
    service.assertCurrent()
  }

  /** Private native navigation adapter mirrors the same excluded proof route. */
  get excludedPath(): string {
    return this.options.proofPath
  }

  permitsPath(path: string): boolean {
    try {
      const pathname = decodeURIComponent(new URL(path, this.options.upstreamOrigin).pathname)
      return (
        pathname !== this.options.proofPath && !pathname.startsWith(`${this.options.proofPath}/`)
      )
    } catch {
      return false
    }
  }

  assertCurrent(): void {
    try {
      this.signal.throwIfAborted()
      this.options.signal.throwIfAborted()
      this.options.assertCurrent()
      if (this.socketIdentity() !== this.identity)
        throw new Error('Runtime view service generation has changed.')
    } catch (error) {
      this.close()
      throw error
    }
  }

  close(): void {
    if (this.signal.aborted) return
    this.abortController.abort()
    this.options.signal.removeEventListener('abort', this.abort)
    for (const close of this.connections) close()
    this.connections.clear()
  }

  /** Every connection proves the generation on the exact socket later used for HTTP or WS. */
  async connect(): Promise<VerifiedRuntimeViewConnection> {
    this.assertCurrent()
    const agent = new Agent({ keepAlive: true, maxSockets: 1, maxTotalSockets: 1 })
    // This agent owns exactly one proven socket. ws intentionally clears socketPath/hostname
    // from client options; a constant private pool key prevents it from requesting another lane.
    agent.getName = () => 'owned-runtime-view-connection'
    let socket: Socket | undefined
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      agent.destroy()
      socket?.destroy()
      this.connections.delete(close)
    }
    this.connections.add(close)
    const origin = new URL(this.options.upstreamOrigin)
    const transport = Object.freeze({
      agent,
      socketPath: this.options.socketPath,
      hostname: origin.hostname,
      port: origin.port || 80
    })
    agent.createConnection = (_options, callback) => {
      try {
        this.assertCurrent()
        if (closed || socket) throw new Error('Runtime view transport cannot reconnect.')
        socket = connect({ path: this.options.socketPath })
        socket.once('connect', () => {
          try {
            this.assertCurrent()
          } catch {
            socket?.destroy()
          }
        })
        return socket
      } catch (error) {
        // Agent retries happen outside the initiating call stack; reject via its callback.
        queueMicrotask(() => callback?.(error as Error, undefined as never))
        return undefined
      }
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const requestOptions: RequestOptions = {
          ...transport,
          path: this.options.proofPath,
          method: 'GET',
          headers: { host: new URL(this.options.upstreamOrigin).host }
        }
        const pending = request(requestOptions, (response) => {
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > 64) pending.destroy(new Error('Invalid runtime view generation proof.'))
            else chunks.push(chunk)
          })
          response.once('error', reject)
          response.once('end', () => {
            const actual = Buffer.concat(chunks),
              expected = Buffer.from(this.options.expectedProof)
            if (
              response.statusCode !== 200 ||
              actual.length !== expected.length ||
              !timingSafeEqual(actual, expected)
            ) {
              reject(new Error('Runtime view service generation could not be verified.'))
              return
            }
            try {
              this.assertCurrent()
              resolve()
            } catch (error) {
              reject(error)
            }
          })
        })
        const timer = setTimeout(
          () => pending.destroy(new Error('Runtime view generation proof timed out.')),
          2000
        )
        pending.once('error', reject)
        pending.once('close', () => clearTimeout(timer))
        pending.end()
      })
      return { requestOptions: transport, origin: this.options.upstreamOrigin, close }
    } catch (error) {
      close()
      // Losing proof is terminal for this generation, including already-open streams.
      this.close()
      throw error
    }
  }
  private socketIdentity(): string {
    validateLocalServiceLocation({
      executionId: this.scope.runId,
      socketPath: this.options.socketPath
    })
    const stat = lstatSync(this.options.socketPath, { bigint: true })
    if (!stat.isSocket()) throw new Error('Runtime view requires the owned Unix socket.')
    return `${stat.dev}:${stat.ino}:${stat.ctimeNs}`
  }
}
