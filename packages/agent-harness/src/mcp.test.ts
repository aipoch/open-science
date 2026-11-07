import { describe, expect, it, vi } from 'vitest'
import {
  loadMcpTools,
  mcpToolResult,
  type McpToolClient,
  type McpToolDefinition,
  type McpToolBinding
} from './mcp'
import { openAgentSession } from './session'
import { ToolValidationError } from './tool-validation'
import type { AgentModel, AgentTool, Json, ToolContext } from './session-types'

const signal = (): AbortSignal => new AbortController().signal
const context = (): ToolContext => ({
  sessionId: 's',
  runId: 'r',
  invocationId: 'i',
  signal: signal(),
  update: vi.fn()
})
const definition = (name = 'sum'): McpToolDefinition => ({
  name,
  inputSchema: { type: 'object' } as Json
})
const binding = (): McpToolBinding & {
  authorize: ReturnType<typeof vi.fn<AgentTool['authorize']>>
} => ({ validate: (args: Json) => args, authorize: vi.fn(async () => true) })
function client(): McpToolClient {
  return {
    listTools: vi.fn(async () => ({ tools: [definition()] })),
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
  }
}
const model = (calls: { id: string; name: string; arguments: Json }[]): AgentModel => ({
  id: 'fixture',
  capabilities: { tools: true, images: false, files: false },
  async *stream(request) {
    if (request.messages.some((message) => message.role === 'tool'))
      yield { type: 'finish', reason: 'complete', content: [] }
    else yield { type: 'finish', reason: 'tools', content: [], calls }
  }
})
async function session(
  tools: readonly AgentTool[],
  calls = [{ id: 'c', name: 'sum', arguments: {} }]
): ReturnType<typeof openAgentSession> {
  return openAgentSession({
    sessionId: 's',
    model: model(calls),
    tools,
    maxSteps: 3,
    maxOutputTokens: 100
  })
}

