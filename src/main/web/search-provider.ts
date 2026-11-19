import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  webResultSchema,
  type SearchInput,
  type WebResult,
  type WebSearchAttempt
} from '../../shared/web-tools'
import { runtimeNetwork } from '../runtime-network'
import { abortable, WebToolError } from './errors'
import { isPublicWebAddress, parseWebUrl } from './transport'

export const EXA_SEARCH_ENDPOINT = 'https://mcp.exa.ai/mcp'
const EXA_ADVANCED_SEARCH_TOOL = 'web_search_advanced_exa'
export const EXA_ADVANCED_SEARCH_ENDPOINT = `${EXA_SEARCH_ENDPOINT}?tools=${EXA_ADVANCED_SEARCH_TOOL}`
const FRESHNESS_DAYS = { day: 1, week: 7, month: 30, year: 365 } as const
const UTC_DAY_MS = 24 * 60 * 60 * 1000
const searchFreshnessWindow = (
  freshness: SearchInput['freshness'],
  end: number
): { start: number; end: number } | undefined =>
  freshness ? { start: end - FRESHNESS_DAYS[freshness] * UTC_DAY_MS, end } : undefined
export const SEARCH_PROVIDER_BODY_LIMIT = 256 * 1024
export const EXA_SEARCH_PROVIDER: Readonly<WebSearchAttempt['provider']> = Object.freeze({
  id: 'exa',
  auth_mode: 'anonymous',
  data_policy_version: 'exa-anonymous-reviewed-2026-11-17'
})

export type SearchProviderResult = {
  sources: WebResult['sources']
  resultsTruncated?: boolean
  effectiveFilters?: WebResult['effective_filters']
  usage?: WebSearchAttempt['usage']
}
export interface SearchProvider {
  search(input: SearchInput, signal: AbortSignal): Promise<SearchProviderResult>
}
export class SearchProviderError extends WebToolError {
  constructor(
    code: ConstructorParameters<typeof WebToolError>[0],
    retryable = false,
    readonly retryAfterMs?: number
  ) {
    super(code, retryable)
  }
}

export const retryAfterMilliseconds = (
  header: string | null,
  now = Date.now()
): number | undefined => {
  if (!header) return undefined
  const value = header.trim()
  const milliseconds = /^\d+(?:\.\d+)?$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - now
  return Number.isFinite(milliseconds)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.ceil(milliseconds)))
    : undefined
}

const prefix = (value: string, limit: number): string => {
  if (value.length <= limit) return value
  const end = value.charCodeAt(limit - 1)
  return value.slice(0, end >= 0xd800 && end <= 0xdbff ? limit - 1 : limit)
}

