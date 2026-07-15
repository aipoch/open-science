import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { BIORXIV_TOOLS } from './biorxiv'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => BIORXIV_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

// A fetch mock that returns queued responses in order and records the requested URLs.
const sequence = (...bodies: unknown[]): { impl: typeof fetch; urls: () => string[] } => {
  let i = 0
  const impl = vi.fn(async () => jsonRes(bodies[Math.min(i++, bodies.length - 1)]))
  const urls = (): string[] => (impl.mock.calls as unknown[][]).map((c) => c[0] as string)
  return { impl: impl as unknown as typeof fetch, urls }
}

const engine = (fetchImpl: typeof fetch): ParserEngine => new ParserEngine({ fetchImpl })
const run = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch
): Promise<unknown> => engine(fetchImpl).call(tool(id), args, {})

const DETAIL_RECORD = {
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
  abstract: 'Induction of a non-culturable state via oxygen restriction.',
  funder: 'NA',
  published: 'NA',
  server: 'bioRxiv'
}

const okList = (total: string | number, collection: unknown[]): unknown => ({
  messages: [{ status: 'ok', total }],
  collection
})
const noPosts = (): unknown => ({ messages: [{ status: 'no posts found' }], collection: [] })

describe('biorxiv / exports', () => {
  it('exposes exactly the 7 official tool ids', () => {
    expect(BIORXIV_TOOLS.map((t) => t.id).sort()).toEqual([
      'get_categories',
      'get_content_statistics',
      'get_preprint',
      'get_usage_statistics',
      'search_by_funder',
      'search_preprints',
      'search_published_preprints'
    ])
    for (const t of BIORXIV_TOOLS) {
      expect(t.connector).toBe('biorxiv')
      expect(t.returns).toBeTruthy()
      expect(t.example).toContain('host.mcp("biorxiv"')
    }
  })
})

describe('biorxiv / get_categories', () => {
  it('returns 27 categories with underscore slugs, no fetch', async () => {
    const { impl, urls } = sequence()
    const out = (await run('get_categories', {}, impl)) as {
      success: boolean
      categories: { name: string; api_format: string; description: null }[]
      error: null
    }
    expect(urls()).toEqual([]) // pure constant, no HTTP
    expect(out.success).toBe(true)
    expect(out.error).toBeNull()
    expect(out.categories).toHaveLength(27)
    expect(out.categories[5]).toEqual({
      name: 'cancer biology',
      api_format: 'cancer_biology',
      description: null
    })
  })
})

describe('biorxiv / get_preprint', () => {
  it('builds the /details/{server}/{doi}/na/json URL and shapes the latest version', async () => {
    const v1 = { ...DETAIL_RECORD, version: '1' }
    const v2 = { ...DETAIL_RECORD, version: '2', published: '10.1038/s41564-020-0723-z' }
    const { impl, urls } = sequence({ messages: [{ status: 'ok' }], collection: [v1, v2] })
    const out = (await run('get_preprint', { doi: '10.1101/339747' }, impl)) as {
      success: boolean
      preprint: Record<string, unknown>
    }
    expect(urls()[0]).toBe('https://api.biorxiv.org/details/biorxiv/10.1101/339747/na/json')
    expect(out.success).toBe(true)
    expect(out.preprint).toMatchObject({
      doi: '10.1101/339747',
      version: '2',
      published_doi: '10.1038/s41564-020-0723-z',
      funding: null, // funder "NA" -> null
      n_versions: 2,
      pdf_url: 'https://www.biorxiv.org/content/10.1101/339747v2.full.pdf',
      web_url: 'https://www.biorxiv.org/content/10.1101/339747v2'
    })
  })

  it('strips a doi.org URL prefix and honors server=medrxiv (medrxiv domain URLs)', async () => {
    const rec = {
      ...DETAIL_RECORD,
      doi: '10.1101/2020.09.09.20191205',
      version: '1',
      server: 'medRxiv'
    }
    const { impl, urls } = sequence({ messages: [{ status: 'ok' }], collection: [rec] })
    const out = (await run(
      'get_preprint',
      { doi: 'https://doi.org/10.1101/2020.09.09.20191205', server: 'medrxiv' },
      impl
    )) as { preprint: Record<string, unknown> }
    expect(urls()[0]).toBe(
      'https://api.biorxiv.org/details/medrxiv/10.1101/2020.09.09.20191205/na/json'
    )
    expect(out.preprint.web_url).toBe(
      'https://www.medrxiv.org/content/10.1101/2020.09.09.20191205v1'
    )
  })

  it('returns a success:false envelope when the DOI is unknown', async () => {
    const { impl } = sequence(noPosts())
    const out = (await run('get_preprint', { doi: '10.1101/000000' }, impl)) as {
      success: boolean
      preprint: null
      error: string
    }
    expect(out).toEqual({
      success: false,
      preprint: null,
      error: 'DOI 10.1101/000000 not found on biorxiv'
    })
  })

  it('rejects a malformed DOI without any HTTP call', async () => {
    const { impl, urls } = sequence()
    const out = (await run('get_preprint', { doi: 'not-a-doi' }, impl)) as { error: string }
    expect(urls()).toEqual([])
    expect(out.error).toContain('not a valid preprint DOI')
  })
})

