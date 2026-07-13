import type { ToolDescriptor } from '../types'

const WORKS = 'https://api.openalex.org/works'

type OpenAlexAuthor = { display_name?: string }
type OpenAlexAuthorship = { author?: OpenAlexAuthor }
type OpenAlexWork = {
  id?: string
  title?: string
  display_name?: string
  publication_year?: number
  doi?: string
  cited_by_count?: number
  authorships?: OpenAlexAuthorship[]
}
type OpenAlexWorksResponse = { results?: OpenAlexWork[] }

const MAX_AUTHORS = 5

// https://openalex.org/W... -> W...; DOI URLs pass through as https://doi.org/10...., which the
// /works/{id} endpoint also accepts directly as a work identifier.
const shortId = (id: string | undefined): string | undefined =>
  id?.startsWith('https://openalex.org/') ? id.slice('https://openalex.org/'.length) : id

const compactWork = (w: OpenAlexWork): Record<string, unknown> => ({
  id: shortId(w.id),
  title: w.title ?? w.display_name,
  publication_year: w.publication_year,
  doi: w.doi,
  cited_by_count: w.cited_by_count,
  authors: (w.authorships ?? [])
    .slice(0, MAX_AUTHORS)
    .map((a) => a.author?.display_name)
    .filter((name): name is string => Boolean(name))
})

// Normalizes a work id/DOI into the /works/{id} path segment. OpenAlex accepts a bare W-id, an
// openalex.org URL, or a DOI (bare or as a doi.org URL) via the "doi:..." alias form.
function normalizeWorkId(input: string): string {
  const id = input.trim()
  if (/^https?:\/\/(dx\.)?doi\.org\//i.test(id)) {
    return `doi:${id.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')}`
  }
  if (id.toLowerCase().startsWith('doi:')) return id
  if (id.startsWith('10.') && id.includes('/')) return `doi:${id}`
  return shortId(id) ?? id
}

// OpenAlex REST API: read-only scholarly work search/lookup. Per upstream policy sends no
// mailto/api key on any request.
export const OPENALEX_TOOLS: ToolDescriptor[] = [
  {
    id: 'openalex_search_works',
    connector: 'openalex',
    description:
      'Search OpenAlex scholarly works by keyword; returns id, title, year, DOI, citation count, and authors per hit.',
    input: {
      type: 'object',
      properties: { query: { type: 'string' }, per_page: { type: 'integer', default: 5 } },
      required: ['query']
    },
    required: ['query'],
    returns:
      '`[ { "id": str, "title": str, "publication_year": int, "doi": str, "cited_by_count": int, "authors": [ str ] } ]` — one entry per hit, up to `per_page` (default 5); `[]` when nothing matches. `authors` is capped at the first 5 names; `id` is the short OpenAlex W-id and any field may be null when absent upstream.',
    url: (a) =>
      `${WORKS}?search=${encodeURIComponent(String(a.query))}&per_page=${Number(a.per_page ?? 5)}`,
    parse: (raw) => ((raw as OpenAlexWorksResponse).results ?? []).map(compactWork)
  },
  {
    id: 'openalex_get_work',
    connector: 'openalex',
    description:
      'Get an OpenAlex work by OpenAlex id or DOI; returns id, title, year, DOI, citation count, and authors.',
    input: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    },
    required: ['id'],
    returns:
      '`{ "id": str, "title": str, "publication_year": int, "doi": str, "cited_by_count": int, "authors": [ str ] }` — one work; `authors` is capped at the first 5 names and `id` is the short OpenAlex W-id. Any field may be null when absent upstream.',
    url: (a) => `${WORKS}/${encodeURIComponent(normalizeWorkId(String(a.id)))}`,
    parse: (raw) => compactWork(raw as OpenAlexWork)
  }
]
