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
import { redactSensitiveText } from '../../shared/diagnostic-redaction'
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
    decision: z
      .enum(['approved', 'rejected'], { error: formatPlanSchemaIssue })
      .describe(
        'A final explicit user decision for the pending Plan. Use this field by itself; approved permits execution and rejected ends the Plan.'
      )
      .optional(),
    approve: z
      .literal(true, { error: formatPlanSchemaIssue })
      .describe('Legacy spelling for decision:"approved". Use this field by itself.')
      .optional(),
    ...generatePlanContentToolSchema.shape
  },
  { error: formatPlanSchemaIssue }
)

const sessionPlanStepStatusSchema = z
  .enum([
    'in_progress',
    'completed',
    'blocked',
    'skipped'
  ] satisfies readonly SessionPlanStepStatus[])
  .describe(
    'The observed status. Use in_progress after work starts; completed after its check passes; blocked only for an irreversible failure and never for a pause; skipped only for unnecessary work that has not started. completed and blocked require in_progress. Terminal statuses cannot change later, and repeating one is a no-op.'
  )

const updateStepStatusToolSchema = {
  title: z
    .string()
    .min(1)
    .describe('The exact, case-sensitive title of one step in the current approved Plan.'),
  status: sessionPlanStepStatusSchema,
  notes: z
    .string()
    .min(1)
    .describe(
      'Optional non-empty progress or blocker context. It is stored only when the status changes or remains in_progress; a repeated terminal-status no-op does not write new notes.'
    )
    .optional()
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
    error: Readonly<{ code?: PlanCommandErrorCode; message: string; guidance?: string }>
  }>
  content: Array<{ type: 'text'; text: string }>
}>

class PlanRpcAuthenticationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanRpcAuthenticationError'
  }
}

const toolResult = (result: unknown): PlanToolCallResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result) }]
})

const INVALID_SUCCESS_MESSAGE =
  'The Session Plan service returned an invalid result. The operation outcome is unconfirmed.'
const OUTCOME_UNCONFIRMED_GUIDANCE =
  'Stop automatic retries. Do not assume the operation failed or repeat it until later Session Plan context confirms whether it took effect. Do not repeat confirmed writes; report unresolved state for application recovery.'
const AUTHENTICATION_REJECTED_GUIDANCE =
  "Do not retry automatically or bypass the rejection. Report it so Open Science can refresh this Session's Plan capability; retry only after the application provides a fresh capability."

const boundedRedactedMessage = (message: string): string => {
  const redacted = redactSensitiveText(message)
  return redacted.length <= 2048 ? redacted : `${redacted.slice(0, 2018)}… [message truncated]`
}

const guidanceForPlanError = (error: PlanCommandError): string | undefined => {
  if (error.code === 'invalid-backend-result') return OUTCOME_UNCONFIRMED_GUIDANCE
  if (error.code === 'invalid-plan') return undefined
  if (error.code === 'plan-unavailable') {
    return 'The operation was not attempted. Do not rebuild or resubmit the Plan. Open Science must provide the Session Plan capability before another Plan call.'
  }
  if (error.code === 'no-active-plan') {
    return 'Do not retry this command unless later application context establishes an active Plan.'
  }
  if (error.code === 'plan-review-pending') {
    return 'Do not repeat this Plan call. Preserve the pending state and follow the error message or later Session Plan context before another mutation.'
  }
  if (error.code === 'approval-already-pending') {
    return 'Keep the current review pending. Do not regenerate automatically; wait for the current review result.'
  }
  if (error.code === 'approval-already-decided') {
    return 'The recorded decision is irreversible. Do not retry or submit the opposite decision.'
  }
  if (error.code === 'stale-plan' || error.code === 'revision-conflict') {
    return 'Stop automatic retries. Follow later Session Plan context for the current version and state before making another mutation.'
  }
  if (error.code === 'unknown-step') {
    return 'Use an exact step title from the current approved Plan when that Plan context is available.'
  }
  if (error.code === 'invalid-transition' || error.code === 'dependency-not-satisfied') {
    return 'Follow the allowed statuses or unmet dependency stated in the error before making another status update.'
  }
  if (error.code === 'plan-not-approved') {
    return 'Do not update Plan steps unless later Session Plan context confirms that the current Plan is approved.'
  }
  if (error.code === 'artifact-unavailable') {
    return 'Stop Plan mutations. The application or user must restore readable, verified Plan data before work can continue.'
  }
  if (error.code === 'interaction-mismatch') {
    return 'The authorization or delivery context changed. Do not retry this mutation automatically.'
  }
  return undefined
}

const structuredPlanErrorResult = (error: PlanCommandError): PlanToolCallResult => {
  const guidance = guidanceForPlanError(error)
  const message = boundedRedactedMessage(error.message)
  const payload = {
    error: {
      code: error.code,
      message,
      ...(guidance ? { guidance } : {})
    }
  }
  return {
    isError: true,
    structuredContent: payload,
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }]
  }
}

