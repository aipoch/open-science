import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

import { net } from 'electron'
import { WebSocket, WebSocketServer } from 'ws'

import { addRendererBroadcastSink } from '../renderer-broadcast'
import { authenticateRequest, persistAuthCookie } from './auth'
import type { RpcCapture } from './rpc-capture'

const MAX_RPC_BODY_BYTES = 64 * 1024 * 1024

// Channels the web client reimplements in the browser (see src/renderer/web/bootstrap.ts) because
// their main handlers require a real Electron WebContents: file:save-* open a native save dialog
// parented to a window, and window:close resolves a BrowserWindow from the sender. The synthetic
// RPC sender has neither, so a direct /rpc call would pop a desktop dialog or silently no-op. The
// browser never routes these through /rpc, so reject them outright rather than expose that behavior.
const WEB_CLIENT_OVERRIDDEN_CHANNELS = new Set([
  'file:save-blob',
  'file:save-managed',
  'window:close'
])

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2'
}

type WebServerOptions = {
  host: string
  port: number
  token: string
  staticRoot: string
  rpc: RpcCapture
  bootstrap: {
    appName: string
    appVersion: string
    platform: string
    versions: { electron: string; chrome: string; node: string }
  }
}

export type RunningWebServer = {
  port: number
  close: () => Promise<void>
}

const json = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  response.end(
    JSON.stringify(value ?? null, (_key, child) => {
      if (child instanceof ArrayBuffer || ArrayBuffer.isView(child)) {
        const bytes =
          child instanceof ArrayBuffer
            ? new Uint8Array(child)
            : new Uint8Array(child.buffer, child.byteOffset, child.byteLength)
        return { $binary: Buffer.from(bytes).toString('base64') }
      }
      return child
    })
  )
}

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_RPC_BODY_BYTES) throw new Error('RPC request body is too large.')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'), (_key, child) => {
    if (
      child &&
      typeof child === 'object' &&
      '$binary' in child &&
      typeof child.$binary === 'string'
    ) {
      return Uint8Array.from(Buffer.from(child.$binary, 'base64'))
    }
    return child
  })
}

const streamPreview = async (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<void> => {
  const previewPath = url.pathname.slice('/preview/'.length)
  const slash = previewPath.indexOf('/')
  const resourceId = slash === -1 ? previewPath : previewPath.slice(0, slash)
  const suffix = slash === -1 ? '' : previewPath.slice(slash)
  if (!resourceId) {
    response.writeHead(404).end()
    return
  }

  const headers = new Headers()
  if (request.headers.range) headers.set('range', request.headers.range)
  const upstream = await net.fetch(
    `open-science-preview://${encodeURIComponent(resourceId)}${suffix}`,
    { method: request.method, headers }
  )
  const responseHeaders: Record<string, string> = {}
  upstream.headers.forEach((value, key) => {
    if (!['connection', 'transfer-encoding'].includes(key.toLowerCase()))
      responseHeaders[key] = value
  })
  response.writeHead(upstream.status, responseHeaders)
  if (!upstream.body || request.method === 'HEAD') {
    response.end()
    return
  }

  const reader = upstream.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!response.write(Buffer.from(value))) {
        await new Promise<void>((doneWaiting) => response.once('drain', doneWaiting))
      }
    }
    response.end()
  } finally {
    reader.releaseLock()
  }
}

const serveStatic = async (
  response: ServerResponse,
  staticRoot: string,
  pathname: string
): Promise<void> => {
  const root = resolve(staticRoot)
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1))
  let filePath = resolve(root, requested)
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    response.writeHead(404).end()
    return
  }

  try {
    if (!(await stat(filePath)).isFile()) throw new Error('Not a file')
  } catch {
    filePath = resolve(root, 'index.html')
  }

  try {
    const content = await readFile(filePath)
    response.writeHead(200, {
      'content-type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000',
      'x-content-type-options': 'nosniff'
    })
    response.end(content)
  } catch {
    response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Web UI is not built. Run npm run build:web first.')
  }
}

const startWebHttpServer = async (options: WebServerOptions): Promise<RunningWebServer> => {
  const sockets = new Set<WebSocket>()
  const clientConnections = new Map<string, number>()
  const wsServer = new WebSocketServer({ noServer: true })

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
      const auth = authenticateRequest(request, url, options.token)
      if (!auth.ok) {
        response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Unauthorized')
        return
      }

      if (auth.queryToken && request.method === 'GET' && url.pathname === '/') {
        persistAuthCookie(response, options.token)
        response.writeHead(302, { location: '/' })
        response.end()
        return
      }

      if (url.pathname === '/api/bootstrap' && request.method === 'GET') {
        json(response, 200, { ...options.bootstrap, rpcChannels: options.rpc.channels() })
        return
      }

      if (url.pathname.startsWith('/rpc/') && request.method === 'POST') {
        const channel = decodeURIComponent(url.pathname.slice('/rpc/'.length))
        if (WEB_CLIENT_OVERRIDDEN_CHANNELS.has(channel)) {
          json(response, 403, { ok: false, error: `Channel not available over web: ${channel}` })
          return
        }
        const body = (await readJsonBody(request)) as { args?: unknown[] }
        const clientId = String(request.headers['x-open-science-client'] ?? 'web')
        try {
          const result = await options.rpc.invoke(channel, clientId, body.args ?? [])
          json(response, 200, { ok: true, result })
        } catch (error) {
          json(response, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
        }
        return
      }

      if (
        url.pathname.startsWith('/preview/') &&
        (request.method === 'GET' || request.method === 'HEAD')
      ) {
        await streamPreview(request, response, url)
        return
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        await serveStatic(response, options.staticRoot, url.pathname)
        return
      }

      response.writeHead(404).end()
    } catch (error) {
      json(response, 500, {
        error: error instanceof Error ? error.message : 'Internal server error'
      })
    }
  })

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    const auth = authenticateRequest(request, url, options.token)
    if (!auth.ok || url.pathname !== '/events') {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wsServer.handleUpgrade(request, socket, head, (webSocket) => {
      wsServer.emit('connection', webSocket, request)
    })
  })

  wsServer.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    const clientId = url.searchParams.get('client') ?? 'web'
    sockets.add(socket)
    clientConnections.set(clientId, (clientConnections.get(clientId) ?? 0) + 1)
    socket.on('close', () => {
      sockets.delete(socket)
      const remaining = (clientConnections.get(clientId) ?? 1) - 1
      if (remaining <= 0) {
        clientConnections.delete(clientId)
        options.rpc.releaseClient(clientId)
      } else {
        clientConnections.set(clientId, remaining)
      }
    })
  })

  const removeBroadcastSink = addRendererBroadcastSink((channel, payload) => {
    const message = JSON.stringify({ channel, payload })
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message)
    }
  })

  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.off('error', reject)
      resolveListening()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port

  return {
    port,
    close: async () => {
      removeBroadcastSink()
      for (const socket of sockets) socket.close()
      wsServer.close()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  }
}

export { startWebHttpServer }
