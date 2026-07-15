import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { RESEARCH_RESOURCES_TOOLS } from './research-resources'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => RESEARCH_RESOURCES_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response
const engine = (fetchImpl: typeof fetch): ParserEngine => new ParserEngine({ fetchImpl })
// The POST body the engine sent on the Nth fetch call.
const bodyOf = (fetchImpl: ReturnType<typeof vi.fn>, n = 0): Record<string, unknown> =>
  JSON.parse((fetchImpl.mock.calls[n][1] as RequestInit).body as string)

// ------------------------------------------------------------------ Grants.gov

describe('research_resources / search_grants', () => {
  const oppHit = (id: string, number: string): Record<string, unknown> => ({
    id,
    number,
    title: `Opp ${number}`,
    agencyCode: 'HHS-NIH11',
    agency: 'National Institutes of Health',
    oppStatus: 'posted',
    openDate: '01/01/2026',
    closeDate: '',
    docType: 'synopsis',
    cfdaList: ['93.399']
  })
  const facets = {
    oppStatusOptions: [{ value: 'posted', count: 2 }],
    agencies: [{ value: 'HHS-NIH11', count: 2 }],
    eligibilities: [],
    fundingCategories: [],
    fundingInstruments: [],
    dateRangeOptions: []
  }

  it('walks the full result set and passes records through verbatim', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        errorcode: 0,
        data: { hitCount: 2, oppHits: [oppHit('1', 'A-1'), oppHit('2', 'A-2')], ...facets }
      })
    )
    const out = (await engine(fetchImpl).call(
      tool('search_grants'),
      { keyword: 'cancer', agencies: ['HHS-NIH11'] },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.grants.gov/v1/api/search2')
    expect(bodyOf(fetchImpl)).toEqual({
      rows: 1000,
      startRecordNum: 0,
      oppStatuses: 'forecasted|posted',
      sortBy: 'oppNum|asc',
      keyword: 'cancer',
      agencies: 'HHS-NIH11'
    })
    expect(out.hit_count).toBe(2)
    expect(out.n_returned).toBe(2)
    expect(out.truncated).toBe(false)
    expect(out.records).toEqual([oppHit('1', 'A-1'), oppHit('2', 'A-2')])
    expect((out.facets as Record<string, unknown>).dateRangeOptions).toEqual([])
  })

  it('paginates via startRecordNum until hitCount is reached', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({ errorcode: 0, data: { hitCount: 2, oppHits: [oppHit('1', 'A-1')], ...facets } })
      )
      .mockResolvedValueOnce(
        jsonRes({ errorcode: 0, data: { hitCount: 2, oppHits: [oppHit('2', 'A-2')] } })
      )
    const out = (await engine(fetchImpl).call(
      tool('search_grants'),
      { keyword: 'cancer' },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(bodyOf(fetchImpl, 1).startRecordNum).toBe(1)
    expect(out.n_returned).toBe(2)
    expect(out.hit_count).toBe(2)
  })

  it('caps records at max_records and flags truncated after a complete walk', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        errorcode: 0,
        data: {
          hitCount: 3,
          oppHits: [oppHit('1', 'A-1'), oppHit('2', 'A-2'), oppHit('3', 'A-3')],
          ...facets
        }
      })
    )
    const out = (await engine(fetchImpl).call(
      tool('search_grants'),
      { keyword: 'cancer', max_records: 2 },
      {}
    )) as Record<string, unknown>
    expect(out.n_returned).toBe(2)
    expect(out.truncated).toBe(true)
    expect((out.records as unknown[]).length).toBe(2)
  })

  it('count_only posts rows=0 and returns hit count + count facets (no dateRangeOptions)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ errorcode: 0, data: { hitCount: 114, oppHits: [], ...facets } }))
    const out = (await engine(fetchImpl).call(
      tool('search_grants'),
      { keyword: 'cancer', count_only: true },
      {}
    )) as Record<string, unknown>
    expect(bodyOf(fetchImpl).rows).toBe(0)
    expect(out).toMatchObject({ hit_count: 114, n_returned: 0, truncated: false, records: [] })
    const outFacets = out.facets as Record<string, unknown>
    expect('dateRangeOptions' in outFacets).toBe(false)
    expect('oppStatusOptions' in outFacets).toBe(true)
  })

  it('omits facets when include_facets is false', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ errorcode: 0, data: { hitCount: 0, oppHits: [], ...facets } }))
    const out = (await engine(fetchImpl).call(
      tool('search_grants'),
      { keyword: 'cancer', include_facets: false },
      {}
    )) as Record<string, unknown>
    expect('facets' in out).toBe(false)
  })

  it('maps aln to cfda and pipe-joins list filters', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ errorcode: 0, data: { hitCount: 0, oppHits: [], ...facets } }))
    await engine(fetchImpl).call(
      tool('search_grants'),
      {
        aln: '93.866',
        agencies: ['HHS-NIH11', 'HHS-FDA'],
        opportunity_statuses: ['posted', 'closed'],
        eligibilities: ['25']
      },
      {}
    )
    expect(bodyOf(fetchImpl)).toMatchObject({
      cfda: '93.866',
      agencies: 'HHS-NIH11|HHS-FDA',
      oppStatuses: 'posted|closed',
      eligibilities: '25'
    })
  })

  it('rejects a call with no search criterion', async () => {
    const fetchImpl = vi.fn()
    await expect(
      engine(fetchImpl).call(tool('search_grants'), { opportunity_statuses: ['posted'] }, {})
    ).rejects.toThrow(/at least one search criterion/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an invalid opportunity status', async () => {
    const fetchImpl = vi.fn()
    await expect(
      engine(fetchImpl).call(
        tool('search_grants'),
        { keyword: 'cancer', opportunity_statuses: ['bogus'] },
        {}
      )
    ).rejects.toThrow(/invalid oppStatus/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('raises on a non-zero errorcode envelope', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ errorcode: 2, msg: 'bad request', data: null }))
    await expect(
      engine(fetchImpl).call(tool('search_grants'), { keyword: 'cancer' }, {})
    ).rejects.toThrow(/errorcode 2/)
  })

  it('raises IncompleteRetrieval when duplicate ids never reconcile with hitCount', async () => {
    const dup = oppHit('1', 'A-1')
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ errorcode: 0, data: { hitCount: 2, oppHits: [dup], ...facets } })
      )
    await expect(
      engine(fetchImpl).call(tool('search_grants'), { keyword: 'cancer' }, {})
    ).rejects.toThrow(/incomplete grants.gov retrieval/)
    // two full walk attempts before giving up (2 pages each)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })
})

