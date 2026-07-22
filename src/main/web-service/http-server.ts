import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

import { net } from 'electron'
import { WebSocket, WebSocketServer } from 'ws'

import { addRendererBroadcastSink } from '../renderer-broadcast'
import { authenticateRequest, persistAuthCookie } from './auth'
import type { RpcCapture } from './rpc-capture'
import type { StartTaskRunRequest } from '../../shared/task-api'
import { TaskApiError, type HeadlessTaskApi } from './task-api'

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
  tasks?: Pick<
    HeadlessTaskApi,
    | 'listProjects'
    | 'createProject'
    | 'listSessions'
    | 'getSession'
    | 'startRun'
    | 'getRun'
    | 'listArtifacts'
    | 'acquireArtifact'
    | 'releaseArtifact'
  >
  onShutdownRequest?: () => void
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

const taskErrorStatus = (error: TaskApiError): number => {
  if (error.code === 'invalid_request') return 400
  if (error.code === 'project_ambiguous' || error.code === 'session_busy') return 409
  return 404
}

const taskError = (response: ServerResponse, error: unknown): void => {
  if (error instanceof SyntaxError) {
    json(response, 400, {
      error: { code: 'invalid_request', message: 'Request body must be valid JSON.' }
    })
    return
  }
  if (error instanceof TaskApiError) {
    json(response, taskErrorStatus(error), {
      error: { code: error.code, message: error.message }
    })
    return
  }
  json(response, 500, {
    error: {
      code: 'internal_error',
      message: error instanceof Error ? error.message : 'Internal server error'
    }
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

  await streamPreviewResource(
    request,
    response,
    `open-science-preview://${encodeURIComponent(resourceId)}${suffix}`
  )
}

const streamPreviewResource = async (
  request: IncomingMessage,
  response: ServerResponse,
  resourceUrl: string,
  responseOverrides: Record<string, string> = {}
): Promise<void> => {
  const abortController = new AbortController()
  const abortOnDisconnect = (): void => {
    if (!response.writableFinished) abortController.abort()
  }
  response.once('close', abortOnDisconnect)
  response.once('error', abortOnDisconnect)
  const headers = new Headers()
  if (request.headers.range) headers.set('range', request.headers.range)
  try {
    const upstream = await net.fetch(resourceUrl, {
      method: request.method,
      headers,
      signal: abortController.signal
    })
    if (abortController.signal.aborted) return
    const responseHeaders: Record<string, string> = {}
    upstream.headers.forEach((value, key) => {
      if (!['connection', 'transfer-encoding'].includes(key.toLowerCase()))
        responseHeaders[key] = value
    })
    Object.assign(responseHeaders, responseOverrides)
    response.writeHead(upstream.status, responseHeaders)
    if (!upstream.body || request.method === 'HEAD') {
      response.end()
      return
    }
    try {
      const source = Readable.fromWeb(upstream.body as unknown as NodeReadableStream<Uint8Array>)
      await pipeline(source, response, { signal: abortController.signal })
    } catch (error) {
      if (!abortController.signal.aborted) throw error
    }
  } finally {
    response.off('close', abortOnDisconnect)
    response.off('error', abortOnDisconnect)
  }
}

const handleTaskApiRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  tasks: NonNullable<WebServerOptions['tasks']>
): Promise<boolean> => {
  try {
    if (url.pathname === '/api/v1/projects' && request.method === 'GET') {
      json(response, 200, { data: await tasks.listProjects() })
      return true
    }
    if (url.pathname === '/api/v1/projects' && request.method === 'POST') {
      const body = (await readJsonBody(request)) as { name?: string; description?: string }
      json(response, 201, {
        data: await tasks.createProject({ name: body.name ?? '', description: body.description })
      })
      return true
    }
    if (url.pathname === '/api/v1/sessions' && request.method === 'GET') {
      json(response, 200, {
        data: await tasks.listSessions(url.searchParams.get('project') ?? undefined)
      })
      return true
    }
    if (url.pathname === '/api/v1/runs' && request.method === 'POST') {
      const body = (await readJsonBody(request)) as StartTaskRunRequest
      json(response, 202, { data: await tasks.startRun(body) })
      return true
    }

    const runMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)$/)
    if (runMatch && request.method === 'GET') {
      json(response, 200, { data: tasks.getRun(decodeURIComponent(runMatch[1])) })
      return true
    }
    const sessionArtifactsMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/artifacts$/)
    if (sessionArtifactsMatch && request.method === 'GET') {
      json(response, 200, {
        data: await tasks.listArtifacts(decodeURIComponent(sessionArtifactsMatch[1]))
      })
      return true
    }
    const sessionMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/)
    if (sessionMatch && request.method === 'GET') {
      json(response, 200, { data: await tasks.getSession(decodeURIComponent(sessionMatch[1])) })
      return true
    }
    const artifactMatch = url.pathname.match(/^\/api\/v1\/artifacts\/([^/]+)\/content$/)
    if (artifactMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      const artifact = await tasks.acquireArtifact(decodeURIComponent(artifactMatch[1]))
      try {
        await streamPreviewResource(request, response, artifact.url, {
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`
        })
      } finally {
        await tasks.releaseArtifact(artifact.resourceId)
      }
      return true
    }
  } catch (error) {
    taskError(response, error)
    return true
  }
  return false
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
  const publicEventSockets = new Set<WebSocket>()
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
        url.searchParams.delete('token')
        response.writeHead(302, { location: `${url.pathname}${url.search}${url.hash}` })
        response.end()
        return
      }

      if (url.pathname === '/api/bootstrap' && request.method === 'GET') {
        json(response, 200, { ...options.bootstrap, rpcChannels: options.rpc.channels() })
        return
      }

      if (url.pathname === '/api/shutdown' && request.method === 'POST') {
        if (!options.onShutdownRequest) {
          json(response, 404, { ok: false, error: 'Shutdown is not available.' })
          return
        }
        json(response, 202, { ok: true })
        setImmediate(options.onShutdownRequest)
        return
      }

      if (
        url.pathname.startsWith('/api/v1/') &&
        options.tasks &&
        (await handleTaskApiRequest(request, response, url, options.tasks))
      ) {
        return
      }
      if (url.pathname.startsWith('/api/v1/')) {
        json(response, 404, {
          error: { code: 'not_found', message: 'Task API endpoint not found.' }
        })
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
    if (!auth.ok || !['/events', '/api/v1/events'].includes(url.pathname)) {
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
    if (url.pathname === '/api/v1/events') publicEventSockets.add(socket)
    clientConnections.set(clientId, (clientConnections.get(clientId) ?? 0) + 1)
    socket.on('close', () => {
      sockets.delete(socket)
      publicEventSockets.delete(socket)
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
    const internalMessage = JSON.stringify({ channel, payload })
    const publicMessage =
      channel === 'acp:event'
        ? JSON.stringify({ type: 'run.event', data: payload })
        : channel === 'acp:permission-request'
          ? JSON.stringify({ type: 'permission.requested', data: payload })
          : undefined
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue
      if (publicEventSockets.has(socket)) {
        if (publicMessage) socket.send(publicMessage)
      } else {
        socket.send(internalMessage)
      }
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
