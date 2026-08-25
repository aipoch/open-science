import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  SIDE_CHAT_MESSAGE_LIMIT,
  type SideChatSendMessageRequest,
  type SideChatSendMessageResult
} from '../../shared/side-chat'

const HOST_MESSAGE_MCP_SERVER_NAME = 'open-science-host-message'
const HOST_SEND_MESSAGE_TOOL_NAME = 'send_message'
const HOST_MESSAGE_CONTENT_INSTRUCTION =
  'Send only the advisory content; do not prepend a Side chat source or relay label.'
const HOST_MESSAGE_NAMESPACED_TOOLS = [
  {
    namespace: 'mcp__open_science_host_message',
    name: HOST_SEND_MESSAGE_TOOL_NAME,
    description: `Send advisory context to the parent main conversation. If Main is running, delivery is attempted in the current turn; otherwise it is queued for the next real main user turn without waking Main. Use only after the user explicitly asks in the current Side chat turn to send, relay, forward, or tell something to Main. Do not use for ordinary Side chat questions, requests, follow-ups, or suggestions. ${HOST_MESSAGE_CONTENT_INSTRUCTION}`,
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
      description: `Send advisory context to the parent main conversation. If Main is running, delivery is attempted in the current turn; otherwise it is queued for the next real main user turn without waking Main. Use only after the user explicitly asks in the current Side chat turn to send, relay, forward, or tell something to Main. Do not use for ordinary Side chat questions, requests, follow-ups, or suggestions. ${HOST_MESSAGE_CONTENT_INSTRUCTION} This does not independently authorize the main Agent.`,
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
  HOST_MESSAGE_CONTENT_INSTRUCTION,
  HOST_MESSAGE_MCP_SERVER_NAME,
  HOST_MESSAGE_NAMESPACED_TOOLS,
  HOST_SEND_MESSAGE_TOOL_NAME,
  createHostMessageMcpServer
}
export type { HostMessageMcpHandler }
