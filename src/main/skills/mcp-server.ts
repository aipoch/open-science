import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import type { ConversationSkillImportResult } from '../../shared/settings'
import {
  REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION,
  REQUEST_SKILL_IMPORT_TOOL_NAME,
  SKILL_IMPORT_MCP_SERVER_NAME
} from '../../shared/skill-import'
import { SKILL_IMPORT_MCP_SERVER_ARG } from '../mcp-server-args'

const requestSkillImportToolSchema = {
  attachment_uri: z
    .string()
    .url()
    .describe('Exact file URI of the attachment marked skillImportEligible in the user prompt.'),
  turn_token: z
    .string()
    .uuid()
    .describe('Exact skillImportTurnToken from the same eligible attachment reference.')
}
const requestSkillImportToolDefinition = {
  title: 'Request Skill import',
  description: REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION,
  inputSchema: requestSkillImportToolSchema
}
const SKILL_IMPORT_SYSTEM_PROMPT_APPEND = [
  '<open_science_skill_import_instructions>',
  'When the user explicitly asks to install or import an attachment wrapped in <attached_skill_package> and marked skillImportEligible, call request_skill_import with its exact URI as attachment_uri and skillImportTurnToken as turn_token.',
  'The tool opens an application-owned preview and confirmation dialog. Never unpack or copy an attached Skill package into a Skill directory yourself.',
  'An <attached_local_archive> is an ordinary ZIP reference, not an eligible Skill package. Do not call request_skill_import for it.',
  'A newly imported Skill becomes available on the next user turn after the agent runtime reloads.',
  '</open_science_skill_import_instructions>'
].join('\n')

type SkillImportRpcConnection = {
  endpoint: string
  token: string
}

type SkillImportMcpEnvironment = SkillImportRpcConnection & {
  sessionId: string
}

type SkillImportMcpHandler = {
  requestImport: (
    attachmentUri: string,
    turnToken: string
  ) => Promise<ConversationSkillImportResult>
}

type SkillImportMcpServerConfigRequest = SkillImportMcpEnvironment & {
  command: string
  entryPath: string
}

type RpcResponse = {
  result?: ConversationSkillImportResult
  error?: string
}

const createSkillImportMcpServer = (handler: SkillImportMcpHandler): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: SKILL_IMPORT_MCP_SERVER_NAME,
    version: '1.0.0'
  })

  server.registerTool(
    REQUEST_SKILL_IMPORT_TOOL_NAME,
    requestSkillImportToolDefinition,
    async ({ attachment_uri, turn_token }) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(await handler.requestImport(attachment_uri, turn_token), null, 2)
        }
      ]
    })
  )

  return server
}

const createSkillImportMcpServerConfig = ({
  command,
  entryPath,
  endpoint,
  token,
  sessionId
}: SkillImportMcpServerConfigRequest): McpServerStdio => ({
  name: SKILL_IMPORT_MCP_SERVER_NAME,
  command,
  args: [entryPath, SKILL_IMPORT_MCP_SERVER_ARG],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'OPEN_SCIENCE_SKILL_IMPORT_RPC_ENDPOINT', value: endpoint },
    { name: 'OPEN_SCIENCE_SKILL_IMPORT_RPC_TOKEN', value: token },
    { name: 'OPEN_SCIENCE_SKILL_IMPORT_SESSION_ID', value: sessionId }
  ]
})

const requireEnvironmentVariable = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`Missing Skill import MCP environment variable: ${name}`)
  return value
}

const createSkillImportMcpEnvironmentFromProcess = (
  env: NodeJS.ProcessEnv = process.env
): SkillImportMcpEnvironment => ({
  endpoint: requireEnvironmentVariable(env, 'OPEN_SCIENCE_SKILL_IMPORT_RPC_ENDPOINT'),
  token: requireEnvironmentVariable(env, 'OPEN_SCIENCE_SKILL_IMPORT_RPC_TOKEN'),
  sessionId: requireEnvironmentVariable(env, 'OPEN_SCIENCE_SKILL_IMPORT_SESSION_ID')
})

const callSkillImportRpc = async (
  environment: SkillImportMcpEnvironment,
  attachmentUri: string,
  turnToken: string
): Promise<ConversationSkillImportResult> => {
  const response = await fetch(environment.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${environment.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      method: 'skillImport',
      params: { sessionId: environment.sessionId, turnToken, attachmentUri }
    })
  })
  const payload = (await response.json()) as RpcResponse

  if (!response.ok || payload.error || !payload.result) {
    throw new Error(payload.error ?? `Skill import RPC failed with status ${response.status}`)
  }
  return payload.result
}

const runSkillImportMcpServer = async (
  environment = createSkillImportMcpEnvironmentFromProcess()
): Promise<void> => {
  const server = createSkillImportMcpServer({
    requestImport: (attachmentUri, turnToken) =>
      callSkillImportRpc(environment, attachmentUri, turnToken)
  })
  await server.connect(new StdioServerTransport())
}

export {
  REQUEST_SKILL_IMPORT_TOOL_NAME,
  REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION,
  SKILL_IMPORT_MCP_SERVER_ARG,
  SKILL_IMPORT_MCP_SERVER_NAME,
  SKILL_IMPORT_SYSTEM_PROMPT_APPEND,
  callSkillImportRpc,
  createSkillImportMcpEnvironmentFromProcess,
  createSkillImportMcpServer,
  createSkillImportMcpServerConfig,
  requestSkillImportToolDefinition,
  requestSkillImportToolSchema,
  runSkillImportMcpServer
}
export type {
  SkillImportMcpEnvironment,
  SkillImportMcpHandler,
  SkillImportMcpServerConfigRequest,
  SkillImportRpcConnection
}
