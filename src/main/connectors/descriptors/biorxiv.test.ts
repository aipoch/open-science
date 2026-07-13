import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { BIORXIV_TOOLS } from './biorxiv'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => BIORXIV_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const RECORD = {
  title: 'Oxygen restriction induces a viable but non-culturable population in bacteria',
  authors: 'Kvich, L. A.; Fritz, B. G.; Bjarnsholt, T.',
  author_corresponding: 'Thomas  Bjarnsholt',
  author_corresponding_institution: 'University of Copenhagen',
  doi: '10.1101/339747',
  date: '2018-06-05',
  version: '1',
  type: 'new results',
  license: 'cc_no',
  category: 'microbiology',
  jatsxml: 'https://www.biorxiv.org/content/early/2018/06/05/339747.source.xml',
  abstract: 'Induction of a non-culturable state...',
  funder: 'NA',
  published: 'NA',
  server: 'bioRxiv'
}

const COMPACT_RECORD = {
  doi: '10.1101/339747',
  title: 'Oxygen restriction induces a viable but non-culturable population in bacteria',
  authors: 'Kvich, L. A.; Fritz, B. G.; Bjarnsholt, T.',
  date: '2018-06-05',
  category: 'microbiology',
  published: 'NA'
}

describe('biorxiv / get_details', () => {
  it('builds the DOI details URL and parses a compact list', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ messages: [{ status: 'ok' }], collection: [RECORD] }))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('biorxiv_get_details'),
      { doi: '10.1101/339747' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://api.biorxiv.org/details/biorxiv/10.1101/339747'
    )
    expect(out).toEqual([COMPACT_RECORD])
  })

  it('defaults to biorxiv and keeps the DOI slash unencoded, strips a doi.org prefix', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ collection: [] }))
    await new ParserEngine({ fetchImpl }).call(
      tool('biorxiv_get_details'),
      { doi: 'https://doi.org/10.1101/339747' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://api.biorxiv.org/details/biorxiv/10.1101/339747'
    )
  })

  it('honors server=medrxiv', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ collection: [] }))
    await new ParserEngine({ fetchImpl }).call(
      tool('biorxiv_get_details'),
      { doi: '10.1101/2020.09.09.20191205', server: 'medrxiv' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://api.biorxiv.org/details/medrxiv/10.1101/2020.09.09.20191205'
    )
  })

  it('returns an empty array when there is no matching preprint', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ messages: [{ status: 'no posts found' }], collection: [] }))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('biorxiv_get_details'),
      { doi: '10.1101/nonexistent' },
      {}
    )
    expect(out).toEqual([])
  })
})

describe('biorxiv / list_interval', () => {
  it('builds the interval URL with default cursor and no category', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ messages: [{ status: 'ok', total: '220' }], collection: [RECORD] })
      )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('biorxiv_list_interval'),
      { from: '2024-01-01', to: '2024-01-02' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://api.biorxiv.org/details/biorxiv/2024-01-01/2024-01-02/0'
    )
    expect(out).toEqual({ total: '220', results: [COMPACT_RECORD] })
  })

  it('includes a normalized category filter and a custom cursor', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ messages: [{ status: 'ok', total: 5 }], collection: [] }))
    await new ParserEngine({ fetchImpl }).call(
      tool('biorxiv_list_interval'),
      { from: '2024-01-01', to: '2024-01-02', category: 'Cell Biology', cursor: 30 },
      {}
    )
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toBe(
      'https://api.biorxiv.org/details/biorxiv/2024-01-01/2024-01-02/30?category=cell_biology'
    )
  })
})
