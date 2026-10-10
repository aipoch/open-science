import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import type { RuntimeViewAccess, RuntimeViewScope } from '../../shared/runtime-view'
import { OwnedRuntimeViewService } from './owned-service'
import { RuntimeViewOwner, type OpenRuntimeViewOptions, type RuntimeViewLimits } from './owner'
import { createElectronCallerContext } from '../caller-context'
import {
  desktopObservationFrameRegistry,
  type DesktopObservationFrame
} from '../replay-viewer/desktop-frame-registry'

const loopbackLookup = {
  family: 4,
  lookup: (
    _hostname: string,
    _options: unknown,
    callback: (error: Error | null, address: string, family: number) => void
  ): void => callback(null, '127.0.0.1', 4)
}

const scope: RuntimeViewScope = {
  projectId: 'project',
  sessionId: 'session',
  runId: 'run-1',
  environmentId: 'environment',
  generationId: 'generation'
}
const roots: string[] = [],
  servers: Server[] = [],
  owners: RuntimeViewOwner[] = [],
  services: OwnedRuntimeViewService[] = [],
  sockets = new Set<Socket>(),
  webSockets: WebSocketServer[] = []
afterEach(async () => {
  owners.splice(0).forEach((owner) => owner.close())
  services.splice(0).forEach((service) => service.close())
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  for (const server of webSockets.splice(0)) {
    server.clients.forEach((client) => client.terminate())
    server.close()
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

interface SeenRequest {
  path: string
  socket: number
  headers: IncomingHttpHeaders
  body?: string
}
interface ServiceFixture {
  server: Server
  socketPath: string
  proof: string
  seen: SeenRequest[]
}
interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  body: string
}
interface ViewFixture {
  f: ServiceFixture
  controller: AbortController
  service: OwnedRuntimeViewService
  owner: RuntimeViewOwner
  access: RuntimeViewAccess
  cookie: string
  origin: string
  bootstrap: HttpResult
}
async function fixture(
  options: { socketPath?: string; proof?: string; delayProof?: number } = {}
): Promise<ServiceFixture> {
  const proof = options.proof ?? randomBytes(32).toString('hex')
  let socketPath = options.socketPath
  if (!socketPath) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'os-service-run-1-')))
    await chmod(root, 0o700)
    roots.push(root)
    socketPath = join(root, 'service.sock')
  }
  const seen: SeenRequest[] = []
  const ids = new WeakMap<Socket, number>()
  let nextId = 0
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has('fixture.v2') ? 'fixture.v2' : false)
  })
  webSockets.push(wss)
  const server = createServer(async (req, res) => {
    const entry = {
      path: req.url!,
      socket: ids.get(req.socket)!,
      headers: req.headers
    } as SeenRequest
    seen.push(entry)
    if (req.url === '/__open_science_proof_0123456789abcdef0123456789abcdef') {
      if (options.delayProof)
        await new Promise((resolve) => setTimeout(resolve, options.delayProof))
      res.end(proof)
      return
    }
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: first\n\n')
      const timer = setTimeout(() => res.write('data: second\n\n'), 10)
      res.once('close', () => clearTimeout(timer))
      return
    }
    if (req.url === '/large') {
      res.end(Buffer.alloc(2048))
      return
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/asset.js?version=1' })
      res.end()
      return
    }
    if (req.url === '/external') {
      res.writeHead(302, { location: 'https://outside.invalid/' })
      res.end()
      return
    }
    if (req.url === '/page') {
      res.setHeader('content-security-policy', [
        "default-src 'self'; frame-ancestors 'none'; script-src 'self'",
        "connect-src 'self'; frame-ancestors 'none'"
      ])
      res.writeHead(200, {
        'content-type': 'text/html',
        'x-frame-options': 'DENY',
        'set-cookie': 'upstream_secret=forbidden'
      })
      res.end('<button>Project</button>')
      return
    }
    if (req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      entry.body = Buffer.concat(chunks).toString()
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ path: req.url, headers: req.headers, body: entry.body }))
  })
  server.on('connection', (socket) => {
    ids.set(socket, ++nextId)
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (req, socket, head) => {
    seen.push({ path: req.url!, socket: ids.get(socket as Socket)!, headers: req.headers })
    wss.handleUpgrade(req, socket, head, (client) =>
      client.on('message', (data, binary) => client.send(data, { binary }))
    )
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return { server, socketPath, proof, seen }
}
async function openService(
  f: Awaited<ReturnType<typeof fixture>>,
  controller = new AbortController(),
  assertCurrent = (): void => {
    return undefined
  }
): Promise<OwnedRuntimeViewService> {
  const service = await OwnedRuntimeViewService.open({
    scope,
    socketPath: f.socketPath,
    expectedProof: f.proof,
    proofPath: '/__open_science_proof_0123456789abcdef0123456789abcdef',
    upstreamOrigin: 'http://127.0.0.1:4173',
    signal: controller.signal,
    assertCurrent
  })
  services.push(service)
  return service
}
async function openView(
  options: Partial<OpenRuntimeViewOptions> = {},
  limits: Partial<RuntimeViewLimits> = {}
): Promise<ViewFixture> {
  const f = await fixture()
  const controller = new AbortController()
  const service = await openService(f, controller)
  const owner = new RuntimeViewOwner(limits, desktopObservationFrameRegistry)
  owners.push(owner)
  const access = await owner.open({
    scope,
    service,
    title: 'Fixture',
    allowedParentOrigins: ['http://127.0.0.1:5000'],
    ...options
  })
  const bootstrap = await http(access.url)
  const cookie = bootstrap.headers['set-cookie']![0].split(';')[0]
  return {
    f,
    controller,
    service,
    owner,
    access,
    cookie,
    origin: new URL(access.url).origin,
    bootstrap
  }
}
async function http(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<HttpResult> {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const pending = request(
        url,
        { ...loopbackLookup, method: options.method ?? 'GET', headers: options.headers },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.once('end', () =>
            resolve({
              status: response.statusCode!,
              headers: response.headers,
              body: Buffer.concat(chunks).toString()
            })
          )
          response.once('error', reject)
        }
      )
      pending.once('error', reject)
      pending.end(options.body)
    }
  )
}
function assertSocketProof(seen: SeenRequest[]): void {
  for (const entry of seen.filter(
    (entry) => entry.path !== '/__open_science_proof_0123456789abcdef0123456789abcdef'
  )) {
    const sameSocket = seen.filter((candidate) => candidate.socket === entry.socket)
    expect(sameSocket[0].path).toBe('/__open_science_proof_0123456789abcdef0123456789abcdef')
    expect(sameSocket.slice(1).map((candidate) => candidate.path)).toEqual([entry.path])
  }
}

