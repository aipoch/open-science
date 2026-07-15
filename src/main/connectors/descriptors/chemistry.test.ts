import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { CHEMISTRY_TOOLS } from './chemistry'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => CHEMISTRY_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response
const notFoundRes = (): Response => ({ ok: false, status: 404 }) as Response
const engine = (fetchImpl: unknown): ParserEngine =>
  new ParserEngine({ fetchImpl: fetchImpl as typeof fetch })

describe('chemistry tool set', () => {
  it('exposes exactly the 12 upstream tools and drops the removed ones', () => {
    expect(CHEMISTRY_TOOLS.map((t) => t.id).sort()).toEqual(
      [
        'bindingdb_ligands_by_target',
        'bindingdb_targets_by_compound',
        'chebi_get_entity',
        'chebi_get_ontology',
        'chebi_search',
        'pubchem_get_bioassay_summary',
        'pubchem_get_compounds',
        'pubchem_get_safety',
        'pubchem_search_compounds',
        'pubchem_similarity_search',
        'rhea_get_reaction',
        'rhea_search_reactions'
      ].sort()
    )
    for (const removed of ['pubchem_get_properties', 'pubchem_get_image']) {
      expect(CHEMISTRY_TOOLS.find((t) => t.id === removed)).toBeUndefined()
    }
    expect(CHEMISTRY_TOOLS.every((t) => t.connector === 'chemistry')).toBe(true)
  })
})

