import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { CELLGUIDE_TOOLS } from './cellguide'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => CELLGUIDE_TOOLS.find((t) => t.id === id)!

const SNAPSHOT = '1763135102'
const METADATA = {
  'CL:0000622': {
    name: 'acinar cell',
    id: 'CL:0000622',
    clDescription: 'A secretory cell that ... releases zymogen granules.',
    synonyms: ['acinic cell', 'acinous cell']
  },
  'CL:0000084': {
    name: 'T cell',
    id: 'CL:0000084',
    clDescription: 'A type of lymphocyte.',
    synonyms: ['T-cell', 'T lymphocyte']
  }
}
// Live shape confirmed against the CDN (2026-07-14): {tissue, symbol, name, publication,
// publication_titles} — no score field (canonical markers are literature-curated).
const CANONICAL_MARKERS = [
  {
    tissue: 'pancreas',
    symbol: 'PRSS1',
    name: 'trypsinogen',
    publication: '',
    publication_titles: ''
  },
  {
    tissue: 'pancreas',
    symbol: 'CPA1',
    name: 'carboxypeptidase A1',
    publication: 'PMID:12345',
    publication_titles: 'Some paper title'
  }
]
// Live shape confirmed against the CDN (2026-07-14): {me, pc, marker_score, specificity,
// gene_ontology_term_id, symbol, name, groupby_dims}.
const COMPUTATIONAL_MARKERS = [
  {
    me: 3.12,
    pc: 0.84,
    marker_score: 1.92,
    specificity: 0.99,
    gene_ontology_term_id: 'ENSMUSG00000071553',
    symbol: 'Cpa2',
    name: 'carboxypeptidase A2, pancreatic',
    groupby_dims: { organism_ontology_term_label: 'Mus musculus' }
  },
  {
    me: 4.62,
    pc: 0.91,
    marker_score: 2.72,
    specificity: 1.0,
    gene_ontology_term_id: 'ENSMUSG00000042179',
    symbol: 'Pnliprp1',
    name: 'pancreatic lipase related protein 1',
    groupby_dims: { organism_ontology_term_label: 'Mus musculus' }
  }
]
// Live shape confirmed against the CDN (2026-07-14).
const SOURCE_COLLECTIONS = [
  {
    collection_name: 'Human Pancreas Aging',
    collection_url: 'https://cellxgene.cziscience.com/collections/aaa',
    publication_url: '10.1016/j.cell.2017.09.004',
    publication_title: 'Enge et al. (2017) Cell',
    tissue: [{ label: 'pancreas', ontology_term_id: 'UBERON:0001264' }],
    disease: [{ label: 'normal', ontology_term_id: 'PATO:0000461' }],
    organism: [{ label: 'Homo sapiens', ontology_term_id: 'NCBITaxon:9606' }]
  },
  {
    collection_name: 'Muraro Pancreas',
    collection_url: 'https://cellxgene.cziscience.com/collections/bbb',
    publication_url: '',
    publication_title: '',
    tissue: [
      { label: 'pancreas', ontology_term_id: 'UBERON:0001264' },
      { label: 'blood', ontology_term_id: 'UBERON:0000178' }
    ],
    disease: [],
    organism: [{ label: 'Homo sapiens', ontology_term_id: 'NCBITaxon:9606' }]
  }
]

// Maps a URL substring to a canned response; throws for anything unexpected so tests can assert
// exactly which calls were made (e.g. "not found" must short-circuit before description/markers).
function mockFetch(
  responses: Record<string, { text?: string; json?: unknown; status?: number }>
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const key = Object.keys(responses).find((k) => url.includes(k))
    if (!key) throw new Error(`unexpected fetch: ${url}`)
    const r = responses[key]
    const status = r.status ?? 200
    return {
      ok: status < 400,
      status,
      // Mirror real fetch: .json() on an empty body throws, matching the CDN's 200-with-empty-body
      // response for cell types with no curated/computed data.
      json: async () => {
        if ('json' in r) return r.json
        if (!r.text) throw new SyntaxError('Unexpected end of JSON input')
        return JSON.parse(r.text)
      },
      text: async () => r.text ?? ''
    } as Response
  }) as unknown as typeof fetch
}

