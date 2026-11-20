import { constants, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { parseEnv } from 'node:util'
import {
  HARNESS_OTLP_CAPTURE_API_REQUEST,
  HARNESS_OTLP_CAPTURE_CONTENT,
  HARNESS_OTLP_CAPTURE_TOOL_ARGUMENTS,
  HARNESS_OTLP_CAPTURE_TOOL_RESULTS,
  HARNESS_OTLP_DIAGNOSTICS,
  HARNESS_OTLP_SWITCHES,
  HARNESS_OTLP_TRACES_API_KEY,
  HARNESS_OTLP_TRACES_ENDPOINT,
  HARNESS_OTLP_TRACES_HEADERS,
  HARNESS_OTLP_TRACES_HEADERS_FILE
} from './config'

const MAX_QUEUED_SPANS = 256
const MAX_EXPORT_BATCH_SPANS = 32
const MAX_QUEUED_REQUEST_BYTES = 4 * 1024 * 1024
export const MAX_REQUEST_BYTES = 1024 * 1024
const CONFIG_TIMEOUT_MS = 1_000
const EXPORT_TIMEOUT_MS = 2_000
const MAX_HEADERS_FILE_BYTES = 8_192
const MAX_ENV_FILE_BYTES = 65_536
const LANGFUSE_TRACE_PATH = '/api/public/otel/v1/traces'

export const SERVICE_NAME = 'open-science-agent'

export type TraceAttributes = Record<string, string | number | boolean | string[] | undefined>
export type ModelRequestCapture =
  | { status: 'captured'; body: string; bytes: number }
  | { status: 'size_limit' | 'queue_limit'; bytes?: number }
  | { status: 'not_sent' | 'unsupported_body' }

export type SpanContent = {
  input?: string
  output?: string
  modelRequest?: ModelRequestCapture
}
export type TraceSpan = {
  name: string
  traceId: string
  spanId: string
  parentSpanId?: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  kind: 1 | 3
  outcome: string
  attributes: TraceAttributes
  content?: SpanContent
}

export type CaptureOptions = {
  excerpts: boolean
  modelRequests: boolean
  toolArguments: boolean
  toolResults: boolean
}
type TraceDestination = {
  url: URL
  headers: Headers
  statusFile?: string
  capture: CaptureOptions
}
type StringValue = { stringValue: string }
type AttributeValue =
  | StringValue
  | { intValue: string }
  | { boolValue: boolean }
  | { arrayValue: { values: StringValue[] } }
type EncodedAttribute = { key: string; value: AttributeValue }

function encodeString(value: string): StringValue {
  return { stringValue: value.slice(0, 256).replace(/[\uD800-\uDBFF]$/, '') }
}

function encodeAttributes(attributes: TraceAttributes): EncodedAttribute[] {
  const encoded: EncodedAttribute[] = []
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string') encoded.push({ key, value: encodeString(value) })
    else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      encoded.push({ key, value: { intValue: String(value) } })
    else if (typeof value === 'boolean') encoded.push({ key, value: { boolValue: value } })
    else if (Array.isArray(value))
      encoded.push({ key, value: { arrayValue: { values: value.map(encodeString) } } })
  }
  return encoded
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
  target: string,
  headersFile: string | undefined,
  env: NodeJS.Dict<string>
): Promise<{ url: URL; headers: Headers } | undefined> {
  const path = headersFile ?? env[HARNESS_OTLP_TRACES_HEADERS_FILE]
  if (path && !isAbsolute(path)) return undefined
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
    if (publicKey !== undefined || secretKey !== undefined) {
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

async function loadTraceDestination(
  endpoint: string | undefined,
  headersFile: string | undefined,
  envFile: string | undefined,
  launchSwitches: NodeJS.Dict<string>,
  signal: AbortSignal
): Promise<TraceDestination | undefined> {
  // Explicit launch settings are one destination. File credentials stay with the file URL.
  const env: NodeJS.Dict<string> =
    endpoint === undefined && envFile
      ? await readTraceFile(envFile, MAX_ENV_FILE_BYTES)
          .then(parseEnv)
          .catch(() => ({}))
      : {}
  const target = (endpoint ?? env[HARNESS_OTLP_TRACES_ENDPOINT])?.trim()
  if (signal.aborted || !target) return undefined
  const switches = endpoint === undefined ? env : launchSwitches
  const enabled = (name: (typeof HARNESS_OTLP_SWITCHES)[number]): boolean =>
    (switches[name] ?? '1') === '1'
  const statusFile =
    envFile && enabled(HARNESS_OTLP_DIAGNOSTICS) ? `${envFile}.otel-status.json` : undefined
  const destination = await loadExportConfig(
    target,
    endpoint === undefined ? undefined : headersFile,
    env
  ).catch(() => undefined)
  if (!destination) {
    if (statusFile && !signal.aborted)
      void writeUploadStatus(statusFile, { outcome: 'invalid_configuration' })
    return undefined
  }
  return {
    ...destination,
    statusFile,
    capture: {
      excerpts: enabled(HARNESS_OTLP_CAPTURE_CONTENT),
      modelRequests: enabled(HARNESS_OTLP_CAPTURE_API_REQUEST),
      toolArguments: enabled(HARNESS_OTLP_CAPTURE_TOOL_ARGUMENTS),
      toolResults: enabled(HARNESS_OTLP_CAPTURE_TOOL_RESULTS)
    }
  }
}

type QueuedSpan = {
  span: TraceSpan
  requestBytes: number
}
type EncodedSpan = Omit<TraceSpan, 'outcome' | 'content' | 'attributes'> & {
  flags: 1
  status?: { code: 2 }
  attributes: EncodedAttribute[]
}

function encodeSpan({ outcome, content, attributes, ...timing }: TraceSpan): EncodedSpan {
  const modelRequest = content?.modelRequest
  const encoded = encodeAttributes({
    ...attributes,
    'harness.outcome': outcome,
    'harness.request.body_capture': modelRequest?.status,
    'harness.request.body_bytes':
      modelRequest && 'bytes' in modelRequest ? modelRequest.bytes : undefined
  })
  // OpenInference input/output attributes also render in Langfuse's observation panels.
  const input = modelRequest?.status === 'captured' ? modelRequest.body : content?.input
  if (input !== undefined) encoded.push({ key: 'input.value', value: { stringValue: input } })
  if (content?.output !== undefined)
    encoded.push({ key: 'output.value', value: { stringValue: content.output } })
  return {
    ...timing,
    flags: 1, // Sampled
    ...(outcome === 'error' ? { status: { code: 2 } } : {}),
    attributes: encoded
  }
}

type TraceExporter = {
  readonly ready: Promise<boolean>
  readonly capture: CaptureOptions | undefined
  enqueue(span: TraceSpan): void
  dispose(): void
}

/** Owns configuration, bounds and transport. The caller never waits for trace I/O. */
export function startTraceExport(
  endpoint: string | undefined,
  headersFile: string | undefined,
  envFile: string | undefined,
  launchSwitches: NodeJS.Dict<string> = {}
): TraceExporter {
  const lifetime = new AbortController()
  const configRead = new AbortController()
  const configSignal = AbortSignal.any([lifetime.signal, configRead.signal])
  let destination: TraceDestination | undefined
  const ready = Promise.race([
    loadTraceDestination(endpoint, headersFile, envFile, launchSwitches, configSignal),
    wait(CONFIG_TIMEOUT_MS, undefined, { ref: false, signal: configSignal })
  ])
    .catch(() => undefined)
    .then((loaded) => {
      if (!lifetime.signal.aborted) destination = loaded
      return destination !== undefined
    })
    .finally(() => configRead.abort())

  const queued: QueuedSpan[] = []
  let queuedRequestBytes = 0
  let exporting = false
  let scheduled: NodeJS.Immediate | undefined

  function scheduleExport(): void {
    if (scheduled || exporting || !queued.length || !destination) return
    scheduled = setImmediate(() => {
      scheduled = undefined
      if (destination) void send(destination).catch(() => undefined)
    }).unref()
  }

  async function send({ url, headers, statusFile }: TraceDestination): Promise<void> {
    let count = 0
    let requestBytes = 0
    for (const item of queued) {
      if (count === MAX_EXPORT_BATCH_SPANS || requestBytes + item.requestBytes > MAX_REQUEST_BYTES)
        break
      count++
      requestBytes += item.requestBytes
    }
    const batch = queued.splice(0, count)
    queuedRequestBytes -= requestBytes
    exporting = true
    const timeout = AbortSignal.timeout(EXPORT_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: { attributes: encodeAttributes({ 'service.name': SERVICE_NAME }) },
              scopeSpans: [
                { scope: { name: SERVICE_NAME }, spans: batch.map(({ span }) => encodeSpan(span)) }
              ]
            }
          ]
        }),
        redirect: 'error',
        signal: AbortSignal.any([lifetime.signal, timeout])
      })
      void response.body?.cancel().catch(() => undefined)
      if (statusFile && !lifetime.signal.aborted)
        await writeUploadStatus(statusFile, {
          outcome: response.ok ? 'http_accepted' : 'http_rejected',
          httpStatus: response.status
        })
    } catch {
      if (statusFile && !lifetime.signal.aborted)
        await writeUploadStatus(statusFile, {
          outcome: timeout.aborted ? 'timeout' : 'transport_error'
        })
      // A failed batch is dropped without retrying or propagating telemetry errors.
    } finally {
      exporting = false
      scheduleExport()
    }
  }

  return {
    ready,
    get capture() {
      return destination?.capture
    },
    enqueue(span: TraceSpan) {
      if (!destination || queued.length >= MAX_QUEUED_SPANS) return
      const request = span.content?.modelRequest
      let requestBytes = 0
      if (request?.status === 'captured') {
        if (queuedRequestBytes + request.bytes > MAX_QUEUED_REQUEST_BYTES) {
          span = {
            ...span,
            content: {
              ...span.content,
              modelRequest: { status: 'queue_limit', bytes: request.bytes }
            }
          }
        } else requestBytes = request.bytes
      }
      queued.push({ span, requestBytes })
      queuedRequestBytes += requestBytes
      scheduleExport()
    },
    dispose() {
      destination = undefined
      lifetime.abort()
      queued.length = 0
      queuedRequestBytes = 0
      if (scheduled) clearImmediate(scheduled)
    }
  }
}
