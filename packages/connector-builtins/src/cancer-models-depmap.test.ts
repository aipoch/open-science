import { describe, expect, it, vi, type Mock } from 'vitest'
import { createConnectorRegistry, ParserEngine, type ToolDescriptor } from '@aipoch/connector-core'
import { CANCER_MODELS_TOOLS } from './cancer-models'
import { CONNECTOR_CATALOG } from './catalog'

const API = 'https://depmap.org/portal/breadbox'
const registry = createConnectorRegistry(CANCER_MODELS_TOOLS)
const geneId = 'ca558003-70f0-4949-8b2f-667bf30ac22a'
const drugId = '07b7bda9-ae00-43b3-bca1-336b9607f8f5'
const metadataId = '9034361b-d4c7-40f6-bf39-edd536c19616'
const a549 = 'ACH-000681'
const model2 = 'ACH-000001'
const model3 = 'ACH-000002'
const columns = ['CellLineName', 'OncotreeLineage', 'OncotreePrimaryDisease', 'CCLEName', 'RRID']
const catalog = [
  {
    id: geneId,
    given_id: 'Chronos_Combined',
    name: 'CRISPR (DepMap Public 26Q3+Score, Chronos)',
    format: 'matrix_dataset',
    units: 'Gene Effect (Chronos)',
    feature_type_name: 'gene',
    sample_type_name: 'depmap_model',
    dataset_metadata: {
      download_file_info: { release_name: 'DepMap Public 26Q3', file_name: 'CRISPRGeneEffect.csv' }
    }
  },
  {
    id: drugId,
    given_id: 'REPURPOSING_AUC_collapsed',
    name: 'PRISM Repurposing Secondary (AUC)',
    format: 'matrix_dataset',
    units: 'AUC',
    feature_type_name: 'compound_v2',
    sample_type_name: 'depmap_model',
    dataset_metadata: {
      download_file_info: {
        release_name: 'Harmonized PRISM Repurposing Secondary Screen 25Q2',
        file_name: 'REPURPOSINGAUCMatrix.csv'
      }
    }
  },
  {
    id: metadataId,
    given_id: 'depmap_model_metadata',
    name: 'depmap_model metadata',
    format: 'tabular_dataset',
    index_type_name: 'depmap_model',
    dataset_metadata: {
      download_file_info: { release_name: 'DepMap Public 26Q3', file_name: 'Model.csv' }
    }
  }
]
const drugMatch = { type_name: 'compound_v2', id: 'DPC-006587', label: 'TRAMETINIB' }
const modelMatch = { type_name: 'depmap_model', id: a549, label: 'A549' }
const descriptor = (id: string): ToolDescriptor => registry.getDescriptor('cancer-models', id)!
type Result = { records: Record<string, unknown>[]; model_metadata_dataset: unknown }
// Representative response fields from live Breadbox reads; tests use no network.
function setup(
  options: { catalog?: unknown; matrix?: unknown; search?: unknown; metadata?: unknown } = {}
): {
  call: (id: string, args: Record<string, unknown>) => Promise<Result>
  fetchImpl: Mock<typeof fetch>
  engine: ParserEngine
} {
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path === `${API}/datasets/`) return Response.json(options.catalog ?? catalog)
    if (path.includes('/datasets/dimensions/'))
      return Response.json(
        options.search ?? [path.includes('compound_v2') ? drugMatch : modelMatch]
      )
    if (path.includes('/datasets/matrix/'))
      return Response.json(
        options.matrix ??
          (path.endsWith(geneId)
            ? { KRAS: { [a549]: -1.3601659641 } }
            : { 'DPC-006587': { [a549]: 0.3948607098 } })
      )
    if (path === `${API}/datasets/tabular/${metadataId}`)
      return Response.json(
        options.metadata ??
          Object.fromEntries(
            columns.map((column) => [
              column,
              Object.fromEntries(
                body.indices.map((id: string) => [
                  id,
                  column === 'CellLineName' ? (id === a549 ? 'A549' : id) : null
                ])
              )
            ])
          )
      )
    throw new Error(`Unexpected request: ${path}`)
  })
  const engine = new ParserEngine({ fetchImpl, retries: 0 })
  const call = async (id: string, args: Record<string, unknown>): Promise<Result> => {
    const tool = descriptor(id)
    registry.validateToolArguments(tool, args)
    return engine.call(tool, args, {}) as Promise<Result>
  }
  return { call, fetchImpl, engine }
}