const engine = (fetchImpl: typeof fetch): ParserEngine => new ParserEngine({ fetchImpl })

describe('cellguide / get_cell_type_info', () => {
  it('resolves a CL id to name, synonyms, ontology + curated description', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: METADATA },
      '/validated_descriptions/CL_0000622.json': {
        json: { description: 'Acinar cells secrete digestive enzymes.', references: ['PMID:123'] }
      }
    })
    const out = await engine(fetchImpl).call(
      tool('get_cell_type_info'),
      { cell_type: 'CL:0000622' },
      {}
    )
    expect(out).toEqual({
      id: 'CL:0000622',
      name: 'acinar cell',
      synonyms: ['acinic cell', 'acinous cell'],
      ontologyDescription: 'A secretory cell that ... releases zymogen granules.',
      description: 'Acinar cells secrete digestive enzymes.',
      descriptionSource: 'validated',
      references: ['PMID:123']
    })
  })

  it('resolves a free-text name/synonym to its CL id', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: METADATA },
      '/validated_descriptions/CL_0000622.json': { json: { description: 'x', references: [] } }
    })
    const out = (await engine(fetchImpl).call(
      tool('get_cell_type_info'),
      { cell_type: 'acinous cell' },
      {}
    )) as { id: string; name: string }
    expect(out.id).toBe('CL:0000622')
    expect(out.name).toBe('acinar cell')
  })

  it('falls back to the GPT description when no validated description exists', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: METADATA },
      '/validated_descriptions/CL_0000622.json': { status: 404 },
      '/gpt_descriptions/CL_0000622.json': { json: 'A GPT-generated description.' }
    })
    const out = (await engine(fetchImpl).call(
      tool('get_cell_type_info'),
      { cell_type: 'CL:0000622' },
      {}
    )) as { description: string; descriptionSource: string }
    expect(out.description).toBe('A GPT-generated description.')
    expect(out.descriptionSource).toBe('gpt')
  })

  it('returns an error and skips the description fetch when the cell type is unknown', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: METADATA }
    })
    const out = await engine(fetchImpl).call(
      tool('get_cell_type_info'),
      { cell_type: 'CL:9999999' },
      {}
    )
    expect(out).toEqual({ error: "Cell type 'CL:9999999' not found" })
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2)
  })
})

describe('cellguide / search_cell_types', () => {
  it('filters metadata by name/synonym substring and caps at limit', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: METADATA }
    })
    const out = (await engine(fetchImpl).call(
      tool('search_cell_types'),
      { query: 'T cell', limit: 10 },
      {}
    )) as { result: Array<{ id: string; name: string; ontology_description: string }> }
    expect(out.result).toEqual([
      {
        id: 'CL:0000084',
        name: 'T cell',
        synonyms: ['T-cell', 'T lymphocyte'],
        ontology_description: 'A type of lymphocyte.'
      }
    ])
  })

  it('matches synonyms case-insensitively', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: METADATA }
    })
    const out = (await engine(fetchImpl).call(
      tool('search_cell_types'),
      { query: 'ACINIC' },
      {}
    )) as {
      result: Array<{ id: string }>
    }
    expect(out.result.map((r) => r.id)).toEqual(['CL:0000622'])
  })

  it('respects the limit', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: METADATA }
    })
    const out = (await engine(fetchImpl).call(
      tool('search_cell_types'),
      { query: 'cell', limit: 1 },
      {}
    )) as { result: unknown[] }
    expect(out.result).toHaveLength(1)
  })
})

