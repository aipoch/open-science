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
})
