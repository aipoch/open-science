import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { net } from 'electron'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  net: { fetch: vi.fn() }
}))

import { WEB_RPC_PROTOCOL_VERSION } from '../../shared/web-rpc-contract'
import { broadcastToRenderers } from '../renderer-broadcast'
import {
  REMOTE_LOCAL_ONLY_RPC_CHANNELS,
  startWebHttpServer,
  type ExternalWebAccessAuthorization,
  type RunningWebServer
} from './http-server'
import { TaskApiError } from './task-api'

const roots: string[] = []
const servers: RunningWebServer[] = []
const authorizedExternalAccess = (): ExternalWebAccessAuthorization => ({
  kind: 'authorized-pairing-manager' as const,
  isCurrent: () => true
})
const accessOnlyExternalAccess = (): ExternalWebAccessAuthorization => ({
  kind: 'authorized' as const,
  isCurrent: () => true
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('startWebHttpServer', () => {
  it('authenticates, serves the UI, invokes RPC, and mirrors events over WebSocket', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>Web test</title>')
    const largeScript = `window.__compressed = "${'a'.repeat(5_000)}"`
    await writeFile(join(staticRoot, 'app.js'), largeScript)
    const rpc = {
      channels: () => [
        'projects:list',
        'sessions:export-conversation',
        'file:save-session-artifacts',
        'uploads:stage-local-file',
        'settings:list-agent-home-skills',
        'settings:import-agent-home-skills'
      ],
      invoke: vi.fn(async (_channel: string, _client: string, args: unknown[]) => args[0]),
      releaseClient: vi.fn(),
      dispose: vi.fn()
    }
    const server = await startWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot,
      rpc,
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        configRoot: '/fake/root',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)
    const base = `http://127.0.0.1:${server.port}`

    expect((await fetch(base, { redirect: 'manual' })).status).toBe(401)
    const login = await fetch(`${base}/?token=test-token&project=project-1&session=session-1`, {
      redirect: 'manual'
    })
    expect(login.status).toBe(302)
    expect(login.headers.get('location')).toBe('/?project=project-1&session=session-1')
    const cookie = login.headers.get('set-cookie')!.split(';', 1)[0]

    const bootstrap = await fetch(`${base}/api/bootstrap`, { headers: { cookie } })
    expect(Number(bootstrap.headers.get('content-length'))).toBeGreaterThan(0)
    expect(await bootstrap.json()).toMatchObject({
      appName: 'Open Science',
      configRoot: '/fake/root',
      rpcProtocolVersion: WEB_RPC_PROTOCOL_VERSION,
      rpcChannels: ['projects:list']
    })

    const compressedStatic = await fetch(`${base}/app.js`, {
      headers: { cookie, 'accept-encoding': 'gzip' }
    })
    expect(compressedStatic.headers.get('content-encoding')).toBe('gzip')
    expect(compressedStatic.headers.get('vary')).toBe('Accept-Encoding')
    expect(Number(compressedStatic.headers.get('content-length'))).toBeLessThan(largeScript.length)
    expect(await compressedStatic.text()).toBe(largeScript)

    const rpcResponse = await fetch(`${base}/rpc/projects%3Alist`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-open-science-client': 'test-client'
      },
      body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [{ value: 1 }] })
    })
    expect(await rpcResponse.json()).toEqual({
      protocolVersion: WEB_RPC_PROTOCOL_VERSION,
      ok: true,
      result: { value: 1 }
    })
    expect(rpc.invoke).toHaveBeenCalledWith('projects:list', 'test-client', [{ value: 1 }], {
      canManageRemotePairing: false
    })

    const binary = Uint8Array.from([0, 1, 127, 128, 255])
    const encodedBinary = Buffer.from(binary).toString('base64')
    const binaryRpcResponse = await fetch(`${base}/rpc/projects%3Alist`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-open-science-client': 'test-client'
      },
      body: JSON.stringify({
        protocolVersion: WEB_RPC_PROTOCOL_VERSION,
        args: [{ $binary: encodedBinary }]
      })
    })
    expect(await binaryRpcResponse.json()).toEqual({
      protocolVersion: WEB_RPC_PROTOCOL_VERSION,
      ok: true,
      result: { $binary: encodedBinary }
    })
    const binaryRpcArgs = vi.mocked(rpc.invoke).mock.calls[1]?.[2]
    expect(binaryRpcArgs?.[0]).toBeInstanceOf(Uint8Array)
    expect(Array.from(binaryRpcArgs?.[0] as Uint8Array)).toEqual(Array.from(binary))

    // Channels unavailable to web clients are rejected over /rpc without reaching the handler.
    for (const channel of [
      'file:save-session-artifacts',
      'window:close',
      'sessions:export-conversation',
      'uploads:stage-local-file',
      'settings:list-agent-home-skills',
      'settings:import-agent-home-skills'
    ]) {
      const blockedResponse = await fetch(`${base}/rpc/${encodeURIComponent(channel)}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
      })
      expect(blockedResponse.status).toBe(404)
      expect(await blockedResponse.json()).toMatchObject({ ok: false })
    }
    expect(rpc.invoke).toHaveBeenCalledTimes(2)

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/events?client=test-client`, {
      headers: { cookie, origin: base }
    })
    await new Promise<void>((resolve) => socket.once('open', resolve))
    const message = new Promise<string>((resolve) =>
      socket.once('message', (data) => resolve(data.toString()))
    )
    broadcastToRenderers('project:created', { ready: true })
    expect(JSON.parse(await message)).toEqual({
      protocolVersion: WEB_RPC_PROTOCOL_VERSION,
      channel: 'project:created',
      payload: { ready: true }
    })
    socket.close()

    const publicSocket = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/v1/events?token=test-token`
    )
    await new Promise<void>((resolve) => publicSocket.once('open', resolve))
    const publicMessage = new Promise<string>((resolve) =>
      publicSocket.once('message', (data) => resolve(data.toString()))
    )
    broadcastToRenderers('acp:event', { sessionId: 'session-1', kind: 'message', text: 'Hi' })
    expect(JSON.parse(await publicMessage)).toEqual({
      type: 'run.event',
      data: { sessionId: 'session-1', kind: 'message', text: 'Hi' }
    })
    publicSocket.close()
  })

  it('exposes only versioned, schema-valid RPC contract channels', async () => {
    const rpc = {
      channels: () => ['projects:list', 'test:unsafe'],
      invoke: vi.fn(async () => ({ ok: true })),
      releaseClient: vi.fn(),
      dispose: vi.fn()
    }
    const server = await startWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      rpc,
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        configRoot: '/fake/root',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)
    const base = `http://127.0.0.1:${server.port}`
    const headers = {
      authorization: 'Bearer test-token',
      'content-type': 'application/json'
    }

    const bootstrap = await fetch(`${base}/api/bootstrap`, { headers })
    expect(await bootstrap.json()).toMatchObject({
      rpcProtocolVersion: WEB_RPC_PROTOCOL_VERSION,
      rpcChannels: ['projects:list']
    })

    const unsafe = await fetch(`${base}/rpc/test%3Aunsafe`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
    })
    expect(unsafe.status).toBe(404)

    const malformed = await fetch(`${base}/rpc/projects%3Alist`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: 'not-an-array' })
    })
    expect(malformed.status).toBe(400)

    const incompatible = await fetch(`${base}/rpc/projects%3Alist`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION + 1, args: [] })
    })
    expect(incompatible.status).toBe(426)
    expect(rpc.invoke).not.toHaveBeenCalled()
  })

  it('passes pairing authority only for trusted-browser Web RPC calls', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    const rpc = {
      channels: () => ['remote-access:get-snapshot'],
      invoke: vi.fn(async () => ({ canManagePairing: true })),
      releaseClient: vi.fn(),
      dispose: vi.fn()
    }
    const authorizeHttp = vi.fn().mockResolvedValue(authorizedExternalAccess())
    const server = await startWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'local-token',
      staticRoot,
      rpc,
      externalAccess: {
        authorizeHttp,
        authorizeWebSocket: vi.fn().mockResolvedValue({})
      },
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        configRoot: '/fake/root',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)

    const response = await fetch(
      `http://127.0.0.1:${server.port}/rpc/remote-access%3Aget-snapshot`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-open-science-client': 'trusted-phone'
        },
        body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
      }
    )

    expect(response.status).toBe(200)
    expect(rpc.invoke).toHaveBeenCalledWith('remote-access:get-snapshot', 'trusted-phone', [], {
      canManageRemotePairing: true
    })

    authorizeHttp.mockResolvedValueOnce(accessOnlyExternalAccess())
    const oneTimeResponse = await fetch(
      `http://127.0.0.1:${server.port}/rpc/remote-access%3Aget-snapshot`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-open-science-client': 'one-time-phone'
        },
        body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
      }
    )

    expect(oneTimeResponse.status).toBe(200)
    expect(rpc.invoke).toHaveBeenLastCalledWith(
      'remote-access:get-snapshot',
      'one-time-phone',
      [],
      { canManageRemotePairing: false }
    )
  })

  it('does not execute remote RPC or Task API requests after their authorization expires', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    let authorizationGeneration = 0
    const authorizeHttp = vi.fn(async () => {
      const authorizedGeneration = authorizationGeneration
      return {
        kind: 'authorized-pairing-manager' as const,
        isCurrent: () => authorizedGeneration === authorizationGeneration
      }
    })
    const rpc = {
      channels: () => ['projects:list'],
      invoke: vi.fn(async () => ({ ok: true })),
      releaseClient: vi.fn(),
      dispose: vi.fn()
    }
    const tasks = {
      listProjects: vi.fn(),
      createProject: vi.fn(),
      listSessions: vi.fn(),
      getSession: vi.fn(),
      startRun: vi.fn(async () => ({
        id: 'run-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        status: 'running' as const,
        startedAt: 1,
        artifacts: []
      })),
      getRun: vi.fn(),
      listArtifacts: vi.fn(),
      acquireArtifact: vi.fn(),
      releaseArtifact: vi.fn()
    }
    const server = await startWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'local-token',
      staticRoot,
      rpc,
      tasks,
      externalAccess: {
        authorizeHttp,
        authorizeWebSocket: vi.fn().mockResolvedValue({})
      },
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        configRoot: '/fake/root',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)

    const postAfterExpiringAuthorization = async (
      pathname: string,
      body: unknown,
      expectedAuthorizationCalls: number
    ): Promise<number> => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: server.port,
        path: pathname,
        method: 'POST',
        headers: {
          host: 'remote.example.test',
          origin: 'https://remote.example.test',
          'content-type': 'application/json'
        }
      })
      const response = new Promise<number>((resolve, reject) => {
        request.once('response', (incoming) => {
          incoming.resume()
          incoming.once('end', () => resolve(incoming.statusCode ?? 0))
        })
        request.once('error', reject)
      })
      request.flushHeaders()
      await vi.waitFor(() =>
        expect(authorizeHttp).toHaveBeenCalledTimes(expectedAuthorizationCalls)
      )
      authorizationGeneration += 1
      request.end(JSON.stringify(body))
      return response
    }

    expect(
      await postAfterExpiringAuthorization(
        '/rpc/projects%3Alist',
        { protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] },
        1
      )
    ).toBe(401)
    expect(rpc.invoke).not.toHaveBeenCalled()

    expect(
      await postAfterExpiringAuthorization(
        '/api/v1/runs',
        { project: 'project-1', prompt: 'Research this.' },
        2
      )
    ).toBe(401)
    expect(tasks.startRun).not.toHaveBeenCalled()
  })

  it('keeps host-management RPC local while preserving the local Web client', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    const localOnlyChannels = [...REMOTE_LOCAL_ONLY_RPC_CHANNELS]
    const remotelyAvailableChannel = 'projects:list'
    const rpcChannels = [...localOnlyChannels, remotelyAvailableChannel]
    const rpc = {
      channels: () => rpcChannels,
      invoke: vi.fn(async () => ({ installed: true })),
      releaseClient: vi.fn(),
      dispose: vi.fn()
    }
    const server = await startWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'local-token',
      staticRoot,
      rpc,
      externalAccess: {
        authorizeHttp: vi.fn().mockResolvedValue(authorizedExternalAccess()),
        authorizeWebSocket: vi.fn().mockResolvedValue({})
      },
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        configRoot: '/fake/root',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)
    const rpcUrl = (channel: string): string =>
      `http://127.0.0.1:${server.port}/rpc/${encodeURIComponent(channel)}`
    const bootstrapUrl = `http://127.0.0.1:${server.port}/api/bootstrap`

    expect(REMOTE_LOCAL_ONLY_RPC_CHANNELS).toContain('runtime:set-selection')
    for (const channel of [
      'settings:login-isolated-claude',
      'settings:login-isolated-claude-browser',
      'settings:logout-isolated-claude',
      'settings:login-isolated-codex',
      'settings:logout-isolated-codex',
      'settings:login-shared-claude',
      'settings:logout-shared-claude',
      'storage:inspect-data-root',
      'storage:validate-data-root'
    ]) {
      expect(REMOTE_LOCAL_ONLY_RPC_CHANNELS, channel).toContain(channel)
    }
    const remoteBootstrap = await fetch(bootstrapUrl)
    expect(remoteBootstrap.status).toBe(200)
    expect(await remoteBootstrap.json()).toMatchObject({
      rpcChannels: [remotelyAvailableChannel],
      restrictedRpcChannels: localOnlyChannels
    })

    const localBootstrap = await fetch(bootstrapUrl, {
      headers: { authorization: 'Bearer local-token' }
    })
    expect(localBootstrap.status).toBe(200)
    expect(await localBootstrap.json()).toMatchObject({ rpcChannels, restrictedRpcChannels: [] })

    for (const channel of localOnlyChannels) {
      const remoteResponse = await fetch(rpcUrl(channel), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
      })
      expect(remoteResponse.status, channel).toBe(403)
    }
    expect(rpc.invoke).not.toHaveBeenCalled()

    const localResponse = await fetch(rpcUrl('cli:install'), {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
    })
    expect(localResponse.status).toBe(200)
    expect(rpc.invoke).toHaveBeenCalledOnce()
  })

  it('closes targeted or all external WebSockets without disturbing local clients', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    const server = await startWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'local-token',
      staticRoot,
      rpc: {
        channels: () => [],
        invoke: vi.fn(),
        releaseClient: vi.fn(),
        dispose: vi.fn()
      },
      externalAccess: {
        authorizeHttp: vi.fn().mockResolvedValue(authorizedExternalAccess()),
        authorizeWebSocket: vi.fn().mockResolvedValue({ sessionId: 'trusted-browser' })
      },
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        configRoot: '/fake/root',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/events`, {
      headers: { origin: `http://127.0.0.1:${server.port}` }
    })
    const localSocket = new WebSocket(`ws://127.0.0.1:${server.port}/events?token=local-token`)
    await Promise.all([
      new Promise<void>((resolve) => socket.once('open', resolve)),
      new Promise<void>((resolve) => localSocket.once('open', resolve))
    ])
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))

    server.closeExternalConnections('trusted-browser')

    await closed
    expect(socket.readyState).toBe(WebSocket.CLOSED)
    expect(localSocket.readyState).toBe(WebSocket.OPEN)

    const nextRemoteSocket = new WebSocket(`ws://127.0.0.1:${server.port}/events`, {
      headers: { origin: `http://127.0.0.1:${server.port}` }
    })
    await new Promise<void>((resolve) => nextRemoteSocket.once('open', resolve))
    const nextRemoteClosed = new Promise<void>((resolve) =>
      nextRemoteSocket.once('close', () => resolve())
    )

    server.closeExternalConnections()

    await nextRemoteClosed
    expect(localSocket.readyState).toBe(WebSocket.OPEN)
    localSocket.close()
  })

  it('authenticates shutdown requests before invoking the callback', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    const onShutdownRequest = vi.fn()
    const server = await startWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot,
      rpc: {
        channels: () => [],
        invoke: vi.fn(),
        releaseClient: vi.fn(),
        dispose: vi.fn()
      },
      onShutdownRequest,
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        configRoot: '/fake/root',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)
    const endpoint = `http://127.0.0.1:${server.port}/api/shutdown`

    expect((await fetch(endpoint, { method: 'POST' })).status).toBe(401)
    expect(onShutdownRequest).not.toHaveBeenCalled()

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' }
    })
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ ok: true })
    await vi.waitFor(() => expect(onShutdownRequest).toHaveBeenCalledOnce())
  })

  it('keeps shutdown local even when remote Browser access is authorized', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    const onShutdownRequest = vi.fn()
    const server = await startWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'local-token',
      staticRoot,
      rpc: {
        channels: () => [],
        invoke: vi.fn(),
        releaseClient: vi.fn(),
        dispose: vi.fn()
      },
      externalAccess: {
        authorizeHttp: vi.fn().mockResolvedValue(authorizedExternalAccess()),
        authorizeWebSocket: vi.fn().mockResolvedValue({})
      },
      onShutdownRequest,
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        configRoot: '/fake/root',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)

    const response = await fetch(`http://127.0.0.1:${server.port}/api/shutdown`, {
      method: 'POST'
    })

    expect(response.status).toBe(403)
    expect(onShutdownRequest).not.toHaveBeenCalled()
  })

  it('serves the versioned task API without exposing internal RPC channels', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    const tasks = {
      listProjects: vi.fn().mockResolvedValue([{ id: 'project-1', name: 'Research' }]),
      createProject: vi.fn(),
      listSessions: vi.fn(),
      getSession: vi.fn(),
      startRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        status: 'running',
        startedAt: 1,
        artifacts: []
      }),
      getRun: vi.fn().mockReturnValue({
        id: 'run-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        status: 'completed',
        startedAt: 1,
        completedAt: 2,
        output: 'Done',
        artifacts: []
      }),
      listArtifacts: vi.fn(),
      acquireArtifact: vi.fn(),
      releaseArtifact: vi.fn(),
      dispose: vi.fn()
    }
    const server = await startWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot,
      rpc: {
        channels: () => ['projects:list'],
        invoke: vi.fn(),
        releaseClient: vi.fn(),
        dispose: vi.fn()
      },
      tasks,
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        configRoot: '/fake/root',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)
    const base = `http://127.0.0.1:${server.port}`
    const headers = { authorization: 'Bearer test-token' }

    const projects = await fetch(`${base}/api/v1/projects`, { headers })
    expect(projects.status).toBe(200)
    expect(await projects.json()).toEqual({ data: [{ id: 'project-1', name: 'Research' }] })

    const started = await fetch(`${base}/api/v1/runs`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1', prompt: 'Research this.' })
    })
    expect(started.status).toBe(202)
    expect(await started.json()).toMatchObject({ data: { id: 'run-1', status: 'running' } })
    expect(tasks.startRun).toHaveBeenCalledWith({
      project: 'project-1',
      prompt: 'Research this.'
    })

    const status = await fetch(`${base}/api/v1/runs/run-1`, { headers })
    expect(await status.json()).toMatchObject({ data: { status: 'completed', output: 'Done' } })

    tasks.startRun.mockRejectedValueOnce(
      new TaskApiError('session_busy', 'Session already has an active run: session-1')
    )
    const conflict = await fetch(`${base}/api/v1/runs`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1', sessionId: 'session-1', prompt: 'Again' })
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({
      error: {
        code: 'session_busy',
        message: 'Session already has an active run: session-1'
      }
    })
  })

  it('streams an acquired artifact and always releases its capability', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    vi.mocked(net.fetch).mockResolvedValueOnce(
      new Response('artifact bytes', {
        headers: { 'content-type': 'text/plain', 'content-length': '14' }
      })
    )
    const tasks = {
      listProjects: vi.fn(),
      createProject: vi.fn(),
      listSessions: vi.fn(),
      getSession: vi.fn(),
      startRun: vi.fn(),
      getRun: vi.fn(),
      listArtifacts: vi.fn(),
      acquireArtifact: vi.fn().mockResolvedValue({
        resourceId: 'resource-1',
        url: 'open-science-preview://resource-1/report.txt',
        name: 'report.txt',
        mimeType: 'text/plain',
        size: 14
      }),
      releaseArtifact: vi.fn().mockResolvedValue(undefined)
    }
    const server = await startWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot,
      rpc: {
        channels: () => [],
        invoke: vi.fn(),
        releaseClient: vi.fn(),
        dispose: vi.fn()
      },
      tasks,
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        configRoot: '/fake/root',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)

    const download = await fetch(
      `http://127.0.0.1:${server.port}/api/v1/artifacts/artifact-1/content`,
      { headers: { authorization: 'Bearer test-token' } }
    )
    expect(await download.text()).toBe('artifact bytes')
    expect(download.headers.get('content-disposition')).toContain('report.txt')
    expect(tasks.acquireArtifact).toHaveBeenCalledWith('artifact-1')
    expect(tasks.releaseArtifact).toHaveBeenCalledWith('resource-1')
  })

  it('cancels the artifact stream and releases its capability when the client disconnects', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    const cancelStream = vi.fn()
    vi.mocked(net.fetch).mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024))
          },
          cancel: cancelStream
        }),
        { headers: { 'content-type': 'application/octet-stream' } }
      )
    )
    const tasks = {
      listProjects: vi.fn(),
      createProject: vi.fn(),
      listSessions: vi.fn(),
      getSession: vi.fn(),
      startRun: vi.fn(),
      getRun: vi.fn(),
      listArtifacts: vi.fn(),
      acquireArtifact: vi.fn().mockResolvedValue({
        resourceId: 'resource-disconnect',
        url: 'open-science-preview://resource-disconnect/report.bin',
        name: 'report.bin',
        mimeType: 'application/octet-stream',
        size: 2 * 1024 * 1024
      }),
      releaseArtifact: vi.fn().mockResolvedValue(undefined)
    }
    const server = await startWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot,
      rpc: {
        channels: () => [],
        invoke: vi.fn(),
        releaseClient: vi.fn(),
        dispose: vi.fn()
      },
      tasks,
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        configRoot: '/fake/root',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)

    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        `http://127.0.0.1:${server.port}/api/v1/artifacts/artifact-disconnect/content`,
        { headers: { authorization: 'Bearer test-token' } },
        (response) => {
          response.once('data', () => {
            response.destroy()
            resolve()
          })
        }
      )
      request.once('error', reject)
      request.end()
    })

    await vi.waitFor(() => {
      expect(cancelStream).toHaveBeenCalledOnce()
      expect(tasks.releaseArtifact).toHaveBeenCalledWith('resource-disconnect')
    })
  })
})
