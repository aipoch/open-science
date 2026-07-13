import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { CHEMBL_TOOLS } from './chembl'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => CHEMBL_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('chembl / search', () => {
  it('chembl_search_molecule builds the search URL and parses compact summaries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        molecules: [
          {
            molecule_chembl_id: 'CHEMBL25',
            pref_name: 'ASPIRIN',
            max_phase: '4.0',
            molecule_type: 'Small molecule',
            molecule_structures: { canonical_smiles: 'CC(=O)Oc1ccccc1C(=O)O' }
          },
          {
            molecule_chembl_id: 'CHEMBL5282669',
            pref_name: null,
            max_phase: null,
            molecule_type: null
          }
        ],
        page_meta: { limit: 20, offset: 0, total_count: 52 }
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('chembl_search_molecule'),
      { query: 'aspirin' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.ebi.ac.uk/chembl/api/data/molecule/search?q=aspirin&format=json'
    )
    expect(out).toEqual([
      {
        chembl_id: 'CHEMBL25',
        pref_name: 'ASPIRIN',
        max_phase: '4.0',
        molecule_type: 'Small molecule'
      },
      { chembl_id: 'CHEMBL5282669', pref_name: null, max_phase: null, molecule_type: null }
    ])
  })

  it('chembl_search_molecule returns an empty array when there are no matches', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ molecules: [] }))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('chembl_search_molecule'),
      { query: 'nonexistent-compound-xyz' },
      {}
    )
    expect(out).toEqual([])
  })

  it('encodes special characters in the query', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ molecules: [] }))
    await new ParserEngine({ fetchImpl }).call(
      tool('chembl_search_molecule'),
      { query: 'a b&c' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.ebi.ac.uk/chembl/api/data/molecule/search?q=a%20b%26c&format=json'
    )
  })
})

describe('chembl / get molecule', () => {
  it('chembl_get_molecule builds the record URL and parses a compact summary', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        molecule_chembl_id: 'CHEMBL25',
        pref_name: 'ASPIRIN',
        max_phase: '4.0',
        molecule_type: 'Small molecule',
        withdrawn_flag: false
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('chembl_get_molecule'),
      { chembl_id: 'CHEMBL25' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://www.ebi.ac.uk/chembl/api/data/molecule/CHEMBL25?format=json'
    )
    expect(out).toEqual({
      chembl_id: 'CHEMBL25',
      pref_name: 'ASPIRIN',
      max_phase: '4.0',
      molecule_type: 'Small molecule'
    })
  })
})
