import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { ACTIVITY_GROUP_MCP_SERVER_ARG } from '../mcp-server-args'
import {
  ACTIVITY_GROUP_MCP_SERVER_NAME,
  BEGIN_ACTIVITY_GROUP_TOOL_NAME,
  MAX_ACTIVITY_GROUP_TITLE_LENGTH
} from '../../shared/activity-groups'

const beginActivityGroupToolSchema = {
  title: z
    .string()
    .trim()
    .min(1)
    .refine((value) => Array.from(value).length <= MAX_ACTIVITY_GROUP_TITLE_LENGTH, {
      message: `Title must be at most ${MAX_ACTIVITY_GROUP_TITLE_LENGTH} characters.`
    })
    .describe('A concise user-facing title describing the purpose of the upcoming tool group.')
}

const createActivityGroupMcpServer = (): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: ACTIVITY_GROUP_MCP_SERVER_NAME,
    version: '1.0.0'
  })

  server.registerTool(
    BEGIN_ACTIVITY_GROUP_TOOL_NAME,
    {
      title: 'Begin activity group',
      description:
        'Declare the concise purpose of the next coherent group of tool calls. Call once before the first tool in that group, not once per step.',
      inputSchema: beginActivityGroupToolSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ title }) => ({
      content: [{ type: 'text', text: `Activity group declared: ${title}` }]
    })
  )

  return server
}

const createActivityGroupMcpServerConfig = ({
  command,
  entryPath
}: {
  command: string
  entryPath: string
}): McpServerStdio => ({
  name: ACTIVITY_GROUP_MCP_SERVER_NAME,
  command,
  args: [entryPath, ACTIVITY_GROUP_MCP_SERVER_ARG],
  env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }]
})

const runActivityGroupMcpServer = async (): Promise<void> => {
  const server = createActivityGroupMcpServer()
  await server.connect(new StdioServerTransport())
}

export {
  ACTIVITY_GROUP_MCP_SERVER_ARG,
  ACTIVITY_GROUP_MCP_SERVER_NAME,
  BEGIN_ACTIVITY_GROUP_TOOL_NAME,
  beginActivityGroupToolSchema,
  createActivityGroupMcpServer,
  createActivityGroupMcpServerConfig,
  runActivityGroupMcpServer
}
