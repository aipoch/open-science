import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { OPENALEX_LITERATURE_TOOLS } from './literature-openalex'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const tool = (id: string): (typeof OPENALEX_LITERATURE_TOOLS)[number] => {
  const t = OPENALEX_LITERATURE_TOOLS.find((x) => x.id === id)
  if (!t) throw new Error(`no tool ${id}`)
  return t
}

// Runs a tool through the engine with a URL-dispatching fetch mock.
const run = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>
): Promise<unknown> =>
  new ParserEngine({ fetchImpl: fetchImpl as unknown as typeof fetch }).call(tool(id), args, {})

// A representative full work object; helpers pick the fields they need.
const workW1 = {
  id: 'https://openalex.org/W1',
  doi: 'https://doi.org/10.1/abc',
  ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/12345' },
  title: 'A Study',
  publication_year: 2021,
  publication_date: '2021-06-01',
  type: 'article',
  language: 'en',
  is_retracted: false,
  authorships: [
    {
      author: { id: 'https://openalex.org/A9', display_name: 'Jane Roe', orcid: 'orcid-x' },
      author_position: 'first',
      is_corresponding: true,
      institutions: [{ display_name: 'MIT' }, { display_name: null }]
    }
  ],
  primary_location: {
    source: {
      id: 'https://openalex.org/S5',
      display_name: 'Nature',
      issn_l: '1476-4687',
      type: 'journal'
    },
    landing_page_url: 'https://example.org/landing'
  },
  best_oa_location: { pdf_url: 'https://example.org/x.pdf' },
  biblio: { volume: '1', issue: '2', first_page: '3', last_page: '4' },
  cited_by_count: 42,
  fwci: 1.5,
  referenced_works_count: 2,
  open_access: { is_oa: true, oa_status: 'gold', oa_url: 'https://example.org/oa' },
  primary_topic: {
    id: 'https://openalex.org/T1',
    display_name: 'Gene Editing',
    field: { display_name: 'Biology' },
    subfield: { display_name: 'Genetics' },
    domain: { display_name: 'Life Sciences' }
  },
  keywords: [{ display_name: 'crispr' }, { keyword: 'editing' }]
}

