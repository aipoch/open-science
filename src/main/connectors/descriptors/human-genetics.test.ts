import { describe, it, expect } from 'vitest'
import { HUMAN_GENETICS_TOOLS } from './human-genetics'

// Integration: the aggregate "Human Genetics" tool set. Per-tool behavior is covered in
// humangenetics-gwas.test.ts, humangenetics-eqtl.test.ts and humangenetics-phewas.test.ts.
const EXPECTED_IDS = [
  'gwas_associations_for_variant',
  'gwas_associations_for_gene',
  'gwas_associations_for_trait',
  'gwas_search_traits',
  'gwas_search_studies',
  'gwas_get_study',
  'gwas_get_variant',
  'eqtl_list_datasets',
  'eqtl_associations',
  'phewas_instances',
  'phewas_variant',
  'phewas_finngen_gene',
  'phewas_list_phenotypes',
  'phewas_search_phenotypes'
]

describe('human-genetics / aggregate', () => {
  it('exposes exactly the Human Genetics tools in order', () => {
    expect(HUMAN_GENETICS_TOOLS.map((t) => t.id)).toEqual(EXPECTED_IDS)
  })

  it('registers every tool under the human_genetics connector with unique ids', () => {
    expect(HUMAN_GENETICS_TOOLS.every((t) => t.connector === 'human_genetics')).toBe(true)
    expect(new Set(HUMAN_GENETICS_TOOLS.map((t) => t.id)).size).toBe(HUMAN_GENETICS_TOOLS.length)
  })

  it('gives every tool an input schema, docs, and a run() implementation', () => {
    for (const t of HUMAN_GENETICS_TOOLS) {
      expect(typeof t.run).toBe('function')
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.returns && t.returns.length).toBeTruthy()
      expect(t.input).toMatchObject({ type: 'object' })
    }
  })
})