describe('cellguide / get_marker_genes', () => {
  it('returns canonical markers with the literature-curated shape', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: METADATA },
      '/canonical_marker_genes/CL_0000622.json': { json: CANONICAL_MARKERS }
    })
    const out = (await engine(fetchImpl).call(
      tool('get_marker_genes'),
      { cell_type: 'CL:0000622', marker_type: 'canonical' },
      {}
    )) as { markerType: string; returned: number; markerGenes: unknown[] }
    expect(out.markerType).toBe('canonical')
    expect(out.returned).toBe(2)
    expect(out.markerGenes[0]).toEqual({
      symbol: 'PRSS1',
      name: 'trypsinogen',
      tissue: 'pancreas',
      publication: undefined,
      publicationTitle: undefined
    })
  })

  it('defaults to computational markers, sorted by marker_score desc and capped at limit', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: METADATA },
      '/computational_marker_genes/CL_0000622.json': { json: COMPUTATIONAL_MARKERS }
    })
    const out = (await engine(fetchImpl).call(
      tool('get_marker_genes'),
      { cell_type: 'CL:0000622', limit: 1 },
      {}
    )) as { markerType: string; returned: number; markerGenes: Array<Record<string, unknown>> }
    expect(out.markerType).toBe('computational')
    expect(out.returned).toBe(1)
    // Pnliprp1 has the higher marker_score (2.72), so it sorts first.
    expect(out.markerGenes[0]).toEqual({
      symbol: 'Pnliprp1',
      name: 'pancreatic lipase related protein 1',
      geneId: 'ENSMUSG00000042179',
      markerScore: 2.72,
      specificity: 1.0,
      meanExpression: 4.62,
      percentExpressing: 0.91,
      groupbyDims: { organism_ontology_term_label: 'Mus musculus' }
    })
  })

  it('returns an empty marker list on a 200 with an empty body', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: METADATA },
      '/computational_marker_genes/CL_0000622.json': { text: '' }
    })
    const out = (await engine(fetchImpl).call(
      tool('get_marker_genes'),
      { cell_type: 'CL:0000622' },
      {}
    )) as { markerGenes: unknown[]; returned: number }
    expect(out.markerGenes).toEqual([])
    expect(out.returned).toBe(0)
  })

  it('errors when the cell type is unknown', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: METADATA }
    })
    const out = await engine(fetchImpl).call(tool('get_marker_genes'), { cell_type: 'nope' }, {})
    expect(out).toEqual({ error: "Cell type 'nope' not found" })
  })
})

describe('cellguide / get_source_data', () => {
  it('returns source collections with tissues/diseases/organisms', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: METADATA },
      '/source_collections/CL_0000622.json': { json: SOURCE_COLLECTIONS }
    })
    const out = (await engine(fetchImpl).call(
      tool('get_source_data'),
      { cell_type: 'acinar cell' },
      {}
    )) as { id: string; count: number; sources: Array<Record<string, unknown>> }
    expect(out.id).toBe('CL:0000622')
    expect(out.count).toBe(2)
    expect(out.sources[0]).toEqual({
      collectionName: 'Human Pancreas Aging',
      collectionUrl: 'https://cellxgene.cziscience.com/collections/aaa',
      publicationUrl: '10.1016/j.cell.2017.09.004',
      publicationTitle: 'Enge et al. (2017) Cell',
      tissues: [{ id: 'UBERON:0001264', label: 'pancreas' }],
      diseases: [{ id: 'PATO:0000461', label: 'normal' }],
      organisms: [{ id: 'NCBITaxon:9606', label: 'Homo sapiens' }]
    })
    // Blank publication fields collapse to undefined.
    expect(out.sources[1].publicationUrl).toBeUndefined()
  })

  it('returns an empty source list on an empty body', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: METADATA },
      '/source_collections/CL_0000622.json': { text: '' }
    })
    const out = (await engine(fetchImpl).call(
      tool('get_source_data'),
      { cell_type: 'CL:0000622' },
      {}
    )) as { sources: unknown[]; count: number }
    expect(out.sources).toEqual([])
    expect(out.count).toBe(0)
  })
})

