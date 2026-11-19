import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  normalizeSearchDomain,
  searchInputSchema,
  webResultSchema,
  WEB_RESULT_MAX_BYTES,
  WEB_RESULT_MAX_CODE_UNITS,
  type SearchInput,
  type WebResult,
  type WebSearchAttempt
} from '../../shared/web-tools'
import { abortable, WebToolError } from './errors'
import { WebSessionSlots } from './limits'
import {
  EXA_SEARCH_PROVIDER,
  ExaSearchProvider,
  SearchProviderError,
  sourceUrl,
  type SearchProvider
} from './search-provider'

export type WebSearchContext = {
  onDispatch?: SearchServiceOptions['onDispatch']
  onAttempt?: SearchServiceOptions['onAttempt']
  signal?: AbortSignal
  invocationId?: string
  sessionSlotKey?: string
}

export type SearchServiceOptions = {
  provider?: SearchProvider
  sessionSlots?: WebSessionSlots
  deadlineMs?: number
  now?: () => number
  onDispatch?: (
    invocationId: string,
    attempt: Omit<WebSearchAttempt, 'status' | 'duration_ms'>
  ) => Promise<void>
  onAttempt?: (invocationId: string, attempt: WebSearchAttempt) => Promise<void>
}

const fits = (result: WebResult): boolean => {
  const json = JSON.stringify(result)
  return json.length <= WEB_RESULT_MAX_CODE_UNITS && Buffer.byteLength(json) <= WEB_RESULT_MAX_BYTES
}

