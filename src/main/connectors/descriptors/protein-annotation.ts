import type { ToolDescriptor } from '../types'

const STRING_BASE = 'https://string-db.org/api/json'
const HUMAN_TAXON_ID = 9606

type StringEdge = {
  preferredName_A?: string
  preferredName_B?: string
  score?: number
}

// STRING-DB REST (JSON output): protein-protein interaction lookups for human (taxon 9606).
export const PROTEIN_ANNOTATION_TOOLS: ToolDescriptor[] = [
  {
    id: 'string_interaction_partners',
    connector: 'protein_annotation',
    description: 'List STRING-DB interaction partners for a gene/protein, ranked by score.',
    input: {
      type: 'object',
      properties: {
        gene: { type: 'string' },
        limit: { type: 'number', description: 'Max partners to return (default 10).' }
      },
      required: ['gene']
    },
    required: ['gene'],
    returns:
      '`[ { "partner": str, "score": float } ]` — up to `limit` partners (default 10) for the query gene, ranked by STRING combined score (0–1); `[]` when the gene is unknown or has no partners.',
    url: (a) => {
      const limit = typeof a.limit === 'number' ? a.limit : 10
      return `${STRING_BASE}/interaction_partners?identifiers=${encodeURIComponent(String(a.gene))}&species=${HUMAN_TAXON_ID}&limit=${limit}`
    },
    parse: (raw) =>
      (raw as StringEdge[]).map((e) => ({
        partner: e.preferredName_B,
        score: e.score
      }))
  },
  {
    id: 'string_network',
    connector: 'protein_annotation',
    description: 'Get the STRING-DB interaction network among a set of genes/proteins.',
    input: {
      type: 'object',
      properties: {
        genes: { type: 'array', items: { type: 'string' } }
      },
      required: ['genes']
    },
    required: ['genes'],
    returns:
      '`[ { "a": str, "b": str, "score": float } ]` — one entry per interaction edge among the input genes, `score` is the STRING combined score (0–1); `[]` when no edges are found. Only pairs with an interaction are returned, not every gene pair.',
    url: (a) => {
      const genes = a.genes as string[]
      return `${STRING_BASE}/network?identifiers=${encodeURIComponent(genes.join(','))}&species=${HUMAN_TAXON_ID}`
    },
    parse: (raw) =>
      (raw as StringEdge[]).map((e) => ({
        a: e.preferredName_A,
        b: e.preferredName_B,
        score: e.score
      }))
  }
]
