import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { CHEMBL_TOOLS } from './chembl'
import type { ToolDescriptor } from '../../connector-core/types'

const tool = (id: string): ToolDescriptor => CHEMBL_TOOLS.find((t) => t.id === id)!

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

// Drives a tool through a real ParserEngine with a queue of mocked responses, returning the parsed
// output and the sequence of requested URLs.
const run = async (
  id: string,
  args: Record<string, unknown>,
  responses: Response[]
): Promise<{ out: unknown; urls: string[] }> => {
  const fetchImpl = vi.fn()
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r)
  const out = await new ParserEngine({ fetchImpl }).call(tool(id), args, {})
  return { out, urls: fetchImpl.mock.calls.map((c) => c[0] as string) }
}

const B = 'https://www.ebi.ac.uk/chembl/api/data'

// ── the ChEMBL tools are exposed ──────────────────────────
describe('chembl / registry', () => {
  it('exposes the existing tools and assay lookup', () => {
    expect(CHEMBL_TOOLS.map((t) => t.id).sort()).toEqual([
      'compound_search',
      'drug_search',
      'get_admet',
      'get_assay',
      'get_bioactivity',
      'get_mechanism',
      'target_search'
    ])
    for (const t of CHEMBL_TOOLS) {
      expect(t.connector).toBe('chembl')
      expect(t.returns).toBeTruthy()
      expect(t.example).toContain('host.mcp("chembl"')
    }
  })
})

