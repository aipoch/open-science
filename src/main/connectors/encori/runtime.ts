import { netFetchStandard } from '../../skills/net-fetch'
import { abortableDelay } from '../abortable-delay'
import type { ToolContext } from '../types'

export type Args = Record<string, unknown>
export const MAX_BYTES = 64 * 1024 * 1024
export const success = (url: string): Args => ({
  ok: true,
  database: 'ENCORI',
  source_url: url,
  queried_at: new Date().toISOString(),
  error: null
})

export class EncoriError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly statusCode: number | null = null,
    readonly sourceUrl: string | null = null
  ) {
    super(message)
  }

  asResult(): Args {
    return {
      ...success(this.sourceUrl ?? ''),
      ok: false,
      source_url: this.sourceUrl,
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        status_code: this.statusCode
      }
    }
  }
}

export function failure(error: unknown, url: string | null = null): EncoriError {
  if (error instanceof EncoriError)
    return new EncoriError(
      error.code,
      error.message,
      error.retryable,
      error.statusCode,
      error.sourceUrl ?? url
    )
  const message = error instanceof Error ? error.message : String(error)
  const code = /^ENCORI ([a-z_]+)[.:]/.exec(message)?.[1]
  const fsCode = (error as NodeJS.ErrnoException)?.code
  return new EncoriError(
    code ?? (typeof fsCode === 'string' ? 'file_write_error' : 'unexpected_response'),
    message,
    false,
    null,
    url
  )
}

// Permission and JSON-schema checks run in the existing service before this wrapper.
// Caller cancellation remains a cancellation, rather than a successful error payload.
export async function encoriCall(ctx: ToolContext, operation: () => Promise<Args>): Promise<Args> {
  try {
    ctx.signal?.throwIfAborted()
    return await operation()
  } catch (error) {
    ctx.signal?.throwIfAborted()
    return failure(error).asResult()
  }
}

export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

// Shared by all ENCORI tools in this app process; concurrent calls cannot burst past
// the original connector's 100 ms minimum interval.
let nextRequestAt = 0
async function rateLimit(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const start = Math.max(Date.now(), nextRequestAt)
  nextRequestAt = start + 100
  await abortableDelay(Math.max(0, start - Date.now()), signal)
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const value = response?.headers.get('retry-after')
  if (value) {
    const numeric = Number(value)
    const milliseconds = Number.isFinite(numeric) ? numeric * 1000 : Date.parse(value) - Date.now()
    if (Number.isFinite(milliseconds)) return Math.min(Math.max(milliseconds, 0), 30000)
  }
  return 500 * 2 ** attempt
}

type ReceiveOptions = { idleTimeoutMs?: number; retries?: number }
type BodyContext = { signal: AbortSignal; touch: () => void }

// The callback owns reading the response under the same idle timer as the request.
// Retrying a download invokes its RequestInit factory again, using the current
// flushed .part offset. Callbacks finish closing file handles before another attempt.
export async function receive<T>(
  url: string,
  ctx: ToolContext,
  init: RequestInit | (() => RequestInit),
  read: (response: Response, body: BodyContext) => Promise<T>,
  options: ReceiveOptions = {}
): Promise<T> {
  const retries = options.retries ?? 2
  for (let attempt = 0; ; attempt++) {
    await rateLimit(ctx.signal)
    const controller = new AbortController()
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    const touch = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(
        () =>
          controller.abort(
            new EncoriError(
              'network_error',
              'ENCORI request timed out while waiting for network data.',
              true,
              null,
              url
            )
          ),
        options.idleTimeoutMs ?? 45000
      )
    }
    let response: Response | undefined
    let failure: EncoriError | undefined
    try {
      signal.throwIfAborted()
      const requestInit = typeof init === 'function' ? init() : init
      touch()
      const pending = netFetchStandard(url, {
        ...requestInit,
        signal,
        headers: { 'accept-encoding': 'identity', ...requestInit.headers }
      })
      // Also dispose of a late reply from an injected/non-cancellable fetch.
      void pending
        .then((reply) => {
          if (signal.aborted) void reply.body?.cancel().catch(() => undefined)
        })
        .catch(() => undefined)
      try {
        response = await abortable(pending, signal)
      } catch {
        if (signal.aborted) throw signal.reason
        throw new EncoriError('network_error', 'Unable to connect to ENCORI.', true, null, url)
      }
      if (!response.ok)
        throw new EncoriError(
          'upstream_http_error',
          `ENCORI returned HTTP ${response.status}.`,
          [429, 500, 502, 503, 504].includes(response.status),
          response.status,
          url
        )
      return await read(response, { signal, touch })
    } catch (error) {
      ctx.signal?.throwIfAborted()
      if (signal.aborted && signal.reason instanceof EncoriError) failure = signal.reason
      else if (error instanceof EncoriError) failure = error
      else throw error
    } finally {
      if (timer) clearTimeout(timer)
      controller.abort()
      void response?.body?.cancel().catch(() => undefined)
    }
    if (!failure.sourceUrl)
      failure = new EncoriError(
        failure.code,
        failure.message,
        failure.retryable,
        failure.statusCode,
        url
      )
    if (!failure.retryable || attempt >= retries) throw failure
    await abortableDelay(retryDelay(response, attempt), ctx.signal)
  }
}

export async function readBytes(
  response: Response,
  { signal, touch }: BodyContext
): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    throw new EncoriError('response_too_large', 'Narrow the query or use a bulk dataset.')
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const cancel = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined)
  }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal)
      signal.throwIfAborted()
      if (done) break
      touch()
      size += value.length
      if (size > MAX_BYTES)
        throw new EncoriError('response_too_large', 'Narrow the query or use a bulk dataset.')
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof EncoriError || signal.aborted) throw error
    throw new EncoriError('network_error', 'ENCORI response stream failed.', true)
  } finally {
    signal.removeEventListener('abort', cancel)
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}
