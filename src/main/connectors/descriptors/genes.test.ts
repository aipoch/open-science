import { describe, it, expect } from 'vitest'
import { GENES_TOOLS } from './genes'

// Integration: the aggregate "Genes & Ontologies" tool set. Per-tool behavior is covered in
// genes-proteins.test.ts, genes-ontology.test.ts, genes-reactome.test.ts, genes-gprofiler.test.ts and
// genes-enrichr.test.ts.
const EXPECTED_IDS = [
  'query_genes',
  'list_ontologies',
  'search_ontology_terms',
  'get_ontology_term',
  'get_go_annotations',
  'search_uniprot_entries',
  'get_uniprot_entries',
  'submit_uniprot_id_mapping',
  'get_uniprot_id_mapping_status',
  'get_uniprot_id_mapping_results',
  'map_reactome_pathways',
  'list_enrichment_sources',
  'enrich_gene_set',
  'list_enrichr_libraries',
  'enrich_gene_set_enrichr'
]

describe('genes / aggregate', () => {
  it('exposes exactly the Genes & Ontologies tools in order', () => {
    expect(GENES_TOOLS.map((t) => t.id)).toEqual(EXPECTED_IDS)
  })

  it('registers every tool under the genes connector with unique ids', () => {
    expect(GENES_TOOLS.every((t) => t.connector === 'genes')).toBe(true)
    expect(new Set(GENES_TOOLS.map((t) => t.id)).size).toBe(GENES_TOOLS.length)
  })

  it('gives every tool an input schema, docs, and a run() implementation', () => {
    for (const t of GENES_TOOLS) {
      expect(typeof t.run).toBe('function')
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.returns && t.returns.length).toBeTruthy()
      expect(t.input).toMatchObject({ type: 'object' })
    }
  })
})
