import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  fetchLocalRpc,
  fetchLongLivedLocalRpc,
  listenForLocalRpc,
  localRpcServerLogFields
} from './local-rpc-transport'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
})

describe('local RPC transport', () => {
  it('posts JSON through a local socket without loopback TCP', async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ path: request.url, authorized: request.headers.authorization }))
    })
    servers.push(server)
    const connection = await listenForLocalRpc(server, {
      name: 'transport-test',
      transport: 'pipe'
    })

    expect(connection.socketPath).toBeTruthy()
    expect(localRpcServerLogFields(server)).toEqual({
      transport: 'pipe',
      listening: true,
      socketPath: connection.socketPath
    })
    const response = await fetchLocalRpc(
      { ...connection, endpoint: `${connection.endpoint}/rpc` },
      {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'state' })
      },
      'Test RPC'
    )

    await expect(response.json()).resolves.toEqual({
      path: '/rpc',
      authorized: 'Bearer test-token'
    })
  })

  it('reports the bound TCP host, port, and listening state', async () => {
    const server = createServer()
    servers.push(server)
    await listenForLocalRpc(server, { name: 'transport-test', transport: 'tcp' })

    expect(localRpcServerLogFields(server)).toMatchObject({
      transport: 'tcp',
      listening: true,
      host: '127.0.0.1',
      port: expect.any(Number)
    })
  })

  it('waits for a long-lived TCP response without inheriting the global fetch timeout policy', async () => {
    let releaseResponse: (() => void) | undefined
    const requestReceived = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    let finishResponse: (() => void) | undefined
    const server = createServer((_request, response) => {
      releaseResponse?.()
      finishResponse = () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ result: 'approved' }))
      }
    })
    servers.push(server)
    const connection = await listenForLocalRpc(server, {
      name: 'long-lived-transport-test',
      transport: 'tcp'
    })
    const globalFetch = vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('Headers Timeout Error'), {
          code: 'UND_ERR_HEADERS_TIMEOUT'
        })
      })
    })
    vi.stubGlobal('fetch', globalFetch)

    try {
      const responsePromise = fetchLongLivedLocalRpc(
        { ...connection, endpoint: `${connection.endpoint}/plan` },
        { method: 'POST', body: '{}' },
        'Session Plan RPC'
      )

      await requestReceived
      expect(globalFetch).not.toHaveBeenCalled()
      finishResponse?.()
      const response = await responsePromise
      await expect(response.json()).resolves.toEqual({ result: 'approved' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('settles a long-lived request when its owner aborts', async () => {
    let backendRequestAborted = false
    let backendRequestReceived = false
    const server = createServer((request) => {
      backendRequestReceived = true
      request.once('aborted', () => {
        backendRequestAborted = true
      })
    })
    servers.push(server)
    const connection = await listenForLocalRpc(server, {
      name: 'long-lived-abort-test',
      transport: 'tcp'
    })
    const owner = new AbortController()
    const response = fetchLongLivedLocalRpc(
      { ...connection, endpoint: `${connection.endpoint}/plan` },
      { method: 'POST', body: '{}', signal: owner.signal },
      'Session Plan RPC'
    )

    await vi.waitFor(() => expect(backendRequestReceived).toBe(true))
    owner.abort(new Error('MCP connection closed'))

    await expect(response).rejects.toThrow(
      'Session Plan RPC transport failed: MCP connection closed'
    )
    await vi.waitFor(() => expect(backendRequestAborted).toBe(true))
  })

  it('settles a long-lived request when the local RPC connection closes', async () => {
    const server = createServer((request) => {
      request.socket.destroy()
    })
    servers.push(server)
    const connection = await listenForLocalRpc(server, {
      name: 'long-lived-disconnect-test',
      transport: 'tcp'
    })

    await expect(
      fetchLongLivedLocalRpc(
        { ...connection, endpoint: `${connection.endpoint}/plan` },
        { method: 'POST', body: '{}' },
        'Session Plan RPC'
      )
    ).rejects.toThrow(/Session Plan RPC transport failed:.*(?:ECONNRESET|socket hang up)/i)
  })

  it('keeps the underlying socket error in the diagnostic', async () => {
    await expect(
      fetchLocalRpc(
        { endpoint: 'http://localhost', socketPath: '/missing/open-science.sock' },
        { method: 'POST' },
        'Notebook RPC'
      )
    ).rejects.toThrow(/Notebook RPC transport failed:.*ENOENT/i)
  })
})
