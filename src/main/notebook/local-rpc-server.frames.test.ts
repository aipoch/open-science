import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotebookLocalRpcServer } from './local-rpc-server'

type RpcConnection = { endpoint: string; token: string; release?: () => void }

const callFrames = async (
  connection: RpcConnection,
  token: string,
  params: Record<string, unknown>
): Promise<{ response: Response; payload: Record<string, unknown> }> => {
  const response = await fetch(connection.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'framesCall', params })
  })
  return { response, payload: (await response.json()) as Record<string, unknown> }
}

let server: NotebookLocalRpcServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('framesCall RPC', () => {
  it('uses only the control token Project and calling Session for list and get operations', async () => {
    const list = vi.fn(async () => ({ frames: [] }))
    const get = vi.fn(async () => ({ frame: { frame_id: 'frame-exact' } }))
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostFrames: { list, get }
    })
    const control = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    const listed = await callFrames(control, control.token, {
      op: 'list',
      options: { session_id: 'narrow-session' },
      projectId: 'forged-project',
      project_id: 'forged-project',
      sessionId: 'forged-session'
    })
    expect(listed).toMatchObject({ response: { status: 200 }, payload: { result: { frames: [] } } })
    expect(list).toHaveBeenCalledWith(
      { session_id: 'narrow-session' },
      { projectId: 'trusted-project', sessionId: 'trusted-session' }
    )

    await expect(
      callFrames(control, control.token, {
        op: 'get',
        frame_id: 'frame-exact',
        options: { branch_id: 'branch-exact' },
        projectId: 'forged-project',
        sessionId: 'forged-session'
      })
    ).resolves.toMatchObject({ response: { status: 200 } })
    expect(get).toHaveBeenCalledWith(
      'frame-exact',
      { branch_id: 'branch-exact' },
      { projectId: 'trusted-project', sessionId: 'trusted-session' }
    )
  })

  it('rejects bootstrap, invalid, ordinary Session, and released control capabilities', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostFrames: { list: vi.fn(), get: vi.fn() }
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
    const params = { op: 'list', options: {} }

    await expect(callFrames(control, bootstrap.token, params)).resolves.toMatchObject({
      response: { status: 401 },
      payload: { error: 'A session-bound notebook RPC token is required.' }
    })
    await expect(callFrames(control, 'invalid-token', params)).resolves.toMatchObject({
      response: { status: 401 },
      payload: { error: 'Invalid notebook RPC token.' }
    })
    await expect(callFrames(control, ordinary.token, params)).resolves.toMatchObject({
      response: { status: 403 },
      payload: { error: 'host.frames requires a control-plane REPL capability.' }
    })

    control.release()
    await expect(callFrames(control, control.token, params)).resolves.toMatchObject({
      response: { status: 401 },
      payload: { error: 'Invalid notebook RPC token.' }
    })
    ordinary.release?.()
  })
})
