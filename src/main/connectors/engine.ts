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

  constructor(url: string, timeoutMs: number, attempts: number, kind: 'idle' | 'total' = 'idle') {
    super(
      `${
        kind === 'total'
          ? `Connector request exceeded the ${timeoutMs}ms total deadline after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'} for ${redactUrl(url)}`
          : `Connector request timed out after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'} of ${timeoutMs}ms for ${redactUrl(url)}`
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
    const ctx = this.makeContext(
      credentials,
      signal,
      descriptor.totalTimeoutMs ?? this.totalTimeoutMs,
      descriptor.maxResponseBytes ?? this.maxResponseBytes
    )
    if (descriptor.run) {
      const result = await descriptor.run(ctx, args)
      signal?.throwIfAborted()
      return result
    }
    if (!descriptor.url || !descriptor.parse) {
      throw new Error(`descriptor ${descriptor.id} needs either run() or url()+parse()`)
    }
    const url = descriptor.url(args)
    const raw = descriptor.format === 'text' ? await ctx.fetchText(url) : await ctx.fetchJson(url)
    return descriptor.parse(raw, args)
  }

  private makeContext(
    credentials: ConnectorCredentials,
    signal: AbortSignal | undefined,
    totalTimeoutMs: number,
    maxResponseBytes: number
  ): ToolContext {
    const doFetch = async (
      url: string,
      accept: string,
      init?: RequestInit
    ): Promise<{ response: Response; bodyText?: string }> => {
      for (let attempt = 0; ; attempt++) {
        const controller = new AbortController()
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        let timedOut: 'idle' | 'total' | undefined
        const abortForTimeout = (kind: 'idle' | 'total'): void => {
          timedOut ??= kind
          controller.abort()
        }
        const armTimeout = (): void => {
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => abortForTimeout('idle'), this.timeoutMs)
        }
        const totalTimer = setTimeout(() => abortForTimeout('total'), totalTimeoutMs)
        const requestSignal = signal
          ? AbortSignal.any([controller.signal, signal])
          : controller.signal
        let res: Response | undefined
        let bodyText: string | undefined
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
            const decoder = new TextDecoder()
            const chunks: string[] = []
            let responseBytes = 0
            try {
              armTimeout()
              for (;;) {
                const chunk = await reader.read()
                if (chunk.done) break
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
              reader.releaseLock()
            }
          }
        } catch (err) {
          caught = true
          failure = err
        } finally {
          if (idleTimer) clearTimeout(idleTimer)
          if (totalTimer) clearTimeout(totalTimer)
        }
        if (caught) {
          if (signal?.aborted) throw failure
          if (failure instanceof ConnectorResponseTooLargeError) throw failure
          if (timedOut) {
            throw new ConnectorRequestTimeoutError(
              url,
              timedOut === 'total' ? totalTimeoutMs : this.timeoutMs,
              attempt + 1,
              timedOut
            )
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
        // Retry only transient upstream statuses; client errors (4xx except 429) fail fast.
        if (attempt < this.retries && CONNECTOR_RETRYABLE_STATUS.has(res.status)) {
          await abortableDelay(
            connectorRetryDelay(attempt, res.headers?.get?.('retry-after') ?? null, this.backoffMs),
            signal
          )
          continue
        }
        throw new Error(`HTTP ${res.status} for ${redactUrl(url)}`)
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
