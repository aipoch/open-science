import { describe, expect, it } from 'vitest'

import type { ToolActivity } from '@/stores/session-store'

import { formatWebSearchDetails, hasWebSearchContentEvidence } from './workspace-web-search-details'

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
          title: 'open science repositories',
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
      query: 'open science repositories',
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
      title: '"open science"',
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
      query: 'open science',
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
          title: 'open science repositories',
          toolKind: 'search',
          toolContent: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: JSON.stringify({
                  query: 'open science repositories',
                  results
                })
              }
            }
          ]
        })
      )
    ).toEqual({
      query: 'open science repositories',
      resultCount: 9,
      results: results.slice(0, 8)
    })
  })
})
