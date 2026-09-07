import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { McpClientManager } from './mcp-client-manager'
import { ConnectorService } from './service'

const config = { id: 'test-mcp', name: 'test-mcp', transport: 'stdio' as const, command: 'unused' }

async function connect(server: Server): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'regression-client', version: '1' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return client
}

describe('MCP protocol regressions', () => {
  it.each<CallToolResult>([
    {
      content: [
        { type: 'text', text: 'summary' },
        { type: 'text', text: 'required second paragraph' },
        { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }
      ],
      structuredContent: { rows: [{ value: 42 }] }
    },
    {
      content: [{ type: 'text', text: '{"summary":true}' }],
      structuredContent: { rows: [{ value: 42 }] }
    }
  ])('C01 preserves the complete successful payload %#', async (payload) => {
    const server = new Server(
      { name: 'payload-server', version: '1' },
      { capabilities: { tools: {} } }
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'read', inputSchema: { type: 'object' as const } }]
    }))
    server.setRequestHandler(CallToolRequestSchema, async () => payload)
    const manager = new McpClientManager({ createClient: () => connect(server) })
    try {
      await expect(manager.call(config, 'read', {})).resolves.toEqual(payload)
    } finally {
      await manager.closeAll()
      await server.close()
    }
  })

  it('C02 dispatches a tool advertised on the second discovery page', async () => {
    const cursors: Array<string | undefined> = []
    const calls: string[] = []
    const server = new Server(
      { name: 'paged-server', version: '1' },
      { capabilities: { tools: {} } }
    )
    server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
      cursors.push(params?.cursor)
      return params?.cursor === 'page-2'
        ? { tools: [{ name: 'second', inputSchema: { type: 'object' as const } }] }
        : {
            tools: [{ name: 'first', inputSchema: { type: 'object' as const } }],
            nextCursor: 'page-2'
          }
    })
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      calls.push(params.name)
      return { content: [{ type: 'text' as const, text: '{"ok":true}' }] }
    })
    const manager = new McpClientManager({ createClient: () => connect(server) })
    const service = new ConnectorService({
      mcpClientManager: manager,
      getConnectors: () => ({
        enabledIds: [],
        autoAllowIds: [],
        customMcpServers: [{ ...config, displayName: 'Test', enabled: true }]
      }),
      resolveApiKey: () => undefined
    })
    try {
      const result = await service
        .call(config.name, 'second', {}, { origin: 'internal' })
        .catch((error: unknown) => error)
      // Soft assertions retain all three pieces of evidence on the original implementation.
      expect.soft(cursors).toEqual([undefined, 'page-2'])
      expect.soft(calls).toEqual(['second'])
      expect(result).toEqual({ ok: true })
    } finally {
      await manager.closeAll()
      await server.close()
    }
  })
  it('C02 stops a repeated cursor without returning a partial tool list', async () => {
    const server = new Server(
      { name: 'cyclic-server', version: '1' },
      { capabilities: { tools: {} } }
    )
    const requests = vi.fn(async () => ({ tools: [], nextCursor: 'same' }))
    server.setRequestHandler(ListToolsRequestSchema, requests)
    const manager = new McpClientManager({ createClient: () => connect(server) })
    try {
      await expect(manager.listTools(config)).rejects.toThrow('repeated a cursor')
      expect(requests).toHaveBeenCalledTimes(2)
    } finally {
      await manager.closeAll()
      await server.close()
    }
  })

  it('C02 passes cancellation to later discovery pages', async () => {
    const controller = new AbortController()
    const server = new Server(
      { name: 'cancel-server', version: '1' },
      { capabilities: { tools: {} } }
    )
    server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
      if (params?.cursor) controller.abort()
      return { tools: [], nextCursor: 'second' }
    })
    const list = vi.spyOn(Client.prototype, 'listTools')
    const manager = new McpClientManager({ createClient: () => connect(server) })
    try {
      await expect(manager.listTools(config, controller.signal)).rejects.toThrow('AbortError')
      expect(list).toHaveBeenCalledWith({ cursor: 'second' }, { signal: controller.signal })
    } finally {
      list.mockRestore()
      await manager.closeAll()
      await server.close()
    }
  })
})