describe('chemistry / pubchem', () => {
  it('pubchem_search_compounds resolves cids then fetches properties, honouring the cap', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ IdentifierList: { CID: [2244, 999, 1000] } }))
      .mockResolvedValueOnce(jsonRes({ PropertyTable: { Properties: [{ CID: 2244 }] } }))
    const out = (await engine(fetchImpl).call(
      tool('pubchem_search_compounds'),
      { query: 'aspirin', max_cids: 1 },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0]).toContain('/compound/name/aspirin/cids/JSON')
    expect(fetchImpl.mock.calls[1][0]).toContain('/compound/cid/2244/property/')
    expect(fetchImpl.mock.calls[1][0]).toContain('ConnectivitySMILES')
    expect(out).toMatchObject({
      query: 'aspirin',
      namespace: 'name',
      n_cids_total: 3,
      truncated: true,
      cids: [2244],
      properties: [{ CID: 2244 }]
    })
  })

  it('pubchem_search_compounds sends SMILES via a query param and returns [] on no match', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(notFoundRes())
    const out = (await engine(fetchImpl).call(
      tool('pubchem_search_compounds'),
      { query: 'C#N/weird', namespace: 'smiles', with_properties: true },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0]).toContain('/compound/smiles/cids/JSON?smiles=')
    expect(fetchImpl).toHaveBeenCalledTimes(1) // no property call when cids empty
    expect(out).toMatchObject({ n_cids_total: 0, cids: [], properties: [] })
  })

  it('pubchem_search_compounds rejects an unknown namespace', async () => {
    await expect(
      engine(vi.fn()).call(tool('pubchem_search_compounds'), { query: 'x', namespace: 'foo' }, {})
    ).rejects.toThrow(/namespace must be one of/)
  })

  it('pubchem_get_compounds dedupes, reports duplicates and not_found, and attaches synonyms', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({ PropertyTable: { Properties: [{ CID: 2244, MolecularFormula: 'C9H8O4' }] } })
      )
      .mockResolvedValueOnce(
        jsonRes({
          InformationList: { Information: [{ CID: 2244, Synonym: ['aspirin', 'a', 'b'] }] }
        })
      )
    const out = (await engine(fetchImpl).call(
      tool('pubchem_get_compounds'),
      { cids: [2244, 2244, 999], include_synonyms: true, max_synonyms: 2 },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0]).toContain('/compound/cid/2244,999/property/')
    expect(fetchImpl.mock.calls[1][0]).toContain('/compound/cid/2244,999/synonyms/JSON')
    expect(out).toMatchObject({
      n_requested: 3,
      duplicates: [2244],
      not_found: [999],
      records: [
        {
          CID: 2244,
          MolecularFormula: 'C9H8O4',
          synonyms: ['aspirin', 'a'],
          n_synonyms_total: 3,
          synonyms_truncated: true
        }
      ]
    })
  })

  it('pubchem_similarity_search flags may_be_truncated when the cap fills', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ IdentifierList: { CID: [2244, 2] } }))
    const out = (await engine(fetchImpl).call(
      tool('pubchem_similarity_search'),
      { smiles: 'CC(=O)O', threshold: 95, max_records: 2 },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0]).toContain('/compound/fastsimilarity_2d/smiles/cids/JSON')
    expect(fetchImpl.mock.calls[0][0]).toContain('Threshold=95')
    expect(fetchImpl.mock.calls[0][0]).toContain('MaxRecords=2')
    expect(out).toMatchObject({ n_cids: 2, may_be_truncated: true, cids: [2244, 2] })
  })

  it('pubchem_get_bioassay_summary maps columns, filters active before the cap', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        Table: {
          Columns: { Column: ['AID', 'Activity Outcome', 'Assay Name'] },
          Row: [
            { Cell: ['1', 'Active', 'Assay A'] },
            { Cell: ['2', 'Inactive', 'Assay B'] },
            { Cell: ['3', 'Active', 'Assay C'] }
          ]
        }
      })
    )
    const out = (await engine(fetchImpl).call(
      tool('pubchem_get_bioassay_summary'),
      { cid: 2244, active_only: true, max_rows: 1 },
      {}
    )) as Record<string, unknown>
    expect(out).toMatchObject({
      cid: 2244,
      active_only: true,
      n_rows_total: 2,
      truncated: true,
      rows: [{ AID: '1', 'Activity Outcome': 'Active', 'Assay Name': 'Assay A' }]
    })
  })

  it('pubchem_get_bioassay_summary returns [] when the compound has no assay data', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(notFoundRes())
    const out = (await engine(fetchImpl).call(
      tool('pubchem_get_bioassay_summary'),
      { cid: 999999999 },
      {}
    )) as Record<string, unknown>
    expect(out).toMatchObject({ n_rows_total: 0, rows: [] })
  })

  it('pubchem_get_safety parses the GHS Classification section from PUG-View', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        Record: {
          RecordTitle: 'Aspirin',
          Reference: [{}, {}],
          Section: [
            {
              TOCHeading: 'Safety and Hazards',
              Section: [
                {
                  TOCHeading: 'GHS Classification',
                  Information: [
                    { Name: 'Signal', Value: { StringWithMarkup: [{ String: 'Warning' }] } },
                    {
                      Name: 'Pictogram(s)',
                      Value: { StringWithMarkup: [{ Markup: [{ Extra: 'Irritant' }] }] }
                    },
                    {
                      Name: 'GHS Hazard Statements',
                      Value: { StringWithMarkup: [{ String: 'H302 (95%): Harmful if swallowed' }] }
                    }
                  ]
                }
              ]
            }
          ]
        }
      })
    )
    const out = (await engine(fetchImpl).call(tool('pubchem_get_safety'), { cid: 2244 }, {})) as {
      cid: number
      found: boolean
      ghs: Record<string, unknown>
    }
    expect(fetchImpl.mock.calls[0][0]).toContain('/pug_view/data/compound/2244/JSON?heading=')
    expect(out.found).toBe(true)
    expect(out.ghs).toMatchObject({
      cid: 2244,
      record_title: 'Aspirin',
      signals: ['Warning'],
      pictograms: ['Irritant'],
      hazard_statements: ['H302 (95%): Harmful if swallowed'],
      n_source_references: 2
    })
  })

  it('pubchem_get_safety returns found=false / ghs=null when PubChem has no GHS section', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(notFoundRes())
    const out = (await engine(fetchImpl).call(
      tool('pubchem_get_safety'),
      { cid: 1 },
      {}
    )) as Record<string, unknown>
    expect(out).toEqual({ cid: 1, found: false, ghs: null })
  })
})

