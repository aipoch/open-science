import { describe, expect, it } from 'vitest'

import type { ToolActivity } from '@/stores/session-store'

import { searchActivity, searchResult } from './workspace-web-search-test-fixtures'
import { sanitizeToolActivity } from '../../../../shared/session-persistence/tool-activity'
import {
  readWebSearchResult,
  isBuiltinWebSearchActivity,
  formatWebSearchDetails,
  hasWebSearchContentEvidence
} from './workspace-web-search-details'

const createActivity = (overrides: Partial<ToolActivity>): ToolActivity => ({
  id: 'tool-1',
  kind: 'tool',
  title: '',
  status: 'completed',
  eventIds: [],
  sortIndex: 1,
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

describe('workspace web search details', () => {
  it('formats web search details from structured tool content', () => {
    const activity = createActivity({
      id: 'tool-search-1',
      title: '"top news July 6 2026"',
      toolKind: 'fetch',
      providerToolName: 'WebSearch',
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({
              query: 'top news July 6 2026',
              results: [
                {
                  title: 'Result 1',
                  url: 'https://example.com/result-1'
                },
                {
                  title: 'Result 2',
                  url: 'https://example.com/result-2'
                }
              ]
            })
          }
        }
      ]
    })

    expect(formatWebSearchDetails(activity)).toEqual({
      query: 'top news July 6 2026',
      resultCount: 2,
      results: [
        {
          title: 'Result 1',
          url: 'https://example.com/result-1'
        },
        {
          title: 'Result 2',
          url: 'https://example.com/result-2'
        }
      ]
    })
    expect(hasWebSearchContentEvidence(activity)).toBe(true)
  })

  it('formats web search details from plain text links', () => {
    expect(
      formatWebSearchDetails(
        createActivity({
          id: 'tool-search-1',
          title: 'open-science repositories',
          toolKind: 'search',
          toolContent: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: [
                  '[Open Science Framework](https://osf.io)',
                  'Registry result',
                  'https://example.com/registry'
                ].join('\n')
              }
            }
          ]
        })
      )
    ).toEqual({
      query: 'open-science repositories',
      resultCount: 2,
      results: [
        {
          title: 'Open Science Framework',
          url: 'https://osf.io'
        },
        {
          title: 'Registry result',
          url: 'https://example.com/registry'
        }
      ]
    })
  })

  it('formats web search details from Claude links payload text', () => {
    const activity = createActivity({
      id: 'tool-search-1',
      title: '',
      toolKind: 'search',
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: [
              'Web search results for query: "Typhoon Bavi landfall time forecast 2026"',
              '',
              'Links: [{"title":"Live typhoon updates","url":"https://typhoon.slt.zj.gov.cn/"},{"title":"Typhoon No. 9 “Bavi” likely to make landfall in East China!","url":"https://finance.sina.com.cn/wm/2026-07-05/doc-inifuper9136723.shtml"}]',
              '',
              'Based on the search results, here is the latest on the predicted landfall time of Typhoon "Bavi".'
            ].join('\n')
          }
        }
      ]
    })

    expect(formatWebSearchDetails(activity)).toEqual({
      query: 'Typhoon Bavi landfall time forecast 2026',
      resultCount: 2,
      results: [
        {
          title: 'Live typhoon updates',
          url: 'https://typhoon.slt.zj.gov.cn/'
        },
        {
          title: 'Typhoon No. 9 “Bavi” likely to make landfall in East China!',
          url: 'https://finance.sina.com.cn/wm/2026-07-05/doc-inifuper9136723.shtml'
        }
      ]
    })
    expect(hasWebSearchContentEvidence(activity)).toBe(true)
  })

  it('does not treat title-only activities as web search content evidence', () => {
    expect(
      hasWebSearchContentEvidence(
        createActivity({
          id: 'tool-fetch-1',
          title: '"https://example.com/resource"',
          toolKind: 'fetch'
        })
      )
    ).toBe(false)
  })

  it('does not treat ordinary link content as web search classification evidence', () => {
    const markdownLinkActivity = createActivity({
      id: 'tool-fetch-1',
      title: '"https://example.com/resource"',
      toolKind: 'fetch',
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: '[Plain link](https://example.com/plain)'
          }
        }
      ]
    })

    expect(formatWebSearchDetails(markdownLinkActivity).results).toEqual([
      {
        title: 'Plain link',
        url: 'https://example.com/plain'
      }
    ])
    expect(hasWebSearchContentEvidence(markdownLinkActivity)).toBe(false)
  })

  it('formats Claude web_search_result title-url text', () => {
    const activity = createActivity({
      id: 'tool-search-1',
      title: '"open-science"',
      toolKind: 'fetch',
      providerToolName: 'WebSearch',
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: 'Open Science Framework (https://osf.io)'
          }
        }
      ]
    })

    expect(formatWebSearchDetails(activity)).toEqual({
      query: 'open-science',
      resultCount: 1,
      results: [
        {
          title: 'Open Science Framework',
          url: 'https://osf.io'
        }
      ]
    })
    expect(hasWebSearchContentEvidence(activity)).toBe(false)
  })

  it('ignores malformed Claude links payload metadata urls', () => {
    expect(
      formatWebSearchDetails(
        createActivity({
          id: 'tool-search-1',
          title: '',
          toolKind: 'search',
          toolContent: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: [
                  'Web search results for query: "Typhoon Bavi landfall time forecast 2026"',
                  '',
                  'Links: [{"title":"Broken result","url":"https://example.com/broken"',
                  '',
                  'url',
                  'https://metadata.example.com/internal'
                ].join('\n')
              }
            }
          ]
        })
      )
    ).toEqual({
      query: 'Typhoon Bavi landfall time forecast 2026',
      resultCount: 0,
      results: []
    })
  })

  it('keeps the total result count when compact details truncate long result lists', () => {
    const results = Array.from({ length: 9 }, (_, index) => ({
      title: `Result ${index + 1}`,
      url: `https://example.com/result-${index + 1}`
    }))

    expect(
      formatWebSearchDetails(
        createActivity({
          id: 'tool-search-1',
          title: 'open-science repositories',
          toolKind: 'search',
          toolContent: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: JSON.stringify({
                  query: 'open-science repositories',
                  results
                })
              }
            }
          ]
        })
      )
    ).toEqual({
      query: 'open-science repositories',
      resultCount: 9,
      results: results.slice(0, 8)
    })
  })
})

