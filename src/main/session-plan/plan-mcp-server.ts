import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  createPlanDocumentV1,
  formatPlanSchemaIssue,
  generatePlanContentToolSchema,
  isPlanCommandErrorCode,
  PlanCommandError,
  type GeneratePlanContent,
  type PlanLifecycle,
  type PlanCommandErrorCode
} from '../../shared/session-plan/contract'
import type { SessionPlanApproval, SessionPlanStepStatus } from '../../shared/session-persistence'
import { LOCAL_RESOURCE_BUDGETS } from '../resource-budget'
import {
  fetchLocalRpc,
  fetchLongLivedLocalRpc,
  type LocalRpcTransport
} from '../local-rpc-transport'
import { PLAN_MCP_SERVER_ARG } from '../mcp-server-args'

const PLAN_MCP_SERVER_NAME = 'open-science-plan'

const generatePlanToolSchema = z.strictObject(
  {
    decision: z.enum(['approved', 'rejected'], { error: formatPlanSchemaIssue }).optional(),
    approve: z.literal(true, { error: formatPlanSchemaIssue }).optional(),
    ...generatePlanContentToolSchema.shape
  },
  { error: formatPlanSchemaIssue }
)

const sessionPlanStepStatusSchema = z.enum([
  'in_progress',
  'completed',
  'blocked',
  'skipped'
] satisfies readonly SessionPlanStepStatus[])

const updateStepStatusToolSchema = {
  title: z.string().min(1),
  status: sessionPlanStepStatusSchema,
  notes: z.string().min(1).optional()
}

const sessionPlanApprovalSchema = z.enum([
  'pending',
  'approved',
  'rejected'
] satisfies readonly SessionPlanApproval[])

const planLifecycleSchema = z.enum([
  'awaiting_approval',
  'approved',
  'in_progress',
  'blocked',
  'completed',
  'rejected'
] satisfies readonly PlanLifecycle[])

const planRevisionSchema = z.number().int().nonnegative()

type PlanMcpHandler = Readonly<{
  generate: (content: GeneratePlanContent, signal?: AbortSignal) => Promise<unknown>
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
  content: [{ type: 'text' as const, text: JSON.stringify(result) }]
})

const structuredPlanErrorResult = (error: PlanCommandError): PlanToolCallResult => {
  const payload = { error: { code: error.code, message: error.message } }
  return {
    isError: true,
    structuredContent: payload,
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }]
  }
}