// ── compound_search ──────────────────────────────────────────────────────────
describe('chembl / compound_search', () => {
  const ASPIRIN = {
    molecule_chembl_id: 'CHEMBL25',
    pref_name: 'ASPIRIN',
    molecule_type: 'Small molecule',
    max_phase: '4.0',
    first_approval: 1950,
    oral: true,
    topical: 0,
    black_box_warning: 0,
    withdrawn_flag: false,
    molecule_properties: {
      alogp: '1.31',
      full_mwt: '180.16',
      hba: 3,
      full_molformula: 'C9H8O4',
      qed_weighted: '0.55'
    },
    molecule_structures: {
      canonical_smiles: 'CC(=O)Oc1ccccc1C(=O)O',
      standard_inchi_key: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N'
    },
    molecule_synonyms: [{ molecule_synonym: 'Aspirin' }, { molecule_synonym: 'ASA' }],
    atc_classifications: ['A01AD05', 'B01AC06'],
    cross_references: []
  }

  it('name branch: synonym icontains URL, shaped compound record, verified total', async () => {
    const { out, urls } = await run('compound_search', { name: 'aspirin', limit: 5 }, [
      okJson({ molecules: [ASPIRIN], page_meta: { total_count: 8, next: null } })
    ])
    expect(urls[0]).toBe(
      `${B}/molecule.json?molecule_synonyms__molecule_synonym__icontains=aspirin&limit=5&offset=0`
    )
    const o = out as Record<string, unknown>
    expect(o.count).toBe(1)
    expect(o.total).toBe(8)
    expect(o.truncated).toBe(true)
    const c = (o.compounds as Record<string, unknown>[])[0]
    // Numeric strings become numbers; 0/1 become bools; molecular_formula renames full_molformula.
    expect(c.max_phase).toBe(4)
    expect(c.topical).toBe(false)
    expect(c.smiles).toBe('CC(=O)Oc1ccccc1C(=O)O')
    expect(c.synonyms).toEqual(['Aspirin', 'ASA'])
    expect((c.molecule_properties as Record<string, unknown>).molecular_formula).toBe('C9H8O4')
    expect((c.molecule_properties as Record<string, unknown>).alogp).toBe(1.31)
    expect(c.cross_references).toBeNull()
    expect((c.atc_classifications as Record<string, unknown>[])[0].level5).toBe('A01AD05')
  })

  it('name branch: falls back to pref_name__icontains when synonyms match nothing', async () => {
    const { out, urls } = await run('compound_search', { name: 'zzz', max_phase: 4 }, [
      okJson({ molecules: [], page_meta: { total_count: 0, next: null } }),
      okJson({ molecules: [ASPIRIN], page_meta: { total_count: 1, next: null } })
    ])
    expect(urls[0]).toBe(
      `${B}/molecule.json?molecule_synonyms__molecule_synonym__icontains=zzz&max_phase=4&limit=20&offset=0`
    )
    expect(urls[1]).toBe(
      `${B}/molecule.json?pref_name__icontains=zzz&max_phase=4&limit=20&offset=0`
    )
    expect((out as Record<string, unknown>).count).toBe(1)
  })

  it('chembl_id branch: __in lookup, client-side max_phase filter sets total to matches kept', async () => {
    const { out, urls } = await run(
      'compound_search',
      { name: 'x', chembl_id: 'CHEMBL25', max_phase: 3 },
      [okJson({ molecules: [ASPIRIN], page_meta: { total_count: 1, next: null } })]
    )
    expect(urls[0]).toBe(`${B}/molecule.json?molecule_chembl_id__in=CHEMBL25&limit=20&offset=0`)
    const o = out as Record<string, unknown>
    // Aspirin is phase 4, filter wants phase 3 -> dropped -> empty, total counts what the filter kept.
    expect(o.count).toBe(0)
    expect(o.total).toBe(0)
  })

  it('smiles similarity branch: encodes the route, sorts by -similarity then id', async () => {
    const { out, urls } = await run(
      'compound_search',
      { name: 'x', smiles: 'CC(=O)O', similarity_threshold: 90, limit: 5 },
      [
        okJson({
          molecules: [
            { molecule_chembl_id: 'CHEMBL2', similarity: '90' },
            { molecule_chembl_id: 'CHEMBL1', similarity: '100' }
          ],
          page_meta: { total_count: 2, next: null }
        })
      ]
    )
    expect(urls[0]).toBe(`${B}/similarity/CC(%3DO)O/90.json?limit=1000&offset=0`)
    const compounds = (out as Record<string, unknown>).compounds as Record<string, unknown>[]
    expect(compounds.map((c) => c.molecule_chembl_id)).toEqual(['CHEMBL1', 'CHEMBL2'])
    expect(compounds[0].score).toBe(100)
  })

  it('smiles substructure branch: discloses walk_truncated + upstream_total when capped', async () => {
    const molecules = Array.from({ length: 1000 }, (_, i) => ({
      molecule_chembl_id: `CHEMBL${10000 + i}`
    }))
    const { out, urls } = await run(
      'compound_search',
      { name: 'x', smiles: 'c1ccccc1', limit: 2 },
      [okJson({ molecules, page_meta: { total_count: 30000, next: null } })]
    )
    expect(urls[0]).toBe(`${B}/substructure/c1ccccc1.json?limit=1000&offset=0`)
    const o = out as Record<string, unknown>
    expect(o.count).toBe(2)
    // total is the count of what was walked/kept (1000), not the upstream match set.
    expect(o.total).toBe(1000)
    expect(o.walk_truncated).toBe(true)
    expect(o.upstream_total).toBe(30000)
  })
})

