import { randomBytes } from 'node:crypto'
import type { AgentModel, AgentTool, ModelEvent, ModelUsage } from '@aipoch/agent-harness'
import { HARNESS_USER_TEXT_RANGE } from './config'
import {
  MAX_REQUEST_BYTES,
  SERVICE_NAME,
  startTraceExport,
  type CaptureOptions,
  type ModelRequestCapture,
  type SpanContent,
  type TraceAttributes
} from './trace-export'

const MAX_TOOL_NAMES = 64
const MAX_EXCERPT_LENGTH = 4_096
const MAX_TOOL_PREVIEW_BYTES = 16 * 1024
const timeOriginNanos = BigInt(Math.round(performance.timeOrigin * 1_000)) * 1_000n
const unixNanos = (): string =>
  (timeOriginNanos + BigInt(Math.round(performance.now() * 1_000_000))).toString()

type StartedSpan = {
  name: 'harness.turn' | 'harness.model' | 'harness.tool'
  traceId: string
  spanId: string
  parentSpanId?: string
  startTimeUnixNano: string
  kind: 1 | 3 // OTLP INTERNAL or CLIENT
}
function startSpan(
  name: StartedSpan['name'],
  kind: StartedSpan['kind'],
  parent?: StartedSpan
): StartedSpan | undefined {
  try {
    return {
      name,
      kind,
      traceId: parent?.traceId ?? randomBytes(16).toString('hex'),
      spanId: randomBytes(8).toString('hex'),
      parentSpanId: parent?.spanId,
      startTimeUnixNano: unixNanos()
    }
  } catch {
    return undefined
  }
}

type SpanRecorder = (
  span: StartedSpan | undefined,
  outcome: string,
  attributes: TraceAttributes,
  content?: SpanContent
) => void

type TextBlock = { type: string; text?: string; _meta?: Record<string, unknown> | null }
type Excerpt = { text: string; truncated: boolean }

function userPromptExcerpt(prompt: readonly TextBlock[]): Excerpt | undefined {
  const first = prompt[0]
  if (first?.type !== 'text' || !first.text) return undefined
  const range = first._meta?.[HARNESS_USER_TEXT_RANGE]
  if (!Array.isArray(range) || range.length !== 2) return undefined
  const [start, end] = range
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > first.text.length
  )
    return undefined
  const limit = Math.min(end, start + MAX_EXCERPT_LENGTH)
  return {
    text: first.text.slice(start, limit).replace(/[\uD800-\uDBFF]$/, ''),
    truncated: limit < end
  }
}

function excerpt(blocks: readonly TextBlock[]): Excerpt | undefined {
  let text = ''
  for (const block of blocks) {
    if (block.type !== 'text' || !block.text) continue
    const remaining = MAX_EXCERPT_LENGTH - text.length
    if (block.text.length + (text ? 1 : 0) > remaining) {
      const prefix = text + (text && remaining ? '\n' : '')
      return {
        text: (prefix + block.text.slice(0, MAX_EXCERPT_LENGTH - prefix.length)).replace(
          /[\uD800-\uDBFF]$/,
          ''
        ),
        truncated: true
      }
    }
    text += text ? '\n' + block.text : block.text
  }
  return text ? { text, truncated: false } : undefined
}

function formatToolPreview(
  summary: { [key: string]: string | number | undefined },
  detail?: { field: 'arguments' | 'result'; value: unknown }
): string {
  if (!detail) return JSON.stringify(summary)
  const omissionField = `${detail.field}Omitted`
  const sizeLimit = Symbol()
  let remaining = MAX_TOOL_PREVIEW_BYTES
  try {
    const preview = JSON.stringify(
      { ...summary, [detail.field]: detail.value },
      function (this: unknown, key: string, value: unknown): unknown {
        if (value === undefined) return value
        // Check a lower bound before JSON builds escaped strings for large media blocks.
        remaining -= Array.isArray(this) ? 0 : key.length
        remaining -= typeof value === 'string' ? value.length + 2 : 1
        if (remaining < 0) throw sizeLimit
        return value
      }
    )
    if (Buffer.byteLength(preview) <= MAX_TOOL_PREVIEW_BYTES) return preview
  } catch (error) {
    if (error !== sizeLimit)
      return JSON.stringify({ ...summary, [omissionField]: 'encoding_error' })
  }
  return JSON.stringify({ ...summary, [omissionField]: 'size_limit' })
}

export type HarnessSessionTracing = {
  startTurn(
    prompt: readonly TextBlock[]
  ): ((outcome: string, requestCount?: number) => void) | undefined
  markCompaction(requestId: string): void
  captureModelRequest(body: RequestInit['body']): void
  wrapModel(model: AgentModel): AgentModel
  wrapTool(tool: AgentTool): AgentTool
}

