import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as connectTcp, createServer as createTcpServer, isIP, type Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'
import { timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'

type GatewayDecision =
  Readonly<{ allowed: true; address: string }> | Readonly<{ allowed: false; message?: string }>

type ParentProxySettings = Readonly<{
  http?: string
  https?: string
  noProxy?: string
  trustedCaCertificates?: readonly string[]
}>

type CommandGatewayOptions = Readonly<{
  decide: (host: string, port: number) => Promise<GatewayDecision>
  credentials: GatewayCredentials
  localRpcSocketPath?: string
  parentProxy?: ParentProxySettings
  sharedPort?: number
}>

type GatewayCredentials = Readonly<{ username: string; password: string }>

type ParentProxy = Readonly<{
  http?: URL
  https?: URL
  noProxy: readonly string[]
  ca?: readonly string[]
}>

type SocketReader = Readonly<{
  receive: (needed: number) => Promise<Buffer>
  remainder: () => Buffer
}>

type SharedIngressState = {
  port: number
  ingress: ReturnType<typeof createTcpServer>
  gateways: Set<CommandGateway>
  pendingConnections: Set<Socket>
}

let sharedIngress: SharedIngressState | undefined
let sharedIngressOperation: Promise<void> = Promise.resolve()

const sharedGatewayPortActive = (port: number): boolean => sharedIngress?.port === port

const withSharedIngressLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = sharedIngressOperation
  let release!: () => void
  sharedIngressOperation = new Promise<void>((resolve) => (release = resolve))
  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

const socketReader = (client: Socket, initial: Buffer): SocketReader => {
  let buffered = initial
  return {
    receive: async (needed) => {
      while (buffered.length < needed) {
        const chunk = await new Promise<Buffer>((resolve, reject) => {
          const onData = (value: Buffer): void => {
            cleanup()
            resolve(value)
          }
          const onError = (error: Error): void => {
            cleanup()
            reject(error)
          }
          const onClose = (): void => {
            cleanup()
            reject(new Error('Gateway client closed.'))
          }
          const cleanup = (): void => {
            client.removeListener('data', onData)
            client.removeListener('error', onError)
            client.removeListener('close', onClose)
          }
          client.once('data', onData)
          client.once('error', onError)
          client.once('close', onClose)
        })
        buffered = Buffer.concat([buffered, chunk])
      }
      const value = buffered.subarray(0, needed)
      buffered = buffered.subarray(needed)
      return value
    },
    remainder: () => buffered
  }
}

const withoutConnectionHeaders = (headers: IncomingHttpHeaders): IncomingHttpHeaders => {
  const result = { ...headers }
  const named = String(headers.connection ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
  for (const name of [
    'connection',
    'proxy-connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    ...named
  ]) {
    delete result[name]
  }
  return result
}

const proxyCredentials = (url: URL): string | undefined => {
  if (!url.username && !url.password) return undefined
  const value = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
  return `Basic ${Buffer.from(value).toString('base64')}`
}

const isSocksProxy = (url: URL): boolean =>
  url.protocol === 'socks:' || url.protocol === 'socks4:' || url.protocol === 'socks5:'

const defaultPort = (url: URL): number =>
  Number(url.port || (isSocksProxy(url) ? 1080 : url.protocol === 'https:' ? 443 : 80))

const urlHost = (address: string): string => (address.includes(':') ? `[${address}]` : address)

const parseProxy = (settings: ParentProxySettings | undefined): ParentProxy | undefined => {
  if (!settings?.http && !settings?.https) return undefined
  const parse = (value: string | undefined): URL | undefined => {
    if (!value) return undefined
    const url = new URL(value)
    if (
      url.protocol !== 'http:' &&
      url.protocol !== 'https:' &&
      url.protocol !== 'socks:' &&
      url.protocol !== 'socks4:' &&
      url.protocol !== 'socks5:'
    ) {
      throw new Error(`Unsupported parent proxy protocol: ${url.protocol}`)
    }
    return url
  }
  return {
    http: parse(settings.http),
    https: parse(settings.https),
    noProxy: (settings.noProxy ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
    ...(settings.trustedCaCertificates?.length ? { ca: [...settings.trustedCaCertificates] } : {})
  }
}

const bypassesProxy = (proxy: ParentProxy, host: string, port: number): boolean =>
  proxy.noProxy.some((entry) => {
    if (entry === '*') return true
    const split = entry.lastIndexOf(':')
    const hasPort = split > 0 && /^\d+$/.test(entry.slice(split + 1))
    if (hasPort && Number(entry.slice(split + 1)) !== port) return false
    const pattern = (hasPort ? entry.slice(0, split) : entry).replace(/^\./, '')
    return host === pattern || host.endsWith(`.${pattern}`)
  })

const selectProxy = (
  proxy: ParentProxy | undefined,
  host: string,
  port: number,
  secureTarget: boolean
): URL | undefined => {
  if (!proxy || bypassesProxy(proxy, host, port)) return undefined
  return secureTarget ? (proxy.https ?? proxy.http) : (proxy.http ?? proxy.https)
}

const waitForTcpConnection = (socket: Socket): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const connected = (): void => {
      socket.removeListener('error', failed)
      resolve(socket)
    }
    const failed = (error: Error): void => {
      socket.removeListener('connect', connected)
      reject(error)
    }
    socket.once('connect', connected)
    socket.once('error', failed)
  })

const connectProxySocket = (url: URL, ca: readonly string[] | undefined): Promise<Socket> => {
  const options = { host: url.hostname, port: defaultPort(url) }
  if (url.protocol !== 'https:') return waitForTcpConnection(connectTcp(options))
  return new Promise((resolve, reject) => {
    const socket = connectTls({ ...options, ca: ca ? [...ca] : undefined })
    const ready = (): void => {
      socket.removeListener('error', failed)
      resolve(socket)
    }
    const failed = (error: Error): void => {
      socket.removeListener('secureConnect', ready)
      reject(error)
    }
    socket.once('secureConnect', ready)
    socket.once('error', failed)
  })
}

const socks5Address = (address: string): Buffer => {
  if (isIP(address) === 4) {
    return Buffer.from([1, ...address.split('.').map(Number)])
  }
  const encoded = Buffer.from(address, 'ascii')
  if (encoded.length > 255) throw new Error('SOCKS destination address is too long.')
  // The policy layer already resolved and approved this value. Passing a numeric IPv6 address as a
  // SOCKS domain avoids a second DNS lookup without carrying an IP parsing dependency.
  return Buffer.concat([Buffer.from([3, encoded.length]), encoded])
}

const tunnelThroughSocks5 = async (
  proxyUrl: URL,
  address: string,
  port: number
): Promise<Socket> => {
  const socket = await connectProxySocket(proxyUrl, undefined)
  const reader = socketReader(socket, Buffer.alloc(0))
  try {
    socket.write(Buffer.from([5, 1, 0]))
    const greeting = await reader.receive(2)
    if (greeting[0] !== 5 || greeting[1] !== 0) {
      throw new Error('Parent SOCKS5 proxy does not permit unauthenticated connections.')
    }
    const portBytes = Buffer.alloc(2)
    portBytes.writeUInt16BE(port)
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), socks5Address(address), portBytes]))
    const response = await reader.receive(4)
    if (response[0] !== 5 || response[1] !== 0) {
      throw new Error(`Parent SOCKS5 proxy rejected the tunnel with status ${response[1] ?? 1}.`)
    }
    if (response[3] === 1) await reader.receive(4)
    else if (response[3] === 4) await reader.receive(16)
    else if (response[3] === 3) await reader.receive((await reader.receive(1))[0]!)
    else throw new Error('Parent SOCKS5 proxy returned an invalid address type.')
    await reader.receive(2)
    const remainder = reader.remainder()
    if (remainder.length) socket.unshift(remainder)
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

