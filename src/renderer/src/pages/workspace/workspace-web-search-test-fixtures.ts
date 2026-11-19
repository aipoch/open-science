import type { ToolActivity } from '@/stores/session-store-contract'
import type { WebResult } from '../../../../shared/web-tools'

export const searchResult = (count = 10): WebResult => ({
  schema: 'open-science.web.v1',
  invocation_id: 'search-invocation',
  operation: 'search',
  status: 'ok',
  request: {
    query: 'open science reproducibility',
    max_results: count || 5,
    allowed_domains: ['example.org']
  },
  retrieved_at: '2026-11-16T12:00:00.000Z',
  duration_ms: 125,
  provider: { id: 'exa', auth_mode: 'anonymous', data_policy_version: 'development' },
  effective_filters: { allowed_domains: ['example.org'], domain_mode: 'post_filter' },
  sources: Array.from({ length: count }, (_, index) => ({
    source_id: `source-${index}`,
    url: `https://example.org/result-${index + 1}`,
    title: `Result ${index + 1}`,
    snippet: `Scientific search excerpt ${index + 1}`,
    evidence_kind: 'provider_excerpt' as const,
    ...(index === 0 ? { published_at: '2026-11-15T00:00:00.000Z' } : {})
  })),
  returned_count: count,
  warnings: ['DATA_POLICY_UNCONFIRMED']
})

export const searchActivity = (
  overrides: Partial<ToolActivity> = {},
  result = searchResult()
): ToolActivity => ({
  id: 'search-activity',
  kind: 'tool',
  title: 'mcp__open_science_web__web_search',
  providerToolName: 'mcp__open_science_web__web_search',
  appOwned: true,
  executionInvocationId: 'search-invocation',
  toolKind: 'search',
  status: 'completed',
  rawInput: { query: 'open science reproducibility' },
  eventIds: [],
  sortIndex: 1,
  createdAt: 1,
  updatedAt: 2,
  toolContent: [{ type: 'content', content: { type: 'text', text: JSON.stringify(result) } }],
  ...overrides
})
