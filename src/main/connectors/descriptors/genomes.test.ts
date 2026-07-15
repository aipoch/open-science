import { describe, it, expect } from 'vitest'
import { GENOMES_TOOLS } from './genomes'

// Integration: the aggregate "Genomes" tool set. Per-tool behavior is covered in
// genomes-ensembl.test.ts and genomes-ucsc.test.ts.
const EXPECTED_IDS = [
  'ensembl_lookup',
  'ensembl_xrefs',
  'ensembl_vep_variant',
  'ensembl_homology',
  'ensembl_sequence',
  'ensembl_overlap_region',
  'ucsc_list_tracks',
  'ucsc_track_data',
  'ucsc_conservation',
  'ucsc_tfbs_clusters',
  'ucsc_chrom_sizes'
]

describe('genomes / aggregate', () => {
  it('exposes exactly the Genomes tools in order', () => {
    expect(GENOMES_TOOLS.map((t) => t.id)).toEqual(EXPECTED_IDS)
  })

  it('registers every tool under the genomes connector with unique ids', () => {
    expect(GENOMES_TOOLS.every((t) => t.connector === 'genomes')).toBe(true)
    expect(new Set(GENOMES_TOOLS.map((t) => t.id)).size).toBe(GENOMES_TOOLS.length)
  })

  it('gives every tool an input schema, docs, and a run() implementation', () => {
    for (const t of GENOMES_TOOLS) {
      expect(typeof t.run).toBe('function')
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.returns && t.returns.length).toBeTruthy()
      expect(t.input).toMatchObject({ type: 'object' })
    }
  })
})
