import { describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import type { ToolDescriptor } from '../types'
import { ZENODO_TOOLS } from './zenodo'

const getDescriptor = (method: string): ToolDescriptor =>
  ZENODO_TOOLS.find((tool) => tool.id === method)!

// Reduced public API response checked on 2026-09-21, including the legacy files array.
const record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 8435696,
  conceptrecid: '8435695',
  doi: '10.5281/zenodo.8435696',
  conceptdoi: '10.5281/zenodo.8435695',
  metadata: {
    title: 'PocketCoffea: a configuration layer for CMS analyses with Coffea',
    publication_date: '2023-10-10',
    description: '<p>A configuration layer for the analysis of CMS data.</p>',
    creators: [{ name: 'Matteo Marchegiani', affiliation: 'ETH Zurich' }],
    access_right: 'open',
    resource_type: { title: 'Presentation', type: 'presentation' },
    license: { id: 'cc-by-4.0' },
    communities: [{ id: 'pyhep2023' }]
  },
  files: [
    {
      key: 'PyHEP2023MatteoMarchegiani.zip',
      size: 11126180,
      checksum: 'md5:93f84ff4f6f4a60a0686792fb3046017',
      links: {
        self: 'https://zenodo.org/api/records/8435696/files/PyHEP2023MatteoMarchegiani.zip/content'
      }
    }
  ],
  ...overrides
})
const page = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  hits: { hits: [record()], total: 1 },
  links: { self: 'https://zenodo.org/api/records?page=1' },
  ...overrides
})
const mockCall = (
  payload: unknown,
  status = 200
): {
  fetchImpl: ReturnType<typeof vi.fn>
  call: (method: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
} => {
  const fetchImpl = vi
    .fn()
    .mockImplementation(async () => new Response(JSON.stringify(payload), { status }))
  const engine = new ParserEngine({ fetchImpl, retries: 0 })
  return {
    fetchImpl,
    call: (method, args) => {
      const descriptor = getDescriptor(method)!
      return engine.call(descriptor, args, {}) as Promise<Record<string, unknown>>
    }
  }
}

describe('Zenodo public records', () => {
  it('encodes query syntax once and fetches only the requested page', async () => {
    const { call, fetchImpl } = mockCall(
      page({
        hits: { hits: [record()], total: 42 },
        links: { next: 'https://zenodo.org/api/records?allversions=True&page=3&size=2' }
      })
    )
    const query = ' doi:"10.5281/zenodo.8435696" AND title:"a & b" '
    const result = await call('search_records', {
      query,
      page: 2,
      page_size: 2,
      sort: 'mostrecent',
      all_versions: true
    })
    const url = new URL(String(fetchImpl.mock.calls[0][0]))
    expect(url.origin + url.pathname).toBe('https://zenodo.org/api/records')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: query.trim(),
      page: '2',
      size: '2',
      sort: 'mostrecent',
      all_versions: 'true'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      page: 2,
      page_size: 2,
      count: 1,
      total: 42,
      total_relation: 'eq',
      next_page: 3,
      pagination_limited: false
    })
    expect((result.records as unknown[])[0]).toMatchObject({
      record_id: '8435696',
      concept_record_id: '8435695',
      doi: '10.5281/zenodo.8435696',
      concept_doi: '10.5281/zenodo.8435695'
    })
    expect((result.records as unknown[])[0]).not.toHaveProperty('files')
  })

  it('uses anonymous limits and does not mutate arguments or cache results', async () => {
    const { call, fetchImpl } = mockCall(page())
    const args = { query: 'climate' }
    await call('search_records', args)
    await call('search_records', args)
    expect(args).toEqual({ query: 'climate' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      'page=1&size=10&sort=bestmatch&all_versions=false'
    )
  })

  it('distinguishes empty results, lower-bound totals and the absence of a next link', async () => {
    expect(
      await mockCall(page({ hits: { hits: [], total: 0 } })).call('search_records', {
        query: 'missing'
      })
    ).toMatchObject({ records: [], count: 0, total: 0, next_page: null, pagination_limited: false })
    expect(
      await mockCall(
        page({ hits: { hits: [record()], total: { value: 10000, relation: 'gte' } } })
      ).call('search_records', { query: 'climate' })
    ).toMatchObject({ count: 1, total: 10000, total_relation: 'gte', next_page: null })
  })

  it('allows the final partial page when the page size does not divide the search window', async () => {
    const { call } = mockCall(page({ links: { next: 'https://zenodo.org/api/records?page=417' } }))
    await expect(
      call('search_records', { query: 'x', page: 416, page_size: 24 })
    ).resolves.toMatchObject({ next_page: 417, pagination_limited: false })
  })

  it.each([
    [10000, 1],
    [400, 25],
    [417, 24]
  ])(
    'stops before the search window is exceeded at page %i with size %i',
    async (current, size) => {
      const { call, fetchImpl } = mockCall(
        page({
          hits: { hits: [record()], total: 20000 },
          links: { next: `https://zenodo.org/api/records?page=${current + 1}` }
        })
      )
      await expect(
        call('search_records', { query: 'x', page: current, page_size: size })
      ).resolves.toMatchObject({
        count: 1,
        total: 20000,
        next_page: null,
        pagination_limited: true
      })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    [10001, 1],
    [401, 25],
    [418, 24],
    [1001, undefined]
  ])('rejects out-of-window requests before HTTP: page %i, size %s', async (current, size) => {
    const { call, fetchImpl } = mockCall(page())
    await expect(
      call('search_records', { query: 'x', page: current, page_size: size })
    ).rejects.toThrow('(page - 1) * page_size must be less than 10000')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    {},
    null,
    { hits: [] },
    page({ hits: { hits: [], total: -1 } }),
    page({ hits: { hits: [{}], total: 1 } }),
    page({ hits: { hits: [record()], total: 0 } }),
    page({ hits: { hits: [], total: { value: 10, relation: 'unknown' } } }),
    page({ links: undefined }),
    page({ hits: { hits: [record(), record()], total: 2 } })
  ])(
    'rejects malformed upstream search data rather than reporting no matches: %j',
    async (payload) => {
      await expect(
        mockCall(payload).call('search_records', { query: 'x', page_size: 1 })
      ).rejects.toThrow(/Invalid Zenodo/)
    }
  )

  it.each([
    'https://example.com/api/records?page=2',
    'https://zenodo.org/api/deposit?page=2',
    'https://zenodo.org/api/records?page=1',
    'https://zenodo.org/api/records?page=3',
    'https://zenodo.org/api/records?page=2junk'
  ])('rejects misleading pagination links: %s', async (next) => {
    const { call, fetchImpl } = mockCall(page({ links: { next } }))
    await expect(call('search_records', { query: 'x' })).rejects.toThrow(/pagination/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each(['8435696', '8435695'])(
    'preserves version identity when looking up %s',
    async (recordId) => {
      const { call, fetchImpl } = mockCall(record())
      const result = await call('get_record', { record_id: recordId })
      expect(fetchImpl.mock.calls[0][0]).toBe(`https://zenodo.org/api/records/${recordId}`)
      expect(result).toMatchObject({
        requested_record_id: recordId,
        record: {
          record_id: '8435696',
          concept_record_id: '8435695',
          description_html: expect.stringContaining('<p>'),
          license: { id: 'cc-by-4.0' }
        },
        files: [
          {
            size_bytes: 11126180,
            checksum: 'md5:93f84ff4f6f4a60a0686792fb3046017',
            download_url: expect.stringContaining('/content')
          }
        ]
      })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it.each([undefined, []])(
    'keeps a missing inventory distinct from an empty one: %j',
    async (files) => {
      const result = await mockCall(
        record({ files, metadata: { title: 'Restricted deposit', access_right: 'restricted' } })
      ).call('get_record', { record_id: '8435696' })
      expect(result.files).toEqual(files ?? null)
      expect(result.record).toMatchObject({
        access_right: 'restricted',
        creators: null,
        license: null
      })
    }
  )

  it.each([
    { id: 99 },
    { id: 9007199254740992 },
    { metadata: {} },
    { files: {} },
    { files: [{ key: 'file', size: -1 }] },
    { files: [{}] }
  ])('rejects mismatched or malformed record metadata: %j', async (override) => {
    await expect(
      mockCall(record(override)).call('get_record', { record_id: '8435696' })
    ).rejects.toThrow(/Invalid Zenodo/)
  })

  it.each([400, 403, 404, 429, 503])('preserves HTTP %s failures', async (status) => {
    await expect(mockCall({}, status).call('get_record', { record_id: '8435696' })).rejects.toThrow(
      `HTTP ${status}`
    )
    await expect(mockCall({}, status).call('search_records', { query: 'x' })).rejects.toThrow(
      `HTTP ${status}`
    )
  })

  it('propagates cancellation and network failures', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network unavailable'))
    const engine = new ParserEngine({ fetchImpl, retries: 0 })
    const descriptor = getDescriptor('get_record')!
    await expect(
      engine.call(
        descriptor,
        { record_id: '8435696' },
        {},
        AbortSignal.abort(new Error('cancelled'))
      )
    ).rejects.toThrow('cancelled')
    expect(fetchImpl).not.toHaveBeenCalled()
    await expect(engine.call(descriptor, { record_id: '8435696' }, {})).rejects.toThrow(
      'network unavailable'
    )
  })
})

describe.skipIf(!process.env.LIVE_API)('Zenodo LIVE', () => {
  it('searches public records and resolves a concept ID without credentials', async () => {
    const engine = new ParserEngine({ retries: 0 })
    const search = (await engine.call(
      getDescriptor('search_records')!,
      { query: 'conceptrecid:8435695', page_size: 2 },
      {}
    )) as { records: { record_id: string; concept_record_id: string }[] }
    expect(search.records.length).toBeGreaterThan(0)
    expect(search.records.every((hit) => hit.concept_record_id === '8435695')).toBe(true)
    const detail = await engine.call(getDescriptor('get_record')!, { record_id: '8435695' }, {})
    expect(detail).toMatchObject({
      requested_record_id: '8435695',
      record: { record_id: expect.stringMatching(/^[1-9][0-9]*$/), concept_record_id: '8435695' },
      files: expect.any(Array)
    })
    const version = await engine.call(getDescriptor('get_record')!, { record_id: '8435696' }, {})
    expect(version).toMatchObject({
      requested_record_id: '8435696',
      record: { record_id: '8435696', concept_record_id: '8435695' }
    })
  }, 60000)
})
