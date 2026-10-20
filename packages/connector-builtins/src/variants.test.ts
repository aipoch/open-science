import { describe, it, expect } from 'vitest'
import { VARIANTS_TOOLS } from './variants'

// Integration: the aggregate "Variants" tool set. Per-tool behavior is covered in
// variants-{gnomad,clinvar,dbsnp,mavedb}.test.ts.
const EXPECTED_IDS = [
  'get_variant',
  'search_variants',
  'gene_variants',
  'gene_constraint',
  'region_variants',
  'liftover_variant',
  'clinvar_variants',
  'structural_variants',
  'get_structural_variant',
  'mitochondrial_variants',
  'clinvar_search',
  'clinvar_get_records',
  'clinvar_get_submissions',
  'clinvar_variant_by_rsid',
  'dbsnp_get_rsids',
  'dbsnp_search_by_region',
  'mavedb_search_score_sets',
  'mavedb_get_score_set',
  'mavedb_download_scores',
  'mavedb_get_mapped_variants',
  'mavedb_get_experiment',
  'mavedb_get_experiment_score_sets'
]

describe('variants / aggregate', () => {
  it('exposes exactly the Variants tools in order', () => {
    expect(VARIANTS_TOOLS.map((t) => t.id)).toEqual(EXPECTED_IDS)
  })

  it('registers every tool under the variants connector with unique ids', () => {
    expect(VARIANTS_TOOLS.every((t) => t.connector === 'variants')).toBe(true)
    expect(new Set(VARIANTS_TOOLS.map((t) => t.id)).size).toBe(VARIANTS_TOOLS.length)
  })

  it('gives every tool an input schema, docs, and a run() implementation', () => {
    for (const t of VARIANTS_TOOLS) {
      expect(typeof t.run).toBe('function')
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.returns && t.returns.length).toBeTruthy()
      expect(t.input).toMatchObject({ type: 'object' })
    }
  })
})
