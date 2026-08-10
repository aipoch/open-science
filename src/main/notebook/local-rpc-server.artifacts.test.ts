import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotebookLocalRpcServer } from './local-rpc-server'

type RpcConnection = { endpoint: string; token: string; release?: () => void }

const callArtifacts = async (
  connection: RpcConnection,
  token: string,
  params: Record<string, unknown>
): Promise<{ response: Response; payload: Record<string, unknown> }> => {
  const response = await fetch(connection.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'artifactsCall', params })
  })
  return { response, payload: (await response.json()) as Record<string, unknown> }
}

let server: NotebookLocalRpcServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('artifactsCall RPC', () => {
  it('uses only the control token Project and Session for list and path operations', async () => {
    const list = vi.fn(async () => ({ artifacts: [] }))
    const resolvePath = vi.fn(async () => '/managed/report.csv')
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostArtifacts: { list, resolvePath }
    })
    const control = await server.issueControlConnection('trusted-session', 'trusted-project')

    const listed = await callArtifacts(control, control.token, {
      op: 'list',
      options: { session_id: 'narrow-session' },
      projectId: 'forged-project',
      sessionId: 'forged-session',
      project_id: 'all'
    })
    expect(listed).toMatchObject({ response: { status: 200 } })
    expect(list).toHaveBeenCalledWith(
      { session_id: 'narrow-session' },
      { projectId: 'trusted-project', sessionId: 'trusted-session' }
    )

    const resolved = await callArtifacts(control, control.token, {
      op: 'path',
      version_id: 'version-1',
      projectId: 'forged-project',
      sessionId: 'forged-session'
    })
    expect(resolved.payload).toEqual({ result: '/managed/report.csv' })
    expect(resolvePath).toHaveBeenCalledWith('version-1', {
      projectId: 'trusted-project',
      sessionId: 'trusted-session'
    })
  })

  it('rejects bootstrap, invalid, ordinary Session, and released control capabilities', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostArtifacts: { list: vi.fn(), resolvePath: vi.fn() }
    })
    const bootstrap = await server.ensureStarted()
    const ordinary = await server.issueSessionConnection('trusted-session', 'trusted-project')
    const control = await server.issueControlConnection('trusted-session', 'trusted-project')
    const params = { op: 'list', options: {} }

    await expect(callArtifacts(control, bootstrap.token, params)).resolves.toMatchObject({
      response: { status: 401 },
      payload: { error: 'A session-bound notebook RPC token is required.' }
    })
    await expect(callArtifacts(control, 'invalid-token', params)).resolves.toMatchObject({
      response: { status: 401 },
      payload: { error: 'Invalid notebook RPC token.' }
    })
    await expect(callArtifacts(control, ordinary.token, params)).resolves.toMatchObject({
      response: { status: 403 },
      payload: { error: 'host.artifacts requires a control-plane REPL capability.' }
    })

    control.release()
    await expect(callArtifacts(control, control.token, params)).resolves.toMatchObject({
      response: { status: 401 },
      payload: { error: 'Invalid notebook RPC token.' }
    })
    ordinary.release?.()
  })
})
