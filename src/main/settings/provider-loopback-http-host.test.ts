import { connect } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Logger } from '../logger'
import { ProviderLoopbackHttpHost, writeProviderLoopbackJson } from './provider-loopback-http-host'

type Connection = Readonly<{ baseUrl: string; token: string }>

const jsonHost = (
  credentialMode: 'bearer' | 'bearer-or-api-key' = 'bearer',
  diagnostics: Pick<Logger, 'info' | 'error'> = { info: vi.fn(), error: vi.fn() }
): ProviderLoopbackHttpHost<Connection> =>
  new ProviderLoopbackHttpHost<Connection>({
    diagnosticName: 'test-provider',
    diagnostics,
    credentialMode,
    createConnection: (origin, token) => Object.freeze({ baseUrl: origin, token }),
    onUnauthorized: (response) =>
      writeProviderLoopbackJson(response, 401, { error: 'unauthorized' }),
    onError: (error, response) =>
      writeProviderLoopbackJson(response, 400, {
        error: error instanceof Error ? error.message : String(error)
      }),
    handle: async (request, response) => {
      if (request.method !== 'POST' || request.path !== '/echo') {
        writeProviderLoopbackJson(response, 404, { error: 'not found' })
        return
      }
      writeProviderLoopbackJson(response, 200, await request.readJsonObject())
    }
  })

describe('ProviderLoopbackHttpHost', () => {
  const hosts: ProviderLoopbackHttpHost<Connection>[] = []

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()))
  })

  it('starts once for concurrent callers and publishes a token-authenticated loopback origin', async () => {
    const host = jsonHost()
    hosts.push(host)

    const firstStart = host.start()
    const secondStart = host.start()
    expect(secondStart).toBe(firstStart)

    const [first, second] = await Promise.all([firstStart, secondStart])
    expect(second).toBe(first)
    expect(new URL(first.baseUrl).hostname).toBe('127.0.0.1')
    expect(first.token).toMatch(/^[a-f0-9]{48}$/)

    const response = await fetch(`${first.baseUrl}/echo`, {
      method: 'POST',
      headers: { authorization: `Bearer ${first.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true })
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('closes once for concurrent callers and restarts with a fresh credential', async () => {
    const host = jsonHost()
    hosts.push(host)
    const firstConnection = await host.start()

    const firstClose = host.close()
    const secondClose = host.close()
    expect(secondClose).toBe(firstClose)
    await Promise.all([firstClose, secondClose])

    const secondConnection = await host.start()
    expect(secondConnection.token).not.toBe(firstConnection.token)
  })

  it('records the loopback listener lifecycle without exposing its credential', async () => {
    const diagnostics = { info: vi.fn(), error: vi.fn() }
    const host = jsonHost('bearer', diagnostics)
    hosts.push(host)

    const connection = await host.start()
    const port = Number(new URL(connection.baseUrl).port)
    expect(diagnostics.info).toHaveBeenCalledWith('provider loopback listening', {
      bridge: 'test-provider',
      bridgeId: expect.any(String),
      port
    })
    const listeningData = diagnostics.info.mock.calls[0][1]

    await host.close()
    expect(diagnostics.info).toHaveBeenCalledWith('provider loopback closed', {
      bridge: 'test-provider',
      bridgeId: (listeningData as { bridgeId: string }).bridgeId,
      port,
      expected: true,
      lifetimeMs: expect.any(Number)
    })
    expect(JSON.stringify(diagnostics.info.mock.calls)).not.toContain(connection.token)
  })

  it('authenticates before routing and preserves each adapter credential mode', async () => {
    const bearer = jsonHost()
    const bearerOrApiKey = jsonHost('bearer-or-api-key')
    hosts.push(bearer, bearerOrApiKey)
    const bearerConnection = await bearer.start()
    const dualConnection = await bearerOrApiKey.start()

    const hiddenRoute = await fetch(`${bearerConnection.baseUrl}/missing`, { method: 'POST' })
    expect(hiddenRoute.status).toBe(401)

    const rejectedApiKey = await fetch(`${bearerConnection.baseUrl}/echo`, {
      method: 'POST',
      headers: { 'x-api-key': bearerConnection.token, 'content-type': 'application/json' },
      body: '{}'
    })
    expect(rejectedApiKey.status).toBe(401)

    const acceptedApiKey = await fetch(`${dualConnection.baseUrl}/echo`, {
      method: 'POST',
      headers: { 'x-api-key': dualConnection.token, 'content-type': 'application/json' },
      body: '{}'
    })
    expect(acceptedApiKey.status).toBe(200)
  })

  it('rejects an oversized declared body and closes the authenticated keep-alive connection', async () => {
    const host = jsonHost()
    hosts.push(host)
    const connection = await host.start()
    const endpoint = new URL(`${connection.baseUrl}/echo`)
    const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) })
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('error', () => undefined)
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    const closed = new Promise<string>((resolve) =>
      socket.once('close', () => resolve(Buffer.concat(chunks).toString()))
    )

    socket.write(
      [
        'POST /echo HTTP/1.1',
        `Host: ${endpoint.host}`,
        `Authorization: Bearer ${connection.token}`,
        'Content-Type: application/json',
        'Content-Length: 67108865',
        'Connection: keep-alive',
        '',
        ''
      ].join('\r\n')
    )

    const response = await Promise.race([
      closed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('oversized request connection stayed open')), 1_000)
      )
    ])
    expect(response).toContain('HTTP/1.1 400')
    expect(response.toLowerCase()).toContain('connection: close')
    expect(response).toContain('64 MiB')
  })

  it('aborts the adapter signal when the client disconnects', async () => {
    let markStarted: (() => void) | undefined
    let markAborted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve
    })
    const host = new ProviderLoopbackHttpHost<Connection>({
      diagnosticName: 'test-provider',
      diagnostics: { info: vi.fn(), error: vi.fn() },
      credentialMode: 'bearer',
      createConnection: (origin, token) => Object.freeze({ baseUrl: origin, token }),
      onUnauthorized: (response) => writeProviderLoopbackJson(response, 401, {}),
      onError: vi.fn(),
      handle: async (request) => {
        markStarted?.()
        await new Promise<void>((resolve) => {
          request.signal.addEventListener(
            'abort',
            () => {
              markAborted?.()
              resolve()
            },
            { once: true }
          )
        })
      }
    })
    hosts.push(host)
    const connection = await host.start()
    const endpoint = new URL(connection.baseUrl)
    const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) })
    socket.on('error', () => undefined)
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    socket.write(
      [
        'POST /echo HTTP/1.1',
        `Host: ${endpoint.host}`,
        `Authorization: Bearer ${connection.token}`,
        'Content-Type: application/json',
        'Content-Length: 2',
        '',
        '{}'
      ].join('\r\n')
    )
    await started
    socket.destroy()

    await expect(aborted).resolves.toBeUndefined()
  })

  it('closes promptly while an authenticated client leaves its request body incomplete', async () => {
    const host = jsonHost()
    hosts.push(host)
    const connection = await host.start()
    const endpoint = new URL(connection.baseUrl)
    const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) })
    socket.on('error', () => undefined)
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    socket.write(
      [
        'POST /echo HTTP/1.1',
        `Host: ${endpoint.host}`,
        `Authorization: Bearer ${connection.token}`,
        'Content-Type: application/json',
        'Content-Length: 100',
        '',
        '{'
      ].join('\r\n')
    )

    await expect(
      Promise.race([
        host.close(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('loopback host close timed out')), 1_000)
        )
      ])
    ).resolves.toBeUndefined()
    socket.destroy()
  })
})
