import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotebookLocalRpcServer } from './local-rpc-server'

type RpcConnection = { endpoint: string; token: string; release?: () => void }

const callLineage = async (
  connection: RpcConnection,
  token: string,
  params: Record<string, unknown>
): Promise<{ response: Response; payload: Record<string, unknown> }> => {
  const response = await fetch(connection.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'lineageCall', params })
  })
  return { response, payload: (await response.json()) as Record<string, unknown> }
}

let server: NotebookLocalRpcServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('lineageCall RPC', () => {
  it('dispatches graph and get with only the control token Project scope', async () => {
    const graph = vi.fn(async () => ({ root_version_id: 'version-1' }))
    const get = vi.fn(async () => ({ version_id: 'version-1' }))
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostLineage: { graph, get } as never
    })
    const control = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    const graphed = await callLineage(control, control.token, {
      op: 'graph',
      version_id: 'version-1',
      options: { direction: 'down', max_depth: 2 }
    })
    expect(graphed).toMatchObject({
      response: { status: 200 },
      payload: { result: { root_version_id: 'version-1' } }
    })
    expect(graph).toHaveBeenCalledWith(
      'version-1',
      { direction: 'down', max_depth: 2 },
      { projectId: 'trusted-project', sessionId: 'trusted-session' }
    )

    const read = await callLineage(control, control.token, {
      op: 'get',
      version_id: 'version-1'
    })
    expect(read.payload).toEqual({ result: { version_id: 'version-1' } })
    expect(get).toHaveBeenCalledWith('version-1', {
      projectId: 'trusted-project',
      sessionId: 'trusted-session'
    })
  })

  it('rejects request-body scope fields, unknown fields, and unsupported operations', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostLineage: { graph: vi.fn(), get: vi.fn() }
    })
    const control = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    for (const forged of [
      { projectId: 'forged-project' },
      { sessionId: 'forged-session' },
      { project_id: 'forged-project' },
      { session_id: 'forged-session' },
      { include_all_projects: true }
    ]) {
      const attempt = await callLineage(control, control.token, {
        op: 'graph',
        version_id: 'version-1',
        options: {},
        ...forged
      })
      expect(attempt.response.status).toBe(400)
      expect(attempt.payload).toEqual({ error: 'host.lineage RPC params are invalid.' })
    }

    await expect(
      callLineage(control, control.token, { op: 'clear', version_id: 'version-1' })
    ).resolves.toMatchObject({
      response: { status: 400 },
      payload: { error: 'Unknown host.lineage operation.' }
    })
  })

  it('rejects bootstrap, invalid, ordinary Session, and released control capabilities', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostLineage: { graph: vi.fn(), get: vi.fn() }
    })
    const bootstrap = await server.ensureStarted()
    const ordinary = await server.issueSessionConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )
    const control = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )
    const params = { op: 'graph', version_id: 'version-1', options: {} }

    await expect(callLineage(control, bootstrap.token, params)).resolves.toMatchObject({
      response: { status: 401 },
      payload: { error: 'A session-bound notebook RPC token is required.' }
    })
    await expect(callLineage(control, 'invalid-token', params)).resolves.toMatchObject({
      response: { status: 401 },
      payload: { error: 'Invalid notebook RPC token.' }
    })
    await expect(callLineage(control, ordinary.token, params)).resolves.toMatchObject({
      response: { status: 403 },
      payload: { error: 'host.lineage requires a control-plane REPL capability.' }
    })

    control.release()
    await expect(callLineage(control, control.token, params)).resolves.toMatchObject({
      response: { status: 401 },
      payload: { error: 'Invalid notebook RPC token.' }
    })
    ordinary.release?.()
  })
})
