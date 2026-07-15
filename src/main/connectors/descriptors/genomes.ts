import type { ToolDescriptor } from '../types'
import { GENOMES_ENSEMBL_TOOLS } from './genomes-ensembl'
import { GENOMES_UCSC_TOOLS } from './genomes-ucsc'

// "Genomes" connector: Ensembl REST (gene/variant/homology/sequence/overlap) plus the UCSC
// Genome Browser (tracks, track data, conservation, TFBS, chrom sizes). Split by upstream API;
// this module aggregates them in the connector's display order.
export const GENOMES_TOOLS: ToolDescriptor[] = [...GENOMES_ENSEMBL_TOOLS, ...GENOMES_UCSC_TOOLS]
