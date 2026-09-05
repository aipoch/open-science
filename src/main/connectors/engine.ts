import type { ConnectorCredentials, ToolContext, ToolDescriptor } from './types'
import { abortableDelay } from './abortable-delay'
import { CONNECTOR_RETRYABLE_STATUS, connectorRetryDelay } from './request-policy'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024

// Transient-failure retry policy shared by every connector call. Public bio APIs (PubChem PUG-REST,
// GTEx, NCBI) routinely return 429/5xx or a brief connection failure under load; a couple of
// backed-off retries turn those blips into successes instead of surfacing them to the notebook.
const DEFAULT_RETRIES = 2
const DEFAULT_BACKOFF_MS = 400

// Some public APIs (e.g. AlphaFold EBI) reject requests without a User-Agent; send a stable one.
const USER_AGENT =
  'Mozilla/5.0 (compatible; OpenScience/1.0; +https://github.com/aipoch/open-science)'

// Builds the NCBI E-utilities etiquette query suffix; empty when unset (calls still work).
export function ncbiEtiquette(credentials: ConnectorCredentials): string {
  const parts: string[] = []
  if (credentials.ncbiEmail) parts.push(`email=${encodeURIComponent(credentials.ncbiEmail)}`)
  if (credentials.ncbiApiKey) parts.push(`api_key=${encodeURIComponent(credentials.ncbiApiKey)}`)
  return parts.length ? `&${parts.join('&')}` : ''
}

// Strips credential query params (NCBI email/api_key) from a URL before it can land in an error
// message or log. Falls back to the raw string if it doesn't parse as a URL.
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('email')
    parsed.searchParams.delete('api_key')
    return parsed.toString()
  } catch {
    return url
  }
}

class ConnectorRequestTimeoutError extends Error {
  override readonly name = 'ConnectorRequestTimeoutError'

  constructor(target: string, timeoutMs: number, attempts?: number) {
    super(
      `${
        attempts === undefined
          ? `Connector call exceeded the ${timeoutMs}ms total deadline for ${target}`
          : `Connector request timed out after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'} of ${timeoutMs}ms for ${redactUrl(target)}`
      }. This is the Connector's own deadline; increasing an outer execution timeout will not extend it. Do not retry solely with a longer timeout.`
    )
  }
}

class ConnectorResponseTooLargeError extends Error {
  override readonly name = 'ConnectorResponseTooLargeError'

  constructor(url: string, maxResponseBytes: number) {
    super(`Connector response exceeded the ${maxResponseBytes}-byte limit for ${redactUrl(url)}`)
  }
}

// Generic executor shared by every connector: declarative { url, parse } or a run() escape hatch.
export class ParserEngine {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly totalTimeoutMs: number
  private readonly maxResponseBytes: number
  private readonly retries: number
  private readonly backoffMs: number

