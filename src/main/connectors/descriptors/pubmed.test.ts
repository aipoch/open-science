import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { PUBMED_TOOLS } from './pubmed'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const textRes = (body: string): Response =>
  ({ ok: true, status: 200, text: async () => body }) as Response

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

  it('pubmed_fetch returns metadata + abstract per PMID (esummary + efetch)', async () => {
    const esummary = {
      result: {
        '1': {
          title: 'Paper One',
          pubdate: '2020 Jan',
          source: 'J Test',
          authors: [
            { name: 'Smith AB', authtype: 'Author' },
            { name: 'Doe C', authtype: 'Author' }
          ],
          articleids: [
            { idtype: 'pubmed', value: '1' },
            { idtype: 'doi', value: '10.1/x' }
          ]
        }
      }
    }
    const efetchXml =
      '<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID Version="1">1</PMID>' +
      '<Article><Abstract><AbstractText Label="BACKGROUND">Hello</AbstractText>' +
      '<AbstractText Label="METHODS">World</AbstractText></Abstract></Article>' +
      '</MedlineCitation></PubmedArticle></PubmedArticleSet>'
    const fetchImpl = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(url.includes('esummary') ? jsonRes(esummary) : textRes(efetchXml))
      )
    const tool = PUBMED_TOOLS.find((t) => t.id === 'pubmed_fetch')!
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool,
      { pmids: ['1'] },
      { ncbiEmail: 'x@y.org' }
    )) as { pmids: string[]; articles: unknown[] }

    expect(out.articles).toEqual([
      {
        pmid: '1',
        title: 'Paper One',
        authors: ['Smith AB', 'Doe C'],
        journal: 'J Test',
        date: '2020 Jan',
        doi: '10.1/x',
        abstract: 'Hello World'
      }
    ])
    // Both endpoints hit, and NCBI etiquette is attached.
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes('esummary'))).toBe(true)
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes('efetch'))).toBe(true)
    expect(fetchImpl.mock.calls.every((c) => String(c[0]).includes('email=x%40y.org'))).toBe(true)
  })

  it('pubmed_fetch yields null abstract/doi when PubMed has none', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('esummary')
          ? jsonRes({
              result: { '9': { title: 'T', pubdate: '2021', source: 'J', authors: [] } }
            })
          : textRes('<PubmedArticleSet></PubmedArticleSet>')
      )
    )
    const tool = PUBMED_TOOLS.find((t) => t.id === 'pubmed_fetch')!
    const out = (await new ParserEngine({ fetchImpl }).call(tool, { pmids: ['9'] }, {})) as {
      articles: Array<{ doi: unknown; abstract: unknown; authors: unknown }>
    }
    expect(out.articles[0].doi).toBeNull()
    expect(out.articles[0].abstract).toBeNull()
    expect(out.articles[0].authors).toEqual([])
  })
})
