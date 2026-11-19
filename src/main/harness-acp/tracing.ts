import { randomBytes } from 'node:crypto'
import { constants, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { AgentModel, AgentTool, ModelEvent, ModelUsage } from '@aipoch/agent-harness'

const MAX_QUEUED_SPANS = 256
const EXPORT_TIMEOUT_MS = 2_000
const MAX_HEADERS_FILE_BYTES = 8_192
const SERVICE_NAME = 'open-science-agent'
const timeOriginNanos = BigInt(Math.round(performance.timeOrigin * 1_000)) * 1_000n
const unixNanos = (): string =>
  (timeOriginNanos + BigInt(Math.round(performance.now() * 1_000_000))).toString()

type StartedSpan = {
  name: string
  traceId: string
  spanId: string
  parentSpanId?: string
  startTimeUnixNano: string
  kind: 1 | 3 // OTLP INTERNAL or CLIENT
}
type AttributeValue = { stringValue: string } | { intValue: string }
type FinishedSpan = StartedSpan & {
  endTimeUnixNano: string
  flags: 1 // Sampled
  status?: { code: 2 } // ERROR
  attributes: { key: string; value: AttributeValue }[]
}

function startSpan(
  name: string,
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

type Attributes = Record<string, string | number | undefined>

function encodeAttributes(attributes: Attributes): FinishedSpan['attributes'] {
  const encoded: FinishedSpan['attributes'] = []
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string')
      encoded.push({ key, value: { stringValue: value.slice(0, 256) } })
    else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      encoded.push({ key, value: { intValue: String(value) } })
  }
  return encoded
}

type SpanRecorder = (span: StartedSpan | undefined, outcome: string, attributes: Attributes) => void

export type HarnessSessionTracing = {
  startTurn(): ((outcome: string, requestCount?: number) => void) | undefined
  markCompaction(requestId: string): void
  wrapModel(model: AgentModel): AgentModel
  wrapTool(tool: AgentTool): AgentTool
}

type Turn = { span: StartedSpan; compactionRequestId?: string }

function traceSession(
  record: SpanRecorder,
  sessionId: string,
  modelName: string,
  protocol: string
): HarnessSessionTracing {
  let active: Turn | undefined
  return {
    startTurn() {
      const span = startSpan('harness.turn', 1)
      if (!span) return undefined
      active = { span }
      return (outcome, requestCount) => {
        active = undefined
        record(span, outcome, {
          'harness.session.id': sessionId,
          'harness.model.protocol': protocol,
          'harness.request.count': requestCount,
          'gen_ai.request.model': modelName
        })
      }
    },
    markCompaction(requestId) {
      if (active) active.compactionRequestId = requestId
    },
    wrapModel(model) {
      return {
        ...model,
        stream(request, signal) {
          const turn = active
          if (!turn) return model.stream(request, signal)
          const stream = async function* (): AsyncGenerator<ModelEvent> {
            const span = startSpan('harness.model', 3, turn.span)
            let reason: string | undefined
            let usage: ModelUsage | undefined
            let completed = false
            try {
              for await (const event of model.stream(request, signal)) {
                yield event
                if (event.type === 'finish') {
                  reason = event.reason
                  usage = event.usage
                }
              }
              completed = true
            } finally {
              record(span, signal.aborted ? 'cancelled' : (completed && reason) || 'error', {
                'harness.request.id': request.requestId,
                'harness.request.purpose':
                  turn.compactionRequestId === request.requestId ? 'compaction' : 'turn',
                'gen_ai.request.model': modelName,
                'gen_ai.usage.input_tokens': usage?.inputTokens,
                'gen_ai.usage.output_tokens': usage?.outputTokens,
                'gen_ai.usage.cache_read.input_tokens': usage?.cacheReadTokens,
                'gen_ai.usage.cache_creation.input_tokens': usage?.cacheWriteTokens
              })
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
          let result: Awaited<ReturnType<AgentTool['execute']>> | undefined
          try {
            result = await tool.execute(args, context)
            return result
          } finally {
            let outcome = 'error'
            if (context.signal.aborted) outcome = 'cancelled'
            else if (result && typeof result === 'object') {
              if ('waiting' in result) outcome = 'waiting'
              else if (!result.isError) outcome = 'complete'
            }
            record(span, outcome, { 'gen_ai.tool.name': tool.name })
          }
        }
      }
    }
  }
}

export type HarnessTracing = {
  session(sessionId: string, model: string, protocol: string): HarnessSessionTracing
  dispose(): void
}

async function loadExportHeaders(filePath: string | undefined): Promise<Headers> {
  const headers = new Headers()
  if (filePath) {
    const file = await open(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > MAX_HEADERS_FILE_BYTES)
        throw new Error('Invalid OTLP headers file')
      const buffer = Buffer.alloc(stat.size)
      for (let offset = 0; offset < buffer.length;) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
        if (!bytesRead) throw new Error('Incomplete OTLP headers file')
        offset += bytesRead
      }
      const values: unknown = JSON.parse(buffer.toString('utf8'))
      if (!values || typeof values !== 'object' || Array.isArray(values))
        throw new Error('Expected an OTLP headers object')
      for (const [name, value] of Object.entries(values)) {
        if (typeof value !== 'string') throw new Error('Expected an OTLP header string')
        headers.set(name, value)
      }
    } finally {
      await file.close()
    }
  }
  headers.set('content-type', 'application/json')
  return headers
}

/** Best-effort OTLP/HTTP JSON, owned by the ACP helper. No global SDK, logging or disk queue. */
export function createHarnessTracing(
  endpoint: string | undefined,
  headersFile?: string
): HarnessTracing | undefined {
  if (!endpoint?.trim() || (headersFile && !isAbsolute(headersFile))) return undefined
  let url: URL
  try {
    url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
      return undefined
  } catch {
    return undefined
  }

  const lifetime = new AbortController()
  let queued: FinishedSpan[] = []
  let exporting = false
  let scheduled: NodeJS.Immediate | undefined
  let exportHeaders: Promise<Headers> | undefined

  function scheduleExport(): void {
    if (scheduled || exporting || !queued.length || lifetime.signal.aborted) return
    scheduled = setImmediate(() => {
      scheduled = undefined
      void send().catch(() => undefined)
    }).unref()
  }

  async function send(): Promise<void> {
    const spans = queued
    queued = []
    exporting = true
    try {
      // Resolve credentials lazily, on the export path. A configured file must load successfully
      // before this helper sends any traces.
      const headers = await (exportHeaders ??= loadExportHeaders(headersFile))
      if (lifetime.signal.aborted) return
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: { attributes: encodeAttributes({ 'service.name': SERVICE_NAME }) },
              scopeSpans: [{ scope: { name: SERVICE_NAME }, spans }]
            }
          ]
        }),
        redirect: 'error',
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(EXPORT_TIMEOUT_MS)])
      })
      await response.body?.cancel()
    } catch {
      // A failed batch is dropped. Never retry, log or propagate telemetry errors.
    } finally {
      exporting = false
      scheduleExport()
    }
  }

  const record: SpanRecorder = (span, outcome, attributes) => {
    if (!span || lifetime.signal.aborted || queued.length >= MAX_QUEUED_SPANS) return
    try {
      queued.push({
        ...span,
        flags: 1,
        endTimeUnixNano: unixNanos(),
        ...(outcome === 'error' ? { status: { code: 2 } } : {}),
        attributes: encodeAttributes({ ...attributes, 'harness.outcome': outcome })
      })
      scheduleExport()
    } catch {
      // Recording spans must not change Agent behavior.
    }
  }

  return {
    session: (id, model, protocol) => traceSession(record, id, model, protocol),
    dispose() {
      lifetime.abort()
      queued = []
      if (scheduled) clearImmediate(scheduled)
    }
  }
}