export const sourceUrl = (value: unknown): string => {
  if (typeof value !== 'string') throw new WebToolError('PROVIDER_RESPONSE_INVALID')
  try {
    const url = parseWebUrl(value)
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    if (
      (isIP(hostname) && !isPublicWebAddress(hostname)) ||
      !hostname.includes('.') ||
      /(?:^|\.)(?:localhost|local|internal|invalid|test)$/i.test(hostname)
    )
      throw new Error('Non-public source')
    return url.href
  } catch {
    throw new WebToolError('PROVIDER_RESPONSE_INVALID')
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

type ExaPublicationWindow = { start: number; end: number }

const exaSearchRows = (
  result: CallToolResult,
  advanced: boolean
): { rows: unknown[]; discardedPrefix?: boolean } => {
  if (result.structuredContent !== undefined || advanced) {
    let structured: unknown = result.structuredContent
    if (structured === undefined) {
      // The hosted advanced tool currently wraps its Search API JSON in one MCP text item.
      const [item] = result.content
      if (result.content.length !== 1 || item.type !== 'text')
        throw new WebToolError('PROVIDER_RESPONSE_INVALID')
      try {
        structured = JSON.parse(item.text)
      } catch {
        throw new WebToolError('PROVIDER_RESPONSE_INVALID')
      }
    }
    if (!record(structured) || structured.error != null || !Array.isArray(structured.results))
      throw new WebToolError('PROVIDER_RESPONSE_INVALID')
    return { rows: structured.results }
  }
  const text = result.content
    .map((part) => {
      if (part.type !== 'text') throw new WebToolError('PROVIDER_RESPONSE_INVALID')
      return part.text
    })
    .join('\n')
    .replace(/\r\n/g, '\n')
    .replace(/^(?:Note: [^\n]*\n)+\n/, '')
    .trim()
  if (text === 'No search results found. Please try a different query.') return { rows: [] }

  // Excerpts can contain Markdown horizontal rules. A new record needs the whole Exa header.
  const headers = [
    ...text.matchAll(
      /(?:^|\n\n---\n\n)Title: ([^\n]*)\nURL: ([^\n]*)\nPublished: ([^\n]*)\nAuthor: [^\n]*/g
    )
  ]
  if (!headers.length) throw new WebToolError('PROVIDER_RESPONSE_INVALID')
  const rows = headers.map((header, index) => {
    const body = text.slice(header.index + header[0].length, headers[index + 1]?.index)
    const excerpt = /^(?:\n(?:Highlights:(?:\n|$)|Text:(?: |$))([\s\S]*))?$/.exec(body)
    if (!excerpt) return undefined
    return { title: header[1], url: header[2], publishedDate: header[3], text: excerpt[1] }
  })
  return { rows, discardedPrefix: headers[0].index !== 0 }
}

const exaPublishedAt = webResultSchema.shape.sources.element.shape.published_at

export const normalizeExaSearch = (
  result: CallToolResult,
  window?: ExaPublicationWindow
): SearchProviderResult => {
  if (result._meta?.['ai.exa/rateLimited'] === true)
    throw new SearchProviderError('RATE_LIMITED', true)
  if (result.isError) throw new WebToolError('PROVIDER_RESPONSE_INVALID')
  const { rows, discardedPrefix = false } = exaSearchRows(result, !!window)
  const seen = new Set<string>()
  let truncated = discardedPrefix
  let validRow = false
  const sources: WebResult['sources'] = []
  for (const row of rows) {
    if (
      !record(row) ||
      (row.title != null && typeof row.title !== 'string') ||
      (row.highlights !== undefined &&
        (!Array.isArray(row.highlights) ||
          !row.highlights.every((item) => typeof item === 'string')))
    ) {
      truncated = true
      continue
    }
    let url: string
    try {
      url = sourceUrl(row.url)
    } catch (error) {
      if (!(error instanceof WebToolError) || error.code !== 'PROVIDER_RESPONSE_INVALID')
        throw error
      truncated = true
      continue
    }
    validRow = true
    const { data: publishedAt } = exaPublishedAt.safeParse(row.publishedDate)
    if (window) {
      const timestamp = publishedAt ? Date.parse(publishedAt) : NaN
      if (!Number.isFinite(timestamp) || timestamp < window.start || timestamp > window.end)
        continue
    }
    if (seen.has(url)) continue
    if (sources.length >= 10) {
      truncated = true
      break
    }
    seen.add(url)
    const rawTitle = typeof row.title === 'string' && row.title !== 'N/A' ? row.title : undefined
    const rawSnippet =
      Array.isArray(row.highlights) && row.highlights.length
        ? row.highlights.join('\n')
        : typeof row.text === 'string'
          ? row.text
          : undefined
    const title = rawTitle ? prefix(rawTitle, 512) : undefined
    const snippet = rawSnippet ? prefix(rawSnippet, 8000) : undefined
    if ((rawTitle && rawTitle !== title) || (rawSnippet && rawSnippet !== snippet)) truncated = true
    sources.push({
      source_id: createHash('sha256').update(url).digest('hex'),
      url,
      ...(title ? { title } : {}),
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { published_at: publishedAt } : {}),
      evidence_kind: 'provider_excerpt'
    })
  }
  if (rows.length && !validRow) throw new WebToolError('PROVIDER_RESPONSE_INVALID')
  return { sources, ...(truncated ? { resultsTruncated: true } : {}) }
}

export class ExaSearchProvider implements SearchProvider {
  constructor(private readonly options: { fetch?: typeof fetch; now?: () => number } = {}) {}

  async search(input: SearchInput, signal: AbortSignal): Promise<SearchProviderResult> {
    signal.throwIfAborted()
    const { freshness, allowed_domains, query, max_results = 5 } = input
    const end = (this.options.now ?? Date.now)()
    const window = searchFreshnessWindow(freshness, end)
    const endpoint = window ? EXA_ADVANCED_SEARCH_ENDPOINT : EXA_SEARCH_ENDPOINT
    const client = new Client({ name: 'open-science-agent', version: '1.0.0' })
    const fetchImpl = this.options.fetch ?? runtimeNetwork().fetch
    let closing = false
    let failure: WebToolError | undefined
    let responseRetryAfterMs: number | undefined
    let rejectFatal!: (error: WebToolError) => void
    const fatal = new Promise<never>((_resolve, reject) => {
      rejectFatal = reject
    })
    // GET SSE and parse failures may arrive asynchronously after the POST promise settles.
    void fatal.catch(() => undefined)
    const fail = (error: WebToolError): void => {
      if (closing) return
      failure ??= error
      rejectFatal(failure)
    }
    client.onerror = () => fail(failure ?? new WebToolError('PROVIDER_RESPONSE_INVALID'))
    const boundedFetch: typeof fetch = async (inputUrl, init) => {
      const requested = new Request(inputUrl, init)
      if (requested.url !== endpoint || !['GET', 'POST'].includes(requested.method))
        throw new WebToolError('PROVIDER_RESPONSE_INVALID')
      const requestSignal = AbortSignal.any([signal, requested.signal])
      const headers = new Headers(requested.headers)
      headers.delete('authorization')
      headers.delete('cookie')
      headers.delete('x-api-key')
      headers.set('user-agent', 'OpenScience-WebTools/1.0')
      try {
        requestSignal.throwIfAborted()
        const response = await abortable(
          fetchImpl(endpoint, {
            ...init,
            headers,
            redirect: 'error',
            credentials: 'omit',
            signal: requestSignal
          }),
          requestSignal
        )
        responseRetryAfterMs =
          retryAfterMilliseconds(response.headers.get('retry-after')) ?? responseRetryAfterMs
        if (!response.ok && !(requested.method === 'GET' && response.status === 405)) {
          void response.body?.cancel().catch(() => undefined)
          throw response.status === 429
            ? new SearchProviderError(
                'RATE_LIMITED',
                true,
                retryAfterMilliseconds(response.headers.get('retry-after'))
              )
            : new WebToolError(
                response.status === 401
                  ? 'AUTH_REQUIRED'
                  : response.status === 403
                    ? 'NETWORK_MODE_UNSUPPORTED'
                    : 'HTTP_ERROR',
                response.status >= 500
              )
        }
        if (!response.body) return response
        const reader = response.body.getReader()
        let bytes = 0
        let cancelled = false
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              requestSignal.throwIfAborted()
              const chunk = await abortable(reader.read(), requestSignal)
              if (cancelled) return
              requestSignal.throwIfAborted()
              if (chunk.done) {
                controller.close()
                return
              }
              bytes += chunk.value.byteLength
              if (bytes > SEARCH_PROVIDER_BODY_LIMIT) throw new WebToolError('CONTENT_TOO_LARGE')
              controller.enqueue(chunk.value)
            } catch (error) {
              if (cancelled) return
              const bounded =
                error instanceof WebToolError ? error : new WebToolError('NETWORK_ERROR', true)
              fail(bounded)
              void reader.cancel().catch(() => undefined)
              controller.error(bounded)
            }
          },
          cancel: () => {
            cancelled = true
            return reader.cancel()
          }
        })
        return new Response(body, { status: response.status, headers: response.headers })
      } catch (error) {
        const bounded =
          error instanceof WebToolError ? error : new WebToolError('NETWORK_ERROR', true)
        fail(bounded)
        throw bounded
      }
    }
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      fetch: boundedFetch,
      requestInit: { redirect: 'error', credentials: 'omit' },
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 0,
        maxReconnectionDelay: 0,
        reconnectionDelayGrowFactor: 1
      }
    })
    try {
      await Promise.race([client.connect(transport, { signal }), fatal])
      signal.throwIfAborted()
      const call = window
        ? {
            name: EXA_ADVANCED_SEARCH_TOOL,
            arguments: {
              query,
              numResults: max_results,
              startPublishedDate: new Date(window.start).toISOString(),
              endPublishedDate: new Date(window.end).toISOString(),
              enableHighlights: true,
              highlightsMaxCharacters: 1200,
              ...(allowed_domains?.length ? { includeDomains: allowed_domains } : {})
            }
          }
        : {
            name: 'web_search_exa',
            arguments: {
              query: allowed_domains?.length
                ? `${query} (${allowed_domains.map((domain) => `site:${domain}`).join(' OR ')})`
                : query,
              numResults: max_results
            }
          }
      const result = await Promise.race([client.callTool(call, undefined, { signal }), fatal])
      signal.throwIfAborted()
      try {
        const normalized = normalizeExaSearch(CallToolResultSchema.parse(result), window)
        return freshness
          ? {
              ...normalized,
              effectiveFilters: {
                freshness,
                ...(allowed_domains?.length ? { allowed_domains, domain_mode: 'native' } : {})
              }
            }
          : normalized
      } catch (error) {
        if (error instanceof SearchProviderError && error.code === 'RATE_LIMITED')
          throw new SearchProviderError(
            'RATE_LIMITED',
            true,
            error.retryAfterMs ?? responseRetryAfterMs
          )
        throw error
      }
    } catch (error) {
      signal.throwIfAborted()
      throw (
        failure ??
        (error instanceof WebToolError ? error : new WebToolError('PROVIDER_RESPONSE_INVALID'))
      )
    } finally {
      closing = true
      await client.close().catch(() => undefined)
    }
  }
}
