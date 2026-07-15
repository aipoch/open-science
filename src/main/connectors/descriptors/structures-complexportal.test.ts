import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { STRUCTURES_COMPLEXPORTAL_TOOLS } from './structures-complexportal'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const errRes = (status: number): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    headers: { get: () => null }
  }) as unknown as Response

const tool = (id: string): (typeof STRUCTURES_COMPLEXPORTAL_TOOLS)[number] => {
  const t = STRUCTURES_COMPLEXPORTAL_TOOLS.find((x) => x.id === id)
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

// A representative /complex/{AC} response (fields the parser reads).
const complex = (ac: string): Record<string, unknown> => ({
  complexAc: ac,
  ac: 'EBI-9008420',
  name: 'Hemoglobin HbA complex',
  systematicName: 'HBA1:HBB',
  synonyms: ['HbA', 'Adult hemoglobin'],
  species: 'Homo sapiens; 9606',
  predictedComplex: false,
  evidenceType: {
    identifier: 'ECO:0000353',
    description: 'physical interaction evidence',
    confidenceScore: 5
  },
  participants: [
    {
      identifier: 'P69905',
      name: 'HBA1',
      description: 'Hemoglobin subunit alpha',
      interactorType: 'protein',
      interactorTypeMI: 'MI:0326',
      bioRole: 'enzyme',
      bioRoleMI: 'MI:0501',
      stochiometry: 'minValue: 2, maxValue: 2'
    },
    {
      identifier: 'CHEBI:30413',
      name: 'heme',
      interactorType: 'small molecule',
      interactorTypeMI: 'MI:0328',
      bioRole: 'cofactor',
      bioRoleMI: 'MI:0682',
      stochiometry: 'minValue: 4, maxValue: 4'
    }
  ],
  crossReferences: [
    {
      database: 'gene ontology',
      identifier: 'GO:0005833',
      qualifier: 'cellular component',
      description: 'hemoglobin complex'
    },
    {
      database: 'gene ontology',
      identifier: 'GO:0005344',
      qualifier: 'molecular function',
      description: 'oxygen carrier activity'
    },
    {
      database: 'intact',
      identifier: 'EBI-1029796',
      qualifier: 'Experimental evidence',
      description: null
    }
  ],
  functions: ['Transports oxygen'],
  complexAssemblies: ['Heterotetramer'],
  releaseDates: ['2015-01-01']
})

describe('complexportal_get_complexes', () => {
  it('fetches records in de-duplicated input order and lists unknowns in not_found', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/complex/CPX-2158')) return Promise.resolve(jsonRes(complex('CPX-2158')))
      if (url.includes('/complex/CPX-2419')) return Promise.resolve(jsonRes(complex('CPX-2419')))
      // Unknown accession -> 404, surfaced by the engine as a throw.
      return Promise.resolve(errRes(404))
    })
    const out = (await run(
      'complexportal_get_complexes',
      // CPX-2419 duplicated + whitespace; CPX-9999999 unknown.
      { complex_acs: ['CPX-2419', 'CPX-2158', ' CPX-2419 ', 'CPX-9999999'] },
      fetchImpl
    )) as {
      n_requested: number
      records: Array<Record<string, unknown>>
      not_found: string[]
    }
    // Input order preserved after de-duplication (CPX-2419 kept at its first position).
    expect(out.records.map((r) => r.complex_ac)).toEqual(['CPX-2419', 'CPX-2158'])
    expect(out.not_found).toEqual(['CPX-9999999'])
    expect(out.n_requested).toBe(3)
    // AC is URL-encoded in the path.
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/complex/CPX-2419')
  })

  it('shapes a complex record: split species, parsed stoichiometry, sorted participants + GO split', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(complex('CPX-2158')))
    const out = (await run(
      'complexportal_get_complexes',
      { complex_acs: ['CPX-2158'] },
      fetchImpl
    )) as { records: Array<Record<string, unknown>> }
    const rec = out.records[0]
    expect(rec.complex_ac).toBe('CPX-2158')
    expect(rec.intact_ac).toBe('EBI-9008420')
    expect(rec.species_name).toBe('Homo sapiens')
    expect(rec.taxid).toBe(9606)
    // Synonyms sorted deterministically.
    expect(rec.synonyms).toEqual(['Adult hemoglobin', 'HbA'])
    expect(rec.evidence).toEqual({
      eco_code: 'ECO:0000353',
      description: 'physical interaction evidence',
      confidence_score: 5
    })
    // Participants sorted by (interactor_type, identifier): 'protein' before 'small molecule'.
    const parts = rec.participants as Array<Record<string, unknown>>
    expect(parts.map((p) => p.identifier)).toEqual(['P69905', 'CHEBI:30413'])
    expect(parts[0].biological_role).toBe('enzyme')
    expect(parts[0].stoichiometry_min).toBe(2)
    expect(parts[1].stoichiometry_min).toBe(4)
    expect(parts[1].stoichiometry_max).toBe(4)
    // Both GO xrefs (database 'gene ontology') routed to go_annotations, sorted by go_id.
    const go = rec.go_annotations as Array<Record<string, unknown>>
    expect(go.map((g) => g.go_id)).toEqual(['GO:0005344', 'GO:0005833'])
    expect(go[0]).toEqual({
      go_id: 'GO:0005344',
      aspect: 'molecular function',
      term: 'oxygen carrier activity'
    })
    // Non-GO xref stays in cross_references.
    const xrefs = rec.cross_references as Array<Record<string, unknown>>
    expect(xrefs.map((x) => x.database)).toEqual(['intact'])
  })

  it('propagates a non-404 failure instead of swallowing it as not_found', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errRes(500))
    await expect(
      run('complexportal_get_complexes', { complex_acs: ['CPX-2158'] }, fetchImpl)
    ).rejects.toThrow(/HTTP 500/)
  })
})

