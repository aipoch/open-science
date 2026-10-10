import { describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import type { ToolDescriptor } from '../../connector-core/types'
import { CELLXGENE_DISCOVER_TOOLS } from './cellxgene-discover'

const C = '9a71db9e-687f-41f0-b88e-544eb1314ef6'
const CV = '46ac9732-ff1c-4f87-86d7-0488d15aecd3'
const D = '0bbf93aa-2d3a-420f-95a1-26fe384024cb'
const DV = '8e0fcb64-735c-4fcb-a74b-12a3518683d1'
const OLD = '11111111-2222-3333-4444-555555555555'
const API = 'https://api.cellxgene.cziscience.com/curation/v1'
const descriptor = (method: string): ToolDescriptor =>
  CELLXGENE_DISCOVER_TOOLS.find((tool) => tool.id === method)!
// Reduced fixtures from the public API, verified 2026-09-29. Assets identify versioned files.
type DatasetFixture = Record<string, unknown> & {
  assets: { filetype: string; filesize: number; url: string }[]
}
const dataset = (overrides: Record<string, unknown> = {}): DatasetFixture => ({
  dataset_id: D,
  dataset_version_id: DV,
  collection_id: C,
  collection_version_id: CV,
  title: 'Human liver cells',
  collection_name: 'An immunobiliary single-cell atlas',
  collection_doi: '10.1038/s41467-026-71537-2',
  cell_count: 32900,
  schema_version: '7.1.0',
  organism: [{ label: 'Homo sapiens', ontology_term_id: 'NCBITaxon:9606' }],
  tissue: [{ label: 'liver', ontology_term_id: 'UBERON:0002107' }],
  disease: [{ label: 'normal', ontology_term_id: 'PATO:0000461' }],
  assay: [{ label: "10x 3' v3", ontology_term_id: 'EFO:0009922' }],
  cell_type: [{ label: 'B cell', ontology_term_id: 'CL:0000236' }],
  citation: 'Publication and dataset version citation',
  published_at: '2026-09-25T16:20:58+00:00',
  revised_at: null,
  visibility: 'PUBLIC',
  tombstone: false,
  assets: [
    {
      filetype: 'H5AD',
      filesize: 335715225,
      url: `https://datasets.cellxgene.cziscience.com/${DV}.h5ad`
    }
  ],
  ...overrides
})
const collection = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  collection_id: C,
  collection_version_id: CV,
  name: 'Liver atlas',
  description: 'Immune cells in cholangitis',
  doi: '10.1038/s41467-026-71537-2',
  datasets: [dataset()],
  visibility: 'PUBLIC',
  ...overrides
})
function mock(
  payload: unknown,
  status = 200
): {
  fetchImpl: ReturnType<typeof vi.fn>
  call: (method: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>
} {
  const fetchImpl = vi
    .fn()
    .mockImplementation(async () => new Response(JSON.stringify(payload), { status }))
  const engine = new ParserEngine({ fetchImpl, retries: 0 })
  return {
    fetchImpl,
    call: async (method: string, args: Record<string, unknown> = {}) => {
      return (await engine.call(descriptor(method), args, {})) as Record<string, unknown>
    }
  }
}

describe('CELLxGENE Discover public metadata', () => {
  it('searches collection descriptions and DOI before bounded paging, without upstream search parameters', async () => {
    const { call, fetchImpl } = mock([
      collection(),
      collection({ collection_id: OLD }),
      collection({ description: 'Other', name: 'Retina', doi: 'other' })
    ])
    expect(
      await call('list_collections', { query: ' CHOLANGITIS ', page_size: 1, page: 2 })
    ).toMatchObject({
      total: 2,
      page: 2,
      page_size: 1,
      count: 1,
      next_page: null,
      pagination: 'client',
      results: [{ collection_id: OLD, collection_version_id: CV, dataset_count: 1 }]
    })
    expect(fetchImpl.mock.calls[0][0]).toBe(`${API}/collections?visibility=PUBLIC`)
    expect((await call('list_collections', { query: '10.1038' })).total).toBe(2)
    expect(await call('list_collections', { query: 'absent' })).toMatchObject({
      total: 0,
      results: [],
      next_page: null
    })
  })

  it('ANDs exact ontology ID/label filters with text and collection filters before paging', async () => {
    const { call, fetchImpl } = mock([
      dataset(),
      dataset({ dataset_id: OLD }),
      dataset({ tissue: null }),
      dataset({ organism: [{ label: 'Mus musculus', ontology_term_id: 'NCBITaxon:10090' }] })
    ])
    const args = {
      query: 'IMMUNOBILIARY',
      organism: 'ncbitaxon:9606',
      tissue: ' Liver ',
      disease: 'normal',
      assay: 'EFO:0009922',
      cell_type: 'b CELL',
      collection_id: C,
      schema_version: '7.1',
      page_size: 1
    }
    expect(await call('list_datasets', args)).toMatchObject({
      total: 2,
      count: 1,
      next_page: 2,
      results: [{ dataset_id: D, dataset_version_id: DV, collection_version_id: CV }]
    })
    expect(fetchImpl.mock.calls[0][0]).toBe(`${API}/datasets?visibility=PUBLIC&schema_version=7.1`)
    expect(await call('list_datasets', { ...args, page: 2 })).toMatchObject({
      total: 2,
      next_page: null,
      results: [{ dataset_id: OLD }]
    })
    expect(await call('list_datasets', { tissue: 'liv' })).toMatchObject({ total: 0 })
    expect(await call('list_datasets', { page: 100 })).toMatchObject({
      results: [],
      next_page: null,
      total: 4
    })
  })

  it.each([undefined, null, [], [{}]].map((tissue) => ({ tissue })))(
    'allows absent or empty ontology metadata: %j',
    async ({ tissue }) => {
      const { call } = mock([dataset({ tissue })])
      expect(await call('list_datasets', { tissue: 'liver' })).toMatchObject({
        total: 0,
        results: []
      })
    }
  )

  it.each(
    [
      { label: 'liver', ontology_term_id: 'UBERON:0002107' },
      'liver',
      [null],
      [{ label: 42 }],
      [{ ontology_term_id: ['UBERON:0002107'] }],
      [{ label: 'liver' }, { label: false }]
    ].map((tissue) => ({ tissue }))
  )(
    'rejects malformed ontology metadata rather than returning false matches: %j',
    async ({ tissue }) => {
      const { call } = mock([dataset({ tissue })])
      await expect(call('list_datasets', { tissue: 'liver' })).rejects.toThrow(
        'Invalid CELLxGENE Discover response'
      )
    }
  )

  it('retains a historical schema selection through version metadata and file retrieval', async () => {
    const historical = dataset({
      dataset_version_id: OLD,
      schema_version: '3.1.0',
      assets: [
        {
          filetype: 'H5AD',
          filesize: -1,
          url: `https://datasets.cellxgene.cziscience.com/${OLD}.h5ad`
        }
      ]
    })
    const { call, fetchImpl } = mock(null)
    fetchImpl.mockImplementation(async (input) => {
      const url = String(input)
      if (url === `${API}/datasets?visibility=PUBLIC&schema_version=3`) {
        return new Response(JSON.stringify([historical]))
      }
      if (url === `${API}/dataset_versions/${OLD}`) {
        return new Response(JSON.stringify(historical))
      }
      if (url === `${API}/collections/${C}/datasets/${D}`) {
        return new Response(JSON.stringify(dataset()))
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    const listing = await call('list_datasets', { schema_version: '3' })
    const selected = (listing.results as Record<string, unknown>[])[0]
    expect(selected).toMatchObject({
      dataset_id: D,
      dataset_version_id: OLD,
      schema_version: '3.1.0'
    })
    const versionArgs = { dataset_version_id: selected.dataset_version_id }
    expect(await call('get_dataset_version', versionArgs)).toMatchObject({
      dataset_version_id: OLD,
      schema_version: '3.1.0'
    })
    expect(await call('list_dataset_files', versionArgs)).toMatchObject({
      dataset_version_id: OLD,
      schema_version: '3.1.0',
      count: 1,
      files: historical.assets
    })
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      `${API}/datasets?visibility=PUBLIC&schema_version=3`,
      `${API}/dataset_versions/${OLD}`,
      `${API}/dataset_versions/${OLD}`
    ])
    expect(await call('list_dataset_files', { collection_id: C, dataset_id: D })).toMatchObject({
      dataset_version_id: DV,
      schema_version: '7.1.0',
      files: dataset().assets
    })
  })

  it.each([
    ['get_collection', { collection_id: C, page_size: 1 }, `/collections/${C}`, 'datasets'],
    [
      'get_collection_version',
      { collection_version_id: CV, page_size: 1 },
      `/collection_versions/${CV}`,
      'dataset_versions'
    ]
  ])(
    'pages nested datasets for %s while preserving collection metadata',
    async (method, args, path, field) => {
      const { call, fetchImpl } = mock(
        collection({ [field]: [dataset(), dataset({ dataset_id: OLD })] })
      )
      const result = await call(method as string, args as Record<string, unknown>)
      expect(result).toMatchObject({
        collection_id: C,
        collection_version_id: CV,
        description: 'Immune cells in cholangitis',
        [field as string]: {
          total: 2,
          count: 1,
          next_page: 2,
          results: [{ dataset_id: D, dataset_version_id: DV }]
        }
      })
      expect(fetchImpl.mock.calls[0][0]).toBe(`${API}${path}`)
    }
  )

  it.each([
    [
      'list_collection_versions',
      { collection_id: C, page_size: 1 },
      `/collections/${C}/versions`,
      [
        collection({ dataset_versions: [dataset()] }),
        collection({ collection_version_id: OLD, dataset_versions: [] })
      ]
    ],
    [
      'list_dataset_versions',
      { dataset_id: D, page_size: 1 },
      `/datasets/${D}/versions`,
      [dataset(), dataset({ dataset_version_id: OLD })]
    ]
  ])(
    'preserves upstream newest-first version order for %s',
    async (method, args, path, payload) => {
      const { call, fetchImpl } = mock(payload)
      expect(await call(method as string, args as Record<string, unknown>)).toMatchObject({
        total: 2,
        next_page: 2,
        count: 1
      })
      const second = await call(method as string, { ...(args as Record<string, unknown>), page: 2 })
      expect(second).toMatchObject({ total: 2, next_page: null, count: 1 })
      expect(JSON.stringify(second.results)).toContain(OLD)
      expect(fetchImpl.mock.calls[0][0]).toBe(`${API}${path}`)
    }
  )

  it.each([
    ['get_dataset', { collection_id: C, dataset_id: D }, `/collections/${C}/datasets/${D}`],
    ['get_dataset_version', { dataset_version_id: DV }, `/dataset_versions/${DV}`]
  ])('returns full metadata and nullable fields for %s', async (method, args, path) => {
    const { call, fetchImpl } = mock(dataset())
    expect(await call(method as string, args as Record<string, unknown>)).toEqual(dataset())
    expect(fetchImpl.mock.calls[0][0]).toBe(`${API}${path}`)
  })

  it.each([
    [{ dataset_version_id: DV }, `/dataset_versions/${DV}`],
    [{ collection_id: C, dataset_id: D }, `/collections/${C}/datasets/${D}`]
  ])(
    'lists all supplied asset formats and sizes with one metadata request: %j',
    async (args, path) => {
      const assets = ['H5AD', 'RDS', 'ATAC_FRAGMENT', 'ATAC_INDEX'].map((filetype, index) => ({
        filetype,
        filesize: index,
        url: `https://datasets.cellxgene.cziscience.com/file-${index}?download=1&signature=a%2Fb`
      }))
      const { call, fetchImpl } = mock(dataset({ assets, collection_id: undefined }))
      const result = await call('list_dataset_files', args)
      expect(result).toMatchObject({
        dataset_id: D,
        dataset_version_id: DV,
        schema_version: '7.1.0',
        citation: dataset().citation,
        count: 4,
        files: assets
      })
      if ('collection_id' in args) expect(result.collection_id).toBe(C)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(fetchImpl.mock.calls[0][0]).toBe(`${API}${path}`)
      expect(JSON.stringify(result)).not.toContain('checksum')
    }
  )

  it('preserves unknown file sizes without losing other assets or probing download URLs', async () => {
    const files = [
      ...dataset().assets,
      { filetype: 'RDS', filesize: -1, url: `https://datasets.cellxgene.cziscience.com/${DV}.rds` },
      {
        filetype: 'ATAC_INDEX',
        filesize: 0,
        url: `https://datasets.cellxgene.cziscience.com/${DV}.tbi`
      }
    ]
    const { call, fetchImpl } = mock(dataset({ assets: files }))
    expect(await call('list_dataset_files', { dataset_version_id: DV })).toMatchObject({
      count: 3,
      files
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe(`${API}/dataset_versions/${DV}`)
    expect(descriptor('list_dataset_files').returns).toContain('-1 when unknown')
  })

  it('distinguishes an empty inventory from a missing or malformed assets array', async () => {
    expect(
      await mock(dataset({ assets: [] })).call('list_dataset_files', { dataset_version_id: DV })
    ).toMatchObject({ count: 0, files: [] })
    for (const assets of [
      undefined,
      null,
      {},
      [null],
      [{ filetype: 'H5AD', url: 'https://example.com', filesize: -2 }],
      [{ filetype: 'H5AD', url: 'https://example.com', filesize: -0.5 }]
    ]) {
      await expect(
        mock(dataset({ assets })).call('list_dataset_files', { dataset_version_id: DV })
      ).rejects.toThrow('Invalid CELLxGENE Discover response')
    }
  })

  it.each([403, 404, 410, 429, 500])(
    'propagates HTTP %s instead of reporting no results or files',
    async (status) => {
      for (const [method, args] of [
        ['list_collections', {}],
        ['list_dataset_files', { dataset_version_id: DV }]
      ] as const) {
        await expect(mock({ detail: 'unavailable' }, status).call(method, args)).rejects.toThrow(
          `HTTP ${status}`
        )
      }
    }
  )

  it('rejects malformed successful catalog responses', async () => {
    for (const payload of [null, {}, { results: [] }, [null], [{}]]) {
      await expect(mock(payload).call('list_datasets')).rejects.toThrow(
        'Invalid CELLxGENE Discover response'
      )
    }
  })

  it('uses the existing cancellation contract', async () => {
    const fetchImpl = vi.fn()
    const signal = AbortSignal.abort(new Error('cancelled'))
    await expect(
      new ParserEngine({ fetchImpl }).call(descriptor('list_datasets'), {}, {}, signal)
    ).rejects.toThrow('cancelled')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
