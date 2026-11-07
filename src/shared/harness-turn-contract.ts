import { z } from 'zod'

const id = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim())
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const harnessRouteSchema = z
  .object({
    id,
    providerId: id,
    configRevision: count,
    model: id,
    protocol: z.enum(['chat-completions', 'responses', 'messages'])
  })
  .strict()
const usageSchema = z
  .object({
    inputTokens: count,
    cacheTokens: count,
    outputTokens: count,
    cachedReadTokens: count.optional(),
    cachedWriteTokens: count.optional()
  })
  .strict()
  .refine(
    (value) =>
      (value.cachedReadTokens === undefined && value.cachedWriteTokens === undefined) ||
      (value.cachedReadTokens !== undefined &&
        value.cachedWriteTokens !== undefined &&
        value.cachedReadTokens + value.cachedWriteTokens === value.cacheTokens)
  )
export const harnessRequestReceiptSchema = z
  .object({
    requestId: id,
    turnId: id,
    step: count,
    route: harnessRouteSchema,
    startedAt: count,
    status: z.enum(['started', 'completed', 'failed', 'interrupted']),
    usage: usageSchema.optional(),
    httpStatus: z.number().int().min(100).max(599).optional()
  })
  .strict()
  .refine((value) => value.status !== 'started' || (!value.usage && value.httpStatus === undefined))

export const harnessTurnScopeSchema = z
  .object({
    projectId: id,
    sessionId: id,
    agentFrameId: id,
    messageBranchId: id,
    promptMessageId: id,
    messageId: id,
    generation: id,
    route: harnessRouteSchema
  })
  .strict()
export type HarnessTurnScope = z.infer<typeof harnessTurnScopeSchema>

export type HarnessAssistantMessage = Record<string, unknown> & {
  role: 'assistant'
  content?: string | null
  reasoning_content?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
}
export const harnessAssistantMessageSchema: z.ZodType<HarnessAssistantMessage> = z
  .object({
    role: z.literal('assistant'),
    content: z.string().nullable().optional(),
    reasoning_content: z.string().optional(),
    tool_calls: z
      .array(
        z
          .object({
            id,
            type: z.literal('function'),
            function: z.object({ name: id, arguments: z.string() }).strict()
          })
          .strict()
      )
      .optional()
  })
  .catchall(z.json())
export const harnessToolReceiptSchema = z
  .object({
    requestId: id,
    callId: id,
    status: z.enum(['started', 'completed', 'denied', 'unknown']),
    output: z.string().optional()
  })
  .strict()
  .refine((value) =>
    ['completed', 'denied'].includes(value.status)
      ? value.output !== undefined
      : value.output === undefined
  )
export type HarnessToolReceipt = z.infer<typeof harnessToolReceiptSchema>

export const harnessTurnJournalSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: harnessTurnScopeSchema,
    status: z.enum(['running', 'complete', 'budget', 'cancelled', 'failed', 'interrupted']),
    attemptedRequests: count,
    contextRevision: count.optional(),
    summaryRequestIds: z.array(id).max(2048).optional(),
    compactions: z
      .array(
        z
          .object({
            id,
            text: z.string().min(1),
            sourceIds: z.array(id).min(1),
            sourceRevision: count,
            beforeTokens: count,
            afterTokens: count
          })
          .strict()
      )
      .max(2048)
      .optional(),
    requests: z.array(harnessRequestReceiptSchema).max(2048),
    transcript: z
      .object({
        responses: z
          .array(z.object({ requestId: id, message: harnessAssistantMessageSchema }).strict())
          .max(2048),
        tools: z.array(harnessToolReceiptSchema).max(4096)
      })
      .strict()
      .optional()
  })
  .strict()
  .refine((value) => {
    const requests = value.requests
    const transcript = value.transcript
    const responses = transcript?.responses ?? []
    const tools = transcript?.tools ?? []
    const calls = responses.flatMap((response) => response.message.tool_calls ?? [])
    return (
      new Set(responses.map((response) => response.requestId)).size === responses.length &&
      new Set(calls.map((call) => call.id)).size === calls.length &&
      new Set(tools.map((tool) => tool.callId)).size === tools.length &&
      new Set(value.summaryRequestIds ?? []).size === (value.summaryRequestIds ?? []).length &&
      (value.summaryRequestIds ?? []).every((id) =>
        requests.some((request) => request.requestId === id)
      ) &&
      responses.every((response) => !value.summaryRequestIds?.includes(response.requestId)) &&
      responses.every((response) =>
        requests.some(
          (request) => request.requestId === response.requestId && request.status === 'completed'
        )
      ) &&
      tools.every((tool) =>
        responses.some(
          (response) =>
            response.requestId === tool.requestId &&
            response.message.tool_calls?.some((call) => call.id === tool.callId)
        )
      ) &&
      requests.length <= value.attemptedRequests &&
      new Set(requests.map((request) => request.requestId)).size === requests.length &&
      new Set(requests.map((request) => request.step)).size === requests.length &&
      requests.every(
        (request) =>
          request.turnId === requests[0].turnId &&
          JSON.stringify(request.route) === JSON.stringify(value.scope.route)
      )
    )
  })
export type HarnessTurnJournal = z.infer<typeof harnessTurnJournalSchema>
