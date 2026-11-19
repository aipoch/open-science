import { randomBytes } from 'node:crypto'
import { constants, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parseEnv } from 'node:util'
import type { AgentModel, AgentTool, ModelEvent, ModelUsage } from '@aipoch/agent-harness'
import {
  HARNESS_OTLP_CAPTURE_CONTENT,
  HARNESS_OTLP_DIAGNOSTICS,
  HARNESS_OTLP_TRACES_API_KEY,
  HARNESS_OTLP_TRACES_ENDPOINT,
  HARNESS_OTLP_TRACES_HEADERS,
  HARNESS_OTLP_TRACES_HEADERS_FILE
} from './config'

const MAX_QUEUED_SPANS = 256
const MAX_EXPORT_BATCH_SPANS = 32
const EXPORT_TIMEOUT_MS = 2_000
const MAX_HEADERS_FILE_BYTES = 8_192
const MAX_ENV_FILE_BYTES = 65_536
const MAX_PREVIEW_TEXT = 4_096
const SERVICE_NAME = 'open-science-agent'
const LANGFUSE_TRACE_PATH = '/api/public/otel/v1/traces'
const timeOriginNanos = BigInt(Math.round(performance.timeOrigin * 1_000)) * 1_000n
const unixNanos = (): string =>
  (timeOriginNanos + BigInt(Math.round(performance.now() * 1_000_000))).toString()

const observationTypes = {
  'harness.turn': 'agent',
  'harness.model': 'generation',
  'harness.tool': 'tool'
} as const

