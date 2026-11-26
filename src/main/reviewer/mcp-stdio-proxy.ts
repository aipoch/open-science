import { nodeRuntimeEnvironmentEntries } from '../node-process-host'
import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { REVIEWER_MCP_SERVER_NAME } from '../../shared/reviewer'
import { fetchOverSocket } from '../local-rpc-transport'
import { REVIEWER_MCP_PROXY_ARG } from '../mcp-server-args'
import { LOCAL_RESOURCE_BUDGETS } from '../resource-budget'
import {
  REVIEWER_MCP_SOCKET_PATH_ENV,
  REVIEWER_MCP_TOKEN_ENV,
  type ReviewerMcpSocket
} from '../agent-framework/reviewer-mcp-transport'

type ReviewerMcpProxyConfigRequest = ReviewerMcpSocket & {
  command: string
  entryPath: string
}

const requireEnvironmentVariable = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`Missing Reviewer MCP proxy environment variable: ${name}`)
  return value
}

const createReviewerMcpProxyEnvironmentFromProcess = (
  env: NodeJS.ProcessEnv = process.env
): ReviewerMcpSocket => ({
  socketPath: requireEnvironmentVariable(env, REVIEWER_MCP_SOCKET_PATH_ENV),
  token: requireEnvironmentVariable(env, REVIEWER_MCP_TOKEN_ENV)
})

const createReviewerMcpStdioProxyConfig = ({
  command,
  entryPath,
  socketPath,
  token
}: ReviewerMcpProxyConfigRequest): McpServerStdio => ({
  name: REVIEWER_MCP_SERVER_NAME,
  command,
  args: [entryPath, REVIEWER_MCP_PROXY_ARG],
  env: [
    ...nodeRuntimeEnvironmentEntries(),
    { name: REVIEWER_MCP_SOCKET_PATH_ENV, value: socketPath },
    { name: REVIEWER_MCP_TOKEN_ENV, value: token }
  ]
})

// Presents the existing scope-enforcing Reviewer MCP server as stdio while moving only its local
// transport over a Windows named pipe. Tool definitions, validation, and submission remain upstream.
const createReviewerMcpStdioProxy = async (
  environment = createReviewerMcpProxyEnvironmentFromProcess()
): Promise<Server> => {
  const upstream = new Client({ name: 'open-science-reviewer-proxy', version: '1.0.0' })
  await upstream.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: fetchOverSocket(environment.socketPath),
      requestInit: { headers: { authorization: `Bearer ${environment.token}` } }
    })
  )

  const downstream = new Server(
    { name: REVIEWER_MCP_SERVER_NAME, version: '1.0.0' },
    { capabilities: { tools: {} } }
  )
  downstream.setRequestHandler(ListToolsRequestSchema, (request) =>
    upstream.listTools(request.params)
  )
  downstream.setRequestHandler(CallToolRequestSchema, (request) =>
    upstream.callTool(request.params)
  )
  downstream.onclose = () => void upstream.close()

  return downstream
}

const runReviewerMcpStdioProxy = async (
  environment = createReviewerMcpProxyEnvironmentFromProcess()
): Promise<void> => {
  const downstream = await createReviewerMcpStdioProxy(environment)
  await downstream.connect(
    new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: LOCAL_RESOURCE_BUDGETS.requestBytes
    })
  )
}

export {
  createReviewerMcpProxyEnvironmentFromProcess,
  createReviewerMcpStdioProxy,
  createReviewerMcpStdioProxyConfig,
  runReviewerMcpStdioProxy
}
