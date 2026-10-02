import { describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { MONARCH_TOOLS } from './monarch'

const disease = MONARCH_TOOLS[0]
const gene = MONARCH_TOOLS[1]
// Reduced production v3 expanded association, observed 2026-10-02.
const row = {
  id: 'uuid:8962fd3c-a73c-11f1-baa1-70a8a519a557',
  subject: 'MONDO:0007947',
  subject_label: 'Marfan syndrome',
  object: 'HP:0032934',
  object_label: 'Spontaneous cerebrospinal fluid leak',
  category: 'biolink:DiseaseToPhenotypicFeatureAssociation',
  predicate: 'biolink:has_phenotype',
  original_predicate: null,
  agent_type: 'manual_agent',
  knowledge_level: 'knowledge_assertion',
  primary_knowledge_source: 'infores:omim',
  aggregator_knowledge_source: ['infores:monarchinitiative', 'infores:hpo-annotations'],
  provided_by: 'hpoa_disease_to_phenotype_edges',
  provided_by_link: {
    id: 'hpoa_disease_to_phenotype',
    url: 'https://monarch-app.monarchinitiative.org/Sources/hpoa/'
  },
  publications: ['PMID:8530937'],
  publications_links: [{ id: 'PMID:8530937', url: 'http://identifiers.org/pubmed/8530937' }],
  has_evidence: ['ECO:0006017'],
  has_evidence_links: [{ id: 'ECO:0006017', url: 'http://purl.obolibrary.org/obo/ECO_0006017' }],
  evidence_count: 2,
  negated: false,
  frequency_qualifier: 'HP:0040284',
  onset_qualifier: 'HP:0011462',
  original_subject: 'OMIM:154700'
}
const page = (items: unknown[] = [row], total = items.length): Record<string, unknown> => ({
  limit: 20,
  offset: 0,
  total,
  items
})
const args = { disease_id: 'MONDO:0007947' }
const run = (raw: unknown, input = args): Promise<unknown> => {
  const fetchImpl = vi.fn().mockResolvedValue(Response.json(raw))
  return new ParserEngine({ fetchImpl, retries: 0 }).call(disease, input, {})
}

describe('Monarch phenotype evidence', () => {
  it('requests expanded direct disease evidence with no credentials', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(page()))
    const result = await new ParserEngine({ fetchImpl, retries: 0 }).call(disease, args, {})
    const url = new URL(fetchImpl.mock.calls[0][0])
    expect(url.origin + url.pathname).toBe('https://api.monarchinitiative.org/v3/api/association')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      category: row.category,
      subject: args.disease_id,
      direct: 'true',
      compact: 'false',
      format: 'json',
      limit: '20',
      offset: '0'
    })
    expect(result).toMatchObject({ total: 1, returned: 1, next_offset: null, associations: [row] })
  })

  it('uses the gene category and maps filters without broadening the query', () => {
    const url = new URL(
      gene.url!({
        gene_id: 'HGNC:3603',
        phenotype_id: 'HP:0002107',
        primary_knowledge_source: 'infores:hpo-annotations',
        direct: false,
        limit: 10,
        offset: 20
      })
    )
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      category: 'biolink:GeneToPhenotypicFeatureAssociation',
      subject: 'HGNC:3603',
      object: 'HP:0002107',
      primary_knowledge_source: 'infores:hpo-annotations',
      direct: 'false',
      limit: '10',
      offset: '20',
      compact: 'false'
    })
  })

  it('retains inferred knowledge, null evidence, zero frequency and disease context', () => {
    const inferred = {
      ...row,
      category: 'biolink:GeneToPhenotypicFeatureAssociation',
      subject: 'HGNC:3603',
      agent_type: 'automated_agent',
      knowledge_level: 'logical_entailment',
      has_evidence: null,
      negated: null,
      has_count: 0,
      has_total: 53,
      has_percentage: 0,
      disease_context_qualifier: 'OMIM:154700',
      supporting_text: ['Source statement']
    }
    expect(gene.parse!(page([inferred]), { gene_id: 'HGNC:3603' })).toMatchObject({
      associations: [inferred]
    })
  })

  it('preserves negated and duplicate evidence records and removes only closure metadata', async () => {
    const negated = { ...row, negated: true, subject_closure: ['MONDO:0000001'] }
    expect(await run(page([row, negated]))).toMatchObject({
      returned: 2,
      associations: [row, { ...row, negated: true }]
    })
    const result = disease.parse!(page([negated]), args) as { associations: object[] }
    expect(result.associations[0]).not.toHaveProperty('subject_closure')
  })

  it('reports the next offset based on returned rows without automatic fan-out', async () => {
    expect(await run(page([row], 138))).toMatchObject({ next_offset: 1, total: 138, returned: 1 })
    expect(await run(page([], 0))).toMatchObject({ associations: [], total: 0, next_offset: null })
    expect(
      disease.parse!({ limit: 20, offset: 200, total: 138, items: [] }, { ...args, offset: 200 })
    ).toMatchObject({ next_offset: null, returned: 0 })
  })

  describe.each([
    { tool: disease, input: args, sourceId: 'OMIM:154700' },
    { tool: gene, input: { gene_id: 'HGNC:3603' }, sourceId: 'NCBIGene:2200' }
  ])('$tool.id pagination and identifier boundaries', ({ tool, input, sourceId }) => {
    const matchingRow = {
      ...row,
      subject: tool === disease ? args.disease_id : 'HGNC:3603',
      category: tool === disease ? row.category : 'biolink:GeneToPhenotypicFeatureAssociation'
    }

    it('rejects a continuation beyond the supported offset instead of returning an unusable next page', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(
          Response.json({ limit: 1, offset: 1000000, total: 1000002, items: [matchingRow] })
        )
      await expect(
        new ParserEngine({ fetchImpl, retries: 0 }).call(
          tool,
          { ...input, limit: 1, offset: 1000000 },
          {}
        )
      ).rejects.toThrow(
        'Monarch pagination exceeds the supported offset limit; narrow the query filters.'
      )
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('allows continuation to the exact offset limit and a final page at that limit', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ limit: 1, offset: 999999, total: 1000001, items: [matchingRow] })
        )
        .mockResolvedValueOnce(
          Response.json({ limit: 1, offset: 1000000, total: 1000001, items: [matchingRow] })
        )
      const engine = new ParserEngine({ fetchImpl, retries: 0 })
      const first = (await engine.call(tool, { ...input, limit: 1, offset: 999999 }, {})) as {
        next_offset: number
      }
      expect(first.next_offset).toBe(1000000)
      const last = await engine.call(tool, { ...input, limit: 1, offset: first.next_offset }, {})
      expect(last).toMatchObject({ returned: 1, next_offset: null, associations: [matchingRow] })
      expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get('offset')).toBe('1000000')
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    })

    it.each([0, 5])(
      'rejects an empty page before the reported end at offset %s',
      async (offset) => {
        const fetchImpl = vi.fn().mockResolvedValue(Response.json({ ...page([], 10), offset }))
        await expect(
          new ParserEngine({ fetchImpl, retries: 0 }).call(tool, { ...input, offset }, {})
        ).rejects.toThrow('Monarch response has inconsistent pagination')
        expect(fetchImpl).toHaveBeenCalledTimes(1)
      }
    )

    it.each([
      { offset: 0, total: 0 },
      { offset: 10, total: 10 },
      { offset: 20, total: 10 }
    ])('accepts an empty page at or beyond the end: %j', async ({ offset, total }) => {
      const fetchImpl = vi.fn().mockResolvedValue(Response.json({ ...page([], total), offset }))
      await expect(
        new ParserEngine({ fetchImpl, retries: 0 }).call(tool, { ...input, offset }, {})
      ).resolves.toMatchObject({ offset, total, returned: 0, next_offset: null, associations: [] })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('preserves source IDs and zero matches without resolving aliases or broadening the query', async () => {
      const field = tool.required![0]
      const fetchImpl = vi.fn().mockResolvedValue(Response.json(page([], 0)))
      const result = await new ParserEngine({ fetchImpl, retries: 0 }).call(
        tool,
        { [field]: sourceId },
        {}
      )
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      const url = new URL(fetchImpl.mock.calls[0][0])
      expect(url.searchParams.get('subject')).toBe(sourceId)
      expect(url.searchParams.get('direct')).toBe('true')
      expect(result).toMatchObject({
        query: { subject: sourceId, direct: true },
        total: 0,
        associations: [],
        next_offset: null
      })
    })
  })

  it.each([
    {},
    { items: [] },
    { ...page(), total: -1 },
    { ...page(), offset: 1 },
    { ...page(), items: null },
    page([null]),
    page([{ ...row, predicate: null }]),
    page([{ ...row, negated: 'false' }]),
    page([{ ...row, category: 'biolink:Association' }]),
    page([row], 0)
  ])('fails on malformed or inconsistent responses: %j', async (raw) => {
    await expect(run(raw)).rejects.toThrow()
  })

  it.each([
    { disease_id: 'Marfan syndrome' },
    { disease_id: 'MONDO:0007947&limit=500' },
    { disease_id: 'MONDO:0007947\n' },
    { disease_id: 'https://example.org' },
    { ...args, limit: 101 },
    { ...args, limit: 0 },
    { ...args, limit: 1.5 },
    { ...args, offset: -1 },
    { ...args, direct: 'false' },
    { ...args, phenotype_id: 'Seizure' }
  ])('rejects invalid input before fetching: %j', async (input) => {
    const fetchImpl = vi.fn()
    await expect(
      new ParserEngine({ fetchImpl, retries: 0 }).call(disease, input, {})
    ).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([404, 422, 429, 500])('surfaces HTTP %s instead of empty evidence', async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('upstream error', { status }))
    await expect(
      new ParserEngine({ fetchImpl, retries: 0 }).call(disease, args, {})
    ).rejects.toThrow(`HTTP ${status}`)
  })

  it('honors cancellation before issuing a request', async () => {
    const fetchImpl = vi.fn()
    const controller = new AbortController()
    controller.abort()
    await expect(
      new ParserEngine({ fetchImpl }).call(disease, args, {}, controller.signal)
    ).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
