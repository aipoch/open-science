import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotebookLocalRpcServer } from './local-rpc-server'

type RpcConnection = { endpoint: string; token: string; release?: () => void }

const callSessions = async (
  connection: RpcConnection,
  token: string,
  params: Record<string, unknown>
): Promise<{ response: Response; payload: Record<string, unknown> }> => {
  const response = await fetch(connection.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'sessionsCall', params })
  })
  return { response, payload: (await response.json()) as Record<string, unknown> }
}

let server: NotebookLocalRpcServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('sessionsCall RPC', () => {
  it('uses only the Main control token identity for list and inspect operations', async () => {
    const list = vi.fn(async () => ({ sessions: [] }))
    const inspect = vi.fn(async () => ({ session_id: 'target-session' }))
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostSessions: { list, inspect }
    })
    const control = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    await expect(
      callSessions(control, control.token, {
        op: 'list',
        options: { archived: 'include' },
        projectId: 'forged-project',
        sessionId: 'forged-session',
        callerRole: 'delegate'
      })
    ).resolves.toMatchObject({ response: { status: 200 }, payload: { result: { sessions: [] } } })
    expect(list).toHaveBeenCalledWith(
      { archived: 'include' },
      { projectId: 'trusted-project', sessionId: 'trusted-session', callerRole: 'main' }
    )

    await expect(
      callSessions(control, control.token, {
        op: 'inspect',
        session_id: 'target-session',
        projectId: 'forged-project'
      })
    ).resolves.toMatchObject({ response: { status: 200 } })
    expect(inspect).toHaveBeenCalledWith('target-session', {
      projectId: 'trusted-project',
      sessionId: 'trusted-session',
      callerRole: 'main'
    })
  })

  it('rejects bootstrap, ordinary Session, delegate control, and released capabilities', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      hostSessions: { list: vi.fn(), inspect: vi.fn() }
    })
    const bootstrap = await server.ensureStarted()
    const ordinary = await server.issueSessionConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )
    const main = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )
    const delegate = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'delegate-frame',
      { role: 'delegate', attemptId: 'attempt-1' }
    )
    const params = { op: 'list', options: {} }

    await expect(callSessions(main, bootstrap.token, params)).resolves.toMatchObject({
      response: { status: 401 },
      payload: { error: 'A session-bound notebook RPC token is required.' }
    })
    await expect(callSessions(main, ordinary.token, params)).resolves.toMatchObject({
      response: { status: 403 },
      payload: { error: 'host.sessions requires a Main control-plane REPL capability.' }
    })
    await expect(callSessions(delegate, delegate.token, params)).resolves.toMatchObject({
      response: { status: 403 },
      payload: { error: 'host.sessions requires a Main control-plane REPL capability.' }
    })

    main.release()
    await expect(callSessions(main, main.token, params)).resolves.toMatchObject({
      response: { status: 401 },
      payload: { error: 'Invalid notebook RPC token.' }
    })
    ordinary.release?.()
    delegate.release()
  })

  it('fails closed and does not advertise Session diagnostics when the service is unavailable', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp'
    })
    const control = await server.issueControlConnection(
      'trusted-session',
      'trusted-project',
      'root-frame-trusted-session'
    )

    const capabilityResponse = await fetch(control.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${control.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'capabilitiesCall', params: {} })
    })
    await expect(capabilityResponse.json()).resolves.toMatchObject({
      result: { sessions: false }
    })
    await expect(
      callSessions(control, control.token, { op: 'list', options: {} })
    ).resolves.toMatchObject({
      response: { status: 500 },
      payload: { error: 'Host Session diagnostics are not configured.' }
    })
  })
})
