import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { CLINICAL_GENOMICS_TOOLS } from './clinical-genomics'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => CLINICAL_GENOMICS_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response
// Parse the JSON body of the nth fetch call (POST connectors send {query, variables}).
const bodyOf = (
  fetchImpl: ReturnType<typeof vi.fn>,
  i = 0
): { query: string; variables: unknown } =>
  JSON.parse((fetchImpl.mock.calls[i][1] as RequestInit).body as string)

describe('clinical_genomics — has exactly the 20 upstream tools', () => {
  it('exposes the ClinGen + CIViC + Open Targets ids', () => {
    expect(CLINICAL_GENOMICS_TOOLS.map((t) => t.id).sort()).toEqual(
      [
        'clingen_actionability',
        'clingen_dosage_sensitivity',
        'clingen_gene_validity',
        'clingen_variant_classifications',
        'civic_gene_variants',
        'civic_get_assertion',
        'civic_get_evidence_item',
        'civic_get_molecular_profile',
        'civic_get_variant',
        'civic_search_assertions',
        'civic_search_diseases',
        'civic_search_evidence',
        'civic_search_genes',
        'civic_search_molecular_profiles',
        'civic_search_therapies',
        'civic_search_variants',
        'open_targets_disease_drugs',
        'open_targets_disease_targets',
        'open_targets_drug',
        'open_targets_graphql'
      ].sort()
    )
    expect(CLINICAL_GENOMICS_TOOLS.every((t) => t.connector === 'clinical_genomics')).toBe(true)
    expect(CLINICAL_GENOMICS_TOOLS.every((t) => t.returns && t.example)).toBeTruthy()
  })
})