// ── drug_search ──────────────────────────────────────────────────────────────
describe('chembl / drug_search', () => {
  const indicationPage = (): Response =>
    okJson({
      drug_indications: [
        {
          drugind_id: 1,
          parent_molecule_chembl_id: 'CHEMBL1',
          max_phase_for_ind: '4.0',
          efo_term: 'hypertension'
        },
        {
          drugind_id: 2,
          parent_molecule_chembl_id: 'CHEMBL2',
          max_phase_for_ind: '2.0',
          efo_term: 'hypertension'
        }
      ],
      page_meta: { total_count: 2, next: null }
    })
  const molecule = (id: string, name: string, phase: string): Record<string, unknown> => ({
    molecule_chembl_id: id,
    pref_name: name,
    max_phase: phase,
    molecule_type: 'Small molecule',
    black_box_warning: 1,
    topical: 0,
    withdrawn_flag: false,
    molecule_properties: { full_mwt: '300.0' }
  })

  it('joins indication rows -> parents -> molecules + warnings (unfiltered, total = distinct parents)', async () => {
    const { out, urls } = await run('drug_search', { indication: 'hypertension', limit: 10 }, [
      indicationPage(),
      okJson({
        molecules: [molecule('CHEMBL1', 'DRUG A', '4.0'), molecule('CHEMBL2', 'DRUG B', '2.0')],
        page_meta: { total_count: 2, next: null }
      }),
      okJson({
        drug_warnings: [
          {
            warning_id: 9,
            parent_molecule_chembl_id: 'CHEMBL1',
            warning_type: 'Withdrawn',
            warning_class: 'Cardiotoxicity',
            warning_country: 'US',
            warning_year: 2005
          }
        ],
        page_meta: { total_count: 1, next: null }
      }),
      okJson({
        molecules: [molecule('CHEMBL1', 'DRUG A', '4.0'), molecule('CHEMBL2', 'DRUG B', '2.0')],
        page_meta: { total_count: 2, next: null }
      })
    ])
    // Indication rows fetched with a lean `only` projection.
    expect(urls[0]).toBe(
      `${B}/drug_indication.json?efo_term__icontains=hypertension&only=drugind_id%2Cparent_molecule_chembl_id%2Cmax_phase_for_ind%2Cefo_term&limit=1000&offset=0`
    )
    expect(urls[1]).toContain('molecule_chembl_id__in=CHEMBL1%2CCHEMBL2')
    expect(urls[1]).toContain('only=molecule_chembl_id%2Cpref_name')
    expect(urls[2]).toBe(
      `${B}/drug_warning.json?parent_molecule_chembl_id__in=CHEMBL1%2CCHEMBL2&limit=1000&offset=0`
    )
    const o = out as Record<string, unknown>
    expect(o.count).toBe(2)
    expect(o.total).toBe(2)
    expect((o.indication_query as Record<string, unknown>).match_field).toBe('efo')
    expect(o.total_indication_rows).toBe(2)
    const drugs = o.drugs as Record<string, unknown>[]
    // Best phase first (phase 4 parent before phase 2); records carry molecule_chembl_id, not parent id.
    expect(drugs[0].molecule_chembl_id).toBe('CHEMBL1')
    expect(drugs[0].best_phase_for_ind).toBe(4)
    expect(drugs[0].black_box_warning).toBe(1)
    expect(drugs[0].topical).toBe(0)
    expect(drugs[0].warning_summary).toEqual([
      {
        warning_type: 'Withdrawn',
        warning_class: 'Cardiotoxicity',
        warning_country: 'US',
        warning_year: 2005
      }
    ])
    expect(drugs[1].warning_summary).toEqual([])
  })

  it('post-filter drug_name joins the full parent set then filters, total = filtered count', async () => {
    const { out } = await run('drug_search', { indication: 'hypertension', drug_name: 'drug b' }, [
      indicationPage(),
      okJson({
        molecules: [molecule('CHEMBL1', 'DRUG A', '4.0'), molecule('CHEMBL2', 'DRUG B', '2.0')],
        page_meta: { total_count: 2, next: null }
      }),
      okJson({ drug_warnings: [], page_meta: { total_count: 0, next: null } }),
      okJson({
        molecules: [molecule('CHEMBL2', 'DRUG B', '2.0')],
        page_meta: { total_count: 1, next: null }
      })
    ])
    const o = out as Record<string, unknown>
    expect(o.count).toBe(1)
    expect(o.total).toBe(1)
    expect((o.drugs as Record<string, unknown>[])[0].pref_name).toBe('DRUG B')
  })
})

