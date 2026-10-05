import { describe, expect, it, vi, type Mock } from 'vitest'
import { ParserEngine } from '../engine'
import type { ToolDescriptor } from '../types'
import { IEDB_TOOLS } from './iedb'

const tool = (method: string): ToolDescriptor => IEDB_TOOLS.find((t) => t.id === method)!
const call = async (
  method: string,
  args: Record<string, unknown>,
  body: unknown
): Promise<{ result: unknown; url: URL; fetchImpl: Mock<typeof fetch> }> => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body))
  const engine = new ParserEngine({ fetchImpl, retries: 0 })
  const result = await engine.call(tool(method), args, {})
  return { result, url: new URL(String(fetchImpl.mock.calls[0][0])), fetchImpl }
}

// Reduced production records and embedded exports observed from IQ-API on 2026-10-02.
const tcell = {
  tcell_id: 1957578,
  structure_id: 161694,
  linear_sequence: 'SGMAEATSLDTMTQM',
  host_organism_iri: 'NCBITaxon:9606',
  source_organism_iri: 'NCBITaxon:83332',
  qualitative_measure: 'Negative',
  reference_id: 1023094,
  pubmed_id: '22504645',
  reference_type: 'Literature',
  parent_source_antigen_iri: 'UNIPROT:P9WNJ9',
  curated_source_antigen: {
    iri: 'GENPEPT:NP_215554.1',
    starting_position: 46,
    ending_position: 60
  },
  pdb_id: null,
  tcell_export: [
    {
      assay__method: 'ELISPOT',
      assay__response_measured: 'IFNg release',
      assay__units: null,
      assay__quantitative_measurement: null,
      assay__number_of_subjects_tested: 3,
      assay__number_of_subjects_positive: 0,
      assay__response_frequency_: 0,
      assay__location_of_assay_data_in_reference: 'Figure 4B'
    }
  ]
}

