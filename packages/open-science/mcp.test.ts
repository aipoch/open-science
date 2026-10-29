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

describe('research MCP tools', () => {
  it('discovers descriptive snake_case tools without contacting the service', async () => {
    const connect = vi.fn()
    const { client } = await harness(connect)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...new Set(cases.map(([name]) => name))].sort()
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