// ── get_admet ────────────────────────────────────────────────────────────────
describe('chembl / get_admet', () => {
  it('joins molecule properties into the ADMET subset', async () => {
    const { out, urls } = await run('get_admet', { molecule_chembl_id: 'CHEMBL25' }, [
      okJson({
        molecules: [
          {
            molecule_chembl_id: 'CHEMBL25',
            molecule_properties: {
              alogp: '1.31',
              full_mwt: '180.16',
              full_molformula: 'C9H8O4',
              hba: 3,
              num_ro5_violations: 0
            }
          }
        ],
        page_meta: { total_count: 1, next: null }
      })
    ])
    expect(urls[0]).toBe(`${B}/molecule.json?molecule_chembl_id__in=CHEMBL25&limit=1&offset=0`)
    const o = out as Record<string, unknown>
    expect(o.found).toBe(true)
    const p = o.properties as Record<string, unknown>
    expect(p.molecular_weight).toBe(180.16)
    expect(p.alogp).toBe(1.31)
    expect(p.molecular_formula).toBe('C9H8O4')
  })

  it('returns found:false with a message for an unknown id (not-found path)', async () => {
    const { out } = await run('get_admet', { molecule_chembl_id: 'CHEMBLXXX' }, [
      okJson({ molecules: [], page_meta: { total_count: 0, next: null } })
    ])
    expect(out).toEqual({
      found: false,
      properties: null,
      message: 'No molecule found for CHEMBLXXX'
    })
  })
})

describe('chembl / get_assay', () => {
  it('retrieves experimental context and target-assignment confidence in one request', async () => {
    const assay = {
      assay_chembl_id: 'CHEMBL1217643',
      description: 'Inhibition of human hERG',
      assay_type: 'B',
      assay_type_description: 'Binding',
      assay_category: 'Confirmatory',
      assay_test_type: 'In vitro',
      bao_format: 'BAO_0000219',
      bao_label: 'cell-based format',
      assay_organism: 'Homo sapiens',
      assay_tax_id: 9606,
      assay_strain: null,
      assay_cell_type: 'HEK293',
      cell_chembl_id: 'CHEMBL3307715',
      assay_tissue: null,
      tissue_chembl_id: null,
      assay_subcellular_fraction: null,
      target_chembl_id: 'CHEMBL240',
      confidence_score: '9',
      confidence_description: 'Direct single protein target assigned',
      relationship_type: 'D',
      relationship_description: 'Direct protein target assigned',
      assay_parameters: [{ type: 'TEMPERATURE', value: '25', units: 'C' }],
      assay_classifications: [{ assay_class_id: 1, l1: 'Ion channel' }],
      variant_sequence: { accession: 'Q12809', mutation: 'G628S' },
      document_chembl_id: 'CHEMBL1212834',
      src_id: 1,
      src_assay_id: null
    }
    const { out, urls } = await run('get_assay', { assay_chembl_id: 'CHEMBL1217643' }, [
      okJson({ assays: [assay], page_meta: { total_count: 1, next: null } })
    ])
    expect(urls).toEqual([`${B}/assay.json?assay_chembl_id=CHEMBL1217643&limit=1&offset=0`])
    expect(out).toEqual({ found: true, assay: { ...assay, confidence_score: 9 } })
  })

  it('preserves zero confidence and normalizes absent context', async () => {
    const { out } = await run('get_assay', { assay_chembl_id: 'CHEMBL1' }, [
      okJson({ assays: [{ assay_chembl_id: 'CHEMBL1', confidence_score: 0 }] })
    ])
    expect(out).toMatchObject({
      found: true,
      assay: {
        assay_cell_type: null,
        assay_organism: null,
        target_chembl_id: null,
        confidence_score: 0,
        confidence_description: null,
        assay_parameters: [],
        assay_classifications: []
      }
    })
  })

  it('returns found:false only for an empty successful lookup', async () => {
    const { out } = await run('get_assay', { assay_chembl_id: 'CHEMBL999999999' }, [
      okJson({ assays: [], page_meta: { total_count: 0, next: null } })
    ])
    expect(out).toEqual({
      found: false,
      assay: null,
      message: 'No assay found for CHEMBL999999999'
    })
    await expect(
      run('get_assay', { assay_chembl_id: 'CHEMBL1217643' }, [
        { ok: false, status: 400, text: async () => 'Bad request' } as Response
      ])
    ).rejects.toThrow('HTTP 400')
  })

  it.each([
    null,
    {},
    { assays: null },
    { assays: {} },
    { assays: [null] },
    { assays: ['CHEMBL1'] },
    { assays: [{}] },
    { assays: [{ assay_chembl_id: 'CHEMBL2' }] },
    { assays: [{ assay_chembl_id: 'CHEMBL1' }, { assay_chembl_id: 'CHEMBL1' }] }
  ])('rejects malformed or mismatched assay responses: %j', async (response) => {
    await expect(
      run('get_assay', { assay_chembl_id: 'CHEMBL1' }, [okJson(response)])
    ).rejects.toThrow('Invalid ChEMBL assay response')
  })

  it('requires an assay id before fetching', async () => {
    await expect(run('get_assay', {}, [])).rejects.toThrow('missing required arg: assay_chembl_id')
  })
})

