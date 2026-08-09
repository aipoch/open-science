import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  SIDE_CHAT_MESSAGE_LIMIT,
  type SideChatSendMessageRequest,
  type SideChatSendMessageResult
} from '../../shared/side-chat'

const HOST_MESSAGE_MCP_SERVER_NAME = 'open-science-host-message'
const HOST_SEND_MESSAGE_TOOL_NAME = 'send_message'
const HOST_MESSAGE_NAMESPACED_TOOLS = [
  {
    namespace: 'mcp__open_science_host_message',
    name: HOST_SEND_MESSAGE_TOOL_NAME,
    description:
      'Queue advisory text for the parent main conversation without waking or interrupting it.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['main'] },
        text: { type: 'string', minLength: 1, maxLength: SIDE_CHAT_MESSAGE_LIMIT }
      },
      required: ['target', 'text'],
      additionalProperties: false
    },
    strict: true
  }
] as const

type HostMessageMcpHandler = Readonly<{
  sendMessage: (request: SideChatSendMessageRequest) => Promise<SideChatSendMessageResult>
}>

const createHostMessageMcpServer = (handler: HostMessageMcpHandler): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: HOST_MESSAGE_MCP_SERVER_NAME,
    version: '1.0.0'
  })
  server.registerTool(
    HOST_SEND_MESSAGE_TOOL_NAME,
    {
      title: 'Send advisory to main',
      description:
        'Queue advisory text for the parent main conversation. This does not wake, interrupt, or authorize the main Agent; delivery waits for the next real main user turn.',
      inputSchema: {
        target: z.literal('main'),
        text: z.string().trim().min(1).max(SIDE_CHAT_MESSAGE_LIMIT)
      }
    },
    async (request) => {
      const result = await handler.sendMessage(request)
      return {
        structuredContent: result,
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
      }
    }
  )
  return server
}

export {
  HOST_MESSAGE_MCP_SERVER_NAME,
  HOST_MESSAGE_NAMESPACED_TOOLS,
  HOST_SEND_MESSAGE_TOOL_NAME,
  createHostMessageMcpServer
}
export type { HostMessageMcpHandler }