describe('DepMap in Cancer Models', () => {
  it('registers three valid examples in the existing facade without a new connector', () => {
    const tools = CANCER_MODELS_TOOLS.filter((t) => t.id.startsWith('depmap_'))
    expect(tools).toHaveLength(3)
    for (const tool of tools) {
      registry.validateToolArguments(tool, tool.exampleArgs!)
      expect(tool.credentialKeys).toEqual([])
      expect(tool.maxResponseBytes).toBe(1_000_000)
      expect(tool.totalTimeoutMs).toBe(25_000)
    }
    expect(CONNECTOR_CATALOG.find((c) => c.id === 'cancer-models')?.sources).toContain(
      'DepMap / CCLE'
    )
    expect(CONNECTOR_CATALOG.some((c) => c.id === 'depmap')).toBe(false)
  })

  it('finds A549 without collapsing similarly named models, and limits metadata at the server', async () => {
    const { call, fetchImpl } = setup({
      search: [modelMatch, { ...modelMatch, id: model2, label: 'A549CRAFKD' }]
    })
    const result = await call('depmap_search_models', { query: 'A549', limit: 1 })
    expect(result).toMatchObject({
      returned: 1,
      has_more: true,
      records: [{ model_id: a549, CellLineName: 'A549', RRID: null }]
    })
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      'substring=A549&type_name=depmap_model&limit=2'
    )
    expect(JSON.parse(String(fetchImpl.mock.calls[2][1]?.body))).toEqual({
      indices: [a549],
      identifier: 'id',
      columns
    })
  })

  it('looks up exact model IDs without substring search, preserving metadata provenance', async () => {
    const { call, fetchImpl } = setup()
    const result = await call('depmap_search_models', { query: a549 })
    expect(result.model_metadata_dataset).toMatchObject({
      id: metadataId,
      release: 'DepMap Public 26Q3',
      file: 'Model.csv'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['depmap_search_models', { query: 'missing' }, { search: [] }],
    ['depmap_search_models', { query: 'ACH-999999' }, { metadata: {} }],
    ['depmap_gene_dependency', { gene: 'MISSING' }, { matrix: {} }],
    ['depmap_drug_response', { compound: 'DPC-999999' }, { matrix: {} }]
  ])('returns empty data for an unmatched exact request: %s %j', async (id, args, options) => {
    const { call } = setup(options)
    expect(await call(id, args)).toMatchObject({ returned: 0, records: [] })
  })

  it('queries the resolved dataset UUID and preserves gene-effect units and selected model IDs', async () => {
    const { call, fetchImpl } = setup()
    const result = await call('depmap_gene_dependency', { gene: 'KRAS', model_ids: [a549, model2] })
    expect(result).toMatchObject({
      feature: 'KRAS',
      dataset: { id: geneId, units: 'Gene Effect (Chronos)', release: 'DepMap Public 26Q3' },
      total_models: 1,
      truncated: false,
      unavailable_model_ids: [model2],
      records: [{ model_id: a549, score: -1.3601659641 }]
    })
    expect(fetchImpl.mock.calls[1][0]).toBe(`${API}/datasets/matrix/${geneId}`)
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
      features: ['KRAS'],
      feature_identifier: 'label',
      samples: [a549, model2],
      sample_identifier: 'id'
    })
    expect(fetchImpl.mock.calls[1][1]?.headers).toMatchObject({
      'user-agent': 'connector-core/0.1.0'
    })
  })

  it('sorts scores ascending with nulls last, retaining zero and reporting truncation', async () => {
    const matrix = { KRAS: { [model2]: null, [model3]: 0, [a549]: -1.2 } }
    const { call, fetchImpl } = setup({ matrix })
    const result = await call('depmap_gene_dependency', { gene: 'KRAS', limit: 2 })
    expect(result).toMatchObject({
      total_models: 3,
      missing_values: 1,
      returned: 2,
      truncated: true,
      records: [
        { model_id: a549, score: -1.2 },
        { model_id: model3, score: 0 }
      ]
    })
    expect(JSON.parse(String(fetchImpl.mock.calls[2][1]?.body)).indices).toEqual([a549, model3])
    const complete = await call('depmap_gene_dependency', { gene: 'KRAS' })
    expect(complete.records[2]).toMatchObject({ model_id: model2, score: null })
  })

  it('resolves exact compound names case-insensitively and reports the separate PRISM release', async () => {
    const { call, fetchImpl } = setup()
    const result = await call('depmap_drug_response', { compound: 'trametinib', model_ids: [a549] })
    expect(result).toMatchObject({
      feature: 'DPC-006587',
      dataset: {
        id: drugId,
        units: 'AUC',
        release: 'Harmonized PRISM Repurposing Secondary Screen 25Q2'
      },
      model_metadata_dataset: { release: 'DepMap Public 26Q3' },
      records: [{ score: 0.3948607098 }]
    })
    expect(JSON.parse(String(fetchImpl.mock.calls[2][1]?.body))).toEqual({
      features: ['DPC-006587'],
      feature_identifier: 'id',
      samples: [a549],
      sample_identifier: 'id'
    })
  })

  it('preserves missing drug measurements instead of calling them resistant', async () => {
    const { call } = setup({ matrix: { 'DPC-006587': { [a549]: null, [model2]: 0 } } })
    expect(await call('depmap_drug_response', { compound: 'DPC-006587' })).toMatchObject({
      missing_values: 1,
      records: [{ score: 0 }, { score: null }]
    })
  })

  it.each([
    { search: [] },
    { search: [{ ...drugMatch, label: 'TRAMETINIB ANALOG' }] },
    { search: [drugMatch, { ...drugMatch, id: 'DPC-000001' }] },
    {
      search: [
        drugMatch,
        ...Array.from({ length: 49 }, (_, i) => ({
          ...drugMatch,
          id: `DPC-${String(i).padStart(6, '0')}`,
          label: `TRAMETINIB ANALOG ${i}`
        }))
      ]
    }
  ])('does not silently choose fuzzy or ambiguous drug matches', async ({ search }) => {
    const { call, fetchImpl } = setup({ search })
    await expect(call('depmap_drug_response', { compound: 'trametinib' })).rejects.toThrow(
      /unique exact match/
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['depmap_gene_dependency', {}],
    ['depmap_gene_dependency', { gene: 'KRAS', model_ids: [] }],
    ['depmap_gene_dependency', { gene: 'KRAS', model_ids: [a549, a549] }],
    ['depmap_gene_dependency', { gene: 'KRAS', model_ids: ['A549'] }],
    [
      'depmap_gene_dependency',
      {
        gene: 'KRAS',
        model_ids: Array.from({ length: 21 }, (_, i) => `ACH-${String(i).padStart(6, '0')}`)
      }
    ],
    ['depmap_gene_dependency', { gene: 'KRAS', limit: 51 }],
    ['depmap_gene_dependency', { gene: '../KRAS' }],
    ['depmap_gene_dependency', { gene: 'KRAS', url: 'https://example.org' }],
    ['depmap_drug_response', { compound: '' }],
    ['depmap_search_models', { query: 'a' }],
    ['depmap_search_models', { query: 'A549', limit: 21 }]
  ])('rejects invalid input before making requests: %s %j', async (id, args) => {
    const { call, fetchImpl } = setup()
    await expect(call(id, args)).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('also validates direct engine arguments before transport', async () => {
    const { engine, fetchImpl } = setup()
    await expect(
      engine.call(descriptor('depmap_gene_dependency'), { gene: 'KRAS', limit: 500 }, {})
    ).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    { matrix: { BRAF: { [a549]: -1 } } },
    { matrix: { KRAS: { A549: -1 } } },
    { matrix: { KRAS: { [a549]: '0.1' } } },
    { matrix: [] },
    { matrix: '<html>Verification</html>' },
    { catalog: [] },
    { catalog: [...catalog, catalog[0]] },
    { catalog: [{ ...catalog[0], units: 'probability' }, ...catalog.slice(1)] },
    { metadata: { CellLineName: { [a549]: 'A549' } } },
    { metadata: Object.fromEntries(columns.map((c) => [c, { [model2]: 'wrong model' }])) }
  ])('rejects malformed or inconsistent upstream data: %j', async (options) => {
    const { call } = setup(options)
    await expect(
      call('depmap_gene_dependency', { gene: 'KRAS', model_ids: [a549] })
    ).rejects.toThrow()
  })

  it('rejects an unrequested model in a score subset', async () => {
    const { call } = setup({ matrix: { KRAS: { [model2]: -1 } } })
    await expect(
      call('depmap_gene_dependency', { gene: 'KRAS', model_ids: [a549] })
    ).rejects.toThrow(/inconsistent scores/)
  })
  it('rejects out-of-range AUC values', async () => {
    const { call } = setup({ matrix: { 'DPC-006587': { [a549]: -0.1 } } })
    await expect(call('depmap_drug_response', { compound: 'DPC-006587' })).rejects.toThrow(
      /inconsistent scores/
    )
  })
  it.each([{ search: [drugMatch] }, { search: [modelMatch, modelMatch] }])(
    'rejects wrong-type and duplicate search identities',
    async ({ search }) => {
      const { call } = setup({ search })
      await expect(call('depmap_search_models', { query: 'A549' })).rejects.toThrow(
        /inconsistent search/
      )
    }
  )
  it('propagates transport errors, malformed HTML and oversized responses', async () => {
    const tool = descriptor('depmap_gene_dependency')
    for (const response of [
      new Response('unavailable', { status: 503 }),
      new Response('<html>Verification</html>'),
      new Response('x'.repeat(1_000_001))
    ]) {
      const engine = new ParserEngine({
        retries: 0,
        fetchImpl: vi.fn<typeof fetch>(async () => response)
      })
      await expect(engine.call(tool, { gene: 'KRAS' }, {})).rejects.toThrow()
    }
  })
  it('honors cancellation through the shared transport', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = vi.fn<typeof fetch>()
    const engine = new ParserEngine({ fetchImpl })
    await expect(
      engine.call(descriptor('depmap_gene_dependency'), { gene: 'KRAS' }, {}, controller.signal)
    ).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
