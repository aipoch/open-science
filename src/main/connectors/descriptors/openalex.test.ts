import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { OPENALEX_TOOLS } from './openalex'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => OPENALEX_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const WORK = {
  id: 'https://openalex.org/W2741809807',
  title: 'The state of OA: a large-scale analysis',
  publication_year: 2018,
  doi: 'https://doi.org/10.7717/peerj.4375',
  cited_by_count: 421,
  authorships: [
    { author: { display_name: 'Heather Piwowar' } },
    { author: { display_name: 'Jason Priem' } },
    { author: { display_name: 'Vincent Larivière' } },
    { author: { display_name: 'Juan Pablo Alperin' } },
    { author: { display_name: 'Lisa Matthias' } },
    { author: { display_name: 'Bree Norlander' } }
  ]
}

const COMPACT_WORK = {
  id: 'W2741809807',
  title: 'The state of OA: a large-scale analysis',
  publication_year: 2018,
  doi: 'https://doi.org/10.7717/peerj.4375',
  cited_by_count: 421,
  authors: [
    'Heather Piwowar',
    'Jason Priem',
    'Vincent Larivière',
    'Juan Pablo Alperin',
    'Lisa Matthias'
  ]
}

describe('openalex / search_works', () => {
  it('builds the search URL and parses a compact list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ results: [WORK] }))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('openalex_search_works'),
      { query: 'open access' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://api.openalex.org/works?search=open%20access&per_page=5'
    )
    expect(out).toEqual([COMPACT_WORK])
  })

  it('respects a custom per_page and sends no mailto/api key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ results: [] }))
    await new ParserEngine({ fetchImpl }).call(
      tool('openalex_search_works'),
      { query: 'CRISPR', per_page: 2 },
      {}
    )
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toBe('https://api.openalex.org/works?search=CRISPR&per_page=2')
    expect(url).not.toContain('mailto')
    expect(url).not.toContain('api_key')
  })

  it('returns an empty array when there are no results', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ results: [] }))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('openalex_search_works'),
      { query: 'nonexistent-topic-xyz' },
      {}
    )
    expect(out).toEqual([])
  })
})

describe('openalex / get_work', () => {
  it('fetches by bare W-id and parses the compact shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(WORK))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('openalex_get_work'),
      { id: 'W2741809807' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.openalex.org/works/W2741809807')
    expect(out).toEqual(COMPACT_WORK)
  })

  it('normalizes a DOI URL to the doi: alias form', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(WORK))
    await new ParserEngine({ fetchImpl }).call(
      tool('openalex_get_work'),
      { id: 'https://doi.org/10.7717/peerj.4375' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://api.openalex.org/works/doi%3A10.7717%2Fpeerj.4375'
    )
  })
})