describe('openalex_search_works', () => {
  it('assembles year/type/oa filters, maps sort, paginates with cap and lean records', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({ meta: { count: 5, next_cursor: 'c2' }, results: [workW1, workW1] })
      )
    const out = (await run(
      'openalex_search_works',
      {
        query: 'crispr',
        year_from: 2020,
        year_to: 2022,
        work_type: 'article',
        open_access_only: true,
        sort: 'cited_by_count',
        max_records: 2
      },
      fetchImpl
    )) as {
      filters: Record<string, string>
      sort: string
      api_total: number
      n_records_returned: number
      records_truncated: boolean
      records: Array<Record<string, unknown>>
    }
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('filter=')
    expect(url).toContain('from_publication_date:2020-01-01')
    expect(url).toContain('to_publication_date:2022-12-31')
    expect(url).toContain('type:article')
    expect(url).toContain('is_oa:true')
    expect(url).toContain('sort=cited_by_count:desc')
    expect(url).toContain('search=crispr')
    expect(out.filters).toEqual({
      from_publication_date: '2020-01-01',
      to_publication_date: '2022-12-31',
      type: 'article',
      is_oa: 'true'
    })
    expect(out.api_total).toBe(5)
    expect(out.n_records_returned).toBe(2)
    expect(out.records_truncated).toBe(true)
    // Only one page fetched because the cap was reached.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const r = out.records[0]
    expect(r.openalex_id).toBe('W1')
    expect(r.doi).toBe('10.1/abc')
    expect(r.pmid).toBe('12345')
    expect(r.best_oa_pdf_url).toBe('https://example.org/x.pdf')
    expect(r.source).toEqual({
      source_id: 'S5',
      display_name: 'Nature',
      issn_l: '1476-4687',
      type: 'journal'
    })
    expect((r.authors as Array<Record<string, unknown>>)[0]).toEqual({
      author_id: 'A9',
      name: 'Jane Roe',
      orcid: 'orcid-x',
      position: 'first',
      is_corresponding: true,
      institutions: ['MIT']
    })
    expect(r.primary_topic).toEqual({
      id: 'T1',
      display_name: 'Gene Editing',
      field: 'Biology',
      subfield: 'Genetics',
      domain: 'Life Sciences'
    })
    expect(r.keywords).toEqual(['crispr', 'editing'])
  })

  it('resolves a venue NAME to an S-id filter and surfaces venue_resolved', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/sources?search=')) {
        return Promise.resolve(
          jsonRes({ results: [{ id: 'https://openalex.org/S5', display_name: 'Nature' }] })
        )
      }
      return Promise.resolve(jsonRes({ meta: { count: 1, next_cursor: null }, results: [workW1] }))
    })
    const out = (await run(
      'openalex_search_works',
      { query: 'x', venue: 'Nature' },
      fetchImpl
    )) as { filters: Record<string, string>; venue_resolved: unknown }
    expect(out.filters['primary_location.source.id']).toBe('S5')
    expect(out.venue_resolved).toEqual({ source_id: 'S5', display_name: 'Nature' })
    const worksUrl = String(fetchImpl.mock.calls.find((c) => String(c[0]).includes('/works?'))![0])
    expect(worksUrl).toContain('primary_location.source.id:S5')
  })

  it('throws when neither query nor a filter is provided', async () => {
    const fetchImpl = vi.fn()
    await expect(run('openalex_search_works', {}, fetchImpl)).rejects.toThrow(/at least a query/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('include_abstracts license gate: open reconstructs, nc withholds, missing index -> null', async () => {
    const openWork = {
      id: 'https://openalex.org/W2',
      best_oa_location: { license: 'cc-by' },
      abstract_inverted_index: { Hello: [0], World: [1] }
    }
    const ncWork = {
      id: 'https://openalex.org/W3',
      primary_location: { license: 'cc-by-nc', landing_page_url: 'https://lp/3' },
      abstract_inverted_index: { Secret: [0] }
    }
    const noIndexWork = { id: 'https://openalex.org/W4' }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({ meta: { count: 3, next_cursor: null }, results: [openWork, ncWork, noIndexWork] })
      )
    const out = (await run(
      'openalex_search_works',
      { query: 'x', include_abstracts: true },
      fetchImpl
    )) as { records: Array<Record<string, unknown>> }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('abstract_inverted_index')
    expect(out.records[0].abstract).toBe('Hello World')
    expect(out.records[0].abstract_license).toBe('cc-by')
    expect(out.records[1].abstract).toBeNull()
    expect(out.records[1].abstract_license).toBe('cc-by-nc')
    expect(String(out.records[1].abstract_policy)).toContain('cc-by-nc')
    expect(String(out.records[1].abstract_policy)).toContain('https://lp/3')
    expect(out.records[2].abstract).toBeNull()
    expect(out.records[2].abstract_license).toBeUndefined()
  })
})

describe('openalex_get_work', () => {
  it('fetches a W-id and attaches abstract, referenced_works, counts_by_year', async () => {
    const full = {
      ...workW1,
      abstract_inverted_index: { Open: [0], Text: [1] },
      best_oa_location: { license: 'cc0', pdf_url: null },
      referenced_works: ['https://openalex.org/W10', 'https://openalex.org/W11'],
      counts_by_year: [{ year: 2022, cited_by_count: 5 }]
    }
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(full))
    const out = (await run('openalex_get_work', { work_id: 'W1' }, fetchImpl)) as {
      openalex_id: string
      abstract: string
      referenced_works: string[]
      counts_by_year: unknown
    }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/works/W1?')
    expect(out.openalex_id).toBe('W1')
    expect(out.abstract).toBe('Open Text')
    expect(out.referenced_works).toEqual(['W10', 'W11'])
    expect(out.counts_by_year).toEqual([{ year: 2022, cited_by_count: 5 }])
  })

  it('resolves a single-claimant DOI via the works filter', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ results: [workW1] }))
    const out = (await run('openalex_get_work', { work_id: '10.1/abc' }, fetchImpl)) as {
      openalex_id: string
      doi_claimants?: unknown
    }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('filter=doi:10.1%2Fabc')
    expect(out.openalex_id).toBe('W1')
    expect(out.doi_claimants).toBeUndefined()
  })

  it('picks the most-cited work for a multi-claimant DOI and reports claimants', async () => {
    const low = { id: 'https://openalex.org/Wa', cited_by_count: 3, title: 'Low' }
    const high = { id: 'https://openalex.org/Wb', cited_by_count: 90, title: 'High' }
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ results: [low, high] }))
    const out = (await run('openalex_get_work', { work_id: 'doi:10.9/dup' }, fetchImpl)) as {
      openalex_id: string
      doi_claimants: unknown[]
      doi_resolution_note: string
    }
    expect(out.openalex_id).toBe('Wb')
    expect(out.doi_claimants).toHaveLength(2)
    expect(out.doi_resolution_note).toContain('Wb')
  })

  it('throws not-found for a DOI with zero results', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ results: [] }))
    await expect(run('openalex_get_work', { work_id: '10.0/missing' }, fetchImpl)).rejects.toThrow(
      /No OpenAlex work found/
    )
  })
})

