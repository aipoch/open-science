import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  createPlanDocumentV1,
  generatePlanContentToolSchema,
  isPlanCommandErrorCode,
  PlanCommandError,
  type GeneratePlanContent,
  type PlanCommandErrorCode
} from '../../shared/session-plan/contract'
import type { SessionPlanStepStatus } from '../../shared/session-persistence'
import { fetchLocalRpc, type LocalRpcTransport } from '../local-rpc-transport'
import { PLAN_MCP_SERVER_ARG } from '../mcp-server-args'

const PLAN_MCP_SERVER_NAME = 'open-science-plan'

const generatePlanToolSchema = {
  session_id: z.never().optional(),
  plan_id: z.never().optional(),
  artifact_id: z.never().optional(),
  artifact_version_id: z.never().optional(),
  decision: z.enum(['approved', 'rejected']).optional(),
  approve: z.literal(true).optional(),
  ...generatePlanContentToolSchema.shape
}

const updateStepStatusToolSchema = {
  title: z.string().min(1),
  status: z.enum(['in_progress', 'completed', 'blocked', 'skipped']),
  notes: z.string().min(1).optional()
}

type PlanMcpHandler = Readonly<{
  generate: (content: GeneratePlanContent) => Promise<unknown>
  approve: () => Promise<unknown>
  reject: () => Promise<unknown>
  updateStepStatus: (input: {
    title: string
    status: SessionPlanStepStatus
    notes?: string
    expectedArtifactVersionId?: string
  }) => Promise<unknown>
}>

type PlanMcpEnvironment = LocalRpcTransport &
  Readonly<{
    token: string
    projectId: string
    sessionId: string
  }>

type PlanMcpServerConfigRequest = PlanMcpEnvironment &
  Readonly<{ command: string; entryPath: string }>

type PlanToolCallResult = Readonly<{
  isError?: true
  structuredContent?: Readonly<{
    error: Readonly<{ code: PlanCommandErrorCode; message: string }>
  }>
  content: Array<{ type: 'text'; text: string }>
}>

const toolResult = (result: unknown): PlanToolCallResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
})

const structuredPlanErrorResult = (error: PlanCommandError): PlanToolCallResult => {
  const payload = { error: { code: error.code, message: error.message } }
  return {
    isError: true,
    structuredContent: payload,
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }]
  }
}

const handlePlanToolCall = async (call: () => Promise<unknown>): Promise<PlanToolCallResult> => {
  try {
    return toolResult(await call())
  } catch (error) {
    if (error instanceof PlanCommandError) return structuredPlanErrorResult(error)
    throw error
  }
}

const projectionVersionId = (result: unknown): string | undefined => {
  if (typeof result !== 'object' || result === null) return undefined
  const projection = (result as { projection?: unknown }).projection
  if (typeof projection !== 'object' || projection === null) return undefined
  const versionId = (projection as { artifactVersionId?: unknown }).artifactVersionId
  return typeof versionId === 'string' ? versionId : undefined
}

const createPlanMcpServer = (handler: PlanMcpHandler): ModelContextProtocolServer => {
  let executionArtifactVersionId: string | undefined
  const server = new ModelContextProtocolServer({
    name: PLAN_MCP_SERVER_NAME,
    version: '1.0.0'
  })
  server.registerTool(
    'generate_plan',
    {
      title: 'Generate or decide Session Plan',
      description:
        'Create an immutable execution Plan or explicitly decide the active Plan. Generation blocks until the user responds. Text responses always return as kind:feedback and remain ordinary user Messages; interpret the full meaning, then call this tool again with only decision:"approved" or decision:"rejected" when the intent is unambiguous, or revise and regenerate when changes are requested. Calling decision:"approved" also binds an already-approved interrupted Plan to the current user interaction. Never execute from message text alone. The legacy approve:true is equivalent to decision:"approved". Do not combine a decision with Plan content.',
      inputSchema: generatePlanToolSchema
    },
    async ({ decision, approve, task_summary, phases, desired_outputs, feasibility }) => {
      const hasContent =
        task_summary !== undefined ||
        phases !== undefined ||
        desired_outputs !== undefined ||
        feasibility !== undefined
      if (approve === true && decision !== undefined) {
        return handlePlanToolCall(async () => {
          throw new PlanCommandError(
            'invalid-plan',
            'Use either decision or legacy approve:true, not both.'
          )
        })
      }
      const resolvedDecision = decision ?? (approve === true ? 'approved' : undefined)
      if (resolvedDecision !== undefined) {
        return handlePlanToolCall(async () => {
          if (hasContent) {
            throw new PlanCommandError(
              'invalid-plan',
              'A Plan decision cannot be combined with Plan content.'
            )
          }
          const result =
            resolvedDecision === 'approved' ? await handler.approve() : await handler.reject()
          executionArtifactVersionId =
            resolvedDecision === 'approved'
              ? (projectionVersionId(result) ?? executionArtifactVersionId)
              : undefined
          return result
        })
      }
      return handlePlanToolCall(async () => {
        const document = createPlanDocumentV1({
          task_summary,
          phases,
          desired_outputs,
          feasibility
        })
        const result = await handler.generate(document)
        executionArtifactVersionId = projectionVersionId(result) ?? executionArtifactVersionId
        return result
      })
    }
  )
  server.registerTool(
    'update_step_status',
    {
      title: 'Update Plan step status',
      description: 'Update one exact step title on the server-bound active Plan.',
      inputSchema: updateStepStatusToolSchema
    },
    async (input) =>
      handlePlanToolCall(() =>
        handler.updateStepStatus({
          ...input,
          expectedArtifactVersionId: executionArtifactVersionId
        })
      )
  )
  return server
}