describe('optional MCP adapter', () => {
  it('discovers once, follows pages, freezes and orders the selected capability snapshot', async () => {
    const transport = client()
    const schema = { type: 'object', properties: { z: { type: 'string' }, a: { type: 'integer' } } }
    transport.listTools = vi.fn(async (cursor) =>
      cursor
        ? { tools: [{ name: 'a', inputSchema: schema }] }
        : { tools: [definition('z')], nextCursor: 'next' }
    )
    const tools = await loadMcpTools({ client: transport, signal: signal(), bind: binding })
    expect(tools.map((tool) => tool.name)).toEqual(['a', 'z'])
    expect(transport.listTools).toHaveBeenCalledTimes(2)
    schema.properties.a.type = 'string'
    expect(tools[0].parameters).toMatchObject({ properties: { a: { type: 'integer' } } })
    expect(Object.isFrozen(tools[0].parameters)).toBe(true)
    await tools[0].execute({}, context())
    await tools[0].execute({}, context())
    expect(transport.listTools).toHaveBeenCalledTimes(2)
    const other = client()
    other.listTools = async () => ({
      tools: [
        {
          name: 'a',
          inputSchema: {
            properties: { a: { type: 'integer' }, z: { type: 'string' } },
            type: 'object'
          }
        }
      ]
    })
    expect(
      (await loadMcpTools({ client: other, signal: signal(), bind: binding }))[0].version
    ).toBe(tools[0].version)
  })

  it('accepts omitted SDK metadata represented as undefined without weakening schema checks', async () => {
    const transport = client()
    transport.listTools = async () => ({
      tools: [{ ...definition(), description: undefined, annotations: undefined }],
      nextCursor: undefined
    })
    expect(await loadMcpTools({ client: transport, signal: signal(), bind: binding })).toHaveLength(
      1
    )
    transport.listTools = async () => ({
      tools: [{ ...definition(), inputSchema: { properties: undefined } }]
    })
    await expect(
      loadMcpTools({ client: transport, signal: signal(), bind: binding })
    ).rejects.toThrow()
  })

  it('rejects duplicate capabilities, cursor loops and cancelled discovery', async () => {
    const transport = client()
    transport.listTools = async () => ({ tools: [definition(), definition()] })
    await expect(
      loadMcpTools({ client: transport, signal: signal(), bind: binding })
    ).rejects.toThrow('duplicate')
    transport.listTools = async () => ({ tools: [], nextCursor: 'again' })
    await expect(
      loadMcpTools({ client: transport, signal: signal(), bind: binding })
    ).rejects.toThrow('pagination')
    const abort = new AbortController()
    abort.abort()
    await expect(
      loadMcpTools({ client: transport, signal: abort.signal, bind: binding })
    ).rejects.toThrow()
  })

  it('does not infer permissions or parallelism from server metadata', async () => {
    const transport = client(),
      policy = binding()
    transport.listTools = async () => ({
      tools: [
        {
          ...definition(),
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false }
        }
      ]
    })
    policy.authorize.mockResolvedValue(false)
    const tools = await loadMcpTools({ client: transport, signal: signal(), bind: () => policy })
    expect(tools[0].scheduling).toBe('exclusive')
    const agent = await session(tools)
    expect(await agent.prompt([{ type: 'text', text: 'run' }])).toBe('complete')
    expect(transport.callTool).not.toHaveBeenCalled()
    expect((await agent.snapshot()).messages[2]).toMatchObject({ isError: true })
    await agent.dispose()
    expect(
      await loadMcpTools({ client: transport, signal: signal(), bind: () => undefined })
    ).toEqual([])
  })

  it.each([false, true])(
    'returns safe field diagnostics with parallel=%s, without authorizing invalid inputs',
    async (parallel) => {
      const transport = client(),
        authorize = vi.fn(async () => true)
      const tools = await loadMcpTools({
        client: transport,
        signal: signal(),
        bind: () => ({
          authorize,
          scheduling: parallel ? 'parallel' : 'exclusive',
          validate() {
            throw new ToolValidationError([{ path: '$.groups', expected: 'array' }])
          }
        })
      })
      const extra = { ...tools[0], name: 'other' }
      const agent = await session(
        [tools[0], extra],
        [
          { id: 'c', name: 'sum', arguments: {} },
          { id: 'd', name: 'other', arguments: {} }
        ]
      )
      await agent.prompt([{ type: 'text', text: 'run' }])
      expect(
        (await agent.snapshot()).messages.filter((m) => m.role === 'tool').map((m) => m.content)
      ).toEqual([
        [{ type: 'text', text: 'Invalid tool arguments: $.groups: expected array' }],
        [{ type: 'text', text: 'Invalid tool arguments: $.groups: expected array' }]
      ])
      expect(authorize).not.toHaveBeenCalled()
      expect(transport.callTool).not.toHaveBeenCalled()
      await agent.dispose()
    }
  )

  it('does not leak arbitrary validator error messages', async () => {
    const transport = client()
    const tools = await loadMcpTools({
      client: transport,
      signal: signal(),
      bind: () => ({
        ...binding(),
        validate() {
          throw new Error('private credential')
        }
      })
    })
    const agent = await session(tools)
    await agent.prompt([{ type: 'text', text: 'run' }])
    expect(JSON.stringify(await agent.snapshot())).not.toContain('private credential')
    await agent.dispose()
  })

  it('preserves acknowledged tool errors but blocks transport failures without retry', async () => {
    const transport = client()
    transport.callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'rejected' }],
      isError: true
    }))
    const tools = await loadMcpTools({ client: transport, signal: signal(), bind: binding })
    const agent = await session(tools)
    await agent.prompt([{ type: 'text', text: 'run' }])
    expect((await agent.snapshot()).messages[2]).toMatchObject({ isError: true })
    await agent.dispose()
    transport.callTool = vi.fn(async () => {
      throw new Error('disconnected after dispatch')
    })
    const uncertain = await session(tools)
    await expect(uncertain.prompt([{ type: 'text', text: 'run' }])).rejects.toThrow('disconnected')
    expect((await uncertain.snapshot()).pending[0].status).toBe('unknown')
    await expect(uncertain.continue()).rejects.toThrow('Reconcile uncertain tool effects')
    expect(transport.callTool).toHaveBeenCalledTimes(1)
    await uncertain.dispose()
  })

  it('requires and runs declared output validation', async () => {
    const transport = client()
    transport.listTools = async () => ({
      tools: [{ ...definition(), outputSchema: { type: 'object' } }]
    })
    await expect(
      loadMcpTools({ client: transport, signal: signal(), bind: binding })
    ).rejects.toThrow('validator')
    const validateOutput = vi.fn()
    const tools = await loadMcpTools({
      client: transport,
      signal: signal(),
      bind: () => ({ ...binding(), validateOutput })
    })
    await expect(tools[0].execute({}, context())).rejects.toThrow('Missing MCP structured')
    transport.callTool = async () => ({ content: [], structuredContent: { count: 3 } })
    expect(await tools[0].execute({}, context())).toEqual({
      content: [{ type: 'text', text: '{"count":3}' }]
    })
    expect(validateOutput).toHaveBeenCalledWith({ count: 3 })
  })

  it('preserves resource references and image content without fetching or duplicating structured JSON', () => {
    expect(
      mcpToolResult({
        content: [{ type: 'text', text: '{"b":2,"a":1}' }],
        structuredContent: { a: 1, b: 2 }
      }).content
    ).toHaveLength(1)
    const resource = {
      type: 'resource_link',
      name: 'result',
      uri: 'file:///private/result.csv',
      mimeType: 'text/csv'
    }
    expect(
      mcpToolResult({ content: [resource, { type: 'image', data: 'AA==', mimeType: 'image/png' }] })
        .content
    ).toEqual([
      { type: 'text', text: JSON.stringify(resource) },
      { type: 'image', mimeType: 'image/png', source: 'data:image/png;base64,AA==' }
    ])
    expect(() => mcpToolResult({ content: [{ type: 'text', text: 42 }] })).toThrow()
    expect(() => mcpToolResult({ content: [], isError: 'yes' })).toThrow()
    expect(() => mcpToolResult({ content: [], structuredContent: [] })).toThrow()
  })
})