describe('openalex_citations', () => {
  it('filters by cites: and maps sort, reporting api_total and truncation', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ meta: { count: 10, next_cursor: null }, results: [workW1] }))
    const out = (await run(
      'openalex_citations',
      { work_id: 'W1', sort: 'publication_date', max_records: 1 },
      fetchImpl
    )) as { work_id: string; api_total: number; records_truncated: boolean }
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('filter=cites:W1')
    expect(url).toContain('sort=publication_date:desc')
    expect(out.work_id).toBe('W1')
    expect(out.api_total).toBe(10)
    expect(out.records_truncated).toBe(true)
  })

  it('resolves a DOI work_id first, then queries citations', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('filter=doi:')) {
        return Promise.resolve(
          jsonRes({ results: [{ id: 'https://openalex.org/W1', cited_by_count: 1 }] })
        )
      }
      return Promise.resolve(jsonRes({ meta: { count: 0, next_cursor: null }, results: [] }))
    })
    const out = (await run('openalex_citations', { work_id: '10.1/abc' }, fetchImpl)) as {
      work_id: string
    }
    expect(out.work_id).toBe('W1')
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes('filter=cites:W1'))).toBe(true)
  })
})

describe('openalex_references', () => {
  it('preserves reference order, batches hydration, and flags a missing id', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('select=referenced_works')) {
        return Promise.resolve(
          jsonRes({
            referenced_works: [
              'https://openalex.org/W10',
              'https://openalex.org/W11',
              'https://openalex.org/W12'
            ]
          })
        )
      }
      // Hydration batch: W11 is absent (merged/deleted upstream).
      return Promise.resolve(
        jsonRes({
          results: [
            { id: 'https://openalex.org/W12', title: 'Twelve' },
            { id: 'https://openalex.org/W10', title: 'Ten' }
          ]
        })
      )
    })
    const out = (await run('openalex_references', { work_id: 'W1' }, fetchImpl)) as {
      n_references: number
      reference_ids: string[]
      references_not_hydrated: string[]
      records: Array<{ openalex_id: string }>
    }
    const hydrateUrl = String(
      fetchImpl.mock.calls.find((c) => String(c[0]).includes('openalex_id:'))![0]
    )
    expect(hydrateUrl).toContain('openalex_id:W10|W11|W12')
    expect(out.n_references).toBe(3)
    expect(out.reference_ids).toEqual(['W10', 'W11', 'W12'])
    // Emitted in reference-list order, skipping the unhydrated id.
    expect(out.records.map((r) => r.openalex_id)).toEqual(['W10', 'W12'])
    expect(out.references_not_hydrated).toEqual(['W11'])
  })
})

describe('openalex_search_authors', () => {
  it('searches by name and maps the lean author record', async () => {
    const author = {
      id: 'https://openalex.org/A9',
      display_name: 'Jane Roe',
      orcid: 'https://orcid.org/0000-0001-0000-0001',
      works_count: 100,
      cited_by_count: 5000,
      summary_stats: { h_index: 40, i10_index: 80 },
      affiliations: [{ institution: { display_name: 'MIT' }, years: [2020, 2021] }],
      last_known_institutions: [{ display_name: 'Broad' }],
      topics: [{ display_name: 'Genetics' }, { display_name: 'Genomics' }]
    }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ meta: { count: 1, next_cursor: null }, results: [author] }))
    const out = (await run('openalex_search_authors', { query: 'Jane Roe' }, fetchImpl)) as {
      records: Array<Record<string, unknown>>
    }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/authors?search=Jane%20Roe')
    expect(out.records[0]).toEqual({
      author_id: 'A9',
      name: 'Jane Roe',
      orcid: 'https://orcid.org/0000-0001-0000-0001',
      works_count: 100,
      cited_by_count: 5000,
      h_index: 40,
      i10_index: 80,
      affiliations: [{ institution: 'MIT', years: [2020, 2021] }],
      last_known_institutions: ['Broad'],
      top_topics: ['Genetics', 'Genomics']
    })
  })
})

