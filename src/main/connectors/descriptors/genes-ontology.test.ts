import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { GENES_ONTOLOGY_TOOLS } from './genes-ontology'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const errRes = (status: number): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    headers: { get: () => null }
  }) as unknown as Response

const tool = (id: string): (typeof GENES_ONTOLOGY_TOOLS)[number] => {
  const t = GENES_ONTOLOGY_TOOLS.find((x) => x.id === id)
  if (!t) throw new Error(`no tool ${id}`)
  return t
}

const run = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>
): Promise<unknown> =>
  new ParserEngine({ fetchImpl: fetchImpl as unknown as typeof fetch, retries: 0 }).call(
    tool(id),
    args,
    {}
  )

// A representative OLS ontology object.
const efoOntology = {
  ontologyId: 'efo',
  status: 'LOADED',
  version: '3.90.0',
  numberOfTerms: 93395,
  numberOfProperties: 200,
  numberOfIndividuals: 10,
  config: {
    id: 'efo',
    title: 'Experimental Factor Ontology',
    version: '3.91.0',
    description: 'An ontology',
    preferredPrefix: 'EFO',
    namespace: 'efo'
  }
}

describe('list_ontologies', () => {
  it('fetches metadata for an ID list and reports unknown IDs in not_found', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/ontologies/efo')) return Promise.resolve(jsonRes(efoOntology))
      // Unknown ontology -> 404, which the engine surfaces as a throw.
      return Promise.resolve(errRes(404))
    })
    const out = (await run('list_ontologies', { ontology_ids: ['EFO', 'nope'] }, fetchImpl)) as {
      records: Array<Record<string, unknown>>
      not_found: string[]
    }
    // Id is lowercased before the request.
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/ontologies/efo')
    expect(out.records).toHaveLength(1)
    expect(out.records[0]).toEqual({
      ontology_id: 'efo',
      title: 'Experimental Factor Ontology',
      version: '3.91.0',
      status: 'LOADED',
      num_terms: 93395,
      num_properties: 200,
      num_individuals: 10,
      preferred_prefix: 'EFO',
      description: 'An ontology',
      namespace: 'efo'
    })
    expect(out.not_found).toEqual(['nope'])
  })

  it('pages the full catalogue via _links.next and count-verifies against totalElements', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('page=1') || url.includes('cursor')) {
        return Promise.resolve(
          jsonRes({
            _embedded: { ontologies: [{ ...efoOntology, ontologyId: 'b' }] },
            _links: {},
            page: { totalElements: 2 }
          })
        )
      }
      // First page returns a next link to page two.
      return Promise.resolve(
        jsonRes({
          _embedded: { ontologies: [{ ...efoOntology, ontologyId: 'a' }] },
          _links: { next: { href: 'https://www.ebi.ac.uk/ols4/api/ontologies?page=1' } },
          page: { totalElements: 2 }
        })
      )
    })
    const out = (await run('list_ontologies', {}, fetchImpl)) as {
      records: Array<Record<string, unknown>>
      total_elements: number
      complete: boolean
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(out.records.map((r) => r.ontology_id)).toEqual(['a', 'b'])
    expect(out.total_elements).toBe(2)
    expect(out.complete).toBe(true)
  })

  it('marks complete=false when fewer rows than totalElements are collected', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        _embedded: { ontologies: [efoOntology] },
        _links: {},
        page: { totalElements: 5 }
      })
    )
    const out = (await run('list_ontologies', {}, fetchImpl)) as { complete: boolean }
    expect(out.complete).toBe(false)
  })
})

