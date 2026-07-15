import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { CANCER_MODELS_TOOLS } from './cancer-models'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => CANCER_MODELS_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response
const notFound = (url: string): Response =>
  ({
    ok: false,
    status: 404,
    json: async () => ({}),
    text: async () => '',
    headers: undefined,
    url
  }) as unknown as Response

// Routes a fetch mock by URL substring; on nested paths (e.g. /molecular-profiles/X/mutations) the
// needle starting latest in the URL wins, so the most specific endpoint matches. Unmatched throws.
const router =
  (routes: Array<[string, unknown]>) =>
  async (url: string): Promise<Response> => {
    let best: unknown
    let bestIdx = -1
    for (const [needle, body] of routes) {
      const idx = url.indexOf(needle)
      if (idx > bestIdx) {
        bestIdx = idx
        best = body
      }
    }
    if (bestIdx < 0) throw new Error(`unexpected fetch: ${url}`)
    return best === '__404__' ? notFound(url) : jsonRes(best)
  }

const run = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch
): Promise<unknown> => new ParserEngine({ fetchImpl, retries: 0 }).call(tool(id), args, {})

describe('cancer_models / list_studies', () => {
  it('fetches all matching studies, filters by cancer_type_id, and sorts by study_id', async () => {
    const fetchImpl = vi.fn(
      router([
        [
          '/studies?',
          [
            {
              studyId: 'gbm_b',
              name: 'GBM B',
              description: 'x'.repeat(300),
              cancerTypeId: 'gbm',
              cancerType: { name: 'Glioblastoma' },
              referenceGenome: 'hg19',
              pmid: '1',
              citation: 'C1',
              sequencedSampleCount: 10,
              cnaSampleCount: 8,
              structuralVariantCount: 2,
              allSampleCount: 12
            },
            {
              studyId: 'gbm_a',
              name: 'GBM A',
              cancerTypeId: 'gbm',
              cancerType: { name: 'Glioblastoma' },
              sequencedSampleCount: 5
            },
            {
              studyId: 'brca_x',
              name: 'Breast',
              cancerTypeId: 'brca',
              cancerType: { name: 'Breast' }
            }
          ]
        ]
      ]) as unknown as typeof fetch
    )
    const out = (await run(
      'cbioportal_list_studies',
      { keyword: 'glioma', cancer_type_id: 'gbm' },
      fetchImpl as unknown as typeof fetch
    )) as Record<string, unknown>

    expect(fetchImpl.mock.calls[0][0] as string).toContain('keyword=glioma')
    expect(out.api_total_for_keyword).toBe(3)
    expect(out.count).toBe(2)
    expect(out.truncated).toBe(false)
    const studies = out.studies as Record<string, unknown>[]
    expect(studies.map((s) => s.study_id)).toEqual(['gbm_a', 'gbm_b'])
    // allSampleCount is deliberately omitted; description is trimmed to ~240 chars with an ellipsis.
    expect(studies[1]).not.toHaveProperty('all_sample_count')
    expect(String(studies[1].description)).toHaveLength(241)
    expect(String(studies[1].description).endsWith('…')).toBe(true)
  })

  it('omits the keyword param and honors max_records truncation', async () => {
    const fetchImpl = vi.fn(
      router([
        [
          '/studies?',
          [
            { studyId: 's1', cancerTypeId: 'a' },
            { studyId: 's2', cancerTypeId: 'a' }
          ]
        ]
      ]) as unknown as typeof fetch
    )
    const out = (await run(
      'cbioportal_list_studies',
      { max_records: 1 },
      fetchImpl as unknown as typeof fetch
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0] as string).not.toContain('keyword=')
    expect(out.keyword).toBeNull()
    expect(out.count).toBe(2)
    expect(out.truncated).toBe(true)
    expect((out.studies as unknown[]).length).toBe(1)
  })
})