// ── get_bioactivity ──────────────────────────────────────────────────────────
describe('chembl / get_bioactivity', () => {
  it('continues beyond 1,000 records with combined filters and an actual-count cursor', async () => {
    const args = {
      molecule_chembl_id: 'CHEMBL25',
      target_chembl_id: 'CHEMBL240',
      assay_chembl_id: 'CHEMBL1217643',
      activity_type: 'Ki',
      min_pchembl: 0,
      min_value: 0,
      max_value: 100,
      unit: 'nM',
      limit: 1000,
      offset: 1000
    }
    const { out, urls } = await run('get_bioactivity', args, [
      okJson({
        activities: [{ activity_id: 1001 }, { activity_id: 1002 }],
        page_meta: { total_count: 1003, next: '/chembl/api/data/activity.json?offset=1002' }
      })
    ])
    expect(urls).toEqual([
      `${B}/activity.json?molecule_chembl_id=CHEMBL25&target_chembl_id=CHEMBL240&assay_chembl_id=CHEMBL1217643&standard_type=Ki&pchembl_value__gte=0&standard_value__gte=0&standard_value__lte=100&standard_units=nM&limit=1000&offset=1000&order_by=activity_id`
    ])
    expect(out).toMatchObject({
      count: 2,
      total: 1003,
      truncated: true,
      limit: 1000,
      offset: 1000,
      has_more: true,
      next_offset: 1002
    })
    const { out: last, urls: lastUrls } = await run(
      'get_bioactivity',
      { ...args, offset: (out as Record<string, unknown>).next_offset },
      [
        okJson({
          activities: [{ activity_id: 1003 }],
          page_meta: { total_count: 1003, next: null }
        })
      ]
    )
    expect(lastUrls).toEqual([urls[0].replace('offset=1000', 'offset=1002')])
    expect(last).toMatchObject({
      count: 1,
      total: 1003,
      truncated: true,
      offset: 1002,
      has_more: false,
      next_offset: null
    })
  })

  it.each([0, 1000])('terminates an empty page at offset %s', async (offset) => {
    const { out, urls } = await run('get_bioactivity', { assay_chembl_id: 'CHEMBL1', offset }, [
      okJson({ activities: [], page_meta: { total_count: 0, next: null } })
    ])
    expect(urls).toEqual([
      `${B}/activity.json?assay_chembl_id=CHEMBL1&limit=20&offset=${offset}&order_by=activity_id`
    ])
    expect(out).toMatchObject({
      count: 0,
      total: 0,
      offset,
      limit: 20,
      has_more: false,
      next_offset: null
    })
  })

  it.each([
    { activities: [{ activity_id: 1 }], next: '/next', hasMore: true, nextOffset: 101 },
    { activities: [{ activity_id: 1 }], next: null, hasMore: false, nextOffset: null },
    { activities: [], next: null, hasMore: false, nextOffset: null }
  ])(
    'uses explicit continuation when total is absent, preserving the legacy count fallback',
    async ({ activities, next, hasMore, nextOffset }) => {
      const { out, urls } = await run('get_bioactivity', { offset: 100 }, [
        okJson({ activities, page_meta: { next } })
      ])
      expect(urls).toHaveLength(1)
      expect(out).toMatchObject({
        total: activities.length,
        has_more: hasMore,
        next_offset: nextOffset
      })
    }
  )

  it.each([
    null,
    {},
    { activities: null },
    { activities: [null], page_meta: { total_count: 1 } },
    { activities: [{ activity_id: 1 }] },
    { activities: [], page_meta: { total_count: '2000' } },
    { activities: [], page_meta: { total_count: -1 } },
    { activities: [], page_meta: { total_count: 1.5 } },
    { activities: [], page_meta: { total_count: 2000, next: false } },
    { activities: [], page_meta: { next: '' } },
    { activities: [], page_meta: { next: '/next' } },
    { activities: [], page_meta: { total_count: 2000, next: '/next' } },
    { activities: [], page_meta: { total_count: 2000 } },
    { activities: [{ activity_id: 1001 }], page_meta: { total_count: 2000, next: null } },
    { activities: [{ activity_id: 1001 }], page_meta: { total_count: 1001, next: '/next' } },
    { activities: [{ activity_id: 1001 }], page_meta: { total_count: 1000 } }
  ])('rejects absent or contradictory paging evidence: %j', async (response) => {
    await expect(run('get_bioactivity', { offset: 1000 }, [okJson(response)])).rejects.toThrow(
      'Invalid ChEMBL activity response'
    )
  })

  it.each([
    { activities: [{ activity_id: 1001 }], total: 1002, hasMore: true, nextOffset: 1001 },
    { activities: [{ activity_id: 1001 }], total: 1001, hasMore: false, nextOffset: null },
    { activities: [], total: 900, hasMore: false, nextOffset: null }
  ])(
    'uses a valid total when next is absent',
    async ({ activities, total, hasMore, nextOffset }) => {
      const { out } = await run('get_bioactivity', { offset: 1000 }, [
        okJson({ activities, page_meta: { total_count: total } })
      ])
      expect(out).toMatchObject({ total, has_more: hasMore, next_offset: nextOffset })
    }
  )

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10'])(
    'rejects invalid offset %s before fetching',
    async (offset) => {
      await expect(run('get_bioactivity', { offset }, [])).rejects.toThrow(
        'offset must be a non-negative safe integer'
      )
    }
  )

  it('retains default paging and limit clamping for direct callers', async () => {
    const { out, urls } = await run('get_bioactivity', { limit: 1001 }, [
      okJson({ activities: [], page_meta: { total_count: 0, next: null } })
    ])
    expect(urls).toEqual([`${B}/activity.json?limit=1000&offset=0&order_by=activity_id`])
    expect(out).toMatchObject({ offset: 0, limit: 1000, has_more: false, next_offset: null })
  })

  it('single page ordered by activity_id, shaped records, most-potent summary', async () => {
    const { out, urls } = await run(
      'get_bioactivity',
      {
        molecule_chembl_id: 'CHEMBL25',
        activity_type: 'IC50',
        min_pchembl: 6,
        unit: 'nM',
        limit: 10
      },
      [
        okJson({
          activities: [
            {
              activity_id: 1,
              target_pref_name: 'COX-1',
              standard_type: 'IC50',
              standard_value: '50',
              standard_units: 'nM',
              pchembl_value: '7.3',
              ligand_efficiency: { le: '0.4' }
            }
          ],
          page_meta: { total_count: 42, next: '/chembl/api/data/activity.json?offset=1' }
        })
      ]
    )
    expect(urls[0]).toBe(
      `${B}/activity.json?molecule_chembl_id=CHEMBL25&standard_type=IC50&pchembl_value__gte=6&standard_units=nM&limit=10&offset=0&order_by=activity_id`
    )
    const o = out as Record<string, unknown>
    expect(o.count).toBe(1)
    expect(o.total).toBe(42)
    expect(o.truncated).toBe(true)
    const a = (o.activities as Record<string, unknown>[])[0]
    expect(a.standard_value).toBe(50)
    expect(a.pchembl_value).toBe(7.3)
    expect((a.ligand_efficiency as Record<string, unknown>).le).toBe(0.4)
    expect(o.summary).toContain('COX-1: IC50=50nM (pChEMBL=7.30)')
  })
})