describe('clinical_genomics — ClinGen', () => {
  it('clingen_gene_validity verifies count, maps + filters + sorts records', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        total: 2,
        rows: [
          {
            symbol: 'BRCA2',
            hgnc_id: 'HGNC:1101',
            disease_name: 'Fanconi anemia  ',
            mondo: 'MONDO:0019391',
            moi: 'AR',
            sop: 'SOP8',
            classification: 'Definitive ',
            ep: 'Hereditary Breast/Ovarian Cancer VCEP',
            affiliate_id: '40023',
            animal_model_only: 0,
            perm_id: 'CGGV:assertion_x',
            date: '2020-01-01'
          },
          { symbol: 'TP53', hgnc_id: 'HGNC:11998', classification: 'Definitive', perm_id: 'y' }
        ]
      })
    )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clingen_gene_validity'),
      { gene: 'brca2' },
      {}
    )) as { total: number; records: Array<Record<string, unknown>>; source: string }
    expect(fetchImpl.mock.calls[0][0]).toBe('https://search.clinicalgenome.org/api/validity')
    expect(out.total).toBe(1)
    expect(out.records[0]).toEqual({
      gene_symbol: 'BRCA2',
      hgnc_id: 'HGNC:1101',
      disease_label: 'Fanconi anemia',
      mondo_id: 'MONDO:0019391',
      moi: 'AR',
      sop: 'SOP8',
      classification: 'Definitive',
      expert_panel: 'Hereditary Breast/Ovarian Cancer VCEP',
      affiliate_id: '40023',
      animal_model_only: false,
      assertion_id: 'CGGV:assertion_x'
    })
    expect(out.source).toContain('search.clinicalgenome.org/api/validity')
  })

  it('clingen_gene_validity throws on a total/rows count mismatch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ total: 5, rows: [{ symbol: 'A' }] }))
    await expect(
      new ParserEngine({ fetchImpl }).call(tool('clingen_gene_validity'), {}, {})
    ).rejects.toThrow(/count mismatch/)
  })

  it('clingen_dosage_sensitivity excludes regions by default and normalizes assertions', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        total: 2,
        rows: [
          {
            symbol: 'A4GALT',
            hgnc_id: 'HGNC:18149',
            type: 0,
            location: '22q13.2',
            grch37: 'chr22:1-2',
            grch38: 'chr22:3-4',
            haplo_assertion: 30,
            triplo_assertion: 0,
            omim: 'Yes',
            morbid: 'Yes'
          },
          {
            symbol: '2p11.2 recurrent region',
            hgnc_id: 'ISCA-46754',
            type: 1,
            haplo_assertion: '0',
            triplo_assertion: '0'
          }
        ]
      })
    )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clingen_dosage_sensitivity'),
      {},
      {}
    )) as { total: number; records: Array<Record<string, unknown>> }
    expect(fetchImpl.mock.calls[0][0]).toBe('https://search.clinicalgenome.org/api/dosage')
    expect(out.total).toBe(1)
    expect(out.records[0].record_type).toBe('gene')
    expect(out.records[0].haploinsufficiency).toEqual({
      code: '30',
      label: 'Gene Associated with Autosomal Recessive Phenotype'
    })
    expect(out.records[0].triplosensitivity).toEqual({ code: '0', label: 'No Evidence' })
  })

  it('clingen_dosage_sensitivity include_regions keeps ISCA region records', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        total: 1,
        rows: [{ symbol: 'reg', hgnc_id: 'ISCA-1', type: 1, haplo_assertion: '40: x' }]
      })
    )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clingen_dosage_sensitivity'),
      { include_regions: true },
      {}
    )) as { total: number; records: Array<Record<string, unknown>> }
    expect(out.total).toBe(1)
    expect(out.records[0].record_type).toBe('region')
    expect(out.records[0].haploinsufficiency).toEqual({
      code: '40',
      label: 'Dosage Sensitivity Unlikely'
    })
  })

  it('clingen_actionability fetches both contexts and filters multi-gene topics', async () => {
    const table = (ctx: string): unknown => ({
      columns: [
        'docId',
        'context',
        'geneOrVariant',
        'disease',
        'outcome',
        'intervention',
        'overall'
      ],
      rows: [['AC001', ctx, 'BRCA1, BRCA2', 'HBOC', 'Cancer', 'Surveillance', '10CC']]
    })
    const fetchImpl = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(jsonRes(url.includes('/Adult/') ? table('Adult') : table('Pediatric')))
      )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clingen_actionability'),
      { gene: 'brca2', context: 'both' },
      {}
    )) as Record<string, { total: number; records: Array<Record<string, unknown>> }> & {
      source: string
    }
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://actionability.clinicalgenome.org/ac/Adult/api/summ?flavor=flat'
    )
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://actionability.clinicalgenome.org/ac/Pediatric/api/summ?flavor=flat'
    )
    expect(out.adult.total).toBe(1)
    expect(out.adult.records[0].genes).toEqual(['BRCA1', 'BRCA2'])
    expect(out.adult.records[0].overall_score).toBe('10CC')
    expect(out.pediatric.total).toBe(1)
    expect(out.source).toContain('actionability.clinicalgenome.org')
  })

  it('clingen_variant_classifications builds the ERepo URL and maps guidelines/agents', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        variantInterpretations: [
          {
            '@id': 'https://erepo.genome.network/.../092',
            uuid: 'u1',
            caid: 'CAR:CA000895',
            variationId: '13961',
            gene: { label: 'BRCA1', NCBI_id: '672' },
            condition: { '@id': 'MONDO:0011450', label: 'BRCA1-related cancer' },
            hgvs: ['b', 'a'],
            evidenceLinks: [],
            publishedDate: '2023-10',
            guidelines: [
              {
                '@id': 'GN092',
                label: 'ENIGMA',
                outcome: { label: 'Pathogenic' },
                agents: [
                  {
                    '@id': 'AG1',
                    affiliation: 'ENIGMA VCEP',
                    outcome: { label: 'Pathogenic' },
                    evidenceCodes: [
                      { label: 'PVS1', status: 'Met' },
                      { label: 'PM2', status: 'Not Met' }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      })
    )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clingen_variant_classifications'),
      { gene: 'BRCA1' },
      {}
    )) as { total: number; records: Array<Record<string, unknown>>; query: unknown }
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://erepo.genome.network/evrepo/api/classifications?gene=BRCA1&matchMode=exact&matchLimit=none'
    )
    expect(out.total).toBe(1)
    expect(out.query).toEqual({ gene: 'BRCA1' })
    const rec = out.records[0]
    expect(rec.caid).toBe('CAR:CA000895')
    expect(rec.hgvs).toEqual(['a', 'b'])
    const guidelines = rec.guidelines as Array<Record<string, unknown>>
    const agent = (guidelines[0].agents as Array<Record<string, unknown>>)[0]
    expect(agent.evidence_codes_met).toEqual(['PVS1'])
    expect(agent.evidence_codes_not_met).toEqual(['PM2'])
  })

  it('clingen_variant_classifications requires exactly one of gene/caid/hgvs', async () => {
    const fetchImpl = vi.fn()
    await expect(
      new ParserEngine({ fetchImpl }).call(tool('clingen_variant_classifications'), {}, {})
    ).rejects.toThrow(/exactly one/)
    await expect(
      new ParserEngine({ fetchImpl }).call(
        tool('clingen_variant_classifications'),
        { gene: 'A', caid: 'B' },
        {}
      )
    ).rejects.toThrow(/exactly one/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('clinical_genomics — CIViC', () => {
  it('civic_search_genes posts the entrezSymbols query and sorts aliases', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        data: {
          conn: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: 'MQ' },
            nodes: [
              {
                id: 5,
                name: 'BRAF',
                entrezId: 673,
                fullName: 'B-Raf',
                featureAliases: ['RAFB1', 'B-RAF1'],
                description: 'd',
                link: '/features/5'
              }
            ]
          }
        }
      })
    )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('civic_search_genes'),
      { entrez_symbol: 'BRAF' },
      {}
    )) as {
      total_count: number
      pages_fetched: number
      records: Array<Record<string, unknown>>
      query: unknown
    }
    expect(fetchImpl.mock.calls[0][0]).toBe('https://civicdb.org/api/graphql')
    const body = bodyOf(fetchImpl)
    expect(body.query).toContain('entrezSymbols: $sym')
    expect(body.variables).toMatchObject({ sym: ['BRAF'], first: 100, after: null })
    expect(out.total_count).toBe(1)
    expect(out.pages_fetched).toBe(1)
    expect(out.records[0].featureAliases).toEqual(['B-RAF1', 'RAFB1'])
    expect(out.query).toEqual({ mode: 'search_genes', entrez_symbol: 'BRAF' })
  })

  it('civic_search_diseases walks cursor pagination to completion and sorts by id', async () => {
    const node = (id: number): Record<string, unknown> => ({
      id,
      name: `D${id}`,
      displayName: `D${id}`,
      doid: `${id}`,
      diseaseUrl: '',
      diseaseAliases: [],
      link: `/diseases/${id}`
    })
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const vars = JSON.parse(init.body as string).variables as { after: string | null }
      if (!vars.after) {
        return Promise.resolve(
          jsonRes({
            data: {
              conn: {
                totalCount: 3,
                pageInfo: { hasNextPage: true, endCursor: 'C1' },
                nodes: [node(2), node(1)]
              }
            }
          })
        )
      }
      return Promise.resolve(
        jsonRes({
          data: {
            conn: {
              totalCount: 3,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [node(3)]
            }
          }
        })
      )
    })
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('civic_search_diseases'),
      { name: 'melanoma' },
      {}
    )) as { total_count: number; pages_fetched: number; records: Array<Record<string, unknown>> }
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(bodyOf(fetchImpl, 1).variables).toMatchObject({ after: 'C1' })
    expect(out.total_count).toBe(3)
    expect(out.pages_fetched).toBe(2)
    expect(out.records.map((r) => r.id)).toEqual([1, 2, 3])
  })

  it('civic paged walk throws when the retrieved count != totalCount', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        data: {
          conn: {
            totalCount: 9,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: 1 }]
          }
        }
      })
    )
    await expect(
      new ParserEngine({ fetchImpl }).call(tool('civic_search_diseases'), { name: 'x' }, {})
    ).rejects.toThrow(/retrieved 1 nodes but totalCount=9/)
  })

  it('civic_get_variant returns found/record for a hit', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ data: { node: { id: 12, name: 'V600E', variantAliases: ['b', 'a'] } } })
      )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('civic_get_variant'),
      { variant_id: 12 },
      {}
    )) as { query: unknown; found: boolean; record: Record<string, unknown> }
    expect(bodyOf(fetchImpl).variables).toEqual({ id: 12 })
    expect(out.query).toEqual({ mode: 'variant', id: 12 })
    expect(out.found).toBe(true)
    expect(out.record.variantAliases).toEqual(['a', 'b'])
  })

  it('civic_get_evidence_item returns found=false when the node is null', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ data: { node: null } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('civic_get_evidence_item'),
      { evidence_id: 999999 },
      {}
    )) as { found: boolean; record: unknown }
    expect(out.found).toBe(false)
    expect(out.record).toBeNull()
  })

  it('civic_search_evidence encodes only provided filters + the ID ASC sort', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        data: {
          conn: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
        }
      })
    )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('civic_search_evidence'),
      { disease_name: 'melanoma', evidence_level: 'A' },
      {}
    )) as { query: { mode: string; filters: unknown } }
    const body = bodyOf(fetchImpl)
    expect(body.query).toContain('$f_diseaseName: String')
    expect(body.query).toContain('diseaseName: $f_diseaseName')
    expect(body.query).toContain('$f_evidenceLevel: EvidenceLevel')
    expect(body.query).toContain('sortBy: $sb')
    expect(body.query).not.toContain('therapyName')
    expect(body.variables).toMatchObject({
      f_diseaseName: 'melanoma',
      f_evidenceLevel: 'A',
      sb: { column: 'ID', direction: 'ASC' }
    })
    expect(out.query).toEqual({
      mode: 'search_evidence',
      filters: { disease_name: 'melanoma', evidence_level: 'A' }
    })
  })

  it('civic_get_variant surfaces GraphQL errors instead of silently returning null', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ errors: [{ message: 'bad field' }] }))
    await expect(
      new ParserEngine({ fetchImpl }).call(tool('civic_get_variant'), { variant_id: 1 }, {})
    ).rejects.toThrow(/CIViC GraphQL error/)
  })
})

