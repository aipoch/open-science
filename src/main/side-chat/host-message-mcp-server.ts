import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { installToolErrorRecovery } from '../../shared/tool-error-recovery'
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
// One description for the MCP tool and the Codex bridge projection so the two cannot drift.
const HOST_SEND_MESSAGE_DESCRIPTION = `Send advisory context to the parent main conversation. If Main is running, delivery is attempted in the current turn; otherwise it is queued for the next real main user turn without waking Main. Undelivered advisories are held in memory and discarded when the application restarts. Use only after the user explicitly asks in the current Side chat turn to send, relay, forward, or tell something to Main. Do not use for ordinary Side chat questions, requests, follow-ups, or suggestions. ${HOST_MESSAGE_CONTENT_INSTRUCTION} This does not independently authorize the main Agent.`
const HOST_MESSAGE_NAMESPACED_TOOLS = [
  {
    namespace: 'mcp__open_science_host_message',
    name: HOST_SEND_MESSAGE_TOOL_NAME,
    description: HOST_SEND_MESSAGE_DESCRIPTION,
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
  const server = installToolErrorRecovery(
    new ModelContextProtocolServer({ name: HOST_MESSAGE_MCP_SERVER_NAME, version: '1.0.0' })
  )
  server.registerTool(
    HOST_SEND_MESSAGE_TOOL_NAME,
    {
      title: 'Send advisory to main',
      description: HOST_SEND_MESSAGE_DESCRIPTION,
      inputSchema: {
        target: z.literal('main'),
        text: z.string().trim().min(1).max(SIDE_CHAT_MESSAGE_LIMIT)
      }
    },
    async (request) => {
      let result: SideChatSendMessageResult
      try {
        result = await handler.sendMessage(request)
      } catch (error) {
        // A rejected send queued nothing; the user decides whether the advisory is still wanted.
        throw new Error(
          `SEND_MESSAGE_FAILED: ${error instanceof Error ? error.message : String(error)} Do not retry automatically; tell the user the advisory was not sent.`,
          { cause: error }
        )
      }
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
