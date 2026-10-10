import { describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import type { ToolDescriptor } from '../../connector-core/types'
import { ALLIANCE_TOOLS } from './alliance'

const jsonRes = (body: unknown): Response => Response.json(body)
const tool = (id: string): ToolDescriptor => {
  const descriptor = ALLIANCE_TOOLS.find((candidate) => candidate.id === id)
  if (!descriptor) throw new Error(`unknown Alliance tool ${id}`)
  return descriptor
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

// Reduced fixtures preserve the field nesting observed in the public Alliance API.
describe('Alliance of Genome Resources connector', () => {
  it('exposes the public model-organism tools in a stable order', () => {
    expect(ALLIANCE_TOOLS.map((candidate) => candidate.id)).toEqual([
      'alliance_get_gene',
      'alliance_search_genes',
      'alliance_get_gene_orthologs',
      'alliance_get_gene_disease_models',
      'alliance_get_gene_phenotypes',
      'alliance_get_gene_alleles',
      'alliance_get_gene_expression',
      'alliance_get_disease_genes'
    ])
    expect(ALLIANCE_TOOLS.every((candidate) => candidate.connector === 'alliance')).toBe(true)
  })

  it('normalizes a gene summary and nested genomic location without changing the query ID', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        gene: {
          primaryExternalId: 'MGI:97490',
          geneSymbol: { displayText: 'Pax6' },
          geneFullName: { displayText: 'paired box 6' },
          taxon: {
            name: 'Mus musculus',
            curie: 'NCBITaxon:10090',
            species: { genomeAssembly: { primaryExternalId: 'GRCm39' } }
          },
          geneSynonyms: [{ displayText: 'Sey' }],
          geneGenomicLocationAssociations: [
            {
              geneGenomicLocationAssociationObject: { name: '2' },
              start: 105499241,
              end: 105528755,
              strand: '+'
            }
          ]
        }
      })
    )
    const out = await run('alliance_get_gene', { gene_id: 'MGI:97490' }, fetchImpl)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://www.alliancegenome.org/api/gene/MGI%3A97490')
    expect(out).toMatchObject({
      query_gene_id: 'MGI:97490',
      gene: {
        id: 'MGI:97490',
        symbol: 'Pax6',
        name: 'paired box 6',
        species: 'Mus musculus',
        taxon_id: 'NCBITaxon:10090',
        synonyms: ['Sey'],
        genomic_location: {
          chromosome: '2',
          start: 105499241,
          end: 105528755,
          assembly: 'GRCm39',
          strand: '+'
        }
      }
    })
  })

  it.each([
    ['FBgn0003996', 'FB:FBgn0003996'],
    ['ZDB-GENE-990415-8', 'ZFIN:ZDB-GENE-990415-8'],
    ['WBGene00006763', 'WB:WBGene00006763']
  ])('normalizes bare gene ID %s', async (input, expected) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ gene: { primaryExternalId: expected } }))
    await expect(run('alliance_get_gene', { gene_id: input }, fetchImpl)).resolves.toMatchObject({
      query_gene_id: expected
    })
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `https://www.alliancegenome.org/api/gene/${encodeURIComponent(expected)}`
    )
  })

  it.each(
    ALLIANCE_TOOLS.filter((candidate) => candidate.required?.includes('gene_id')).map(
      (candidate) => candidate.id
    )
  )('%s rejects unqualified numeric gene IDs before any request', async (id) => {
    const fetchImpl = vi.fn()
    for (const geneId of ['0', '1234', '97490', ' 97490 ', '0012345']) {
      await expect(run(id, { gene_id: geneId }, fetchImpl)).rejects.toThrow(
        'gene_id must include a database prefix for numeric identifiers'
      )
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each(['MGI:97490', 'RGD:3258', 'HGNC:8620'])(
    'preserves the explicit database namespace in %s',
    async (geneId) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonRes({ gene: { primaryExternalId: geneId } }))
      await expect(run('alliance_get_gene', { gene_id: geneId }, fetchImpl)).resolves.toMatchObject(
        {
          query_gene_id: geneId,
          gene: { id: geneId }
        }
      )
      expect(fetchImpl.mock.calls[0][0]).toBe(
        `https://www.alliancegenome.org/api/gene/${encodeURIComponent(geneId)}`
      )
    }
  )

  it('uses the current gene search category and zero-based row offset', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        total: 22,
        results: [
          {
            category: 'gene_search_result',
            curie: 'MGI:97490',
            symbol: 'Pax6',
            name: 'paired box 6',
            species: 'Mus musculus'
          }
        ]
      })
    )
    const out = await run(
      'alliance_search_genes',
      { query: ' pax6 ', limit: 2, page: 2 },
      fetchImpl
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.alliancegenome.org/api/search?category=gene_search_result&q=pax6&limit=2&offset=2'
    )
    expect(out).toMatchObject({
      query: 'pax6',
      page: 2,
      limit: 2,
      total: 22,
      returned: 1,
      genes: [{ id: 'MGI:97490', symbol: 'Pax6', name: 'paired box 6', species: 'Mus musculus' }]
    })
  })

  it('accepts the zero-result search envelope without inventing rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ total: 0 }))
    await expect(
      run('alliance_search_genes', { query: 'no-such-gene' }, fetchImpl)
    ).resolves.toMatchObject({
      total: 0,
      returned: 0,
      genes: []
    })
  })

  it('retrieves orthologs with methods and requested stringency', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        total: 9,
        results: [
          {
            stringencyFilter: 'stringent',
            geneToGeneOrthologyGenerated: {
              objectGene: {
                primaryExternalId: 'Xenbase:XB-GENE-865046',
                geneSymbol: { displayText: 'pax6.L' },
                taxon: { name: 'Xenopus laevis' }
              },
              predictionMethodsMatched: [{ name: 'Xenbase' }]
            }
          }
        ]
      })
    )
    const out = await run(
      'alliance_get_gene_orthologs',
      { gene_id: 'HGNC:8620', limit: 1 },
      fetchImpl
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.alliancegenome.org/api/gene/HGNC%3A8620/orthologs?limit=1&page=1&filter.stringency=stringent'
    )
    expect(out).toMatchObject({
      total: 9,
      returned: 1,
      orthologs: [
        {
          gene_id: 'Xenbase:XB-GENE-865046',
          symbol: 'pax6.L',
          species: 'Xenopus laevis',
          methods: ['Xenbase']
        }
      ]
    })
    expect(tool('alliance_get_gene_orthologs').description).not.toContain('paralogs')
  })

  it('keeps disease model names when the upstream disease object is empty', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        total: 183,
        results: [
          {
            model: { primaryExternalId: 'MGI:2680573', agmFullName: { displayText: 'Pax6 model' } },
            diseaseModels: [
              { disease: {}, associationType: 'IS_MODEL_OF', diseaseModel: 'Peters anomaly' }
            ]
          }
        ]
      })
    )
    await expect(
      run('alliance_get_gene_disease_models', { gene_id: 'MGI:97490' }, fetchImpl)
    ).resolves.toMatchObject({
      disease_models: [
        {
          model_id: 'MGI:2680573',
          model_name: 'Pax6 model',
          diseases: [
            {
              disease_id: null,
              disease_name: 'Peters anomaly',
              association_type: 'IS_MODEL_OF'
            }
          ]
        }
      ]
    })
  })

  it('preserves phenotype statements and source annotations', async () => {
    const row = {
      subject: { primaryExternalId: 'MGI:97490', geneSymbol: { displayText: 'Pax6' } },
      phenotypeStatement: 'abnormal anterior eye segment morphology',
      primaryAnnotations: [{ type: 'AGMPhenotypeAnnotation' }]
    }
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ total: 184, results: [row] }))
    await expect(
      run('alliance_get_gene_phenotypes', { gene_id: 'MGI:97490', page: 2 }, fetchImpl)
    ).resolves.toMatchObject({
      page: 2,
      total: 184,
      returned: 1,
      phenotypes: [
        {
          ...row,
          gene_id: 'MGI:97490',
          gene_symbol: 'Pax6',
          phenotype_statement: row.phenotypeStatement
        }
      ]
    })
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.alliancegenome.org/api/gene/MGI%3A97490/phenotypes?limit=20&page=2'
    )
  })

  it('normalizes nested alleles and variantList without silently truncating variants', async () => {
    const locations = [{ start: 105514812, end: 105514813, hgvs: 'NC_000068.8:g.105514813del' }]
    const variants = Array.from({ length: 21 }, (_, index) => ({
      curie: `variant:${index}`,
      variantType: { name: 'deletion' },
      curatedVariantGenomicLocations: locations
    }))
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        total: 675,
        results: [
          {
            allele: { curie: 'rs227592986' },
            variantList: variants,
            hasDisease: false,
            hasPhenotype: false
          }
        ]
      })
    )
    const out = (await run('alliance_get_gene_alleles', { gene_id: 'MGI:97490' }, fetchImpl)) as {
      alleles: { id: string; variants: unknown[] }[]
    }
    expect(out.alleles[0]).toMatchObject({
      id: 'rs227592986',
      has_disease: false,
      has_phenotype: false
    })
    expect(out.alleles[0].variants).toHaveLength(21)
    expect(out.alleles[0].variants[0]).toMatchObject({
      id: 'variant:0',
      type: 'deletion',
      location: locations
    })
  })

  it('still accepts flat allele records with variants', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        total: 1,
        results: [
          {
            primaryExternalId: 'MGI:1856151',
            alleleSymbol: { displayText: 'Pax6 allele' },
            variants: [{ primaryExternalId: 'variant:1', variantType: { name: 'SNP' } }]
          }
        ]
      })
    )
    await expect(
      run('alliance_get_gene_alleles', { gene_id: 'MGI:97490' }, fetchImpl)
    ).resolves.toMatchObject({
      alleles: [
        { id: 'MGI:1856151', symbol: 'Pax6 allele', variants: [{ id: 'variant:1', type: 'SNP' }] }
      ]
    })
  })

  it('uses read-only expression POST with server pagination and provider abbreviation', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        total: 487,
        results: [
          {
            geneExpressionAnnotation: {
              whenExpressedStageName: 'Segmentation:5-9 somites',
              whereExpressedStatement: 'anterior neural rod',
              dataProvider: { abbreviation: 'ZFIN' },
              evidenceItem: { curie: 'AGRKB:101000000666780' }
            }
          }
        ]
      })
    )
    const out = await run(
      'alliance_get_gene_expression',
      {
        gene_id: 'ZFIN:ZDB-GENE-990415-8',
        limit: 1,
        page: 2
      },
      fetchImpl
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.alliancegenome.org/api/expression?limit=1&page=2'
    )
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      body: '["ZFIN:ZDB-GENE-990415-8"]',
      headers: { 'content-type': 'application/json' }
    })
    expect(out).toMatchObject({
      page: 2,
      total: 487,
      returned: 1,
      expression: [
        {
          stage: 'Segmentation:5-9 somites',
          location: 'anterior neural rod',
          data_provider: 'ZFIN',
          reference: 'AGRKB:101000000666780'
        }
      ]
    })
  })

  it('maps disease associations from subject, object and relation', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        total: 80224,
        results: [
          {
            subject: { primaryExternalId: 'HGNC:17968', geneSymbol: { displayText: 'A4GNT' } },
            object: { curie: 'DOID:1793', name: 'pancreatic cancer' },
            relation: { name: 'is_marker_for' }
          }
        ]
      })
    )
    await expect(
      run('alliance_get_disease_genes', { disease_id: 'DOID:162' }, fetchImpl)
    ).resolves.toMatchObject({
      total: 80224,
      genes: [{ gene_id: 'HGNC:17968', disease_id: 'DOID:1793', association_type: 'is_marker_for' }]
    })
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.alliancegenome.org/api/disease/DOID%3A162/genes?limit=20&page=1'
    )
  })

  it.each([404, 429, 503])(
    'propagates HTTP %s without trying an undocumented fallback',
    async (status) => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status }))
      await expect(
        run('alliance_get_disease_genes', { disease_id: 'DOID:162' }, fetchImpl)
      ).rejects.toThrow(`HTTP ${status}`)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it.each([{ total: 1, results: 'bad' }, { total: 1 }, {}, { total: 1, results: [null] }])(
    'rejects malformed envelopes instead of returning a successful empty page: %j',
    async (body) => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(body))
      await expect(
        run('alliance_get_gene_expression', { gene_id: 'MGI:97490' }, fetchImpl)
      ).rejects.toThrow('Alliance response missing')
    }
  )

  it('propagates application errors from an HTTP 200 search response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ total: 0, errorMessages: ['Query failed'] }))
    await expect(run('alliance_search_genes', { query: 'pax6' }, fetchImpl)).rejects.toThrow(
      'Query failed'
    )
  })

  it('rejects blank queries and gene IDs before fetching', async () => {
    const fetchImpl = vi.fn()
    await expect(run('alliance_search_genes', { query: '  ' }, fetchImpl)).rejects.toThrow(
      'query must be'
    )
    await expect(run('alliance_get_gene', { gene_id: '  ' }, fetchImpl)).rejects.toThrow(
      'gene_id must be'
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([{}, { gene: null }, { gene: {} }, { gene: { primaryExternalId: ' ' } }, { id: 123 }])(
    'rejects a gene response without a valid identity: %j',
    async (body) => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(body))
      await expect(run('alliance_get_gene', { gene_id: 'MGI:97490' }, fetchImpl)).rejects.toThrow(
        'Alliance response missing'
      )
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    { errorMessages: ['Backend unavailable'] },
    { errorMessages: ['Backend unavailable'], gene: { primaryExternalId: 'MGI:97490' } }
  ])('propagates gene error envelopes even when they contain gene data', async (body) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(body))
    await expect(run('alliance_get_gene', { gene_id: 'MGI:97490' }, fetchImpl)).rejects.toThrow(
      'Alliance gene failed: Backend unavailable'
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([{ gene: { primaryExternalId: 'MGI:97490' } }, { id: 'MGI:97490' }])(
    'allows optional gene fields to be absent in wrapped and flat responses',
    async (body) => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(body))
      await expect(
        run('alliance_get_gene', { gene_id: 'MGI:97490' }, fetchImpl)
      ).resolves.toMatchObject({
        query_gene_id: 'MGI:97490',
        gene: { id: 'MGI:97490', symbol: null, species: null, synonyms: [] }
      })
    }
  )
})