const tunnelThroughSocks4 = async (
  proxyUrl: URL,
  address: string,
  port: number
): Promise<Socket> => {
  if (isIP(address) !== 4) {
    throw new Error('Parent SOCKS4 proxy cannot route a non-IPv4 policy address.')
  }
  const socket = await connectProxySocket(proxyUrl, undefined)
  const reader = socketReader(socket, Buffer.alloc(0))
  try {
    const portBytes = Buffer.alloc(2)
    portBytes.writeUInt16BE(port)
    socket.write(
      Buffer.concat([
        Buffer.from([4, 1]),
        portBytes,
        Buffer.from(address.split('.').map(Number)),
        Buffer.from([0])
      ])
    )
    const response = await reader.receive(8)
    if (response[0] !== 0 || response[1] !== 0x5a) {
      throw new Error(`Parent SOCKS4 proxy rejected the tunnel with status ${response[1] ?? 91}.`)
    }
    const remainder = reader.remainder()
    if (remainder.length) socket.unshift(remainder)
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

const readHeader = (socket: Socket): Promise<{ header: string; remainder: Buffer }> =>
  new Promise((resolve, reject) => {
    let received = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk])
      const end = received.indexOf('\r\n\r\n')
      if (end < 0) {
        if (received.length > 64 * 1024) reject(new Error('Parent proxy response is too large.'))
        return
      }
      cleanup()
      resolve({
        header: received.subarray(0, end + 4).toString('latin1'),
        remainder: received.subarray(end + 4)
      })
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('Parent proxy closed the tunnel handshake.'))
    }
    const cleanup = (): void => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })

const readClientHttpHead = (socket: Socket, initial: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    let received = initial
    const inspect = (): void => {
      if (received.indexOf('\r\n\r\n') >= 0) {
        cleanup()
        resolve(received)
      } else if (received.length > 64 * 1024) {
        cleanup()
        reject(new Error('Proxy request headers are too large.'))
      }
    }
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk])
      inspect()
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('Proxy client closed before sending request headers.'))
    }
    const cleanup = (): void => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    inspect()
  })

const tunnelThroughProxy = async (
  proxyUrl: URL,
  address: string,
  port: number,
  ca: readonly string[] | undefined
): Promise<Socket> => {
  if (proxyUrl.protocol === 'socks4:') return tunnelThroughSocks4(proxyUrl, address, port)
  if (proxyUrl.protocol === 'socks:' || proxyUrl.protocol === 'socks5:') {
    return tunnelThroughSocks5(proxyUrl, address, port)
  }
  const socket = await connectProxySocket(proxyUrl, ca)
  const authority = `${urlHost(address)}:${port}`
  const authorization = proxyCredentials(proxyUrl)
  socket.write(
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ''}Connection: keep-alive\r\n\r\n`
  )
  const response = await readHeader(socket)
  const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(response.header)?.[1]
  if (status !== '200') {
    socket.destroy()
    throw new Error(`Parent proxy rejected the tunnel with status ${status ?? 'unknown'}.`)
  }
  if (response.remainder.length) socket.unshift(response.remainder)
  return socket
}

const directSocket = (address: string, port: number): Promise<Socket> =>
  waitForTcpConnection(connectTcp({ host: address, port }))

const destinationSocket = (
  parent: ParentProxy | undefined,
  host: string,
  address: string,
  port: number
): Promise<Socket> => {
  const proxyUrl = selectProxy(parent, host, port, true)
  return proxyUrl
    ? tunnelThroughProxy(proxyUrl, address, port, parent?.ca)
    : directSocket(address, port)
}

const rejectHttp = (response: ServerResponse, message: string): void => {
  response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
  response.end(message)
}

const rejectSocket = (socket: Socket, message: string): void => {
  socket.end(
    `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`
  )
}

const rejectAuthentication = (response: ServerResponse): void => {
  response.writeHead(407, {
    'proxy-authenticate': 'Basic realm="Open Science Notebook"',
    connection: 'close'
  })
  response.end('Proxy authentication required.')
}

const rejectSocketAuthentication = (socket: Socket): void => {
  socket.end(
    'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Open Science Notebook"\r\nConnection: close\r\nContent-Length: 30\r\n\r\nProxy authentication required.'
  )
}

const secureEqual = (actual: string, expected: string): boolean => {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

const parseAuthority = (
  authority: string,
  fallbackPort: number
): { host: string; port: number } => {
  const url = new URL(`http://${authority}`)
  return { host: url.hostname, port: Number(url.port || fallbackPort) }
}

const LOCAL_RPC_BROKER_HOST = 'open-science-notebook-rpc.invalid'

