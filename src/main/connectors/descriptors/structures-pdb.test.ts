import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { STRUCTURES_PDB_TOOLS } from './structures-pdb'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

// Zero-hit search: RCSB answers HTTP 204 with an empty body, so Response.json() throws a JSON
// parse error. The engine treats 204 as ok, so the throw surfaces from .json() exactly like this.
const res204 = (): Response =>
  ({
    ok: true,
    status: 204,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input')
    }
  }) as unknown as Response

const errRes = (status: number): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    headers: { get: () => null }
  }) as unknown as Response

const tool = (id: string): (typeof STRUCTURES_PDB_TOOLS)[number] => {
  const t = STRUCTURES_PDB_TOOLS.find((x) => x.id === id)
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

// A representative RCSB data-API entry object (subset confirmed live against 1TUP).
const entry1TUP = {
  rcsb_id: '1TUP',
  struct: { title: 'TUMOR SUPPRESSOR P53 COMPLEXED WITH DNA' },
  exptl: [{ method: 'X-RAY DIFFRACTION' }],
  rcsb_entry_info: {
    resolution_combined: [2.2],
    structure_determination_methodology: 'experimental',
    molecular_weight: 86.84,
    assembly_count: 1,
    polymer_entity_count: 3,
    polymer_entity_count_protein: 1,
    polymer_entity_count_DNA: 2,
    polymer_entity_count_RNA: 0,
    nonpolymer_entity_count: 1,
    polymer_composition: 'protein/NA',
    nonpolymer_bound_components: ['ZN']
  },
  rcsb_accession_info: {
    deposit_date: '1995-07-11T00:00:00.000+00:00',
    initial_release_date: '1995-07-11T00:00:00.000+00:00',
    revision_date: '2024-02-14T00:00:00.000+00:00',
    status_code: 'REL'
  },
  rcsb_entry_container_identifiers: {
    polymer_entity_ids: ['1', '2', '3'],
    non_polymer_entity_ids: ['4']
  },
  rcsb_primary_citation: {
    title: 'Crystal structure of a p53 tumor suppressor-DNA complex.',
    rcsb_journal_abbrev: 'Science',
    year: 1994,
    rcsb_authors: ['Cho, Y.', 'Pavletich, N.P.'],
    pdbx_database_id_PubMed: 8023157,
    pdbx_database_id_DOI: null
  }
}

describe('pdb_search_structures', () => {
  it('builds an AND query from filters, POSTs to the search API, maps records + truncation', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        total_count: 5722,
        result_set: [
          { identifier: '2MW4', score: 1.0 },
          { identifier: '2WTT', score: 0.99 }
        ]
      })
    )
    const out = (await run(
      'pdb_search_structures',
      {
        uniprot_accession: 'P04637',
        experimental_method: 'x-ray diffraction',
        max_resolution_angstrom: 2.5,
        max_rows: 2
      },
      fetchImpl
    )) as {
      total_count: number
      n_retrieved: number
      truncated: boolean
      max_rows: number
      records: Array<{ pdb_id: string; score: number }>
    }
    // Search is a POST to search.rcsb.org.
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://search.rcsb.org/rcsbsearch/v2/query')
    const init = fetchImpl.mock.calls[0][1] as { method?: string; body?: string }
    expect(init.method).toBe('POST')
    const payload = JSON.parse(init.body as string)
    // Two nodes (uniprot accession + name) plus method + resolution -> AND group.
    expect(payload.query.type).toBe('group')
    expect(payload.query.logical_operator).toBe('and')
    const attrs = payload.query.nodes.map(
      (n: { service?: string; parameters?: { attribute?: string } }) =>
        n.service === 'full_text' ? 'full_text' : n.parameters?.attribute
    )
    expect(attrs).toContain(
      'rcsb_polymer_entity_container_identifiers.reference_sequence_identifiers.database_accession'
    )
    expect(attrs).toContain('exptl.method')
    expect(attrs).toContain('rcsb_entry_info.resolution_combined')
    // experimental_method is upper-cased against the controlled vocabulary.
    const methodNode = payload.query.nodes.find(
      (n: { parameters?: { attribute?: string } }) => n.parameters?.attribute === 'exptl.method'
    )
    expect(methodNode.parameters.value).toBe('X-RAY DIFFRACTION')
    expect(payload.request_options.paginate).toEqual({ start: 0, rows: 2 })
    expect(payload.request_options.results_content_type).toEqual(['experimental'])

    expect(out.total_count).toBe(5722)
    expect(out.n_retrieved).toBe(2)
    expect(out.truncated).toBe(true)
    expect(out.max_rows).toBe(2)
    expect(out.records).toEqual([
      { pdb_id: '2MW4', score: 1.0 },
      { pdb_id: '2WTT', score: 0.99 }
    ])
  })

  it('uses a single terminal node (no AND group) for one filter and adds computed models', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ total_count: 1, result_set: [{ identifier: '1ABC' }] }))
    await run(
      'pdb_search_structures',
      { text: 'p53 DNA binding', include_computed_models: true },
      fetchImpl
    )
    const payload = JSON.parse((fetchImpl.mock.calls[0][1] as { body: string }).body)
    expect(payload.query.type).toBe('terminal')
    expect(payload.query.service).toBe('full_text')
    expect(payload.request_options.results_content_type).toEqual(['experimental', 'computational'])
  })

  it('returns empty records without throwing when the search yields zero hits (HTTP 204)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(res204())
    const out = (await run('pdb_search_structures', { ligand_comp_id: 'ZZZZZ' }, fetchImpl)) as {
      total_count: number
      n_retrieved: number
      truncated: boolean
      records: unknown[]
    }
    expect(out.total_count).toBe(0)
    expect(out.n_retrieved).toBe(0)
    expect(out.truncated).toBe(false)
    expect(out.records).toEqual([])
  })

  it('pages until the cap is reached, incrementing start by the page length', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: { body: string }) => {
      // The real API returns exactly the requested `rows` window; honour it so paging terminates.
      const { start, rows } = JSON.parse(init.body).request_options.paginate
      const page = Array.from({ length: rows }, (_v, i) => ({
        identifier: `E${start + i}`,
        score: 1
      }))
      return Promise.resolve(jsonRes({ total_count: 500, result_set: page }))
    })
    const out = (await run(
      'pdb_search_structures',
      { text: 'kinase', max_rows: 150 },
      fetchImpl
    )) as { n_retrieved: number; truncated: boolean }
    // 150 rows over a 100-row page size -> two POSTs (rows 100 then 50).
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(
      JSON.parse((fetchImpl.mock.calls[1][1] as { body: string }).body).request_options.paginate
    ).toEqual({ start: 100, rows: 50 })
    expect(out.n_retrieved).toBe(150)
    expect(out.truncated).toBe(true)
  })

  it('throws on an unknown experimental_method with the valid list', async () => {
    const fetchImpl = vi.fn()
    await expect(
      run('pdb_search_structures', { experimental_method: 'MICROSCOPY' }, fetchImpl)
    ).rejects.toThrow(/unknown experimental_method/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws when no search criterion is supplied', async () => {
    await expect(run('pdb_search_structures', {}, vi.fn())).rejects.toThrow(
      /at least one search criterion/
    )
  })
})