describe('chemistry / chebi', () => {
  it('chebi_search maps es_search hits and carries the api_total', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        total: 18,
        number_pages: 9,
        results: [
          {
            _score: 12.3,
            _source: {
              chebi_accession: 'CHEBI:27732',
              name: 'caffeine',
              formula: 'C8H10N4O2',
              charge: 0,
              mass: 194.194,
              monoisotopicmass: 194.08,
              smiles: 'Cn1...',
              inchikey: 'RYYVLZVUVIJVGH-UHFFFAOYSA-N',
              stars: 3
            }
          }
        ]
      })
    )
    const out = (await engine(fetchImpl).call(
      tool('chebi_search'),
      { term: 'caffeine', max_results: 2 },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0]).toContain('/es_search/?term=caffeine&size=2&page=1')
    expect(out).toMatchObject({
      term: 'caffeine',
      api_total: 18,
      number_pages: 9,
      results: [
        {
          chebi_accession: 'CHEBI:27732',
          name: 'caffeine',
          monoisotopic_mass: 194.08,
          relevance: 12.3
        }
      ]
    })
  })

  it('chebi_get_entity normalizes names, roles, xrefs and caps synonyms', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        chebi_accession: 'CHEBI:27732',
        name: 'caffeine',
        definition: 'A trimethylxanthine.',
        stars: 3,
        modified_on: '2021-09-20T10:57:24Z',
        is_released: true,
        secondary_ids: ['CHEBI:3295'],
        names: {
          SYNONYM: [{ name: 'guaranine' }, { name: 'thein' }, { name: 'methyltheobromine' }],
          'IUPAC NAME': [{ name: '1,3,7-trimethylpurine-2,6-dione' }]
        },
        chemical_data: {
          formula: 'C8H10N4O2',
          charge: 0,
          mass: '194.19',
          monoisotopic_mass: '194.08'
        },
        default_structure: {
          smiles: 'Cn1...',
          standard_inchi: 'InChI=1S/...',
          standard_inchi_key: 'RYYVLZVUVIJVGH-UHFFFAOYSA-N'
        },
        database_accessions: {
          CITATION: [
            { accession_number: '10213372', source_name: 'PubMed', url: 'http://europepmc.org/x' }
          ]
        },
        roles_classification: [
          { chebi_accession: 'CHEBI:76946', name: 'fungal metabolite', definition: 'x' }
        ]
      })
    )
    const out = (await engine(fetchImpl).call(
      tool('chebi_get_entity'),
      { chebi_id: 'CHEBI:27732', max_synonyms: 2 },
      {}
    )) as Record<string, unknown>
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${'https://www.ebi.ac.uk/chebi/backend/api/public'}/compound/27732/`
    )
    expect(out).toMatchObject({
      chebi_accession: 'CHEBI:27732',
      formula: 'C8H10N4O2',
      monoisotopic_mass: '194.08',
      inchikey: 'RYYVLZVUVIJVGH-UHFFFAOYSA-N',
      iupac_names: ['1,3,7-trimethylpurine-2,6-dione'],
      synonyms: ['guaranine', 'thein'],
      n_synonyms_total: 3,
      synonyms_truncated: true,
      secondary_ids: ['CHEBI:3295'],
      xrefs: [
        { type: 'CITATION', accession: '10213372', source: 'PubMed', url: 'http://europepmc.org/x' }
      ],
      n_xrefs_total: 1,
      roles: [{ chebi_accession: 'CHEBI:76946', name: 'fungal metabolite' }],
      is_released: true
    })
  })

  it('chebi_get_entity throws a not-found error for an unknown id', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(notFoundRes())
    await expect(
      engine(fetchImpl).call(tool('chebi_get_entity'), { chebi_id: '99999999' }, {})
    ).rejects.toThrow(/no ChEBI entity/)
  })

  it('chebi_get_entity rejects a malformed id without a network call', async () => {
    const fetchImpl = vi.fn()
    await expect(
      engine(fetchImpl).call(tool('chebi_get_entity'), { chebi_id: 'nope' }, {})
    ).rejects.toThrow(/not a ChEBI ID/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('chebi_get_ontology splits outgoing/incoming relations and applies a type filter', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        chebi_accession: 'CHEBI:27732',
        name: 'caffeine',
        ontology_relations: {
          outgoing_relations: [
            {
              relation_type: 'has role',
              init_id: 27732,
              init_name: 'caffeine',
              final_id: 35705,
              final_name: 'immunosuppressive agent'
            },
            {
              relation_type: 'is a',
              init_id: 27732,
              init_name: 'caffeine',
              final_id: 26385,
              final_name: 'purine alkaloid'
            }
          ],
          incoming_relations: [
            {
              relation_type: 'has part',
              init_id: 1,
              init_name: 'x',
              final_id: 27732,
              final_name: 'caffeine'
            }
          ]
        }
      })
    )
    const out = (await engine(fetchImpl).call(
      tool('chebi_get_ontology'),
      { chebi_id: '27732', relation_type: 'has role' },
      {}
    )) as Record<string, unknown>
    expect(out).toMatchObject({
      chebi_accession: 'CHEBI:27732',
      relation_type_filter: 'has role',
      outgoing_relations: [
        {
          relation_type: 'has role',
          init_chebi_id: 27732,
          final_chebi_id: 35705,
          final_name: 'immunosuppressive agent'
        }
      ],
      n_outgoing_total: 1,
      incoming_relations: [],
      n_incoming_total: 0
    })
  })
})

describe('chemistry / rhea', () => {
  const chebiRow = {
    accession: { value: 'RHEA:10280' },
    equation: { value: 'A = B' },
    status: { value: 'http://rdf.rhea-db.org/Approved' }
  }

  it('rhea_search_reactions detects a ChEBI query and runs a COUNT companion', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ results: { bindings: [chebiRow] } }))
      .mockResolvedValueOnce(jsonRes({ results: { bindings: [{ n: { value: '3' } }] } }))
    const out = (await engine(fetchImpl).call(
      tool('rhea_search_reactions'),
      { query: 'CHEBI:27732', limit: 1 },
      {}
    )) as Record<string, unknown>
    expect(decodeURIComponent(String(fetchImpl.mock.calls[0][0]))).toContain('SELECT DISTINCT')
    expect(decodeURIComponent(String(fetchImpl.mock.calls[0][0]))).toContain('CHEBI_27732')
    expect(decodeURIComponent(String(fetchImpl.mock.calls[1][0]))).toContain('COUNT(DISTINCT')
    expect(out).toMatchObject({
      query: 'CHEBI:27732',
      query_type: 'chebi',
      api_total: 3,
      n_returned: 1,
      truncated: true,
      reactions: [{ rhea_id: 'RHEA:10280', equation: 'A = B', status: 'Approved' }]
    })
  })

  it('rhea_search_reactions detects a full EC number', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ results: { bindings: [] } }))
      .mockResolvedValueOnce(jsonRes({ results: { bindings: [{ n: { value: '0' } }] } }))
    const out = (await engine(fetchImpl).call(
      tool('rhea_search_reactions'),
      { query: '2.1.1.160' },
      {}
    )) as Record<string, unknown>
    expect(decodeURIComponent(String(fetchImpl.mock.calls[0][0]))).toContain(
      'http://purl.uniprot.org/enzyme/2.1.1.160'
    )
    expect(out).toMatchObject({ query_type: 'ec', api_total: 0, reactions: [] })
  })

  it('rhea_search_reactions does a case-insensitive text search otherwise', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ results: { bindings: [chebiRow] } }))
      .mockResolvedValueOnce(jsonRes({ results: { bindings: [{ n: { value: '1' } }] } }))
    const out = (await engine(fetchImpl).call(
      tool('rhea_search_reactions'),
      { query: 'Caffeine' },
      {}
    )) as Record<string, unknown>
    const q = decodeURIComponent(String(fetchImpl.mock.calls[0][0]))
    expect(q).toContain('CONTAINS(LCASE(STR(?equation)), "caffeine")')
    expect(out).toMatchObject({ query_type: 'text', api_total: 1 })
  })

  it('rhea_search_reactions rejects a partial EC class without a network call', async () => {
    const fetchImpl = vi.fn()
    await expect(
      engine(fetchImpl).call(tool('rhea_search_reactions'), { query: '2.1.1.-' }, {})
    ).rejects.toThrow(/not a full EC number/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rhea_get_reaction assembles predicates and participants', async () => {
    const preds = {
      results: {
        bindings: [
          { p: { value: 'http://rdf.rhea-db.org/equation' }, o: { value: 'A = B' } },
          {
            p: { value: 'http://rdf.rhea-db.org/status' },
            o: { value: 'http://rdf.rhea-db.org/Approved' }
          },
          { p: { value: 'http://rdf.rhea-db.org/isTransport' }, o: { value: 'false' } },
          { p: { value: 'http://rdf.rhea-db.org/isChemicallyBalanced' }, o: { value: 'true' } },
          {
            p: { value: 'http://rdf.rhea-db.org/ec' },
            o: { value: 'http://purl.uniprot.org/enzyme/2.1.1.160' }
          },
          {
            p: { value: 'http://rdf.rhea-db.org/citation' },
            o: { value: 'http://rdf.ncbi.nlm.nih.gov/pubmed/10984041' }
          },
          {
            p: { value: 'http://rdf.rhea-db.org/directionalReaction' },
            o: { value: 'http://rdf.rhea-db.org/10281' }
          },
          {
            p: { value: 'http://rdf.rhea-db.org/bidirectionalReaction' },
            o: { value: 'http://rdf.rhea-db.org/10283' }
          }
        ]
      }
    }
    const parts = {
      results: {
        bindings: [
          {
            side: { value: 'http://rdf.rhea-db.org/10280_R' },
            coefProp: { value: 'http://rdf.rhea-db.org/contains1' },
            cacc: { value: 'CHEBI:27732' },
            cname: { value: 'caffeine' }
          },
          {
            side: { value: 'http://rdf.rhea-db.org/10280_L' },
            coefProp: { value: 'http://rdf.rhea-db.org/contains2' },
            cacc: { value: 'CHEBI:25858' },
            cname: { value: '1,7-dimethylxanthine' }
          }
        ]
      }
    }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(preds))
      .mockResolvedValueOnce(jsonRes(parts))
    const out = (await engine(fetchImpl).call(
      tool('rhea_get_reaction'),
      { rhea_id: '10280' },
      {}
    )) as Record<string, unknown>
    expect(out).toMatchObject({
      rhea_id: 'RHEA:10280',
      equation: 'A = B',
      status: 'Approved',
      is_transport: false,
      is_chemically_balanced: true,
      ec_numbers: ['2.1.1.160'],
      pubmed_ids: ['10984041'],
      directional_reactions: ['RHEA:10281'],
      bidirectional_reaction: 'RHEA:10283',
      left_side: [
        { compound_accession: 'CHEBI:25858', name: '1,7-dimethylxanthine', coefficient: '2' }
      ],
      right_side: [{ compound_accession: 'CHEBI:27732', name: 'caffeine', coefficient: '1' }]
    })
  })

  it('rhea_get_reaction throws when the accession has no bindings', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ results: { bindings: [] } }))
    await expect(
      engine(fetchImpl).call(tool('rhea_get_reaction'), { rhea_id: '999999' }, {})
    ).rejects.toThrow(/no Rhea reaction/)
  })
})

describe('chemistry / bindingdb', () => {
  it('bindingdb_ligands_by_target unwraps the misspelled root, sorts and caps', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        getLindsByUniprotsResponse: {
          affinities: [
            {
              query: 'EGFR',
              monomerid: 10,
              smile: 'X',
              affinity_type: 'Ki',
              affinity: '50',
              pmid: 1,
              doi: 'd1'
            },
            {
              query: 'EGFR',
              monomerid: 11,
              smile: 'Y',
              affinity_type: 'IC50',
              affinity: '5',
              pmid: 2,
              doi: 'd2'
            },
            {
              query: 'EGFR',
              monomerid: 12,
              smile: 'Z',
              affinity_type: 'Ki',
              affinity: '0.006',
              pmid: 3,
              doi: 'd3'
            }
          ]
        }
      })
    )
    const out = (await engine(fetchImpl).call(
      tool('bindingdb_ligands_by_target'),
      { uniprot: 'p00533', affinity_cutoff_nm: 100, max_rows: 2 },
      {}
    )) as {
      rows: Array<Record<string, unknown>>
      n_rows_total: number
      truncated: boolean
      uniprot: string
    }
    expect(fetchImpl.mock.calls[0][0]).toContain('uniprot=P00533')
    expect(fetchImpl.mock.calls[0][0]).toContain('cutoff=100')
    expect(out.uniprot).toBe('P00533')
    expect(out.n_rows_total).toBe(3)
    expect(out.truncated).toBe(true)
    // Sorted by (affinity_type, numeric affinity): IC50/5 first, then Ki/0.006.
    expect(out.rows.map((r) => r.monomer_id)).toEqual(['11', '12'])
    expect(out.rows[0]).toMatchObject({
      affinity_type: 'IC50',
      affinity: '5',
      pmid: '2',
      doi: 'd2'
    })
  })

  it('bindingdb_ligands_by_target rejects a malformed UniProt accession', async () => {
    const fetchImpl = vi.fn()
    await expect(
      engine(fetchImpl).call(tool('bindingdb_ligands_by_target'), { uniprot: 'nope' }, {})
    ).rejects.toThrow(/not a UniProt accession/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('bindingdb_targets_by_compound maps the bdb.* fields and api_hit_count', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        getLindsByUniprotResponse: {
          'bdb.hit': 2,
          'bdb.affinities': [
            {
              'bdb.monomerid': 22360,
              'bdb.smiles': 'CC',
              'bdb.inhibitor': 'lig',
              'bdb.target': 'B target',
              'bdb.species': 'Human',
              'bdb.affinity_type': 'IC50',
              'bdb.affinity': '>133000'
            },
            {
              'bdb.monomerid': 22361,
              'bdb.smiles': 'CCC',
              'bdb.inhibitor': 'lig2',
              'bdb.target': 'A target',
              'bdb.species': 'Human',
              'bdb.affinity_type': 'Ki',
              'bdb.affinity': '10',
              'bdb.tanimoto': '0.9'
            }
          ]
        }
      })
    )
    const out = (await engine(fetchImpl).call(
      tool('bindingdb_targets_by_compound'),
      { smiles: 'CC(=O)O', similarity: 0.85 },
      {}
    )) as { rows: Array<Record<string, unknown>>; api_hit_count: number; n_rows_total: number }
    expect(fetchImpl.mock.calls[0][0]).toContain('/getTargetByCompound?smiles=')
    expect(fetchImpl.mock.calls[0][0]).toContain('cutoff=0.85')
    expect(out.api_hit_count).toBe(2)
    expect(out.n_rows_total).toBe(2)
    // Sorted by target_name: "A target" before "B target".
    expect(out.rows.map((r) => r.target_name)).toEqual(['A target', 'B target'])
    expect(out.rows[0]).toMatchObject({
      monomer_id: '22361',
      ligand_name: 'lig2',
      affinity_type: 'Ki',
      affinity: '10',
      tanimoto: '0.9'
    })
  })
})

// Live smoke tests against the real backends — opt in with LIVE_API=1. Kept minimal (rate-limited).
describe.skipIf(!process.env.LIVE_API)('chemistry / LIVE', () => {
  const live = new ParserEngine()
  const call = (id: string, args: Record<string, unknown>): Promise<unknown> =>
    live.call(tool(id), args, {})

  it('pubchem_search_compounds returns aspirin properties', async () => {
    const out = (await call('pubchem_search_compounds', { query: 'aspirin', max_cids: 3 })) as {
      cids: number[]
      properties: Array<Record<string, unknown>>
    }
    expect(out.cids).toContain(2244)
    expect(out.properties[0]).toHaveProperty('ConnectivitySMILES')
    expect(out.properties[0]).toHaveProperty('MolecularFormula')
  }, 30000)

  it('pubchem_get_compounds returns full records for 2244 and 2519', async () => {
    const out = (await call('pubchem_get_compounds', { cids: [2244, 2519] })) as {
      records: Array<Record<string, unknown>>
      not_found: number[]
    }
    expect(out.records.length).toBe(2)
    expect(out.records[0]).toHaveProperty('InChIKey')
    expect(out.not_found).toEqual([])
  }, 30000)

  it('pubchem_similarity_search finds analogs of aspirin', async () => {
    const out = (await call('pubchem_similarity_search', {
      smiles: 'CC(=O)OC1=CC=CC=C1C(=O)O',
      threshold: 95,
      max_records: 5
    })) as { cids: number[] }
    expect(out.cids).toContain(2244)
  }, 30000)

  it('pubchem_get_bioassay_summary returns rows for aspirin', async () => {
    const out = (await call('pubchem_get_bioassay_summary', { cid: 2244, max_rows: 5 })) as {
      n_rows_total: number
      rows: Array<Record<string, unknown>>
    }
    expect(out.n_rows_total).toBeGreaterThan(0)
    expect(out.rows[0]).toHaveProperty('AID')
  }, 30000)

  it('pubchem_get_safety returns a GHS block for aspirin', async () => {
    const out = (await call('pubchem_get_safety', { cid: 2244 })) as {
      found: boolean
      ghs: Record<string, unknown> | null
    }
    expect(out.found).toBe(true)
    expect(out.ghs).toHaveProperty('hazard_statements')
  }, 30000)

  it('chebi_search finds caffeine', async () => {
    const out = (await call('chebi_search', { term: 'caffeine', max_results: 3 })) as {
      api_total: number
      results: Array<Record<string, unknown>>
    }
    expect(out.api_total).toBeGreaterThan(0)
    expect(out.results.some((r) => r.chebi_accession === 'CHEBI:27732')).toBe(true)
  }, 30000)

  it('chebi_get_entity returns the caffeine record', async () => {
    const out = (await call('chebi_get_entity', { chebi_id: 'CHEBI:27732' })) as {
      name: string
      formula: string
      roles: unknown[]
    }
    expect(out.name).toBe('caffeine')
    expect(out.formula).toBe('C8H10N4O2')
    expect(out.roles.length).toBeGreaterThan(0)
  }, 30000)

  it('chebi_get_ontology returns relations for caffeine', async () => {
    const out = (await call('chebi_get_ontology', { chebi_id: '27732' })) as {
      n_outgoing_total: number
    }
    expect(out.n_outgoing_total).toBeGreaterThan(0)
  }, 30000)

  it('rhea_search_reactions works for chebi, ec and text queries', async () => {
    const byChebi = (await call('rhea_search_reactions', { query: 'CHEBI:27732', limit: 5 })) as {
      query_type: string
      api_total: number
    }
    expect(byChebi.query_type).toBe('chebi')
    expect(byChebi.api_total).toBeGreaterThan(0)
    const byEc = (await call('rhea_search_reactions', { query: '2.1.1.160', limit: 5 })) as {
      query_type: string
      api_total: number
    }
    expect(byEc.query_type).toBe('ec')
    expect(byEc.api_total).toBeGreaterThan(0)
    const byText = (await call('rhea_search_reactions', { query: 'caffeine', limit: 5 })) as {
      query_type: string
      api_total: number
    }
    expect(byText.query_type).toBe('text')
    expect(byText.api_total).toBeGreaterThan(0)
  }, 45000)

  it('rhea_get_reaction returns the full record for 10280', async () => {
    const out = (await call('rhea_get_reaction', { rhea_id: '10280' })) as {
      ec_numbers: string[]
      left_side: unknown[]
      right_side: unknown[]
    }
    expect(out.ec_numbers).toContain('2.1.1.160')
    expect(out.left_side.length).toBeGreaterThan(0)
    expect(out.right_side.length).toBeGreaterThan(0)
  }, 30000)

  it('bindingdb_ligands_by_target returns potent EGFR binders', async () => {
    const out = (await call('bindingdb_ligands_by_target', {
      uniprot: 'P00533',
      affinity_cutoff_nm: 100,
      max_rows: 5
    })) as { n_rows_total: number; rows: Array<Record<string, unknown>> }
    expect(out.n_rows_total).toBeGreaterThan(0)
    expect(out.rows[0]).toHaveProperty('affinity_type')
  }, 45000)

  it('bindingdb_targets_by_compound returns targets for aspirin', async () => {
    const out = (await call('bindingdb_targets_by_compound', {
      smiles: 'CC(=O)OC1=CC=CC=C1C(=O)O',
      similarity: 0.85,
      max_rows: 5
    })) as { n_rows_total: number; api_hit_count: number | null }
    expect(out.n_rows_total).toBeGreaterThan(0)
  }, 45000)
})
