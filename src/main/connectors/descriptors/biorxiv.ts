import type { ToolDescriptor } from '../types'

const BASE = 'https://api.biorxiv.org'

type BiorxivRecord = {
  doi?: string
  title?: string
  authors?: string
  date?: string
  category?: string
  published?: string
}

type BiorxivMessage = { status?: string; total?: string | number }
type BiorxivResponse = { messages?: BiorxivMessage[]; collection?: BiorxivRecord[] }

const summarize = (records: BiorxivRecord[]): BiorxivRecord[] =>
  records.map((r) => ({
    doi: r.doi,
    title: r.title,
    authors: r.authors,
    date: r.date,
    category: r.category,
    // "NA" until the preprint is later linked to a published journal article.
    published: r.published
  }))

const normalizeServer = (server: unknown): 'biorxiv' | 'medrxiv' =>
  server === 'medrxiv' ? 'medrxiv' : 'biorxiv'

// Strips a doi.org URL prefix; the API path takes the bare "10.xxxx/yyyy" DOI, slash included
// (NOT URL-encoded — it is two literal path segments, e.g. /details/biorxiv/10.1101/339747).
const normalizeDoi = (doi: string): string =>
  doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')

// bioRxiv/medRxiv REST API (api.biorxiv.org): read-only preprint metadata lookups.
export const BIORXIV_TOOLS: ToolDescriptor[] = [
  {
    id: 'biorxiv_get_details',
    connector: 'biorxiv',
    description:
      'Get bioRxiv/medRxiv preprint details (title, authors, date, category, published link) for a DOI.',
    input: {
      type: 'object',
      properties: {
        doi: { type: 'string' },
        server: { type: 'string', enum: ['biorxiv', 'medrxiv'], default: 'biorxiv' }
      },
      required: ['doi']
    },
    required: ['doi'],
    returns:
      '`[ { "doi": str, "title": str, "authors": str, "date": str, "category": str, "published": str } ]` — array of matching preprint versions; `published` is "NA" until linked to a published journal article. `[]` when the DOI is unknown.',
    url: (a) => `${BASE}/details/${normalizeServer(a.server)}/${normalizeDoi(String(a.doi))}`,
    parse: (raw) => summarize((raw as BiorxivResponse).collection ?? [])
  },
  {
    id: 'biorxiv_list_interval',
    connector: 'biorxiv',
    description:
      'List bioRxiv/medRxiv preprints posted in a closed date interval (YYYY-MM-DD), optionally filtered by category; one page of up to 30.',
    input: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD' },
        server: { type: 'string', enum: ['biorxiv', 'medrxiv'], default: 'biorxiv' },
        category: { type: 'string' },
        cursor: { type: 'integer', default: 0 }
      },
      required: ['from', 'to']
    },
    required: ['from', 'to'],
    returns:
      '`{ "total": str, "results": [ { "doi": str, "title": str, "authors": str, "date": str, "category": str, "published": str } ] }` — one page of up to 30 preprints; `total` (passthrough string count) is the full interval total. `published` is "NA" until linked to a journal article.',
    url: (a) => {
      const cursor = Number.isFinite(Number(a.cursor)) ? Math.max(0, Number(a.cursor)) : 0
      const path = `${BASE}/details/${normalizeServer(a.server)}/${encodeURIComponent(String(a.from))}/${encodeURIComponent(String(a.to))}/${cursor}`
      const category = a.category
        ? `?category=${encodeURIComponent(String(a.category).trim().toLowerCase().replace(/ /g, '_'))}`
        : ''
      return `${path}${category}`
    },
    parse: (raw) => {
      const r = raw as BiorxivResponse
      return { total: r.messages?.[0]?.total, results: summarize(r.collection ?? []) }
    }
  }
]