describe('clinical_genomics — Open Targets', () => {
  it('open_targets_graphql passes query+variables through and returns {data, attempts}', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ data: { target: { approvedSymbol: 'TP53' } } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('open_targets_graphql'),
      {
        query: 'query($id: String!){ target(ensemblId: $id){ approvedSymbol } }',
        variables: { id: 'ENSG00000141510' }
      },
      {}
    )) as { data: unknown; attempts: number }
    const body = bodyOf(fetchImpl)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.platform.opentargets.org/api/v4/graphql')
    expect(body.variables).toEqual({ id: 'ENSG00000141510' })
    expect(out.data).toEqual({ target: { approvedSymbol: 'TP53' } })
    expect(out.attempts).toBe(1)
  })

  it('open_targets_graphql retries the transient HTTP-200 internal-server error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ errors: [{ message: 'Internal server error' }] }))
      .mockResolvedValueOnce(jsonRes({ data: { target: { approvedSymbol: 'BRAF' } } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('open_targets_graphql'),
      { query: '{ target(ensemblId: "x"){ approvedSymbol } }' },
      {}
    )) as { data: unknown; attempts: number; errors?: unknown }
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(out.attempts).toBe(2)
    expect(out.errors).toBeUndefined()
    expect(out.data).toEqual({ target: { approvedSymbol: 'BRAF' } })
  })

  it('open_targets_disease_targets returns the disease node with the size variable', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        data: {
          disease: {
            id: 'MONDO_0004992',
            name: 'cancer',
            associatedTargets: {
              count: 22581,
              rows: [{ score: 0.94, target: { id: 'ENSG00000139618', approvedSymbol: 'BRCA2' } }]
            }
          }
        }
      })
    )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('open_targets_disease_targets'),
      { efo_id: 'MONDO_0004992', size: 3 },
      {}
    )) as Record<string, unknown>
    expect(bodyOf(fetchImpl).variables).toEqual({ id: 'MONDO_0004992', size: 3 })
    expect(out.id).toBe('MONDO_0004992')
    expect((out.associatedTargets as { count: number }).count).toBe(22581)
  })

  it('open_targets_disease_drugs slices rows to size', async () => {
    const rows = [1, 2, 3, 4].map((n) => ({
      id: `r${n}`,
      maxClinicalStage: 'Phase III',
      drug: { id: `d${n}`, name: `D${n}`, drugType: 'x' }
    }))
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        data: { disease: { id: 'E', name: 'e', drugAndClinicalCandidates: { count: 4, rows } } }
      })
    )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('open_targets_disease_drugs'),
      { efo_id: 'E', size: 2 },
      {}
    )) as { drugAndClinicalCandidates: { count: number; rows: unknown[] } }
    expect(out.drugAndClinicalCandidates.count).toBe(4)
    expect(out.drugAndClinicalCandidates.rows).toHaveLength(2)
  })

  it('open_targets_drug returns {errors} when the drug is unknown (null root)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ data: { drug: null } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('open_targets_drug'),
      { chembl_id: 'CHEMBL_NOPE' },
      {}
    )) as { errors: unknown }
    expect(Array.isArray(out.errors)).toBe(true)
  })
})
