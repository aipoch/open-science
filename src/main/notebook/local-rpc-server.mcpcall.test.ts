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