const callPlanRpc = async (
  environment: PlanMcpEnvironment,
  operation: 'generate' | 'approve' | 'reject' | 'updateStepStatus',
  input?: unknown
): Promise<unknown> => {
  const response = await fetchLocalRpc(
    environment,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${environment.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'planCall',
        params: {
          projectId: environment.projectId,
          sessionId: environment.sessionId,
          operation,
          input
        }
      })
    },
    'Session Plan RPC'
  )
  const payload = (await response.json()) as {
    result?: unknown
    error?: string | { code?: unknown; message?: unknown }
  }
  if (!response.ok || payload.error) {
    if (
      typeof payload.error === 'object' &&
      payload.error !== null &&
      isPlanCommandErrorCode(payload.error.code) &&
      typeof payload.error.message === 'string'
    ) {
      throw new PlanCommandError(payload.error.code, payload.error.message)
    }
    throw new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Session Plan RPC failed with status ${response.status}`
    )
  }
  return payload.result
}

const executionVersionByEnvironment = new WeakMap<PlanMcpEnvironment, string>()

const createPlanMcpServerForEnvironment = (
  environment: PlanMcpEnvironment
): ModelContextProtocolServer =>
  createPlanMcpServer({
    generate: async (content) => {
      const result = await callPlanRpc(environment, 'generate', content)
      const versionId = projectionVersionId(result)
      if (versionId) executionVersionByEnvironment.set(environment, versionId)
      return result
    },
    approve: async () => {
      const result = await callPlanRpc(environment, 'approve')
      const versionId = projectionVersionId(result)
      if (versionId) executionVersionByEnvironment.set(environment, versionId)
      return result
    },
    reject: async () => {
      const result = await callPlanRpc(environment, 'reject')
      executionVersionByEnvironment.delete(environment)
      return result
    },
    updateStepStatus: (input) =>
      callPlanRpc(environment, 'updateStepStatus', {
        ...input,
        expectedArtifactVersionId:
          input.expectedArtifactVersionId ?? executionVersionByEnvironment.get(environment)
      })
  })

const createPlanMcpServerConfig = ({
  command,
  entryPath,
  endpoint,
  socketPath,
  token,
  projectId,
  sessionId
}: PlanMcpServerConfigRequest): McpServerStdio => ({
  name: PLAN_MCP_SERVER_NAME,
  command,
  args: [entryPath, PLAN_MCP_SERVER_ARG],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'OPEN_SCIENCE_PLAN_RPC_ENDPOINT', value: endpoint },
    ...(socketPath ? [{ name: 'OPEN_SCIENCE_PLAN_RPC_SOCKET_PATH', value: socketPath }] : []),
    { name: 'OPEN_SCIENCE_PLAN_RPC_TOKEN', value: token },
    { name: 'OPEN_SCIENCE_PLAN_PROJECT_ID', value: projectId },
    { name: 'OPEN_SCIENCE_PLAN_SESSION_ID', value: sessionId }
  ]
})

const requireEnvironment = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing Session Plan MCP environment variable: ${name}`)
  return value
}

const runPlanMcpServer = async (): Promise<void> => {
  const server = createPlanMcpServerForEnvironment({
    endpoint: requireEnvironment('OPEN_SCIENCE_PLAN_RPC_ENDPOINT'),
    socketPath: process.env.OPEN_SCIENCE_PLAN_RPC_SOCKET_PATH,
    token: requireEnvironment('OPEN_SCIENCE_PLAN_RPC_TOKEN'),
    projectId: requireEnvironment('OPEN_SCIENCE_PLAN_PROJECT_ID'),
    sessionId: requireEnvironment('OPEN_SCIENCE_PLAN_SESSION_ID')
  })
  await server.connect(new StdioServerTransport())
}

export {
  PLAN_MCP_SERVER_NAME,
  callPlanRpc,
  createPlanMcpServer,
  createPlanMcpServerConfig,
  createPlanMcpServerForEnvironment,
  generatePlanToolSchema,
  runPlanMcpServer,
  updateStepStatusToolSchema
}
export type { PlanMcpEnvironment, PlanMcpHandler, PlanMcpServerConfigRequest }