describe('openalex_get_author', () => {
  const author = {
    id: 'https://openalex.org/A9',
    display_name: 'Jane Roe',
    summary_stats: { h_index: 40, i10_index: 80 },
    counts_by_year: [{ year: 2021, works_count: 10 }]
  }

  it('normalizes an ORCID to the orcid: alias and fetches top works', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/authors/')) return Promise.resolve(jsonRes(author))
      return Promise.resolve(jsonRes({ meta: { count: 250 }, results: [workW1] }))
    })
    const out = (await run(
      'openalex_get_author',
      { author_id: '0000-0001-0000-0001', works_sample: 5 },
      fetchImpl
    )) as {
      author_id: string
      top_works_total: number
      top_works: unknown[]
      counts_by_year: unknown
    }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/authors/orcid:0000-0001-0000-0001')
    const worksUrl = String(fetchImpl.mock.calls.find((c) => String(c[0]).includes('/works?'))![0])
    expect(worksUrl).toContain('filter=author.id:A9')
    expect(worksUrl).toContain('per-page=5')
    expect(out.top_works_total).toBe(250)
    expect(out.top_works).toHaveLength(1)
    expect(out.counts_by_year).toEqual([{ year: 2021, works_count: 10 }])
  })

  it('skips the works request when works_sample is 0', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(author))
    const out = (await run(
      'openalex_get_author',
      { author_id: 'A9', works_sample: 0 },
      fetchImpl
    )) as { top_works_total: number; top_works: unknown[] }
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(out.top_works_total).toBe(0)
    expect(out.top_works).toEqual([])
  })
})

describe('openalex_venue_info', () => {
  const source = {
    id: 'https://openalex.org/S5',
    display_name: 'Nature',
    type: 'journal',
    issn_l: '1476-4687',
    issn: ['0028-0836', '1476-4687'],
    host_organization_name: 'Springer Nature',
    country_code: 'GB',
    is_oa: false,
    is_in_doaj: false,
    is_core: true,
    apc_usd: 11690,
    works_count: 400000,
    cited_by_count: 20000000,
    summary_stats: { h_index: 1200, '2yr_mean_citedness': 25.5 },
    topics: [{ display_name: 'Multidisciplinary' }],
    counts_by_year: [
      { year: 2019, works_count: 1 },
      { year: 2023, works_count: 2 }
    ]
  }

  it('exact S-id GET returns one lean source plus counts_by_year', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(source))
    const out = (await run('openalex_venue_info', { venue: 'S5' }, fetchImpl)) as Record<
      string,
      unknown
    >
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/sources/S5?')
    expect(out.source_id).toBe('S5')
    expect(out.two_year_mean_citedness).toBe(25.5)
    expect(out.h_index).toBe(1200)
    expect(out.first_publication_year).toBe(2019)
    expect(out.last_publication_year).toBe(2023)
    expect(out.counts_by_year).toHaveLength(2)
  })

  it('ISSN uses the issn: alias GET', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(source))
    await run('openalex_venue_info', { venue: '1476-4687' }, fetchImpl)
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/sources/issn:1476-4687?')
  })

  it('a plain name triggers the source search branch', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ meta: { count: 3, next_cursor: null }, results: [source] }))
    const out = (await run(
      'openalex_venue_info',
      { venue: 'nature', max_records: 1 },
      fetchImpl
    )) as { query: string; api_total: number; records_truncated: boolean; records: unknown[] }
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('/sources?search=nature')
    expect(url).toContain('per-page=200')
    expect(url).toContain('cursor=*')
    expect(out.query).toBe('nature')
    expect(out.api_total).toBe(3)
    expect(out.records_truncated).toBe(true)
    expect(out.records).toHaveLength(1)
  })
})