const matchesDomain = (url: string, domains: string[]): boolean => {
  const host = new URL(url).hostname.toLowerCase()
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

const retryAfterMs = (failure: WebToolError): number | undefined =>
  failure.code === 'RATE_LIMITED'
    ? ((failure instanceof SearchProviderError ? failure.retryAfterMs : undefined) ?? 60_000)
    : undefined

export class SearchService {
  private readonly provider: SearchProvider
  private readonly slots: WebSessionSlots
  private readonly now: () => number
  private cooldownUntil = 0

  constructor(private readonly options: SearchServiceOptions = {}) {
    this.now = options.now ?? Date.now
    this.provider = options.provider ?? new ExaSearchProvider({ now: this.now })
    this.slots = options.sessionSlots ?? new WebSessionSlots()
  }

  async search(
    sessionId: string,
    rawInput: unknown,
    context: WebSearchContext = {}
  ): Promise<WebResult> {
    const began = performance.now()
    const timeout = AbortSignal.timeout(this.options.deadlineMs ?? 20_000)
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout
    const invocationId = context.invocationId ?? randomUUID()
    const retrievedAt = new Date(this.now()).toISOString()
    let request: WebResult['request'] = {}
    const attempts: WebSearchAttempt[] = []
    const classifyFailure = (error: unknown): WebToolError => {
      if (signal.aborted) {
        if (timeout.aborted && signal.reason === timeout.reason)
          return new WebToolError('TIMEOUT', true)
        return new WebToolError('CANCELLED')
      }
      return error instanceof WebToolError ? error : new WebToolError('PROVIDER_RESPONSE_INVALID')
    }
    const base = (): WebResult => ({
      schema: 'open-science.web.v2',
      invocation_id: invocationId,
      operation: 'search',
      status: 'ok',
      request,
      retrieved_at: retrievedAt,
      duration_ms: Math.max(0, Math.round(performance.now() - began)),
      attempts,
      ...(attempts.length ? { provider: { ...EXA_SEARCH_PROVIDER } } : {}),
      sources: []
    })
    try {
      signal.throwIfAborted()
      const parsed = searchInputSchema.safeParse(rawInput)
      if (!parsed.success) throw new WebToolError('INVALID_INPUT')
      const input: SearchInput = {
        ...parsed.data,
        query: parsed.data.query.trim(),
        ...(parsed.data.allowed_domains
          ? {
              allowed_domains: [
                ...new Set(
                  parsed.data.allowed_domains.map((domain) => normalizeSearchDomain(domain)!)
                )
              ]
            }
          : {})
      }
      request = input
      const release = await this.slots.acquire(context.sessionSlotKey ?? sessionId, signal)
      try {
        signal.throwIfAborted()
        const cooldown = this.cooldownUntil - this.now()
        if (cooldown > 0) throw new SearchProviderError('RATE_LIMITED', true, cooldown)
        const dispatch: Omit<WebSearchAttempt, 'status' | 'duration_ms'> = {
          index: 1,
          provider: { ...EXA_SEARCH_PROVIDER },
          execution: 'direct_search',
          started_at: new Date(this.now()).toISOString()
        }
        const attempt: WebSearchAttempt = { ...dispatch, duration_ms: 0, status: 'error' }
        const started = performance.now()
        attempts.push(attempt)
        let output: Awaited<ReturnType<SearchProvider['search']>>
        let sources: WebResult['sources']
        try {
          await (context.onDispatch ?? this.options.onDispatch)?.(
            invocationId,
            structuredClone(dispatch)
          )
          signal.throwIfAborted()
          output = await abortable(this.provider.search(input, signal), signal)
          signal.throwIfAborted()
          if (output.usage) attempt.usage = output.usage
          const seen = new Set<string>()
          sources = []
          for (const source of output.sources) {
            const url = sourceUrl(source.url)
            if (
              seen.has(url) ||
              (input.allowed_domains?.length && !matchesDomain(url, input.allowed_domains))
            )
              continue
            seen.add(url)
            sources.push({ ...source, url, attempt_index: attempt.index })
          }
          attempt.status = 'ok'
          attempt.search_executed = true
        } catch (error) {
          const failure = classifyFailure(error)
          attempt.status =
            context.signal?.aborted || failure.code === 'CANCELLED' ? 'cancelled' : 'error'
          const retryAfter = retryAfterMs(failure)
          attempt.error = {
            code: failure.code,
            retryable: failure.retryable,
            ...(retryAfter !== undefined ? { retry_after_ms: retryAfter } : {})
          }
          if (retryAfter !== undefined)
            this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + retryAfter)
          throw failure
        } finally {
          attempt.duration_ms = Math.max(0, Math.round(performance.now() - started))
          await (context.onAttempt ?? this.options.onAttempt)?.(
            invocationId,
            structuredClone(attempt)
          )
        }
        signal.throwIfAborted()
        const maxResults = input.max_results ?? 5
        const result: WebResult = {
          ...base(),
          sources: sources.slice(0, maxResults),
          returned_count: Math.min(sources.length, maxResults),
          ...(output.effectiveFilters
            ? { effective_filters: output.effectiveFilters }
            : input.allowed_domains?.length
              ? {
                  effective_filters: {
                    allowed_domains: input.allowed_domains,
                    domain_mode: 'post_filter'
                  }
                }
              : {}),
          ...(output.resultsTruncated || sources.length > maxResults
            ? { results_truncated: true }
            : {})
        }
        while (!fits(result)) {
          const longest = result.sources.reduce<(typeof result.sources)[number] | undefined>(
            (best, source) =>
              (source.snippet?.length ?? 0) > (best?.snippet?.length ?? 0) ? source : best,
            undefined
          )
          if (longest?.snippet) {
            const characters = [...longest.snippet]
            longest.snippet = characters.slice(0, Math.floor(characters.length / 2)).join('')
            if (!longest.snippet) delete longest.snippet
          } else if (result.sources.length) result.sources.pop()
          else throw new WebToolError('CONTENT_TOO_LARGE')
          result.returned_count = result.sources.length
          result.results_truncated = true
        }
        signal.throwIfAborted()
        return webResultSchema.parse(result)
      } finally {
        release()
      }
    } catch (error) {
      context.signal?.throwIfAborted()
      const failure = classifyFailure(error)
      const retryAfter = retryAfterMs(failure)
      return webResultSchema.parse({
        ...base(),
        status: 'error',
        error: {
          code: failure.code,
          retryable: failure.retryable,
          ...(retryAfter !== undefined ? { retry_after_ms: retryAfter } : {})
        }
      })
    }
  }
}