describe('cellguide / get_cell_tissues', () => {
  it('aggregates and dedupes tissues across source collections, sorted by label', async () => {
    const fetchImpl = mockFetch({
      latest_snapshot_identifier: { text: SNAPSHOT },
      '/celltype_metadata.json': { json: METADATA },
      '/source_collections/CL_0000622.json': { json: SOURCE_COLLECTIONS }
    })
    const out = (await engine(fetchImpl).call(
      tool('get_cell_tissues'),
      { cell_type: 'CL:0000622' },
      {}
    )) as { count: number; tissues: Array<{ id: string; label: string }> }
    // pancreas appears in both collections but is deduped; blood is unique. Sorted by label.
    expect(out.count).toBe(2)
    expect(out.tissues).toEqual([
      { id: 'UBERON:0000178', label: 'blood' },
      { id: 'UBERON:0001264', label: 'pancreas' }
    ])
  })
})

// Live CDN integration tests — opt-in via LIVE_API=1 so CI stays offline.
const live = process.env.LIVE_API ? describe : describe.skip
live('cellguide / LIVE CDN', () => {
  const call = (id: string, args: Record<string, unknown>): Promise<unknown> =>
    new ParserEngine().call(tool(id), args, {})

  it('get_cell_type_info resolves both a CL id and a name', async () => {
    const byId = (await call('get_cell_type_info', { cell_type: 'CL:0000622' })) as {
      id: string
      name: string
    }
    expect(byId.id).toBe('CL:0000622')
    expect(byId.name).toBe('acinar cell')
    const byName = (await call('get_cell_type_info', { cell_type: 'acinar cell' })) as {
      id: string
    }
    expect(byName.id).toBe('CL:0000622')
  }, 30_000)

  it('search_cell_types finds T cell', async () => {
    const out = (await call('search_cell_types', { query: 'T cell', limit: 5 })) as {
      result: Array<{ id: string; name: string }>
    }
    expect(out.result.length).toBeGreaterThan(0)
    expect(out.result.some((r) => r.name.toLowerCase().includes('t cell'))).toBe(true)
  }, 30_000)

  it('get_marker_genes returns computational markers with scores', async () => {
    const out = (await call('get_marker_genes', {
      cell_type: 'CL:0000622',
      marker_type: 'computational',
      limit: 5
    })) as { markerGenes: Array<{ symbol: string; markerScore: number }> }
    expect(out.markerGenes.length).toBeGreaterThan(0)
    expect(typeof out.markerGenes[0].symbol).toBe('string')
    expect(typeof out.markerGenes[0].markerScore).toBe('number')
  }, 30_000)

  it('get_marker_genes returns canonical markers for a cell type that has them', async () => {
    const out = (await call('get_marker_genes', {
      cell_type: 'CL:0000084',
      marker_type: 'canonical',
      limit: 5
    })) as { markerGenes: Array<{ symbol: string }> }
    expect(out.markerGenes.length).toBeGreaterThan(0)
    expect(typeof out.markerGenes[0].symbol).toBe('string')
  }, 30_000)

  it('get_source_data returns collections with publications', async () => {
    const out = (await call('get_source_data', { cell_type: 'CL:0000622' })) as {
      count: number
      sources: Array<{ collectionName: string }>
    }
    expect(out.count).toBeGreaterThan(0)
    expect(typeof out.sources[0].collectionName).toBe('string')
  }, 30_000)

  it('get_cell_tissues returns anatomical tissues', async () => {
    const out = (await call('get_cell_tissues', { cell_type: 'T cell' })) as {
      count: number
      tissues: Array<{ id: string; label: string }>
    }
    expect(out.count).toBeGreaterThan(0)
    expect(out.tissues.some((t) => (t.id ?? '').startsWith('UBERON:'))).toBe(true)
  }, 30_000)
})