describe('cancer_models / get_study', () => {
  it('assembles metadata, true collection counts, and sorted profiles', async () => {
    const fetchImpl = vi.fn(
      router([
        [
          '/studies/msk_impact_2017?',
          {
            studyId: 'msk_impact_2017',
            name: 'MSK-IMPACT',
            description: 'd',
            cancerTypeId: 'mixed',
            cancerType: { name: 'Mixed' },
            referenceGenome: 'hg19',
            pmid: '28481359',
            citation: 'Zehir 2017',
            publicStudy: true,
            groups: 'PUBLIC',
            importDate: '2026-01-01',
            sequencedSampleCount: 10945,
            cnaSampleCount: 10336,
            structuralVariantCount: 0,
            treatmentCount: 0,
            allSampleCount: 1
          }
        ],
        [
          '/molecular-profiles',
          [
            {
              molecularProfileId: 'msk_impact_2017_mutations',
              molecularAlterationType: 'MUTATION_EXTENDED',
              datatype: 'MAF',
              name: 'Mutations'
            },
            {
              molecularProfileId: 'msk_impact_2017_cna',
              molecularAlterationType: 'COPY_NUMBER_ALTERATION',
              datatype: 'DISCRETE',
              name: 'CNA'
            }
          ]
        ],
        ['/samples?', [{ sampleId: 'a' }, { sampleId: 'b' }, { sampleId: 'c' }]],
        ['/patients?', [{ patientId: 'p1' }, { patientId: 'p2' }]]
      ]) as unknown as typeof fetch
    )
    const out = (await run(
      'cbioportal_get_study',
      { study_id: 'msk_impact_2017' },
      fetchImpl as unknown as typeof fetch
    )) as Record<string, unknown>

    expect(out.sample_count).toBe(3)
    expect(out.patient_count).toBe(2)
    expect(out.cancer_type).toBe('Mixed')
    expect(out.public).toBe(true)
    const profiles = out.molecular_profiles as Record<string, unknown>[]
    expect(profiles.map((p) => p.molecular_profile_id)).toEqual([
      'msk_impact_2017_cna',
      'msk_impact_2017_mutations'
    ])
    expect(out).not.toHaveProperty('all_sample_count')
  })

  it('throws "Study not found" on a 404', async () => {
    const fetchImpl = vi.fn(router([['/studies/nope?', '__404__']]) as unknown as typeof fetch)
    await expect(
      run('cbioportal_get_study', { study_id: 'nope' }, fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow('Study not found')
  })
})

describe('cancer_models / mutations_in_gene', () => {
  const genePlusProfiles = (mutations: unknown[]): Array<[string, unknown]> => [
    ['/genes/IDH1', { entrezGeneId: 3417, hugoGeneSymbol: 'IDH1' }],
    [
      '/molecular-profiles',
      [
        {
          molecularProfileId: 'difg_msk_2023_mutations',
          molecularAlterationType: 'MUTATION_EXTENDED'
        }
      ]
    ],
    [
      '/sample-lists',
      [{ sampleListId: 'difg_msk_2023_sequenced', category: 'all_cases_with_mutation_data' }]
    ],
    ['/mutations?', mutations]
  ]

  it('aggregates recurrence and sorts mutations by genomic position', async () => {
    const fetchImpl = vi.fn(
      router(
        genePlusProfiles([
          {
            sampleId: 's1',
            proteinChange: 'R132H',
            mutationType: 'Missense_Mutation',
            chr: '2',
            startPosition: 209113112
          },
          {
            sampleId: 's2',
            proteinChange: 'R132H',
            mutationType: 'Missense_Mutation',
            chr: '2',
            startPosition: 209113100
          },
          {
            sampleId: 's2',
            proteinChange: 'R132C',
            mutationType: 'Missense_Mutation',
            chr: '2',
            startPosition: 209113113
          }
        ])
      ) as unknown as typeof fetch
    )
    const out = (await run(
      'cbioportal_mutations_in_gene',
      { gene_symbol: 'IDH1', study_id: 'difg_msk_2023', max_records: 2 },
      fetchImpl as unknown as typeof fetch
    )) as Record<string, unknown>

    expect(out.total_mutations).toBe(3)
    expect(out.mutated_sample_count).toBe(2)
    expect(out.distinct_protein_changes).toBe(2)
    expect(out.top_protein_changes).toEqual({ R132H: 2, R132C: 1 })
    expect(out.truncated).toBe(true)
    const muts = out.mutations as Record<string, unknown>[]
    expect(muts.length).toBe(2)
    // Sorted by start position within chr 2.
    expect(muts[0].start_position).toBe(209113100)
    expect((out.gene as Record<string, unknown>).entrez_gene_id).toBe(3417)
  })

  it('throws listing alteration types when the study lacks mutation data', async () => {
    const fetchImpl = vi.fn(
      router([
        ['/genes/IDH1', { entrezGeneId: 3417, hugoGeneSymbol: 'IDH1' }],
        [
          '/molecular-profiles',
          [{ molecularProfileId: 'x_cna', molecularAlterationType: 'COPY_NUMBER_ALTERATION' }]
        ]
      ]) as unknown as typeof fetch
    )
    await expect(
      run(
        'cbioportal_mutations_in_gene',
        { gene_symbol: 'IDH1', study_id: 'x' },
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toThrow(/no mutation data.*COPY_NUMBER_ALTERATION/)
  })

  it('throws "Gene not found" on unknown gene', async () => {
    const fetchImpl = vi.fn(router([['/genes/ZZZ', '__404__']]) as unknown as typeof fetch)
    await expect(
      run(
        'cbioportal_mutations_in_gene',
        { gene_symbol: 'ZZZ', study_id: 'x' },
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toThrow('Gene not found')
  })
})

describe('cancer_models / mutation_frequency', () => {
  it('computes frequency per study and buckets unknown / no-data ids, ranked by frequency', async () => {
    const fetchImpl = vi.fn(
      router([
        ['/genes/KRAS', { entrezGeneId: 3845, hugoGeneSymbol: 'KRAS' }],
        ['/studies/study_hi?', { studyId: 'study_hi', name: 'Hi', sequencedSampleCount: 10 }],
        ['/studies/study_lo?', { studyId: 'study_lo', name: 'Lo', sequencedSampleCount: 100 }],
        [
          '/studies/study_nodata?',
          { studyId: 'study_nodata', name: 'No', sequencedSampleCount: 5 }
        ],
        ['/studies/study_unknown?', '__404__'],
        [
          '/studies/study_hi/molecular-profiles',
          [
            {
              molecularProfileId: 'study_hi_mutations',
              molecularAlterationType: 'MUTATION_EXTENDED'
            }
          ]
        ],
        [
          '/studies/study_lo/molecular-profiles',
          [
            {
              molecularProfileId: 'study_lo_mutations',
              molecularAlterationType: 'MUTATION_EXTENDED'
            }
          ]
        ],
        [
          '/studies/study_nodata/molecular-profiles',
          [
            {
              molecularProfileId: 'study_nodata_cna',
              molecularAlterationType: 'COPY_NUMBER_ALTERATION'
            }
          ]
        ],
        [
          '/studies/study_hi/sample-lists',
          [{ sampleListId: 'study_hi_sequenced', category: 'all_cases_with_mutation_data' }]
        ],
        [
          '/studies/study_lo/sample-lists',
          [{ sampleListId: 'study_lo_sequenced', category: 'all_cases_with_mutation_data' }]
        ],
        [
          'study_hi_mutations/mutations?',
          [{ sampleId: 'a' }, { sampleId: 'b' }, { sampleId: 'b' }]
        ],
        ['study_lo_mutations/mutations?', [{ sampleId: 'a' }, { sampleId: 'b' }]]
      ]) as unknown as typeof fetch
    )
    const out = (await run(
      'cbioportal_mutation_frequency',
      {
        gene_symbol: 'KRAS',
        study_ids: ['study_hi', 'study_lo', 'study_nodata', 'study_unknown']
      },
      fetchImpl as unknown as typeof fetch
    )) as Record<string, unknown>

    expect(out.unknown_studies).toEqual(['study_unknown'])
    expect(out.no_mutation_data).toEqual(['study_nodata'])
    const freqs = out.frequencies as Record<string, unknown>[]
    expect(out.count).toBe(2)
    // study_hi: 2 mutated / 10 sequenced = 0.2 > study_lo: 2/100 = 0.02.
    expect(freqs.map((f) => f.study_id)).toEqual(['study_hi', 'study_lo'])
    expect(freqs[0].frequency).toBe(0.2)
    expect(freqs[0].mutated_samples).toBe(2)
    expect(freqs[1].frequency).toBe(0.02)
  })
})

describe('cancer_models / cna_in_gene', () => {
  const baseRoutes = (cnaRows: unknown[]): Array<[string, unknown]> => [
    ['/genes/CDKN2A', { entrezGeneId: 1029, hugoGeneSymbol: 'CDKN2A' }],
    [
      '/molecular-profiles',
      [
        {
          molecularProfileId: 'msk_impact_2017_cna',
          molecularAlterationType: 'COPY_NUMBER_ALTERATION',
          datatype: 'DISCRETE'
        }
      ]
    ],
    [
      '/sample-lists',
      [{ sampleListId: 'msk_impact_2017_cna', category: 'all_cases_with_cna_data' }]
    ],
    ['/discrete-copy-number/fetch', cnaRows]
  ]

  it('buckets events by type and tallies the full distribution (default HOMDEL_AND_AMP)', async () => {
    const fetchImpl = vi.fn(
      router(
        baseRoutes([
          { sampleId: 's1', patientId: 'p1', alteration: -2 },
          { sampleId: 's2', patientId: 'p2', alteration: 2 },
          { sampleId: 's3', patientId: 'p3', alteration: 0 },
          { sampleId: 's4', patientId: 'p4', alteration: 1 }
        ])
      ) as unknown as typeof fetch
    )
    const out = (await run(
      'cbioportal_cna_in_gene',
      { gene_symbol: 'CDKN2A', study_id: 'msk_impact_2017' },
      fetchImpl as unknown as typeof fetch
    )) as Record<string, unknown>

    // POST body carries the gene filter the GET endpoint ignores.
    const postArgs = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/fetch'))
    expect(JSON.parse((postArgs![1] as RequestInit).body as string)).toEqual({
      sampleListId: 'msk_impact_2017_cna',
      entrezGeneIds: [1029]
    })
    expect(out.event_type).toBe('HOMDEL_AND_AMP')
    expect(out.total_events).toBe(2)
    expect(out.altered_sample_count).toBe(2)
    expect(out.alteration_counts).toEqual({
      deep_deletion: 1,
      amplification: 1,
      diploid: 1,
      gain: 1
    })
    const events = out.events as Record<string, unknown>[]
    expect(events.map((e) => e.alteration_label)).toEqual(['deep_deletion', 'amplification'])
  })

  it('respects a non-default event_type filter (AMP only)', async () => {
    const fetchImpl = vi.fn(
      router(
        baseRoutes([
          { sampleId: 's1', alteration: -2 },
          { sampleId: 's2', alteration: 2 }
        ])
      ) as unknown as typeof fetch
    )
    const out = (await run(
      'cbioportal_cna_in_gene',
      { gene_symbol: 'CDKN2A', study_id: 'msk_impact_2017', event_type: 'AMP' },
      fetchImpl as unknown as typeof fetch
    )) as Record<string, unknown>
    expect(out.total_events).toBe(1)
    expect((out.events as Record<string, unknown>[])[0].alteration_label).toBe('amplification')
  })

  it('throws listing alteration types when the study lacks discrete CNA', async () => {
    const fetchImpl = vi.fn(
      router([
        ['/genes/CDKN2A', { entrezGeneId: 1029, hugoGeneSymbol: 'CDKN2A' }],
        [
          '/molecular-profiles',
          [{ molecularProfileId: 'x_mut', molecularAlterationType: 'MUTATION_EXTENDED' }]
        ]
      ]) as unknown as typeof fetch
    )
    await expect(
      run(
        'cbioportal_cna_in_gene',
        { gene_symbol: 'CDKN2A', study_id: 'x' },
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toThrow(/no discrete copy-number data.*MUTATION_EXTENDED/)
  })
})

describe('cancer_models / clinical_attributes', () => {
  it('summarizes survival endpoints and levels, sorted by attribute id', async () => {
    const fetchImpl = vi.fn(
      router([
        [
          '/clinical-attributes',
          [
            {
              clinicalAttributeId: 'OS_STATUS',
              displayName: 'OS Status',
              datatype: 'STRING',
              patientAttribute: true,
              priority: '1'
            },
            {
              clinicalAttributeId: 'OS_MONTHS',
              displayName: 'OS Months',
              datatype: 'NUMBER',
              patientAttribute: true,
              priority: '1'
            },
            {
              clinicalAttributeId: 'AGE',
              displayName: 'Age',
              datatype: 'NUMBER',
              patientAttribute: true,
              priority: '1'
            },
            {
              clinicalAttributeId: 'SAMPLE_TYPE',
              displayName: 'Sample Type',
              datatype: 'STRING',
              patientAttribute: false,
              priority: '1'
            }
          ]
        ]
      ]) as unknown as typeof fetch
    )
    const out = (await run(
      'cbioportal_clinical_attributes',
      { study_id: 'brca_tcga_pan_can_atlas_2018' },
      fetchImpl as unknown as typeof fetch
    )) as Record<string, unknown>

    expect(out.total_attributes).toBe(4)
    expect(out.patient_level_count).toBe(3)
    expect(out.sample_level_count).toBe(1)
    expect(out.survival_attributes).toEqual(['OS_MONTHS', 'OS_STATUS'])
    expect(out.has_overall_survival).toBe(true)
    const attrs = out.attributes as Record<string, unknown>[]
    expect(attrs.map((x) => x.attribute_id)).toEqual([
      'AGE',
      'OS_MONTHS',
      'OS_STATUS',
      'SAMPLE_TYPE'
    ])
    expect(attrs[0].level).toBe('patient')
    expect(attrs[3].level).toBe('sample')
    expect(attrs[0].priority).toBe(1)
  })

  it('throws "Study not found" on a 404', async () => {
    const fetchImpl = vi.fn(
      router([['/clinical-attributes', '__404__']]) as unknown as typeof fetch
    )
    await expect(
      run(
        'cbioportal_clinical_attributes',
        { study_id: 'nope' },
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toThrow('Study not found')
  })
})

// Live integration tests against the real cBioPortal API. Opt-in via LIVE_API=1 to keep the default
// suite offline and to respect upstream rate limits (each block hits the network a handful of times).
describe.skipIf(!process.env.LIVE_API)('cancer_models / LIVE cBioPortal', () => {
  const live = (id: string, args: Record<string, unknown>): Promise<unknown> =>
    new ParserEngine().call(tool(id), args, {})

  it('list_studies finds gliomas and reports an API total', async () => {
    const out = (await live('cbioportal_list_studies', { keyword: 'glioma' })) as Record<
      string,
      unknown
    >
    expect(out.api_total_for_keyword as number).toBeGreaterThan(0)
    expect((out.studies as unknown[]).length).toBeGreaterThan(0)
    const first = (out.studies as Record<string, unknown>[])[0]
    expect(first).toHaveProperty('study_id')
    expect(first).not.toHaveProperty('all_sample_count')
  }, 30000)

  it('get_study returns true counts and molecular profiles for msk_impact_2017', async () => {
    const out = (await live('cbioportal_get_study', { study_id: 'msk_impact_2017' })) as Record<
      string,
      unknown
    >
    expect(out.study_id).toBe('msk_impact_2017')
    expect(out.sample_count as number).toBeGreaterThan(10000)
    expect((out.molecular_profiles as unknown[]).length).toBeGreaterThan(0)
  }, 60000)

  it('get_study throws for an unknown study', async () => {
    await expect(
      live('cbioportal_get_study', { study_id: 'definitely_not_a_study_xyz' })
    ).rejects.toThrow('Study not found')
  }, 30000)

  it('mutations_in_gene aggregates IDH1 in a small glioma cohort', async () => {
    const out = (await live('cbioportal_mutations_in_gene', {
      gene_symbol: 'IDH1',
      study_id: 'difg_msk_2023'
    })) as Record<string, unknown>
    expect((out.gene as Record<string, unknown>).entrez_gene_id).toBe(3417)
    expect(out.total_mutations as number).toBeGreaterThan(0)
    expect(Object.keys(out.top_protein_changes as object)).toContain('R132H')
  }, 30000)

  it('mutation_frequency ranks KRAS across studies', async () => {
    const out = (await live('cbioportal_mutation_frequency', {
      gene_symbol: 'KRAS',
      study_ids: ['msk_impact_2017', 'difg_msk_2023']
    })) as Record<string, unknown>
    expect((out.frequencies as unknown[]).length).toBeGreaterThan(0)
    for (const f of out.frequencies as Record<string, unknown>[]) {
      expect(f).toHaveProperty('frequency')
      expect(f).toHaveProperty('sequenced_samples')
    }
  }, 60000)

  it('cna_in_gene finds CDKN2A deletions/amplifications in msk_impact_2017', async () => {
    const out = (await live('cbioportal_cna_in_gene', {
      gene_symbol: 'CDKN2A',
      study_id: 'msk_impact_2017'
    })) as Record<string, unknown>
    expect(out.event_type).toBe('HOMDEL_AND_AMP')
    expect(out.total_events as number).toBeGreaterThan(0)
    expect(out.alteration_counts).toHaveProperty('deep_deletion')
  }, 60000)

  it('clinical_attributes reports OS endpoints for a TCGA PanCan study', async () => {
    const out = (await live('cbioportal_clinical_attributes', {
      study_id: 'brca_tcga_pan_can_atlas_2018'
    })) as Record<string, unknown>
    expect(out.total_attributes as number).toBeGreaterThan(0)
    expect(out.has_overall_survival).toBe(true)
    expect(out.survival_attributes as string[]).toContain('OS_STATUS')
  }, 30000)
})