describe('pdb_get_structures', () => {
  it('dedupes case-insensitively, skips blanks, maps entries and flags unknown ids', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/entry/1TUP')) return Promise.resolve(jsonRes(entry1TUP))
      // Unknown entry -> 404, surfaced by the engine as an HTTP 404 throw.
      return Promise.resolve(errRes(404))
    })
    const out = (await run(
      'pdb_get_structures',
      { pdb_ids: ['1TUP', '1tup', '  ', '6XYZ'] },
      fetchImpl
    )) as {
      n_requested: number
      n_unique: number
      n_blank_skipped: number
      n_duplicate_skipped: number
      records: Array<Record<string, unknown>>
    }
    expect(out.n_requested).toBe(4)
    expect(out.n_unique).toBe(2)
    expect(out.n_blank_skipped).toBe(1)
    expect(out.n_duplicate_skipped).toBe(1)
    expect(out.records).toHaveLength(2)
    const known = out.records[0]
    expect(known.pdb_id).toBe('1TUP')
    expect(known.experimental_methods).toEqual(['X-RAY DIFFRACTION'])
    expect(known.resolution_angstrom).toBe(2.2)
    expect(known.polymer_entity_ids).toEqual(['1', '2', '3'])
    expect(known.nonpolymer_entity_ids).toEqual(['4'])
    expect(known.ligand_comp_ids).toEqual(['ZN'])
    expect((known.citation as Record<string, unknown>).pubmed_id).toBe(8023157)
    // Unknown id becomes an error-tagged record, upper-cased, never silently dropped.
    expect(out.records[1]).toEqual({ pdb_id: '6XYZ', error: 'not_found' })
  })

  it('throws when the unique id count exceeds the batch cap', async () => {
    const ids = Array.from({ length: 26 }, (_v, i) => `ID${i}`)
    await expect(run('pdb_get_structures', { pdb_ids: ids }, vi.fn())).rejects.toThrow(/max 25/)
  })
})

