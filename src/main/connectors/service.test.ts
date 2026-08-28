import { describe, it, expect, vi } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ConnectorService } from './service'
import { ParserEngine } from './engine'
import { McpClientManager, McpToolCallError } from './mcp-client-manager'
import type { SpecialistView } from '../../shared/specialist'
import type { CustomMcpServerConfig } from './mcp-client-manager'

const internal = { origin: 'internal' as const }

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('ConnectorService', () => {
  it('parks an OpenAlex call for credential recovery and resumes the exact call after save', async () => {
    let connectors = {
      enabledIds: [] as string[],
      autoAllowIds: [] as string[],
      openAlexApiKeyRef: undefined as string | undefined
    }
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ meta: { count: 0 }, results: [] }))
    const requestCredential = vi.fn(async () => {
      connectors = { ...connectors, openAlexApiKeyRef: 'encrypted-ref' }
      return true
    })
    const svc = new ConnectorService({
      engine: new ParserEngine({ fetchImpl }),
      getConnectors: () => connectors,
      getConnectorsFresh: async () => connectors,
      resolveApiKey: (ref) => (ref === 'encrypted-ref' ? 'OPENALEX_KEY' : undefined),
      requestCredential
    })

    await svc.call(
      'literature',
      'openalex_search_works',
      { query: 'CRISPR', max_records: 1 },
      { origin: 'internal', sessionId: 'session-1' }
    )

    expect(requestCredential).toHaveBeenCalledWith(
      {
        credentialId: 'openalex',
        connector: 'literature',
        method: 'openalex_search_works',
        sessionId: 'session-1'
      },
      undefined
    )
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('api_key')).toBe(
      'OPENALEX_KEY'
    )
  })

  it('does not dispatch OpenAlex when credential recovery is declined', async () => {
    const fetchImpl = vi.fn()
    const svc = new ConnectorService({
      engine: new ParserEngine({ fetchImpl }),
      getConnectors: () => ({ enabledIds: [], autoAllowIds: [] }),
      resolveApiKey: () => undefined,
      requestCredential: vi.fn().mockResolvedValue(false)
    })

    await expect(
      svc.call('literature', 'openalex_search_works', { query: 'CRISPR', max_records: 1 }, internal)
    ).rejects.toThrow(/credential_required/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not dispatch OpenAlex when the tool is blocked during credential recovery', async () => {
    let connectors = {
      enabledIds: [] as string[],
      autoAllowIds: [] as string[],
      blockedToolIds: [] as string[],
      openAlexApiKeyRef: undefined as string | undefined
    }
    let settleCredential: ((configured: boolean) => void) | undefined
    const fetchImpl = vi.fn()
    const requestCredential = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settleCredential = resolve
        })
    )
    const svc = new ConnectorService({
      engine: new ParserEngine({ fetchImpl }),
      getConnectors: () => connectors,
      getConnectorsFresh: async () => connectors,
      resolveApiKey: (ref) => (ref === 'encrypted-ref' ? 'OPENALEX_KEY' : undefined),
      requestCredential
    })

    const call = svc.call(
      'literature',
      'openalex_search_works',
      { query: 'CRISPR', max_records: 1 },
      internal
    )
    await vi.waitFor(() => expect(requestCredential).toHaveBeenCalledOnce())
    connectors = {
      ...connectors,
      blockedToolIds: ['literature/openalex_search_works'],
      openAlexApiKeyRef: 'encrypted-ref'
    }
    settleCredential?.(true)

    await expect(call).rejects.toThrow(/blocked by policy/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not dispatch OpenAlex when the connector is disabled during credential recovery', async () => {
    let connectors = {
      enabledIds: [] as string[],
      autoAllowIds: [] as string[],
      disabledConnectorIds: [] as string[],
      openAlexApiKeyRef: undefined as string | undefined
    }
    let settleCredential: ((configured: boolean) => void) | undefined
    const fetchImpl = vi.fn()
    const requestCredential = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settleCredential = resolve
        })
    )
    const svc = new ConnectorService({
      engine: new ParserEngine({ fetchImpl }),
      getConnectors: () => connectors,
      getConnectorsFresh: async () => connectors,
      resolveApiKey: (ref) => (ref === 'encrypted-ref' ? 'OPENALEX_KEY' : undefined),
      requestCredential
    })

    const call = svc.call(
      'literature',
      'openalex_search_works',
      { query: 'CRISPR', max_records: 1 },
      internal
    )
    await vi.waitFor(() => expect(requestCredential).toHaveBeenCalledOnce())
    connectors = {
      ...connectors,
      disabledConnectorIds: ['literature'],
      openAlexApiKeyRef: 'encrypted-ref'
    }
    settleCredential?.(true)

    await expect(call).rejects.toThrow(/disabled/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('preserves a satisfied Once approval across credential recovery', async () => {
    let connectors = {
      enabledIds: [] as string[],
      autoAllowIds: [] as string[],
      askToolIds: ['literature/openalex_search_works'],
      openAlexApiKeyRef: undefined as string | undefined
    }
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ meta: { count: 0 }, results: [] }))
    const requestApproval = vi.fn().mockResolvedValue('once')
    const requestCredential = vi.fn(async () => {
      connectors = { ...connectors, openAlexApiKeyRef: 'encrypted-ref' }
      return true
    })
    const svc = new ConnectorService({
      engine: new ParserEngine({ fetchImpl }),
      getConnectors: () => connectors,
      getConnectorsFresh: async () => connectors,
      resolveApiKey: (ref) => (ref === 'encrypted-ref' ? 'OPENALEX_KEY' : undefined),
      requestApproval,
      requestCredential
    })

    await svc.call(
      'literature',
      'openalex_search_works',
      { query: 'CRISPR', max_records: 1 },
      internal
    )

    expect(requestApproval).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('rejects calls to a disabled connector', async () => {
    const svc = new ConnectorService({
      getConnectors: () => ({
        enabledIds: [],
        autoAllowIds: [],
        disabledConnectorIds: ['chemistry']
      }),
      resolveApiKey: () => undefined
    })
    await expect(
      svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] }, internal)
    ).rejects.toThrow(
      'Connector "chemistry" is disabled. Do not retry with guessed Connector names. Ask the user to enable it in Settings > Connectors, then retry the same call.'
    )
  })
  it('treats a bundled connector as enabled by default (opt-out model)', async () => {
    const svc = new ConnectorService({
      getConnectors: () => ({ enabledIds: [], autoAllowIds: [] }),
      resolveApiKey: () => undefined
    })
    // No disabledConnectorIds ⇒ chemistry is enabled, so an unknown method (not enablement) is what fails.
    await expect(svc.call('chemistry', 'nope', {}, internal)).rejects.toThrow(/unknown tool/)
  })
  it('rejects an unknown method', async () => {
    const svc = new ConnectorService({
      getConnectors: () => ({ enabledIds: ['chemistry'], autoAllowIds: [] }),
      resolveApiKey: () => undefined
    })
    await expect(svc.call('chemistry', 'nope', {}, internal)).rejects.toThrow(
      'unknown tool: chemistry/nope. Do not retry with guessed method names. Use only methods documented by a loaded mcp-* Skill, then retry with a documented method.'
    )
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
    const out = await svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] }, internal)
    expect(out).toEqual({ n_requested: 1, duplicates: [], records: [{ CID: 1 }], not_found: [] })
  })
  it('preserves bundled handler support for a single id when the schema recommends a list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        status: 'ok',
        records: [{ 'requested-id': 'PMC9046468', pmcid: 'PMC9046468', pmid: 34713412 }]
      })
    )
    const svc = new ConnectorService({
      engine: new ParserEngine({ fetchImpl }),
      getConnectors: () => ({ enabledIds: ['pubmed'], autoAllowIds: [] }),
      resolveApiKey: () => undefined
    })

    const out = (await svc.call(
      'pubmed',
      'convert_article_ids',
      { ids: 'PMC9046468', id_type: 'pmcid' },
      internal
    )) as { records: Array<Record<string, unknown>> }

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(String(fetchImpl.mock.calls[0][0])).toContain('ids=PMC9046468')
    expect(out.records[0]).toMatchObject({
      pmcid: 'PMC9046468',
      pmid: '34713412',
      'requested-id': 'PMC9046468'
    })
  })
  it('rejects bundled tool arguments that do not match the registered JSON Schema', async () => {
    const engine = {
      call: vi.fn().mockResolvedValue({ accepted: true })
    } as unknown as ParserEngine
    const svc = new ConnectorService({
      engine,
      getConnectors: () => ({ enabledIds: ['chemistry'], autoAllowIds: [] }),
      resolveApiKey: () => undefined
    })

    await expect(
      svc.call('chemistry', 'pubchem_get_compounds', { cids: '2244' }, internal)
    ).rejects.toThrow(/invalid tool arguments.*cids.*array/i)
    expect(engine.call).not.toHaveBeenCalled()
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
      { origin: 'internal', sessionId: 's-1' }
    )
    expect(localHandler).toHaveBeenCalledWith(
      { smiles: 'C' },
      { origin: 'internal', sessionId: 's-1' }
    )
    expect(out).toEqual({ ok: true })
    expect(engine.call).not.toHaveBeenCalled()
  })
  it('validates bundled tool arguments before dispatching to a local handler', async () => {
    const localHandler = vi.fn().mockResolvedValue({ ok: true })
    const svc = new ConnectorService({
      getConnectors: () => ({ enabledIds: ['molecule'], autoAllowIds: [] }),
      resolveApiKey: () => undefined,
      localToolHandlers: { 'molecule/preview_molecule': localHandler }
    })

    await expect(
      svc.call('molecule', 'preview_molecule', { smiles: 42 }, internal)
    ).rejects.toThrow(/invalid tool arguments.*smiles.*string/i)
    expect(localHandler).not.toHaveBeenCalled()
  })
  it('passes the caller signal to a bundled local handler', async () => {
    const localHandler = vi.fn().mockResolvedValue({ ok: true })
    const svc = new ConnectorService({
      getConnectors: () => ({ enabledIds: ['molecule'], autoAllowIds: [] }),
      resolveApiKey: () => undefined,
      localToolHandlers: { 'molecule/preview_molecule': localHandler }
    })
    const cancellation = new AbortController()

    await svc.call(
      'molecule',
      'preview_molecule',
      { smiles: 'C' },
      { origin: 'internal', sessionId: 's-1' },
      cancellation.signal
    )

    expect(localHandler).toHaveBeenCalledWith(
      { smiles: 'C' },
      { origin: 'internal', sessionId: 's-1' },
      cancellation.signal
    )
  })
  it('falls through to the engine when no local handler is registered', async () => {
    const svc = new ConnectorService({
      getConnectors: () => ({ enabledIds: ['molecule'], autoAllowIds: [] }),
      resolveApiKey: () => undefined
    })
    await expect(
      svc.call('molecule', 'preview_molecule', { smiles: 'C' }, internal)
    ).rejects.toThrow(/handled by the app runtime/)
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
    await expect(
      svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] }, internal)
    ).rejects.toThrow(/blocked by policy/)
  })

  it('requests approval for an ask-flagged tool and runs it when allowed', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ PropertyTable: { Properties: [{ CID: 1 }] } }))
    const requestApproval = vi.fn().mockResolvedValue('once')
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
    const out = await svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] }, internal)
    expect(out).toEqual({ n_requested: 1, duplicates: [], records: [{ CID: 1 }], not_found: [] })
    expect(requestApproval).toHaveBeenCalledWith({
      connector: 'chemistry',
      method: 'pubchem_get_compounds',
      args: { cids: [1] },
      availableScopes: ['once']
    })
  })

  it('does not dispatch a bundled call blocked while its approval is pending', async () => {
    const fetchImpl = vi.fn()
    let connectors = {
      enabledIds: [] as string[],
      autoAllowIds: [] as string[],
      askToolIds: ['chemistry/pubchem_get_compounds'],
      blockedToolIds: [] as string[]
    }
    let settleApproval: ((decision: 'once') => void) | undefined
    const requestApproval = vi.fn(
      () =>
        new Promise<'once'>((resolve) => {
          settleApproval = resolve
        })
    )
    const svc = new ConnectorService({
      engine: new ParserEngine({ fetchImpl }),
      getConnectors: () => connectors,
      getConnectorsFresh: async () => connectors,
      resolveApiKey: () => undefined,
      requestApproval
    })

    const call = svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] }, internal)
    await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledOnce())
    connectors = {
      ...connectors,
      blockedToolIds: ['chemistry/pubchem_get_compounds']
    }
    settleApproval?.('once')

    await expect(call).rejects.toThrow(/blocked by policy/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not dispatch a bundled call after its pending approval is cancelled', async () => {
    const fetchImpl = vi.fn()
    let approvalSignal: AbortSignal | undefined
    const requestApproval = vi.fn(
      async (_info: unknown, signal?: AbortSignal): Promise<'deny'> =>
        new Promise((resolve) => {
          approvalSignal = signal
          signal?.addEventListener('abort', () => resolve('deny'), { once: true })
        })
    )
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
    const cancellation = new AbortController()

    const call = svc.call(
      'chemistry',
      'pubchem_get_compounds',
      { cids: [1] },
      internal,
      cancellation.signal
    )
    await vi.waitFor(() => expect(approvalSignal).toBe(cancellation.signal))
    cancellation.abort()

    await expect(call).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not mark a custom MCP server unavailable when discovery is cancelled', async () => {
    let discoverySignal: AbortSignal | undefined
    const listTools = vi.fn(
      async (_config: CustomMcpServerConfig, signal?: AbortSignal) =>
        new Promise<Array<{ name: string }>>((_, reject) => {
          discoverySignal = signal
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const callTool = vi.fn()
    const onCustomServerAvailabilityChanged = vi.fn()
    const svc = new ConnectorService({
      mcpClientManager: { listTools, call: callTool },
      getConnectors: () => ({
        enabledIds: [],
        autoAllowIds: ['myserver'],
        customMcpServers: [
          {
            id: 'srv-1',
            name: 'myserver',
            displayName: 'My server',
            transport: 'stdio',
            command: 'npx',
            enabled: true
          }
        ]
      }),
      resolveApiKey: () => undefined,
      onCustomServerAvailabilityChanged
    })
    const cancellation = new AbortController()

    const call = svc.call('myserver', 'do_thing', {}, internal, cancellation.signal)
    await vi.waitFor(() => expect(discoverySignal).toBe(cancellation.signal))
    cancellation.abort()

    await expect(call).rejects.toMatchObject({ name: 'AbortError' })
    expect(callTool).not.toHaveBeenCalled()
    expect(onCustomServerAvailabilityChanged).not.toHaveBeenCalled()
  })

  it('does not dispatch from a stale cached Allow after durable policy becomes Block', async () => {
    const fetchImpl = vi.fn()
    const cached = {
      enabledIds: [] as string[],
      autoAllowIds: ['chemistry'],
      askToolIds: [] as string[],
      blockedToolIds: [] as string[]
    }
    const durable = {
      ...cached,
      blockedToolIds: ['chemistry/pubchem_get_compounds']
    }
    const requestApproval = vi.fn()
    const getConnectorsFresh = vi.fn().mockResolvedValue(durable)
    const svc = new ConnectorService({
      engine: new ParserEngine({ fetchImpl }),
      getConnectors: () => cached,
      getConnectorsFresh,
      resolveApiKey: () => undefined,
      requestApproval
    })

    await expect(
      svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] }, internal)
    ).rejects.toThrow(/blocked by policy/)
    expect(getConnectorsFresh).toHaveBeenCalledOnce()
    expect(requestApproval).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not reject a bundled call from stale cached Disabled after durable Enable', async () => {
    const localHandler = vi.fn().mockResolvedValue({ ok: true })
    const cached = {
      enabledIds: [] as string[],
      autoAllowIds: [] as string[],
      disabledConnectorIds: ['chemistry']
    }
    const durable = { ...cached, disabledConnectorIds: [] as string[] }
    const svc = new ConnectorService({
      getConnectors: () => cached,
      getConnectorsFresh: vi.fn().mockResolvedValue(durable),
      resolveApiKey: () => undefined,
      localToolHandlers: { 'chemistry/pubchem_get_compounds': localHandler }
    })

    await expect(
      svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] }, internal)
    ).resolves.toEqual({ ok: true })
    expect(localHandler).toHaveBeenCalledOnce()
  })

  // Pins the ConnectorCallContext → ensureApproved → requestApproval seam. The connector service
  // already received the triggering session; a prior regression dropped it here, which made
  // ApprovalBroker → notification routing click on the wrong conversation (or none at all for
  // notebook calls without an in-flight turn).
  it('threads context.sessionId through to requestApproval for bundled tools', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ PropertyTable: { Properties: [{ CID: 1 }] } }))
    const requestApproval = vi.fn().mockResolvedValue('once')
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

    await svc.call(
      'chemistry',
      'pubchem_get_compounds',
      { cids: [1] },
      { origin: 'internal', sessionId: 'session-42' }
    )

    expect(requestApproval).toHaveBeenCalledWith({
      connector: 'chemistry',
      method: 'pubchem_get_compounds',
      args: { cids: [1] },
      sessionId: 'session-42',
      availableScopes: ['once']
    })
  })

  it('does not ask again when the unified Broker resolves a matching Connector grant', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ PropertyTable: { Properties: [{ CID: 1 }] } }))
    const requestApproval = vi.fn().mockResolvedValue('once')
    const resolve = vi.fn().mockResolvedValue({ matchedScope: 'project' })
    const svc = new ConnectorService({
      engine: new ParserEngine({ fetchImpl }),
      getConnectors: () => ({
        enabledIds: [],
        autoAllowIds: [],
        askToolIds: ['chemistry/pubchem_get_compounds']
      }),
      resolveApiKey: () => undefined,
      requestApproval,
      permissionGrantRegistry: { resolve } as never
    })

    await svc.call(
      'chemistry',
      'pubchem_get_compounds',
      { cids: [1] },
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    expect(resolve).toHaveBeenCalledWith(
      { kind: 'mcp_tool', key: 'mcp:chemistry/pubchem_get_compounds' },
      { sessionId: 'session-1', projectId: 'project-1' }
    )
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('commits a selected Session scope before releasing an ask-flagged Connector call', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ PropertyTable: { Properties: [{ CID: 1 }] } }))
    const requestApproval = vi.fn().mockResolvedValue('session')
    const resolve = vi.fn().mockResolvedValue(undefined)
    const remember = vi.fn().mockResolvedValue(undefined)
    const svc = new ConnectorService({
      engine: new ParserEngine({ fetchImpl }),
      getConnectors: () => ({
        enabledIds: [],
        autoAllowIds: [],
        askToolIds: ['chemistry/pubchem_get_compounds']
      }),
      resolveApiKey: () => undefined,
      requestApproval,
      permissionGrantRegistry: { resolve, remember } as never
    })

    await svc.call(
      'chemistry',
      'pubchem_get_compounds',
      { cids: [1] },
      { sessionId: 'session-1', projectId: 'project-1' }
    )

    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        availableScopes: ['once', 'session', 'project', 'global']
      })
    )
    expect(remember).toHaveBeenCalledWith({
      capability: { kind: 'mcp_tool', key: 'mcp:chemistry/pubchem_get_compounds' },
      scope: { kind: 'session', projectId: 'project-1', sessionId: 'session-1' }
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
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
    await expect(
      svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] }, internal)
    ).rejects.toThrow(/denied by user/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails closed when a required approval has no prompt transport', async () => {
    const fetchImpl = vi.fn()
    const svc = new ConnectorService({
      engine: new ParserEngine({ fetchImpl }),
      getConnectors: () => ({
        enabledIds: [],
        autoAllowIds: [],
        askToolIds: ['chemistry/pubchem_get_compounds']
      }),
      resolveApiKey: () => undefined
    })

    await expect(
      svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] }, internal)
    ).rejects.toThrow(/approval unavailable/)
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
    await svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] }, internal)
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
    await svc.call('chemistry', 'pubchem_get_compounds', { cids: [1] }, internal)
    expect(requestApproval).not.toHaveBeenCalled()
  })

  describe('custom MCP servers', () => {
    const manager = (
      call: ReturnType<typeof vi.fn>,
      tools = ['do_thing']
    ): {
      call: (
        config: CustomMcpServerConfig,
        method: string,
        args: Record<string, unknown>
      ) => Promise<unknown>
      listTools: (config: CustomMcpServerConfig) => Promise<Array<{ name: string }>>
    } => ({
      call: call as unknown as (
        config: CustomMcpServerConfig,
        method: string,
        args: Record<string, unknown>
      ) => Promise<unknown>,
      listTools: vi.fn().mockResolvedValue(tools.map((name) => ({ name })))
    })

    it('routes a call to a custom server through mcpClientManager.call', async () => {
      const call = vi.fn().mockResolvedValue({ ok: true })
      const svc = new ConnectorService({
        mcpClientManager: manager(call),
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [
            {
              id: 'srv-1',
              name: 'example-oauth-e2e',
              displayName: 'Example OAuth E2E',
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
      const out = await svc.call('example-oauth-e2e', 'do_thing', { x: 1 }, internal)
      expect(out).toEqual({ ok: true })
      expect(call).toHaveBeenCalledWith(
        {
          id: 'srv-1',
          name: 'example-oauth-e2e',
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

    it('does not dispatch a custom name that collides with a bundled connector', async () => {
      const call = vi.fn()
      const mcpClientManager = manager(call)
      const svc = new ConnectorService({
        mcpClientManager,
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [
            {
              id: 'srv-reserved',
              name: 'chemistry',
              displayName: 'Other Chemistry',
              transport: 'stdio',
              command: 'npx',
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined
      })

      await expect(svc.call('chemistry', 'do_thing', {}, internal)).rejects.toThrow(/unknown tool/)
      expect(mcpClientManager.listTools).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()
    })

    it('fails closed when custom Connectors have the same name', async () => {
      const call = vi.fn()
      const mcpClientManager = manager(call)
      const svc = new ConnectorService({
        mcpClientManager,
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [
            {
              id: 'srv-duplicate-a',
              name: 'duplicate-mcp',
              displayName: 'Duplicate A',
              transport: 'stdio',
              command: 'first-command',
              enabled: true
            },
            {
              id: 'srv-duplicate-b',
              name: 'duplicate-mcp',
              displayName: 'Duplicate B',
              transport: 'stdio',
              command: 'second-command',
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined
      })

      await expect(svc.call('duplicate-mcp', 'do_thing', {}, internal)).rejects.toThrow(
        /unavailable/
      )
      expect(mcpClientManager.listTools).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()
    })

    it('does not discover or dispatch a custom server blocked while approval is pending', async () => {
      const call = vi.fn()
      const mcpClientManager = manager(call)
      let connectors = {
        enabledIds: [] as string[],
        autoAllowIds: [] as string[],
        askToolIds: ['myserver/do_thing'],
        blockedToolIds: [] as string[],
        customMcpServers: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'myserver',
            displayName: 'My server',
            transport: 'stdio' as const,
            command: 'server-command',
            enabled: true
          }
        ]
      }
      let settleApproval: ((decision: 'once') => void) | undefined
      const requestApproval = vi.fn(
        () =>
          new Promise<'once'>((resolve) => {
            settleApproval = resolve
          })
      )
      const svc = new ConnectorService({
        mcpClientManager,
        getConnectors: () => connectors,
        getConnectorsFresh: async () => connectors,
        resolveApiKey: () => undefined,
        requestApproval
      })

      const pendingCall = svc.call('myserver', 'do_thing', {}, internal)
      await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledOnce())
      connectors = { ...connectors, blockedToolIds: ['myserver/do_thing'] }
      settleApproval?.('once')

      await expect(pendingCall).rejects.toThrow(/blocked by policy/)
      expect(mcpClientManager.listTools).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()
    })

    it('does not discover a custom server from a stale cached Allow after durable Block', async () => {
      const call = vi.fn()
      const mcpClientManager = manager(call)
      const customMcpServers = [
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'myserver',
          displayName: 'My server',
          transport: 'stdio' as const,
          command: 'server-command',
          enabled: true
        }
      ]
      const cached = {
        enabledIds: [] as string[],
        autoAllowIds: ['myserver'],
        askToolIds: [] as string[],
        blockedToolIds: [] as string[],
        customMcpServers
      }
      const durable = {
        ...cached,
        blockedToolIds: ['myserver/do_thing']
      }
      const svc = new ConnectorService({
        mcpClientManager,
        getConnectors: () => cached,
        getConnectorsFresh: vi.fn().mockResolvedValue(durable),
        resolveApiKey: () => undefined,
        requestApproval: vi.fn()
      })

      await expect(svc.call('myserver', 'do_thing', {}, internal)).rejects.toThrow(
        /blocked by policy/
      )
      expect(mcpClientManager.listTools).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()
    })

    it('discovers a newly durable custom server before its cached projection refreshes', async () => {
      const call = vi.fn().mockResolvedValue({ ok: true })
      const mcpClientManager = manager(call)
      const durable = {
        enabledIds: [] as string[],
        autoAllowIds: [] as string[],
        customMcpServers: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'myserver',
            displayName: 'My server',
            transport: 'stdio' as const,
            command: 'server-command',
            enabled: true
          }
        ]
      }
      const svc = new ConnectorService({
        mcpClientManager,
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: []
        }),
        getConnectorsFresh: vi.fn().mockResolvedValue(durable),
        resolveApiKey: () => undefined
      })

      await expect(svc.call('myserver', 'do_thing', {}, internal)).resolves.toEqual({ ok: true })
      expect(mcpClientManager.listTools).toHaveBeenCalledOnce()
      expect(call).toHaveBeenCalledOnce()
    })

    it('routes a call to a remote (streamable_http) custom server with its url/headers', async () => {
      const call = vi.fn().mockResolvedValue({ ok: true })
      const svc = new ConnectorService({
        mcpClientManager: manager(call),
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [
            {
              id: 'srv-remote',
              name: 'remoteserver',
              displayName: 'Remote server',
              transport: 'streamable_http',
              url: 'https://example.com/mcp',
              headers: { Authorization: 'Bearer token' },
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined
      })
      const out = await svc.call('remoteserver', 'do_thing', { x: 1 }, internal)
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
        mcpClientManager: manager(call),
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [
            {
              id: 'srv-1',
              name: 'myserver',
              displayName: 'My server',
              transport: 'stdio',
              command: 'npx',
              enabled: false
            }
          ]
        }),
        resolveApiKey: () => undefined
      })
      await expect(svc.call('myserver', 'do_thing', {}, internal)).rejects.toThrow(
        'Connector "My server" is disabled. Do not retry with guessed Connector names. Ask the user to enable it in Settings > Connectors, then retry the same call.'
      )
      expect(call).not.toHaveBeenCalled()
    })

    it('rejects a blocked tool on a custom server', async () => {
      const call = vi.fn()
      const listTools = vi.fn().mockResolvedValue([{ name: 'dangerous' }])
      const resolve = vi.fn().mockResolvedValue({ matchedScope: 'global' })
      const requestApproval = vi.fn().mockResolvedValue('once')
      const svc = new ConnectorService({
        mcpClientManager: {
          call: call as never,
          listTools
        },
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: ['myserver'],
          askToolIds: ['myserver/dangerous'],
          blockedToolIds: ['myserver/dangerous'],
          customMcpServers: [
            {
              id: 'srv-1',
              name: 'myserver',
              displayName: 'My server',
              transport: 'stdio',
              command: 'npx',
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined,
        permissionGrantRegistry: { resolve } as never,
        requestApproval
      })
      await expect(svc.call('myserver', 'dangerous', {}, internal)).rejects.toThrow(
        /blocked by policy/
      )
      expect(listTools).not.toHaveBeenCalled()
      expect(resolve).not.toHaveBeenCalled()
      expect(requestApproval).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()
    })

    it('rejects a call to an unknown server name (neither bundled nor custom)', async () => {
      const svc = new ConnectorService({
        getConnectors: () => ({ enabledIds: [], autoAllowIds: [], customMcpServers: [] }),
        resolveApiKey: () => undefined
      })
      await expect(svc.call('nope', 'do_thing', {}, internal)).rejects.toThrow(
        'Connector "nope" is unavailable. Do not retry with guessed Connector names. Use only Connector names and methods documented by a loaded mcp-* Skill. If the required Skill is unavailable, ask the user to enable or add the Connector in Settings > Connectors, then retry.'
      )
    })

    it('threads context.sessionId through to requestApproval for custom MCP tools', async () => {
      const call = vi.fn().mockResolvedValue({ ok: true })
      const requestApproval = vi.fn().mockResolvedValue('once')
      const svc = new ConnectorService({
        mcpClientManager: manager(call),
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          askToolIds: ['myserver/do_thing'],
          customMcpServers: [
            {
              id: 'srv-1',
              name: 'myserver',
              displayName: 'My server',
              transport: 'stdio',
              command: 'npx',
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined,
        requestApproval
      })

      await svc.call(
        'myserver',
        'do_thing',
        { x: 1 },
        { origin: 'internal', sessionId: 'session-99' }
      )

      expect(requestApproval).toHaveBeenCalledWith({
        connector: 'My server',
        method: 'do_thing',
        args: { x: 1 },
        sessionId: 'session-99',
        availableScopes: ['once']
      })
    })

    it('does not connect an Ask-policy custom server before approval', async () => {
      const call = vi.fn()
      const listTools = vi.fn().mockResolvedValue([{ name: 'do_thing' }])
      const requestApproval = vi.fn().mockResolvedValue('deny')
      const svc = new ConnectorService({
        mcpClientManager: { call: call as never, listTools },
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          askToolIds: ['myserver/do_thing'],
          customMcpServers: [
            {
              id: 'srv-1',
              name: 'myserver',
              displayName: 'My server',
              transport: 'streamable_http',
              url: 'https://private.example/mcp',
              headers: { Authorization: 'Bearer secret' },
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined,
        requestApproval
      })

      await expect(svc.call('myserver', 'do_thing', {}, internal)).rejects.toThrow(/denied by user/)

      expect(requestApproval).toHaveBeenCalledOnce()
      expect(listTools).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()
    })

    it('persists a broad custom MCP grant only after validating the approved method', async () => {
      const events: string[] = []
      const requestApproval = vi.fn(async () => {
        events.push('approval')
        return 'project' as const
      })
      const listTools = vi.fn(async () => {
        events.push('listTools')
        return [{ name: 'do_thing' }]
      })
      const remember = vi.fn(async () => {
        events.push('remember')
        return {}
      })
      const call = vi.fn(async () => {
        events.push('call')
        return { ok: true }
      })
      const svc = new ConnectorService({
        mcpClientManager: { call: call as never, listTools },
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          askToolIds: ['myserver/do_thing'],
          customMcpServers: [
            {
              id: 'srv-stable',
              name: 'myserver',
              displayName: 'My server',
              transport: 'stdio',
              command: 'npx',
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined,
        requestApproval,
        permissionGrantRegistry: { resolve: vi.fn(), remember } as never
      })

      await expect(
        svc.call(
          'myserver',
          'do_thing',
          { x: 1 },
          { origin: 'internal', sessionId: 'session-1', projectId: 'project-1' }
        )
      ).resolves.toEqual({ ok: true })

      expect(events).toEqual(['approval', 'listTools', 'remember', 'call'])
      expect(remember).toHaveBeenCalledWith({
        capability: { kind: 'mcp_tool', key: 'mcp:srv-stable/do_thing' },
        scope: { kind: 'project', projectId: 'project-1' }
      })
    })

    it('rejects a pending approval when the custom server security configuration changes', async () => {
      const original = {
        id: 'srv-stable',
        name: 'myserver',
        displayName: 'My server',
        transport: 'stdio' as const,
        command: 'old-command',
        enabled: true
      }
      const replacement = {
        ...original,
        command: 'new-command'
      }
      let current = original
      let approve: ((decision: 'global') => void) | undefined
      const requestApproval = vi.fn(
        () =>
          new Promise<'global' | 'once'>((resolve) => {
            approve = (decision) => resolve(decision)
          })
      )
      const remember = vi.fn()
      const call = vi.fn()
      const listTools = vi.fn().mockResolvedValue([{ name: 'do_thing' }])
      const svc = new ConnectorService({
        mcpClientManager: { call: call as never, listTools },
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          askToolIds: ['myserver/do_thing'],
          customMcpServers: [current]
        }),
        resolveApiKey: () => undefined,
        requestApproval,
        permissionGrantRegistry: { resolve: vi.fn(), remember } as never
      })

      const pendingCall = svc.call(
        'myserver',
        'do_thing',
        {},
        { origin: 'internal', sessionId: 'session-1', projectId: 'project-1' }
      )
      await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledOnce())

      const guard = svc.beginCustomServerSecurityChange(original.id)
      current = replacement
      guard.commit(replacement)
      approve?.('global')

      await expect(pendingCall).rejects.toThrow(
        'connector call rejected: connector_configuration_changed. The Connector configuration changed before the external tool was called. Retry the exact same call once.'
      )
      expect(listTools).not.toHaveBeenCalled()
      expect(remember).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()

      requestApproval.mockResolvedValueOnce('once')
      call.mockResolvedValueOnce({ ok: true })
      await expect(
        svc.call(
          'myserver',
          'do_thing',
          {},
          { origin: 'internal', sessionId: 'session-1', projectId: 'project-1' }
        )
      ).resolves.toEqual({ ok: true })
      expect(listTools).toHaveBeenCalledOnce()
      expect(call).toHaveBeenCalledOnce()
    })

    it('treats a pre-registered OAuth client-secret ref as security-sensitive', async () => {
      const original = {
        id: 'srv-oauth-static',
        name: 'oauth-static',
        displayName: 'OAuth static',
        transport: 'streamable_http' as const,
        url: 'https://mcp.example.test',
        oauth: {
          authorizationServerUrl: 'https://auth.example.test',
          clientId: 'registered-client'
        },
        oauthClientSecretRef: 'enc:old-secret',
        oauthState: { tokens: { access_token: 'access', token_type: 'Bearer' as const } },
        enabled: true
      }
      const replacement = { ...original, oauthClientSecretRef: 'enc:new-secret' }
      let current = original
      let approve: ((decision: 'once') => void) | undefined
      const requestApproval = vi.fn(
        () =>
          new Promise<'once'>((resolve) => {
            approve = resolve
          })
      )
      const call = vi.fn()
      const listTools = vi.fn().mockResolvedValue([{ name: 'lookup' }])
      const svc = new ConnectorService({
        mcpClientManager: { call: call as never, listTools },
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          askToolIds: ['oauth-static/lookup'],
          customMcpServers: [current]
        }),
        resolveApiKey: () => undefined,
        requestApproval
      })

      const pendingCall = svc.call('oauth-static', 'lookup', {}, internal)
      await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledOnce())
      const guard = svc.beginCustomServerSecurityChange(original.id)
      current = replacement
      guard.commit(replacement)
      approve?.('once')

      await expect(pendingCall).rejects.toThrow('connector_configuration_changed')
      expect(listTools).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()
    })

    it('fails closed after a custom connector cannot authenticate or start, without exposing its error', async () => {
      const call = vi
        .fn()
        .mockRejectedValue(
          new Error('401 Unauthorized for https://private.example with Bearer SECRET')
        )
      const onCustomServerAvailabilityChanged = vi.fn()
      const svc = new ConnectorService({
        mcpClientManager: manager(call, ['lookup']),
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [
            {
              id: 'srv-1',
              name: 'secured-server',
              displayName: 'Secured server',
              transport: 'streamable_http',
              url: 'https://private.example/mcp',
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined,
        onCustomServerAvailabilityChanged,
        resolveSpecialistProfile: async () => ({
          id: 'specialist-1',
          name: 'Secured Server Bot',
          description: '',
          systemPrompt: 'profile secret',
          enabled: true,
          capabilityMode: 'selected',
          fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
          selectedCapabilities: {
            skillIds: [],
            connectorIds: ['secured-server'],
            connectorTools: []
          },
          revision: 1
        })
      })
      const context = {
        origin: 'agent' as const,
        sessionId: 'specialist-session',
        specialistId: 'specialist-1'
      }
      await expect(
        svc.call('secured-server', 'lookup', { token: 'ARG_SECRET' }, context)
      ).rejects.toThrow('connector_unauthenticated')
      await expect(
        svc.call('secured-server', 'lookup', { token: 'ARG_SECRET' }, context)
      ).rejects.toThrow('connector_unauthenticated')
      expect(call).toHaveBeenCalledTimes(1)
      expect(onCustomServerAvailabilityChanged).toHaveBeenCalledOnce()
      expect(onCustomServerAvailabilityChanged).toHaveBeenCalledWith('srv-1', 'unauthenticated')
      await svc
        .call('secured-server', 'lookup', { token: 'ARG_SECRET' }, context)
        .catch((error: Error) => {
          expect(error.message).not.toContain('ARG_SECRET')
          expect(error.message).not.toContain('SECRET')
          expect(error.message).not.toContain('private.example')
        })
    })

    it('backs off before probing a custom MCP server after a transient connection failure', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-08-22T00:00:00.000Z'))
      const failedClient = {
        listTools: vi.fn().mockRejectedValue(new Error('Connection closed')),
        close: vi.fn().mockResolvedValue(undefined)
      } as unknown as Client
      const recoveredClient = {
        listTools: vi.fn().mockResolvedValue({ tools: [{ name: 'lookup' }] }),
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: JSON.stringify({ ok: true }) }]
        }),
        close: vi.fn().mockResolvedValue(undefined)
      } as unknown as Client
      const createClient = vi
        .fn()
        .mockResolvedValueOnce(failedClient)
        .mockResolvedValueOnce(recoveredClient)
      const mcpClientManager = new McpClientManager({ createClient })
      try {
        const svc = new ConnectorService({
          mcpClientManager,
          getConnectors: () => ({
            enabledIds: [],
            autoAllowIds: [],
            customMcpServers: [
              {
                id: 'srv-transient',
                name: 'transient-server',
                displayName: 'Transient server',
                transport: 'streamable_http',
                url: 'https://mcp.example.test',
                enabled: true
              }
            ]
          }),
          resolveApiKey: () => undefined
        })

        await expect(svc.call('transient-server', 'lookup', {}, internal)).rejects.toThrow(
          'connector_unavailable'
        )
        await expect(svc.call('transient-server', 'lookup', {}, internal)).rejects.toThrow(
          'connector_unavailable'
        )
        expect(createClient).toHaveBeenCalledOnce()

        await vi.advanceTimersByTimeAsync(1_000)

        await expect(svc.call('transient-server', 'lookup', {}, internal)).resolves.toEqual({
          ok: true
        })
        expect(createClient).toHaveBeenCalledTimes(2)
      } finally {
        await mcpClientManager.closeAll()
        vi.useRealTimers()
      }
    })

    it('does not contact an OAuth connector before it has tokens', async () => {
      const call = vi.fn()
      const mcpClientManager = manager(call)
      const svc = new ConnectorService({
        mcpClientManager,
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [
            {
              id: 'oauth-1',
              name: 'oauth-server',
              displayName: 'OAuth server',
              transport: 'streamable_http',
              url: 'https://mcp.example.test',
              oauth: {},
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined
      })

      await expect(svc.call('oauth-server', 'lookup', {}, internal)).rejects.toThrow(
        'connector call rejected: connector_unauthenticated. Connector authentication is required. Do not retry until the user signs in from Settings > Connectors, then retry the same call.'
      )
      expect(mcpClientManager.listTools).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()
    })

    it('records structured authentication failures for a host-managed OAuth connector', async () => {
      const call = vi.fn().mockRejectedValue(new McpToolCallError('Not logged in. Sign in again.'))
      const onCustomServerAvailabilityChanged = vi.fn()
      const svc = new ConnectorService({
        mcpClientManager: manager(call, ['lookup']),
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [
            {
              id: 'oauth-1',
              name: 'oauth-server',
              displayName: 'OAuth server',
              transport: 'streamable_http',
              url: 'https://mcp.example.test',
              oauth: {},
              oauthState: { tokens: { access_token: 'stale', token_type: 'Bearer' } },
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined,
        onCustomServerAvailabilityChanged
      })

      await expect(svc.call('oauth-server', 'lookup', {}, internal)).rejects.toThrow(
        'connector_unauthenticated'
      )
      await expect(svc.call('oauth-server', 'lookup', {}, internal)).rejects.toThrow(
        'connector_unauthenticated'
      )
      expect(call).toHaveBeenCalledOnce()
      expect(onCustomServerAvailabilityChanged).toHaveBeenCalledWith('oauth-1', 'unauthenticated')
    })

    it('keeps a connector-managed authentication tool reachable after a sign-in error', async () => {
      const call = vi
        .fn()
        .mockRejectedValueOnce(new McpToolCallError('Not logged in. Call login first.'))
        .mockResolvedValueOnce({ authenticated: true })
      const svc = new ConnectorService({
        mcpClientManager: manager(call, ['status', 'login']),
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [
            {
              id: 'content-service-id',
              name: 'content-service',
              displayName: 'Content service',
              transport: 'stdio',
              command: 'content-service-mcp',
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined
      })

      await expect(svc.call('content-service', 'status', {}, internal)).rejects.toThrow(
        'connector_unauthenticated'
      )
      await expect(svc.call('content-service', 'login', {}, internal)).resolves.toEqual({
        authenticated: true
      })
      expect(call).toHaveBeenCalledTimes(2)
    })

    it('recovers from a cached authentication failure after successful sign-in', async () => {
      const call = vi
        .fn()
        .mockRejectedValueOnce(new Error('401 Unauthorized'))
        .mockResolvedValueOnce({ ok: true })
      const onCustomServerAvailabilityChanged = vi.fn()
      const svc = new ConnectorService({
        mcpClientManager: manager(call, ['lookup']),
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [
            {
              id: 'srv-1',
              name: 'secured-server',
              displayName: 'Secured server',
              transport: 'streamable_http',
              url: 'https://mcp.example.test',
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined,
        onCustomServerAvailabilityChanged
      })

      await expect(svc.call('secured-server', 'lookup', {}, internal)).rejects.toThrow(
        'connector_unauthenticated'
      )
      await expect(svc.call('secured-server', 'lookup', {}, internal)).rejects.toThrow(
        'connector_unauthenticated'
      )
      expect(call).toHaveBeenCalledOnce()

      svc.clearCustomServerFailure('srv-1')

      expect(onCustomServerAvailabilityChanged).toHaveBeenLastCalledWith('srv-1', undefined)

      await expect(svc.call('secured-server', 'lookup', {}, internal)).resolves.toEqual({
        ok: true
      })
      expect(call).toHaveBeenCalledTimes(2)
    })

    it('publishes recovery when a concurrent custom Connector call succeeds', async () => {
      let rejectFirst: ((error: Error) => void) | undefined
      let resolveSecond: ((value: unknown) => void) | undefined
      const call = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              rejectFirst = reject
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSecond = resolve
            })
        )
      const onCustomServerAvailabilityChanged = vi.fn()
      const svc = new ConnectorService({
        mcpClientManager: manager(call, ['lookup']),
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [
            {
              id: 'srv-1',
              name: 'concurrent-server',
              displayName: 'Concurrent server',
              transport: 'stdio',
              command: 'mcp',
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined,
        onCustomServerAvailabilityChanged
      })

      const first = expect(svc.call('concurrent-server', 'lookup', {}, internal)).rejects.toThrow(
        'connector_unavailable'
      )
      const second = svc.call('concurrent-server', 'lookup', {}, internal)
      await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))

      rejectFirst?.(new Error('Connection closed'))
      await first
      expect(onCustomServerAvailabilityChanged).toHaveBeenLastCalledWith('srv-1', 'unavailable')

      resolveSecond?.({ ok: true })
      await expect(second).resolves.toEqual({ ok: true })
      expect(onCustomServerAvailabilityChanged).toHaveBeenLastCalledWith('srv-1', undefined)
    })

    it('does not restore a cached failure from a request started before sign-in', async () => {
      let rejectStaleList: ((error: Error) => void) | undefined
      const listTools = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Array<{ name: string }>>((_, reject) => {
              rejectStaleList = reject
            })
        )
        .mockResolvedValue([{ name: 'lookup' }])
      const call = vi.fn().mockResolvedValue({ ok: true })
      const svc = new ConnectorService({
        mcpClientManager: { listTools, call },
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [
            {
              id: 'srv-1',
              name: 'secured-server',
              displayName: 'Secured server',
              transport: 'streamable_http',
              url: 'https://mcp.example.test',
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined
      })

      const staleCall = svc.call('secured-server', 'lookup', {}, internal)
      await vi.waitFor(() => expect(listTools).toHaveBeenCalledOnce())

      svc.clearCustomServerFailure('srv-1')
      rejectStaleList?.(new Error('401 Unauthorized'))
      await expect(staleCall).rejects.toThrow('connector_unauthenticated')

      await expect(svc.call('secured-server', 'lookup', {}, internal)).resolves.toEqual({
        ok: true
      })
      expect(listTools).toHaveBeenCalledTimes(2)
      expect(call).toHaveBeenCalledOnce()
    })

    it('resolves remembered grants by immutable custom server id after a display-name edit', async () => {
      const call = vi.fn().mockResolvedValue({ ok: true })
      const requestApproval = vi.fn().mockResolvedValue('once')
      const resolve = vi.fn().mockResolvedValue({ matchedScope: 'session' })
      const svc = new ConnectorService({
        mcpClientManager: manager(call),
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          askToolIds: ['stable-server/do_thing'],
          customMcpServers: [
            {
              id: 'srv-stable',
              name: 'stable-server',
              displayName: 'Renamed server',
              transport: 'stdio',
              command: 'npx',
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined,
        requestApproval,
        permissionGrantRegistry: { resolve } as never
      })

      await svc.call(
        'stable-server',
        'do_thing',
        { x: 1 },
        { origin: 'internal', sessionId: 'session-1', projectId: 'project-1' }
      )

      expect(resolve).toHaveBeenCalledWith(
        { kind: 'mcp_tool', key: 'mcp:srv-stable/do_thing' },
        {
          origin: 'internal',
          sessionId: 'session-1',
          projectId: 'project-1'
        }
      )
      expect(requestApproval).not.toHaveBeenCalled()
    })

    it('does not remember a broad approval for an unregistered custom method', async () => {
      const call = vi.fn()
      const requestApproval = vi.fn().mockResolvedValue('global')
      const remember = vi.fn()
      const svc = new ConnectorService({
        mcpClientManager: manager(call, ['registered_method']),
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          askToolIds: ['myserver/future_method'],
          customMcpServers: [
            {
              id: 'srv-1',
              name: 'myserver',
              displayName: 'My server',
              transport: 'stdio',
              command: 'npx',
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined,
        requestApproval,
        permissionGrantRegistry: { resolve: vi.fn(), remember } as never
      })

      await expect(
        svc.call(
          'myserver',
          'future_method',
          {},
          { origin: 'internal', sessionId: 'session-1', projectId: 'project-1' }
        )
      ).rejects.toThrow(/unknown tool/)
      expect(requestApproval).toHaveBeenCalledOnce()
      expect(remember).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()
    })
  })
})

describe('ConnectorService specialist capability gate', () => {
  const specialist = (overrides: Partial<SpecialistView> = {}): SpecialistView => ({
    id: 'specialist-1',
    name: 'Connector Bot',
    description: '',
    systemPrompt: 'do not disclose profile-secret-prompt',
    enabled: true,
    capabilityMode: 'full',
    fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
    selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
    revision: 1,
    ...overrides
  })

  it('uses the fresh durable OpenAlex credential for Specialist calls', async () => {
    const staleConnectors = {
      enabledIds: [] as string[],
      autoAllowIds: [] as string[],
      openAlexApiKeyRef: 'stale-ref'
    }
    let currentConnectors = {
      ...staleConnectors,
      openAlexApiKeyRef: 'current-ref' as string | undefined
    }
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ meta: { count: 0 }, results: [] }))
    const current = specialist()
    const svc = new ConnectorService({
      engine: new ParserEngine({ fetchImpl }),
      getConnectors: () => staleConnectors,
      getConnectorsFresh: async () => currentConnectors,
      resolveApiKey: (ref) =>
        ref === 'stale-ref' ? 'STALE_KEY' : ref === 'current-ref' ? 'CURRENT_KEY' : undefined,
      resolveSpecialistProfile: async () => current
    })
    const context = {
      origin: 'agent' as const,
      sessionId: 'specialist-openalex',
      specialistId: current.id
    }

    await svc.call(
      'literature',
      'openalex_search_works',
      { query: 'CRISPR', max_records: 1 },
      context
    )
    expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('api_key')).toBe(
      'CURRENT_KEY'
    )

    currentConnectors = { ...currentConnectors, openAlexApiKeyRef: undefined }
    await expect(
      svc.call('literature', 'openalex_search_works', { query: 'RNA', max_records: 1 }, context)
    ).rejects.toThrow(/credential_required/)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([
    ['disabled', specialist({ enabled: false }), /specialist_unavailable/],
    ['deleted', undefined, /specialist_unavailable/],
    [
      'removed from the Connector scope',
      specialist({
        capabilityMode: 'selected',
        selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] }
      }),
      /specialist_capability_denied/
    ]
  ] as const)(
    'does not dispatch OpenAlex when the Specialist is %s during credential recovery',
    async (_change, revokedProfile, expectedError) => {
      let connectors = {
        enabledIds: [] as string[],
        autoAllowIds: [] as string[],
        openAlexApiKeyRef: undefined as string | undefined
      }
      let current: SpecialistProfileView | undefined = specialist()
      let settleCredential: ((configured: boolean) => void) | undefined
      const fetchImpl = vi.fn()
      const requestCredential = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            settleCredential = resolve
          })
      )
      const svc = new ConnectorService({
        engine: new ParserEngine({ fetchImpl }),
        getConnectors: () => connectors,
        getConnectorsFresh: async () => connectors,
        resolveApiKey: (ref) => (ref === 'encrypted-ref' ? 'OPENALEX_KEY' : undefined),
        resolveSpecialistProfile: async () => current,
        requestCredential
      })
      const call = svc.call(
        'literature',
        'openalex_search_works',
        { query: 'CRISPR', max_records: 1 },
        {
          origin: 'agent',
          sessionId: 'specialist-credential-recovery',
          specialistId: 'specialist-1'
        }
      )

      await vi.waitFor(() => expect(requestCredential).toHaveBeenCalledOnce())
      current = revokedProfile
      connectors = { ...connectors, openAlexApiKeyRef: 'encrypted-ref' }
      settleCredential?.(true)

      await expect(call).rejects.toThrow(expectedError)
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it('keeps Main and Specialist connector scopes independent and enforces both modes before dispatch', async () => {
    const localHandler = vi.fn().mockResolvedValue({ ok: true })
    let current = specialist()
    const svc = new ConnectorService({
      engine: { call: vi.fn() } as unknown as ParserEngine,
      getConnectors: () => ({
        enabledIds: [],
        autoAllowIds: [],
        disabledConnectorIds: ['molecule'],
        blockedToolIds: ['molecule/preview_molecule']
      }),
      resolveApiKey: () => undefined,
      resolveSpecialistProfile: async () => current,
      localToolHandlers: { 'molecule/preview_molecule': localHandler }
    })

    // Main remains disabled, while a Specialist that explicitly has Full access can use the installed
    // connector without inheriting Main's block list.
    await expect(
      svc.call('molecule', 'preview_molecule', { smiles: 'SECRET_ARGS' }, internal)
    ).rejects.toThrow(/Connector "molecule" is disabled/)
    for (const framework of ['claude-code', 'codex', 'opencode']) {
      await expect(
        svc.call(
          'molecule',
          'preview_molecule',
          { smiles: 'SECRET_ARGS' },
          { origin: 'agent', sessionId: `session-${framework}`, specialistId: current.id }
        )
      ).resolves.toEqual({ ok: true })
    }
    expect(localHandler).toHaveBeenCalledTimes(3)

    current = specialist({
      capabilityMode: 'full',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: ['molecule'], connectorTools: [] }
    })
    await expect(
      svc.call(
        'molecule',
        'preview_molecule',
        { smiles: 'SECRET_ARGS' },
        {
          origin: 'agent',
          sessionId: 'full-excluded',
          specialistId: current.id
        }
      )
    ).rejects.toThrow(
      "connector call rejected: specialist_capability_denied. The current Specialist is not allowed to use this Connector. Do not retry from this Specialist. Use an allowed Connector, or ask the user to update this Specialist's Connector access in Settings > Specialists, then retry the same call."
    )

    current = specialist({
      capabilityMode: 'selected',
      selectedCapabilities: { skillIds: [], connectorIds: ['chemistry'], connectorTools: [] }
    })
    await expect(
      svc.call(
        'molecule',
        'preview_molecule',
        { smiles: 'SECRET_ARGS' },
        {
          origin: 'agent',
          sessionId: 'selected-omitted',
          specialistId: current.id
        }
      )
    ).rejects.toThrow('specialist_capability_denied')
    expect(localHandler).toHaveBeenCalledTimes(3)
  })

  it('accepts a custom Connector local UUID or legacy public name as a capability reference', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true })
    const listTools = vi.fn().mockResolvedValue([{ name: 'do_thing' }])
    let current = specialist({
      capabilityMode: 'selected',
      selectedCapabilities: {
        skillIds: [],
        connectorIds: ['custom-server-uuid'],
        connectorTools: []
      }
    })
    const svc = new ConnectorService({
      mcpClientManager: { call, listTools },
      getConnectors: () => ({
        enabledIds: [],
        autoAllowIds: [],
        customMcpServers: [
          {
            id: 'custom-server-uuid',
            name: 'public-route',
            displayName: 'Public Route',
            transport: 'stdio',
            command: 'npx',
            enabled: true
          }
        ]
      }),
      resolveApiKey: () => undefined,
      resolveSpecialistProfile: async () => current
    })
    const context = {
      origin: 'agent' as const,
      sessionId: 'legacy-specialist-session',
      specialistId: current.id
    }

    await expect(svc.call('public-route', 'do_thing', {}, context)).resolves.toEqual({ ok: true })

    current = specialist({
      capabilityMode: 'selected',
      selectedCapabilities: {
        skillIds: [],
        connectorIds: ['public-route'],
        connectorTools: []
      }
    })
    await expect(svc.call('public-route', 'do_thing', {}, context)).resolves.toEqual({ ok: true })

    current = specialist({
      capabilityMode: 'full',
      fullAccess: {
        excludedSkillIds: [],
        excludedConnectorIds: ['custom-server-uuid'],
        connectorTools: []
      }
    })
    await expect(svc.call('public-route', 'do_thing', {}, context)).rejects.toThrow(
      'specialist_capability_denied'
    )
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('fails closed for missing agent session/profile/connector without exposing call data', async () => {
    const localHandler = vi.fn()
    const svc = new ConnectorService({
      engine: { call: vi.fn() } as unknown as ParserEngine,
      getConnectors: () => ({ enabledIds: [], autoAllowIds: [] }),
      resolveApiKey: () => undefined,
      resolveSpecialistProfile: async () =>
        specialist({
          capabilityMode: 'selected',
          selectedCapabilities: {
            skillIds: [],
            connectorIds: ['not-installed'],
            connectorTools: []
          }
        }),
      localToolHandlers: { 'molecule/preview_molecule': localHandler }
    })
    await expect(
      svc.call('molecule', 'preview_molecule', { token: 'SECRET_ARGS' }, { origin: 'agent' })
    ).rejects.toThrow(
      'connector call rejected: missing_session. The Connector call could not be associated with the current Session. Do not retry this call. Ask the user to start a new Session before retrying.'
    )
    await expect(
      svc.call(
        'not-installed',
        'run',
        { token: 'SECRET_ARGS' },
        {
          origin: 'agent',
          sessionId: 'specialist-session',
          specialistId: 'specialist-1'
        }
      )
    ).rejects.toThrow('connector_unavailable')
    await svc
      .call(
        'not-installed',
        'run',
        { token: 'SECRET_ARGS' },
        {
          origin: 'agent',
          sessionId: 'specialist-session',
          specialistId: 'specialist-1'
        }
      )
      .catch((error: Error) => {
        expect(error.message).not.toContain('SECRET_ARGS')
        expect(error.message).not.toContain('profile-secret-prompt')
      })
    expect(localHandler).not.toHaveBeenCalled()
  })

  it('allows only explicitly marked internal calls to bypass the agent session gate', async () => {
    const localHandler = vi.fn().mockResolvedValue({ ok: true })
    const svc = new ConnectorService({
      engine: { call: vi.fn() } as unknown as ParserEngine,
      getConnectors: () => ({ enabledIds: [], autoAllowIds: [] }),
      resolveApiKey: () => undefined,
      localToolHandlers: { 'molecule/preview_molecule': localHandler }
    })
    await expect(
      svc.call('molecule', 'preview_molecule', {}, { origin: 'internal' })
    ).resolves.toEqual({ ok: true })
    await expect(svc.call('molecule', 'preview_molecule', {})).rejects.toThrow('missing_session')
  })

  it('gives actionable guidance when the Specialist or Connector runtime is unavailable', async () => {
    const customMcpServers = [
      {
        id: 'server-1',
        name: 'custom-server',
        displayName: 'Custom server',
        transport: 'stdio' as const,
        command: 'custom-server',
        enabled: true
      }
    ]
    const svc = new ConnectorService({
      getConnectors: () => ({ enabledIds: [], autoAllowIds: [], customMcpServers }),
      resolveApiKey: () => undefined
    })

    await expect(
      svc.call(
        'custom-server',
        'lookup',
        {},
        { origin: 'agent', sessionId: 'session-1', specialistId: 'missing-specialist' }
      )
    ).rejects.toThrow(
      'connector call rejected: specialist_unavailable. The current Specialist is unavailable. Do not retry from this Specialist. Ask the user to switch to Main Agent or an available Specialist, then retry the same call.'
    )
    await expect(svc.call('custom-server', 'lookup', {}, internal)).rejects.toThrow(
      'connector call rejected: connector_runtime_unavailable. The Connector runtime is unavailable. Wait briefly and retry the same call once. If it fails again, ask the user to restart Open Science before retrying.'
    )
  })
})