const authenticationRejectedResult = (error: PlanRpcAuthenticationError): PlanToolCallResult => {
  const payload = {
    error: {
      message: boundedRedactedMessage(
        `The Session Plan operation was not attempted because authentication was rejected: ${error.message}`
      ),
      guidance: AUTHENTICATION_REJECTED_GUIDANCE
    }
  }
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
    if (error instanceof PlanRpcAuthenticationError) return authenticationRejectedResult(error)
    const payload = {
      error: {
        message: 'The Session Plan operation did not return a confirmed result.',
        guidance: OUTCOME_UNCONFIRMED_GUIDANCE
      }
    }
    return {
      isError: true,
      structuredContent: payload,
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }]
    }
  }
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

const invalidPlanToolSuccess = (): PlanCommandError =>
  new PlanCommandError('invalid-backend-result', INVALID_SUCCESS_MESSAGE)

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

const decisionDeliveryContext = (
  outcome: Record<string, unknown>,
  projection: Record<string, unknown>
): Record<string, string> => {
  const deliveryWarning =
    typeof outcome.deliveryWarning === 'string' &&
    outcome.deliveryWarning.length > 0 &&
    outcome.deliveryWarning.length <= 2048
      ? outcome.deliveryWarning
      : undefined
  if (!deliveryWarning) return {}
  const artifactVersionId =
    typeof projection.artifactVersionId === 'string' &&
    projection.artifactVersionId.length > 0 &&
    projection.artifactVersionId.length <= 2048
      ? projection.artifactVersionId
      : undefined
  const deliveryCommandId =
    typeof outcome.deliveryCommandId === 'string' &&
    outcome.deliveryCommandId.length > 0 &&
    outcome.deliveryCommandId.length <= 2048
      ? outcome.deliveryCommandId
      : undefined
  return {
    deliveryWarning,
    ...(artifactVersionId ? { artifactVersionId } : {}),
    ...(deliveryCommandId ? { deliveryCommandId } : {})
  }
}

const presentPlanToolOutcome = (result: unknown, context: PlanToolOutcomeContext): unknown => {
  const outcome = recordOf(result)
  const planContext =
    typeof outcome?.planContext === 'string' && outcome.planContext.length <= 2048
      ? { planContext: outcome.planContext }
      : {}
  if (context.kind === 'generation-result') {
    if (outcome?.kind === 'feedback' && typeof outcome.text === 'string') {
      return { kind: 'feedback', text: outcome.text, ...planContext }
    }
  }
  const {
    outcome: validatedOutcome,
    projection,
    changed,
    revision,
    approval,
    lifecycle
  } = requirePlanToolState(result)
  const state = { changed, revision, lifecycle, ...planContext }
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
      return {
        kind: 'decision',
        decision,
        ...state,
        ...decisionDeliveryContext(validatedOutcome, projection)
      }
    }
    return {
      kind: 'plan',
      ...state,
      guidance: 'Review is pending. Do not execute Plan steps until approval is recorded.'
    }
  }
  if (approval !== context.decision) throw invalidPlanToolSuccess()
  return {
    kind: 'decision',
    decision: context.decision,
    ...state,
    ...decisionDeliveryContext(validatedOutcome, projection)
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
        'Create a complete Session Plan for review, or record the user\'s explicit decision on the pending Plan. Use exactly one shape: (1) generation with task_summary, phases, desired_outputs, and feasibility; or (2) decision-only with decision:"approved" or decision:"rejected". Legacy decision-only approve:true remains accepted. Each step should state the work, concrete deliverable or finding, and completion check. A distinct new Plan supersedes the current Plan. When the current Plan needs revision, submit the complete revised Plan for fresh review. Do not regenerate merely to report progress or recover a transport failure. Generation waits for review: kind:plan remains pending, kind:decision records approval or rejection, and kind:feedback is an ordinary user Message. Never infer approval from ambiguous or conditional feedback. A timeout or disconnect neither approves the Plan nor proves submission failed; wait for later Plan context instead of resubmitting or executing steps. Repair every reported validation path. A deliveryWarning means the decision committed but handoff is unconfirmed; preserve its identities and follow the warning without repeating the decision.',
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
          // A review pause cancels this transport before an approval result can rebind the cache.
          // Pending updates remain rejected by the service; the next approved Plan is server-bound.
          executionArtifactVersionId = undefined
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
      description:
        'Report observed progress for one exact, case-sensitive step in the current approved Plan. Call soon after work starts and when completion, irreversible blockage, or skipping is known; update before moving to a later independent unit. Complete only after the promised check passes and its result is available. Waiting for user input or an external result preserves the current status; it is not blocked. Earlier steps in the same delegation and all earlier phases must be completed or skipped before starting or skipping; after a block, only already-started delegations may continue. A receipt confirms the stored status. Settle known results before finishing the task without inventing terminal statuses merely to end a turn.',
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
    if (response.status === 401) {
      const message =
        typeof payload.error === 'string'
          ? payload.error
          : typeof payload.error === 'object' &&
              payload.error !== null &&
              typeof payload.error.message === 'string'
            ? payload.error.message
            : 'Session Plan RPC authentication was rejected.'
      throw new PlanRpcAuthenticationError(
        environment.token.length > 0 ? message.replaceAll(environment.token, '[redacted]') : message
      )
    }
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
      executionVersionByEnvironment.delete(environment)
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