const handlePlanToolCall = async (
  call: () => Promise<unknown>,
  present: (result: unknown) => unknown = (result) => result
): Promise<PlanToolCallResult> => {
  try {
    return toolResult(present(await call()))
  } catch (error) {
    if (error instanceof PlanCommandError) return structuredPlanErrorResult(error)
    throw error
  }
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

const invalidPlanToolSuccess = (): PlanCommandError =>
  new PlanCommandError(
    'invalid-plan',
    'The Session Plan service returned an invalid success result.'
  )

const requirePlanToolState = (
  result: unknown
): Readonly<{
  outcome: Record<string, unknown>
  projection: Record<string, unknown>
  changed: boolean
  revision: number
  approval: SessionPlanApproval
  lifecycle: PlanLifecycle
}> => {
  const outcome = recordOf(result)
  const projection = recordOf(outcome?.projection)
  const approval = sessionPlanApprovalSchema.safeParse(projection?.approval)
  const revision = planRevisionSchema.safeParse(projection?.revision)
  const lifecycle = planLifecycleSchema.safeParse(projection?.lifecycle)
  if (
    !outcome ||
    !projection ||
    typeof outcome.changed !== 'boolean' ||
    !approval.success ||
    !revision.success ||
    !lifecycle.success
  ) {
    throw invalidPlanToolSuccess()
  }
  return {
    outcome,
    projection,
    changed: outcome.changed,
    revision: revision.data,
    approval: approval.data,
    lifecycle: lifecycle.data
  }
}

type PlanToolOutcomeContext =
  | Readonly<{
      kind: 'step-update'
      title: string
      status: SessionPlanStepStatus
    }>
  | Readonly<{ kind: 'decision'; decision: 'approved' | 'rejected' }>
  | Readonly<{ kind: 'generation-result' }>

const presentPlanToolOutcome = (result: unknown, context: PlanToolOutcomeContext): unknown => {
  const outcome = recordOf(result)
  if (context.kind === 'generation-result') {
    if (outcome?.kind === 'feedback' && typeof outcome.text === 'string') {
      return { kind: 'feedback', text: outcome.text }
    }
  }
  const { projection, changed, revision, approval, lifecycle } = requirePlanToolState(result)
  const state = { changed, revision, lifecycle }
  if (context.kind === 'step-update') {
    const step = recordOf(recordOf(projection.stepStates)?.[context.title])
    const stepStatus = sessionPlanStepStatusSchema.safeParse(step?.status)
    if (approval !== 'approved' || !stepStatus.success || stepStatus.data !== context.status) {
      throw invalidPlanToolSuccess()
    }
    return {
      ...state,
      step: { title: context.title, status: context.status }
    }
  }
  if (context.kind === 'generation-result') {
    const decision = approval
    if (decision === 'approved' || decision === 'rejected') {
      return { kind: 'decision', decision, ...state }
    }
    return { kind: 'plan', ...state }
  }
  if (approval !== context.decision) throw invalidPlanToolSuccess()
  return {
    kind: 'decision',
    decision: context.decision,
    ...state
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
        'Generation and decision use separate call shapes. For generation, submit one complete payload with all four top-level fields: task_summary, phases, desired_outputs, and feasibility. For a decision, submit only decision:"approved" or decision:"rejected". If validation fails, repair each reported path in the complete payload; never resend the same invalid arguments unchanged. Generation blocks until the user responds. Text responses always return as kind:feedback and remain ordinary user Messages; interpret the full meaning, then submit an unambiguous approval or rejection as a decision-only call, or revise and regenerate when changes are requested. An approved Plan remains active context on its durable Message Branch across later Attempts and context reconstruction. Never infer approval from message text alone. The legacy approval-only payload approve:true remains accepted.',
      inputSchema: generatePlanToolSchema
    },
    async ({ decision, approve, task_summary, phases, desired_outputs, feasibility }, extra) => {
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
        return handlePlanToolCall(
          async () => {
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
          },
          (result) =>
            presentPlanToolOutcome(result, { kind: 'decision', decision: resolvedDecision })
        )
      }
      return handlePlanToolCall(
        async () => {
          const document = createPlanDocumentV1({
            task_summary,
            phases,
            desired_outputs,
            feasibility
          })
          const result = await handler.generate(document, extra.signal)
          executionArtifactVersionId = projectionVersionId(result) ?? executionArtifactVersionId
          return result
        },
        (result) => presentPlanToolOutcome(result, { kind: 'generation-result' })
      )
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
      handlePlanToolCall(
        () =>
          handler.updateStepStatus({
            ...input,
            expectedArtifactVersionId: executionArtifactVersionId
          }),
        (result) =>
          presentPlanToolOutcome(result, {
            kind: 'step-update',
            title: input.title,
            status: input.status
          })
      )
  )
  return server
}

const callPlanRpc = async (
  environment: PlanMcpEnvironment,
  operation: 'generate' | 'approve' | 'reject' | 'updateStepStatus',
  input?: unknown,
  signal?: AbortSignal
): Promise<unknown> => {
  const request = operation === 'generate' ? fetchLongLivedLocalRpc : fetchLocalRpc
  const response = await request(
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
      }),
      signal
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
    generate: async (content, signal) => {
      const result = await callPlanRpc(environment, 'generate', content, signal)
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
  await server.connect(
    new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: LOCAL_RESOURCE_BUDGETS.requestBytes
    })
  )
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
