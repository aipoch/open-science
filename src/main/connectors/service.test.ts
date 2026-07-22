import { describe, it, expect, vi } from 'vitest'
import { ConnectorService } from './service'
import { ParserEngine } from './engine'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('ConnectorService', () => {
  it('rejects calls to a disabled connector', async () => {
    const svc = new ConnectorService({
      getConnectors: () => ({
        enabledIds: [],
        autoAllowIds: [],
        disabledConnectorIds: ['chemistry']
      }),
      resolveApiKey: () => undefined
    })
    await expect(svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] })).rejects.toThrow(
      /not enabled/
    )
  })
  it('treats a bundled connector as enabled by default (opt-out model)', async () => {
    const svc = new ConnectorService({
      getConnectors: () => ({ enabledIds: [], autoAllowIds: [] }),
      resolveApiKey: () => undefined
    })
    // No disabledConnectorIds ⇒ chemistry is enabled, so an unknown method (not enablement) is what fails.
    await expect(svc.call('chemistry', 'nope', {})).rejects.toThrow(/unknown tool/)
  })
  it('rejects an unknown method', async () => {
    const svc = new ConnectorService({
      getConnectors: () => ({ enabledIds: ['chemistry'], autoAllowIds: [] }),
      resolveApiKey: () => undefined
    })
    await expect(svc.call('chemistry', 'nope', {})).rejects.toThrow(/unknown tool/)
  })
  it('routes an enabled call through the engine with resolved credentials', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ PropertyTable: { Properties: [{ CID: 1 }] } }))
    const svc = new ConnectorService({
      engine: new ParserEngine({ fetchImpl }),
      getConnectors: () => ({
        enabledIds: ['chemistry'],
        autoAllowIds: [],
        contactEmail: 'x@y.org',
        ncbiApiKeyRef: 'ref'
      }),
      resolveApiKey: (ref) => (ref === 'ref' ? 'SECRET' : undefined)
    })
    const out = await svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] })
    expect(out).toEqual({ n_requested: 1, duplicates: [], records: [{ CID: 1 }], not_found: [] })
  })
  it('routes a bundled tool with a registered local handler through it, not the engine', async () => {
    const localHandler = vi.fn().mockResolvedValue({ ok: true })
    const engine = { call: vi.fn() } as unknown as ParserEngine
    const svc = new ConnectorService({
      engine,
      getConnectors: () => ({ enabledIds: ['molecule'], autoAllowIds: [] }),
      resolveApiKey: () => undefined,
      localToolHandlers: { 'molecule/preview_molecule': localHandler }
    })
    const out = await svc.call(
      'molecule',
      'preview_molecule',
      { smiles: 'C' },
      { sessionId: 's-1' }
    )
    expect(localHandler).toHaveBeenCalledWith({ smiles: 'C' }, { sessionId: 's-1' })
    expect(out).toEqual({ ok: true })
    expect(engine.call).not.toHaveBeenCalled()
  })
  it('falls through to the engine when no local handler is registered', async () => {
    const svc = new ConnectorService({
      getConnectors: () => ({ enabledIds: ['molecule'], autoAllowIds: [] }),
      resolveApiKey: () => undefined
    })
    await expect(svc.call('molecule', 'preview_molecule', { smiles: 'C' })).rejects.toThrow(
      /handled by the app runtime/
    )
  })
  it('rejects a blocked tool', async () => {
    const svc = new ConnectorService({
      getConnectors: () => ({
        enabledIds: ['chemistry'],
        autoAllowIds: [],
        blockedToolIds: ['chemistry/pubchem_get_compounds']
      }),
      resolveApiKey: () => undefined
    })
    await expect(svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] })).rejects.toThrow(
      /blocked by policy/
    )
  })

  it('requests approval for an ask-flagged tool and runs it when allowed', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ PropertyTable: { Properties: [{ CID: 1 }] } }))
    const requestApproval = vi.fn().mockResolvedValue('allow')
    const svc = new ConnectorService({
      engine: new ParserEngine({ fetchImpl }),
      getConnectors: () => ({
        enabledIds: [],
        autoAllowIds: [],
        askToolIds: ['chemistry/pubchem_get_compounds']
      }),
      resolveApiKey: () => undefined,
      requestApproval
    })
    const out = await svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] })
    expect(out).toEqual({ n_requested: 1, duplicates: [], records: [{ CID: 1 }], not_found: [] })
    expect(requestApproval).toHaveBeenCalledWith({
      connector: 'chemistry',
      method: 'pubchem_get_compounds',
      args: { cids: [1] }
    })
  })

  // Pins the ConnectorCallContext → ensureApproved → requestApproval seam. The connector service
  // already received the triggering session; a prior regression dropped it here, which made
  // ApprovalBroker → notification routing click on the wrong conversation (or none at all for
  // notebook calls without an in-flight turn).
  it('threads context.sessionId through to requestApproval for bundled tools', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ PropertyTable: { Properties: [{ CID: 1 }] } }))
    const requestApproval = vi.fn().mockResolvedValue('allow')
    const svc = new ConnectorService({
      engine: new ParserEngine({ fetchImpl }),
      getConnectors: () => ({
        enabledIds: [],
        autoAllowIds: [],
        askToolIds: ['chemistry/pubchem_get_compounds']
      }),
      resolveApiKey: () => undefined,
      requestApproval
    })

    await svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] }, { sessionId: 'session-42' })

    expect(requestApproval).toHaveBeenCalledWith({
      connector: 'chemistry',
      method: 'pubchem_get_compounds',
      args: { cids: [1] },
      sessionId: 'session-42'
    })
  })

  it('rejects an ask-flagged tool when the user denies approval', async () => {
    const fetchImpl = vi.fn()
    const requestApproval = vi.fn().mockResolvedValue('deny')
    const svc = new ConnectorService({
      engine: new ParserEngine({ fetchImpl }),
      getConnectors: () => ({
        enabledIds: [],
        autoAllowIds: [],
        askToolIds: ['chemistry/pubchem_get_compounds']
      }),
      resolveApiKey: () => undefined,
      requestApproval
    })
    await expect(svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] })).rejects.toThrow(
      /denied by user/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not prompt for a tool at the default (allow)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ PropertyTable: { Properties: [{ CID: 1 }] } }))
    const requestApproval = vi.fn()
    const svc = new ConnectorService({
      engine: new ParserEngine({ fetchImpl }),
      getConnectors: () => ({ enabledIds: [], autoAllowIds: [] }),
      resolveApiKey: () => undefined,
      requestApproval
    })
    await svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] })
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('skips approval for an ask tool when the connector has skip-approvals', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ PropertyTable: { Properties: [{ CID: 1 }] } }))
    const requestApproval = vi.fn()
    const svc = new ConnectorService({
      engine: new ParserEngine({ fetchImpl }),
      getConnectors: () => ({
        enabledIds: [],
        autoAllowIds: ['chemistry'],
        askToolIds: ['chemistry/pubchem_get_compounds']
      }),
      resolveApiKey: () => undefined,
      requestApproval
    })
    await svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] })
    expect(requestApproval).not.toHaveBeenCalled()
  })

  describe('custom MCP servers', () => {
    it('routes a call to a custom server through mcpClientManager.call', async () => {
      const call = vi.fn().mockResolvedValue({ ok: true })
      const svc = new ConnectorService({
        mcpClientManager: { call },
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [
            {
              id: 'srv-1',
              name: 'myserver',
              transport: 'stdio',
              command: 'npx',
              args: ['-y', '@example/server'],
              env: { FOO: 'bar' },
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined
      })
      const out = await svc.call('myserver', 'do_thing', { x: 1 })
      expect(out).toEqual({ ok: true })
      expect(call).toHaveBeenCalledWith(
        {
          id: 'srv-1',
          name: 'myserver',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@example/server'],
          env: { FOO: 'bar' },
          url: undefined,
          headers: undefined
        },
        'do_thing',
        { x: 1 }
      )
    })

    it('routes a call to a remote (streamable_http) custom server with its url/headers', async () => {
      const call = vi.fn().mockResolvedValue({ ok: true })
      const svc = new ConnectorService({
        mcpClientManager: { call },
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [
            {
              id: 'srv-remote',
              name: 'remoteserver',
              transport: 'streamable_http',
              url: 'https://example.com/mcp',
              headers: { Authorization: 'Bearer token' },
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined
      })
      const out = await svc.call('remoteserver', 'do_thing', { x: 1 })
      expect(out).toEqual({ ok: true })
      expect(call).toHaveBeenCalledWith(
        {
          id: 'srv-remote',
          name: 'remoteserver',
          transport: 'streamable_http',
          command: '',
          args: undefined,
          env: undefined,
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer token' }
        },
        'do_thing',
        { x: 1 }
      )
    })

    it('rejects a disabled custom server', async () => {
      const call = vi.fn()
      const svc = new ConnectorService({
        mcpClientManager: { call },
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [
            { id: 'srv-1', name: 'myserver', transport: 'stdio', command: 'npx', enabled: false }
          ]
        }),
        resolveApiKey: () => undefined
      })
      await expect(svc.call('myserver', 'do_thing', {})).rejects.toThrow(/not enabled/)
      expect(call).not.toHaveBeenCalled()
    })

    it('rejects a blocked tool on a custom server', async () => {
      const call = vi.fn()
      const svc = new ConnectorService({
        mcpClientManager: { call },
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          blockedToolIds: ['myserver/dangerous'],
          customMcpServers: [
            { id: 'srv-1', name: 'myserver', transport: 'stdio', command: 'npx', enabled: true }
          ]
        }),
        resolveApiKey: () => undefined
      })
      await expect(svc.call('myserver', 'dangerous', {})).rejects.toThrow(/blocked by policy/)
      expect(call).not.toHaveBeenCalled()
    })

    it('rejects a call to an unknown server name (neither bundled nor custom)', async () => {
      const svc = new ConnectorService({
        getConnectors: () => ({ enabledIds: [], autoAllowIds: [], customMcpServers: [] }),
        resolveApiKey: () => undefined
      })
      await expect(svc.call('nope', 'do_thing', {})).rejects.toThrow(/not enabled/)
    })

    it('threads context.sessionId through to requestApproval for custom MCP tools', async () => {
      const call = vi.fn().mockResolvedValue({ ok: true })
      const requestApproval = vi.fn().mockResolvedValue('allow')
      const svc = new ConnectorService({
        mcpClientManager: { call },
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          askToolIds: ['myserver/do_thing'],
          customMcpServers: [
            { id: 'srv-1', name: 'myserver', transport: 'stdio', command: 'npx', enabled: true }
          ]
        }),
        resolveApiKey: () => undefined,
        requestApproval
      })

      await svc.call('myserver', 'do_thing', { x: 1 }, { sessionId: 'session-99' })

      expect(requestApproval).toHaveBeenCalledWith({
        connector: 'myserver',
        method: 'do_thing',
        args: { x: 1 },
        sessionId: 'session-99'
      })
    })
  })
})
