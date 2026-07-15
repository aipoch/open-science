import { describe, it, expect } from 'vitest'
import { STRUCTURES_TOOLS } from './structures'

// Integration: the aggregate "Structures & Interactions" tool set. Per-tool behavior is covered in
// structures-{emdb,complexportal,intact,pdb,alphafold}.test.ts.
const EXPECTED_IDS = [
  'emdb_get_entries',
  'emdb_search_entries',
  'emdb_get_entry_section',
  'emdb_get_validation',
  'complexportal_get_complexes',
  'complexportal_search_by_participant',
  'intact_fetch_interactions',
  'intact_get_interactor',
  'intact_get_interaction_details',
  'intact_build_network',
  'pdb_search_structures',
  'pdb_get_structures',
  'pdb_get_entities',
  'pdb_get_ligands',
  'alphafold_get_prediction',
  'alphafold_check_coverage'
]

describe('structures / aggregate', () => {
  it('exposes exactly the Structures & Interactions tools in order', () => {
    expect(STRUCTURES_TOOLS.map((t) => t.id)).toEqual(EXPECTED_IDS)
  })

  it('registers every tool under the structures connector with unique ids', () => {
    expect(STRUCTURES_TOOLS.every((t) => t.connector === 'structures')).toBe(true)
    expect(new Set(STRUCTURES_TOOLS.map((t) => t.id)).size).toBe(STRUCTURES_TOOLS.length)
  })

  it('gives every tool an input schema, docs, and a run() implementation', () => {
    for (const t of STRUCTURES_TOOLS) {
      expect(typeof t.run).toBe('function')
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.returns && t.returns.length).toBeTruthy()
      expect(t.input).toMatchObject({ type: 'object' })
    }
  })
})
