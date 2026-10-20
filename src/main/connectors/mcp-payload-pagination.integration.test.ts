import { createConnectorRegistry } from '@aipoch/connector-core'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { McpClientManager } from '@aipoch/connector-mcp-client'
import { ConnectorService } from './service'

const config = { id: 'test-mcp', name: 'test-mcp', transport: 'stdio' as const, command: 'unused' }

async function connect(server: Server): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'regression-client', version: '1' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return client
}

describe('ConnectorService MCP integration', () => {
  it('C02 dispatches a tool advertised on the second discovery page', async () => {
    const calls: string[] = []
    const server = new Server(
      { name: 'paged-server', version: '1' },
      { capabilities: { tools: {} } }
    )
    server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
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
    // The root test graph and the connector package can resolve distinct MCP SDK declaration
    // copies. The runtime client is intentionally the same protocol object; keep this test's
    // factory boundary explicit rather than letting duplicate private fields fail node typecheck.
    const manager = new McpClientManager({
      createClient: () => connect(server) as unknown as never
    })
    const service = new ConnectorService({
      registry: createConnectorRegistry([]),
      mcpClientManager: manager,
      getConnectors: () => ({
        enabledIds: [],
        autoAllowIds: [],
        customMcpServers: [{ ...config, displayName: 'Test', enabled: true }]
      }),
      resolveApiKey: () => undefined
    })
    try {
      await expect(
        service.call(config.name, 'second', {}, { origin: 'internal' })
      ).resolves.toEqual({ ok: true })
      expect(calls).toEqual(['second'])
    } finally {
      await manager.closeAll()
      await server.close()
    }
  })
})