describe('pdb_get_entities', () => {
  const polymerEntity = (eid: string, seq?: string): Record<string, unknown> => ({
    rcsb_id: `1TUP_${eid}`,
    rcsb_polymer_entity: {
      pdbx_description: 'CELLULAR TUMOR ANTIGEN P53',
      pdbx_number_of_molecules: 1
    },
    rcsb_polymer_entity_container_identifiers: {
      entry_id: '1TUP',
      entity_id: eid,
      asym_ids: ['A'],
      auth_asym_ids: ['A'],
      uniprot_ids: ['P04637'],
      reference_sequence_identifiers: [
        {
          database_name: 'UniProt',
          database_accession: 'P04637',
          entity_sequence_coverage: 1.0,
          reference_sequence_coverage: 0.55
        }
      ]
    },
    entity_poly: {
      rcsb_entity_polymer_type: 'Protein',
      type: 'polypeptide(L)',
      rcsb_sample_sequence_length: seq ? seq.length : 219,
      rcsb_mutation_count: 0,
      pdbx_seq_one_letter_code_can: seq
    },
    rcsb_entity_source_organism: [{ scientific_name: 'Homo sapiens', ncbi_taxonomy_id: 9606 }],
    rcsb_polymer_entity_align: [
      {
        reference_database_name: 'UniProt',
        reference_database_accession: 'P04637',
        aligned_regions: [{ entity_beg_seq_id: 1, length: 219, ref_beg_seq_id: 94 }]
      }
    ]
  })

  it('resolves the full entity list from the entry when entity_ids is null, reporting the true count', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/entry/1TUP')) return Promise.resolve(jsonRes(entry1TUP))
      const eid = url.split('/').pop() as string
      return Promise.resolve(jsonRes(polymerEntity(eid)))
    })
    const out = (await run('pdb_get_entities', { pdb_id: '1tup' }, fetchImpl)) as {
      pdb_id: string
      n_polymer_entities: number | null
      polymer_entity_ids: string[]
      truncated: boolean
      records: Array<Record<string, unknown>>
      not_found: string[]
    }
    // Entry fetched once (to resolve ids) then one call per entity.
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/entry/1TUP')
    expect(out.pdb_id).toBe('1TUP')
    expect(out.n_polymer_entities).toBe(3)
    expect(out.polymer_entity_ids).toEqual(['1', '2', '3'])
    expect(out.truncated).toBe(false)
    expect(out.records).toHaveLength(3)
    expect(out.records[0].uniprot_ids).toEqual(['P04637'])
    expect(out.records[0].uniprot_aligned_regions).toEqual([
      { accession: 'P04637', regions: [{ entity_beg_seq_id: 1, length: 219, ref_beg_seq_id: 94 }] }
    ])
    // Sequences not requested -> the field is absent entirely.
    expect('sequence' in out.records[0]).toBe(false)
    expect(out.not_found).toEqual([])
  })

  it('with an explicit subset leaves n_polymer_entities null and lists unknown entity ids', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/polymer_entity/1TUP/3'))
        return Promise.resolve(jsonRes(polymerEntity('3')))
      return Promise.resolve(errRes(404))
    })
    const out = (await run(
      'pdb_get_entities',
      { pdb_id: '1TUP', entity_ids: ['3', '99'] },
      fetchImpl
    )) as { n_polymer_entities: number | null; records: unknown[]; not_found: string[] }
    // No entry fetch on the explicit-subset branch.
    expect(fetchImpl.mock.calls.every((c) => !String(c[0]).includes('/entry/'))).toBe(true)
    expect(out.n_polymer_entities).toBeNull()
    expect(out.records).toHaveLength(1)
    expect(out.not_found).toEqual(['99'])
  })

  it('throws when an explicit entity_ids list exceeds the cap', async () => {
    const ids = Array.from({ length: 26 }, (_v, i) => String(i))
    await expect(
      run('pdb_get_entities', { pdb_id: '1TUP', entity_ids: ids }, vi.fn())
    ).rejects.toThrow(/max 25/)
  })

  it('includes sequences under budget, but omits them (with sequences_omitted) over max_bytes', async () => {
    const seq = 'M'.repeat(300)
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/entry/1TUP')) return Promise.resolve(jsonRes(entry1TUP))
      const eid = url.split('/').pop() as string
      return Promise.resolve(jsonRes(polymerEntity(eid, seq)))
    })
    const out = (await run(
      'pdb_get_entities',
      { pdb_id: '1TUP', include_sequences: true, max_bytes: 500 },
      fetchImpl
    )) as { records: Array<Record<string, unknown>>; sequences_omitted?: string }
    // 3 entities * 300 bytes = 900 > 500 -> sequences dropped, metadata retained.
    expect(out.sequences_omitted).toMatch(/max_bytes=500/)
    for (const r of out.records) expect('sequence' in r).toBe(false)
    expect(out.records[0].description).toBe('CELLULAR TUMOR ANTIGEN P53')
  })

  it('keeps sequences when the combined size is within max_bytes', async () => {
    const seq = 'MEEP'
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/entry/1TUP')) return Promise.resolve(jsonRes(entry1TUP))
      const eid = url.split('/').pop() as string
      return Promise.resolve(jsonRes(polymerEntity(eid, seq)))
    })
    const out = (await run(
      'pdb_get_entities',
      { pdb_id: '1TUP', include_sequences: true },
      fetchImpl
    )) as { records: Array<Record<string, unknown>>; sequences_omitted?: string }
    expect(out.sequences_omitted).toBeUndefined()
    expect(out.records[0].sequence).toBe('MEEP')
  })
})

