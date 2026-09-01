import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import {
  request as httpRequest,
  type RequestOptions as HttpRequestOptions,
  type Server
} from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'

type LocalRpcTransport = {
  endpoint: string
  socketPath?: string
}

type LocalRpcListenOptions = {
  name: string
  host?: string
  transport?: 'tcp' | 'pipe'
}

type LocalRpcServerLogFields = {
  transport: 'tcp' | 'pipe' | 'pending'
  listening: boolean
  host?: string
  port?: number
  socketPath?: string
}

const namedPipePath = (name: string): string =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\open-science-${name}-${process.pid}-${randomUUID()}`
    : join(realpathSync('/tmp'), `os-${process.pid}-${randomUUID().slice(0, 8)}.sock`)

const listen = (server: Server, target: { host: string } | { socketPath: string }): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }

    if ('socketPath' in target) server.listen(target.socketPath, onListening)
    else server.listen(0, target.host, onListening)
  })

// Windows child processes can be blocked from app-owned loopback TCP by host security software.
// Use a named pipe there; other platforms retain the established loopback HTTP transport.
const listenForLocalRpc = async (
  server: Server,
  options: LocalRpcListenOptions
): Promise<LocalRpcTransport> => {
  const transport =
    options.transport ?? (process.platform === 'win32' ? ('pipe' as const) : ('tcp' as const))

  if (transport === 'pipe') {
    const socketPath = namedPipePath(options.name)
    await listen(server, { socketPath })
    return { endpoint: 'http://localhost', socketPath }
  }

  await listen(server, { host: options.host ?? '127.0.0.1' })
  const address = server.address()
  if (typeof address !== 'object' || address === null) {
    throw new Error('Local RPC server did not return a TCP address.')
  }
  return { endpoint: `http://${address.address}:${address.port}` }
}

const localRpcServerLogFields = (server: Server): LocalRpcServerLogFields => {
  const address = server.address()
  if (typeof address === 'string') {
    return { transport: 'pipe', listening: server.listening, socketPath: address }
  }
  if (address) {
    return {
      transport: 'tcp',
      listening: server.listening,
      host: address.address,
      port: address.port
    }
  }
  return { transport: 'pending', listening: server.listening }
}

const requestBody = (
  body: BodyInit | null | undefined
): string | Buffer | Uint8Array | undefined => {
  if (body == null) return undefined
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (body instanceof URLSearchParams) return body.toString()
  throw new Error('Named-pipe fetch received an unsupported request body.')
}

// Implements the small Fetch surface used by MCP Streamable HTTP and the app-local JSON RPC calls.
// Keeping it Fetch-compatible lets the existing MCP client own protocol/session behavior unchanged.
const fetchOverSocket = (socketPath: string): typeof fetch => {
  const socketFetch = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const headers = new Headers(init.headers)
    const body = requestBody(init.body)

    return new Promise<Response>((resolve, reject) => {
      const request = httpRequest(
        {
          socketPath,
          path: `${url.pathname}${url.search}`,
          method: init.method ?? 'GET',
          headers: Object.fromEntries(headers.entries())
        },
        (response) => {
          const responseHeaders = new Headers()
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1])
          }
          const status = response.statusCode ?? 500
          const responseBody = status === 204 || status === 304 ? null : Readable.toWeb(response)
          resolve(
            new Response(responseBody as ReadableStream<Uint8Array> | null, {
              status,
              statusText: response.statusMessage,
              headers: responseHeaders
            })
          )
        }
      )

      const abort = (): void => {
        request.destroy(new Error('The named-pipe request was aborted.'))
      }
      request.once('error', reject)
      if (init.signal?.aborted) abort()
      else init.signal?.addEventListener('abort', abort, { once: true })

      request.once('close', () => init.signal?.removeEventListener('abort', abort))
      if (body !== undefined) request.write(body)
      request.end()
    })
  }
  return socketFetch as typeof fetch
}

// The global fetch implementation applies an Undici response-headers timeout. A Session Plan may
// intentionally wait for user review longer than that, so this narrow transport uses node:http,
// which has no implicit response timeout, while retaining AbortSignal ownership.
const fetchWithoutHeadersTimeout = (transport: LocalRpcTransport): typeof fetch => {
  const longLivedFetch = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const headers = new Headers(init.headers)
    const body = requestBody(init.body)
    const requestOptions: HttpRequestOptions = {
      ...(transport.socketPath
        ? { socketPath: transport.socketPath }
        : {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || undefined
          }),
      path: `${url.pathname}${url.search}`,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(headers.entries())
    }

    return new Promise<Response>((resolve, reject) => {
      const request = httpRequest(requestOptions, (response) => {
        const responseHeaders = new Headers()
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1])
        }
        const status = response.statusCode ?? 500
        const responseBody = status === 204 || status === 304 ? null : Readable.toWeb(response)
        resolve(
          new Response(responseBody as ReadableStream<Uint8Array> | null, {
            status,
            statusText: response.statusMessage,
            headers: responseHeaders
          })
        )
      })

      const abort = (): void => {
        const reason = init.signal?.reason
        request.destroy(reason instanceof Error ? reason : new Error('The request was aborted.'))
      }
      request.once('error', reject)
      if (init.signal?.aborted) abort()
      else init.signal?.addEventListener('abort', abort, { once: true })

      request.once('close', () => init.signal?.removeEventListener('abort', abort))
      if (body !== undefined) request.write(body)
      request.end()
    })
  }
  return longLivedFetch as typeof fetch
}

const errorDetail = (error: unknown): string => {
  const root = error as { message?: unknown; code?: unknown; cause?: unknown }
  const cause = root?.cause as { message?: unknown; code?: unknown } | undefined
  const code =
    typeof cause?.code === 'string'
      ? cause.code
      : typeof root?.code === 'string'
        ? root.code
        : undefined
  const message =
    typeof cause?.message === 'string'
      ? cause.message
      : typeof root?.message === 'string'
        ? root.message
        : String(error)
  return code && !message.includes(code) ? `${code}: ${message}` : message
}

const fetchLocalRpc = async (
  transport: LocalRpcTransport,
  init: RequestInit,
  label: string
): Promise<Response> => {
  try {
    const request = transport.socketPath ? fetchOverSocket(transport.socketPath) : fetch
    return await request(transport.endpoint, init)
  } catch (error) {
    throw new Error(`${label} transport failed: ${errorDetail(error)}`, { cause: error })
  }
}

const fetchLongLivedLocalRpc = async (
  transport: LocalRpcTransport,
  init: RequestInit,
  label: string
): Promise<Response> => {
  try {
    return await fetchWithoutHeadersTimeout(transport)(transport.endpoint, init)
  } catch (error) {
    throw new Error(`${label} transport failed: ${errorDetail(error)}`, { cause: error })
  }
}

export {
  fetchLocalRpc,
  fetchLongLivedLocalRpc,
  fetchOverSocket,
  listenForLocalRpc,
  localRpcServerLogFields
}
export type { LocalRpcListenOptions, LocalRpcServerLogFields, LocalRpcTransport }
