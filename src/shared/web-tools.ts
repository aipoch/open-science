import { z } from 'zod'

export const WEB_RESULT_SCHEMA = 'open-science.web.v1' as const
export const WEB_SEARCH_RESULT_SCHEMA = 'open-science.web.v2' as const
export const WEB_RESTRICTED_RESULT_SCHEMA = 'open-science.web.v3' as const
export const WEB_RESULT_MAX_CODE_UNITS = 14_000
export const WEB_RESULT_MAX_BYTES = 32 * 1024
export const WEB_FETCH_DEFAULT_MAX_CHARS = 6000

const fetchRequestSchema = z
  .object({
    url: z.string().max(2048).optional(),
    snapshot_id: z.string().max(128).optional(),
    cursor: z.string().max(512).optional(),
    max_chars: z.number().int().min(1).max(8000).optional(),
    refresh: z.boolean().optional()
  })
  .strict()

export const fetchInputSchema = fetchRequestSchema.superRefine((input, context) => {
  const urlMode = input.url !== undefined
  if (
    urlMode
      ? input.snapshot_id !== undefined || input.cursor !== undefined
      : !input.snapshot_id || !input.cursor || input.refresh !== undefined
  ) {
    context.addIssue({ code: 'custom', message: 'Use a URL, or a snapshot ID and cursor.' })
  }
  if (JSON.stringify(input).length > 7000) {
    context.addIssue({ code: 'custom', message: 'Input exceeds the serialized size limit.' })
  }
})
export type FetchInput = z.infer<typeof fetchInputSchema>

export const webErrorCodeSchema = z.enum([
  'CONFIGURATION_ERROR',
  'SEARCH_UNSUPPORTED',
  'SEARCH_NOT_EXECUTED',
  'CREDENTIAL_UNAVAILABLE',
  'POLICY_DENIED',
  'INVALID_INPUT',
  'UNSUPPORTED_FILTER',
  'RATE_LIMITED',
  'AUTH_REQUIRED',
  'NETWORK_MODE_UNSUPPORTED',
  'NETWORK_ERROR',
  'TIMEOUT',
  'BLOCKED_TARGET',
  'HTTP_ERROR',
  'CONTENT_TOO_LARGE',
  'UNSUPPORTED_CONTENT_TYPE',
  'EXTRACTION_FAILED',
  'PROVIDER_RESPONSE_INVALID',
  'INVALID_CURSOR',
  'EVIDENCE_UNAVAILABLE',
  'CAPABILITY_DISABLED',
  'CANCELLED'
])
export type WebErrorCode = z.infer<typeof webErrorCodeSchema>

