import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createResearchMcpServer } from './mcp.mjs'
import { OpenScienceApiError, OpenScienceClient } from './index.mjs'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()))
})

async function harness(connect: ReturnType<typeof vi.fn>): Promise<{
  server: ReturnType<typeof createResearchMcpServer>
  client: Client
}> {
  const server = createResearchMcpServer({ configRoot: '/test-profile', version: '1.0.3', connect })
  const client = new Client({ name: 'test-agent', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  cleanup.push(async () => {
    await client.close()
    await server.close()
  })
  return { server, client }
}

const cases = [
  ['doctor', {}, '/api/v1/doctor', 'GET', undefined],
  ['list_runtimes', {}, '/api/v1/runtimes', 'GET', undefined],
  ['list_projects', {}, '/api/v1/projects', 'GET', undefined],
  [
    'create_project',
    { name: 'Research', agentContext: 'Use controls' },
    '/api/v1/projects',
    'POST',
    { name: 'Research', agentContext: 'Use controls' }
  ],
  [
    'update_project',
    { projectId: 'p/1', agentContext: null },
    '/api/v1/projects/p%2F1',
    'PATCH',
    { agentContext: null }
  ],
  ['list_sessions', { projectId: 'p/1' }, '/api/v1/sessions?project=p%2F1', 'GET', undefined],
  ['get_session', { sessionId: 's/1' }, '/api/v1/sessions/s%2F1', 'GET', undefined],
  [
    'get_session_configuration',
    { sessionId: 's/1' },
    '/api/v1/sessions/s%2F1/config',
    'GET',
    undefined
  ],
  [
    'update_session_configuration',
    { sessionId: 's/1', expectedRevision: 4, memoryEnabled: false },
    '/api/v1/sessions/s%2F1/config',
    'PATCH',
    { expectedRevision: 4, memoryEnabled: false }
  ],
  [
    'start_run',
    {
      projectId: 'p1',
      sessionId: 's1',
      prompt: 'Continue',
      turnIntent: 'plan-first',
      agentConfiguration: { model: null }
    },
    '/api/v1/runs',
    'POST',
    {
      project: 'p1',
      sessionId: 's1',
      prompt: 'Continue',
      turnIntent: 'plan-first',
      agentConfiguration: { model: null }
    }
  ],
  ['get_run', { runId: 'r/1' }, '/api/v1/runs/r%2F1', 'GET', undefined],
  ['cancel_run', { runId: 'r/1' }, '/api/v1/runs/r%2F1/cancel', 'POST', undefined],
  ['get_plan', { sessionId: 's/1' }, '/api/v1/sessions/s%2F1/plan', 'GET', undefined],
  [
    'respond_plan',
    {
      sessionId: 's/1',
      response: { decision: 'approved', artifactVersionId: 'v1', expectedRevision: 3 }
    },
    '/api/v1/sessions/s%2F1/plan/respond',
    'POST',
    { decision: 'approved', artifactVersionId: 'v1', expectedRevision: 3 }
  ],
  [
    'respond_plan',
    { sessionId: 's/1', response: { feedback: 'Add controls' } },
    '/api/v1/sessions/s%2F1/plan/respond',
    'POST',
    { feedback: 'Add controls' }
  ],
  ['list_artifacts', { sessionId: 's/1' }, '/api/v1/sessions/s%2F1/artifacts', 'GET', undefined]
] as const

const rpcCases = [
  [
    'search_literature',
    { query: 'atlas', projectId: 'p1' },
    'literature:search',
    [{ scope: 'library', query: 'atlas', projectId: 'p1', limit: 20 }]
  ],
  ['get_literature_item', { itemId: 'i1' }, 'literature:get', ['i1']],
  ['list_citation_styles', {}, 'literature:citation-styles', [{ kind: 'list' }]],
  [
    'format_references',
    { itemIds: ['i1'], styleId: 'apa' },
    'literature:format-references',
    [{ itemIds: ['i1'], styleId: 'apa', locale: 'en-US' }]
  ],
  ['get_reference_metadata', { identifier: 'pmid:123' }, 'literature:lookup-metadata', ['pmid:123']]
] as const

const writeRpcCases = [
  [
    'import_literature',
    { mode: 'preview', content: '@article{a}' },
    'literature:import-records',
    [{ mode: 'preview', content: '@article{a}' }]
  ],
  [
    'update_project_literature',
    { projectId: 'p1', itemIds: ['i1', 'i1'], included: false },
    'literature:transact',
    [
      {
        kind: 'set-project-items',
        projectId: 'p1',
        itemIds: ['i1'],
        included: false,
        source: 'library'
      }
    ]
  ],
  [
    'create_literature_collection',
    { name: 'Methods' },
    'literature:transact',
    [{ kind: 'create-collection', name: 'Methods' }]
  ],
  [
    'update_collection_items',
    { collectionId: 'c1', itemIds: ['i1'], included: true },
    'literature:transact',
    [{ kind: 'set-collection-item', collectionId: 'c1', itemId: 'i1', included: true }]
  ],
  [
    'set_reading_status',
    { itemIds: ['i1'], readingStatus: 'read' },
    'literature:transact',
    [{ kind: 'set-reading-status', itemIds: ['i1'], readingStatus: 'read' }]
  ],
  [
    'set_literature_lifecycle',
    { itemIds: ['i1'], state: 'deleted' },
    'literature:transact',
    [{ kind: 'set-item-lifecycle', itemIds: ['i1'], state: 'deleted' }]
  ]
] as const

const rpcFetch = (
  respond: (channel: string, args: unknown[]) => unknown = () => ({})
): ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>> =>
  vi.fn(async (url: string, init: RequestInit) => {
    const channel = decodeURIComponent(url.split('/rpc/')[1])
    const result = respond(channel, JSON.parse(init.body as string).args)
    return result instanceof Response ? result : Response.json({ ok: true, result })
  })

describe('research MCP tools', () => {
  it('discovers descriptive snake_case tools without contacting the service', async () => {
    const connect = vi.fn()
    const { client } = await harness(connect)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        ...new Set(
          [...cases, ...rpcCases, ...writeRpcCases, ['create_literature_item']].map(
            ([name]) => name
          )
        )
      ].sort()
    )
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z]+(?:_[a-z]+)*$/)
      expect(tool.description!.length).toBeGreaterThan(30)
      expect(tool.inputSchema.additionalProperties).toBe(false)
      expect(tool.outputSchema).toBeDefined()
      expect(typeof tool.annotations?.readOnlyHint).toBe('boolean')
    }
    expect(connect).not.toHaveBeenCalled()
  })

  it.each(cases)('%s preserves the SDK HTTP contract', async (name, args, path, method, body) => {
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      Response.json({ data: { example: 'result' } })
    )
    const sdk = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 'private-token',
      fetch
    })
    const connect = vi.fn(async () => sdk)
    const { client } = await harness(connect)
    const response = await client.callTool({ name, arguments: args })
    expect(response.isError).not.toBe(true)
    expect(response.structuredContent).toEqual({ result: { example: 'result' } })
    expect(response.content).toEqual([
      { type: 'text', text: JSON.stringify(response.structuredContent) }
    ])
    const sentBody = fetch.mock.calls[0]?.[1]?.body
    expect(sentBody === undefined ? undefined : JSON.parse(sentBody as string)).toEqual(body)
    expect(connect).toHaveBeenCalledWith({
      configRoot: '/test-profile',
      signal: expect.any(AbortSignal)
    })
    expect(fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:44100${path}`,
      expect.objectContaining({
        method,
        body: body === undefined ? undefined : expect.any(String),
        headers: expect.objectContaining({ authorization: 'Bearer private-token' }),
        signal: expect.any(AbortSignal)
      })
    )
  })

  it.each(rpcCases)('%s is a read-only Web RPC call', async (name, args, channel, rpcArgs) => {
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      Response.json({ ok: true, result: { styles: [], id: 'i1' } })
    )
    const sdk = new OpenScienceClient({ baseUrl: 'http://127.0.0.1:44100', token: 't', fetch })
    const { client } = await harness(vi.fn(async () => sdk))
    const { tools } = await client.listTools()
    expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true)
    const response = await client.callTool({ name, arguments: args })
    expect(response.isError).not.toBe(true)
    expect(fetch.mock.calls[0][0]).toBe(`http://127.0.0.1:44100/rpc/${encodeURIComponent(channel)}`)
    expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual({
      protocolVersion: 1,
      args: rpcArgs
    })
  })

  it.each(writeRpcCases)('%s writes through Web RPC', async (name, args, channel, rpcArgs) => {
    const fetch = rpcFetch()
    const sdk = new OpenScienceClient({ baseUrl: 'http://127.0.0.1:44100', token: 't', fetch })
    const { client } = await harness(vi.fn(async () => sdk))
    const { tools } = await client.listTools()
    const annotations = tools.find((tool) => tool.name === name)?.annotations
    expect(annotations).toMatchObject({ readOnlyHint: false, openWorldHint: false })
    const response = await client.callTool({ name, arguments: args })
    expect(response.isError).not.toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe(`http://127.0.0.1:44100/rpc/${encodeURIComponent(channel)}`)
    expect(JSON.parse(fetch.mock.calls[0][1].body as string).args).toEqual(rpcArgs)
  })

  it('creates an item from resolved metadata', async () => {
    const item = { itemType: 'article-journal', title: 'Atlas' }
    const fetch = rpcFetch((channel) =>
      channel === 'literature:lookup-metadata' ? item : { kind: 'item', id: 'i1' }
    )
    const sdk = new OpenScienceClient({ baseUrl: 'http://127.0.0.1:44100', token: 't', fetch })
    const { client } = await harness(vi.fn(async () => sdk))
    const response = await client.callTool({
      name: 'create_literature_item',
      arguments: { identifier: '10.1000/atlas' }
    })
    expect(response.structuredContent).toEqual({ result: { kind: 'item', id: 'i1' } })
    expect(JSON.parse(fetch.mock.calls[1][1].body as string).args).toEqual([
      { kind: 'create-item', item }
    ])
  })

  it('links committed imports to a project and reports committed IDs when linking fails', async () => {
    const fetch = rpcFetch((channel) =>
      channel === 'literature:import-records'
        ? { entries: [], imported: { itemIds: ['i1', 'i2'], createdCount: 2, reusedCount: 0 } }
        : Response.json(
            { ok: false, error: { code: 'command-failed', message: 'x' } },
            { status: 500 }
          )
    )
    const sdk = new OpenScienceClient({ baseUrl: 'http://127.0.0.1:44100', token: 't', fetch })
    const { client } = await harness(vi.fn(async () => sdk))
    const response = await client.callTool({
      name: 'import_literature',
      arguments: { mode: 'commit', content: '@article{a}', projectId: 'p1' }
    })
    expect(response.isError).toBe(true)
    expect(JSON.parse((response.content as Array<{ text: string }>)[0].text).error).toMatchObject({
      code: 'literature_project_link_failed',
      itemIds: ['i1', 'i2']
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('identifies a missing item after a redacted formatter failure', async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async (url) =>
      url.endsWith(encodeURIComponent('literature:format-references'))
        ? Response.json(
            { ok: false, error: { code: 'command-failed', message: 'Internal' } },
            { status: 500 }
          )
        : Response.json({ ok: true })
    )
    const sdk = new OpenScienceClient({ baseUrl: 'http://127.0.0.1:44100', token: 't', fetch })
    const { client } = await harness(vi.fn(async () => sdk))
    const response = await client.callTool({
      name: 'format_references',
      arguments: { itemIds: ['gone', 'gone'], styleId: 'apa' }
    })
    expect(response.isError).toBe(true)
    expect(JSON.stringify(response)).toContain('literature_item_not_found')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('reports older services without Literature commands as unsupported', async () => {
    const sdk = new OpenScienceClient({
      baseUrl: 'http://127.0.0.1:44100',
      token: 't',
      fetch: async () =>
        Response.json(
          { ok: false, error: { code: 'method_not_found', message: 'SECRET' } },
          { status: 404 }
        )
    })
    const { client } = await harness(vi.fn(async () => sdk))
    const response = await client.callTool({ name: 'list_citation_styles', arguments: {} })
    expect(response.isError).toBe(true)
    expect(JSON.stringify(response)).toContain('unsupported_capability')
    expect(JSON.stringify(response)).not.toContain('SECRET')
  })

  it.each([
    ['get_session', {}],
    ['get_session', { sessionId: 's1', arbitrary: true }],
    ['update_session_configuration', { sessionId: 's1', expectedRevision: -1 }],
    ['respond_plan', { sessionId: 's1', response: { decision: 'approved' } }],
    [
      'respond_plan',
      {
        sessionId: 's1',
        response: {
          decision: 'rejected',
          artifactVersionId: 'v1',
          expectedRevision: 2,
          feedback: 'ambiguous'
        }
      }
    ],
    ['start_run', { projectId: 'p1', prompt: ' ' }],
    ['start_run', { projectId: 'p1', prompt: 'Go', permissionProfile: 'unknown' }],
    ['search_literature', { limit: 21 }],
    ['format_references', { itemIds: [], styleId: 'apa' }],
    ['import_literature', { mode: 'commit' }],
    ['import_literature', { mode: 'preview', content: 'x', projectId: 'p1' }],
    ['set_literature_lifecycle', { itemIds: ['i1'], state: 'purged' }],
    ['execute', { command: 'stop' }]
  ])('rejects invalid %s requests before connecting', async (name, args) => {
    const connect = vi.fn()
    const { client } = await harness(connect)
    const response = await client.callTool({
      name: name as string,
      arguments: args as Record<string, unknown>
    })
    expect(response.isError).toBe(true)
    expect(connect).not.toHaveBeenCalled()
  })

  it('rediscovers after an unavailable service, without retrying a write', async () => {
    const createProject = vi
      .fn()
      .mockRejectedValueOnce(new Error('token=SECRET'))
      .mockResolvedValueOnce({ id: 'p1' })
    const connect = vi
      .fn()
      .mockRejectedValueOnce(
        new OpenScienceApiError('private details', { code: 'daemon_unavailable' })
      )
      .mockResolvedValue({ createProject })
    const { client } = await harness(connect)
    const call = (): ReturnType<Client['callTool']> =>
      client.callTool({ name: 'create_project', arguments: { name: 'Research' } })
    expect(JSON.stringify(await call())).toContain('open-science start')
    const failedWrite = await call()
    expect(failedWrite.isError).toBe(true)
    expect(JSON.stringify(failedWrite)).not.toContain('SECRET')
    expect(createProject).toHaveBeenCalledTimes(1)
    expect((await call()).structuredContent).toEqual({ result: { id: 'p1' } })
  })

  it.each([401, 403, 409])(
    'reports HTTP %s without exposing service error bodies',
    async (status) => {
      const sdk = new OpenScienceClient({
        baseUrl: 'http://127.0.0.1:44100',
        token: 'private-token',
        fetch: async () =>
          Response.json({ error: { message: 'SECRET', code: 'SECRET' } }, { status })
      })
      const { client } = await harness(vi.fn(async () => sdk))
      const response = await client.callTool({ name: 'list_projects', arguments: {} })
      expect(response.isError).toBe(true)
      expect(JSON.stringify(response)).not.toContain('SECRET')
      expect(JSON.stringify(response)).toContain(status === 409 ? 'revision' : 'Access denied')
    }
  )

  it('preserves the unattended capability check without submitting unsupported runs', async () => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () =>
      Response.json({ taskCapabilities: [] })
    )
    const sdk = new OpenScienceClient({ baseUrl: 'http://127.0.0.1:44100', token: 'token', fetch })
    const { client } = await harness(vi.fn(async () => sdk))
    const response = await client.callTool({
      name: 'start_run',
      arguments: { projectId: 'p1', prompt: 'Go', permissionPrompts: 'none' }
    })
    expect(response.isError).toBe(true)
    expect(JSON.stringify(response)).toContain('unsupported_capability')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toContain('/api/bootstrap')
  })

  it('aborts pending calls on disconnect without cancelling persisted runs', async () => {
    let signal: AbortSignal | undefined
    const getRun = vi.fn(async (_id, options) => {
      signal = options.signal
      await new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      )
    })
    const cancelRun = vi.fn()
    const { client, server } = await harness(vi.fn(async () => ({ getRun, cancelRun })))
    const pending = client
      .callTool({ name: 'get_run', arguments: { runId: 'r1' } })
      .catch(() => undefined)
    await vi.waitFor(() => expect(getRun).toHaveBeenCalledOnce())
    await server.close()
    await pending
    expect(signal?.aborted).toBe(true)
    expect(cancelRun).not.toHaveBeenCalled()
  })
})
