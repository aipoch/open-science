import { describe, it, expect, afterEach } from 'vitest'
import { NotebookLocalRpcServer } from './local-rpc-server'

const fakeConnector = {
  call: async (s: string, m: string, a: Record<string, unknown>) => ({ s, m, a })
}
let server: NotebookLocalRpcServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('mcpCall RPC', () => {
  it('routes mcpCall to the connector service', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      connectorService: fakeConnector as never
    })
    const { endpoint, token } = await server.ensureStarted()
    const res = await fetch(`${endpoint}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'mcpCall',
        params: { server: 'chemistry', method: 'pubchem_get_properties', args: { cids: [1] } }
      })
    })
    expect(await res.json()).toEqual({
      result: { s: 'chemistry', m: 'pubchem_get_properties', a: { cids: [1] } }
    })
  })

  it('forwards the caller session id as call context so writes attribute to the right session', async () => {
    let seenContext: { sessionId?: string } | undefined
    const capturing = {
      call: async (
        _s: string,
        _m: string,
        _a: Record<string, unknown>,
        context?: { sessionId?: string }
      ) => {
        seenContext = context
        return { ok: true }
      }
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      connectorService: capturing as never
    })
    const { endpoint, token } = await server.ensureStarted()
    await fetch(`${endpoint}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'mcpCall',
        params: { server: 'molecule', method: 'preview_molecule', args: {}, sessionId: 's-42' }
      })
    })
    expect(seenContext).toEqual({ sessionId: 's-42' })
  })
})

describe('computeCall RPC', () => {
  it('routes computeCall op=call_command to the compute service', async () => {
    const fakeResult = { exit_code: 0, stdout: 'hello', stderr: '', truncated: false }
    const fakeCompute = {
      callCommand: async (
        providerId: string,
        cmd: string,
        intent: string,
        loginShell: boolean,
        timeoutSeconds?: number
      ) => ({ ...fakeResult, _args: { providerId, cmd, intent, loginShell, timeoutSeconds } })
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      computeService: fakeCompute as never
    })
    const { endpoint, token } = await server.ensureStarted()
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'computeCall',
        params: {
          op: 'call_command',
          provider_id: 'ssh:biowulf',
          cmd: 'echo hi',
          intent: 'test',
          login_shell: true,
          timeout_seconds: 30
        }
      })
    })
    const body = (await res.json()) as {
      result: { exit_code: number; stdout: string; _args: Record<string, unknown> }
    }
    expect(res.status).toBe(200)
    expect(body.result.exit_code).toBe(0)
    expect(body.result.stdout).toBe('hello')
    expect(body.result._args.providerId).toBe('ssh:biowulf')
    expect(body.result._args.loginShell).toBe(true)
    expect(body.result._args.timeoutSeconds).toBe(30)
  })

  it('returns 401 without Bearer token', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      computeService: {} as never
    })
    const { endpoint } = await server.ensureStarted()
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'computeCall', params: { op: 'call_command' } })
    })
    expect(res.status).toBe(401)
  })

  it('returns 500 when compute service is not configured', async () => {
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never)
    const { endpoint, token } = await server.ensureStarted()
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'computeCall', params: { op: 'call_command' } })
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/compute service is not configured/i)
  })

  it('returns 500 with structured error JSON when computeCallError is thrown', async () => {
    const callErr = new Error('approval denied') as Error & { computeCallError: unknown }
    callErr.computeCallError = {
      error_code: 'approval_denied',
      message: 'Approval denied.',
      retry_after_user_action: false
    }
    const fakeCompute = {
      callCommand: async () => {
        throw callErr
      }
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      computeService: fakeCompute as never
    })
    const { endpoint, token } = await server.ensureStarted()
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'computeCall',
        params: { op: 'call_command', provider_id: 'ssh:x', cmd: 'ls', intent: 'test' }
      })
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    const parsed = JSON.parse(body.error)
    expect(parsed.error_code).toBe('approval_denied')
  })

  it('returns 500 for unknown op', async () => {
    const fakeCompute = { callCommand: async () => ({}) }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      computeService: fakeCompute as never
    })
    const { endpoint, token } = await server.ensureStarted()
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'computeCall', params: { op: 'unknown_op' } })
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/unknown computecall op/i)
  })
})
