import type { McpServerHttp, McpServerStdio } from '@agentclientprotocol/sdk'
import { realpathSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { REVIEWER_MCP_SERVER_NAME } from '../../shared/reviewer'
import { REVIEWER_MCP_PROXY_ARG } from '../mcp-server-args'

export type ReviewerMcpSocket = { socketPath: string; token: string }

export const REVIEWER_MCP_SOCKET_PATH_ENV = 'OPEN_SCIENCE_REVIEWER_MCP_SOCKET_PATH'
export const REVIEWER_MCP_TOKEN_ENV = 'OPEN_SCIENCE_REVIEWER_MCP_TOKEN'

const SOCKET_META = 'open-science/reviewer-mcp-socket'
// An ordinary HTTP client must never contact a network endpoint with the pipe's token.
const SOCKET_URL = 'http://open-science-reviewer.invalid/mcp'

export const createReviewerMcpSocketConfig = ({
  socketPath,
  token
}: ReviewerMcpSocket): McpServerHttp & { type: 'http' } => ({
  type: 'http',
  name: REVIEWER_MCP_SERVER_NAME,
  url: SOCKET_URL,
  headers: [{ name: 'authorization', value: `Bearer ${token}` }],
  _meta: { [SOCKET_META]: socketPath }
})

export const readReviewerMcpStdioProxyConfig = (
  server: McpServerStdio
): ReviewerMcpSocket | undefined => {
  if (server.args?.length !== 2 || server.args[1] !== REVIEWER_MCP_PROXY_ARG) return undefined
  const socketPath = server.env?.find(({ name }) => name === REVIEWER_MCP_SOCKET_PATH_ENV)?.value
  const token = server.env?.find(({ name }) => name === REVIEWER_MCP_TOKEN_ENV)?.value
  return socketPath && token ? { socketPath, token } : undefined
}

export const readReviewerMcpSocketPath = (server: McpServerHttp): string | undefined => {
  const path = server._meta?.[SOCKET_META]
  if (path === undefined) return undefined
  const localSocket =
    typeof path === 'string' &&
    (process.platform === 'win32'
      ? /^\\\\\.\\pipe\\open-science-reviewer-mcp-\d+-[0-9a-f-]{36}$/u.test(path)
      : /^os-\d+-[0-9a-f]{8}\.sock$/u.test(basename(path)) &&
        dirname(path) === realpathSync('/tmp'))
  if (server.name !== REVIEWER_MCP_SERVER_NAME || server.url !== SOCKET_URL || !localSocket) {
    throw new Error('Invalid Reviewer MCP socket configuration')
  }
  return path
}