// ── get_mechanism ────────────────────────────────────────────────────────────
describe('chembl / get_mechanism', () => {
  it('single page ordered by mec_id with an action-type summary', async () => {
    const { out, urls } = await run('get_mechanism', { molecule_chembl_id: 'CHEMBL25', limit: 5 }, [
      okJson({
        mechanisms: [
          {
            mec_id: 11,
            molecule_chembl_id: 'CHEMBL25',
            action_type: 'INHIBITOR',
            direct_interaction: 1,
            disease_efficacy: 1,
            target_chembl_id: 'CHEMBL221'
          }
        ],
        page_meta: { total_count: 1, next: null }
      })
    ])
    expect(urls[0]).toBe(
      `${B}/mechanism.json?molecule_chembl_id=CHEMBL25&limit=5&offset=0&order_by=mec_id`
    )
    const o = out as Record<string, unknown>
    const m = (o.mechanisms as Record<string, unknown>[])[0]
    expect(m.direct_interaction).toBe(true)
    expect(o.summary).toBe('Primary action types: INHIBITOR (1)')
  })

  it('retries against the parent molecule when the molecule id yields nothing', async () => {
    const { out, urls } = await run('get_mechanism', { molecule_chembl_id: 'CHEMBL1697' }, [
      okJson({ mechanisms: [], page_meta: { total_count: 0, next: null } }),
      okJson({
        mechanisms: [
          { mec_id: 5, action_type: 'BLOCKER', parent_molecule_chembl_id: 'CHEMBL1697' }
        ],
        page_meta: { total_count: 1, next: null }
      })
    ])
    expect(urls[0]).toBe(
      `${B}/mechanism.json?molecule_chembl_id=CHEMBL1697&limit=20&offset=0&order_by=mec_id`
    )
    expect(urls[1]).toBe(
      `${B}/mechanism.json?parent_molecule_chembl_id=CHEMBL1697&limit=20&offset=0&order_by=mec_id`
    )
    expect((out as Record<string, unknown>).count).toBe(1)
  })
})