describe('biorxiv / search_preprints (search-method branch selection)', () => {
  it('date_from + date_to builds the /details interval URL and compact summaries', async () => {
    const { impl, urls } = sequence(okList('220', [DETAIL_RECORD]))
    const out = (await run(
      'search_preprints',
      { date_from: '2024-01-01', date_to: '2024-01-02', limit: 1 },
      impl
    )) as { results: Record<string, unknown>[]; total: number; count: number; cursor: number }
    expect(urls()[0]).toBe('https://api.biorxiv.org/details/biorxiv/2024-01-01/2024-01-02/0/json')
    expect(out).toMatchObject({ total: 220, count: 1, cursor: 0 })
    expect(out.results[0]).toEqual({
      doi: '10.1101/339747',
      title: DETAIL_RECORD.title,
      authors: DETAIL_RECORD.authors,
      date: '2018-06-05',
      category: 'microbiology',
      version: '1',
      abstract_preview: DETAIL_RECORD.abstract
    })
  })

  it('recent_days builds a today-minus-N .. today window (no recent_count tail probe)', async () => {
    const { impl, urls } = sequence(okList(1, [DETAIL_RECORD]))
    await run('search_preprints', { recent_days: 30, category: 'Neuroscience' }, impl)
    const url = urls()[0]
    const m = url.match(
      /^https:\/\/api\.biorxiv\.org\/details\/biorxiv\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})\/0\/json\?category=neuroscience$/
    )
    expect(m).not.toBeNull()
    const [, from, to] = m!
    const spanDays = (Date.parse(to) - Date.parse(from)) / 86_400_000
    expect(spanDays).toBe(30)
    expect(urls()).toHaveLength(1) // recent_days does NOT do the tail probe
  })

  it('recent_count probes total once, then reads the most-recent-N tail via cursor', async () => {
    // window total 55; recent_count 10 -> tail starts at cursor 45.
    const page45 = Array.from({ length: 10 }, (_, i) => ({
      ...DETAIL_RECORD,
      doi: `10.1101/a${45 + i}`
    }))
    const { impl, urls } = sequence(
      okList('55', [DETAIL_RECORD]), // probe at cursor 0
      okList('55', page45) // tail page at cursor 45
    )
    const out = (await run('search_preprints', { recent_count: 10, limit: 100 }, impl)) as {
      count: number
      total: number
    }
    expect(urls()[0]).toMatch(/\/0\/json$/) // probe uses cursor 0
    expect(urls()[1]).toMatch(/\/45\/json$/) // tail start = max(55 - 10, 0) + 0
    expect(out).toMatchObject({ count: 10, total: 55 })
  })

  it('no search method defaults to a 60-day window', async () => {
    const { impl, urls } = sequence(okList('1', [DETAIL_RECORD]))
    await run('search_preprints', {}, impl)
    const m = urls()[0].match(/details\/biorxiv\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})\/0\/json/)
    const spanDays = (Date.parse(m![2]) - Date.parse(m![1])) / 86_400_000
    expect(spanDays).toBe(60)
  })

  it('walks multiple pages until limit is reached (cursor advances by page length)', async () => {
    const page0 = Array.from({ length: 30 }, (_, i) => ({ ...DETAIL_RECORD, doi: `10.1101/p${i}` }))
    const page30 = Array.from({ length: 30 }, (_, i) => ({
      ...DETAIL_RECORD,
      doi: `10.1101/q${i}`
    }))
    const { impl, urls } = sequence(okList('220', page0), okList('220', page30))
    const out = (await run(
      'search_preprints',
      { date_from: '2024-01-01', date_to: '2024-01-31', limit: 45 },
      impl
    )) as { count: number; results: { doi: string }[] }
    expect(urls()[0]).toMatch(/\/0\/json$/)
    expect(urls()[1]).toMatch(/\/30\/json$/)
    expect(out.count).toBe(45) // trimmed to limit across two 30-record pages
    expect(out.results[44].doi).toBe('10.1101/q14')
  })

  it('reports total:null when a route returns records but no total', async () => {
    const { impl } = sequence(okList(0, [DETAIL_RECORD]))
    const out = (await run(
      'search_preprints',
      { date_from: '2024-01-01', date_to: '2024-01-02' },
      impl
    )) as { total: number | null; count: number }
    expect(out.total).toBeNull()
    expect(out.count).toBe(1)
  })

  it('rejects an invalid server as a success:false envelope', async () => {
    const { impl, urls } = sequence()
    const out = (await run('search_preprints', { server: 'arxiv' }, impl)) as { error: string }
    expect(urls()).toEqual([])
    expect(out.error).toContain("server must be 'biorxiv' or 'medrxiv'")
  })
})

