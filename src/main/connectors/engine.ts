import type { ConnectorCredentials, ToolContext, ToolDescriptor } from './types'

const DEFAULT_TIMEOUT_MS = 30_000

// Transient-failure retry policy shared by every connector call. Public bio APIs (PubChem PUG-REST,
// GTEx, NCBI) routinely return 429/5xx or a brief timeout under load; a couple of backed-off retries
// turn those blips into successes instead of surfacing them to the notebook.
const DEFAULT_RETRIES = 2
const DEFAULT_BACKOFF_MS = 400
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

// Generic executor shared by every connector: declarative { url, parse } or a run() escape hatch.
export class ParserEngine {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly backoffMs: number

  constructor(opts?: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
    retries?: number
    retryBackoffMs?: number
  }) {
    this.fetchImpl = opts?.fetchImpl ?? fetch
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.retries = opts?.retries ?? DEFAULT_RETRIES
    this.backoffMs = opts?.retryBackoffMs ?? DEFAULT_BACKOFF_MS
  }

  async call(
    descriptor: ToolDescriptor,
    args: Record<string, unknown>,
    credentials: ConnectorCredentials
  ): Promise<unknown> {
    for (const key of descriptor.required ?? []) {
      if (args[key] == null) throw new Error(`missing required arg: ${key}`)
    }
    const ctx = this.makeContext(credentials)
    if (descriptor.run) return descriptor.run(ctx, args)
    if (!descriptor.url || !descriptor.parse) {
      throw new Error(`descriptor ${descriptor.id} needs either run() or url()+parse()`)
    }
    const url = descriptor.url(args)
    const raw = descriptor.format === 'text' ? await ctx.fetchText(url) : await ctx.fetchJson(url)
    return descriptor.parse(raw, args)
  }

  private makeContext(credentials: ConnectorCredentials): ToolContext {
    // Delay before the next attempt: honour a numeric Retry-After (seconds, capped), else exponential
    // backoff with jitter off the configured base.
    const nextDelay = (attempt: number, retryAfter: string | null): number => {
      const ra = retryAfter ? Number(retryAfter) : NaN
      if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 5_000)
      return Math.min(this.backoffMs * 2 ** attempt, 4_000) + Math.random() * this.backoffMs
    }

    const doFetch = async (url: string, accept: string, init?: RequestInit): Promise<Response> => {
      for (let attempt = 0; ; attempt++) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)
        let res: Response
        try {
          res = await this.fetchImpl(url, {
            ...init,
            headers: { accept, 'user-agent': USER_AGENT, ...init?.headers },
            signal: controller.signal
          })
        } catch (err) {
          // Network failure or timeout abort — retry a bounded number of times, then give up.
          if (attempt < this.retries) {
            await sleep(nextDelay(attempt, null))
            continue
          }
          throw err
        } finally {
          clearTimeout(timer)
        }
        if (res.ok) return res
        // Retry only transient upstream statuses; client errors (4xx except 429) fail fast.
        if (attempt < this.retries && RETRYABLE_STATUS.has(res.status)) {
          await sleep(nextDelay(attempt, res.headers?.get?.('retry-after') ?? null))
          continue
        }
        throw new Error(`HTTP ${res.status} for ${redactUrl(url)}`)
      }
    }
    return {
      credentials,
      fetchJson: async (url) => (await doFetch(url, 'application/json')).json(),
      fetchJsonWithHeaders: async (url) => {
        const res = await doFetch(url, 'application/json')
        return { body: await res.json(), headers: res.headers }
      },
      fetchText: async (url) => (await doFetch(url, 'text/plain, application/xml, */*')).text(),
      postJson: async (url, body) =>
        (
          await doFetch(url, 'application/json', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          })
        ).json()
    }
  }
}
