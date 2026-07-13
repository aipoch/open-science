import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { PUBMED_TOOLS } from './pubmed'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('pubmed', () => {
  it('esearch + esummary, includes etiquette', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ esearchresult: { count: '2', idlist: ['1', '2'] } }))
      .mockResolvedValueOnce(
        jsonRes({
          result: { '1': { title: 'A', pubdate: '2020' }, '2': { title: 'B', pubdate: '2021' } }
        })
      )
    const tool = PUBMED_TOOLS.find((t) => t.id === 'pubmed_search')!
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool,
      { term: 'crispr', retmax: 2 },
      { ncbiEmail: 'x@y.org' }
    )) as {
      count: number
      articles: unknown[]
    }
    expect(fetchImpl.mock.calls[0][0]).toContain('email=x%40y.org')
    expect(out.count).toBe(2)
    expect(out.articles).toEqual([
      { pmid: '1', title: 'A', date: '2020' },
      { pmid: '2', title: 'B', date: '2021' }
    ])
  })
})
