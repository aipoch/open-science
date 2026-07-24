import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'

import {
  ACTIVITY_GROUP_MCP_SERVER_NAME,
  BEGIN_ACTIVITY_GROUP_TOOL_NAME,
  createActivityGroupMcpServer
} from './mcp-server'

describe('activity group MCP server', () => {
  it('exposes a declaration-only begin_activity_group tool', async () => {
    const server = createActivityGroupMcpServer()
    const client = new Client({ name: 'activity-group-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const tools = await client.listTools()
    expect(tools.tools).toEqual([
      expect.objectContaining({
        name: BEGIN_ACTIVITY_GROUP_TOOL_NAME,
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({ title: expect.any(Object) }),
          required: ['title']
        })
      })
    ])

    await expect(
      client.callTool({
        name: BEGIN_ACTIVITY_GROUP_TOOL_NAME,
        arguments: { title: 'Inspect files' }
      })
    ).resolves.toMatchObject({
      content: [
        {
          type: 'text',
          text: 'Activity group declared: Inspect files. Before starting another coherent tool group this turn, call begin_activity_group again with its own purpose title.'
        }
      ]
    })

    expect(ACTIVITY_GROUP_MCP_SERVER_NAME).toBe('open-science-activity')

    await client.close()
    await server.close()
  })
})