// --------------------------------------------------------- Antibody Registry

// A registry record carrying volatile fields that must be stripped from output.
const abRecord = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  abId: 3676740,
  abName: 'CD8, Liquid Concentrate',
  abTarget: 'CD8',
  catalogNum: 'CD8-4B11-L-U',
  catAlt: 'NCL-L-CD8-4B11-U',
  vendorName: 'Leica Biosystems',
  cloneId: '4B11',
  sourceOrganism: 'Mouse',
  targetSpecies: ['human'],
  // volatile — stripped by _norm parity:
  curateTime: '2025-03-06T21:30:22.099Z',
  lastEditTime: null,
  ix: 3612196,
  showLink: null,
  feedback: '',
  numOfCitation: 0,
  ...over
})
const stripped = (over: Record<string, unknown> = {}): Record<string, unknown> => {
  const r = abRecord(over)
  for (const k of ['curateTime', 'lastEditTime', 'ix', 'showLink', 'feedback', 'numOfCitation']) {
    delete r[k]
  }
  return r
}

describe('research_resources / search_antibodies', () => {
  it('walks pages, strips volatile fields, and reports unique_ab_ids', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ totalElements: 2, items: [abRecord({ abId: 1 })] }))
      .mockResolvedValueOnce(jsonRes({ totalElements: 2, items: [abRecord({ abId: 2 })] }))
    const out = (await engine(fetchImpl).call(
      tool('search_antibodies'),
      { query: 'CD8', page_size: 1 },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.antibodyregistry.org/api/fts-antibodies?q=CD8&page=1&size=1'
    )
    expect(fetchImpl.mock.calls[1][0]).toContain('page=2&size=1')
    expect(out).toMatchObject({
      query: 'CD8',
      total_elements: 2,
      retrieved: 2,
      unique_ab_ids: 2,
      complete: true,
      truncated_at_max_records: false,
      anonymous_limit_hit: false
    })
    expect((out.items as Record<string, unknown>[])[0]).toEqual(stripped({ abId: 1 }))
    expect('curateTime' in (out.items as Record<string, unknown>[])[0]).toBe(false)
  })

  it('flags anonymous_limit_hit when the walk reaches the 500-row cap', async () => {
    // page_size 300: page 1 fetched (300 <= 500), page 2 would be 600 > 500 -> stop.
    const items = Array.from({ length: 300 }, (_, i) => abRecord({ abId: i }))
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ totalElements: 700, items }))
    const out = (await engine(fetchImpl).call(
      tool('search_antibodies'),
      { query: 'CD4', page_size: 300 },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({
      total_elements: 700,
      retrieved: 300,
      complete: false,
      anonymous_limit_hit: true,
      truncated_at_max_records: false
    })
  })

  it('flags truncated_at_max_records when max_records stops the walk before the cap', async () => {
    const items = Array.from({ length: 100 }, (_, i) => abRecord({ abId: i }))
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ totalElements: 400, items }))
    const out = (await engine(fetchImpl).call(
      tool('search_antibodies'),
      { query: 'CD4', page_size: 100, max_records: 100 },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({
      retrieved: 100,
      complete: false,
      truncated_at_max_records: true,
      anonymous_limit_hit: false
    })
  })

  it('single-page mode returns the page-shaped result', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ totalElements: 1, items: [abRecord()] }))
    const out = (await engine(fetchImpl).call(
      tool('search_antibodies'),
      { query: 'CD8', page: 1, page_size: 10 },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.antibodyregistry.org/api/fts-antibodies?q=CD8&page=1&size=10'
    )
    expect(out).toMatchObject({
      query: 'CD8',
      page: 1,
      total_elements: 1,
      retrieved: 1,
      complete: true
    })
    expect('anonymous_limit_hit' in out).toBe(false)
  })

  it('rejects single-page requests past the anonymous row limit', async () => {
    const fetchImpl = vi.fn()
    await expect(
      engine(fetchImpl).call(
        tool('search_antibodies'),
        { query: 'CD4', page: 6, page_size: 100 },
        {}
      )
    ).rejects.toThrow(/anonymous row limit/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an empty query', async () => {
    const fetchImpl = vi.fn()
    await expect(
      engine(fetchImpl).call(tool('search_antibodies'), { query: '   ' }, {})
    ).rejects.toThrow(/query must be non-empty/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('research_resources / get_antibody', () => {
  it('parses a numeric id into ab_id/rrid/record_count with stripped records', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes([abRecord({ abId: 3643095 })]))
    const out = (await engine(fetchImpl).call(
      tool('get_antibody'),
      { antibody_id: '3643095' },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.antibodyregistry.org/api/antibodies/3643095'
    )
    expect(out.ab_id).toBe(3643095)
    expect(out.rrid).toBe('AB_3643095')
    expect(out.record_count).toBe(1)
    expect((out.records as Record<string, unknown>[])[0]).toEqual(stripped({ abId: 3643095 }))
  })

  it('accepts "AB_<id>" and "RRID:AB_<id>" forms', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes([]))
    await engine(fetchImpl).call(tool('get_antibody'), { antibody_id: 'AB_3643095' }, {})
    await engine(fetchImpl).call(tool('get_antibody'), { antibody_id: 'RRID:AB_3643095' }, {})
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.antibodyregistry.org/api/antibodies/3643095'
    )
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://www.antibodyregistry.org/api/antibodies/3643095'
    )
  })

  it('returns record_count 0 for a nonexistent id (upstream 200 + [])', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes([]))
    const out = (await engine(fetchImpl).call(
      tool('get_antibody'),
      { antibody_id: '1' },
      {}
    )) as Record<string, unknown>
    expect(out).toEqual({ ab_id: 1, rrid: 'AB_1', record_count: 0, records: [] })
  })

  it('rejects a malformed id without fetching', async () => {
    const fetchImpl = vi.fn()
    await expect(
      engine(fetchImpl).call(tool('get_antibody'), { antibody_id: 'not-an-id' }, {})
    ).rejects.toThrow(/not a valid antibody id/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('research_resources / find_antibodies_by_catalog', () => {
  it('keeps only exact catalog matches (via catalogNum or catAlt) and reports the search total', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        totalElements: 3,
        items: [
          abRecord({ abId: 1, catalogNum: 'ab32572', catAlt: '' }),
          abRecord({ abId: 2, catalogNum: 'OTHER-1', catAlt: 'foo; ab32572' }),
          abRecord({ abId: 3, catalogNum: 'unrelated', catAlt: '' })
        ]
      })
    )
    const out = (await engine(fetchImpl).call(
      tool('find_antibodies_by_catalog'),
      { catalog_number: 'AB32572' },
      {}
    )) as Record<string, unknown>
    expect(out.catalog_num).toBe('AB32572')
    expect(out.match_count).toBe(2)
    expect(out.search_total_elements).toBe(3)
    expect((out.matches as Record<string, unknown>[]).map((m) => m.abId)).toEqual([1, 2])
  })

  it('applies an exact case-insensitive vendor filter', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        totalElements: 2,
        items: [
          abRecord({ abId: 1, catalogNum: 'ab32572', vendorName: 'Abcam' }),
          abRecord({ abId: 2, catalogNum: 'ab32572', vendorName: 'Novus' })
        ]
      })
    )
    const out = (await engine(fetchImpl).call(
      tool('find_antibodies_by_catalog'),
      { catalog_number: 'ab32572', vendor: 'abcam' },
      {}
    )) as Record<string, unknown>
    expect(out.match_count).toBe(1)
    expect((out.matches as Record<string, unknown>[])[0].abId).toBe(1)
  })

  it('rejects an empty catalog number', async () => {
    const fetchImpl = vi.fn()
    await expect(
      engine(fetchImpl).call(tool('find_antibodies_by_catalog'), { catalog_number: '  ' }, {})
    ).rejects.toThrow(/catalog_number must be non-empty/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('research_resources / get_antibody_registry_stats', () => {
  it('returns the datainfo payload verbatim', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ total: 3186453, lastupdate: '2026-07-14' }))
    const out = await engine(fetchImpl).call(tool('get_antibody_registry_stats'), {}, {})
    expect(fetchImpl.mock.calls[0][0]).toBe('https://www.antibodyregistry.org/api/datainfo')
    expect(out).toEqual({ total: 3186453, lastupdate: '2026-07-14' })
  })
})