class CommandGateway {
  readonly #options: CommandGatewayOptions
  #parent: ParentProxy | undefined
  readonly #connections = new Set<Socket>()
  readonly #http = createHttpServer()
  readonly #ingress = createTcpServer()
  #active = true
  #connectionGeneration = 0
  #closePromise: Promise<void> | undefined
  #port: number | undefined
  #sharedIngress: SharedIngressState | undefined

  private constructor(options: CommandGatewayOptions) {
    this.#options = options
    this.#parent = parseProxy(options.parentProxy)
    this.#http.on('request', (request, response) => void this.#forwardHttp(request, response))
    this.#http.on(
      'connect',
      (request, socket, head) => void this.#openConnect(request, socket as Socket, head)
    )
    this.#http.on('clientError', (_error, socket) => socket.destroy())
    this.#ingress.on('connection', (socket) => this.#accept(socket))
  }

  static async open(options: CommandGatewayOptions): Promise<CommandGateway> {
    const gateway = new CommandGateway(options)
    if (options.sharedPort !== undefined) {
      if (
        !Number.isInteger(options.sharedPort) ||
        options.sharedPort < 1 ||
        options.sharedPort > 65535
      ) {
        throw new Error('Shared policy gateway port is invalid.')
      }
      await CommandGateway.#attachShared(gateway, options.sharedPort)
      return gateway
    }
    const listen = (port: number): Promise<void> =>
      new Promise((resolve, reject) => {
        const failed = (error: Error): void => {
          gateway.#ingress.removeListener('listening', ready)
          reject(error)
        }
        const ready = (): void => {
          gateway.#ingress.removeListener('error', failed)
          resolve()
        }
        gateway.#ingress.once('error', failed)
        gateway.#ingress.once('listening', ready)
        gateway.#ingress.listen(port, '127.0.0.1')
      })
    await listen(0)
    const address = gateway.#ingress.address()
    if (!address || typeof address === 'string') throw new Error('Policy gateway did not bind TCP.')
    gateway.#port = address.port
    gateway.#ingress.unref()
    return gateway
  }

  get port(): number {
    if (this.#port === undefined) throw new Error('Policy gateway is not listening.')
    return this.#port
  }

  updateParentProxy(settings: ParentProxySettings | undefined): void {
    this.#parent = parseProxy(settings)
  }

  resetConnections(): void {
    this.#connectionGeneration += 1
    for (const socket of this.#connections) socket.destroy()
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    this.#active = false
    this.#closePromise = this.#close()
    return this.#closePromise
  }

  async #close(): Promise<void> {
    this.resetConnections()
    if (this.#sharedIngress) {
      const state = this.#sharedIngress
      this.#sharedIngress = undefined
      await withSharedIngressLock(async () => {
        state.gateways.delete(this)
        if (state.gateways.size > 0 || sharedIngress !== state) return
        sharedIngress = undefined
        for (const socket of state.pendingConnections) socket.destroy()
        await new Promise<void>((resolve) => state.ingress.close(() => resolve()))
      })
      return
    }
    await new Promise<void>((resolve) => this.#ingress.close(() => resolve()))
  }

  static async #attachShared(gateway: CommandGateway, port: number): Promise<void> {
    await withSharedIngressLock(async () => {
      if (!sharedIngress) {
        const ingress = createTcpServer()
        const state: SharedIngressState = {
          port,
          ingress,
          gateways: new Set(),
          pendingConnections: new Set()
        }
        ingress.on('connection', (socket) => CommandGateway.#routeShared(state, socket))
        await new Promise<void>((resolve, reject) => {
          ingress.once('error', reject)
          ingress.listen(port, '127.0.0.1', () => {
            ingress.removeListener('error', reject)
            resolve()
          })
        })
        ingress.unref()
        sharedIngress = state
      }
      if (sharedIngress.port !== port) {
        throw new Error('Notebook shared policy gateway port does not match the active listener.')
      }
      sharedIngress.gateways.add(gateway)
      gateway.#sharedIngress = sharedIngress
      gateway.#port = port
    })
  }

  static #routeShared(state: SharedIngressState, socket: Socket): void {
    state.pendingConnections.add(socket)
    socket.once('close', () => state.pendingConnections.delete(socket))
    socket.once('error', () => socket.destroy())
    socket.once('data', (first: Buffer) => {
      if (first[0] === 0x05) void CommandGateway.#routeSharedSocks(state, socket, first)
      else void CommandGateway.#routeSharedHttp(state, socket, first)
    })
  }

  static async #routeSharedHttp(
    state: SharedIngressState,
    socket: Socket,
    first: Buffer
  ): Promise<void> {
    try {
      const request = await readClientHttpHead(socket, first)
      const authorization = request
        .toString('latin1')
        .match(/(?:^|\r\n)proxy-authorization:\s*([^\r\n]+)/i)?.[1]
      const gateway = [...state.gateways].find((candidate) =>
        candidate.#authenticated(authorization)
      )
      if (!gateway || !state.gateways.has(gateway)) {
        rejectSocketAuthentication(socket)
        return
      }
      state.pendingConnections.delete(socket)
      if (!gateway.#trackConnection(socket)) return
      socket.unshift(request)
      gateway.#http.emit('connection', socket)
    } catch {
      socket.destroy()
    }
  }

  static async #routeSharedSocks(
    state: SharedIngressState,
    client: Socket,
    first: Buffer
  ): Promise<void> {
    const reader = socketReader(client, first)
    try {
      const greeting = await reader.receive(2)
      if (greeting[0] !== 5) throw new Error('Unsupported SOCKS version.')
      const methods = await reader.receive(greeting[1]!)
      if (!methods.includes(2)) {
        client.end(Buffer.from([5, 0xff]))
        return
      }
      client.write(Buffer.from([5, 2]))
      const authHeader = await reader.receive(2)
      if (authHeader[0] !== 1) throw new Error('Unsupported SOCKS authentication version.')
      const username = (await reader.receive(authHeader[1]!)).toString('utf8')
      const passwordLength = (await reader.receive(1))[0]!
      const password = (await reader.receive(passwordLength)).toString('utf8')
      const gateway = [...state.gateways].find((candidate) =>
        candidate.#matchesCredentials(username, password)
      )
      const authenticated = gateway !== undefined && state.gateways.has(gateway)
      client.write(Buffer.from([1, authenticated ? 0 : 1]))
      if (!gateway || !authenticated) {
        client.end()
        return
      }
      state.pendingConnections.delete(client)
      if (!gateway.#trackConnection(client)) return
      await gateway.#serveSocksRequest(client, reader)
    } catch {
      if (!client.destroyed) client.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]))
    }
  }

  #accept(socket: Socket): void {
    if (!this.#trackConnection(socket)) return
    socket.once('data', (first: Buffer) => {
      if (first[0] === 0x05) {
        void this.#serveSocks(socket, first)
      } else {
        socket.unshift(first)
        this.#http.emit('connection', socket)
      }
    })
  }

  #trackConnection(socket: Socket): boolean {
    if (!this.#active) {
      socket.destroy()
      return false
    }
    this.#connections.add(socket)
    socket.once('error', () => socket.destroy())
    socket.once('close', () => this.#connections.delete(socket))
    return true
  }

  async #authorize(host: string, port: number, generation: number): Promise<GatewayDecision> {
    try {
      const decision = await this.#options.decide(host, port)
      if (!this.#active || generation !== this.#connectionGeneration) {
        return { allowed: false, message: 'OPEN_SCIENCE_NETWORK_POLICY_BLOCKED' }
      }
      return decision
    } catch {
      return { allowed: false, message: 'OPEN_SCIENCE_NETWORK_POLICY_BLOCKED' }
    }
  }

  #authenticated(header: string | string[] | undefined): boolean {
    if (!this.#active) return false
    if (typeof header !== 'string' || !header.startsWith('Basic ')) return false
    let supplied: string
    try {
      supplied = Buffer.from(header.slice(6), 'base64').toString('utf8')
    } catch {
      return false
    }
    return secureEqual(
      supplied,
      `${this.#options.credentials.username}:${this.#options.credentials.password}`
    )
  }

  #matchesCredentials(username: string, password: string): boolean {
    return (
      this.#active &&
      secureEqual(username, this.#options.credentials.username) &&
      secureEqual(password, this.#options.credentials.password)
    )
  }

  async #forwardHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const generation = this.#connectionGeneration
    if (!this.#authenticated(request.headers['proxy-authorization'])) {
      rejectAuthentication(response)
      return
    }
    let target: URL
    try {
      target =
        request.url?.startsWith('http://') || request.url?.startsWith('https://')
          ? new URL(request.url)
          : new URL(request.url ?? '/', `http://${request.headers.host ?? ''}`)
    } catch {
      rejectHttp(response, 'OPEN_SCIENCE_NETWORK_POLICY_BLOCKED: malformed proxy request')
      return
    }
    if (target.hostname === LOCAL_RPC_BROKER_HOST) {
      this.#forwardLocalRpc(request, response, target)
      return
    }
    const port = defaultPort(target)
    const decision = await this.#authorize(target.hostname, port, generation)
    if (!decision.allowed) {
      rejectHttp(response, decision.message ?? 'OPEN_SCIENCE_NETWORK_POLICY_BLOCKED')
      return
    }
    const proxyUrl = selectProxy(this.#parent, target.hostname, port, target.protocol === 'https:')
    const routedTarget = new URL(target.href)
    routedTarget.hostname = urlHost(decision.address)
    const headers = withoutConnectionHeaders(request.headers)
    headers.host = target.host
    if (proxyUrl && !isSocksProxy(proxyUrl)) {
      const credentials = proxyCredentials(proxyUrl)
      if (credentials) headers['proxy-authorization'] = credentials
    }
    if (proxyUrl && isSocksProxy(proxyUrl)) {
      try {
        const tunnel = await tunnelThroughProxy(proxyUrl, decision.address, port, undefined)
        if (!this.#active || generation !== this.#connectionGeneration) {
          tunnel.destroy()
          response.destroy()
          return
        }
        const connection =
          target.protocol === 'https:'
            ? await new Promise<Socket>((resolve, reject) => {
                const tls = connectTls({
                  socket: tunnel,
                  servername: target.hostname,
                  ca: this.#parent?.ca ? [...this.#parent.ca] : undefined
                })
                tls.once('secureConnect', () => resolve(tls))
                tls.once('error', reject)
              })
            : tunnel
        if (!this.#trackConnection(connection)) {
          response.destroy()
          return
        }
        const send = target.protocol === 'https:' ? httpsRequest : httpRequest
        const upstream = send(
          {
            agent: false,
            createConnection: () => connection,
            method: request.method,
            path: `${target.pathname}${target.search}`,
            headers
          },
          (upstreamResponse) => {
            response.writeHead(
              upstreamResponse.statusCode ?? 502,
              withoutConnectionHeaders(upstreamResponse.headers)
            )
            upstreamResponse.pipe(response)
          }
        )
        upstream.once('error', (error) => {
          if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' })
          response.end(`Policy gateway could not reach the destination: ${error.message}`)
        })
        request.pipe(upstream)
      } catch (error) {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' })
        response.end(
          `Policy gateway could not reach the destination: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      return
    }
    const send = (proxyUrl?.protocol ?? target.protocol) === 'https:' ? httpsRequest : httpRequest
    const upstream = send(
      proxyUrl
        ? {
            hostname: proxyUrl.hostname,
            port: defaultPort(proxyUrl),
            method: request.method,
            path: routedTarget.href,
            headers,
            ca: this.#parent?.ca ? [...this.#parent.ca] : undefined
          }
        : {
            hostname: decision.address,
            port,
            method: request.method,
            path: `${target.pathname}${target.search}`,
            headers,
            ...(target.protocol === 'https:' ? { servername: target.hostname } : {})
          },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          withoutConnectionHeaders(upstreamResponse.headers)
        )
        upstreamResponse.pipe(response)
      }
    )
    upstream.once('error', (error) => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' })
      response.end(`Policy gateway could not reach the destination: ${error.message}`)
    })
    request.pipe(upstream)
  }

  #forwardLocalRpc(request: IncomingMessage, response: ServerResponse, target: URL): void {
    const socketPath = this.#options.localRpcSocketPath
    if (!socketPath || target.protocol !== 'http:' || defaultPort(target) !== 80) {
      rejectHttp(response, 'OPEN_SCIENCE_NETWORK_POLICY_BLOCKED: local RPC route unavailable')
      return
    }
    const headers = withoutConnectionHeaders(request.headers)
    headers.host = 'localhost'
    const upstream = httpRequest(
      {
        socketPath,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          withoutConnectionHeaders(upstreamResponse.headers)
        )
        upstreamResponse.pipe(response)
      }
    )
    upstream.once('error', (error) => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' })
      response.end(`Policy gateway could not reach local RPC: ${error.message}`)
    })
    request.pipe(upstream)
  }

  async #openConnect(request: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    const generation = this.#connectionGeneration
    if (!this.#authenticated(request.headers['proxy-authorization'])) {
      rejectSocketAuthentication(client)
      return
    }
    let destination: { host: string; port: number }
    try {
      destination = parseAuthority(request.url ?? '', 443)
    } catch {
      rejectSocket(client, 'OPEN_SCIENCE_NETWORK_POLICY_BLOCKED: malformed CONNECT target')
      return
    }
    const decision = await this.#authorize(destination.host, destination.port, generation)
    if (!decision.allowed) {
      rejectSocket(client, decision.message ?? 'OPEN_SCIENCE_NETWORK_POLICY_BLOCKED')
      return
    }
    try {
      const upstream = await destinationSocket(
        this.#parent,
        destination.host,
        decision.address,
        destination.port
      )
      if (!this.#active || generation !== this.#connectionGeneration) {
        upstream.destroy()
        client.destroy()
        return
      }
      if (!this.#trackConnection(upstream)) {
        client.destroy()
        return
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream).pipe(client)
    } catch (error) {
      rejectSocket(
        client,
        `Policy gateway could not open the tunnel: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async #serveSocks(client: Socket, initial: Buffer): Promise<void> {
    const reader = socketReader(client, initial)
    try {
      const greeting = await reader.receive(2)
      if (greeting[0] !== 5) throw new Error('Unsupported SOCKS version.')
      const methods = await reader.receive(greeting[1]!)
      if (!methods.includes(2)) {
        client.end(Buffer.from([5, 0xff]))
        return
      }
      client.write(Buffer.from([5, 2]))
      const authHeader = await reader.receive(2)
      if (authHeader[0] !== 1) throw new Error('Unsupported SOCKS authentication version.')
      const username = (await reader.receive(authHeader[1]!)).toString('utf8')
      const passwordLength = (await reader.receive(1))[0]!
      const password = (await reader.receive(passwordLength)).toString('utf8')
      const authenticated = this.#matchesCredentials(username, password)
      client.write(Buffer.from([1, authenticated ? 0 : 1]))
      if (!authenticated) {
        client.end()
        return
      }
      await this.#serveSocksRequest(client, reader)
    } catch {
      if (!client.destroyed) client.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]))
    }
  }

  async #serveSocksRequest(client: Socket, reader: SocketReader): Promise<void> {
    const generation = this.#connectionGeneration
    const header = await reader.receive(4)
    if (header[0] !== 5 || header[1] !== 1) throw new Error('Only SOCKS CONNECT is supported.')
    let host: string
    if (header[3] === 1) {
      host = [...(await reader.receive(4))].join('.')
    } else if (header[3] === 3) {
      const length = (await reader.receive(1))[0]!
      host = (await reader.receive(length)).toString('utf8')
    } else if (header[3] === 4) {
      const bytes = await reader.receive(16)
      const words: string[] = []
      for (let index = 0; index < bytes.length; index += 2) {
        words.push(bytes.readUInt16BE(index).toString(16))
      }
      host = words.join(':')
    } else {
      throw new Error('Unsupported SOCKS address type.')
    }
    const port = (await reader.receive(2)).readUInt16BE(0)
    const decision = await this.#authorize(host, port, generation)
    if (!decision.allowed) {
      client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]))
      return
    }
    const upstream = await destinationSocket(this.#parent, host, decision.address, port)
    if (!this.#active || generation !== this.#connectionGeneration) {
      upstream.destroy()
      client.destroy()
      return
    }
    if (!this.#trackConnection(upstream)) {
      client.destroy()
      return
    }
    client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
    const buffered = reader.remainder()
    if (buffered.length) upstream.write(buffered)
    client.pipe(upstream).pipe(client)
  }
}

export { CommandGateway, LOCAL_RPC_BROKER_HOST, sharedGatewayPortActive }
export type { CommandGatewayOptions, GatewayCredentials, GatewayDecision, ParentProxySettings }