describe('search_ontology_terms', () => {
  it('assembles q/ontology/exact/obsoletes/rows and maps rows with truncation', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        response: {
          numFound: 50,
          docs: [
            {
              iri: 'http://purl.obolibrary.org/obo/MONDO_0004979',
              label: 'asthma',
              short_form: 'MONDO_0004979',
              obo_id: 'MONDO:0004979',
              ontology_name: 'efo',
              description: ['A bronchial disease'],
              type: 'class'
            }
          ]
        }
      })
    )
    const out = (await run(
      'search_ontology_terms',
      { query: 'asthma', ontologies: ['EFO', 'MONDO'], exact: true, max_results: 1 },
      fetchImpl
    )) as {
      total_found: number
      n_returned: number
      truncated: boolean
      terms: Array<Record<string, unknown>>
    }
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('q=asthma')
    expect(url).toContain('ontology=efo,mondo')
    expect(url).toContain('exact=true')
    expect(url).toContain('obsoletes=false')
    expect(url).toContain('rows=1')
    expect(out.total_found).toBe(50)
    expect(out.n_returned).toBe(1)
    expect(out.truncated).toBe(true)
    expect(out.terms[0]).toEqual({
      curie: 'MONDO:0004979',
      iri: 'http://purl.obolibrary.org/obo/MONDO_0004979',
      label: 'asthma',
      short_form: 'MONDO_0004979',
      ontology: 'efo',
      description: 'A bronchial disease',
      type: 'class',
      is_defining_ontology: null
    })
  })

  it('omits the ontology param and returns empty terms with no docs', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ response: { numFound: 0, docs: [] } }))
    const out = (await run('search_ontology_terms', { query: 'zzz' }, fetchImpl)) as {
      terms: unknown[]
      truncated: boolean
    }
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain('ontology=')
    expect(out.terms).toEqual([])
    expect(out.truncated).toBe(false)
  })
})

describe('get_ontology_term', () => {
  const goTerm = {
    iri: 'http://purl.obolibrary.org/obo/GO_0006281',
    label: 'DNA repair',
    short_form: 'GO_0006281',
    obo_id: 'GO:0006281',
    ontology_name: 'go',
    description: ['The process of restoring DNA'],
    synonyms: ['DNA repair pathway'],
    is_obsolete: false,
    has_children: true
  }

  it('resolves a CURIE via obo_id and returns the term record (relation=None)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ _embedded: { terms: [goTerm] } }))
    const out = (await run(
      'get_ontology_term',
      { ontology: 'GO', term_id: 'GO:0006281' },
      fetchImpl
    )) as Record<string, unknown>
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('/ontologies/go/terms?obo_id=GO%3A0006281')
    expect(out).toEqual({
      curie: 'GO:0006281',
      iri: 'http://purl.obolibrary.org/obo/GO_0006281',
      label: 'DNA repair',
      ontology: 'go',
      short_form: 'GO_0006281',
      synonyms: ['DNA repair pathway'],
      description: 'The process of restoring DNA',
      is_obsolete: false,
      has_children: true
    })
  })

  it('resolves a short_form when the id has no colon and no scheme', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ _embedded: { terms: [goTerm] } }))
    await run('get_ontology_term', { ontology: 'go', term_id: 'GO_0006281' }, fetchImpl)
    expect(String(fetchImpl.mock.calls[0][0])).toContain('terms?short_form=GO_0006281')
  })

  it('throws not-found when resolution returns no term', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ _embedded: { terms: [] } }))
    await expect(
      run('get_ontology_term', { ontology: 'go', term_id: 'GO:9999999' }, fetchImpl)
    ).rejects.toThrow(/not found/)
  })

  it('with a relation: double-encodes the IRI, pages the set, count-verifies', async () => {
    const child = (id: string): Record<string, unknown> => ({
      iri: `http://purl.obolibrary.org/obo/${id}`,
      label: id,
      short_form: id,
      obo_id: id.replace('_', ':'),
      ontology_name: 'go',
      has_children: false
    })
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/terms?obo_id=')) {
        return Promise.resolve(jsonRes({ _embedded: { terms: [goTerm] } }))
      }
      if (url.includes('page=1')) {
        return Promise.resolve(
          jsonRes({
            _embedded: { terms: [child('GO_0000012')] },
            _links: {},
            page: { totalElements: 2 }
          })
        )
      }
      // First relation page carries a next link.
      return Promise.resolve(
        jsonRes({
          _embedded: { terms: [child('GO_0000724')] },
          _links: {
            next: {
              href: 'https://www.ebi.ac.uk/ols4/api/ontologies/go/terms/x/children?page=1'
            }
          },
          page: { totalElements: 2 }
        })
      )
    })
    const out = (await run(
      'get_ontology_term',
      { ontology: 'go', term_id: 'GO:0006281', relation: 'children' },
      fetchImpl
    )) as {
      root: string
      relation: string
      total_elements: number
      term_count: number
      terms: Array<Record<string, unknown>>
    }
    const relUrl = String(fetchImpl.mock.calls.find((c) => String(c[0]).includes('/children'))![0])
    // IRI is double-URL-encoded: ':' -> %253A, '/' -> %252F.
    expect(relUrl).toContain('http%253A%252F%252Fpurl.obolibrary.org%252Fobo%252FGO_0006281')
    expect(relUrl).toContain('/children?size=')
    expect(out.root).toBe('GO:0006281')
    expect(out.relation).toBe('children')
    expect(out.total_elements).toBe(2)
    expect(out.term_count).toBe(2)
    expect(out.terms.map((t) => t.curie)).toEqual(['GO:0000724', 'GO:0000012'])
    expect(out.terms[0]).toEqual({
      curie: 'GO:0000724',
      iri: 'http://purl.obolibrary.org/obo/GO_0000724',
      label: 'GO_0000724',
      short_form: 'GO_0000724',
      ontology: 'go',
      has_children: false
    })
  })

  it('include_parents fetches the parents relation set', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/terms?obo_id=')) {
        return Promise.resolve(jsonRes({ _embedded: { terms: [goTerm] } }))
      }
      return Promise.resolve(
        jsonRes({
          _embedded: {
            terms: [
              {
                iri: 'http://purl.obolibrary.org/obo/GO_0006259',
                label: 'DNA metabolic process',
                short_form: 'GO_0006259',
                obo_id: 'GO:0006259',
                ontology_name: 'go'
              }
            ]
          },
          _links: {},
          page: { totalElements: 1 }
        })
      )
    })
    const out = (await run(
      'get_ontology_term',
      { ontology: 'go', term_id: 'GO:0006281', include_parents: true },
      fetchImpl
    )) as { parents: Array<Record<string, unknown>> }
    const parUrl = String(fetchImpl.mock.calls.find((c) => String(c[0]).includes('/parents'))![0])
    expect(parUrl).toContain('/parents?size=')
    expect(out.parents).toHaveLength(1)
    expect(out.parents[0].curie).toBe('GO:0006259')
  })
})