type Turn = {
  span: StartedSpan
  captureExcerpts: boolean
  captureModelRequests: boolean
  captureToolArguments: boolean
  captureToolResults: boolean
  response?: Excerpt
  modelRequests: number
  compactionRequests: number
  toolExecutions: number
  compactionRequestId?: string
}

type SessionMetadata = {
  model: string
  protocol: string
  contextWindow: number
  inputBudget: number
}

function traceSession(
  record: SpanRecorder,
  sessionId: string,
  metadata: SessionMetadata,
  captureOptions: () => CaptureOptions | undefined
): HarnessSessionTracing {
  let active: Turn | undefined
  // Each session serializes model dispatch, including automatic compaction.
  let modelRequest: ModelRequestCapture | undefined
  const sessionAttributes = { 'session.id': sessionId, 'harness.session.id': sessionId }
  const modelAttributes = {
    'harness.model.protocol': metadata.protocol,
    'harness.context.window_tokens': metadata.contextWindow,
    'harness.context.input_budget_tokens': metadata.inputBudget
  }
  return {
    startTurn(prompt) {
      const capture = captureOptions()
      if (!capture) return undefined
      const span = startSpan('harness.turn', 1)
      if (!span) return undefined
      const turn: Turn = {
        span,
        captureExcerpts: capture.excerpts,
        captureModelRequests: capture.modelRequests,
        captureToolArguments: capture.toolArguments,
        captureToolResults: capture.toolResults,
        modelRequests: 0,
        compactionRequests: 0,
        toolExecutions: 0
      }
      let input: Excerpt | undefined
      try {
        if (capture.excerpts) input = userPromptExcerpt(prompt)
      } catch {
        // An unreadable diagnostic value cannot stop a turn.
      }
      active = turn
      return (outcome, requestCount) => {
        active = undefined
        record(
          span,
          outcome,
          {
            ...sessionAttributes,
            ...modelAttributes,
            'gen_ai.operation.name': 'invoke_agent',
            'gen_ai.agent.name': SERVICE_NAME,
            'harness.prompt.block_count': prompt.length,
            'harness.prompt.excerpt_truncated': input?.truncated,
            'harness.reply.excerpt_truncated': turn.response?.truncated,
            'harness.request.count': requestCount ?? turn.modelRequests,
            'harness.compaction.request_count': turn.compactionRequests,
            'harness.tool.execution_count': turn.toolExecutions
          },
          { input: input?.text, output: turn.response?.text }
        )
      }
    },
    markCompaction(requestId) {
      if (active) active.compactionRequestId = requestId
    },
    captureModelRequest(body) {
      if (!modelRequest || !captureOptions()) return
      try {
        if (typeof body !== 'string') modelRequest = { status: 'unsupported_body' }
        else if (body.length > MAX_REQUEST_BYTES) modelRequest = { status: 'size_limit' }
        else {
          const bytes = Buffer.byteLength(body)
          modelRequest =
            bytes <= MAX_REQUEST_BYTES
              ? { status: 'captured', body, bytes }
              : { status: 'size_limit', bytes }
        }
      } catch {
        modelRequest = { status: 'unsupported_body' }
      }
    },
    wrapModel(model) {
      return {
        ...model,
        stream(request, signal) {
          const turn = active
          if (!turn) return model.stream(request, signal)
          const stream = async function* (): AsyncGenerator<ModelEvent> {
            const span = startSpan('harness.model', 3, turn.span)
            const compaction = turn.compactionRequestId === request.requestId
            modelRequest = turn.captureModelRequests ? { status: 'not_sent' } : undefined
            turn.modelRequests++
            if (compaction) turn.compactionRequests++
            let reason: string | undefined
            let usage: ModelUsage | undefined
            let toolCalls: number | undefined
            let requestedTools: string[] | undefined
            let unknownToolCalls: number | undefined
            let response: Excerpt | undefined
            let completed = false
            try {
              for await (const event of model.stream(request, signal)) {
                if (event.type === 'finish') {
                  reason = event.reason
                  usage = event.usage
                  toolCalls = event.calls?.length ?? 0
                  try {
                    if (
                      turn.captureExcerpts &&
                      !compaction &&
                      event.reason !== 'tools' &&
                      captureOptions()
                    )
                      response = excerpt(event.content)
                    if (event.calls?.length) {
                      const offeredNames = new Set(request.tools.map((tool) => tool.name))
                      // Only record names in the tool catalog. Model-generated names can carry content.
                      const knownCalls = event.calls.filter((call) => offeredNames.has(call.name))
                      unknownToolCalls = toolCalls - knownCalls.length
                      requestedTools = knownCalls.slice(0, MAX_TOOL_NAMES).map((call) => call.name)
                    }
                  } catch {
                    // Always deliver the model event, even when its trace attributes cannot be read.
                  }
                }
                yield event
              }
              completed = true
            } finally {
              const outcome = signal.aborted ? 'cancelled' : (completed && reason) || 'error'
              const capturedRequest = modelRequest
              modelRequest = undefined
              if (!compaction && (outcome === 'complete' || outcome === 'length'))
                turn.response = response
              record(
                span,
                outcome,
                {
                  ...sessionAttributes,
                  ...modelAttributes,
                  'gen_ai.operation.name': 'chat',
                  'gen_ai.request.model': metadata.model,
                  'gen_ai.request.max_tokens': request.useProviderOutputDefault
                    ? undefined
                    : request.maxOutputTokens,
                  'gen_ai.usage.input_tokens': usage?.inputTokens,
                  'gen_ai.usage.output_tokens': usage?.outputTokens,
                  'gen_ai.usage.cache_read.input_tokens': usage?.cacheReadTokens,
                  'gen_ai.usage.cache_creation.input_tokens': usage?.cacheWriteTokens,
                  'harness.request.id': request.requestId,
                  'harness.request.purpose': compaction ? 'compaction' : 'turn',
                  'harness.context.message_count': request.messages.length,
                  'harness.tool.offered_count': request.tools.length,
                  'harness.tool.offered_names': request.tools
                    .slice(0, MAX_TOOL_NAMES)
                    .map((tool) => tool.name),
                  'harness.tool.requested_count': toolCalls,
                  'harness.tool.requested_names': requestedTools,
                  'harness.tool.unknown_requested_count': unknownToolCalls
                },
                { modelRequest: capturedRequest }
              )
            }
          }
          return stream()
        }
      }
    },
    wrapTool(tool) {
      return {
        ...tool,
        async execute(args, context) {
          const turn = active
          if (!turn) return tool.execute(args, context)
          const span = startSpan('harness.tool', 1, turn.span)
          turn.toolExecutions++
          let input: string | undefined
          try {
            const argumentCount =
              args && typeof args === 'object' && !Array.isArray(args)
                ? Object.keys(args).length
                : undefined
            input = formatToolPreview(
              { tool: tool.name.slice(0, 256), argumentCount },
              span && turn.captureToolArguments && captureOptions()
                ? { field: 'arguments', value: args }
                : undefined
            )
          } catch {
            // A diagnostic snapshot must not prevent execution.
          }
          let result: Awaited<ReturnType<AgentTool['execute']>> | undefined
          try {
            result = await tool.execute(args, context)
            return result
          } finally {
            try {
              let outcome = 'error'
              if (context.signal.aborted) outcome = 'cancelled'
              else if (result && typeof result === 'object') {
                if ('waiting' in result) outcome = 'waiting'
                else if (!result.isError) outcome = 'complete'
              }
              const resultBlockCount =
                result && 'content' in result ? result.content.length : undefined
              record(
                span,
                outcome,
                {
                  ...sessionAttributes,
                  'gen_ai.operation.name': 'execute_tool',
                  'gen_ai.tool.name': tool.name,
                  'harness.tool.invocation.id': context.invocationId
                },
                {
                  input,
                  output: formatToolPreview(
                    { outcome, resultBlockCount },
                    span && turn.captureToolResults && result !== undefined && captureOptions()
                      ? { field: 'result', value: result }
                      : undefined
                  )
                }
              )
            } catch {
              // Trace previews must not change the tool's result or error.
            }
          }
        }
      }
    }
  }
}

export type HarnessTracing = {
  ready: Promise<boolean>
  session(sessionId: string, metadata: SessionMetadata): HarnessSessionTracing
  dispose(): void
}

export function createHarnessTracing(
  endpoint: string | undefined,
  headersFile?: string,
  envFile?: string,
  launchSwitches?: NodeJS.Dict<string>
): HarnessTracing | undefined {
  if (endpoint === undefined && !envFile) return undefined
  const exporter = startTraceExport(endpoint, headersFile, envFile, launchSwitches)
  const record: SpanRecorder = (span, outcome, attributes, content) => {
    if (!span) return
    try {
      exporter.enqueue({ ...span, endTimeUnixNano: unixNanos(), outcome, attributes, content })
    } catch {
      // Recording spans must not change Agent behavior.
    }
  }
  return {
    ready: exporter.ready,
    session: (id, metadata) => traceSession(record, id, metadata, () => exporter.capture),
    dispose: exporter.dispose
  }
}
