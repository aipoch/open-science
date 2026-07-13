import type { ToolDescriptor } from '../types'

const ENSEMBL = 'https://rest.ensembl.org'
const DEFAULT_SPECIES = 'homo_sapiens'

type EnsemblFeature = {
  id?: string
  display_name?: string
  biotype?: string
  seq_region_name?: string
  start?: number
  end?: number
  strand?: number
}

type ParsedFeature = {
  id?: string
  display_name?: string
  biotype?: string
  seq_region_name?: string
  start?: number
  end?: number
  strand?: number
}

function parseFeature(raw: unknown): ParsedFeature {
  const f = raw as EnsemblFeature
  return {
    id: f.id,
    display_name: f.display_name,
    biotype: f.biotype,
    seq_region_name: f.seq_region_name,
    start: f.start,
    end: f.end,
    strand: f.strand
  }
}

// Ensembl REST: read-only gene lookups by symbol or stable ID (keyless GETs, no rate-limit key).
export const GENOMES_TOOLS: ToolDescriptor[] = [
  {
    id: 'ensembl_lookup_symbol',
    connector: 'genomes',
    description:
      'Look up a gene by symbol (e.g. BRCA2) and species; returns its Ensembl ID, biotype, and genomic location.',
    input: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        species: { type: 'string', default: DEFAULT_SPECIES }
      },
      required: ['symbol']
    },
    required: ['symbol'],
    url: (a) => {
      const species = String(a.species ?? DEFAULT_SPECIES)
      const symbol = String(a.symbol)
      return `${ENSEMBL}/lookup/symbol/${encodeURIComponent(species)}/${encodeURIComponent(symbol)}?content-type=application/json`
    },
    parse: parseFeature
  },
  {
    id: 'ensembl_lookup_id',
    connector: 'genomes',
    description:
      'Look up a gene, transcript, or exon by Ensembl stable ID; returns its biotype and genomic location.',
    input: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    },
    required: ['id'],
    url: (a) =>
      `${ENSEMBL}/lookup/id/${encodeURIComponent(String(a.id))}?content-type=application/json`,
    parse: parseFeature
  }
]
