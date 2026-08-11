import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import {
  HOST_MESSAGE_CONTENT_INSTRUCTION,
  HOST_MESSAGE_MCP_SERVER_NAME,
  HOST_MESSAGE_NAMESPACED_TOOLS,
  HOST_SEND_MESSAGE_TOOL_NAME,
  createHostMessageMcpServer
} from './host-message-mcp-server'

describe('Side chat host-message MCP server', () => {
  it('exposes only relationship-scoped send_message and returns its structured queue result', async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      status: 'queued',
      messageId: 'side-chat-message-1',
      targetState: 'idle',
      delivery: 'next-user-turn',
      persisted: true,
      systemHint: 'Delivered with the next user turn.'
    })
    const server = createHostMessageMcpServer({ sendMessage })
    const client = new Client({ name: 'host-message-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    try {
      const tools = (await client.listTools()).tools
      expect(tools.map(({ name }) => name)).toEqual([HOST_SEND_MESSAGE_TOOL_NAME])
      expect(tools[0]?.description).toContain('only after the user explicitly asks')
      expect(HOST_MESSAGE_NAMESPACED_TOOLS[0].description).toContain(
        'only after the user explicitly asks'
      )
      expect(tools[0]?.description).toContain(HOST_MESSAGE_CONTENT_INSTRUCTION)
      expect(HOST_MESSAGE_NAMESPACED_TOOLS[0].description).toContain(
        HOST_MESSAGE_CONTENT_INSTRUCTION
      )
      const result = await client.callTool({
        name: HOST_SEND_MESSAGE_TOOL_NAME,
        arguments: { target: 'main', text: 'Use a black line.' }
      })

      expect(sendMessage).toHaveBeenCalledWith({ target: 'main', text: 'Use a black line.' })
      expect(result).toMatchObject({
        structuredContent: expect.objectContaining({
          status: 'queued',
          messageId: 'side-chat-message-1',
          persisted: true
        })
      })
      expect(HOST_MESSAGE_MCP_SERVER_NAME).toBe('open-science-host-message')
    } finally {
      await client.close()
      await server.close()
    }
  })
})