describe('pdb_get_ligands', () => {
  const nonpolymer = {
    rcsb_nonpolymer_entity_container_identifiers: {
      entity_id: '4',
      nonpolymer_comp_id: 'ZN',
      auth_asym_ids: ['A', 'B', 'C']
    },
    rcsb_nonpolymer_entity: { pdbx_description: 'ZINC ION', pdbx_number_of_molecules: 3 }
  }
  const chemCompZN = {
    chem_comp: {
      id: 'ZN',
      name: 'ZINC ION',
      formula: 'Zn',
      formula_weight: 65.409,
      pdbx_formal_charge: 2,
      type: 'non-polymer'
    },
    rcsb_chem_comp_descriptor: { InChIKey: 'PTFCDOFLOPIGGS-UHFFFAOYSA-N', SMILES_stereo: '[Zn+2]' }
  }

  it('walks entry -> nonpolymer entities -> chem comps and attaches chemistry', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/entry/1TUP')) return Promise.resolve(jsonRes(entry1TUP))
      if (url.includes('/nonpolymer_entity/1TUP/4')) return Promise.resolve(jsonRes(nonpolymer))
      if (url.includes('/chemcomp/ZN')) return Promise.resolve(jsonRes(chemCompZN))
      return Promise.resolve(errRes(404))
    })
    const out = (await run('pdb_get_ligands', { pdb_id: '1tup' }, fetchImpl)) as {
      pdb_id: string
      n_nonpolymer_entities: number
      n_returned: number
      truncated: boolean
      ligands: Array<Record<string, unknown>>
    }
    expect(out.pdb_id).toBe('1TUP')
    expect(out.n_nonpolymer_entities).toBe(1)
    expect(out.n_returned).toBe(1)
    expect(out.truncated).toBe(false)
    expect(out.ligands[0].comp_id).toBe('ZN')
    expect(out.ligands[0].n_copies_deposited).toBe(3)
    expect(out.ligands[0].auth_asym_ids).toEqual(['A', 'B', 'C'])
    expect(out.ligands[0].chem_comp).toEqual({
      comp_id: 'ZN',
      name: 'ZINC ION',
      formula: 'Zn',
      formula_weight: 65.409,
      formal_charge: 2,
      type: 'non-polymer',
      inchikey: 'PTFCDOFLOPIGGS-UHFFFAOYSA-N',
      smiles: '[Zn+2]'
    })
  })

  it('returns ligands:[] for an entry with no nonpolymer entities', async () => {
    const noLigEntry = {
      ...entry1TUP,
      rcsb_entry_container_identifiers: { polymer_entity_ids: ['1'], non_polymer_entity_ids: [] }
    }
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(noLigEntry))
    const out = (await run('pdb_get_ligands', { pdb_id: '1TUP' }, fetchImpl)) as {
      n_nonpolymer_entities: number
      ligands: unknown[]
    }
    // Only the entry is fetched; no ligand/chemcomp requests.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(out.n_nonpolymer_entities).toBe(0)
    expect(out.ligands).toEqual([])
  })

  it('flags a nonpolymer entity the data API no longer serves inline as not_found', async () => {
    const twoLigEntry = {
      ...entry1TUP,
      rcsb_entry_container_identifiers: {
        polymer_entity_ids: ['1'],
        non_polymer_entity_ids: ['4', '5']
      }
    }
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/entry/1TUP')) return Promise.resolve(jsonRes(twoLigEntry))
      if (url.includes('/nonpolymer_entity/1TUP/4')) return Promise.resolve(jsonRes(nonpolymer))
      if (url.includes('/chemcomp/ZN')) return Promise.resolve(jsonRes(chemCompZN))
      // Entity 5 is gone.
      return Promise.resolve(errRes(404))
    })
    const out = (await run('pdb_get_ligands', { pdb_id: '1TUP' }, fetchImpl)) as {
      n_returned: number
      ligands: Array<Record<string, unknown>>
    }
    expect(out.n_returned).toBe(2)
    expect(out.ligands[0].comp_id).toBe('ZN')
    // Missing entity carries an inline error and a null chem_comp (partial results, not aborted).
    expect(out.ligands[1]).toEqual({
      entity_id: '5',
      comp_id: null,
      error: 'not_found',
      chem_comp: null
    })
  })

  it('caps at max_ligands and reports truncated with the entry true count', async () => {
    const manyLigEntry = {
      ...entry1TUP,
      rcsb_entry_container_identifiers: {
        polymer_entity_ids: ['1'],
        non_polymer_entity_ids: ['4', '5', '6']
      }
    }
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/entry/1TUP')) return Promise.resolve(jsonRes(manyLigEntry))
      if (url.includes('/nonpolymer_entity/')) return Promise.resolve(jsonRes(nonpolymer))
      if (url.includes('/chemcomp/ZN')) return Promise.resolve(jsonRes(chemCompZN))
      return Promise.resolve(errRes(404))
    })
    const out = (await run('pdb_get_ligands', { pdb_id: '1TUP', max_ligands: 1 }, fetchImpl)) as {
      n_nonpolymer_entities: number
      n_returned: number
      truncated: boolean
    }
    expect(out.n_nonpolymer_entities).toBe(3)
    expect(out.n_returned).toBe(1)
    expect(out.truncated).toBe(true)
  })
})
