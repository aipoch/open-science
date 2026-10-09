import { createServer } from 'node:http'
import { connect } from 'node:net'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'

// This endpoint is an OS-local desktop attachment, never a browser-accessible TCP listener.
// Business requests retain the existing application command and Web RPC contracts. The secret
// and generation authenticate the process attachment; neither is exposed through the renderer.
export type DesktopEndpoint = Readonly<{
  path: string
  generation: string
  secret: string
  version: string
}>

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

export async function listenForDesktop(
  version: string,
  onConnection: (socket: WebSocket) => void
): Promise<{ endpoint: DesktopEndpoint; close(): Promise<void> }> {
  const generation = randomUUID()
  const directory =
    process.platform === 'win32' ? undefined : await mkdtemp(join(tmpdir(), 'os-desktop-'))
  const path = directory ? join(directory, 'host.sock') : `\\\\.\\pipe\\open-science-${generation}`
  const secret = randomBytes(32).toString('hex')
  const secretBytes = Buffer.from(secret)
  const endpoint: DesktopEndpoint = { path, generation, secret, version }
  const server = createServer((_request, response) => {
    response.writeHead(404)
    response.end()
  })
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false
  })
  let active: WebSocket | undefined
  let closing: Promise<void> | undefined
  server.on('upgrade', (request, socket, head) => {
    const authorization = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '')
    if (
      closing ||
      request.url !== '/desktop' ||
      request.headers.origin !== undefined ||
      request.headers['x-open-science-generation'] !== generation ||
      request.headers['x-open-science-version'] !== version ||
      authorization.length !== secretBytes.length ||
      !timingSafeEqual(authorization, secretBytes)
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    if (active && active.readyState !== WebSocket.CLOSED) {
      socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n')
      return
    }
    sockets.handleUpgrade(request, socket, head, (connection) => {
      active = connection
      connection.on('error', () => connection.terminate())
      connection.once('close', () => {
        if (active === connection) active = undefined
      })
      onConnection(connection)
    })
  })
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      for (const socket of sockets.clients) socket.terminate()
      await new Promise<void>((resolve) => sockets.close(() => resolve()))
      server.closeAllConnections()
      try {
        if (server.listening) {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
        }
      } finally {
        secretBytes.fill(0)
        if (directory) await rm(directory, { recursive: true, force: true })
      }
    })())
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    if (directory) await chmod(path, 0o600)
    return { endpoint, close }
  } catch (error) {
    await close().catch(() => undefined)
    throw error
  }
}

export async function connectToDesktopEndpoint(endpoint: DesktopEndpoint): Promise<WebSocket> {
  const socket = new WebSocket('ws://localhost/desktop', {
    createConnection: () => connect(endpoint.path),
    handshakeTimeout: 5_000,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
    headers: {
      authorization: `Bearer ${endpoint.secret}`,
      'x-open-science-generation': endpoint.generation,
      'x-open-science-version': endpoint.version
    }
  })
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => {
      socket.removeListener('open', opened)
      reject(error)
    }
    const opened = (): void => {
      socket.removeListener('error', failed)
      // The caller binds its lifecycle handlers before the next socket event.
      socket.on('error', () => socket.terminate())
      resolve()
    }
    socket.once('error', failed)
    socket.once('open', opened)
  })
  return socket
}