describe('IEDB IQ-API', () => {
  it.each(['tcr', 'bcr'])(
    'keeps %s receptor CDR3, epitope and reference filters distinct',
    async (kind) => {
      const exportField = `${kind}_export`
      const evidence = {
        receptor__iedb_receptor_id: 123,
        reference__iedb_iri: 'https://www.iedb.org/reference/1023094',
        epitope__iedb_iri: 'https://www.iedb.org/epitope/25750',
        chain_1__cdr3_curated: 'CASSLAPGATNEKLFF',
        chain_1__cdr3_calculated: null,
        chain_1__curated_v_gene: 'TRBV7-9',
        chain_1__calculated_v_gene: null
      }
      const row = {
        receptor_group_id: 27233,
        parent_source_antigen_iris: ['UNIPROT:P01012'],
        pdb_ids: ['1vac'],
        qualitative_measures: ['Negative'],
        [exportField]: [evidence]
      }
      const { result, url, fetchImpl } = await call(
        `search_${kind}s`,
        {
          receptor_group_id: 27233,
          sequence: 'siinfekl',
          chain1_cdr3: 'casslapgatneklff',
          chain2_cdr3: 'cavrdsggyqkvtf',
          epitope_id: 25750,
          reference_id: 1023094,
          host_taxonomy_id: 9606,
          uniprot_accession: 'P01012',
          mhc_allele: 'HLA-A*02:01',
          qualitative_measure: 'Negative',
          limit: 1
        },
        [row, { receptor_group_id: 27234, [exportField]: [] }]
      )
      expect(url.pathname).toBe(`/${kind}_search`)
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        receptor_group_id: 'eq.27233',
        linear_sequences: 'cs.{"SIINFEKL"}',
        chain1_cdr3_seq: 'eq.CASSLAPGATNEKLFF',
        chain2_cdr3_seq: 'eq.CAVRDSGGYQKVTF',
        structure_ids: 'cs.{"25750"}',
        reference_ids: 'cs.{"1023094"}',
        host_organism_iri_search: 'cs.{"NCBITaxon:9606"}',
        parent_source_antigen_iris: 'cs.{"UNIPROT:P01012"}',
        mhc_allele_names: 'cs.{"HLA-A*02:01"}',
        qualitative_measures: 'cs.{"Negative"}',
        order: 'receptor_group_id.asc',
        limit: '2'
      })
      expect(url.searchParams.has('linear_sequence')).toBe(false)
      expect(url.searchParams.get('select')).toContain(`${exportField}(*)`)
      expect(result).toMatchObject({
        returned: 1,
        has_more: true,
        next_offset: 1,
        records: [
          {
            ...row,
            cross_references: {
              parent_uniprot_accessions: ['P01012'],
              curated_uniprot_accessions: [],
              pdb_ids: ['1VAC']
            }
          }
        ]
      })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['tcr', 'bcr'])('rejects malformed %s receptor evidence', async (kind) => {
    for (const row of [
      { receptor_group_id: '27233', [`${kind}_export`]: [] },
      { receptor_group_id: 27233 },
      { receptor_group_id: 27233, [`${kind}_export`]: {} }
    ]) {
      await expect(call(`search_${kind}s`, { epitope_id: 25750 }, [row])).rejects.toThrow(/IEDB/)
    }
    const { result } = await call(`search_${kind}s`, { epitope_id: 25750 }, [])
    expect(result).toMatchObject({ records: [], returned: 0, has_more: false, next_offset: null })
  })

  it.each(['tcr', 'bcr'])('rejects invalid records inside %s export arrays', async (kind) => {
    for (const record of [null, 'invalid', 42, false, []]) {
      await expect(
        call(`search_${kind}s`, { receptor_group_id: 47 }, [
          { receptor_group_id: 47, [`${kind}_export`]: [{}, record] }
        ])
      ).rejects.toThrow('IEDB returned an invalid record')
    }
  })

  it.each(['tcr', 'bcr'])(
    'preserves distinct %s evidence rows and nullable annotations within one group',
    async (kind) => {
      const records = [
        {
          receptor__iedb_receptor_id: 57,
          reference__iedb_iri: 'https://www.iedb.org/reference/1023094',
          chain_1__cdr3_curated: null,
          chain_1__cdr3_calculated: 'IVVRSSNTGKLI'
        },
        {
          receptor__iedb_receptor_id: 57,
          reference__iedb_iri: 'https://www.iedb.org/reference/1002786',
          chain_1__cdr3_curated: 'IVVRSSNTGKLI'
        },
        {}
      ]
      const { result } = await call(`search_${kind}s`, { receptor_group_id: 47, limit: 1 }, [
        { receptor_group_id: 47, [`${kind}_export`]: records }
      ])
      expect(result).toMatchObject({ returned: 1, has_more: false, next_offset: null })
      expect(result).toHaveProperty(['records', 0, `${kind}_export`], records)
    }
  )

  it('uses unique ordering and lookahead without inventing totals or joining unrelated evidence', async () => {
    const { result, url, fetchImpl } = await call(
      'search_epitopes',
      { sequence: 'siinfekl', limit: 1, offset: 2 },
      [
        {
          structure_id: 10,
          parent_source_antigen_iris: ['UNIPROT:P01012'],
          pdb_ids: ['1vac'],
          curated_source_antigens: [
            { iri: 'UNIPROT:P01012-2', starting_position: 257, ending_position: 264 }
          ]
        },
        { structure_id: 11 }
      ]
    )
    expect(url.origin).toBe('https://query-api.iedb.org')
    expect(url.pathname).toBe('/epitope_search')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      linear_sequence: 'eq.SIINFEKL',
      order: 'structure_id.asc',
      limit: '2',
      offset: '2'
    })
    expect(result).toMatchObject({
      returned: 1,
      has_more: true,
      next_offset: 3,
      records: [
        {
          structure_id: 10,
          cross_references: {
            parent_uniprot_accessions: ['P01012'],
            curated_uniprot_accessions: ['P01012-2'],
            pdb_ids: ['1VAC']
          }
        }
      ]
    })
    expect(result).not.toHaveProperty('total')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('requires a biological or evidence filter before reading a broad IEDB table page', async () => {
    await expect(call('search_epitopes', {}, [])).rejects.toThrow(/at least one .* filter/)
  })

  it.each(['search_epitopes', 'search_antigens', 'search_references'])(
    'encodes array filters for %s, including literal HLA asterisks and quoted antigen names',
    async (method) => {
      const { url } = await call(
        method,
        {
          host_taxonomy_id: 9606,
          source_taxonomy_id: 83332,
          uniprot_accession: 'P9WNJ9',
          mhc_allele: 'HLA-A*02:01',
          mhc_class: 'I',
          qualitative_measure: 'Negative',
          assay_iri: 'OBI:0001489',
          pdb_id: '1vac'
        },
        []
      )
      expect(url.searchParams.get('host_organism_iri_search')).toBe('cs.{"NCBITaxon:9606"}')
      expect(url.searchParams.get('source_organism_iri_search')).toBe('cs.{"NCBITaxon:83332"}')
      expect(url.searchParams.get('mhc_allele_names')).toBe('cs.{"HLA-A*02:01"}')
      expect(url.searchParams.get('qualitative_measures')).toBe('cs.{"Negative"}')
      expect(url.searchParams.get('pdb_ids')).toBe('cs.{"1VAC"}')
      expect(url.searchParams.get('assay_iri_search')).toBe('cs.{"OBI:0001489"}')
      expect(
        url.searchParams.get(
          method === 'search_antigens' ? 'parent_source_antigen_iri' : 'parent_source_antigen_iris'
        )
      ).toBe(method === 'search_antigens' ? 'eq.UNIPROT:P9WNJ9' : 'cs.{"UNIPROT:P9WNJ9"}')
    }
  )

  it('escapes antigen array values without introducing extra parameters', async () => {
    const name = 'protein "A", beta\\chain &select=*'
    const { url } = await call('search_antigens', { antigen_name: name }, [])
    expect(url.searchParams.get('parent_source_antigen_names')).toBe(`cs.{${JSON.stringify(name)}}`)
    expect(url.searchParams.getAll('select')).toHaveLength(1)
    expect(url.searchParams.get('order')).toBe('parent_source_antigen_iri.asc')
  })

  it('keeps host/source, curated/parent antigen, zero response and negative evidence separate', async () => {
    const { result, url } = await call(
      'search_tcell_assays',
      {
        epitope_id: 161694,
        assay_id: 1957578,
        reference_id: 1023094,
        host_taxonomy_id: 9606,
        source_taxonomy_id: 83332,
        mhc_allele: 'HLA-A*02:01',
        qualitative_measure: 'Negative'
      },
      [tcell]
    )
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      structure_id: 'eq.161694',
      tcell_id: 'eq.1957578',
      reference_id: 'eq.1023094',
      mhc_allele_name: 'eq.HLA-A*02:01',
      qualitative_measure: 'eq.Negative'
    })
    expect(result).toMatchObject({
      has_more: false,
      next_offset: null,
      records: [
        {
          ...tcell,
          cross_references: {
            parent_uniprot_accessions: ['P9WNJ9'],
            curated_uniprot_accessions: [],
            pdb_ids: []
          }
        }
      ]
    })
    expect(url.searchParams.get('select')).toContain('tcell_export(')
    expect(url.searchParams.get('select')).toContain('epitope_structure_defined')
    expect(url.searchParams.get('select')).toContain('assay__number_of_subjects_positive')
  })

  it('uses B-cell-specific evidence field names', async () => {
    const bcell = {
      bcell_id: 1854962,
      bcell_export: [
        {
          assay__method: 'western blot',
          assay__qualitative_measure: 'Negative',
          assay__location_of_assay_data_in_reference: 'Figures 1 and 2'
        }
      ]
    }
    const { result, url } = await call('search_bcell_assays', { assay_id: 1854962 }, [bcell])
    expect(url.searchParams.get('select')).toContain('assay__qualitative_measure,')
    expect(url.searchParams.get('select')).not.toContain('assay__qualitative_measurement')
    expect(result).toMatchObject({ records: [bcell] })
  })

  it('preserves MHC measurement inequalities and units and keeps submissions distinct from publications', async () => {
    const mhc = {
      elution_id: 1406346,
      reference_type: 'Submission',
      pubmed_id: null,
      qualitative_measure: 'Negative',
      mhc_export: [
        {
          assay__method: 'purified MHC/direct/fluorescence',
          assay__response_measured: 'dissociation constant KD (~EC50)',
          assay__measurement_inequality: '=',
          assay__quantitative_measurement: 13000,
          assay__units: 'nM'
        }
      ]
    }
    const { result, url } = await call('search_mhc_assays', { assay_id: 1406346 }, [mhc])
    expect(url.searchParams.get('elution_id')).toBe('eq.1406346')
    expect(url.searchParams.get('order')).toBe('elution_id.asc')
    expect(url.searchParams.get('select')).toContain('assay__number_of_subjects_responded')
    expect(result).toMatchObject({ records: [mhc] })
  })

  it('links references by IEDB ID, epitope membership and PMID without confusing namespaces', async () => {
    const reference = {
      reference_id: 1023094,
      pubmed_id: '22504645',
      structure_ids: [161694],
      reference_title: 'Dissecting mechanisms of immunodominance',
      reference_author: 'Cecilia S Lindestam Arlehamn',
      reference_date: '2012'
    }
    const { result, url } = await call(
      'search_references',
      { epitope_id: 161694, reference_id: 1023094, pubmed_id: '22504645' },
      [reference]
    )
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      structure_ids: 'cs.{"161694"}',
      reference_id: 'eq.1023094',
      pubmed_id: 'eq.22504645'
    })
    expect(result).toMatchObject({ records: [reference] })
    expect(url.searchParams.get('select')).toContain('reference_export(')
    expect(url.searchParams.get('select')).toContain('reference__type')
  })

  it('returns an empty page without treating it as missing or negative evidence', async () => {
    const { result } = await call('search_epitopes', { sequence: 'NOSUCHPEPTIDE' }, [])
    expect(result).toMatchObject({ returned: 0, records: [], has_more: false, next_offset: null })
  })

  it.each([null, {}, { message: 'upstream error' }, [null], [{}], [{ structure_id: '1' }]])(
    'rejects malformed upstream pages: %j',
    async (body) => {
      await expect(call('search_epitopes', { sequence: 'SIINFEKL' }, body)).rejects.toThrow(/IEDB/)
    }
  )

  it('rejects missing experiment evidence and pagination outside the supported window', async () => {
    await expect(
      call('search_tcell_assays', { sequence: 'SIINFEKL' }, [{ tcell_id: 1 }])
    ).rejects.toThrow(/export evidence/)
    await expect(
      call('search_epitopes', { sequence: 'SIINFEKL', limit: 1 }, [
        { structure_id: 1 },
        { structure_id: 2 },
        { structure_id: 3 }
      ])
    ).rejects.toThrow(/result page/)
    await expect(
      call('search_epitopes', { sequence: 'SIINFEKL', limit: 1, offset: 1000000 }, [
        { structure_id: 1 },
        { structure_id: 2 }
      ])
    ).rejects.toThrow(/narrow the filters/)
  })

  it('propagates HTTP errors and cancellation through the shared engine', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('unavailable', { status: 503 }))
    const engine = new ParserEngine({ fetchImpl, retries: 0 })
    await expect(
      engine.call(tool('search_epitopes'), { sequence: 'SIINFEKL' }, {})
    ).rejects.toThrow(/503/)
    const controller = new AbortController()
    controller.abort()
    fetchImpl.mockClear()
    await expect(engine.call(tool('search_epitopes'), {}, {}, controller.signal)).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
