import { describe, it, expect } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { McpClientManager, buildTransport } from './mcp-client-manager'
import type { CustomMcpServerConfig } from './mcp-client-manager'

// Builds an in-memory MCP server with one echo tool and one always-erroring tool, and an
// injectable createClient that links a fresh Client to it via InMemoryTransport — no process
// spawn, no network.
function makeTestServer(): { createClient: () => Promise<Client> } {
  const server = new McpServer({ name: 'test-server', version: '0.0.0' })

  server.registerTool(
    'echo',
    { description: 'Echoes back its args as JSON.', inputSchema: { value: z.string() } },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] })
  )

  server.registerTool('boom', { description: 'Always fails.' }, async () => ({
    content: [{ type: 'text', text: 'kaboom' }],
    isError: true
  }))

  const createClient = async (): Promise<Client> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    return client
  }

  return { createClient }
}

const config: CustomMcpServerConfig = {
  id: 'srv-1',
  name: 'test-server',
  transport: 'stdio',
  command: 'unused'
}

describe('McpClientManager', () => {
  it('lists tools registered on the server', async () => {
    const { createClient } = makeTestServer()
    const manager = new McpClientManager({ createClient: () => createClient() })

    const tools = await manager.listTools(config)

    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['boom', 'echo'])
    expect(tools.find((t) => t.name === 'echo')?.description).toMatch(/Echoes/)
  })

  it('calls a tool and returns the parsed JSON dict', async () => {
    const { createClient } = makeTestServer()
    const manager = new McpClientManager({ createClient: () => createClient() })

    const out = await manager.call(config, 'echo', { value: 'hello' })

    expect(out).toEqual({ value: 'hello' })
  })

  it('throws when the tool result has isError set', async () => {
    const { createClient } = makeTestServer()
    const manager = new McpClientManager({ createClient: () => createClient() })

    await expect(manager.call(config, 'boom', {})).rejects.toThrow(/kaboom/)
  })

  it('dedupes concurrent connects for the same server id', async () => {
    let connectCount = 0
    const { createClient } = makeTestServer()
    const manager = new McpClientManager({
      createClient: async () => {
        connectCount += 1
        return createClient()
      }
    })

    await Promise.all([manager.listTools(config), manager.call(config, 'echo', { value: 'x' })])

    expect(connectCount).toBe(1)
  })

  it('closeAll drops cached clients so a later call reconnects', async () => {
    let connectCount = 0
    const { createClient } = makeTestServer()
    const manager = new McpClientManager({
      createClient: async () => {
        connectCount += 1
        return createClient()
      }
    })

    await manager.listTools(config)
    await manager.closeAll()
    await manager.listTools(config)

    expect(connectCount).toBe(2)
  })
})

describe('buildTransport', () => {
  it('builds a StdioClientTransport for a stdio config', () => {
    const transport = buildTransport({
      id: 'srv-stdio',
      name: 'stdio-server',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-mcp-server']
    })

    expect(transport).toBeInstanceOf(StdioClientTransport)
  })

  it('throws when a stdio config is missing a command', () => {
    expect(() =>
      buildTransport({ id: 'srv-stdio', name: 'stdio-server', transport: 'stdio' })
    ).toThrow()
  })

  it('builds a StreamableHTTPClientTransport for a streamable_http config', () => {
    const transport = buildTransport({
      id: 'srv-http',
      name: 'http-server',
      transport: 'streamable_http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' }
    })

    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
  })

  it('throws when a streamable_http config is missing a url', () => {
    expect(() =>
      buildTransport({ id: 'srv-http', name: 'http-server', transport: 'streamable_http' })
    ).toThrow()
  })

  it('builds an SSEClientTransport for an sse config', () => {
    const transport = buildTransport({
      id: 'srv-sse',
      name: 'sse-server',
      transport: 'sse',
      url: 'https://example.com/sse'
    })

    expect(transport).toBeInstanceOf(SSEClientTransport)
  })

  it('throws when an sse config is missing a url', () => {
    expect(() => buildTransport({ id: 'srv-sse', name: 'sse-server', transport: 'sse' })).toThrow()
  })
})
