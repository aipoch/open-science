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

import { WEB_INVOKE_CHANNELS } from '../../shared/web-api-map.generated'
import { isWebRpcChannel, WEB_RPC_PROTOCOL_VERSION } from '../../shared/web-rpc-contract'
import { ApplicationEventHub } from '../application-events'
import type { CallerContext } from '../caller-context'
import {
  REMOTE_LOCAL_ONLY_RPC_CHANNELS,
  startWebHttpServer,
  type ExternalWebAccessAuthorization,
  type RunningWebServer
} from './http-server'
import { TaskApiError } from './task-api'

const roots: string[] = []
const servers: RunningWebServer[] = []
const applicationEvents = new ApplicationEventHub()
type TestWebServerOptions = Omit<
  Parameters<typeof startWebHttpServer>[0],
  'applicationCommands' | 'applicationEvents'
> &
  Partial<Pick<Parameters<typeof startWebHttpServer>[0], 'applicationCommands'>> & {
    rpc: {
      channels: () => string[]
      invoke: (channel: string, callerContext: CallerContext, args: unknown[]) => Promise<unknown>
      releaseClient?: (clientId: string) => void
      dispose?: () => void
    }
  }
const startTestWebHttpServer = (
  options: TestWebServerOptions
): ReturnType<typeof startWebHttpServer> => {
  const { rpc, ...serverOptions } = options
  const localNames = rpc.channels().filter(isWebRpcChannel)
  const remoteRejectedNames = localNames.filter((channel) =>
    REMOTE_LOCAL_ONLY_RPC_CHANNELS.has(channel)
  )
  const invokeDirect = (
    channel: string,
    invocation: { callerContext: CallerContext; args: readonly unknown[] }
  ): Promise<unknown> => rpc.invoke(channel, invocation.callerContext, [...invocation.args])

  return startWebHttpServer({
    ...serverOptions,
    applicationCommands: options.applicationCommands ?? {
      localWeb: { commandNames: () => localNames, invoke: invokeDirect },
      remoteWeb: {
        commandNames: () =>
          localNames.filter((channel) => !REMOTE_LOCAL_ONLY_RPC_CHANNELS.has(channel)),
        rejectedCommandNames: () => remoteRejectedNames,
        invoke: invokeDirect
      }
    },
    applicationEvents
  })
}
const authorizedExternalAccess = (): ExternalWebAccessAuthorization => ({
  kind: 'authorized-pairing-manager' as const,
  isCurrent: () => true
})
const accessOnlyExternalAccess = (): ExternalWebAccessAuthorization => ({
  kind: 'authorized' as const,
  isCurrent: () => true
})
const runWithCallerContext = <Result>(_context: CallerContext, operation: () => Result): Result =>
  operation()

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('startWebHttpServer', () => {
  it('dispatches local Web RPC through the narrow application command view', async () => {
    const unusedFallbackInvoke = vi.fn()
    const directInvoke = vi.fn(
      async (
        _channel: string,
        invocation: { args: readonly unknown[]; callerLease: { signal: AbortSignal } }
      ) => Promise.resolve(invocation.args[0])
    )
    const rpc = {
      channels: () => ['projects:list'],
      invoke: unusedFallbackInvoke,
      releaseClient: vi.fn(),
      dispose: vi.fn()
    }
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      rpc,
      applicationCommands: {
        localWeb: { commandNames: rpc.channels, invoke: directInvoke },
        remoteWeb: {
          commandNames: () => [],
          rejectedCommandNames: () => ['projects:list'],
          invoke: vi.fn()
        }
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

    const firstSocket = new WebSocket(
      `ws://127.0.0.1:${server.port}/events?token=test-token&client=direct-client`
    )
    const secondSocket = new WebSocket(
      `ws://127.0.0.1:${server.port}/events?token=test-token&client=direct-client`
    )
    await Promise.all([
      new Promise<void>((resolve) => firstSocket.once('open', resolve)),
      new Promise<void>((resolve) => secondSocket.once('open', resolve))
    ])

    const response = await fetch(`http://127.0.0.1:${server.port}/rpc/projects%3Alist`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        'x-open-science-client': 'direct-client'
      },
      body: JSON.stringify({
        protocolVersion: WEB_RPC_PROTOCOL_VERSION,
        args: [{ source: 'direct' }]
      })
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, result: { source: 'direct' } })
    expect(directInvoke).toHaveBeenCalledWith(
      'projects:list',
      expect.objectContaining({
        callerContext: expect.objectContaining({
          clientId: 'direct-client',
          surface: 'web',
          location: 'local'
        }),
        callerLease: expect.objectContaining({ leaseId: 'direct-client' }),
        args: [{ source: 'direct' }]
      })
    )
    expect(unusedFallbackInvoke).not.toHaveBeenCalled()

    const directSignal = directInvoke.mock.calls[0]?.[1].callerLease.signal
    firstSocket.close()
    await new Promise<void>((resolve) => firstSocket.once('close', () => resolve()))
    expect(directSignal.aborted).toBe(false)
    secondSocket.close()
    await new Promise<void>((resolve) => secondSocket.once('close', () => resolve()))
    await vi.waitFor(() => expect(directSignal.aborted).toBe(true))
  })

  it('releases its application-event subscription when listening fails', async () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(() => unsubscribe)
    const options = {
      host: '127.0.0.1',
      token: 'test-token',
      staticRoot: '/unused',
      applicationEvents: { subscribe },
      rpc: {
        channels: () => [],
        invoke: vi.fn(async () => undefined),
        releaseClient: vi.fn(),
        dispose: vi.fn()
      },
      applicationCommands: {
        localWeb: { commandNames: () => [], invoke: vi.fn() },
        remoteWeb: { commandNames: () => [], rejectedCommandNames: () => [], invoke: vi.fn() }
      },
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        configRoot: '/fake/root',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    }

    await expect(startWebHttpServer({ ...options, port: -1 })).rejects.toThrow()

    expect(subscribe).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()

    const retry = await startWebHttpServer({ ...options, port: 0 })
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(unsubscribe).toHaveBeenCalledOnce()
    await retry.close()
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  })

  it('authenticates, invokes direct commands, and delivers projected events once in order', async () => {
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
      invoke: vi.fn(
        async (_channel: string, _callerContext: CallerContext, args: unknown[]) => args[0]
      ),
      releaseClient: vi.fn(),
      dispose: vi.fn()
    }
    const server = await startTestWebHttpServer({
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
    expect(rpc.invoke).toHaveBeenCalledWith(
      'projects:list',
      expect.objectContaining({
        clientId: 'test-client',
        lifecycleClientId: 'web:test-client',
        location: 'local',
        actionOrigin: 'human',
        authorities: []
      }),
      [{ value: 1 }]
    )

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
    const secondSocket = new WebSocket(`ws://127.0.0.1:${server.port}/events?client=test-client`, {
      headers: { cookie, origin: base }
    })
    await new Promise<void>((resolve) => socket.once('open', resolve))
    await new Promise<void>((resolve) => secondSocket.once('open', resolve))
    const message = new Promise<string>((resolve) =>
      socket.once('message', (data) => resolve(data.toString()))
    )
    const project = {
      id: 'project-1',
      name: 'Test project',
      description: '',
      isExample: false,
      createdAt: 1,
      updatedAt: 1
    }
    applicationEvents.publish('project:created', project)
    expect(JSON.parse(await message)).toEqual({
      protocolVersion: WEB_RPC_PROTOCOL_VERSION,
      channel: 'project:created',
      payload: project
    })
    const socketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    socket.close()
    await socketClosed
    const secondSocketClosed = new Promise<void>((resolve) =>
      secondSocket.once('close', () => resolve())
    )
    secondSocket.close()
    await secondSocketClosed

    await new Promise<void>((resolve, reject) => {
      const unauthenticatedSocket = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/events`)
      unauthenticatedSocket.once('open', () => reject(new Error('Unauthenticated socket opened.')))
      unauthenticatedSocket.once('error', () => undefined)
      unauthenticatedSocket.once('unexpected-response', (_request, response) => {
        expect(response.statusCode).toBe(401)
        response.resume()
        resolve()
      })
    })

    const publicSocket = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/v1/events?token=test-token`
    )
    await new Promise<void>((resolve) => publicSocket.once('open', resolve))
    const publicMessages: unknown[] = []
    publicSocket.on('message', (data) => publicMessages.push(JSON.parse(data.toString())))
    applicationEvents.publish('acp:event', {
      id: 'event-1',
      timestamp: 1,
      level: 'info',
      sessionId: 'session-1',
      kind: 'message',
      text: 'Hi'
    })
    applicationEvents.publish('acp:permission-request', {
      sessionId: 'session-1',
      requestId: 'permission-1',
      toolCallId: 'tool-1',
      title: 'Run command',
      options: []
    })
    await vi.waitFor(() => {
      expect(publicMessages).toEqual([
        {
          type: 'run.event',
          data: {
            id: 'event-1',
            timestamp: 1,
            level: 'info',
            sessionId: 'session-1',
            kind: 'message',
            text: 'Hi'
          }
        },
        {
          type: 'permission.requested',
          data: {
            sessionId: 'session-1',
            requestId: 'permission-1',
            toolCallId: 'tool-1',
            title: 'Run command',
            options: []
          }
        }
      ])
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
    const server = await startTestWebHttpServer({
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

  it('releases each active client once when the server closes', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    const directSignals: AbortSignal[] = []
    const directInvoke = vi.fn(async (_channel, invocation) => {
      directSignals.push(invocation.callerLease.signal)
      return []
    })
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot,
      rpc: {
        channels: () => ['projects:list'],
        invoke: vi.fn(),
        dispose: vi.fn()
      },
      applicationCommands: {
        localWeb: { commandNames: () => ['projects:list'], invoke: directInvoke },
        remoteWeb: { commandNames: () => [], rejectedCommandNames: () => [], invoke: vi.fn() }
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
    const firstSocket = new WebSocket(
      `ws://127.0.0.1:${server.port}/events?token=test-token&client=test-client`
    )
    const secondSocket = new WebSocket(
      `ws://127.0.0.1:${server.port}/events?token=test-token&client=test-client`
    )
    await Promise.all([
      new Promise<void>((resolve) => firstSocket.once('open', resolve)),
      new Promise<void>((resolve) => secondSocket.once('open', resolve))
    ])
    await fetch(`http://127.0.0.1:${server.port}/rpc/projects%3Alist`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        'x-open-science-client': 'test-client'
      },
      body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
    })
    expect(directSignals[0]?.aborted).toBe(false)

    await server.close()
    servers.splice(servers.indexOf(server), 1)

    expect(directSignals[0]?.aborted).toBe(true)
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
    const server = await startTestWebHttpServer({
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
    expect(rpc.invoke).toHaveBeenCalledWith(
      'remote-access:get-snapshot',
      expect.objectContaining({
        clientId: 'trusted-phone',
        location: 'remote',
        authorities: ['manage-remote-pairing']
      }),
      []
    )

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
      expect.objectContaining({
        clientId: 'one-time-phone',
        location: 'remote',
        authorities: []
      }),
      []
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
      channels: () => ['acp:get-state'],
      invoke: vi.fn(async () => ({ ok: true })),
      releaseClient: vi.fn(),
      dispose: vi.fn()
    }
    const taskContexts: CallerContext[] = []
    const runWithCapturedCallerContext = <Result>(
      context: CallerContext,
      operation: () => Result
    ): Result => {
      taskContexts.push(context)
      return operation()
    }
    const tasks = {
      runWithCallerContext: runWithCapturedCallerContext,
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
    const server = await startTestWebHttpServer({
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
        '/rpc/acp%3Aget-state',
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
    const taskContext = taskContexts[0]
    expect(taskContext).toMatchObject({
      surface: 'task',
      location: 'remote',
      principalKind: 'automation',
      actionOrigin: 'automation'
    })
    expect(taskContext?.isAuthorizationCurrent()).toBe(false)
  })

  it('keeps host-management RPC local while preserving the local Web client', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    const localOnlyChannels = [...REMOTE_LOCAL_ONLY_RPC_CHANNELS]
    const remotelyAvailableChannel = 'projects:list'
    const rpcChannels = [...localOnlyChannels, remotelyAvailableChannel]
    const localInvoke = vi.fn(async () => ({ installed: true }))
    const remoteInvoke = vi.fn(async () => ({ projects: [] }))
    const rpc = {
      channels: () => rpcChannels,
      invoke: vi.fn(),
      releaseClient: vi.fn(),
      dispose: vi.fn()
    }
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'local-token',
      staticRoot,
      rpc,
      applicationCommands: {
        localWeb: { commandNames: () => rpcChannels, invoke: localInvoke },
        remoteWeb: {
          commandNames: () => [remotelyAvailableChannel],
          rejectedCommandNames: () => localOnlyChannels,
          invoke: remoteInvoke
        }
      },
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
      'storage:validate-data-root',
      'local-fs:get-roots',
      'local-fs:list-dir',
      'local-fs:open-path',
      'local-fs:read-preview',
      'local-fs:reveal',
      'uploads:stage-local-path'
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
      expect(await remoteResponse.json(), channel).toEqual({
        protocolVersion: WEB_RPC_PROTOCOL_VERSION,
        ok: false,
        error: {
          code: 'method_not_found',
          message: `Channel only available from the local app: ${channel}`
        }
      })
    }
    expect(remoteInvoke).not.toHaveBeenCalled()
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
    expect(localInvoke).toHaveBeenCalledOnce()
    expect(rpc.invoke).not.toHaveBeenCalled()
  })

  it('pins the remote Web Notebook capability matrix', () => {
    const channelsFor = (prefix: string): string[] =>
      Object.entries(WEB_INVOKE_CHANNELS)
        .filter(([path]) => path.startsWith(prefix))
        .map(([, channel]) => channel)

    const notebookChannels = channelsFor('notebook.')
    const environmentChannels = channelsFor('notebookEnv.')
    const runtimeChannels = channelsFor('runtime.')
    const localOnly = (channels: string[]): string[] =>
      channels.filter((channel) => REMOTE_LOCAL_ONLY_RPC_CHANNELS.has(channel))

    expect(localOnly(notebookChannels)).toEqual([
      'notebook:export-ipynb',
      'notebook:export-ipynb-all'
    ])
    expect(
      notebookChannels.filter((channel) => !localOnly(notebookChannels).includes(channel))
    ).toEqual([
      'notebook:append-code-cell',
      'notebook:begin-code-cell',
      'notebook:execute',
      'notebook:finish-code-cell',
      'notebook:reference',
      'notebook:read-input-preview',
      'notebook:restart',
      'notebook:run-cell',
      'notebook:shutdown',
      'notebook:state'
    ])
    expect(localOnly(environmentChannels)).toEqual([
      'notebook-env:cancel',
      'notebook-env:provision',
      'notebook-env:repair'
    ])
    expect(
      environmentChannels.filter((channel) => !localOnly(environmentChannels).includes(channel))
    ).toEqual(['notebook-env:status'])
    expect(localOnly(runtimeChannels)).toEqual([
      'runtime:pick-interpreter',
      'runtime:register-interpreter',
      'runtime:set-environment-enabled',
      'runtime:set-install-authorized',
      'runtime:set-selection',
      'runtime:unregister-interpreter'
    ])
    expect(
      runtimeChannels.filter((channel) => !localOnly(runtimeChannels).includes(channel))
    ).toEqual([
      'runtime:describe-usage',
      'runtime:get-enablement',
      'runtime:list-environments',
      'runtime:list-package-counts',
      'runtime:list-packages',
      'runtime:survey'
    ])
  })

  it.each([
    ['one-time', accessOnlyExternalAccess],
    ['trusted', authorizedExternalAccess]
  ])('pins the %s remote capability matrix', async (_authority, createAuthorization) => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    const acpChannels = Object.entries(WEB_INVOKE_CHANNELS)
      .filter(([path]) => path.startsWith('acp.'))
      .map(([, channel]) => channel)
      .sort()
    expect(acpChannels).toHaveLength(15)
    const permissionChannels = [
      'permissions:extend-undo',
      'permissions:list',
      'permissions:restore',
      'permissions:revoke'
    ]
    const computeChannels = [
      'compute:bookmarks:get',
      'compute:bookmarks:set',
      'compute:concurrency:set',
      'compute:create',
      'compute:delete',
      'compute:details:get',
      'compute:details:save',
      'compute:download',
      'compute:enabled-hosts:get',
      'compute:enabled-hosts:set',
      'compute:get',
      'compute:jobs:list',
      'compute:jobs:mark-consumed',
      'compute:jobs:pending-notification',
      'compute:list',
      'compute:list-dir',
      'compute:probe',
      'compute:approval-respond',
      'compute:reveal-in-folder',
      'compute:scratch:set',
      'compute:ssh-config-aliases'
    ]
    const remoteDeniedComputeChannels = ['compute:download', 'compute:reveal-in-folder']
    const remoteAllowedChannels = [
      ...acpChannels,
      ...permissionChannels,
      ...computeChannels.filter((channel) => !remoteDeniedComputeChannels.includes(channel))
    ]
    const rpcChannels = [
      'specialist:list',
      ...acpChannels,
      ...permissionChannels,
      ...computeChannels
    ]
    const rpc = {
      channels: () => rpcChannels,
      invoke: vi.fn(async (channel: string) => ({ channel })),
      releaseClient: vi.fn(),
      dispose: vi.fn()
    }
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'local-token',
      staticRoot,
      rpc,
      externalAccess: {
        authorizeHttp: vi.fn().mockResolvedValue(createAuthorization()),
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
    const base = `http://127.0.0.1:${server.port}`
    const invoke = (channel: string, local = false): Promise<Response> =>
      fetch(`${base}/rpc/${encodeURIComponent(channel)}`, {
        method: 'POST',
        headers: {
          ...(local ? { authorization: 'Bearer local-token' } : {}),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
      })

    const remoteBootstrap = await fetch(`${base}/api/bootstrap`)
    const remoteBootstrapBody = (await remoteBootstrap.json()) as {
      rpcChannels: string[]
      restrictedRpcChannels: string[]
    }
    expect(remoteBootstrapBody.rpcChannels).toEqual(remoteAllowedChannels)
    expect(remoteBootstrapBody.restrictedRpcChannels).toEqual(remoteDeniedComputeChannels)

    for (const channel of remoteAllowedChannels) {
      const response = await invoke(channel)
      expect(response.status, channel).toBe(200)
    }
    for (const channel of remoteDeniedComputeChannels) {
      const remoteResponse = await invoke(channel)
      expect(remoteResponse.status, channel).toBe(403)

      const localResponse = await invoke(channel, true)
      expect(localResponse.status, channel).toBe(200)
    }

    const localBootstrap = await fetch(`${base}/api/bootstrap`, {
      headers: { authorization: 'Bearer local-token' }
    })
    const localBootstrapBody = (await localBootstrap.json()) as {
      rpcChannels: string[]
      restrictedRpcChannels: string[]
    }
    expect(localBootstrapBody.rpcChannels).toEqual([
      ...acpChannels,
      ...permissionChannels,
      ...computeChannels
    ])
    expect(localBootstrapBody.restrictedRpcChannels).toEqual([])

    expect((await invoke('specialist:list')).status).toBe(404)
    expect((await invoke('specialist:list', true)).status).toBe(404)
    expect(rpc.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      ...remoteAllowedChannels,
      ...remoteDeniedComputeChannels
    ])
  })

  it('closes targeted or all external WebSockets without disturbing local clients', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    const server = await startTestWebHttpServer({
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
    const server = await startTestWebHttpServer({
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
    const server = await startTestWebHttpServer({
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
    const taskContexts: CallerContext[] = []
    const runWithCapturedCallerContext = <Result>(
      context: CallerContext,
      operation: () => Result
    ): Result => {
      taskContexts.push(context)
      return operation()
    }
    const tasks = {
      runWithCallerContext: runWithCapturedCallerContext,
      listProjects: vi.fn().mockResolvedValue([{ id: 'project-1', name: 'Research' }]),
      createProject: vi.fn().mockResolvedValue({ id: 'project-2', name: 'Created' }),
      listSessions: vi.fn().mockResolvedValue([{ id: 'session/1', title: 'Review' }]),
      getSession: vi.fn().mockResolvedValue({ id: 'session/1', title: 'Review' }),
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
      listArtifacts: vi.fn().mockResolvedValue([{ id: 'artifact/1', name: 'report.md' }]),
      acquireArtifact: vi.fn(),
      releaseArtifact: vi.fn(),
      dispose: vi.fn()
    }
    const server = await startTestWebHttpServer({
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
    expect(projects.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(projects.headers.get('cache-control')).toBe('no-store')
    expect(await projects.json()).toEqual({ data: [{ id: 'project-1', name: 'Research' }] })
    expect(taskContexts[0]).toMatchObject({
      surface: 'task',
      location: 'local',
      principalKind: 'automation',
      actionOrigin: 'automation'
    })

    const created = await fetch(`${base}/api/v1/projects`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Created', description: 'A new project' })
    })
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({ data: { id: 'project-2', name: 'Created' } })
    expect(tasks.createProject).toHaveBeenCalledWith({
      name: 'Created',
      description: 'A new project'
    })

    const sessions = await fetch(`${base}/api/v1/sessions?project=Research%20%2F%20Lab`, {
      headers
    })
    expect(await sessions.json()).toEqual({ data: [{ id: 'session/1', title: 'Review' }] })
    expect(tasks.listSessions).toHaveBeenCalledWith('Research / Lab')

    const session = await fetch(`${base}/api/v1/sessions/session%2F1`, { headers })
    expect(await session.json()).toEqual({ data: { id: 'session/1', title: 'Review' } })
    expect(tasks.getSession).toHaveBeenCalledWith('session/1')

    const artifacts = await fetch(`${base}/api/v1/sessions/session%2F1/artifacts`, { headers })
    expect(await artifacts.json()).toEqual({
      data: [{ id: 'artifact/1', name: 'report.md' }]
    })
    expect(tasks.listArtifacts).toHaveBeenCalledWith('session/1')

    const started = await fetch(`${base}/api/v1/runs`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        project: 'project-1',
        prompt: 'Research this.',
        permissionProfile: 'auto'
      })
    })
    expect(started.status).toBe(202)
    expect(await started.json()).toMatchObject({ data: { id: 'run-1', status: 'running' } })
    expect(tasks.startRun).toHaveBeenCalledWith({
      project: 'project-1',
      prompt: 'Research this.',
      permissionProfile: 'auto'
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

    tasks.startRun.mockRejectedValueOnce(
      new TaskApiError('project_not_found', 'Project not found: missing')
    )
    const missingProject = await fetch(`${base}/api/v1/runs`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'missing', prompt: 'Research this.' })
    })
    expect(missingProject.status).toBe(404)
    expect(await missingProject.json()).toEqual({
      error: { code: 'project_not_found', message: 'Project not found: missing' }
    })

    const malformed = await fetch(`${base}/api/v1/runs`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{not-json'
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({
      error: { code: 'invalid_request', message: 'Request body must be valid JSON.' }
    })

    const unauthenticated = await fetch(`${base}/api/v1/projects`)
    expect(unauthenticated.status).toBe(401)
    expect(await unauthenticated.text()).toBe('Unauthorized')

    for (const path of [
      '/api/v1/permissions/permission-1/approve',
      '/api/v1/specialists',
      '/api/v1/compute'
    ]) {
      const absent = await fetch(`${base}${path}`, { method: 'POST', headers })
      expect(absent.status).toBe(404)
      expect(await absent.json()).toEqual({
        error: { code: 'not_found', message: 'Task API endpoint not found.' }
      })
    }
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
      runWithCallerContext,
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
    const server = await startTestWebHttpServer({
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
      runWithCallerContext,
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
    const server = await startTestWebHttpServer({
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