describe('biorxiv / search_published_preprints', () => {
  const pubRec = {
    preprint_doi: '10.1101/2022.09.11.507474',
    published_doi: '10.1038/s41564-023-01548-y',
    published_journal: 'Nature Microbiology',
    preprint_platform: 'bioRxiv',
    preprint_title: 'A new route for integron cassette dissemination',
    preprint_category: 'genetics',
    preprint_date: '2022-09-13',
    published_date: '2024-01-03',
    preprint_abstract: 'Integrons are genetic elements involved in bacterial adaptation.'
  }

  it('uses the /pubs route and includes every field when include_details=true', async () => {
    const { impl, urls } = sequence(okList('276', [pubRec]))
    const out = (await run(
      'search_published_preprints',
      { date_from: '2024-01-01', date_to: '2024-01-05', limit: 10 },
      impl
    )) as { results: Record<string, unknown>[]; total: number }
    expect(urls()[0]).toBe('https://api.biorxiv.org/pubs/biorxiv/2024-01-01/2024-01-05/0/json')
    expect(out.total).toBe(276)
    expect(out.results[0]).toMatchObject({
      biorxiv_doi: '10.1101/2022.09.11.507474',
      published_journal: 'Nature Microbiology',
      preprint_abstract: pubRec.preprint_abstract
    })
    expect(out.results[0]).not.toHaveProperty('preprint_doi')
  })

  it('returns only the summary subset when include_details=false', async () => {
    const { impl } = sequence(okList('276', [pubRec]))
    const out = (await run(
      'search_published_preprints',
      { date_from: '2024-01-01', date_to: '2024-01-05', include_details: false },
      impl
    )) as { results: Record<string, unknown>[] }
    expect(Object.keys(out.results[0]).sort()).toEqual([
      'biorxiv_doi',
      'preprint_category',
      'preprint_date',
      'preprint_platform',
      'preprint_title',
      'published_date',
      'published_doi',
      'published_journal'
    ])
    expect(out.results[0]).not.toHaveProperty('preprint_abstract')
  })

  it('uses the bioRxiv-only /publisher route (no /json segment) when publisher is set', async () => {
    const { impl, urls } = sequence(okList('12', [pubRec]))
    await run(
      'search_published_preprints',
      { publisher: '10.1038', date_from: '2024-01-01', date_to: '2024-01-05' },
      impl
    )
    expect(urls()[0]).toBe('https://api.biorxiv.org/publisher/10.1038/2024-01-01/2024-01-05/0')
  })

  it('rejects publisher combined with server=medrxiv', async () => {
    const { impl, urls } = sequence()
    const out = (await run(
      'search_published_preprints',
      { publisher: '10.1038', server: 'medrxiv' },
      impl
    )) as { error: string }
    expect(urls()).toEqual([])
    expect(out.error).toContain('publisher route is bioRxiv-only')
  })

  it('rejects a non-prefix publisher value', async () => {
    const { impl } = sequence()
    const out = (await run('search_published_preprints', { publisher: '10.1038/x' }, impl)) as {
      error: string
    }
    expect(out.error).toContain('must be a DOI prefix')
  })
})

