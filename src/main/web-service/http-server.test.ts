import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingMessage, ServerResponse } from 'node:http'
import { connect } from 'node:net'
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
import { ApplicationCommandError } from '../../shared/application-command-contract'
import { TASK_EVENT_STREAM_PROTOCOL_VERSION } from '../../shared/task-api'
import {
  isWebRpcChannel,
  WEB_EVENT_STREAM_PROTOCOL_VERSION,
  WEB_RPC_CAPABILITIES,
  WEB_RPC_PROTOCOL_VERSION
} from '../../shared/web-rpc-contract'
import { ApplicationEventHub } from '../application-events'
import type { CallerContext } from '../caller-context'
import { createLogger, flushLogs, initLogger } from '../logger'
import { PermissionApprovalPresence } from '../permission-approval-presence'
import {
  REMOTE_LOCAL_ONLY_RPC_CHANNELS,
  startWebHttpServer,
  TaskIdempotencyRegistry,
  type ExternalWebAccessAuthorization,
  type RunningWebServer
} from './http-server'
import { TaskApiError } from './task-api'

const roots: string[] = []
const servers: RunningWebServer[] = []
let diagnosticLogDir: string | undefined
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
const authorizedExternalAccess = (
  principalId = 'trusted-browser'
): ExternalWebAccessAuthorization => ({
  kind: 'authorized-pairing-manager' as const,
  principalId,
  isCurrent: () => true
})
const accessOnlyExternalAccess = (
  principalId = 'one-time-session'
): ExternalWebAccessAuthorization => ({
  kind: 'authorized' as const,
  principalId,
  isCurrent: () => true
})
const startBudgetTestServer = async (
  requestBodyBudgets: NonNullable<Parameters<typeof startWebHttpServer>[0]['requestBodyBudgets']>,
  onExternalAuthorization?: () => void,
  invoke: TestWebServerOptions['rpc']['invoke'] = vi.fn().mockResolvedValue([]),
  principalIdForRequest: (request: IncomingMessage) => string = () => 'one-time-session'
): ReturnType<typeof startWebHttpServer> => {
  const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
  roots.push(staticRoot)
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
  const server = await startTestWebHttpServer({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    staticRoot,
    requestBodyBudgets,
    rpc: {
      channels: () => ['projects:list'],
      invoke,
      releaseClient: vi.fn(),
      dispose: vi.fn()
    },
    externalAccess: {
      authorizeHttp: async (request) => {
        onExternalAuthorization?.()
        return accessOnlyExternalAccess(principalIdForRequest(request))
      },
      authorizeWebSocket: async () => undefined
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
  return server
}
const runWithCallerContext = <Result>(_context: CallerContext, operation: () => Result): Result =>
  operation()

const readLogRecords = async (logDir: string): Promise<Record<string, unknown>[]> => {
  await flushLogs()
  return (await readFile(join(logDir, 'main.log'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await flushLogs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  if (diagnosticLogDir) {
    await rm(diagnosticLogDir, { recursive: true, force: true })
  }
})

describe('startWebHttpServer', () => {
  it('tracks only interactive internal Web event clients as approval-capable', async () => {
    const permissionApprovalPresence = new PermissionApprovalPresence()
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      permissionApprovalPresence,
      rpc: { channels: () => [], invoke: vi.fn() },
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        configRoot: '/fake/root',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)
    const interactive = new WebSocket(
      `ws://127.0.0.1:${server.port}/events?token=test-token&client=web-ui`
    )
    await new Promise<void>((resolve) => interactive.once('open', resolve))
    expect(permissionApprovalPresence.isAvailable()).toBe(true)

    const liveness = new WebSocket(
      `ws://127.0.0.1:${server.port}/events?token=test-token&client=probe&liveness=1`
    )
    await new Promise<void>((resolve) => liveness.once('open', resolve))
    interactive.close()
    await new Promise<void>((resolve) => interactive.once('close', () => resolve()))
    await vi.waitFor(() => expect(permissionApprovalPresence.isAvailable()).toBe(false))

    liveness.close()
  })

  it('closes stale external event sockets before an application event can leak', async () => {
    let authorizationCurrent = true
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      rpc: { channels: () => [], invoke: vi.fn() },
      externalAccess: {
        authorizeHttp: vi.fn().mockResolvedValue('denied'),
        authorizeWebSocket: vi.fn().mockResolvedValue({
          principalId: 'remote-principal-1',
          isCurrent: () => authorizationCurrent
        })
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
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/events`)
    await new Promise<void>((resolve) => socket.once('open', resolve))
    authorizationCurrent = false

    const outcome = new Promise<'closed' | 'leaked'>((resolve) => {
      socket.once('close', () => resolve('closed'))
      socket.once('message', () => resolve('leaked'))
    })
    applicationEvents.publish('project:created', {
      id: 'private-project',
      name: 'Private project',
      description: '',
      isExample: false,
      createdAt: 1,
      updatedAt: 1
    })

    await expect(
      Promise.race([
        outcome,
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 250))
      ])
    ).resolves.toBe('closed')
  })

  it('closes stale idle external sockets before heartbeat traffic is sent', async () => {
    let authorizationCurrent = true
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      eventHeartbeatIntervalMs: 10,
      rpc: { channels: () => [], invoke: vi.fn() },
      externalAccess: {
        authorizeHttp: vi.fn().mockResolvedValue('denied'),
        authorizeWebSocket: vi.fn().mockResolvedValue({
          principalId: 'remote-principal-1',
          isCurrent: () => authorizationCurrent
        })
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
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/events?liveness=1`)
    await new Promise<void>((resolve) => socket.once('open', resolve))
    authorizationCurrent = false

    const outcome = new Promise<'closed' | 'heartbeat'>((resolve) => {
      socket.once('close', () => resolve('closed'))
      socket.once('message', () => resolve('heartbeat'))
    })
    await expect(
      Promise.race([
        outcome,
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 250))
      ])
    ).resolves.toBe('closed')
  })

  it('rejects stale external sockets before replay frames are sent', async () => {
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      rpc: { channels: () => [], invoke: vi.fn() },
      externalAccess: {
        authorizeHttp: vi.fn().mockResolvedValue('denied'),
        authorizeWebSocket: vi.fn().mockResolvedValue({
          principalId: 'remote-principal-1',
          isCurrent: () => false
        })
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
    const url = new URL(`ws://127.0.0.1:${server.port}/events`)
    url.searchParams.set('eventProtocol', String(WEB_EVENT_STREAM_PROTOCOL_VERSION))
    url.searchParams.set('stream', 'stale-stream')
    url.searchParams.set('after', '0')
    const socket = new WebSocket(url)
    const outcome = new Promise<'rejected' | 'replayed'>((resolve) => {
      socket.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve('rejected')
      })
      socket.once('error', () => resolve('rejected'))
      socket.once('message', () => resolve('replayed'))
    })

    await expect(
      Promise.race([
        outcome,
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 250))
      ])
    ).resolves.toBe('rejected')
  })

  it('closes stale external sockets before Task progress is sent', async () => {
    let authorizationCurrent = true
    let publishProgress:
      ((event: import('../../shared/task-api').TaskRunProgressEvent) => void) | undefined
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      rpc: { channels: () => [], invoke: vi.fn() },
      tasks: {
        subscribeProgress: (
          listener: (event: import('../../shared/task-api').TaskRunProgressEvent) => void
        ) => {
          publishProgress = listener
          return () => {
            publishProgress = undefined
          }
        }
      } as never,
      externalAccess: {
        authorizeHttp: vi.fn().mockResolvedValue('denied'),
        authorizeWebSocket: vi.fn().mockResolvedValue({
          principalId: 'remote-principal-1',
          isCurrent: () => authorizationCurrent
        })
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
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/events`)
    await new Promise<void>((resolve) => socket.once('open', resolve))
    authorizationCurrent = false

    const outcome = new Promise<'closed' | 'leaked'>((resolve) => {
      socket.once('close', () => resolve('closed'))
      socket.once('message', () => resolve('leaked'))
    })
    publishProgress?.({
      runId: 'run-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      phase: 'provider-accepted',
      timestamp: 250,
      elapsedMs: 249,
      heartbeat: false
    })

    await expect(
      Promise.race([
        outcome,
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 250))
      ])
    ).resolves.toBe('closed')
  })

  it('rejects malformed URL encoding at the public HTTP boundary', async () => {
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      rpc: {
        channels: () => ['projects:list'],
        invoke: vi.fn(),
        releaseClient: vi.fn(),
        dispose: vi.fn()
      },
      tasks: {
        runWithCallerContext,
        subscribeProgress: vi.fn(() => vi.fn()),
        getRun: vi.fn()
      } as never,
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

    const statuses = await Promise.all([
      fetch(`${base}/api/bootstrap`, {
        headers: { cookie: 'open_science_web_token=%' }
      }).then((response) => response.status),
      fetch(`${base}/rpc/%`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
      }).then((response) => response.status),
      fetch(`${base}/api/v1/runs/%`, {
        headers: { authorization: 'Bearer test-token' }
      }).then((response) => response.status)
    ])

    expect(statuses).toEqual([401, 400, 400])
  })

  it('retains a parsed body reservation when the client disconnects before its handler completes', async () => {
    const body = JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
    const bodyBytes = Buffer.byteLength(body)
    let markHandlerStarted: () => void = () => undefined
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve
    })
    let finishFirstHandler: (value: unknown) => void = () => undefined
    const firstHandler = new Promise<unknown>((resolve) => {
      finishFirstHandler = resolve
    })
    const invoke = vi
      .fn<TestWebServerOptions['rpc']['invoke']>()
      .mockImplementationOnce(async () => {
        markHandlerStarted()
        return firstHandler
      })
      .mockResolvedValue([])
    const server = await startBudgetTestServer(
      {
        perRequestBytes: bodyBytes,
        perClientInFlightBytes: bodyBytes,
        serverInFlightBytes: bodyBytes
      },
      undefined,
      invoke
    )

    const firstRequest = httpRequest({
      host: '127.0.0.1',
      port: server.port,
      path: '/rpc/projects%3Alist',
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        'content-length': String(bodyBytes),
        'x-open-science-client': 'first-client'
      }
    })
    firstRequest.on('error', () => undefined)
    firstRequest.end(body)
    await handlerStarted
    const firstClosed = new Promise<void>((resolve) => firstRequest.once('close', resolve))
    firstRequest.destroy()
    await firstClosed
    await new Promise<void>((resolve) => setImmediate(resolve))

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/rpc/projects%3Alist`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-open-science-client': 'second-client'
        },
        body
      })

      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ error: { code: 'handler_error' } })
      expect(invoke).toHaveBeenCalledOnce()
    } finally {
      finishFirstHandler([])
    }
  })

  it.each([
    {
      dimension: 'server',
      budgets: {
        perRequestBytes: 64,
        perClientInFlightBytes: 64,
        serverInFlightBytes: 64
      },
      firstClientId: 'first-client',
      secondClientId: 'second-client',
      expectedStatus: 503
    },
    {
      dimension: 'client',
      budgets: {
        perRequestBytes: 64,
        perClientInFlightBytes: 64,
        serverInFlightBytes: 128
      },
      firstClientId: 'first-connection',
      secondClientId: 'second-connection',
      expectedStatus: 429
    }
  ])(
    'rejects a declared body before reading when concurrent requests exhaust the $dimension byte budget',
    async ({ dimension, budgets, firstClientId, secondClientId, expectedStatus }) => {
      let authorizeCount = 0
      let markFirstAuthorized: () => void = () => undefined
      const firstAuthorized = new Promise<void>((resolve) => {
        markFirstAuthorized = resolve
      })
      const server = await startBudgetTestServer(
        budgets,
        () => {
          authorizeCount += 1
          if (authorizeCount === 1) markFirstAuthorized()
        },
        undefined,
        ({ headers }) =>
          dimension === 'server'
            ? `principal:${String(headers['x-open-science-client'])}`
            : 'shared-principal'
      )

      const firstRequest = httpRequest({
        host: '127.0.0.1',
        port: server.port,
        path: '/rpc/projects%3Alist',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': '64',
          'x-open-science-client': firstClientId
        }
      })
      firstRequest.on('error', () => undefined)
      firstRequest.write('{')
      await firstAuthorized
      await new Promise<void>((resolve) => setImmediate(resolve))

      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/rpc/projects%3Alist`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-open-science-client': secondClientId
          },
          body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
        })

        expect(response.status).toBe(expectedStatus)
        expect(await response.json()).toMatchObject({
          error: { code: 'handler_error' }
        })
      } finally {
        const firstClosed = new Promise<void>((resolve) => firstRequest.once('close', resolve))
        firstRequest.destroy()
        await firstClosed
      }

      await new Promise<void>((resolve) => setImmediate(resolve))
      const retry = await fetch(`http://127.0.0.1:${server.port}/rpc/projects%3Alist`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-open-science-client': secondClientId
        },
        body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
      })
      expect(retry.status).toBe(200)
    }
  )

  it.each([
    {
      transport: 'declared',
      bodyHeaders: ['Content-Length: 65'],
      body: ''
    },
    {
      transport: 'chunked',
      bodyHeaders: ['Transfer-Encoding: chunked'],
      body: `41\r\n${'x'.repeat(65)}\r\n`
    }
  ])(
    'rejects an oversized $transport body and closes the connection',
    async ({ bodyHeaders, body }) => {
      const server = await startBudgetTestServer({
        perRequestBytes: 64,
        perClientInFlightBytes: 128,
        serverInFlightBytes: 128
      })

      const socket = connect({ host: '127.0.0.1', port: server.port })
      const chunks: Buffer[] = []
      socket.on('data', (chunk: Buffer) => chunks.push(chunk))
      socket.on('error', () => undefined)
      await new Promise<void>((resolve) => socket.once('connect', resolve))
      const closed = new Promise<string>((resolve) =>
        socket.once('close', () => resolve(Buffer.concat(chunks).toString()))
      )

      socket.write(
        `${[
          'POST /rpc/projects%3Alist HTTP/1.1',
          `Host: 127.0.0.1:${server.port}`,
          'Authorization: Bearer test-token',
          'Content-Type: application/json',
          ...bodyHeaders,
          'Connection: keep-alive',
          '',
          ''
        ].join('\r\n')}${body}`
      )

      const response = await Promise.race([
        closed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('oversized request connection stayed open')), 1_000)
        )
      ])
      expect(response).toContain('HTTP/1.1 413')
      expect(response.toLowerCase()).toContain('connection: close')
      expect(response).toContain('Request body is too large.')
    }
  )

  it('preserves valid idempotency entries when replay capacity is full', async () => {
    const registry = new TaskIdempotencyRegistry(2, 8_192)
    const first = vi.fn().mockResolvedValue('first result')

    await expect(registry.run('first', 'first fingerprint', 4_096, first)).resolves.toBe(
      'first result'
    )
    await registry.run('second', 'second fingerprint', 4_096, async () => 'second result')
    await expect(
      registry.run('third', 'third fingerprint', 4_096, async () => 'third result')
    ).rejects.toThrow('Idempotency replay capacity is temporarily unavailable.')
    await expect(registry.run('first', 'first fingerprint', 4_096, first)).resolves.toBe(
      'first result'
    )
    expect(first).toHaveBeenCalledOnce()
  })

  it('limits one idempotency principal without consuming another principal capacity', async () => {
    const registry = new TaskIdempotencyRegistry(2, 8_192, Date.now, 1, 4_096)

    await expect(
      registry.run(
        'principal-a:first',
        'first fingerprint',
        4_096,
        async () => 'first',
        'principal-a'
      )
    ).resolves.toBe('first')
    await expect(
      registry.run(
        'principal-a:second',
        'second fingerprint',
        4_096,
        async () => 'second',
        'principal-a'
      )
    ).rejects.toThrow('Idempotency replay capacity is temporarily unavailable.')
    await expect(
      registry.run(
        'principal-b:first',
        'third fingerprint',
        4_096,
        async () => 'third',
        'principal-b'
      )
    ).resolves.toBe('third')
  })

  it('serves static resources with browser security policies', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>Web test</title>')
    await writeFile(join(staticRoot, 'app.js'), 'window.__staticTest = true')
    await writeFile(join(staticRoot, 'worker.mjs'), 'export const ready = true')
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
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        configRoot: '/fake/root',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)

    for (const path of ['/', '/app.js']) {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        headers: { authorization: 'Bearer test-token' }
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
      expect(response.headers.get('x-frame-options')).toBe('DENY')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    }

    const moduleResponse = await fetch(`http://127.0.0.1:${server.port}/worker.mjs`, {
      headers: { authorization: 'Bearer test-token' }
    })
    expect(moduleResponse.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
  })

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

    directInvoke.mockRejectedValueOnce(
      new ApplicationCommandError('invalid-command-arguments', 'Invalid project request.')
    )
    const invalidResponse = await fetch(`http://127.0.0.1:${server.port}/rpc/projects%3Alist`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        'x-open-science-client': 'direct-client'
      },
      body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
    })
    expect(invalidResponse.status).toBe(400)
    expect(await invalidResponse.json()).toEqual({
      protocolVersion: WEB_RPC_PROTOCOL_VERSION,
      ok: false,
      error: { code: 'invalid-command-arguments', message: 'Invalid project request.' }
    })

    for (const [code, expectedStatus] of [
      ['command-unavailable', 404],
      ['session-details-conflict', 409],
      ['session-revision-conflict', 409]
    ] as const) {
      directInvoke.mockRejectedValueOnce(new ApplicationCommandError(code, `Rejected: ${code}`))
      const rejectedResponse = await fetch(`http://127.0.0.1:${server.port}/rpc/projects%3Alist`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
          'x-open-science-client': 'direct-client'
        },
        body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
      })
      expect(rejectedResponse.status).toBe(expectedStatus)
      expect(await rejectedResponse.json()).toMatchObject({
        ok: false,
        error: { code }
      })
    }

    directInvoke.mockRejectedValueOnce(
      new Error('SQLITE_CANTOPEN: /Users/private/.open-science/open-science.db')
    )
    const internalErrorResponse = await fetch(
      `http://127.0.0.1:${server.port}/rpc/projects%3Alist`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
          'x-open-science-client': 'direct-client'
        },
        body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
      }
    )
    expect(internalErrorResponse.status).toBe(500)
    expect(await internalErrorResponse.json()).toEqual({
      protocolVersion: WEB_RPC_PROTOCOL_VERSION,
      ok: false,
      error: { code: 'command-failed', message: 'Internal server error' }
    })

    const directSignal = directInvoke.mock.calls[0]?.[1].callerLease.signal
    firstSocket.close()
    await new Promise<void>((resolve) => firstSocket.once('close', () => resolve()))
    expect(directSignal.aborted).toBe(false)
    secondSocket.close()
    await new Promise<void>((resolve) => secondSocket.once('close', () => resolve()))
    await vi.waitFor(() => expect(directSignal.aborted).toBe(true))
  })

  it('correlates a rejected Web RPC with logs emitted by its command', async () => {
    const logDir = await mkdtemp(join(tmpdir(), 'open-science-web-rpc-log-'))
    diagnosticLogDir = logDir
    initLogger({ logDir, mirrorToConsole: false })
    const invoke = vi.fn(async () => {
      createLogger('test-command').warn('command execution failed', {
        sessionId: 'session-1',
        runId: 'run-1'
      })
      throw new Error('private command failure')
    })
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      rpc: { channels: () => ['projects:list'], invoke },
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        configRoot: '/fake/root',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)

    const response = await fetch(`http://127.0.0.1:${server.port}/rpc/projects%3Alist`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
    })

    expect(response.status).toBe(500)
    const records = (await readLogRecords(logDir)).filter(
      (record) =>
        record.scope === 'test-command' ||
        (record.scope === 'web-service' && record.msg === 'web rpc rejected')
    )
    expect(records).toHaveLength(2)
    expect(new Set(records.map((record) => record.correlationId))).toEqual(
      new Set([expect.any(String)])
    )
    expect(records[0]?.data).toMatchObject({ sessionId: 'session-1', runId: 'run-1' })
    expect(records[1]?.data).toEqual({
      channel: 'projects:list',
      surface: 'web',
      location: 'local',
      errorCategory: 'error'
    })
    expect(JSON.stringify(records)).not.toContain('private command failure')
  })

  it('correlates a rejected Task HTTP request with logs emitted by its Run', async () => {
    const logDir = await mkdtemp(join(tmpdir(), 'open-science-task-http-log-'))
    diagnosticLogDir = logDir
    initLogger({ logDir, mirrorToConsole: false })
    const startRun = vi.fn(async () => {
      createLogger('test-task-run').warn('task run execution failed', {
        sessionId: 'session-1',
        runId: 'run-1'
      })
      throw new Error('private task run failure')
    })
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      rpc: { channels: () => [], invoke: vi.fn() },
      tasks: {
        runWithCallerContext,
        subscribeProgress: vi.fn(() => vi.fn()),
        listProjects: vi.fn(),
        createProject: vi.fn(),
        updateProject: vi.fn(),
        listSessions: vi.fn(),
        getSession: vi.fn(),
        startRun,
        getRun: vi.fn(),
        cancelRun: vi.fn(),
        listArtifacts: vi.fn(),
        acquireArtifact: vi.fn(),
        releaseArtifact: vi.fn()
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

    const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/runs`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ project: 'project-1', sessionId: 'session-1', prompt: 'Run task.' })
    })

    expect(response.status).toBe(500)
    const records = (await readLogRecords(logDir)).filter(
      (record) =>
        record.scope === 'test-task-run' ||
        (record.scope === 'web-service' && record.msg === 'task http request rejected')
    )
    expect(records).toHaveLength(2)
    expect(new Set(records.map((record) => record.correlationId))).toEqual(
      new Set([expect.any(String)])
    )
    expect(records[0]?.data).toMatchObject({ sessionId: 'session-1', runId: 'run-1' })
    expect(records[1]?.data).toEqual({
      method: 'POST',
      surface: 'task',
      location: 'local',
      errorCategory: 'error'
    })
    expect(JSON.stringify(records)).not.toContain('private task run failure')
  })

  it('releases its application-event subscription when listening fails', async () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(() => unsubscribe)
    const unsubscribeProgress = vi.fn()
    const subscribeProgress = vi.fn(() => unsubscribeProgress)
    const options = {
      host: '127.0.0.1',
      token: 'test-token',
      staticRoot: '/unused',
      applicationEvents: { subscribe },
      tasks: {
        runWithCallerContext,
        subscribeProgress,
        listProjects: vi.fn(),
        createProject: vi.fn(),
        updateProject: vi.fn(),
        listSessions: vi.fn(),
        getSession: vi.fn(),
        startRun: vi.fn(),
        getRun: vi.fn(),
        cancelRun: vi.fn(),
        listArtifacts: vi.fn(),
        acquireArtifact: vi.fn(),
        releaseArtifact: vi.fn()
      },
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
    expect(subscribeProgress).toHaveBeenCalledOnce()
    expect(unsubscribeProgress).toHaveBeenCalledOnce()

    const retry = await startWebHttpServer({ ...options, port: 0 })
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(subscribeProgress).toHaveBeenCalledTimes(2)
    expect(unsubscribeProgress).toHaveBeenCalledOnce()
    await retry.close()
    expect(unsubscribe).toHaveBeenCalledTimes(2)
    expect(unsubscribeProgress).toHaveBeenCalledTimes(2)
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
      tasks: {
        subscribeProgress: () => () => undefined,
        resolveActiveRun: (sessionId: string) =>
          sessionId === 'session-1'
            ? { runId: 'run-1', sessionId, projectId: 'project-1' }
            : undefined
      } as never,
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
      rpcCapabilities: WEB_RPC_CAPABILITIES,
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
    applicationEvents.publish('acp:event', [
      {
        id: 'event-1',
        timestamp: 1,
        level: 'info',
        sessionId: 'session-1',
        kind: 'message',
        role: 'assistant',
        text: 'Hi'
      }
    ])
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
          sequence: 1,
          runId: 'run-1',
          sessionId: 'session-1',
          projectId: 'project-1',
          type: 'run.event',
          data: {
            id: 'event-1',
            timestamp: 1,
            level: 'info',
            sessionId: 'session-1',
            kind: 'message',
            role: 'assistant',
            text: 'Hi'
          }
        },
        {
          sequence: 2,
          runId: 'run-1',
          sessionId: 'session-1',
          projectId: 'project-1',
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

  it('disconnects event sockets before their outgoing backlog exceeds the byte limit', async () => {
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      tasks: {
        subscribeProgress: () => () => undefined,
        resolveActiveRun: (sessionId: string) =>
          sessionId === 'session-1'
            ? { runId: 'run-1', sessionId, projectId: 'project-1' }
            : undefined
      } as never,
      rpc: {
        channels: () => [],
        invoke: vi.fn(),
        releaseClient: vi.fn(),
        dispose: vi.fn()
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
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/events?token=test-token`)
    await new Promise<void>((resolve) => socket.once('open', resolve))
    const closed = new Promise<'closed'>((resolve) => socket.once('close', () => resolve('closed')))
    const bufferedAmount = vi
      .spyOn(WebSocket.prototype, 'bufferedAmount', 'get')
      .mockReturnValue(Number.MAX_SAFE_INTEGER)

    applicationEvents.publish('acp:event', [
      {
        id: 'event-1',
        timestamp: 1,
        level: 'info',
        sessionId: 'session-1',
        kind: 'message',
        role: 'assistant',
        text: 'Backlogged event'
      }
    ])
    const outcome = await Promise.race([
      closed,
      new Promise<'still-open'>((resolve) => setTimeout(() => resolve('still-open'), 250))
    ])
    bufferedAmount.mockRestore()

    expect(outcome).toBe('closed')

    const oversizedSocket = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/v1/events?token=test-token`
    )
    await new Promise<void>((resolve) => oversizedSocket.once('open', resolve))
    const oversizedClosed = new Promise<'closed'>((resolve) =>
      oversizedSocket.once('close', () => resolve('closed'))
    )
    applicationEvents.publish('acp:event', [
      {
        id: 'event-2',
        timestamp: 2,
        level: 'info',
        sessionId: 'session-1',
        kind: 'message',
        role: 'assistant',
        text: 'x'.repeat(17 * 1024 * 1024)
      }
    ])

    await expect(
      Promise.race([
        oversizedClosed,
        new Promise<'still-open'>((resolve) => setTimeout(() => resolve('still-open'), 250))
      ])
    ).resolves.toBe('closed')
  })

  it('keeps non-Task Session events off the public Task event stream', async () => {
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      tasks: {
        subscribeProgress: () => () => undefined,
        resolveActiveRun: (sessionId: string) =>
          sessionId === 'session-1'
            ? { runId: 'run-1', sessionId, projectId: 'project-1' }
            : undefined
      } as never,
      rpc: {
        channels: () => [],
        invoke: vi.fn(),
        releaseClient: vi.fn(),
        dispose: vi.fn()
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
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/events?token=test-token`)
    await new Promise<void>((resolve) => socket.once('open', resolve))
    const outcome = new Promise<'leaked'>((resolve) =>
      socket.once('message', () => resolve('leaked'))
    )

    applicationEvents.publish('acp:event', [
      {
        id: 'desktop-event',
        timestamp: 1,
        level: 'info',
        sessionId: 'desktop-session',
        kind: 'message',
        role: 'assistant',
        text: 'Private desktop Session detail'
      }
    ])
    applicationEvents.publish('acp:permission-request', {
      sessionId: 'desktop-session',
      requestId: 'desktop-permission',
      toolCallId: 'desktop-tool',
      title: 'Private desktop permission',
      options: []
    })

    await expect(
      Promise.race([
        outcome,
        new Promise<'not-delivered'>((resolve) => setTimeout(() => resolve('not-delivered'), 50))
      ])
    ).resolves.toBe('not-delivered')
    socket.close()
  })

  it('replays internal renderer events published while the Web client is disconnected', async () => {
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      tasks: {
        subscribeProgress: () => () => undefined,
        resolveActiveRun: (sessionId: string) =>
          sessionId === 'session-1'
            ? { runId: 'run-1', sessionId, projectId: 'project-1' }
            : undefined
      } as never,
      rpc: {
        channels: () => [],
        invoke: vi.fn(),
        releaseClient: vi.fn(),
        dispose: vi.fn()
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
    const bootstrap = (await (
      await fetch(`${base}/api/bootstrap`, {
        headers: { authorization: 'Bearer test-token' }
      })
    ).json()) as {
      eventStream: {
        protocolVersion: number
        streamId: string
        latestSequence: number
      }
    }
    expect(bootstrap.eventStream).toMatchObject({
      protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
      latestSequence: 0
    })

    const eventSocketUrl = (after: number): string => {
      const url = new URL(`${base.replace('http:', 'ws:')}/events`)
      url.searchParams.set('token', 'test-token')
      url.searchParams.set('client', 'replay-client')
      url.searchParams.set('eventProtocol', String(WEB_EVENT_STREAM_PROTOCOL_VERSION))
      url.searchParams.set('stream', bootstrap.eventStream.streamId)
      url.searchParams.set('after', String(after))
      return url.toString()
    }

    const staleSocketUrl = new URL(eventSocketUrl(0))
    staleSocketUrl.searchParams.set('eventProtocol', String(WEB_EVENT_STREAM_PROTOCOL_VERSION - 1))
    const staleSocket = new WebSocket(staleSocketUrl)
    await expect(
      new Promise<number>((resolve) => staleSocket.once('close', (code) => resolve(code)))
    ).resolves.toBe(1002)

    const firstSocket = new WebSocket(eventSocketUrl(0))
    const firstMessage = new Promise<unknown>((resolve) =>
      firstSocket.once('message', (data) => resolve(JSON.parse(data.toString())))
    )
    await new Promise<void>((resolve) => firstSocket.once('open', resolve))
    await expect(firstMessage).resolves.toMatchObject({ kind: 'ready', latestSequence: 0 })
    const firstClosed = new Promise<void>((resolve) => firstSocket.once('close', () => resolve()))
    firstSocket.close()
    await firstClosed

    applicationEvents.publish('acp:permission-request', {
      sessionId: 'internal-session',
      requestId: 'permission-1',
      toolCallId: 'tool-1',
      title: 'Run command',
      options: []
    })
    applicationEvents.publish('settings:connector-runtime-changed', undefined)

    const replayed: unknown[] = []
    const bufferedAmount = vi
      .spyOn(WebSocket.prototype, 'bufferedAmount', 'get')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(16 * 1024 * 1024)
    const secondSocket = new WebSocket(eventSocketUrl(0))
    const replayCompleted = new Promise<'ready' | 'closed'>((resolve) => {
      secondSocket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as { kind?: string }
        replayed.push(message)
        if (message.kind === 'ready') resolve('ready')
      })
      secondSocket.once('close', () => resolve('closed'))
    })
    await new Promise<void>((resolve) => secondSocket.once('open', resolve))
    const replayOutcome = await Promise.race([
      replayCompleted,
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 500))
    ])
    bufferedAmount.mockRestore()

    expect(replayOutcome).toBe('ready')
    expect(replayed).toEqual([
      expect.objectContaining({
        kind: 'event',
        sequence: 1,
        channel: 'acp:permission-request',
        payload: expect.objectContaining({ requestId: 'permission-1' })
      }),
      expect.objectContaining({
        kind: 'event',
        sequence: 2,
        channel: 'settings:connector-runtime-changed',
        payload: null
      }),
      expect.objectContaining({ kind: 'ready', latestSequence: 2 })
    ])
    secondSocket.close()

    const publicMessages: unknown[] = []
    const publicSocket = new WebSocket(
      `${base.replace('http:', 'ws:')}/api/v1/events?token=test-token`
    )
    publicSocket.on('message', (data) => publicMessages.push(JSON.parse(data.toString())))
    await new Promise<void>((resolve) => publicSocket.once('open', resolve))
    applicationEvents.publish('acp:permission-request', {
      sessionId: 'session-1',
      requestId: 'permission-live',
      toolCallId: 'tool-live',
      title: 'Run another command',
      options: []
    })
    await vi.waitFor(() => expect(publicMessages).toHaveLength(1))
    expect(publicMessages).toEqual([
      expect.objectContaining({
        type: 'permission.requested',
        data: expect.objectContaining({ requestId: 'permission-live' })
      })
    ])
    publicSocket.close()
  })

  it('does not replay event frames that predate a remote principal authorization', async () => {
    const authorizationFor = (request: IncomingMessage): ExternalWebAccessAuthorization =>
      accessOnlyExternalAccess(String(request.headers['x-test-principal']))
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'local-token',
      staticRoot: '/unused',
      rpc: { channels: () => [], invoke: vi.fn() },
      tasks: {
        subscribeProgress: () => () => undefined,
        resolveActiveRun: (sessionId: string) =>
          sessionId === 'task-session'
            ? { runId: 'run-1', sessionId, projectId: 'project-1' }
            : undefined
      } as never,
      externalAccess: {
        authorizeHttp: async (request) => authorizationFor(request),
        authorizeWebSocket: async (request) => authorizationFor(request)
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
    const bootstrapFor = async (
      principalId: string
    ): Promise<{ eventStream: { streamId: string; latestSequence: number } }> =>
      (await (
        await fetch(`${base}/api/bootstrap`, {
          headers: { 'x-test-principal': principalId }
        })
      ).json()) as { eventStream: { streamId: string; latestSequence: number } }
    const eventSocket = (
      pathname: '/events' | '/api/v1/events',
      principalId: string,
      streamId: string,
      after: number
    ): WebSocket => {
      const url = new URL(`${base.replace('http:', 'ws:')}${pathname}`)
      url.searchParams.set(
        'eventProtocol',
        String(
          pathname === '/events'
            ? WEB_EVENT_STREAM_PROTOCOL_VERSION
            : TASK_EVENT_STREAM_PROTOCOL_VERSION
        )
      )
      url.searchParams.set('stream', streamId)
      url.searchParams.set('after', String(after))
      return new WebSocket(url, { headers: { 'x-test-principal': principalId } })
    }
    const nextMessage = (socket: WebSocket): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for event frame from ${socket.url}.`)),
          500
        )
        socket.once('message', (data) => {
          clearTimeout(timeout)
          resolve(JSON.parse(data.toString()))
        })
      })

    const firstPrincipal = await bootstrapFor('principal-before-event')
    expect(firstPrincipal.eventStream.latestSequence).toBe(0)

    applicationEvents.publish('acp:event', [
      {
        id: 'event-before-second-principal',
        timestamp: 1,
        level: 'info',
        sessionId: 'task-session',
        kind: 'message',
        role: 'assistant',
        text: 'Authorized-principal-only history'
      }
    ])

    const firstInternalSocket = eventSocket(
      '/events',
      'principal-before-event',
      firstPrincipal.eventStream.streamId,
      0
    )
    await expect(nextMessage(firstInternalSocket)).resolves.toMatchObject({
      kind: 'event',
      sequence: 1,
      channel: 'acp:event'
    })
    firstInternalSocket.close()

    const secondPrincipal = await bootstrapFor('principal-after-event')
    expect(secondPrincipal.eventStream.latestSequence).toBe(1)
    const secondInternalSocket = eventSocket(
      '/events',
      'principal-after-event',
      secondPrincipal.eventStream.streamId,
      0
    )
    const secondInternalMessage = await nextMessage(secondInternalSocket)
    secondInternalSocket.close()

    const publicReadyUrl = new URL(`${base.replace('http:', 'ws:')}/api/v1/events`)
    publicReadyUrl.searchParams.set('eventProtocol', String(TASK_EVENT_STREAM_PROTOCOL_VERSION))
    const publicReadySocket = new WebSocket(publicReadyUrl, {
      headers: { 'x-test-principal': 'principal-after-event' }
    })
    const publicReady = await nextMessage(publicReadySocket)
    expect(publicReady).toMatchObject({
      type: 'stream.ready',
      data: { latestSequence: 1, streamId: expect.any(String) }
    })
    publicReadySocket.close()

    const publicStreamId = (publicReady.data as { streamId: string }).streamId
    const secondPublicSocket = eventSocket(
      '/api/v1/events',
      'principal-after-event',
      publicStreamId,
      0
    )
    const secondPublicMessage = await nextMessage(secondPublicSocket)
    secondPublicSocket.close()

    expect([secondInternalMessage, secondPublicMessage]).toMatchObject([
      {
        kind: 'resync-required',
        reason: 'cursor-expired',
        latestSequence: 1
      },
      {
        type: 'stream.resync-required',
        data: { reason: 'cursor-expired', latestSequence: 1 }
      }
    ])
  })

  it('invalidates remote replay floors for one principal or the current authorization generation', async () => {
    const authorizationFor = (request: IncomingMessage): ExternalWebAccessAuthorization =>
      accessOnlyExternalAccess(String(request.headers['x-test-principal']))
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'local-token',
      staticRoot: '/unused',
      rpc: { channels: () => [], invoke: vi.fn() },
      externalAccess: {
        authorizeHttp: async (request) => authorizationFor(request),
        authorizeWebSocket: async (request) => authorizationFor(request)
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
    const bootstrapFor = async (
      principalId: string
    ): Promise<{ eventStream: { streamId: string; latestSequence: number } }> =>
      (await (
        await fetch(`${base}/api/bootstrap`, {
          headers: { 'x-test-principal': principalId }
        })
      ).json()) as { eventStream: { streamId: string; latestSequence: number } }
    const resumeFor = (
      principalId: string,
      streamId: string,
      after: number
    ): Promise<Record<string, unknown>> => {
      const url = new URL(`${base.replace('http:', 'ws:')}/events`)
      url.searchParams.set('eventProtocol', String(WEB_EVENT_STREAM_PROTOCOL_VERSION))
      url.searchParams.set('stream', streamId)
      url.searchParams.set('after', String(after))
      const socket = new WebSocket(url, { headers: { 'x-test-principal': principalId } })
      return new Promise((resolve) =>
        socket.once('message', (data) => {
          socket.close()
          resolve(JSON.parse(data.toString()))
        })
      )
    }
    const publishProject = (id: string): void =>
      applicationEvents.publish('project:created', {
        id,
        name: id,
        description: '',
        isExample: false,
        createdAt: 1,
        updatedAt: 1
      })

    const firstPrincipal = await bootstrapFor('principal-one')
    publishProject('project-1')
    const secondPrincipal = await bootstrapFor('principal-two')
    publishProject('project-2')

    server.closeExternalConnections('principal-one')
    await bootstrapFor('principal-one')

    await expect(
      resumeFor('principal-one', firstPrincipal.eventStream.streamId, 0)
    ).resolves.toMatchObject({ kind: 'resync-required', reason: 'cursor-expired' })
    await expect(
      resumeFor('principal-two', secondPrincipal.eventStream.streamId, 1)
    ).resolves.toMatchObject({ kind: 'event', sequence: 2 })

    server.closeExternalConnections()
    publishProject('project-3')
    await bootstrapFor('principal-two')

    await expect(
      resumeFor('principal-two', secondPrincipal.eventStream.streamId, 1)
    ).resolves.toMatchObject({ kind: 'resync-required', reason: 'cursor-expired' })
  })

  it('replays owned public Task events from the requested sequence', async () => {
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      rpc: {
        channels: () => [],
        invoke: vi.fn(),
        releaseClient: vi.fn(),
        dispose: vi.fn()
      },
      tasks: {
        subscribeProgress: () => () => undefined,
        resolveActiveRun: (sessionId: string) =>
          sessionId === 'task-session'
            ? { runId: 'run-1', sessionId, projectId: 'project-1' }
            : undefined
      } as never,
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        configRoot: '/fake/root',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)
    const baseUrl = new URL(`ws://127.0.0.1:${server.port}/api/v1/events`)
    baseUrl.searchParams.set('token', 'test-token')
    baseUrl.searchParams.set('eventProtocol', '1')
    const firstSocket = new WebSocket(baseUrl)
    const firstMessage = new Promise<unknown>((resolve) =>
      firstSocket.once('message', (data) => resolve(JSON.parse(data.toString())))
    )
    await new Promise<void>((resolve) => firstSocket.once('open', resolve))
    const ready = await Promise.race([
      firstMessage,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for public stream readiness.')), 250)
      )
    ])
    expect(ready).toMatchObject({
      type: 'stream.ready',
      data: { protocolVersion: 1, latestSequence: 0, streamId: expect.any(String) }
    })
    const streamId = (ready as { data: { streamId: string } }).data.streamId
    const firstClosed = new Promise<void>((resolve) => firstSocket.once('close', () => resolve()))
    firstSocket.close()
    await firstClosed

    applicationEvents.publish('acp:event', [
      {
        id: 'event-1',
        timestamp: 1,
        level: 'info',
        sessionId: 'task-session',
        kind: 'message',
        role: 'assistant',
        text: 'Task output'
      }
    ])

    const resumeUrl = new URL(baseUrl)
    resumeUrl.searchParams.set('stream', streamId)
    resumeUrl.searchParams.set('after', '0')
    const replayed: unknown[] = []
    const secondSocket = new WebSocket(resumeUrl)
    const replayReady = new Promise<void>((resolve) => {
      secondSocket.on('message', (data) => {
        const message = JSON.parse(data.toString())
        replayed.push(message)
        if (message.type === 'stream.ready') resolve()
      })
    })
    await replayReady

    expect(replayed).toEqual([
      {
        sequence: 1,
        runId: 'run-1',
        sessionId: 'task-session',
        projectId: 'project-1',
        type: 'run.event',
        data: {
          id: 'event-1',
          timestamp: 1,
          level: 'info',
          sessionId: 'task-session',
          kind: 'message',
          role: 'assistant',
          text: 'Task output'
        }
      },
      {
        type: 'stream.ready',
        data: { protocolVersion: 1, streamId, latestSequence: 1 }
      }
    ])
    secondSocket.close()
  })

  it('sends opt-in liveness frames on internal and public event sockets', async () => {
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      eventHeartbeatIntervalMs: 10,
      rpc: {
        channels: () => [],
        invoke: vi.fn(),
        releaseClient: vi.fn(),
        dispose: vi.fn()
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
    const bootstrap = (await (
      await fetch(`${base}/api/bootstrap`, {
        headers: { authorization: 'Bearer test-token' }
      })
    ).json()) as {
      eventStream: { streamId: string; latestSequence: number }
    }
    const internalUrl = new URL(`${base.replace('http:', 'ws:')}/events`)
    internalUrl.searchParams.set('token', 'test-token')
    internalUrl.searchParams.set('client', 'heartbeat-web')
    internalUrl.searchParams.set('eventProtocol', String(WEB_EVENT_STREAM_PROTOCOL_VERSION))
    internalUrl.searchParams.set('stream', bootstrap.eventStream.streamId)
    internalUrl.searchParams.set('after', String(bootstrap.eventStream.latestSequence))
    internalUrl.searchParams.set('liveness', '1')
    const publicUrl = new URL(`${base.replace('http:', 'ws:')}/api/v1/events`)
    publicUrl.searchParams.set('token', 'test-token')
    publicUrl.searchParams.set('client', 'heartbeat-sdk')
    publicUrl.searchParams.set('liveness', '1')
    const internalSocket = new WebSocket(internalUrl)
    const publicSocket = new WebSocket(publicUrl)
    const messages = (socket: WebSocket): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for heartbeat.')), 250)
        socket.on('message', (data) => {
          const parsed = JSON.parse(data.toString())
          if (parsed.kind === 'ready') return
          clearTimeout(timeout)
          resolve(parsed)
        })
      })

    await expect(Promise.all([messages(internalSocket), messages(publicSocket)])).resolves.toEqual([
      expect.objectContaining({
        kind: 'heartbeat',
        protocolVersion: WEB_EVENT_STREAM_PROTOCOL_VERSION,
        streamId: bootstrap.eventStream.streamId,
        latestSequence: bootstrap.eventStream.latestSequence
      }),
      expect.objectContaining({
        type: 'connection.heartbeat',
        data: { timestamp: expect.any(Number) }
      })
    ])
    internalSocket.close()
    publicSocket.close()
  })

  it('closes event sockets with a protocol error when a client sends data', async () => {
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      rpc: { channels: () => [], invoke: vi.fn() },
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        configRoot: '/fake/root',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/events?token=test-token`)
    await new Promise<void>((resolve) => socket.once('open', resolve))
    const closed = new Promise<{ code: number; reason: string } | undefined>((resolve) => {
      const timeout = setTimeout(() => resolve(undefined), 500)
      socket.once('close', (code, reason) => {
        clearTimeout(timeout)
        resolve({ code, reason: reason.toString() })
      })
    })

    socket.send('unexpected inbound data')

    const outcome = await closed
    if (socket.readyState === WebSocket.OPEN) socket.close()
    expect(outcome).toEqual({ code: 1002, reason: 'Inbound messages are not supported' })
  })

  it('rejects event socket messages larger than the inbound payload budget', async () => {
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      rpc: { channels: () => [], invoke: vi.fn() },
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        configRoot: '/fake/root',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/events?token=test-token`)
    socket.on('error', () => undefined)
    await new Promise<void>((resolve) => socket.once('open', resolve))
    const closed = new Promise<number | undefined>((resolve) => {
      const timeout = setTimeout(() => resolve(undefined), 500)
      socket.once('close', (code) => {
        clearTimeout(timeout)
        resolve(code)
      })
    })

    socket.send(Buffer.alloc(1_025))

    const outcome = await closed
    if (socket.readyState === WebSocket.OPEN) socket.close()
    expect(outcome).toBe(1009)
  })

  it('rejects Web RPC responses larger than the response byte budget', async () => {
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      rpc: {
        channels: () => ['projects:list'],
        invoke: vi.fn().mockResolvedValue('x'.repeat(16 * 1024 * 1024))
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

    const response = await fetch(`http://127.0.0.1:${server.port}/rpc/projects%3Alist`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      protocolVersion: WEB_RPC_PROTOCOL_VERSION,
      ok: false,
      error: {
        code: 'handler_error',
        message: 'RPC response exceeds the 16 MiB byte budget.'
      }
    })
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

  it('bounds retained caller leases when one principal rotates HTTP client nonces', async () => {
    const callerSignals: AbortSignal[] = []
    const remoteInvoke = vi.fn(async (_channel, invocation) => {
      callerSignals.push(invocation.callerLease.signal)
      return []
    })
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'local-token',
      staticRoot: '/unused',
      rpc: {
        channels: () => ['projects:list'],
        invoke: vi.fn(),
        dispose: vi.fn()
      },
      applicationCommands: {
        localWeb: { commandNames: () => [], invoke: vi.fn() },
        remoteWeb: {
          commandNames: () => ['projects:list'],
          rejectedCommandNames: () => [],
          invoke: remoteInvoke
        }
      },
      externalAccess: {
        authorizeHttp: vi.fn().mockResolvedValue(accessOnlyExternalAccess('shared-principal')),
        authorizeWebSocket: vi.fn().mockResolvedValue(undefined)
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

    const responses: Response[] = []
    for (let index = 0; index < 65; index += 1) {
      responses.push(
        await fetch(`http://127.0.0.1:${server.port}/rpc/projects%3Alist`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-open-science-client': `rotated-client-${index}`
          },
          body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
        })
      )
    }

    expect(responses.every((response) => response.status === 200)).toBe(true)
    expect(callerSignals).toHaveLength(65)
    expect(callerSignals.some((signal) => signal.aborted)).toBe(true)
  })

  it('rejects malformed or repeated HTTP client nonces before invoking a command', async () => {
    const invoke = vi.fn().mockResolvedValue([])
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      rpc: { channels: () => ['projects:list'], invoke },
      bootstrap: {
        appName: 'Open Science',
        appVersion: '0.0.0',
        configRoot: '/fake/root',
        platform: 'test',
        versions: { electron: '1', chrome: '1', node: '1' }
      }
    })
    servers.push(server)
    const body = JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
    const postWithClientHeader = (clientHeader: string | string[]): Promise<number> =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          {
            host: '127.0.0.1',
            port: server.port,
            path: '/rpc/projects%3Alist',
            method: 'POST',
            headers: {
              authorization: 'Bearer test-token',
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(body)),
              'x-open-science-client': clientHeader
            }
          },
          (response) => {
            response.resume()
            response.once('end', () => resolve(response.statusCode ?? 0))
          }
        )
        request.once('error', reject)
        request.end(body)
      })

    expect(
      await Promise.all([
        postWithClientHeader('x'.repeat(65)),
        postWithClientHeader('client with spaces'),
        postWithClientHeader(['first-client', 'second-client'])
      ])
    ).toEqual([400, 400, 400])
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects malformed WebSocket client nonces during the HTTP upgrade', async () => {
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      rpc: { channels: () => [], invoke: vi.fn() },
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
      const socket = new WebSocket(
        `ws://127.0.0.1:${server.port}/events?token=test-token&client=invalid%20client`
      )
      socket.once('open', () => {
        socket.close()
        reject(new Error('WebSocket with malformed client nonce opened.'))
      })
      socket.once('error', () => undefined)
      socket.once('unexpected-response', (_request, response) => {
        expect(response.statusCode).toBe(400)
        response.resume()
        resolve()
      })
    })
  })

  it('does not retain external socket metadata after client capacity rejects an upgrade', async () => {
    const close = vi.spyOn(WebSocket.prototype, 'close')
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'local-token',
      staticRoot: '/unused',
      webClientRetention: { maxClientsPerPrincipal: 1 },
      rpc: { channels: () => [], invoke: vi.fn() },
      externalAccess: {
        authorizeHttp: vi.fn().mockResolvedValue('denied'),
        authorizeWebSocket: vi.fn().mockResolvedValue({
          principalId: 'shared-principal',
          isCurrent: () => true
        })
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
    const retained = new WebSocket(`ws://127.0.0.1:${server.port}/events?client=retained-client`)
    await new Promise<void>((resolve) => retained.once('open', resolve))
    const rejected = new WebSocket(`ws://127.0.0.1:${server.port}/events?client=rejected-client`)

    await new Promise<void>((resolve) => {
      rejected.once('close', (code) => {
        expect(code).toBe(1013)
        resolve()
      })
    })
    const retainedClosed = new Promise<void>((resolve) => retained.once('close', () => resolve()))
    server.closeExternalConnections('shared-principal')
    await retainedClosed

    expect(
      close.mock.calls.filter(
        ([code, reason]) => code === 1008 && reason === 'Remote access revoked'
      )
    ).toHaveLength(1)
  })

  it('releases an HTTP-only caller when its connection closes during command execution', async () => {
    let markInvocationStarted: (() => void) | undefined
    const invocationStarted = new Promise<void>((resolve) => {
      markInvocationStarted = resolve
    })
    let finishInvocation: (() => void) | undefined
    const invocationGate = new Promise<void>((resolve) => {
      finishInvocation = resolve
    })
    let callerSignal: AbortSignal | undefined
    const directInvoke = vi.fn(async (_channel, invocation) => {
      callerSignal = invocation.callerLease.signal
      markInvocationStarted?.()
      await invocationGate
      return []
    })
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      rpc: { channels: () => ['projects:list'], invoke: vi.fn() },
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
    const request = httpRequest({
      host: '127.0.0.1',
      port: server.port,
      path: '/rpc/projects%3Alist',
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        'x-open-science-client': 'http-only-client'
      }
    })
    request.once('error', () => undefined)
    request.end(JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] }))
    await invocationStarted

    request.destroy()
    await vi.waitFor(() => expect(callerSignal?.aborted).toBe(true))
    finishInvocation?.()
  })

  it('releases an HTTP-only caller after its idle retention window', async () => {
    let callerSignal: AbortSignal | undefined
    const directInvoke = vi.fn(async (_channel, invocation) => {
      callerSignal = invocation.callerLease.signal
      return []
    })
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      webClientRetention: { httpIdleTtlMs: 20 },
      rpc: { channels: () => ['projects:list'], invoke: vi.fn() },
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

    const response = await fetch(`http://127.0.0.1:${server.port}/rpc/projects%3Alist`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        'x-open-science-client': 'http-only-client'
      },
      body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
    })

    expect(response.status).toBe(200)
    expect(callerSignal?.aborted).toBe(false)
    await vi.waitFor(() => expect(callerSignal?.aborted).toBe(true))
  })

  it('bounds close when an active HTTP request does not finish', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    let markInvocationStarted: (() => void) | undefined
    const invocationStarted = new Promise<void>((resolve) => {
      markInvocationStarted = resolve
    })
    let releaseInvocation: (() => void) | undefined
    const invocationGate = new Promise<void>((resolve) => {
      releaseInvocation = resolve
    })
    let callerSignal: AbortSignal | undefined
    const directInvoke = vi.fn(async (_channel, invocation) => {
      callerSignal = invocation.callerLease.signal
      markInvocationStarted?.()
      await invocationGate
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

    const request = httpRequest({
      host: '127.0.0.1',
      port: server.port,
      path: '/rpc/projects%3Alist',
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        connection: 'close',
        'content-type': 'application/json',
        'x-open-science-client': 'test-client'
      }
    })
    request.on('error', () => undefined)
    request.end(JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] }))
    await invocationStarted

    const closePromise = server.close()
    const closeOutcome = await Promise.race([
      closePromise.then(() => 'closed' as const),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 250))
    ])

    releaseInvocation?.()
    await closePromise
    request.destroy()
    servers.splice(servers.indexOf(server), 1)

    expect(closeOutcome).toBe('closed')
    expect(callerSignal?.aborted).toBe(true)
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
        authorizeWebSocket: vi.fn().mockResolvedValue({
          principalId: 'trusted-browser',
          isCurrent: () => true
        })
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
        clientId: 'trusted-browser:trusted-phone',
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
        clientId: 'one-time-session:one-time-phone',
        location: 'remote',
        authorities: []
      }),
      []
    )
  })

  it('rejects a remote HTTP request when authorization expires while authorization is pending', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    let markAuthorizationStarted: () => void = () => undefined
    const authorizationStarted = new Promise<void>((resolve) => {
      markAuthorizationStarted = resolve
    })
    let resolveAuthorization: (authorization: ExternalWebAccessAuthorization) => void = () =>
      undefined
    const authorization = new Promise<ExternalWebAccessAuthorization>((resolve) => {
      resolveAuthorization = resolve
    })
    let current = true
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
        authorizeHttp: vi.fn(() => {
          markAuthorizationStarted()
          return authorization
        }),
        authorizeWebSocket: vi.fn().mockResolvedValue(undefined)
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

    const response = fetch(`http://127.0.0.1:${server.port}/api/bootstrap`)
    await authorizationStarted
    current = false
    resolveAuthorization({
      kind: 'authorized-pairing-manager',
      principalId: 'trusted-browser',
      isCurrent: () => current
    })

    expect((await response).status).toBe(401)
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
        principalId: 'trusted-browser',
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
      subscribeProgress: () => () => undefined,
      listProjects: vi.fn(),
      createProject: vi.fn(),
      updateProject: vi.fn(),
      listSessions: vi.fn(),
      getSession: vi.fn(),
      startRun: vi.fn(async () => ({
        id: 'run-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        cwd: '/workspace/research',
        status: 'running' as const,
        startedAt: 1,
        artifacts: [],
        preferredComputeHostIds: []
      })),
      getRun: vi.fn(),
      cancelRun: vi.fn(),
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
        authorizeWebSocket: vi.fn().mockResolvedValue({
          principalId: 'trusted-browser',
          isCurrent: () => true
        })
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
    expect(await postAfterExpiringAuthorization('/api/v1/runs/run-1/cancel', {}, 3)).toBe(401)
    expect(tasks.cancelRun).not.toHaveBeenCalled()
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
    const authorizeHttp = vi.fn().mockResolvedValue(authorizedExternalAccess())
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
        authorizeHttp,
        authorizeWebSocket: vi.fn().mockResolvedValue({
          principalId: 'trusted-browser',
          isCurrent: () => true
        })
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
    const remoteBootstrapBody = await remoteBootstrap.json()
    expect(remoteBootstrapBody).toMatchObject({
      rpcChannels: [remotelyAvailableChannel],
      restrictedRpcChannels: localOnlyChannels
    })
    expect(remoteBootstrapBody).not.toHaveProperty('configRoot')

    const localBootstrap = await fetch(bootstrapUrl, {
      headers: { authorization: 'Bearer local-token' }
    })
    expect(localBootstrap.status).toBe(200)
    expect(await localBootstrap.json()).toMatchObject({
      configRoot: '/fake/root',
      rpcChannels,
      restrictedRpcChannels: []
    })

    authorizeHttp.mockRejectedValueOnce(
      new Error('EACCES: /Users/private/.open-science/remote-access.json')
    )
    const failedBootstrap = await fetch(bootstrapUrl)
    expect(failedBootstrap.status).toBe(500)
    expect(await failedBootstrap.json()).toEqual({ error: 'Internal server error' })

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
      'notebook:abort-code-cell',
      'notebook:append-code-cell',
      'notebook:begin-code-cell',
      'notebook:execute',
      'notebook:finish-code-cell',
      'notebook:reference',
      'notebook:inspect-namespace',
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
      'runtime:set-agent-environment-creation-enabled',
      'runtime:set-environment-enabled',
      'runtime:set-install-authorized',
      'runtime:unregister-interpreter'
    ])
    expect(
      runtimeChannels.filter((channel) => !localOnly(runtimeChannels).includes(channel))
    ).toEqual([
      'runtime:describe-usage',
      'runtime:get-agent-environment-creation-enabled',
      'runtime:get-enablement',
      'runtime:list-environments',
      'runtime:list-package-counts',
      'runtime:list-packages'
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
    expect(acpChannels).toHaveLength(19)
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
        authorizeWebSocket: vi.fn().mockResolvedValue({
          principalId: 'trusted-browser',
          isCurrent: () => true
        })
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
      webCallerLocation: string
    }
    expect(remoteBootstrapBody.webCallerLocation).toBe('remote')
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
      webCallerLocation: string
    }
    expect(localBootstrapBody.webCallerLocation).toBe('local')
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
        authorizeWebSocket: vi.fn().mockResolvedValue({
          principalId: 'trusted-browser',
          isCurrent: () => true
        })
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

  it('rejects an external WebSocket when authorization expires while the upgrade waits', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    let authorizationCurrent = true
    let resolveAuthorization:
      ((authorization: { principalId: string; isCurrent: () => boolean }) => void) | undefined
    let markAuthorizationStarted: (() => void) | undefined
    const authorizationStarted = new Promise<void>((resolve) => {
      markAuthorizationStarted = resolve
    })
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
        authorizeWebSocket: vi.fn(
          () =>
            new Promise<{ principalId: string; isCurrent: () => boolean }>((resolve) => {
              resolveAuthorization = resolve
              markAuthorizationStarted?.()
            })
        )
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
    const outcome = new Promise<'opened' | 'rejected'>((resolve) => {
      socket.once('open', () => resolve('opened'))
      socket.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve('rejected')
      })
      socket.once('error', () => resolve('rejected'))
    })

    await authorizationStarted
    authorizationCurrent = false
    resolveAuthorization?.({
      principalId: 'temporary-browser',
      isCurrent: () => authorizationCurrent
    })

    await expect(outcome).resolves.toBe('rejected')
    socket.terminate()
  })

  it('closes an expired external WebSocket before replaying retained task events', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
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
        authorizeWebSocket: vi.fn().mockResolvedValue({
          principalId: 'temporary-browser',
          isCurrent
        })
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
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/events?eventProtocol=1`, {
      headers: { origin: `http://127.0.0.1:${server.port}` }
    })
    const outcome = new Promise<'closed' | 'event-leaked'>((resolve) => {
      socket.once('close', () => resolve('closed'))
      socket.once('message', () => resolve('event-leaked'))
    })

    await expect(outcome).resolves.toBe('closed')
    expect(isCurrent).toHaveBeenCalledTimes(2)
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

  it('delivers the shutdown acknowledgement before closing an attached server', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'open-science-web-static-'))
    roots.push(staticRoot)
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html>')
    let shutdownClose: Promise<void> | undefined
    const onShutdownRequest = (): void => {
      shutdownClose = server.close()
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

    const originalEnd = ServerResponse.prototype.end
    ServerResponse.prototype.end = function (
      this: ServerResponse,
      ...args: unknown[]
    ): ServerResponse {
      setTimeout(() => Reflect.apply(originalEnd, this, args), 25)
      return this
    } as typeof ServerResponse.prototype.end
    let response: Response
    try {
      response = await fetch(`http://127.0.0.1:${server.port}/api/shutdown`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token' }
      })
    } finally {
      ServerResponse.prototype.end = originalEnd
    }

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(shutdownClose).toBeDefined())
    await shutdownClose
    servers.splice(servers.indexOf(server), 1)
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
        authorizeWebSocket: vi.fn().mockResolvedValue({
          principalId: 'trusted-browser',
          isCurrent: () => true
        })
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

  it('replays project and run POST responses for repeated idempotency keys', async () => {
    const createProject = vi.fn().mockResolvedValue({ id: 'project-1', name: 'Created' })
    let releaseStartRun: (() => void) | undefined
    const startRunGate = new Promise<void>((resolve) => {
      releaseStartRun = resolve
    })
    const startRun = vi.fn(async () => {
      await startRunGate
      return {
        id: 'run-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        cwd: '/workspace/research',
        status: 'running' as const,
        startedAt: 1,
        artifacts: [],
        preferredComputeHostIds: []
      }
    })
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      rpc: { channels: () => [], invoke: vi.fn() },
      tasks: {
        runWithCallerContext,
        subscribeProgress: vi.fn(() => vi.fn()),
        listProjects: vi.fn(),
        createProject,
        updateProject: vi.fn(),
        listSessions: vi.fn(),
        getSession: vi.fn(),
        startRun,
        getRun: vi.fn(),
        cancelRun: vi.fn(),
        listArtifacts: vi.fn(),
        acquireArtifact: vi.fn(),
        releaseArtifact: vi.fn()
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
    const post = async (path: string, key: string, body: unknown): Promise<unknown> => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
          'idempotency-key': key
        },
        body: JSON.stringify(body)
      })
      return response.json()
    }
    const postTwice = async (path: string, key: string, body: unknown): Promise<unknown[]> => {
      const responses: unknown[] = []
      for (let attempt = 0; attempt < 2; attempt += 1) {
        responses.push(await post(path, key, body))
      }
      return responses
    }

    const projectResponses = await postTwice('/api/v1/projects', 'create-project-1', {
      name: 'Created'
    })
    const conflictingProject = await fetch(`${base}/api/v1/projects`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        'idempotency-key': 'create-project-1'
      },
      body: JSON.stringify({ name: 'Different project' })
    })
    const runBody = {
      project: 'project-1',
      prompt: 'Research this.'
    }
    const firstRunResponse = post('/api/v1/runs', 'start-run-1', runBody)
    await vi.waitFor(() => expect(startRun).toHaveBeenCalledOnce())
    const secondRunResponse = post('/api/v1/runs', 'start-run-1', runBody)
    releaseStartRun?.()
    const runResponses = await Promise.all([firstRunResponse, secondRunResponse])

    expect(projectResponses[1]).toEqual(projectResponses[0])
    expect(conflictingProject.status).toBe(409)
    expect(await conflictingProject.json()).toEqual({
      error: {
        code: 'idempotency_conflict',
        message: 'Idempotency-Key was already used with a different request body.'
      }
    })
    expect(runResponses[1]).toEqual(runResponses[0])
    expect([createProject.mock.calls.length, startRun.mock.calls.length]).toEqual([1, 1])
  })

  it('keeps remote browser idempotency keys in separate authorized caller scopes', async () => {
    const createProject = vi
      .fn()
      .mockImplementation(async (request: { name: string }) => ({ id: request.name }))
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'local-token',
      staticRoot: '/unused',
      rpc: { channels: () => [], invoke: vi.fn() },
      tasks: {
        runWithCallerContext,
        subscribeProgress: vi.fn(() => vi.fn()),
        listProjects: vi.fn(),
        createProject,
        updateProject: vi.fn(),
        listSessions: vi.fn(),
        getSession: vi.fn(),
        startRun: vi.fn(),
        getRun: vi.fn(),
        cancelRun: vi.fn(),
        listArtifacts: vi.fn(),
        acquireArtifact: vi.fn(),
        releaseArtifact: vi.fn()
      },
      externalAccess: {
        authorizeHttp: vi.fn().mockResolvedValue(accessOnlyExternalAccess()),
        authorizeWebSocket: vi.fn().mockResolvedValue({
          principalId: 'trusted-browser',
          isCurrent: () => true
        })
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

    const createFromBrowser = (clientId: string, name: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${server.port}/api/v1/projects`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'create-project',
          'x-open-science-client': clientId
        },
        body: JSON.stringify({ name })
      })

    const first = await createFromBrowser('browser-a', 'First project')
    const second = await createFromBrowser('browser-b', 'Second project')

    expect([first.status, second.status]).toEqual([201, 201])
    expect(createProject).toHaveBeenCalledTimes(2)
  })

  it('applies idempotency capacity to the authorized principal across rotated clients', async () => {
    const createProject = vi
      .fn()
      .mockImplementation(async (request: { name: string }) => ({ id: request.name }))
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'local-token',
      staticRoot: '/unused',
      rpc: { channels: () => [], invoke: vi.fn() },
      tasks: {
        runWithCallerContext,
        subscribeProgress: vi.fn(() => vi.fn()),
        listProjects: vi.fn(),
        createProject,
        updateProject: vi.fn(),
        listSessions: vi.fn(),
        getSession: vi.fn(),
        startRun: vi.fn(),
        getRun: vi.fn(),
        cancelRun: vi.fn(),
        listArtifacts: vi.fn(),
        acquireArtifact: vi.fn(),
        releaseArtifact: vi.fn()
      },
      externalAccess: {
        authorizeHttp: vi.fn(async (request: IncomingMessage) =>
          accessOnlyExternalAccess(String(request.headers['x-test-principal']))
        ),
        authorizeWebSocket: vi.fn().mockResolvedValue(undefined)
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

    const create = (principal: string, client: string, index: number): Promise<Response> =>
      fetch(`http://127.0.0.1:${server.port}/api/v1/projects`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `create-project-${index}`,
          'x-open-science-client': client,
          'x-test-principal': principal
        },
        body: JSON.stringify({ name: `${principal}-${index}` })
      })

    for (let index = 0; index < 128; index += 1) {
      expect((await create('principal-a', `rotated-${index}`, index)).status).toBe(201)
    }
    const limited = await create('principal-a', 'rotated-128', 128)
    const otherPrincipal = await create('principal-b', 'client-1', 1)

    expect(limited.status).toBe(503)
    expect(await limited.json()).toMatchObject({ error: { code: 'idempotency_unavailable' } })
    expect(otherPrincipal.status).toBe(201)
  })

  it('keeps bootstrap available while Task API requests wait for journal restoration', async () => {
    let releaseTasks: (() => void) | undefined
    const taskReadiness = new Promise<void>((resolve) => {
      releaseTasks = resolve
    })
    let markRunLookup: (() => void) | undefined
    const runLookup = new Promise<void>((resolve) => {
      markRunLookup = resolve
    })
    const getRun = vi.fn(() => {
      markRunLookup?.()
      return {
        id: 'run-restored',
        sessionId: 'session-restored',
        projectId: 'project-restored',
        cwd: '/workspace/research',
        status: 'failed' as const,
        startedAt: 1,
        completedAt: 2,
        artifacts: [],
        preferredComputeHostIds: []
      }
    })
    const server = await startTestWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: '/unused',
      rpc: { channels: () => [], invoke: vi.fn() },
      waitUntilTasksReady: () => taskReadiness,
      tasks: {
        runWithCallerContext,
        subscribeProgress: () => () => undefined,
        getRun
      } as never,
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

    const taskRequest = fetch(`${base}/api/v1/runs/run-restored`, { headers })
    try {
      await expect(
        Promise.race([
          runLookup.then(() => 'looked-up'),
          new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 100))
        ])
      ).resolves.toBe('waiting')
      expect(getRun).not.toHaveBeenCalled()

      const bootstrap = await fetch(`${base}/api/bootstrap`, { headers })
      expect(bootstrap.status).toBe(200)
    } finally {
      releaseTasks?.()
    }

    expect((await taskRequest).status).toBe(200)
    expect(getRun).toHaveBeenCalledOnce()
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
    let publishProgress:
      ((event: import('../../shared/task-api').TaskRunProgressEvent) => void) | undefined
    const tasks = {
      runWithCallerContext: runWithCapturedCallerContext,
      subscribeProgress: vi.fn((listener) => {
        publishProgress = listener
        return () => {
          publishProgress = undefined
        }
      }),
      listProjects: vi
        .fn()
        .mockResolvedValue([{ id: 'project-1', name: 'Research', hasAgentContext: false }]),
      createProject: vi
        .fn()
        .mockResolvedValue({ id: 'project-2', name: 'Created', hasAgentContext: true }),
      updateProject: vi
        .fn()
        .mockResolvedValue({ id: 'project-1', name: 'Research', hasAgentContext: true }),
      getProjectSessionDefaults: vi.fn().mockResolvedValue({
        projectId: 'project/1',
        updatedAt: 7,
        configured: {}
      }),
      updateProjectSessionDefaults: vi.fn().mockResolvedValue({
        projectId: 'project/1',
        updatedAt: 8,
        configured: { memoryEnabled: false }
      }),
      listSessions: vi.fn().mockResolvedValue([{ id: 'session/1', title: 'Review' }]),
      getSession: vi.fn().mockResolvedValue({ id: 'session/1', title: 'Review' }),
      getSessionConfiguration: vi.fn().mockResolvedValue({
        sessionId: 'session/1',
        revision: 3,
        persisted: { computeHosts: { enabled: [], selected: [] } }
      }),
      updateSessionConfiguration: vi.fn().mockResolvedValue({
        sessionId: 'session/1',
        revision: 4,
        persisted: { memoryEnabled: false, computeHosts: { enabled: [], selected: [] } }
      }),
      getAgentRouting: vi.fn().mockResolvedValue({
        configured: { framework: 'claude-code' }
      }),
      updateAgentRouting: vi.fn().mockResolvedValue({
        configured: { framework: 'codex' }
      }),
      getSessionPlan: vi.fn().mockResolvedValue({
        artifactVersionId: 'plan-version',
        revision: 2,
        lifecycle: 'awaiting_approval'
      }),
      respondSessionPlan: vi.fn().mockResolvedValue({ changed: true }),
      startRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        cwd: '/workspace/research',
        status: 'running',
        startedAt: 1,
        artifacts: []
      }),
      getRun: vi.fn().mockReturnValue({
        id: 'run-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        cwd: '/workspace/research',
        status: 'completed',
        startedAt: 1,
        completedAt: 2,
        output: 'Done',
        artifacts: []
      }),
      cancelRun: vi.fn().mockResolvedValue({
        id: 'run/1',
        sessionId: 'session-1',
        projectId: 'project-1',
        cwd: '/workspace/research',
        status: 'cancelled',
        startedAt: 1,
        cancelRequestedAt: 2,
        cancelledAt: 3,
        completedAt: 3,
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

    const progressSocket = new WebSocket(
      `${base.replace('http:', 'ws:')}/api/v1/events?token=test-token`
    )
    await new Promise<void>((resolve) => progressSocket.once('open', resolve))
    const progressMessage = new Promise<unknown>((resolve) =>
      progressSocket.once('message', (data) => resolve(JSON.parse(data.toString())))
    )
    publishProgress?.({
      runId: 'run-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      phase: 'provider-accepted',
      timestamp: 250,
      elapsedMs: 249,
      heartbeat: false
    })
    await expect(progressMessage).resolves.toEqual({
      sequence: 1,
      runId: 'run-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      type: 'run.progress',
      data: {
        runId: 'run-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        phase: 'provider-accepted',
        timestamp: 250,
        elapsedMs: 249,
        heartbeat: false
      }
    })
    progressSocket.close()

    const projects = await fetch(`${base}/api/v1/projects`, { headers })
    expect(projects.status).toBe(200)
    expect(projects.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(projects.headers.get('cache-control')).toBe('no-store')
    expect(await projects.json()).toEqual({
      data: [{ id: 'project-1', name: 'Research', hasAgentContext: false }]
    })
    expect(taskContexts[0]).toMatchObject({
      surface: 'task',
      location: 'local',
      principalKind: 'automation',
      actionOrigin: 'automation'
    })

    const created = await fetch(`${base}/api/v1/projects`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Created',
        description: 'A new project',
        agentContext: 'Always cite sources.'
      })
    })
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({
      data: { id: 'project-2', name: 'Created', hasAgentContext: true }
    })
    expect(tasks.createProject).toHaveBeenCalledWith({
      name: 'Created',
      description: 'A new project',
      agentContext: 'Always cite sources.'
    })

    const updated = await fetch(`${base}/api/v1/projects/project%2F1`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedUpdatedAt: 7, agentContext: 'Prefer Python.' })
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toEqual({
      data: { id: 'project-1', name: 'Research', hasAgentContext: true }
    })
    expect(tasks.updateProject).toHaveBeenCalledWith('project/1', {
      expectedUpdatedAt: 7,
      agentContext: 'Prefer Python.'
    })

    const projectDefaults = await fetch(`${base}/api/v1/projects/project%2F1/session-defaults`, {
      headers
    })
    expect(await projectDefaults.json()).toMatchObject({ data: { updatedAt: 7 } })
    const updatedProjectDefaults = await fetch(
      `${base}/api/v1/projects/project%2F1/session-defaults`,
      {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedUpdatedAt: 7,
          patch: { memoryEnabled: false }
        })
      }
    )
    expect(await updatedProjectDefaults.json()).toMatchObject({ data: { updatedAt: 8 } })
    expect(tasks.updateProjectSessionDefaults).toHaveBeenCalledWith('project/1', {
      expectedUpdatedAt: 7,
      patch: { memoryEnabled: false }
    })

    const sessions = await fetch(`${base}/api/v1/sessions?project=project-1`, {
      headers
    })
    expect(await sessions.json()).toEqual({ data: [{ id: 'session/1', title: 'Review' }] })
    expect(tasks.listSessions).toHaveBeenCalledWith('project-1')

    const session = await fetch(`${base}/api/v1/sessions/session%2F1`, { headers })
    expect(await session.json()).toEqual({ data: { id: 'session/1', title: 'Review' } })
    expect(tasks.getSession).toHaveBeenCalledWith('session/1')

    const sessionConfiguration = await fetch(`${base}/api/v1/sessions/session%2F1/config`, {
      headers
    })
    expect(await sessionConfiguration.json()).toMatchObject({ data: { revision: 3 } })
    const updatedSessionConfiguration = await fetch(`${base}/api/v1/sessions/session%2F1/config`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 3, memoryEnabled: false })
    })
    expect(await updatedSessionConfiguration.json()).toMatchObject({ data: { revision: 4 } })
    expect(tasks.updateSessionConfiguration).toHaveBeenCalledWith('session/1', {
      expectedRevision: 3,
      memoryEnabled: false
    })

    const agentRouting = await fetch(`${base}/api/v1/settings/agent-routing`, { headers })
    expect(await agentRouting.json()).toMatchObject({
      data: { configured: { framework: 'claude-code' } }
    })
    const updatedAgentRouting = await fetch(`${base}/api/v1/settings/agent-routing`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ framework: 'codex' })
    })
    expect(await updatedAgentRouting.json()).toMatchObject({
      data: { configured: { framework: 'codex' } }
    })
    expect(tasks.updateAgentRouting).toHaveBeenCalledWith({ framework: 'codex' })

    const plan = await fetch(`${base}/api/v1/sessions/session%2F1/plan`, { headers })
    expect(await plan.json()).toEqual({
      data: {
        artifactVersionId: 'plan-version',
        revision: 2,
        lifecycle: 'awaiting_approval'
      }
    })
    expect(tasks.getSessionPlan).toHaveBeenCalledWith('session/1')

    const approvedPlan = await fetch(`${base}/api/v1/sessions/session%2F1/plan/respond`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: 'approved',
        artifactVersionId: 'plan-version',
        expectedRevision: 2
      })
    })
    expect(await approvedPlan.json()).toEqual({ data: { changed: true } })
    expect(tasks.respondSessionPlan).toHaveBeenCalledWith('session/1', {
      decision: 'approved',
      artifactVersionId: 'plan-version',
      expectedRevision: 2
    })

    tasks.respondSessionPlan.mockClear()
    for (const invalidResponse of [
      null,
      {},
      { feedback: '   ' },
      { feedback: 'revise', decision: 'rejected' },
      { decision: 'maybe', artifactVersionId: 'plan-version', expectedRevision: 2 },
      { decision: 'approved', artifactVersionId: '', expectedRevision: 2 },
      { decision: 'approved', artifactVersionId: 'plan-version', expectedRevision: -1 },
      { decision: 'approved', artifactVersionId: 'plan-version', expectedRevision: 1.5 }
    ]) {
      const invalidPlanResponse = await fetch(`${base}/api/v1/sessions/session%2F1/plan/respond`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(invalidResponse)
      })
      expect(invalidPlanResponse.status).toBe(400)
      expect(await invalidPlanResponse.json()).toMatchObject({
        error: { code: 'invalid_request' }
      })
    }
    expect(tasks.respondSessionPlan).not.toHaveBeenCalled()

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
        cwd: '/workspace/research',
        permissionProfile: 'auto'
      })
    })
    expect(started.status).toBe(202)
    expect(await started.json()).toMatchObject({
      data: {
        id: 'run-1',
        cwd: '/workspace/research',
        status: 'running'
      }
    })
    expect(tasks.startRun).toHaveBeenCalledWith({
      project: 'project-1',
      prompt: 'Research this.',
      cwd: '/workspace/research',
      permissionProfile: 'auto'
    })

    const status = await fetch(`${base}/api/v1/runs/run-1`, { headers })
    expect(await status.json()).toMatchObject({ data: { status: 'completed', output: 'Done' } })

    const cancelled = await fetch(`${base}/api/v1/runs/run%2F1/cancel`, {
      method: 'POST',
      headers
    })
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toMatchObject({
      data: { id: 'run/1', status: 'cancelled', cancelRequestedAt: 2, cancelledAt: 3 }
    })
    expect(tasks.cancelRun).toHaveBeenCalledWith('run/1')

    tasks.cancelRun.mockRejectedValueOnce(
      new TaskApiError('run_not_found', 'Run not found: missing')
    )
    const missingRun = await fetch(`${base}/api/v1/runs/missing/cancel`, {
      method: 'POST',
      headers
    })
    expect(missingRun.status).toBe(404)
    expect(await missingRun.json()).toEqual({
      error: { code: 'run_not_found', message: 'Run not found: missing' }
    })

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

    for (const [code, message] of [
      ['session_archived', 'Restore this archived Session before continuing.'],
      ['project_archived', 'Restore this archived Project before continuing.']
    ] as const) {
      tasks.startRun.mockRejectedValueOnce(new TaskApiError(code, message))
      const archived = await fetch(`${base}/api/v1/runs`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ project: 'project-1', sessionId: 'session-1', prompt: 'Again' })
      })
      expect(archived.status).toBe(409)
      expect(await archived.json()).toEqual({ error: { code, message } })
    }

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

    tasks.startRun.mockRejectedValueOnce(
      new Error('SQLITE_CANTOPEN: /Users/private/.open-science/open-science.db')
    )
    const internalError = await fetch(`${base}/api/v1/runs`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'project-1', prompt: 'Research this.' })
    })
    expect(internalError.status).toBe(500)
    expect(await internalError.json()).toEqual({
      error: { code: 'internal_error', message: 'Internal server error' }
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
      '/api/v1/compute',
      '/api/v1/settings',
      '/api/v1/providers',
      '/api/v1/runtime',
      '/api/v1/notebook',
      '/api/v1/reviewer'
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
      subscribeProgress: () => () => undefined,
      listProjects: vi.fn(),
      createProject: vi.fn(),
      updateProject: vi.fn(),
      listSessions: vi.fn(),
      getSession: vi.fn(),
      startRun: vi.fn(),
      getRun: vi.fn(),
      cancelRun: vi.fn(),
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
      subscribeProgress: () => () => undefined,
      listProjects: vi.fn(),
      createProject: vi.fn(),
      updateProject: vi.fn(),
      listSessions: vi.fn(),
      getSession: vi.fn(),
      startRun: vi.fn(),
      getRun: vi.fn(),
      cancelRun: vi.fn(),
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