describe('built-in v1 search details', () => {
  it('uses validated input while pending and never the MCP title as a query', () => {
    const pending = searchActivity({ status: 'in_progress', toolContent: [] })
    expect(formatWebSearchDetails(pending)).toMatchObject({
      builtin: true,
      query: 'open science reproducibility',
      resultCount: 0
    })
    expect(
      formatWebSearchDetails({ ...pending, rawInput: { query: 'x', headers: {} } }).query
    ).toBe('')
  })
  it('requires host ownership, identity and invocation before reading the envelope', () => {
    expect(readWebSearchResult(searchActivity())).toEqual(searchResult())
    for (const overrides of [
      { appOwned: undefined },
      { providerToolName: 'mcp__external__web_search' },
      { executionInvocationId: 'other-invocation' }
    ]) {
      expect(readWebSearchResult(searchActivity(overrides))).toBeUndefined()
    }
    expect(isBuiltinWebSearchActivity(searchActivity({ appOwned: undefined }))).toBe(false)
  })
  it('keeps all ten results, source excerpts, and available publication dates', () => {
    const details = formatWebSearchDetails(searchActivity())
    expect(details.resultCount).toBe(10)
    expect(details.results).toHaveLength(10)
    expect(details.results[0]).toMatchObject({
      snippet: 'Scientific search excerpt 1',
      publishedAt: '2026-11-15T00:00:00.000Z'
    })
  })
  it('preserves redacted complete search JSON within wrapper budgets after restart', () => {
    const value = searchResult(2)
    value.sources[0].snippet = 'token=x;'.repeat(800)
    const original = JSON.stringify(value)
    const saved = sanitizeToolActivity(searchActivity({}, value))!
    const parsed = readWebSearchResult(saved as ToolActivity)!
    expect(parsed).toBeDefined()
    expect(parsed.results_truncated).toBe(true)
    expect(parsed.returned_count).toBe(parsed.sources.length)
    expect(parsed.sources[0].snippet).toContain('[redacted]')
    expect(JSON.stringify(saved.toolContent)).not.toContain('token=x')
    expect(JSON.stringify(saved.toolContent).length).toBeLessThanOrEqual(32000)
    expect(JSON.stringify(value)).toBe(original)
  })
  it('does not expose credential-bearing or executable source links', () => {
    const value = searchResult(2)
    value.sources[0].url = 'https://user:pass@example.org/private'
    value.sources[1].url = 'javascript:alert(1)'
    expect(formatWebSearchDetails(searchActivity({}, value)).results).toEqual([])
  })
  it('preserves positive results when query redaction expands beyond the input limit', () => {
    const value = searchResult(2)
    value.request = { query: 'token=a\n'.repeat(250).trim() }
    const original = JSON.stringify(value)
    const saved = sanitizeToolActivity(searchActivity({}, value))!
    const parsed = readWebSearchResult(saved as ToolActivity)!
    expect(parsed).toBeDefined()
    expect(formatWebSearchDetails(saved as ToolActivity).resultCount).toBe(2)
    expect(JSON.stringify(parsed.request)).not.toContain('token=a')
    expect(JSON.stringify(value)).toBe(original)
  })
})