type StartedSpan = {
  name: keyof typeof observationTypes
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

type Preview = { input: object; output: object }
type TextBlock = { type: string; text?: string }
type TextPreview = { text: string; truncated?: true }

function previewText(blocks: readonly TextBlock[]): TextPreview | undefined {
  let text = ''
  for (const block of blocks) {
    if (block.type !== 'text' || !block.text) continue
    if (text) text += '\n'
    const remaining = MAX_PREVIEW_TEXT - text.length
    if (block.text.length > remaining) {
      // Keep the prefix valid Unicode when it ends inside a surrogate pair.
      const prefix = (text + block.text.slice(0, Math.max(0, remaining))).slice(0, MAX_PREVIEW_TEXT)
      return { text: prefix.replace(/[\uD800-\uDBFF]$/, ''), truncated: true }
    }
    text += block.text
  }
  return text ? { text } : undefined
}

type SpanRecorder = (
  span: StartedSpan | undefined,
  outcome: string,
  attributes: Attributes,
  preview: Preview
) => void

export type HarnessSessionTracing = {
  startTurn(
    prompt?: readonly TextBlock[]
  ): ((outcome: string, requestCount?: number) => void) | undefined
  markCompaction(requestId: string): void
  wrapModel(model: AgentModel): AgentModel
  wrapTool(tool: AgentTool): AgentTool
}

type Turn = {
  span: StartedSpan
  prompt?: TextPreview
  response?: TextPreview
  modelRequests: number
  compactionRequests: number
  toolExecutions: number
  compactionRequestId?: string
}

function traceSession(
  record: SpanRecorder,
  sessionId: string,
  modelName: string,
  protocol: string,
  enabled: () => boolean,
  captureContent: () => boolean
): HarnessSessionTracing {
  let active: Turn | undefined
  const sessionAttributes = { 'langfuse.session.id': sessionId }
  return {
    startTurn(prompt = []) {
      if (!enabled()) return undefined
      const span = startSpan('harness.turn', 1)
      if (!span) return undefined
      const turn: Turn = {
        span,
        prompt: captureContent() ? previewText(prompt) : undefined,
        modelRequests: 0,
        compactionRequests: 0,
        toolExecutions: 0
      }
      active = turn
      return (outcome, requestCount) => {
        active = undefined
        record(
          span,
          outcome,
          {
            ...sessionAttributes,
            'harness.session.id': sessionId,
            'harness.model.protocol': protocol,
            'harness.request.count': requestCount
          },
          {
            input: {
              model: modelName.slice(0, 256),
              protocol,
              promptBlocks: prompt.length,
              prompt: turn.prompt
            },
            output: {
              stopReason: outcome,
              modelRequests: requestCount ?? turn.modelRequests,
              compactionRequests: turn.compactionRequests,
              toolExecutions: turn.toolExecutions,
              response: turn.response
            }
          }
        )
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
            const compaction = turn.compactionRequestId === request.requestId
            const purpose = compaction ? 'compaction' : 'turn'
            turn.modelRequests++
            if (compaction) turn.compactionRequests++
            let reason: string | undefined
            let usage: ModelUsage | undefined
            let response: TextPreview | undefined
            let toolCalls: number | undefined
            let completed = false
            try {
              for await (const event of model.stream(request, signal)) {
                yield event
                if (event.type === 'finish') {
                  reason = event.reason
                  usage = event.usage
                  toolCalls = event.calls?.length ?? 0
                  if (!compaction && captureContent()) response = previewText(event.content)
                }
              }
              completed = true
            } finally {
              const outcome = signal.aborted ? 'cancelled' : (completed && reason) || 'error'
              if (!compaction && (outcome === 'complete' || outcome === 'length'))
                turn.response = response
              record(
                span,
                outcome,
                {
                  ...sessionAttributes,
                  'harness.request.id': request.requestId,
                  'harness.request.purpose': purpose,
                  'gen_ai.request.model': modelName,
                  'gen_ai.usage.input_tokens': usage?.inputTokens,
                  'gen_ai.usage.output_tokens': usage?.outputTokens,
                  'gen_ai.usage.cache_read.input_tokens': usage?.cacheReadTokens,
                  'gen_ai.usage.cache_creation.input_tokens': usage?.cacheWriteTokens
                },
                {
                  input: {
                    purpose,
                    messages: request.messages.length,
                    availableTools: request.tools.length,
                    maxOutputTokens: request.useProviderOutputDefault
                      ? undefined
                      : request.maxOutputTokens,
                    turnPrompt: compaction ? undefined : turn.prompt
                  },
                  output: {
                    outcome,
                    toolCalls,
                    usage: usage && {
                      inputTokens: usage.inputTokens,
                      outputTokens: usage.outputTokens,
                      cacheReadTokens: usage.cacheReadTokens,
                      cacheWriteTokens: usage.cacheWriteTokens
                    },
                    response
                  }
                }
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
            const toolName = tool.name.slice(0, 256)
            record(
              span,
              outcome,
              { ...sessionAttributes, 'gen_ai.tool.name': toolName },
              { input: { tool: toolName }, output: { outcome } }
            )
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
  env: NodeJS.Dict<string>
): Promise<{ url: URL; headers: Headers } | undefined> {
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

type UploadStatus =
  | { outcome: 'http_accepted' | 'http_rejected'; httpStatus: number }
  | { outcome: 'invalid_configuration' | 'timeout' | 'transport_error' }

async function writeUploadStatus(path: string, status: UploadStatus): Promise<void> {
  try {
    const file = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
      0o600
    )
    try {
      if (!(await file.stat()).isFile()) return
      // A fixed-width record keeps concurrent helpers from truncating each other's status.
      const contents =
        JSON.stringify({ at: new Date().toISOString(), ...status }).padEnd(127) + '\n'
      await file.writeFile(contents)
      await file.truncate(Buffer.byteLength(contents))
    } finally {
      await file.close()
    }
  } catch {
    // The status file is best effort and never participates in the Agent protocol.
  }
}

/** Best-effort OTLP/HTTP JSON, owned by the ACP helper. */
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
  let captureContent = false
  const destination = (async () => {
    // Explicit launch settings are one destination. File credentials stay with the file URL.
    const env =
      endpoint === undefined && envFile
        ? parseEnv(await readTraceFile(envFile, MAX_ENV_FILE_BYTES))
        : {}
    const statusFile =
      envFile && env[HARNESS_OTLP_DIAGNOSTICS] === '1' ? `${envFile}.otel-status.json` : undefined
    captureContent = env[HARNESS_OTLP_CAPTURE_CONTENT] === '1'
    const config = await loadExportConfig(endpoint, headersFile, env).catch(() => undefined)
    if (!config) {
      if (statusFile && !lifetime.signal.aborted)
        await writeUploadStatus(statusFile, { outcome: 'invalid_configuration' })
      return undefined
    }
    return { ...config, statusFile }
  })()
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
    const spans = queued.splice(0, MAX_EXPORT_BATCH_SPANS)
    exporting = true
    let statusFile: string | undefined
    let timeout: AbortSignal | undefined
    try {
      const config = await destination
      if (!config || lifetime.signal.aborted) return
      const { url, headers } = config
      statusFile = config.statusFile
      timeout = AbortSignal.timeout(EXPORT_TIMEOUT_MS)
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
        signal: AbortSignal.any([lifetime.signal, timeout])
      })
      await response.body?.cancel().catch(() => undefined)
      if (statusFile && !lifetime.signal.aborted)
        await writeUploadStatus(statusFile, {
          outcome: response.ok ? 'http_accepted' : 'http_rejected',
          httpStatus: response.status
        })
    } catch {
      if (statusFile && !lifetime.signal.aborted)
        await writeUploadStatus(statusFile, {
          outcome: timeout?.aborted ? 'timeout' : 'transport_error'
        })
      // A failed batch is dropped without retrying or propagating telemetry errors.
    } finally {
      exporting = false
      scheduleExport()
    }
  }

  const record: SpanRecorder = (span, outcome, attributes, preview) => {
    if (!span || disabled || lifetime.signal.aborted || queued.length >= MAX_QUEUED_SPANS) return
    try {
      queued.push({
        ...span,
        flags: 1,
        endTimeUnixNano: unixNanos(),
        ...(outcome === 'error' ? { status: { code: 2 } } : {}),
        attributes: [
          ...encodeAttributes({
            ...attributes,
            'harness.outcome': outcome,
            'langfuse.observation.type': observationTypes[span.name]
          }),
          {
            key: 'langfuse.observation.input',
            value: { stringValue: JSON.stringify(preview.input) }
          },
          {
            key: 'langfuse.observation.output',
            value: { stringValue: JSON.stringify(preview.output) }
          }
        ]
      })
      scheduleExport()
    } catch {
      // Recording spans must not change Agent behavior.
    }
  }

  return {
    session: (id, model, protocol) =>
      traceSession(
        record,
        id,
        model,
        protocol,
        () => !disabled,
        () => captureContent
      ),
    dispose() {
      lifetime.abort()
      queued = []
      if (scheduled) clearImmediate(scheduled)
    }
  }
}