  constructor(opts?: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
    totalTimeoutMs?: number
    maxResponseBytes?: number
    retries?: number
    retryBackoffMs?: number
  }) {
    this.fetchImpl = opts?.fetchImpl ?? fetch
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.totalTimeoutMs = opts?.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS
    this.maxResponseBytes = opts?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    this.retries = opts?.retries ?? DEFAULT_RETRIES
    this.backoffMs = opts?.retryBackoffMs ?? DEFAULT_BACKOFF_MS
  }

  async call(
    descriptor: ToolDescriptor,
    args: Record<string, unknown>,
    credentials: ConnectorCredentials,
    signal?: AbortSignal
  ): Promise<unknown> {
    signal?.throwIfAborted()
    for (const key of descriptor.required ?? []) {
      if (args[key] == null) throw new Error(`missing required arg: ${key}`)
    }
    const totalTimeoutMs = descriptor.totalTimeoutMs ?? this.totalTimeoutMs
    const deadline = Date.now() + totalTimeoutMs
    const controller = new AbortController()
    const callSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const totalTimer = setTimeout(
      () =>
        controller.abort(
          new ConnectorRequestTimeoutError(
            `${descriptor.connector}/${descriptor.id}`,
            totalTimeoutMs
          )
        ),
      totalTimeoutMs
    )
    let onAbort: () => void = () => {}
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(callSignal.reason)
      callSignal.addEventListener('abort', onAbort, { once: true })
    })
    const execute = async (): Promise<unknown> => {
      const ctx = this.makeContext(
        credentials,
        callSignal,
        deadline,
        descriptor.maxResponseBytes ?? this.maxResponseBytes
      )
      let result: unknown
      if (descriptor.run) {
        result = await descriptor.run(ctx, args)
      } else {
        if (!descriptor.url || !descriptor.parse) {
          throw new Error(`descriptor ${descriptor.id} needs either run() or url()+parse()`)
        }
        const url = descriptor.url(args)
        const raw =
          descriptor.format === 'text' ? await ctx.fetchText(url) : await ctx.fetchJson(url)
        result = await descriptor.parse(raw, args)
      }
      callSignal.throwIfAborted()
      return result
    }
    try {
      return await Promise.race([execute(), aborted])
    } finally {
      clearTimeout(totalTimer)
      callSignal.removeEventListener('abort', onAbort)
      // Stop sibling requests if a run-style descriptor fails partway through a batch.
      controller.abort()
    }
  }

  private makeContext(
    credentials: ConnectorCredentials,
    signal: AbortSignal,
    deadline: number,
    maxResponseBytes: number
  ): ToolContext {
    const doFetch = async (
      url: string,
      accept: string,
      init?: RequestInit
    ): Promise<{ response: Response; bodyText?: string }> => {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted()
        const controller = new AbortController()
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        let timedOut = false
        const armTimeout = (): void => {
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            timedOut = true
            controller.abort()
          }, this.timeoutMs)
        }
        const requestSignal = AbortSignal.any([controller.signal, signal])
        let res: Response | undefined
        let bodyText: string | undefined
        let bodyComplete = false
        let caught = false
        let failure: unknown
        try {
          armTimeout()
          res = await this.fetchImpl(url, {
            ...init,
            headers: { accept, 'user-agent': USER_AGENT, ...init?.headers },
            signal: requestSignal
          })
          if (res.ok && res.body) {
            const reader = res.body.getReader()
            // Native fetch observes abort too; explicitly cancel injected/independent streams.
            const cancelReader = (): void => {
              void reader.cancel(requestSignal.reason).catch(() => {})
            }
            requestSignal.addEventListener('abort', cancelReader, { once: true })
            if (requestSignal.aborted) cancelReader()
            const decoder = new TextDecoder()
            const chunks: string[] = []
            let responseBytes = 0
            try {
              armTimeout()
              for (;;) {
                const chunk = await reader.read()
                requestSignal.throwIfAborted()
                if (chunk.done) {
                  bodyComplete = true
                  break
                }
                if (chunk.value.byteLength === 0) continue
                responseBytes += chunk.value.byteLength
                if (responseBytes > maxResponseBytes) {
                  const error = new ConnectorResponseTooLargeError(url, maxResponseBytes)
                  controller.abort(error)
                  throw error
                }
                chunks.push(decoder.decode(chunk.value, { stream: true }))
                armTimeout()
              }
              chunks.push(decoder.decode())
              bodyText = chunks.join('')
            } finally {
              requestSignal.removeEventListener('abort', cancelReader)
              reader.releaseLock()
            }
          }
        } catch (err) {
          caught = true
          failure = err
        } finally {
          if (idleTimer) clearTimeout(idleTimer)
          // Do not drain unbounded error bodies or wait for a broken cancellation hook.
          // A cleanup failure must never replace the HTTP/read error.
          if (res?.body && !bodyComplete) {
            void res.body.cancel().catch(() => {})
            controller.abort()
          }
        }
        signal.throwIfAborted()
        if (caught) {
          if (failure instanceof ConnectorResponseTooLargeError) throw failure
          if (timedOut) {
            throw new ConnectorRequestTimeoutError(url, this.timeoutMs, attempt + 1)
          }
          // Immediate network failures may be transient, so retry them within the bounded budget.
          if (attempt < this.retries) {
            await abortableDelay(connectorRetryDelay(attempt, null, this.backoffMs), signal)
            continue
          }
          throw failure
        }
        if (!res) throw new Error(`No response for ${redactUrl(url)}`)
        if (res.ok) {
          signal?.throwIfAborted()
          return { response: res, ...(bodyText !== undefined ? { bodyText } : {}) }
        }
        // Retry only transient upstream statuses; never shorten the server's requested wait.
        const retryable = CONNECTOR_RETRYABLE_STATUS.has(res.status)
        const retryAfter = res.headers?.get?.('retry-after') ?? null
        const delay = retryable ? connectorRetryDelay(attempt, retryAfter, this.backoffMs) : 0
        const insufficientBudget = delay >= deadline - Date.now()
        if (attempt < this.retries && retryable && !(retryAfter && insufficientBudget)) {
          await abortableDelay(delay, signal)
          continue
        }
        const retryHint =
          retryable && retryAfter
            ? ` Retry after ${Math.ceil(delay / 1_000)}s.${insufficientBudget ? ' The remaining call budget cannot accommodate this wait.' : ''}`
            : ''
        throw new Error(`HTTP ${res.status} for ${redactUrl(url)}.${retryHint}`)
      }
    }
    return {
      ...(signal ? { signal } : {}),
      credentials,
      fetchJson: async (url) => {
        const { response, bodyText } = await doFetch(url, 'application/json')
        return bodyText === undefined ? response.json() : JSON.parse(bodyText)
      },
      fetchJsonWithHeaders: async (url) => {
        const { response, bodyText } = await doFetch(url, 'application/json')
        return {
          body: bodyText === undefined ? await response.json() : JSON.parse(bodyText),
          headers: response.headers
        }
      },
      fetchText: async (url) => {
        const { response, bodyText } = await doFetch(url, 'text/plain, application/xml, */*')
        return bodyText === undefined ? response.text() : bodyText
      },
      postJson: async (url, body) => {
        const { response, bodyText } = await doFetch(url, 'application/json', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
        return bodyText === undefined ? response.json() : JSON.parse(bodyText)
      }
    }
  }
}
