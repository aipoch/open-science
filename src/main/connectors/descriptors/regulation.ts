import type { ToolDescriptor } from '../types'

const ENCODE = 'https://www.encodeproject.org'
const DEFAULT_SEARCH_LIMIT = 25

// target/lab arrive as embedded objects in most frames, but can degrade to a bare @id string.
type EncodeEmbedded = { label?: string; title?: string } | string | undefined

type EncodeExperiment = {
  accession?: string
  status?: string
  assay_title?: string
  assay_term_name?: string
  biosample_ontology?: { term_name?: string }
  target?: EncodeEmbedded
  description?: string
  lab?: EncodeEmbedded
  date_released?: string
}

type EncodeSearchResponse = { '@graph'?: EncodeExperiment[] }

function embeddedLabel(v: EncodeEmbedded): string | undefined {
  return typeof v === 'string' ? v : (v?.label ?? v?.title)
}

// ENCODE portal REST API (encodeproject.org): every route accepts format=json; the client
// also sends Accept: application/json via ParserEngine's default fetchJson header.
export const REGULATION_TOOLS: ToolDescriptor[] = [
  {
    id: 'encode_search',
    connector: 'regulation',
    description:
      'Search ENCODE functional-genomics experiments (ChIP-seq, ATAC-seq, ...) by free text.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '`[ { "accession": str, "assay_title": str, "biosample": str, "target": str, "status": str } ]` — one entry per matching experiment, up to `limit` (default 25); `[]` when nothing matches. `target`/`biosample` are null when the experiment has none.',
    url: (a) => {
      const limit = typeof a.limit === 'number' && a.limit > 0 ? a.limit : DEFAULT_SEARCH_LIMIT
      return `${ENCODE}/search/?searchTerm=${encodeURIComponent(String(a.query))}&type=Experiment&format=json&limit=${limit}`
    },
    parse: (raw) =>
      ((raw as EncodeSearchResponse)['@graph'] ?? []).map((e) => ({
        accession: e.accession,
        assay_title: e.assay_title,
        biosample: e.biosample_ontology?.term_name,
        target: embeddedLabel(e.target),
        status: e.status
      }))
  },
  {
    id: 'encode_get_experiment',
    connector: 'regulation',
    description:
      'Get one ENCODE experiment by accession (assay, target, biosample, status, dates).',
    input: {
      type: 'object',
      properties: { accession: { type: 'string' } },
      required: ['accession']
    },
    required: ['accession'],
    returns:
      '`{ "accession": str, "status": str, "assay_title": str, "assay_term_name": str, "biosample": str, "target": str, "description": str, "lab": str, "date_released": str }` — one experiment; `target`/`lab`/`biosample`/`date_released` are null when absent upstream.',
    url: (a) => `${ENCODE}/experiments/${encodeURIComponent(String(a.accession))}/?format=json`,
    parse: (raw) => {
      const e = raw as EncodeExperiment
      return {
        accession: e.accession,
        status: e.status,
        assay_title: e.assay_title,
        assay_term_name: e.assay_term_name,
        biosample: e.biosample_ontology?.term_name,
        target: embeddedLabel(e.target),
        description: e.description,
        lab: embeddedLabel(e.lab),
        date_released: e.date_released
      }
    }
  }
]