// ── target_search ────────────────────────────────────────────────────────────
describe('chembl / target_search', () => {
  it('gene_symbol -> component-synonym iexact filter, shaped target record', async () => {
    const { out, urls } = await run(
      'target_search',
      { gene_symbol: 'EGFR', organism: 'Homo sapiens', limit: 5 },
      [
        okJson({
          targets: [
            {
              target_chembl_id: 'CHEMBL203',
              pref_name: 'Epidermal growth factor receptor erbB1',
              target_type: 'SINGLE PROTEIN',
              organism: 'Homo sapiens',
              tax_id: 9606,
              species_group_flag: false,
              cross_references: [],
              target_components: [
                {
                  component_id: 733,
                  accession: 'P00533',
                  relationship: 'SINGLE PROTEIN',
                  target_component_synonyms: [
                    { component_synonym: 'ERBB', syn_type: 'GENE_SYMBOL_OTHER' },
                    { component_synonym: 'EGFR', syn_type: 'GENE_SYMBOL' }
                  ],
                  target_component_xrefs: [
                    { xref_id: 'x1', xref_name: 'n1', xref_src_db: 'UniProt' }
                  ]
                }
              ]
            }
          ],
          page_meta: { total_count: 18, next: null }
        })
      ]
    )
    expect(urls[0]).toBe(
      `${B}/target.json?target_components__target_component_synonyms__component_synonym__iexact=EGFR&organism__icontains=Homo%20sapiens&limit=5&offset=0`
    )
    const o = out as Record<string, unknown>
    expect(o.count).toBe(1)
    expect(o.total).toBe(18)
    const t = (o.targets as Record<string, unknown>[])[0]
    expect(t.cross_references).toBeNull()
    expect(t.score).toBeNull()
    const comp = (t.components as Record<string, unknown>[])[0]
    // gene_symbol is the first GENE_SYMBOL synonym; xrefs carry a null xref_src_url.
    expect(comp.gene_symbol).toBe('EGFR')
    expect((comp.target_component_xrefs as Record<string, unknown>[])[0].xref_src_url).toBeNull()
  })
})
