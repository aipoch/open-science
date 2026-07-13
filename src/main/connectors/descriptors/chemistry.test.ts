import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { CHEMISTRY_TOOLS } from './chemistry'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => CHEMISTRY_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('chemistry / pubchem', () => {
  it('pubchem_get_properties parses PropertyTable', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ PropertyTable: { Properties: [{ CID: 2244, MolecularFormula: 'C9H8O4' }] } })
      )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('pubchem_get_properties'),
      { cids: [2244] },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toContain('/compound/cid/2244/property/')
    expect(out).toEqual([{ CID: 2244, MolecularFormula: 'C9H8O4' }])
  })

  it('pubchem_search_compounds resolves name -> cids -> properties', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ IdentifierList: { CID: [2519, 999] } }))
      .mockResolvedValueOnce(jsonRes({ PropertyTable: { Properties: [{ CID: 2519 }] } }))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('pubchem_search_compounds'),
      { query: 'caffeine', max_cids: 1 },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toContain('/compound/name/caffeine/cids/JSON')
    expect(fetchImpl.mock.calls[1][0]).toContain('/compound/cid/2519/property/')
    expect(out).toEqual({ query: 'caffeine', compounds: [{ CID: 2519 }] })
  })
})

describe('chemistry / chebi', () => {
  it('chebi_get_entity normalizes the compound record', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        chebi_accession: 'CHEBI:27732',
        name: 'caffeine',
        definition: 'A trimethylxanthine.',
        chemical_data: { formula: 'C8H10N4O2', charge: '0', mass: '194.19' },
        default_structure: {
          smiles: 'CN1C=NC2=C1C(=O)N(C(=O)N2C)C',
          standard_inchi: 'InChI=1S/C8H10N4O2',
          standard_inchi_key: 'RYYVLZVUVIJVGH-UHFFFAOYSA-N'
        }
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('chebi_get_entity'),
      { chebi_id: 'CHEBI:27732' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.ebi.ac.uk/chebi/backend/api/public/compound/27732/'
    )
    expect(out).toEqual({
      chebi_accession: 'CHEBI:27732',
      name: 'caffeine',
      definition: 'A trimethylxanthine.',
      formula: 'C8H10N4O2',
      charge: '0',
      mass: '194.19',
      smiles: 'CN1C=NC2=C1C(=O)N(C(=O)N2C)C',
      inchi: 'InChI=1S/C8H10N4O2',
      inchikey: 'RYYVLZVUVIJVGH-UHFFFAOYSA-N'
    })
  })

  it('chebi_get_entity accepts a bare numeric id and rejects a malformed one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ chebi_accession: 'CHEBI:27732' }))
    await new ParserEngine({ fetchImpl }).call(tool('chebi_get_entity'), { chebi_id: '27732' }, {})
    expect(fetchImpl.mock.calls[0][0]).toContain('/compound/27732/')
    await expect(
      new ParserEngine({ fetchImpl }).call(tool('chebi_get_entity'), { chebi_id: 'nope' }, {})
    ).rejects.toThrow(/not a ChEBI ID/)
  })
})

describe('chemistry / rhea', () => {
  it('rhea_get_reaction parses SPARQL bindings into equation + sides', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        results: {
          bindings: [
            {
              side: { value: 'http://rdf.rhea-db.org/10280_L' },
              status: { value: 'http://rdf.rhea-db.org/Approved' },
              equation: { value: 'A + B = C + D' },
              cacc: { value: 'CHEBI:1' },
              cname: { value: 'A' }
            },
            {
              side: { value: 'http://rdf.rhea-db.org/10280_R' },
              status: { value: 'http://rdf.rhea-db.org/Approved' },
              equation: { value: 'A + B = C + D' },
              cacc: { value: 'CHEBI:2' },
              cname: { value: 'C' }
            }
          ]
        }
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('rhea_get_reaction'),
      { rhea_id: '10280' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toContain('https://sparql.rhea-db.org/sparql?query=')
    expect(out).toEqual({
      rhea_id: 'RHEA:10280',
      equation: 'A + B = C + D',
      status: 'Approved',
      left_side: [{ compound_accession: 'CHEBI:1', name: 'A' }],
      right_side: [{ compound_accession: 'CHEBI:2', name: 'C' }]
    })
  })

  it('rhea_get_reaction throws when no bindings come back', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ results: { bindings: [] } }))
    await expect(
      new ParserEngine({ fetchImpl }).call(tool('rhea_get_reaction'), { rhea_id: '999999' }, {})
    ).rejects.toThrow(/no Rhea reaction/)
  })
})

describe('chemistry / bindingdb', () => {
  it('bindingdb_affinities unwraps the misspelled root key and normalizes rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        getLindsByUniprotsResponse: {
          affinities: [
            {
              query: 'Epidermal growth factor receptor',
              monomerid: 3032,
              smile: 'COc1cc2ncnc(Nc3cccc(Br)c3)c2cc1OC',
              affinity_type: 'Ki',
              affinity: '0.006',
              pmid: 18077363,
              doi: '10.1073/pnas.0708800104'
            }
          ]
        }
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('bindingdb_affinities'),
      { uniprot: 'p00533', cutoff_nm: 100 },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toContain('uniprot=P00533')
    expect(fetchImpl.mock.calls[0][0]).toContain('cutoff=100')
    expect(out).toEqual({
      uniprot: 'P00533',
      cutoff_nm: 100,
      n_rows: 1,
      affinities: [
        {
          target_name: 'Epidermal growth factor receptor',
          monomer_id: '3032',
          smiles: 'COc1cc2ncnc(Nc3cccc(Br)c3)c2cc1OC',
          affinity_type: 'Ki',
          affinity: '0.006',
          pmid: '18077363',
          doi: '10.1073/pnas.0708800104'
        }
      ]
    })
  })

  it('bindingdb_affinities rejects a malformed UniProt accession', async () => {
    const fetchImpl = vi.fn()
    await expect(
      new ParserEngine({ fetchImpl }).call(tool('bindingdb_affinities'), { uniprot: 'nope' }, {})
    ).rejects.toThrow(/not a UniProt accession/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
