import type { ToolDescriptor } from '../types'
import { HUMANGENETICS_GWAS_TOOLS } from './humangenetics-gwas'
import { HUMANGENETICS_EQTL_TOOLS } from './humangenetics-eqtl'
import { HUMANGENETICS_PHEWAS_TOOLS } from './humangenetics-phewas'

// "Human Genetics" connector: human genetic-association evidence across the GWAS Catalog, the
// eQTL Catalogue, and PheWeb PheWAS portals (FinnGen, BioBank Japan). Split by upstream source;
// this module aggregates them in the connector's display order.
export const HUMAN_GENETICS_TOOLS: ToolDescriptor[] = [
  ...HUMANGENETICS_GWAS_TOOLS,
  ...HUMANGENETICS_EQTL_TOOLS,
  ...HUMANGENETICS_PHEWAS_TOOLS
]