export const normalizeSearchDomain = (value: string): string | undefined => {
  if (!value || value !== value.trim() || /[\s/:@*?#\\]/u.test(value)) return undefined
  const domain = value.endsWith('.') ? value.slice(0, -1) : value
  try {
    const host = new URL(`https://${domain}`).hostname.toLowerCase()
    if (
      host.length > 253 ||
      !host.includes('.') ||
      !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
      /^[0-9.]+$/.test(host)
    )
      return undefined
    return host
  } catch {
    return undefined
  }
}

const searchRequestSchema = z
  .object({
    query: z
      .string()
      .max(7000)
      .refine((value) => {
        const count = [...value.trim()].length
        return count >= 1 && count <= 2000
      }, 'Query must contain 1 to 2000 Unicode code points.'),
    max_results: z.number().int().min(1).max(10).optional(),
    allowed_domains: z
      .array(
        z
          .string()
          .max(253)
          .refine(
            (value) => normalizeSearchDomain(value) !== undefined,
            'Use a domain without a scheme, path or wildcard.'
          )
      )
      .max(10)
      .optional(),
    freshness: z.enum(['day', 'week', 'month', 'year']).optional()
  })
  .strict()
export const searchInputSchema = searchRequestSchema.superRefine((input, context) => {
  if (JSON.stringify(input).length > 7000) {
    context.addIssue({ code: 'custom', message: 'Input exceeds the serialized size limit.' })
  }
})
export type SearchInput = z.infer<typeof searchInputSchema>
export const SearchInputSchema = searchInputSchema
const safeUrl = z.string().max(2048)
const time = z.string().datetime({ offset: true })
export const webAttemptSchema = z
  .object({
    index: z.union([z.literal(1), z.literal(2)]),
    provider: z
      .object({
        id: z.string().min(1).max(128),
        auth_mode: z.enum(['anonymous', 'api_key', 'platform']),
        data_policy_version: z.string().min(1).max(128)
      })
      .strict(),
    execution: z.enum(['direct_search', 'model_search']),
    model_service_id: z.string().min(1).max(128).optional(),
    model: z.string().min(1).max(256).optional(),
    protocol: z
      .enum([
        'responses',
        'messages',
        'chat-completions',
        'conversations',
        'rest-search',
        'mcp',
        'google-generate-content',
        'google-interactions'
      ])
      .optional(),
    started_at: time,
    duration_ms: z.number().finite().nonnegative(),
    status: z.enum(['ok', 'error', 'cancelled']),
    error: z
      .object({
        code: webErrorCodeSchema,
        retryable: z.boolean(),
        retry_after_ms: z.number().finite().nonnegative().optional()
      })
      .strict()
      .optional(),
    search_executed: z.boolean().optional(),
    usage: z
      .object({
        input_tokens: z.number().finite().nonnegative().optional(),
        output_tokens: z.number().finite().nonnegative().optional(),
        total_tokens: z.number().finite().nonnegative().optional(),
        search_requests: z.number().finite().nonnegative().optional(),
        credits: z.number().finite().nonnegative().optional(),
        cost: z
          .object({
            amount: z.number().finite().nonnegative(),
            currency: z.string().min(1).max(16),
            basis: z.enum(['reported', 'estimated']),
            rate_version: z.string().min(1).max(128).optional()
          })
          .strict()
          .optional()
      })
      .strict()
      .optional()
  })
  .strict()
export type WebSearchAttempt = z.infer<typeof webAttemptSchema>
export const usesExtendedSearchProtocol = (
  attempts: ReadonlyArray<Pick<WebSearchAttempt, 'protocol'>> | undefined
): boolean =>
  !!attempts?.some(
    (attempt) =>
      attempt.protocol && !['responses', 'messages', 'chat-completions'].includes(attempt.protocol)
  )
export const webRoutingSchema = z
  .object({
    mode: z.enum(['auto', 'specified']),
    requested_target: z.enum(['auto', 'current_model', 'tavily', 'exa']),
    selected_target: z.enum(['current_model', 'tavily', 'exa']).optional(),
    config_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    fallback_reason: z.string().min(1).max(128).optional()
  })
  .strict()
export const webSynthesisSchema = z
  .object({
    text: z.string().refine((value) => [...value].length <= 2000),
    kind: z.literal('model_synthesis'),
    attempt_index: z.union([z.literal(1), z.literal(2)])
  })
  .strict()
const webResultBaseSchema = z
  .object({
    schema: z.enum([WEB_RESULT_SCHEMA, WEB_SEARCH_RESULT_SCHEMA, WEB_RESTRICTED_RESULT_SCHEMA]),
    invocation_id: z.string().min(1).max(512),
    operation: z.enum(['search', 'fetch']),
    status: z.enum(['ok', 'error']),
    request: z.union([fetchRequestSchema, searchRequestSchema]),
    retrieved_at: time,
    duration_ms: z.number().finite().nonnegative(),
    provider: z
      .object({
        id: z.string().max(128),
        auth_mode: z.enum(['anonymous', 'api_key', 'platform', 'managed']),
        data_policy_version: z.string().max(128)
      })
      .strict()
      .optional(),
    effective_filters: z
      .object({
        allowed_domains: z.array(z.string().max(253)).max(10).optional(),
        domain_mode: z.enum(['native', 'post_filter']).optional(),
        freshness: z.enum(['day', 'week', 'month', 'year']).optional()
      })
      .strict()
      .optional(),
    sources: z
      .array(
        z
          .object({
            source_id: z.string().max(128),
            url: safeUrl,
            title: z.string().max(512).optional(),
            snippet: z.string().max(8000).optional(),
            published_at: time.optional(),
            evidence_kind: z.enum([
              'search_snippet',
              'provider_excerpt',
              'page_extract',
              'provider_citation'
            ]),
            attempt_index: z.union([z.literal(1), z.literal(2)]).optional(),
            snapshot_id: z.string().max(128).optional()
          })
          .strict()
      )
      .max(10),
    returned_count: z.number().int().nonnegative().max(10).optional(),
    results_truncated: z.boolean().optional(),
    document: z
      .object({
        snapshot_id: z.string().max(128),
        final_url: safeUrl,
        fetched_at: time,
        content_type: z.string().max(128),
        extraction_method: z.enum(['main_content', 'semantic_dom', 'plain_text']),
        extraction_quality: z.enum(['normal', 'degraded']),
        extractor_version: z.string().max(128),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        text: z.string().max(16000),
        start_line: z.number().int().min(1),
        end_line: z.number().int().nonnegative(),
        total_lines: z.number().int().nonnegative(),
        truncated: z.boolean(),
        next_cursor: z.string().max(512).optional()
      })
      .strict()
      .optional(),
    cache: z
      .object({ hit: z.boolean(), age_ms: z.number().nonnegative().optional() })
      .strict()
      .optional(),
    warnings: z.array(z.string().max(128)).max(20).optional(),
    error: z
      .object({
        code: webErrorCodeSchema,
        retryable: z.boolean(),
        retry_after_ms: z.number().nonnegative().optional()
      })
      .strict()
      .optional()
  })
  .strict()

export const webResultSchema = webResultBaseSchema
  .extend({
    routing: webRoutingSchema.optional(),
    attempts: z.array(webAttemptSchema).max(2).optional(),
    synthesis: webSynthesisSchema.optional(),
    result_kind: z.literal('restricted_grounded_result').optional(),
    presentation: z
      .object({
        status: z.literal('presentation_only'),
        handle: z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/),
        expires_at: time
      })
      .strict()
      .optional()
  })
  .superRefine((result, context) => {
    if (
      result.status === 'error'
        ? !result.error || !!result.document
        : !!result.error || (result.operation === 'fetch' && !result.document)
    ) {
      context.addIssue({ code: 'custom', message: 'Result status and evidence disagree.' })
    }
    const invalid = (message: string): void => context.addIssue({ code: 'custom', message })
    if (result.schema === WEB_RESTRICTED_RESULT_SCHEMA) {
      if (
        result.result_kind !== 'restricted_grounded_result' ||
        !result.presentation ||
        result.operation !== 'search' ||
        result.sources.length ||
        result.synthesis ||
        result.document ||
        result.returned_count !== undefined ||
        result.results_truncated !== undefined ||
        result.effective_filters
      )
        invalid(
          'Restricted presentation requires metadata-only evidence and a separate result kind.'
        )
    } else if (result.result_kind || result.presentation)
      invalid('Restricted presentation requires the v3 reader.')
    if (result.schema === WEB_RESULT_SCHEMA) {
      if (
        result.routing ||
        result.attempts ||
        result.synthesis ||
        result.sources.some(
          (source) =>
            source.attempt_index !== undefined || source.evidence_kind === 'provider_citation'
        )
      )
        invalid('v2 fields require v2 schema.')
    } else {
      if (result.operation !== 'search' || !result.attempts)
        invalid('Search attempts are required for this result version.')
      const attempts = result.attempts ?? []
      attempts.forEach((attempt, index) => {
        if (attempt.index !== index + 1) invalid('Attempt indices must preserve dispatch order.')
        if ((attempt.status === 'error') !== !!attempt.error && attempt.status !== 'cancelled')
          invalid('Attempt status and error disagree.')
        if (
          attempt.status === 'ok' &&
          attempt.execution === 'model_search' &&
          attempt.search_executed !== true
        )
          invalid('Native success requires search execution evidence.')
      })
      const successful = (index: number | undefined): boolean =>
        attempts.some(
          (attempt) =>
            attempt.index === index && attempt.status === 'ok' && attempt.search_executed === true
        )
      if (
        result.sources.some(
          (source) =>
            !successful(source.attempt_index) ||
            source.snapshot_id ||
            source.evidence_kind === 'page_extract'
        )
      )
        invalid('Search source requires a successful executed attempt.')
      if (
        result.synthesis &&
        (!successful(result.synthesis.attempt_index) ||
          result.synthesis.attempt_index !== attempts.at(-1)?.index)
      )
        invalid('Synthesis requires final successful execution.')
      if (result.status === 'ok' && attempts.at(-1)?.status !== 'ok')
        invalid('Search success requires a successful final attempt.')
      if (result.returned_count !== undefined && result.returned_count !== result.sources.length)
        invalid('Returned count must match the sources.')
      const provider = attempts.at(-1)?.provider
      if (
        provider
          ? !result.provider || JSON.stringify(provider) !== JSON.stringify(result.provider)
          : !!result.provider
      )
        invalid('Provider must identify the final actual attempt.')
    }
    if (
      JSON.stringify(result).length > WEB_RESULT_MAX_CODE_UNITS ||
      new TextEncoder().encode(JSON.stringify(result)).length > WEB_RESULT_MAX_BYTES
    ) {
      context.addIssue({ code: 'custom', message: 'Result exceeds the serialized size limit.' })
    }
  })
export type WebResult = z.infer<typeof webResultSchema>
export const FetchInputSchema = fetchInputSchema
export const WebResultSchema = webResultSchema
export const parseWebResult = (value: unknown): WebResult | undefined => {
  const parsed = webResultSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

// Read a saved result from the structured and text wrappers used by tool activity.
export const readWebResultEnvelope = (value: unknown, depth = 0): WebResult | undefined => {
  if (depth > 4) return undefined
  if (typeof value === 'string') {
    if (value.length > 16_000) return undefined
    try {
      return readWebResultEnvelope(JSON.parse(value) as unknown, depth + 1)
    } catch {
      return undefined
    }
  }
  const parsed = parseWebResult(value)
  if (parsed) return parsed
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const wrapper = value as Record<string, unknown>
  for (const nested of [wrapper.structuredContent, wrapper.result, wrapper.content]) {
    if (Array.isArray(nested)) {
      for (const block of nested) {
        if (block && typeof block === 'object' && 'text' in block) {
          const result = readWebResultEnvelope(block.text, depth + 1)
          if (result) return result
        }
      }
    } else {
      const result = readWebResultEnvelope(nested, depth + 1)
      if (result) return result
    }
  }
  return undefined
}

// Main-owned execution provenance, separate from provider results and model tool arguments.
export const webInvocationMetadataSchema = z
  .object({
    attempt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    retryOf: z.string().min(1).max(512).optional(),
    configGeneration: z.string().min(1).max(128),
    branchId: z.string().min(1).max(512).optional(),
    retryEligible: z.literal(true).optional(),
    searchDispatches: z
      .array(webAttemptSchema.omit({ status: true, duration_ms: true }))
      .max(2)
      .optional(),
    searchAttempts: z.array(webAttemptSchema).max(2).optional()
  })
  .strict()
export type WebInvocationMetadata = z.infer<typeof webInvocationMetadataSchema>