// A representative /search element (fields the parser reads).
const searchElement = (ac: string): Record<string, unknown> => ({
  complexAC: ac,
  complexName: `Complex ${ac}`,
  organismName: 'Homo sapiens; 9606',
  predictedComplex: false,
  interactors: [
    {
      identifier: 'P02042',
      name: 'HBD',
      interactorType: 'protein',
      stochiometry: 'minValue: 2, maxValue: 2'
    },
    {
      identifier: 'CHEBI:30413',
      name: 'heme',
      interactorType: 'small molecule',
      stochiometry: null
    }
  ]
})

describe('complexportal_search_by_participant', () => {
  it('field-qualifies as pxref by default, pages fully, count-verifies, sorts by CPX number', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      // Two pages of a 3-result set (page size irrelevant to the mock; first= drives paging).
      if (url.includes('first=0')) {
        return Promise.resolve(
          jsonRes({
            totalNumberOfResults: 3,
            elements: [searchElement('CPX-2158'), searchElement('CPX-15202')]
          })
        )
      }
      return Promise.resolve(
        jsonRes({ totalNumberOfResults: 3, elements: [searchElement('CPX-915')] })
      )
    })
    const out = (await run(
      'complexportal_search_by_participant',
      { accession: 'P69905' },
      fetchImpl
    )) as {
      query_accession: string
      solr_query: string
      total_reported: number
      total_retrieved: number
      complexes: Array<Record<string, unknown>>
    }
    // Default participants_only=true -> field-qualified pxref:"..." query (URL-encoded).
    const url0 = String(fetchImpl.mock.calls[0][0])
    expect(url0).toContain(encodeURIComponent('pxref:"P69905"'))
    expect(out.solr_query).toBe('pxref:"P69905"')
    expect(out.query_accession).toBe('P69905')
    // Two pages fetched to retrieve all 3 rows.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(out.total_reported).toBe(3)
    expect(out.total_retrieved).toBe(3)
    // Sorted by numeric CPX accession: 915 < 2158 < 15202.
    expect(out.complexes.map((c) => c.complex_ac)).toEqual(['CPX-915', 'CPX-2158', 'CPX-15202'])
    // Compact record shape with split species and sorted interactors.
    expect(out.complexes[0]).toEqual({
      complex_ac: 'CPX-915',
      name: 'Complex CPX-915',
      species_name: 'Homo sapiens',
      taxid: 9606,
      predicted_complex: false,
      interactors: [
        {
          identifier: 'P02042',
          name: 'HBD',
          interactor_type: 'protein',
          stoichiometry_raw: 'minValue: 2, maxValue: 2'
        },
        {
          identifier: 'CHEBI:30413',
          name: 'heme',
          interactor_type: 'small molecule',
          stoichiometry_raw: null
        }
      ]
    })
  })

  it('with participants_only=false submits the bare accession as free text', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ totalNumberOfResults: 0, elements: [] }))
    const out = (await run(
      'complexportal_search_by_participant',
      { accession: 'P69905', participants_only: false },
      fetchImpl
    )) as { solr_query: string; total_retrieved: number }
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('/search/P69905?')
    expect(url).not.toContain('pxref')
    expect(out.solr_query).toBe('P69905')
    expect(out.total_retrieved).toBe(0)
  })

  it('throws loudly when the retrieved row count disagrees with the reported total', async () => {
    // Reports 5 total but yields only 1 row and no further pages -> mismatch must fail.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({ totalNumberOfResults: 5, elements: [searchElement('CPX-1')] })
      )
      .mockResolvedValue(jsonRes({ totalNumberOfResults: 5, elements: [] }))
    await expect(
      run('complexportal_search_by_participant', { accession: 'P69905' }, fetchImpl)
    ).rejects.toThrow(/pagination mismatch.*retrieved 1 of 5/)
  })
})