describe.skipIf(process.platform === 'win32')('owned interactive runtime view transport', () => {
  it('registers only its granted runtime frame under the exact authenticated viewer until Run release', async () => {
    const viewerOrigin = 'http://viewer-runtime-fixture.localhost:32123'
    const grant = randomBytes(32).toString('hex')
    const viewerUrl = `${viewerOrigin}/__open_science_viewer?grant=${grant}`
    const viewer = desktopObservationFrameRegistry.registerViewer({
      origin: viewerOrigin,
      caller: createElectronCallerContext(17),
      expiresAt: Date.now() + 60000,
      assertCurrent: () => undefined
    })
    const mainFrame: DesktopObservationFrame = {
      frameTreeNodeId: 100,
      url: 'file:///app/index.html',
      parent: null
    }
    const viewerFrame: DesktopObservationFrame = {
      frameTreeNodeId: 101,
      url: viewerOrigin + '/',
      parent: mainFrame
    }
    const projectFrame: DesktopObservationFrame = {
      frameTreeNodeId: 102,
      url: 'about:blank',
      parent: viewerFrame
    }
    const allows = (url: string, frame = projectFrame): boolean =>
      desktopObservationFrameRegistry.allows({ url, webContentsId: 17, frame, mainFrame })
    try {
      viewer.issueGrant(viewerUrl, Date.now() + 60000)
      expect(allows(viewerUrl, viewerFrame)).toBe(true)
      viewer.authenticateGrant(grant)
      const f = await fixture()
      const controller = new AbortController()
      const service = await openService(f, controller)
      const owner = new RuntimeViewOwner({}, desktopObservationFrameRegistry)
      owners.push(owner)
      const access = await owner.open({
        scope,
        service,
        title: 'Desktop',
        allowedParentOrigins: [viewerOrigin, 'file:'],
        adaptFrameAncestors: true
      })
      const origin = new URL(access.url).origin
      expect(allows(access.url, viewerFrame)).toBe(false)
      expect(allows(origin + '/')).toBe(false)
      expect(allows(access.url)).toBe(true)
      expect((await http(access.url)).status).toBe(303)
      expect(allows(origin + '/')).toBe(true)
      expect(allows(access.url)).toBe(false)
      controller.abort()
      expect(allows(origin + '/')).toBe(false)
    } finally {
      viewer.close()
    }
  })

  it('serves assets and POST on the same proven Unix connections without forwarding management credentials', async () => {
    const v = await openView({ allowedRequestHeaders: ['x-project-csrf'] })
    expect(v.bootstrap.status).toBe(303)
    expect(v.bootstrap.headers.location).toBe('/')
    const result = await http(`${v.origin}/asset.js?version=1`, {
      headers: {
        cookie: `${v.cookie}; management=secret`,
        authorization: 'Bearer management-secret',
        'x-undelared': 'secret'
      }
    })
    expect(result.status).toBe(200)
    const received = JSON.parse(result.body)
    expect(received.headers).toMatchObject({
      host: '127.0.0.1:4173',
      origin: 'http://127.0.0.1:4173'
    })
    expect(received.headers.cookie).toBeUndefined()
    expect(received.headers.authorization).toBeUndefined()
    expect(received.headers['x-undelared']).toBeUndefined()
    const post = await http(`${v.origin}/change`, {
      method: 'POST',
      headers: {
        cookie: v.cookie,
        origin: v.origin,
        'content-type': 'application/json',
        'x-project-csrf': 'project-token'
      },
      body: '{"value":7}'
    })
    expect(post.status).toBe(200)
    expect(JSON.parse(post.body)).toMatchObject({
      body: '{"value":7}',
      headers: { 'x-project-csrf': 'project-token' }
    })
    assertSocketProof(v.f.seen)
  })

  it('streams SSE before the service ends and releases the reservation after client disconnect', async () => {
    const v = await openView({}, { maxConnections: 1 })
    await new Promise<void>((resolve, reject) => {
      const pending = request(
        `${v.origin}/events`,
        { ...loopbackLookup, headers: { cookie: v.cookie } },
        (response) => {
          let text = ''
          response.on('data', (chunk) => {
            text += chunk.toString()
            if (text.includes('second')) {
              pending.destroy()
              resolve()
            }
          })
        }
      )
      pending.on('error', reject)
      pending.end()
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(
      (await http(`${v.origin}/asset`, { ...loopbackLookup, headers: { cookie: v.cookie } })).status
    ).toBe(200)
    assertSocketProof(v.f.seen)
  })

  it('upgrades the proven socket and forwards messages with the upstream-selected declared protocol', async () => {
    const v = await openView({ webSocketProtocols: ['fixture.v1', 'fixture.v2'] })
    const socket = new WebSocket(
      `${v.origin.replace('http:', 'ws:')}/socket`,
      ['fixture.v1', 'fixture.v2'],
      { headers: { cookie: v.cookie }, origin: v.origin }
    )
    await once(socket, 'open')
    expect(socket.protocol).toBe('fixture.v2')
    const received = once(socket, 'message')
    socket.send('hello from browser')
    expect((await received)[0].toString()).toBe('hello from browser')
    v.controller.abort()
    await once(socket, 'close')
    expect(v.owner.list(scope)[0].state).toBe('closed')
    assertSocketProof(v.f.seen)
  })

  it('requires real authority, exact scope and startup proof before exposing a page', async () => {
    const f = await fixture()
    await expect(
      OwnedRuntimeViewService.open({
        scope,
        socketPath: f.socketPath,
        expectedProof: randomBytes(32).toString('hex'),
        proofPath: '/__open_science_proof_0123456789abcdef0123456789abcdef',
        upstreamOrigin: 'http://127.0.0.1:4173',
        signal: new AbortController().signal,
        assertCurrent() {
          return undefined
        }
      })
    ).rejects.toThrow('verified')
    const service = await openService(f)
    const owner = new RuntimeViewOwner({}, desktopObservationFrameRegistry)
    owners.push(owner)
    const args = {
      scope,
      service,
      title: 'Fixture',
      allowedParentOrigins: ['http://127.0.0.1:5000']
    }
    await expect(
      owner.open({ ...args, service: { ...service } as OwnedRuntimeViewService })
    ).rejects.toThrow('authority')
    await expect(
      owner.open({ ...args, scope: { ...scope, generationId: 'other' } })
    ).rejects.toThrow('authority')
    expect(
      f.seen.every(
        (entry) => entry.path === '/__open_science_proof_0123456789abcdef0123456789abcdef'
      )
    ).toBe(true)
  })

  it('refuses a replacement listener even when it knows the old proof', async () => {
    const v = await openView()
    v.f.server.closeAllConnections()
    await new Promise<void>((resolve) => v.f.server.close(() => resolve()))
    const replacement = await fixture({ socketPath: v.f.socketPath, proof: v.f.proof })
    await expect(v.owner.issueAccess(v.access.view.viewId, scope)).rejects.toThrow()
    expect(replacement.seen).toEqual([])
    expect(v.owner.list(scope)[0].state).toBe('closed')
  })

  it('uses single-use scoped grants and rejects foreign origins, proof paths and cross-scope access', async () => {
    const v = await openView()
    expect((await http(v.access.url)).status).toBe(403)
    expect((await http(`${v.origin}/asset`)).status).toBe(403)
    expect(
      (
        await http(`${v.origin}/__open_science_proof_0123456789abcdef0123456789abcdef`, {
          headers: { cookie: v.cookie }
        })
      ).status
    ).toBe(403)
    expect(
      (
        await http(`${v.origin}/%5f_open_science_proof_0123456789abcdef0123456789abcdef`, {
          headers: { cookie: v.cookie }
        })
      ).status
    ).toBe(403)
    expect(
      (
        await http(`${v.origin}/asset`, {
          headers: { cookie: v.cookie, origin: 'https://attacker.invalid' }
        })
      ).status
    ).toBe(403)
    expect(
      (
        await http(`${v.origin}/change`, {
          method: 'POST',
          headers: { cookie: v.cookie },
          body: 'mutation'
        })
      ).status
    ).toBe(403)
    await expect(
      v.owner.issueAccess(v.access.view.viewId, { ...scope, sessionId: 'other' })
    ).rejects.toThrow('scope')
    expect(v.owner.list({ ...scope, sessionId: 'other' })).toEqual([])
  })

  it('preserves all CSP policies by default and only adapts framing with explicit opt-in', async () => {
    const preserved = await openView()
    const original = await http(`${preserved.origin}/page`, {
      headers: { cookie: preserved.cookie }
    })
    expect(original.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(original.headers['x-frame-options']).toBe('DENY')
    expect(original.headers['set-cookie']).toBeUndefined()
    const adapted = await openView({
      adaptFrameAncestors: true,
      allowedParentOrigins: ['http://127.0.0.1:5000', 'http://127.0.0.1:5001']
    })
    const result = await http(`${adapted.origin}/page`, { headers: { cookie: adapted.cookie } })
    expect(result.headers['content-security-policy']).not.toContain("frame-ancestors 'none'")
    expect(result.headers['content-security-policy']).toContain("default-src 'self'")
    expect(result.headers['content-security-policy']).toContain("connect-src 'self'")
    expect(result.headers['content-security-policy']).toContain("form-action 'self'")
    expect(result.headers['content-security-policy']).toContain("worker-src 'none'")
    expect(result.headers['content-security-policy']).toContain(
      'frame-ancestors http://127.0.0.1:5000 http://127.0.0.1:5001'
    )
    expect(result.headers['x-frame-options']).toBeUndefined()
    expect(adapted.access.view.embeddingAdapted).toBe(true)
  })

  it('supports controlled partitioned-cookie syntax without claiming browser-host compatibility', async () => {
    const v = await openView({ cookiePolicy: 'partitioned' })
    expect(v.bootstrap.headers['set-cookie']![0]).toContain(
      'HttpOnly; Secure; SameSite=None; Partitioned;'
    )
    expect(v.access.view).not.toHaveProperty('url')
    expect(JSON.stringify(v.owner.list(scope))).not.toContain(
      new URL(v.access.url).searchParams.get('grant')
    )
  })

  it('allows the trusted desktop ancestor only with explicit adaptation and bounds closed descriptors', async () => {
    const v = await openView(
      { adaptFrameAncestors: true, allowedParentOrigins: ['file:', 'http://127.0.0.1:5000'] },
      { maxViews: 1 }
    )
    const result = await http(`${v.origin}/page`, {
      ...loopbackLookup,
      headers: { cookie: v.cookie }
    })
    expect(result.headers['content-security-policy']).toContain(
      'frame-ancestors file: http://127.0.0.1:5000'
    )
    v.owner.revoke(v.access.view.viewId, scope)
    await expect(
      v.owner.open({ scope, service: v.service, title: 'Fixture', allowedParentOrigins: ['file:'] })
    ).rejects.toThrow('explicit')
    for (const parent of [
      'file:///Applications/Test.app',
      'null',
      'http://*.localhost',
      'http://127.0.0.1:5000/path',
      'https://example.test/'
    ]) {
      await expect(
        v.owner.open({
          scope,
          service: v.service,
          title: 'Fixture',
          allowedParentOrigins: [parent],
          adaptFrameAncestors: true
        })
      ).rejects.toThrow()
    }
    for (let index = 0; index < 20; index++) {
      const access = await v.owner.open({
        scope,
        service: v.service,
        title: 'Fixture',
        allowedParentOrigins: ['http://127.0.0.1:5000']
      })
      v.owner.revoke(access.view.viewId, scope)
    }
    expect(v.owner.list(scope)).toHaveLength(16)
    await expect(v.owner.issueAccess(v.access.view.viewId, scope)).rejects.toThrow('scope')
  })

  it('rewrites local redirects but rejects external redirects and dangerous declarations', async () => {
    const v = await openView()
    const local = await http(`${v.origin}/redirect`, {
      ...loopbackLookup,
      headers: { cookie: v.cookie }
    })
    expect(local.status).toBe(302)
    expect(local.headers.location).toBe('/asset.js?version=1')
    expect(
      (await http(`${v.origin}/external`, { ...loopbackLookup, headers: { cookie: v.cookie } }))
        .status
    ).toBe(502)
    for (const header of [
      'authorization',
      'cookie',
      'host',
      'x-forwarded-host',
      'x-open-science-token'
    ]) {
      await expect(
        v.owner.open({
          scope,
          service: v.service,
          title: 'Unsafe',
          allowedParentOrigins: ['http://127.0.0.1:5000'],
          allowedRequestHeaders: [header]
        })
      ).rejects.toThrow('header declaration')
    }
  })

  it('bounds request bodies, response bytes and cumulative requests', async () => {
    const v = await openView({}, { maxRequestBytes: 128, maxResponseBytes: 1024, maxRequests: 3 })
    expect(
      (
        await http(`${v.origin}/change`, {
          method: 'POST',
          headers: { cookie: v.cookie, origin: v.origin, 'content-length': '256' },
          body: 'x'.repeat(256)
        })
      ).status
    ).toBe(413)
    expect(v.f.seen.some((entry) => entry.path === '/change')).toBe(false)
    await expect(
      http(`${v.origin}/large`, { ...loopbackLookup, headers: { cookie: v.cookie } })
    ).rejects.toThrow()
    expect(
      (await http(`${v.origin}/asset`, { ...loopbackLookup, headers: { cookie: v.cookie } })).status
    ).toBe(200)
    expect(
      (await http(`${v.origin}/asset`, { ...loopbackLookup, headers: { cookie: v.cookie } })).status
    ).toBe(403)
  })

  it('revokes active streams on the owning Run ending and never stops the owned service on view close', async () => {
    const v = await openView()
    const stream = request(`${v.origin}/events`, {
      ...loopbackLookup,
      headers: { cookie: v.cookie }
    })
    stream.end()
    const [response] = await once(stream, 'response')
    response.resume()
    const closed = new Promise<void>((resolve) => response.once('close', resolve))
    response.on('error', () => {})
    v.controller.abort()
    await closed
    expect(v.owner.list(scope)[0]).toMatchObject({ state: 'closed', closedReason: 'run-ended' })
    await expect(v.owner.issueAccess(v.access.view.viewId, scope)).rejects.toThrow()
    const other = await openView()
    other.owner.revoke(other.access.view.viewId, scope)
    expect(other.service.signal.aborted).toBe(false)
    const connection = await other.service.connect()
    connection.close()
  })

  it('fails closed when the owner closes while the loopback listener is starting', async () => {
    const f = await fixture(),
      service = await openService(f),
      owner = new RuntimeViewOwner({}, desktopObservationFrameRegistry)
    owners.push(owner)
    const pending = owner.open({
      scope,
      service,
      title: 'Fixture',
      allowedParentOrigins: ['http://127.0.0.1:5000']
    })
    owner.close()
    await expect(pending).rejects.toThrow('closed')
    await expect(
      owner.open({
        scope,
        service,
        title: 'Fixture',
        allowedParentOrigins: ['http://127.0.0.1:5000']
      })
    ).rejects.toThrow('closed')
  })

  it('refuses concurrent streams above budget and reuses capacity only after the first closes', async () => {
    const v = await openView({}, { maxConnections: 1 })
    const stream = request(`${v.origin}/events`, {
      ...loopbackLookup,
      headers: { cookie: v.cookie }
    })
    stream.end()
    const [response] = await once(stream, 'response')
    response.on('error', () => {})
    response.resume()
    expect(
      (await http(`${v.origin}/asset`, { ...loopbackLookup, headers: { cookie: v.cookie } })).status
    ).toBe(403)
    const closed = new Promise<void>((resolve) => response.once('close', resolve))
    stream.destroy()
    await closed
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(
      (await http(`${v.origin}/asset`, { ...loopbackLookup, headers: { cookie: v.cookie } })).status
    ).toBe(200)
  })

  it('revokes an in-flight proof and never forwards the application request after cancellation', async () => {
    const f = await fixture({ delayProof: 30 })
    const controller = new AbortController(),
      service = await openService(f, controller)
    const owner = new RuntimeViewOwner({}, desktopObservationFrameRegistry)
    owners.push(owner)
    const access = await owner.open({
      scope,
      service,
      title: 'Fixture',
      allowedParentOrigins: ['http://127.0.0.1:5000']
    })
    const bootstrap = await http(access.url)
    const pending = http(`${new URL(access.url).origin}/asset`, {
      headers: { cookie: bootstrap.headers['set-cookie']![0].split(';')[0] }
    })
    const rejected = expect(pending).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()
    await rejected
    expect(f.seen.some((entry) => entry.path === '/asset')).toBe(false)
  })

  it('closes access at its bounded expiry while leaving the Run-owned service alone', async () => {
    const v = await openView({}, { lifetimeMs: 30 })
    const deadline = Date.now() + 1000
    while (v.owner.list(scope)[0].state === 'ready' && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5))
    expect(v.owner.list(scope)[0]).toMatchObject({ state: 'closed', closedReason: 'expired' })
    expect(v.service.signal.aborted).toBe(false)
    await expect(
      http(`${v.origin}/asset`, { ...loopbackLookup, headers: { cookie: v.cookie } })
    ).rejects.toThrow()
  })

  it('rejects undeclared WebSocket protocols before contacting the service', async () => {
    const v = await openView({ webSocketProtocols: ['fixture.v2'] })
    const socket = new WebSocket(`${v.origin.replace('http:', 'ws:')}/socket`, 'foreign.protocol', {
      headers: { cookie: v.cookie },
      origin: v.origin,
      ...loopbackLookup
    })
    await expect(once(socket, 'open')).rejects.toThrow()
    expect(v.f.seen.some((entry) => entry.path === '/socket')).toBe(false)
  })

  it.each(['HTTP', 'WebSocket'] as const)(
    'rechecks the viewer lease before forwarding %s',
    async (transport) => {
      let authorized = true
      const v = await openView({
        assertAuthorized: () => {
          if (!authorized) throw new Error('Original viewer lease was revoked')
        }
      })
      authorized = false
      if (transport === 'HTTP') {
        await expect(
          http(`${v.origin}/asset`, {
            ...loopbackLookup,
            headers: { cookie: v.cookie, origin: v.origin },
            method: 'POST'
          })
        ).rejects.toThrow()
      } else {
        const socket = new WebSocket(`${v.origin.replace('http:', 'ws:')}/socket`, {
          ...loopbackLookup,
          headers: { cookie: v.cookie },
          origin: v.origin
        })
        await expect(once(socket, 'open')).rejects.toThrow()
      }
      expect(v.f.seen.some((entry) => ['/asset', '/socket'].includes(entry.path))).toBe(false)
      expect(v.owner.list(scope)[0]).toMatchObject({
        state: 'closed',
        closedReason: 'authorization-revoked'
      })
      expect(v.service.signal.aborted).toBe(false)
      expect(v.f.server.listening).toBe(true)
    }
  )

  it('binds a published page to current owner authority even when the socket is still alive', async () => {
    const f = await fixture()
    let current = true
    const service = await openService(f, new AbortController(), () => {
      if (!current) throw new Error('Run no longer current')
    })
    const owner = new RuntimeViewOwner({}, desktopObservationFrameRegistry)
    owners.push(owner)
    const access = await owner.open({
      scope,
      service,
      title: 'Fixture',
      allowedParentOrigins: ['http://127.0.0.1:5000']
    })
    current = false
    await expect(owner.issueAccess(access.view.viewId, scope)).rejects.toThrow('no longer current')
    expect(owner.list(scope)[0].state).toBe('closed')
    expect(f.server.listening).toBe(true)
  })
})
