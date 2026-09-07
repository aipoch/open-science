import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { fetchLocalRpc } from '../local-rpc-transport'
import { NotebookLocalRpcServer } from './local-rpc-server'
import type { NotebookRpcConnection } from './mcp-server'

let server: NotebookLocalRpcServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

const call = (connection: NotebookRpcConnection, body: unknown): Promise<Response> =>
  fetchLocalRpc(
    connection,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    },
    'Notebook RPC error contract'
  )

describe.each(['tcp', 'pipe'] as const)('Notebook RPC error status over %s', (transport) => {
  it.each(
    [null, [], {}, { method: 42 }, { method: 'state', params: [] }].map((body) => ({ body }))
  )('rejects malformed request envelopes: $body', async ({ body }) => {
    const state = vi.fn()
    server = new NotebookLocalRpcServer({ state } as never, { transport })
    const connection = await server.ensureStarted()

    expect((await call(connection, body)).status).toBe(400)
    expect(state).not.toHaveBeenCalled()
  })

  it('rejects unknown methods independently of runtime params and capability scope', async () => {
    server = new NotebookLocalRpcServer({} as never, { transport })
    const connections = [
      await server.ensureStarted(),
      await server.issueSessionConnection('session', 'project', 'root-frame-session'),
      await server.issueControlConnection('session', 'project', 'root-frame-session')
    ]
    for (const connection of connections) {
      const response = await call(connection, { method: 'unknown' })
      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toEqual({
        error: 'Unknown notebook RPC method: unknown'
      })
    }
  })

  it('reports input-schema failures as 400 before calling the Memory owner', async () => {
    const searchForAgent = vi.fn()
    server = new NotebookLocalRpcServer({} as never, {
      transport,
      memoryService: {
        searchForAgent,
        listCategoriesForAgent: vi.fn(),
        rememberForAgent: vi.fn()
      }
    })
    const connection = await server.issueControlConnection(
      'session',
      'project',
      'root-frame-session'
    )
    const response = await call(connection, { method: 'memorySearch', params: { query: 42 } })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('query')
    })
    expect(searchForAgent).not.toHaveBeenCalled()
  })

  it('reports an unowned Notebook input lease as 403', async () => {
    server = new NotebookLocalRpcServer({} as never, { transport })
    const connection = await server.issueSessionConnection(
      'session',
      'project',
      'root-frame-session'
    )
    const response = await call(connection, {
      method: 'resolveNotebookInput',
      params: {
        inputRunLeaseId: 'stale-lease',
        sourceKind: 'upload-version',
        inputFileVersionId: 'version'
      }
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: 'Notebook input resolution requires an active run lease.'
    })
  })

  it.each([
    new Error('owner failed'),
    new SyntaxError('internal JSON failed'),
    z.string().safeParse(42).error!
  ])('keeps unexpected owner errors at 500: %s', async (error) => {
    const state = vi.fn().mockRejectedValue(error)
    server = new NotebookLocalRpcServer({ state } as never, { transport })
    const connection = await server.ensureStarted()
    const response = await call(connection, {
      method: 'state',
      params: { sessionId: 'session', workspaceCwd: process.cwd() }
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: error.message })
    expect(state).toHaveBeenCalledOnce()
  })
})
