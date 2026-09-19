import type { ToolDescriptor } from '../types'
import { GENES_PROTEINS_TOOLS } from './genes-proteins'
import { GENES_ONTOLOGY_TOOLS } from './genes-ontology'
import { GENES_REACTOME_TOOLS } from './genes-reactome'
import { GENES_GPROFILER_TOOLS } from './genes-gprofiler'

// "Genes & Ontologies" connector: gene/protein identity (mygene.info, UniProt), ontology terms
// (OLS4), GO annotations (QuickGO), Reactome pathways and cross-database enrichment. Tools are
// split across descriptor files by upstream API; this module aggregates them in display order.
const POOL: ToolDescriptor[] = [
  ...GENES_PROTEINS_TOOLS,
  ...GENES_ONTOLOGY_TOOLS,
  ...GENES_REACTOME_TOOLS,
  ...GENES_GPROFILER_TOOLS
]

const ORDER = [
  'query_genes',
  'list_ontologies',
  'search_ontology_terms',
  'get_ontology_term',
  'get_go_annotations',
  'get_uniprot_entries',
  'map_reactome_pathways',
  'list_enrichment_sources',
  'enrich_gene_set'
]

export const GENES_TOOLS: ToolDescriptor[] = ORDER.map(
  (id) => POOL.find((t) => t.id === id) as ToolDescriptor
)
