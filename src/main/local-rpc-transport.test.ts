import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import { fetchLocalRpc, listenForLocalRpc } from './local-rpc-transport'

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
