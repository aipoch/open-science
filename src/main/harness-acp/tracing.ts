import { randomBytes } from 'node:crypto'
import { constants, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parseEnv } from 'node:util'
import type { AgentModel, AgentTool, ModelEvent, ModelUsage } from '@aipoch/agent-harness'
import {
  HARNESS_OTLP_TRACES_API_KEY,
  HARNESS_OTLP_TRACES_ENDPOINT,
  HARNESS_OTLP_TRACES_HEADERS,
  HARNESS_OTLP_TRACES_HEADERS_FILE
} from './config'

const MAX_QUEUED_SPANS = 256
const EXPORT_TIMEOUT_MS = 2_000
const MAX_HEADERS_FILE_BYTES = 8_192
const MAX_ENV_FILE_BYTES = 65_536
const SERVICE_NAME = 'open-science-agent'
const LANGFUSE_TRACE_PATH = '/api/public/otel/v1/traces'
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
  protocol: string,
  enabled: () => boolean
): HarnessSessionTracing {
  let active: Turn | undefined
  return {
    startTurn() {
      if (!enabled()) return undefined
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

async function readTraceFile(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Invalid OTLP configuration file')
    const buffer = Buffer.alloc(stat.size)
    for (let offset = 0; offset < buffer.length;) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) throw new Error('Incomplete OTLP configuration file')
      offset += bytesRead
    }
    return buffer.toString('utf8')
  } finally {
    await file.close()
  }
}

async function loadExportConfig(
  endpoint: string | undefined,
  headersFile: string | undefined,
  envFile: string | undefined
): Promise<{ url: URL; headers: Headers } | undefined> {
  // Explicit launch settings are one export destination. Do not attach file credentials to
  // a URL supplied by an environment override.
  const env =
    endpoint === undefined && envFile
      ? parseEnv(await readTraceFile(envFile, MAX_ENV_FILE_BYTES))
      : {}
  const target = endpoint ?? env[HARNESS_OTLP_TRACES_ENDPOINT]
  const path = headersFile ?? env[HARNESS_OTLP_TRACES_HEADERS_FILE]
  if (!target?.trim() || (path && !isAbsolute(path))) return undefined
  const url = new URL(target)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    return undefined
  const headers = new Headers()
  const rawHeaders = path
    ? await readTraceFile(path, MAX_HEADERS_FILE_BYTES)
    : env[HARNESS_OTLP_TRACES_HEADERS]
  const apiKey = env[HARNESS_OTLP_TRACES_API_KEY]?.trim()
  if (rawHeaders !== undefined) {
    const values: unknown = JSON.parse(rawHeaders)
    if (!values || typeof values !== 'object' || Array.isArray(values))
      throw new Error('Expected an OTLP headers object')
    for (const [name, value] of Object.entries(values)) {
      if (typeof value !== 'string') throw new Error('Expected an OTLP header string')
      headers.set(name, value)
    }
  } else if (apiKey) {
    headers.set('authorization', `Bearer ${apiKey}`)
  } else if (url.pathname === LANGFUSE_TRACE_PATH) {
    const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim()
    const secretKey = env.LANGFUSE_SECRET_KEY?.trim()
    if (publicKey || secretKey) {
      if (!publicKey || !secretKey || publicKey.includes(':')) return undefined
      const credentials = Buffer.from(`${publicKey}:${secretKey}`, 'utf8').toString('base64')
      headers.set('authorization', `Basic ${credentials}`)
      headers.set('x-langfuse-ingestion-version', '4')
    }
  }
  headers.set('content-type', 'application/json')
  return { url, headers }
}

/** Best-effort OTLP/HTTP JSON, owned by the ACP helper. No global SDK, logging or disk queue. */
export function createHarnessTracing(
  endpoint: string | undefined,
  headersFile?: string,
  envFile?: string
): HarnessTracing | undefined {
  if (endpoint === undefined && !envFile) return undefined
  const lifetime = new AbortController()
  let queued: FinishedSpan[] = []
  let exporting = false
  let scheduled: NodeJS.Immediate | undefined
  let disabled = false
  const destination = loadExportConfig(endpoint, headersFile, envFile)
    .catch(() => undefined)
    .then((config) => {
      if (!config) {
        disabled = true
        queued = []
      }
      return config
    })

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
      const config = await destination
      if (!config || lifetime.signal.aborted) return
      const { url, headers } = config
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
    if (!span || disabled || lifetime.signal.aborted || queued.length >= MAX_QUEUED_SPANS) return
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
    session: (id, model, protocol) => traceSession(record, id, model, protocol, () => !disabled),
    dispose() {
      lifetime.abort()
      queued = []
      if (scheduled) clearImmediate(scheduled)
    }
  }
}