describe('get_go_annotations', () => {
  const annotation = (goId: string, eco: string, aspect: string): Record<string, unknown> => ({
    id: `${goId}!`,
    geneProductId: 'UniProtKB:P04637',
    qualifier: 'enables',
    goId,
    goName: null,
    goEvidence: 'IDA',
    goAspect: aspect,
    evidenceCode: eco,
    reference: 'PMID:1',
    withFrom: [],
    taxonId: 9606,
    assignedBy: 'UniProt',
    date: '20210810',
    symbol: 'TP53'
  })

  it('strips prefix, maps preset evidence + aspect + taxon, pages all, count-verifies', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('page=1')) {
        return Promise.resolve(
          jsonRes({
            numberOfHits: 3,
            pageInfo: { resultsPerPage: 2, current: 1, total: 2 },
            results: [
              annotation('GO:0000976', 'ECO:0000314', 'molecular_function'),
              annotation('GO:0000976', 'ECO:0000314', 'molecular_function')
            ]
          })
        )
      }
      return Promise.resolve(
        jsonRes({
          numberOfHits: 3,
          pageInfo: { resultsPerPage: 2, current: 2, total: 2 },
          results: [annotation('GO:0003677', 'ECO:0000314', 'molecular_function')]
        })
      )
    })
    const out = (await run(
      'get_go_annotations',
      {
        uniprot_accession: 'UniProtKB:P04637',
        aspect: 'molecular_function',
        evidence: 'experimental_manual',
        taxon_id: 9606,
        max_records: 100
      },
      fetchImpl
    )) as {
      gene_product: string
      total_annotations: number
      n_records: number
      complete: boolean
      truncated: boolean
      distinct_go_ids: string[]
      records: Array<Record<string, unknown>>
    }
    const url0 = String(fetchImpl.mock.calls[0][0])
    expect(url0).toContain('geneProductId=P04637')
    expect(url0).toContain('aspect=molecular_function')
    // experimental_manual preset -> ECO:0000269 with descendant usage.
    expect(url0).toContain('evidenceCode=ECO%3A0000269')
    expect(url0).toContain('evidenceCodeUsage=descendants')
    expect(url0).toContain('taxonId=9606')
    expect(url0).toContain('limit=200')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(out.gene_product).toBe('P04637')
    expect(out.total_annotations).toBe(3)
    expect(out.n_records).toBe(3)
    expect(out.complete).toBe(true)
    expect(out.truncated).toBe(false)
    expect(out.distinct_go_ids).toEqual(['GO:0000976', 'GO:0003677'])
    expect(out.records[0]).toEqual({
      go_id: 'GO:0000976',
      go_aspect: 'molecular_function',
      qualifier: 'enables',
      go_evidence: 'IDA',
      eco_id: 'ECO:0000314',
      reference: 'PMID:1',
      assigned_by: 'UniProt',
      date: '20210810',
      taxon_id: 9606,
      symbol: 'TP53',
      with_from: []
    })
  })

  it('maps an explicit ECO code to an exact evidenceCode filter (no descendants)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ numberOfHits: 0, pageInfo: { total: 1 }, results: [] }))
    await run(
      'get_go_annotations',
      { uniprot_accession: 'P04637', evidence: 'ECO:0000314' },
      fetchImpl
    )
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('evidenceCode=ECO%3A0000314')
    expect(url).not.toContain('evidenceCodeUsage')
  })

  it('caps records at max_records but summarizes the full set (truncated)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        numberOfHits: 3,
        pageInfo: { resultsPerPage: 200, current: 1, total: 1 },
        results: [
          annotation('GO:1', 'ECO:0000314', 'biological_process'),
          annotation('GO:2', 'ECO:0000314', 'biological_process'),
          annotation('GO:3', 'ECO:0000314', 'biological_process')
        ]
      })
    )
    const out = (await run(
      'get_go_annotations',
      { uniprot_accession: 'P04637', max_records: 2 },
      fetchImpl
    )) as { n_records: number; truncated: boolean; complete: boolean; distinct_go_ids: string[] }
    expect(out.n_records).toBe(2)
    expect(out.truncated).toBe(true)
    expect(out.complete).toBe(true)
    // distinct ids computed across ALL 3 annotations, not just the 2 returned.
    expect(out.distinct_go_ids).toEqual(['GO:1', 'GO:2', 'GO:3'])
  })

  it('include_term_names hydrates go_name/aspect/obsolete via one batched lookup', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/ontology/go/terms/')) {
        return Promise.resolve(
          jsonRes({
            numberOfHits: 1,
            results: [
              {
                id: 'GO:0000976',
                name: 'DNA-binding transcription factor',
                aspect: 'molecular_function',
                isObsolete: false
              }
            ]
          })
        )
      }
      return Promise.resolve(
        jsonRes({
          numberOfHits: 1,
          pageInfo: { resultsPerPage: 200, current: 1, total: 1 },
          results: [annotation('GO:0000976', 'ECO:0000314', 'bad_aspect')]
        })
      )
    })
    const out = (await run(
      'get_go_annotations',
      { uniprot_accession: 'P04637', include_term_names: true },
      fetchImpl
    )) as { records: Array<Record<string, unknown>> }
    const lookupUrl = String(
      fetchImpl.mock.calls.find((c) => String(c[0]).includes('/ontology/go/terms/'))![0]
    )
    expect(lookupUrl).toContain('/ontology/go/terms/GO:0000976')
    expect(out.records[0].go_name).toBe('DNA-binding transcription factor')
    // Hydrated aspect overrides the annotation's raw aspect.
    expect(out.records[0].go_aspect).toBe('molecular_function')
    expect(out.records[0].go_obsolete).toBe(false)
  })

  it('returns zero records without throwing when there are no annotations', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        numberOfHits: 0,
        pageInfo: { resultsPerPage: 200, current: 1, total: 1 },
        results: []
      })
    )
    const out = (await run('get_go_annotations', { uniprot_accession: 'P99999' }, fetchImpl)) as {
      total_annotations: number
      n_records: number
      complete: boolean
      distinct_go_ids: string[]
    }
    expect(out.total_annotations).toBe(0)
    expect(out.n_records).toBe(0)
    expect(out.complete).toBe(true)
    expect(out.distinct_go_ids).toEqual([])
  })
})