describe('biorxiv / search_by_funder', () => {
  it('builds the /funder route with dates before the ROR id and normalizes a ror.org URL', async () => {
    const { impl, urls } = sequence(okList(0, [DETAIL_RECORD]))
    const out = (await run(
      'search_by_funder',
      {
        funder_ror_id: 'https://ror.org/021nxhr62',
        date_from: '2025-04-10',
        date_to: '2025-05-10',
        category: 'Cell Biology'
      },
      impl
    )) as { total: number | null; results: unknown[] }
    expect(urls()[0]).toBe(
      'https://api.biorxiv.org/funder/biorxiv/2025-04-10/2025-05-10/021nxhr62/0/json?category=cell_biology'
    )
    expect(out.total).toBeNull() // funder route carries no total
    expect(out.results).toHaveLength(1)
  })

  it('rejects a malformed ROR id', async () => {
    const { impl, urls } = sequence()
    const out = (await run(
      'search_by_funder',
      { funder_ror_id: 'XYZ', date_from: '2025-04-10', date_to: '2025-05-10' },
      impl
    )) as { error: string }
    expect(urls()).toEqual([])
    expect(out.error).toContain('ROR id must be 9 chars')
  })

  it('rejects a malformed date', async () => {
    const { impl } = sequence()
    const out = (await run(
      'search_by_funder',
      { funder_ror_id: '021nxhr62', date_from: '2025/04/10', date_to: '2025-05-10' },
      impl
    )) as { error: string }
    expect(out.error).toContain("date_from must be 'YYYY-MM-DD'")
  })
})

describe('biorxiv / get_content_statistics', () => {
  it('fetches /sum/y and coerces yearly rows to numbers', async () => {
    const body = {
      messages: { status: 'ok' },
      'bioRxiv content statistics': [
        {
          year: 2013,
          new_papers: 109,
          new_papers_cumulative: 109,
          revised_papers: 34,
          revised_papers_cumulative: 34
        }
      ]
    }
    const { impl, urls } = sequence(body)
    const out = (await run('get_content_statistics', { interval: 'yearly' }, impl)) as {
      results: Record<string, unknown>[]
    }
    expect(urls()[0]).toBe('https://api.biorxiv.org/sum/y/json')
    expect(out.results[0]).toEqual({
      year: 2013,
      new_papers: 109,
      new_papers_cumulative: 109,
      revised_papers: 34,
      revised_papers_cumulative: 34
    })
  })

  it('defaults to /sum/m (monthly) and keeps the month string', async () => {
    const body = {
      messages: { status: 'ok' },
      'bioRxiv content statistics': [
        {
          month: '2013-11',
          new_papers: '80',
          new_papers_cumulative: '80',
          revised_papers: '2',
          revised_papers_cumulative: '2'
        }
      ]
    }
    const { impl, urls } = sequence(body)
    const out = (await run('get_content_statistics', {}, impl)) as {
      results: Record<string, unknown>[]
    }
    expect(urls()[0]).toBe('https://api.biorxiv.org/sum/m/json')
    expect(out.results[0]).toMatchObject({ month: '2013-11', new_papers: 80 })
  })

  it('rejects an invalid interval', async () => {
    const { impl } = sequence()
    const out = (await run('get_content_statistics', { interval: 'weekly' }, impl)) as {
      error: string
    }
    expect(out.error).toContain('Invalid interval')
  })
})

describe('biorxiv / get_usage_statistics', () => {
  it('fetches /usage/y and coerces string counts to numbers, year as string', async () => {
    const body = {
      messages: { status: 'ok' },
      'bioRxiv content statistics': [
        {
          year: '2013',
          abstract_views: '2665',
          full_text_views: '0',
          pdf_downloads: '3716',
          abstract_cumulative: 2665,
          full_text_cumulative: 0,
          pdf_cumulative: 3716
        }
      ]
    }
    const { impl, urls } = sequence(body)
    const out = (await run('get_usage_statistics', { interval: 'yearly' }, impl)) as {
      results: Record<string, unknown>[]
    }
    expect(urls()[0]).toBe('https://api.biorxiv.org/usage/y/json')
    expect(out.results[0]).toEqual({
      year: '2013',
      abstract_views: 2665,
      full_text_views: 0,
      pdf_downloads: 3716,
      abstract_cumulative: 2665,
      full_text_cumulative: 0,
      pdf_cumulative: 3716
    })
  })
})
