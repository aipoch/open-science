import type { ConnectorCredentials, ToolContext, ToolDescriptor } from './types'

const DEFAULT_TIMEOUT_MS = 30_000

// Some public APIs (e.g. AlphaFold EBI) reject requests without a User-Agent; send a stable one.
const USER_AGENT = 'OpenScience/1.0 (+https://github.com/aipoch/open-science)'

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

  constructor(opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.fetchImpl = opts?.fetchImpl ?? fetch
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
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
    const doFetch = async (url: string, accept: string, init?: RequestInit): Promise<Response> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await this.fetchImpl(url, {
          ...init,
          headers: { accept, 'user-agent': USER_AGENT, ...init?.headers },
          signal: controller.signal
        })
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${redactUrl(url)}`)
        return res
      } finally {
        clearTimeout(timer)
      }
    }
    return {
      credentials,
      fetchJson: async (url) => (await doFetch(url, 'application/json')).json(),
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
