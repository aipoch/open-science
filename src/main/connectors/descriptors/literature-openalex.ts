import type { ToolContext, ToolDescriptor } from '../types'

// OpenAlex REST API (all disciplines, ~250M works). Per upstream etiquette this connector sends
// NO mailto and NO api key on any request; payloads are kept lean via `select=` and multi-page
// walks use cursor paging with per-page=200 (the API maximum).
const BASE = 'https://api.openalex.org'
const PER_PAGE = 200

// Selected fields for the lean work record (see leanWork). include_abstracts adds
// abstract_inverted_index; get_work additionally requests referenced_works + counts_by_year.
const WORK_SELECT =
  'id,doi,ids,title,display_name,publication_year,publication_date,type,language,is_retracted,' +
  'authorships,primary_location,biblio,cited_by_count,fwci,referenced_works_count,open_access,' +
  'best_oa_location,primary_topic,keywords'
const AUTHOR_SELECT =
  'id,display_name,orcid,works_count,cited_by_count,summary_stats,affiliations,' +
  'last_known_institutions,topics,counts_by_year'
const SOURCE_SELECT =
  'id,display_name,type,issn_l,issn,host_organization_name,country_code,homepage_url,is_oa,' +
  'is_in_doaj,is_core,apc_usd,works_count,cited_by_count,summary_stats,topics,counts_by_year'

// Licenses under which OpenAlex-reconstructed abstracts are treated as verified-open; anything else
// (nc/nd/other/undeclared) is withheld with a policy note (see abstractFields).
const OPEN_LICENSES = new Set(['cc-by', 'cc-by-sa', 'cc0', 'public-domain', 'pd'])

// ---- Minimal shapes of the OpenAlex JSON we read (only the fields the lean records surface) ----

type CountByYear = { year?: number; works_count?: number; cited_by_count?: number }
type SummaryStats = {
  h_index?: number
  i10_index?: number
  '2yr_mean_citedness'?: number
}
type NamedEntity = { id?: string; display_name?: string }
type OpenAlexTopic = {
  id?: string
  display_name?: string
  field?: NamedEntity
  subfield?: NamedEntity
  domain?: NamedEntity
}
type OpenAlexSourceRef = {
  id?: string
  display_name?: string
  issn_l?: string
  type?: string
}
type OpenAlexLocation = {
  source?: OpenAlexSourceRef
  license?: string | null
  pdf_url?: string | null
  landing_page_url?: string | null
}
type OpenAlexAuthorship = {
  author?: { id?: string; display_name?: string; orcid?: string }
  author_position?: string
  is_corresponding?: boolean
  institutions?: NamedEntity[]
}
type OpenAlexWork = {
  id?: string
  doi?: string
  ids?: { pmid?: string }
  title?: string
  display_name?: string
  publication_year?: number
  publication_date?: string
  type?: string
  language?: string
  is_retracted?: boolean
  authorships?: OpenAlexAuthorship[]
  primary_location?: OpenAlexLocation
  best_oa_location?: OpenAlexLocation
  biblio?: unknown
  cited_by_count?: number
  fwci?: number
  referenced_works_count?: number
  open_access?: { is_oa?: boolean; oa_status?: string; oa_url?: string }
  primary_topic?: OpenAlexTopic
  keywords?: { display_name?: string; keyword?: string }[]
  abstract_inverted_index?: Record<string, number[]>
  referenced_works?: string[]
  counts_by_year?: CountByYear[]
}
type OpenAlexAuthor = {
  id?: string
  display_name?: string
  orcid?: string
  works_count?: number
  cited_by_count?: number
  summary_stats?: SummaryStats
  affiliations?: { institution?: NamedEntity; years?: number[] }[]
  last_known_institutions?: NamedEntity[]
  last_known_institution?: NamedEntity
  topics?: NamedEntity[]
  counts_by_year?: CountByYear[]
}
type OpenAlexSource = {
  id?: string
  display_name?: string
  type?: string
  issn_l?: string
  issn?: string[]
  host_organization_name?: string
  country_code?: string
  homepage_url?: string
  is_oa?: boolean
  is_in_doaj?: boolean
  is_core?: boolean
  apc_usd?: number
  works_count?: number
  cited_by_count?: number
  summary_stats?: SummaryStats
  topics?: NamedEntity[]
  counts_by_year?: CountByYear[]
}
type ListResponse<T> = { results?: T[]; meta?: { count?: number; next_cursor?: string | null } }

// ---- id normalizers -------------------------------------------------------------------------

// https://openalex.org/W... -> W... (also A.../S...); passes other values through unchanged.
const shortId = (url: string | undefined | null): string | undefined =>
  typeof url === 'string' ? url.replace(/^https:\/\/openalex\.org\//i, '') : undefined

// DOI URL / "doi:" prefix -> bare "10.xxx/..."; null when the work carries no DOI.
const bareDoi = (doi: string | undefined | null): string | null =>
  doi ? doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '') : null

// PubMed URL (from work.ids.pmid) -> bare numeric id (last path segment); null when absent.
const bareId = (url: string | undefined | null): string | null => {
  if (!url) return null
  const parts = url.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : null
}

type WorkIdRef = { kind: 'wid'; wid: string } | { kind: 'doi'; doi: string }

// Distinguishes a work identifier (W-id or openalex.org URL) from a DOI (bare, "doi:", or doi.org
// URL). DOIs must be resolved via the /works?filter=doi: claimant lookup by the caller.
function normalizeWorkId(input: string): WorkIdRef {
  const id = input.trim()
  if (/^https?:\/\/(dx\.)?doi\.org\//i.test(id)) {
    return { kind: 'doi', doi: id.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') }
  }
  if (/^doi:/i.test(id)) return { kind: 'doi', doi: id.replace(/^doi:/i, '') }
  if (/^10\.\d/.test(id) && id.includes('/')) return { kind: 'doi', doi: id }
  return { kind: 'wid', wid: shortId(id) ?? id }
}

// Author id/URL/ORCID -> a /authors/{segment} path token. ORCIDs use the "orcid:" alias form,
// which OpenAlex accepts as a single GET without URL-encoding the orcid.org URL.
function normalizeAuthorId(input: string): string {
  const id = input.trim()
  if (/^https?:\/\/orcid\.org\//i.test(id))
    return `orcid:${id.replace(/^https?:\/\/orcid\.org\//i, '')}`
  if (/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i.test(id)) return `orcid:${id}`
  return shortId(id) ?? id
}

// True when the venue string is an exact source identifier (S-id, openalex.org URL, or ISSN) that
// needs no name search.
function isExactSourceId(input: string): boolean {
  const id = input.trim()
  return /^(https:\/\/openalex\.org\/)?S\d+$/i.test(id) || /^\d{4}-\d{3}[\dX]$/i.test(id)
}

// Source id/URL -> S-id; ISSN (NNNN-NNNC) -> "issn:<issn>" alias accepted by /sources/{id}.
function normalizeSourceId(input: string): string {
  const id = input.trim()
  if (/^\d{4}-\d{3}[\dX]$/i.test(id)) return `issn:${id}`
  return shortId(id) ?? id
}

// ---- abstract reconstruction + license gate -------------------------------------------------

// Rebuilds abstract text from OpenAlex's inverted index { word: [positions...] }; null when the
// index is missing/empty (publisher withholds it).
function reconstructAbstract(inverted: Record<string, number[]> | undefined | null): string | null {
  if (!inverted || Object.keys(inverted).length === 0) return null
  const slots: { pos: number; word: string }[] = []
  for (const [word, positions] of Object.entries(inverted)) {
    for (const pos of positions) slots.push({ pos, word })
  }
  slots.sort((a, b) => a.pos - b.pos)
  return slots.map((s) => s.word).join(' ')
}

// Applies the abstract license gate: reconstruct only under verified-open licenses; otherwise emit
// abstract=null with abstract_license + an abstract_policy note pointing at the landing page.
function abstractFields(w: OpenAlexWork): Record<string, unknown> {
  const inverted = w.abstract_inverted_index
  if (!inverted || Object.keys(inverted).length === 0) return { abstract: null }
  const license = w.best_oa_location?.license ?? w.primary_location?.license ?? null
  if (license && OPEN_LICENSES.has(license)) {
    return { abstract: reconstructAbstract(inverted), abstract_license: license }
  }
  const landing =
    w.primary_location?.landing_page_url ??
    w.open_access?.oa_url ??
    `https://openalex.org/${shortId(w.id)}`
  return {
    abstract: null,
    abstract_license: license,
    abstract_policy:
      `Abstract withheld: license '${license || 'undeclared'}' is not verified-open ` +
      `(only cc-by/cc-by-sa/cc0/public-domain reconstruct). See ${landing}`
  }
}

// ---- lean record mappers --------------------------------------------------------------------

// First primary-location source as a compact {source_id, display_name, issn_l, type}; null if none.
function firstSource(w: OpenAlexWork): Record<string, unknown> | null {
  const s = w.primary_location?.source
  if (!s) return null
  return { source_id: shortId(s.id), display_name: s.display_name, issn_l: s.issn_l, type: s.type }
}

// Maps one OpenAlex work to the shared lean record consumed by every work-returning tool.
function leanWork(w: OpenAlexWork): Record<string, unknown> {
  return {
    openalex_id: shortId(w.id),
    doi: bareDoi(w.doi),
    pmid: bareId(w.ids?.pmid),
    title: w.title ?? w.display_name,
    publication_year: w.publication_year,
    publication_date: w.publication_date,
    type: w.type,
    language: w.language,
    is_retracted: w.is_retracted,
    authors: (w.authorships ?? []).map((a) => ({
      author_id: shortId(a.author?.id),
      name: a.author?.display_name,
      orcid: a.author?.orcid,
      position: a.author_position,
      is_corresponding: a.is_corresponding,
      institutions: (a.institutions ?? []).map((i) => i.display_name).filter(Boolean)
    })),
    source: firstSource(w),
    biblio: w.biblio,
    cited_by_count: w.cited_by_count,
    fwci: w.fwci,
    referenced_works_count: w.referenced_works_count,
    open_access: {
      is_oa: w.open_access?.is_oa,
      oa_status: w.open_access?.oa_status,
      oa_url: w.open_access?.oa_url
    },
    best_oa_pdf_url: w.best_oa_location?.pdf_url ?? null,
    primary_topic: w.primary_topic
      ? {
          id: shortId(w.primary_topic.id),
          display_name: w.primary_topic.display_name,
          field: w.primary_topic.field?.display_name,
          subfield: w.primary_topic.subfield?.display_name,
          domain: w.primary_topic.domain?.display_name
        }
      : null,
    keywords: (w.keywords ?? []).map((k) => k.display_name ?? k.keyword).filter(Boolean)
  }
}

// leanWork, optionally extended with the license-gated abstract fields.
function leanWorkWithAbstract(w: OpenAlexWork, includeAbstract: boolean): Record<string, unknown> {
  return includeAbstract ? { ...leanWork(w), ...abstractFields(w) } : leanWork(w)
}

function leanAuthor(a: OpenAlexAuthor): Record<string, unknown> {
  return {
    author_id: shortId(a.id),
    name: a.display_name,
    orcid: a.orcid,
    works_count: a.works_count,
    cited_by_count: a.cited_by_count,
    h_index: a.summary_stats?.h_index,
    i10_index: a.summary_stats?.i10_index,
    affiliations: (a.affiliations ?? []).map((af) => ({
      institution: af.institution?.display_name,
      years: af.years
    })),
    last_known_institutions: (
      a.last_known_institutions ?? (a.last_known_institution ? [a.last_known_institution] : [])
    )
      .map((i) => i.display_name)
      .filter(Boolean),
    top_topics: (a.topics ?? []).slice(0, 10).map((t) => t.display_name)
  }
}

// Smallest/largest year present in a counts_by_year array; null when it carries none.
function minYear(cby: CountByYear[] | undefined): number | null {
  const years = (cby ?? []).map((c) => c.year).filter((y): y is number => typeof y === 'number')
  return years.length ? Math.min(...years) : null
}
function maxYear(cby: CountByYear[] | undefined): number | null {
  const years = (cby ?? []).map((c) => c.year).filter((y): y is number => typeof y === 'number')
  return years.length ? Math.max(...years) : null
}

function leanSource(s: OpenAlexSource): Record<string, unknown> {
  return {
    source_id: shortId(s.id),
    display_name: s.display_name,
    type: s.type,
    issn_l: s.issn_l,
    issn: s.issn,
    host_organization: s.host_organization_name,
    country_code: s.country_code,
    homepage_url: s.homepage_url,
    is_oa: s.is_oa,
    is_in_doaj: s.is_in_doaj,
    is_core: s.is_core,
    apc_usd: s.apc_usd,
    works_count: s.works_count,
    cited_by_count: s.cited_by_count,
    h_index: s.summary_stats?.h_index,
    two_year_mean_citedness: s.summary_stats?.['2yr_mean_citedness'],
    first_publication_year: minYear(s.counts_by_year),
    last_publication_year: maxYear(s.counts_by_year),
    top_topics: (s.topics ?? []).slice(0, 10).map((t) => t.display_name)
  }
}

// ---- small arg + request helpers ------------------------------------------------------------

// Reads an integer arg, applying a default when unset and clamping into [lo, hi].
function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  const base = Number.isFinite(n) && v != null && v !== '' ? Math.trunc(n) : def
  return Math.min(hi, Math.max(lo, base))
}

// Cursor-paginates an OpenAlex list endpoint (per-page=200) until max_records rows are collected or
// the cursor runs out; returns the rows plus the first page's meta.count.
async function paginate<T>(
  ctx: ToolContext,
  buildUrl: (cursor: string) => string,
  maxRecords: number
): Promise<{ results: T[]; count: number }> {
  const out: T[] = []
  let cursor = '*'
  let count = 0
  let first = true
  while (out.length < maxRecords) {
    const resp = (await ctx.fetchJson(buildUrl(cursor))) as ListResponse<T>
    if (first) {
      count = resp.meta?.count ?? 0
      first = false
    }
    const page = resp.results ?? []
    for (const r of page) {
      out.push(r)
      if (out.length >= maxRecords) break
    }
    const next = resp.meta?.next_cursor
    if (!next || page.length === 0) break
    cursor = next
  }
  return { results: out, count }
}

type Claimant = {
  openalex_id: string | undefined
  cited_by_count: number | undefined
  title: unknown
}
const toClaimant = (w: OpenAlexWork): Claimant => ({
  openalex_id: shortId(w.id),
  cited_by_count: w.cited_by_count,
  title: w.title ?? w.display_name
})
const pickMostCited = (works: OpenAlexWork[]): OpenAlexWork =>
  works.reduce((best, w) => ((w.cited_by_count ?? 0) > (best.cited_by_count ?? 0) ? w : best))

type ResolvedWork = {
  wid: string
  doi_claimants?: Claimant[]
  doi_resolution_note?: string
}

// Resolves a work_id arg to a W-id. DOIs cost one extra /works?filter=doi: request; when several
// works share the DOI the most-cited is chosen and claimants + a note are carried out.
async function resolveWorkIdToWid(ctx: ToolContext, input: string): Promise<ResolvedWork> {
  const ref = normalizeWorkId(input)
  if (ref.kind === 'wid') return { wid: ref.wid }
  const resp = (await ctx.fetchJson(
    `${BASE}/works?filter=doi:${encodeURIComponent(ref.doi)}&per-page=50&select=id,cited_by_count,title,display_name`
  )) as ListResponse<OpenAlexWork>
  const results = resp.results ?? []
  if (results.length === 0) throw new Error(`No OpenAlex work found for DOI '${ref.doi}'`)
  const chosen = pickMostCited(results)
  const wid = shortId(chosen.id) ?? ''
  if (results.length > 1) {
    return {
      wid,
      doi_claimants: results.map(toClaimant),
      doi_resolution_note: `DOI '${ref.doi}' maps to ${results.length} OpenAlex works; selected the most-cited (${wid}).`
    }
  }
  return { wid }
}

type VenueResolution = { sourceFilterId: string; venueResolved: unknown }

// Resolves a venue arg to an S-id for the primary_location.source.id filter. Exact S-ids/URLs are
// used verbatim; an ISSN resolves via a single GET; anything else is a top-hit name search.
async function resolveVenue(ctx: ToolContext, venue: string): Promise<VenueResolution> {
  const v = venue.trim()
  if (/^(https:\/\/openalex\.org\/)?S\d+$/i.test(v)) {
    return { sourceFilterId: shortId(v) ?? v, venueResolved: v }
  }
  if (/^\d{4}-\d{3}[\dX]$/i.test(v)) {
    const s = (await ctx.fetchJson(
      `${BASE}/sources/issn:${v}?select=id,display_name`
    )) as OpenAlexSource
    const sid = shortId(s.id) ?? ''
    return { sourceFilterId: sid, venueResolved: { source_id: sid, display_name: s.display_name } }
  }
  const resp = (await ctx.fetchJson(
    `${BASE}/sources?search=${encodeURIComponent(v)}&per-page=1&select=id,display_name`
  )) as ListResponse<OpenAlexSource>
  const top = resp.results?.[0]
  if (!top) throw new Error(`No OpenAlex source matched venue '${venue}'`)
  const sid = shortId(top.id) ?? ''
  return { sourceFilterId: sid, venueResolved: { source_id: sid, display_name: top.display_name } }
}

// Maps the sort arg to an OpenAlex sort= value; "relevance" (the search default) omits sort.
const worksSortParam = (sort: string): string | null =>
  sort === 'cited_by_count'
    ? 'cited_by_count:desc'
    : sort === 'publication_date'
      ? 'publication_date:desc'
      : null

// ---- the 7 tools ----------------------------------------------------------------------------

export const OPENALEX_LITERATURE_TOOLS: ToolDescriptor[] = [
  {
    id: 'openalex_search_works',
    connector: 'literature',
    description:
      'Search OpenAlex scholarly works (all disciplines, ~250M records) with year/type/OA/venue filters. Args: query (free-text over title+abstract+fulltext; optional if a filter is set), year_from, year_to (inclusive years), work_type (article/review/preprint/book-chapter/dataset/dissertation), open_access_only, venue (S-id, openalex.org URL, ISSN, or a plain name resolved to the top sources hit — surfaced in venue_resolved; pass an exact ID to skip resolution), sort (relevance default / cited_by_count / publication_date), max_records (default 50, hard ceiling 500; pages of 200), include_abstracts (reconstructed from the inverted index, but ONLY for verified-open licenses — cc-by/cc-by-sa/cc0/public-domain; others get abstract=null + abstract_policy note + abstract_license; adds bulk). Returns {query, filters, sort, api_total, n_records_returned, records_truncated, records}; each record is the lean work shape (openalex_id, doi, pmid, title, publication_year/date, type, language, is_retracted, authors[...], source{...}, biblio, cited_by_count, fwci, referenced_works_count, open_access{...}, best_oa_pdf_url, primary_topic, keywords).',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        year_from: { type: 'integer' },
        year_to: { type: 'integer' },
        work_type: { type: 'string' },
        open_access_only: { type: 'boolean' },
        venue: { type: 'string' },
        sort: {
          type: 'string',
          enum: ['relevance', 'cited_by_count', 'publication_date'],
          default: 'relevance'
        },
        max_records: { type: 'integer', default: 50 },
        include_abstracts: { type: 'boolean', default: false }
      }
    },
    returns:
      '{query, filters (applied filter object), venue_resolved? , sort, api_total (meta.count), n_records_returned, records_truncated (api_total > returned), records[]} — each record the lean work shape.',
    example:
      'result = host.mcp("literature", "openalex_search_works", {"query": "CRISPR base editing", "year_from": 2020, "open_access_only": true, "sort": "cited_by_count", "max_records": 25})',
    run: async (ctx, a) => {
      const query = a.query != null && String(a.query).trim() !== '' ? String(a.query) : null
      const sort = String(a.sort ?? 'relevance')
      const maxRecords = clampInt(a.max_records, 50, 1, 500)
      const includeAbstracts = a.include_abstracts === true

      // Assemble the OpenAlex filter object surfaced in the output.
      const filters: Record<string, string> = {}
      if (a.year_from != null)
        filters['from_publication_date'] = `${clampInt(a.year_from, 0, 0, 9999)}-01-01`
      if (a.year_to != null)
        filters['to_publication_date'] = `${clampInt(a.year_to, 0, 0, 9999)}-12-31`
      if (a.work_type != null && String(a.work_type) !== '') filters['type'] = String(a.work_type)
      if (a.open_access_only === true) filters['is_oa'] = 'true'
      const hasVenue = a.venue != null && String(a.venue).trim() !== ''

      if (!query && Object.keys(filters).length === 0 && !hasVenue) {
        throw new Error(
          'openalex_search_works needs at least a query or one filter (year_from/year_to/work_type/open_access_only/venue).'
        )
      }

      let venueResolved: unknown
      if (hasVenue) {
        const resolved = await resolveVenue(ctx, String(a.venue))
        filters['primary_location.source.id'] = resolved.sourceFilterId
        venueResolved = resolved.venueResolved
      }

      const filterStr = Object.entries(filters)
        .map(([k, v]) => `${k}:${v}`)
        .join(',')
      // relevance -> null (OpenAlex applies relevance only alongside a search term); others map to sort=.
      const sortParam = worksSortParam(sort)
      const select = WORK_SELECT + (includeAbstracts ? ',abstract_inverted_index' : '')

      const buildUrl = (cursor: string): string => {
        const params = [`select=${select}`, `per-page=${PER_PAGE}`, `cursor=${cursor}`]
        if (filterStr) params.push(`filter=${filterStr}`)
        if (query) params.push(`search=${encodeURIComponent(query)}`)
        if (sortParam) params.push(`sort=${sortParam}`)
        return `${BASE}/works?${params.join('&')}`
      }

      const { results, count } = await paginate<OpenAlexWork>(ctx, buildUrl, maxRecords)
      const records = results.map((w) => leanWorkWithAbstract(w, includeAbstracts))
      return {
        query,
        filters,
        ...(hasVenue ? { venue_resolved: venueResolved } : {}),
        sort,
        api_total: count,
        n_records_returned: records.length,
        records_truncated: count > records.length,
        records
      }
    }
  },
  {
    id: 'openalex_get_work',
    connector: 'literature',
    description:
      'Fetch one OpenAlex work in full — metadata, abstract (reconstructed from the inverted index, license-gated as in openalex_search_works), OA locations, referenced_works (outgoing W-ids — hydrate with openalex_references) and counts_by_year. Args: work_id (W-id, openalex.org URL, bare DOI, or doi.org URL). DOI lookups resolve via the claimant filter; when several works share one DOI the most-cited is selected and doi_claimants + doi_resolution_note are included. Raises not-found for unknown IDs/DOIs.',
    input: {
      type: 'object',
      properties: { work_id: { type: 'string' } },
      required: ['work_id']
    },
    required: ['work_id'],
    returns:
      'The lean work shape plus {abstract, abstract_license?, abstract_policy?, referenced_works (W-ids), counts_by_year, doi_claimants?, doi_resolution_note?}.',
    example: 'result = host.mcp("literature", "openalex_get_work", {"work_id": "W2741809807"})',
    run: async (ctx, a) => {
      const select = `${WORK_SELECT},abstract_inverted_index,referenced_works,counts_by_year`
      const ref = normalizeWorkId(String(a.work_id))
      let work: OpenAlexWork
      let doiExtra: Record<string, unknown> = {}
      if (ref.kind === 'wid') {
        work = (await ctx.fetchJson(`${BASE}/works/${ref.wid}?select=${select}`)) as OpenAlexWork
      } else {
        const resp = (await ctx.fetchJson(
          `${BASE}/works?filter=doi:${encodeURIComponent(ref.doi)}&per-page=50&select=${select}`
        )) as ListResponse<OpenAlexWork>
        const results = resp.results ?? []
        if (results.length === 0) throw new Error(`No OpenAlex work found for DOI '${ref.doi}'`)
        work = pickMostCited(results)
        if (results.length > 1) {
          doiExtra = {
            doi_claimants: results.map(toClaimant),
            doi_resolution_note: `DOI '${ref.doi}' maps to ${results.length} OpenAlex works; selected the most-cited (${shortId(work.id)}).`
          }
        }
      }
      return {
        ...leanWork(work),
        ...abstractFields(work),
        referenced_works: (work.referenced_works ?? []).map((r) => shortId(r)),
        counts_by_year: work.counts_by_year,
        ...doiExtra
      }
    }
  },
  {
    id: 'openalex_citations',
    connector: 'literature',
    description:
      "List works that CITE a given work (incoming citations) via OpenAlex's citation graph. Args: work_id (W-id/URL/DOI — DOIs cost one extra resolution request), sort (cited_by_count default / publication_date / relevance), max_records (default 50, ceiling 500), include_abstracts. Returns {work_id, api_total (the true citing-work count), n_records_returned, records_truncated, records} (lean work records).",
    input: {
      type: 'object',
      properties: {
        work_id: { type: 'string' },
        sort: {
          type: 'string',
          enum: ['cited_by_count', 'publication_date', 'relevance'],
          default: 'cited_by_count'
        },
        max_records: { type: 'integer', default: 50 },
        include_abstracts: { type: 'boolean', default: false }
      },
      required: ['work_id']
    },
    required: ['work_id'],
    returns:
      '{work_id (resolved W-id), api_total, n_records_returned, records_truncated, records[], doi_claimants?, doi_resolution_note?}.',
    example:
      'result = host.mcp("literature", "openalex_citations", {"work_id": "W2741809807", "sort": "cited_by_count", "max_records": 50})',
    run: async (ctx, a) => {
      const sort = String(a.sort ?? 'cited_by_count')
      const maxRecords = clampInt(a.max_records, 50, 1, 500)
      const includeAbstracts = a.include_abstracts === true
      const resolved = await resolveWorkIdToWid(ctx, String(a.work_id))
      const sortParam = worksSortParam(sort)
      const select = WORK_SELECT + (includeAbstracts ? ',abstract_inverted_index' : '')

      const buildUrl = (cursor: string): string => {
        const params = [
          `filter=cites:${resolved.wid}`,
          `select=${select}`,
          `per-page=${PER_PAGE}`,
          `cursor=${cursor}`
        ]
        if (sortParam) params.push(`sort=${sortParam}`)
        return `${BASE}/works?${params.join('&')}`
      }

      const { results, count } = await paginate<OpenAlexWork>(ctx, buildUrl, maxRecords)
      const records = results.map((w) => leanWorkWithAbstract(w, includeAbstracts))
      return {
        work_id: resolved.wid,
        api_total: count,
        n_records_returned: records.length,
        records_truncated: count > records.length,
        records,
        ...(resolved.doi_claimants ? { doi_claimants: resolved.doi_claimants } : {}),
        ...(resolved.doi_resolution_note
          ? { doi_resolution_note: resolved.doi_resolution_note }
          : {})
      }
    }
  },
  {
    id: 'openalex_references',
    connector: 'literature',
    description:
      'List the works a given work CITES (outgoing references), hydrated to full metadata in reference-list order. Args: work_id (W-id/URL/DOI), max_records (default 100, ceiling 500; hydration batched 50/request). Returns {work_id, n_references, n_records_returned, records_truncated, references_not_hydrated (IDs OpenAlex has no record for — never silently dropped), reference_ids (ALL outgoing W-ids), records}.',
    input: {
      type: 'object',
      properties: {
        work_id: { type: 'string' },
        max_records: { type: 'integer', default: 100 }
      },
      required: ['work_id']
    },
    required: ['work_id'],
    returns:
      '{work_id, n_references, n_records_returned, records_truncated, references_not_hydrated[], reference_ids[] (all outgoing W-ids, order preserved), records[]}.',
    example:
      'result = host.mcp("literature", "openalex_references", {"work_id": "W2741809807", "max_records": 100})',
    run: async (ctx, a) => {
      const maxRecords = clampInt(a.max_records, 100, 1, 500)
      const resolved = await resolveWorkIdToWid(ctx, String(a.work_id))
      const meta = (await ctx.fetchJson(
        `${BASE}/works/${resolved.wid}?select=referenced_works`
      )) as OpenAlexWork
      const referenceIds = (meta.referenced_works ?? [])
        .map((r) => shortId(r))
        .filter((r): r is string => Boolean(r))
      const nReferences = referenceIds.length
      const attemptIds = referenceIds.slice(0, maxRecords)

      // Hydrate the attempted ids in batches of 50 (openalex_id OR filter), keyed by short W-id.
      const hydrated = new Map<string, OpenAlexWork>()
      for (let i = 0; i < attemptIds.length; i += 50) {
        const batch = attemptIds.slice(i, i + 50)
        const resp = (await ctx.fetchJson(
          `${BASE}/works?filter=openalex_id:${batch.join('|')}&per-page=50&select=${WORK_SELECT}`
        )) as ListResponse<OpenAlexWork>
        for (const w of resp.results ?? []) {
          const id = shortId(w.id)
          if (id) hydrated.set(id, w)
        }
      }

      const records = attemptIds
        .filter((id) => hydrated.has(id))
        .map((id) => leanWork(hydrated.get(id) as OpenAlexWork))
      const referencesNotHydrated = attemptIds.filter((id) => !hydrated.has(id))
      return {
        work_id: resolved.wid,
        n_references: nReferences,
        n_records_returned: records.length,
        records_truncated: nReferences > attemptIds.length,
        references_not_hydrated: referencesNotHydrated,
        reference_ids: referenceIds,
        records
      }
    }
  },
  {
    id: 'openalex_search_authors',
    connector: 'literature',
    description:
      'Search OpenAlex author profiles by name. Args: query (matches display name + alternatives; expect homonyms — check affiliations/topics/ORCID), max_records (default 25, ceiling 500). Returns {query, api_total, n_records_returned, records_truncated, records}; each record {author_id, name, orcid, works_count, cited_by_count, h_index, i10_index, affiliations[{institution, years}], last_known_institutions, top_topics}. Use author_id with openalex_get_author.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_records: { type: 'integer', default: 25 }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '{query, api_total, n_records_returned, records_truncated, records[]} — each record the lean author shape.',
    example:
      'result = host.mcp("literature", "openalex_search_authors", {"query": "Jennifer Doudna", "max_records": 25})',
    run: async (ctx, a) => {
      const query = String(a.query)
      const maxRecords = clampInt(a.max_records, 25, 1, 500)
      const buildUrl = (cursor: string): string =>
        `${BASE}/authors?search=${encodeURIComponent(query)}&select=${AUTHOR_SELECT}&per-page=${PER_PAGE}&cursor=${cursor}`
      const { results, count } = await paginate<OpenAlexAuthor>(ctx, buildUrl, maxRecords)
      const records = results.map(leanAuthor)
      return {
        query,
        api_total: count,
        n_records_returned: records.length,
        records_truncated: count > records.length,
        records
      }
    }
  },
  {
    id: 'openalex_get_author',
    connector: 'literature',
    description:
      "Fetch one OpenAlex author profile plus their top-cited works. Args: author_id (A-id, openalex.org URL, or ORCID; CAVEAT: OpenAlex's ORCID pointer can resolve to a sparse duplicate — prefer the A-id from openalex_search_authors), works_sample (default 10, max 200; 0 skips the extra request). Returns the author record plus counts_by_year, top_works_total (true total works count) and top_works (lean work records by citations).",
    input: {
      type: 'object',
      properties: {
        author_id: { type: 'string' },
        works_sample: { type: 'integer', default: 10 }
      },
      required: ['author_id']
    },
    required: ['author_id'],
    returns:
      'The lean author shape plus {counts_by_year, top_works_total, top_works[] (lean work records by citations)}.',
    example:
      'result = host.mcp("literature", "openalex_get_author", {"author_id": "A5023888391", "works_sample": 10})',
    run: async (ctx, a) => {
      const worksSample = clampInt(a.works_sample, 10, 0, 200)
      const idToken = normalizeAuthorId(String(a.author_id))
      const author = (await ctx.fetchJson(
        `${BASE}/authors/${idToken}?select=${AUTHOR_SELECT}`
      )) as OpenAlexAuthor
      const aid = shortId(author.id) ?? ''

      let topWorks: Record<string, unknown>[] = []
      let topWorksTotal = 0
      if (worksSample > 0) {
        const resp = (await ctx.fetchJson(
          `${BASE}/works?filter=author.id:${aid}&sort=cited_by_count:desc&per-page=${worksSample}&select=${WORK_SELECT}`
        )) as ListResponse<OpenAlexWork>
        topWorksTotal = resp.meta?.count ?? 0
        topWorks = (resp.results ?? []).map(leanWork)
      }
      return {
        ...leanAuthor(author),
        counts_by_year: author.counts_by_year,
        top_works_total: topWorksTotal,
        top_works: topWorks
      }
    }
  },
  {
    id: 'openalex_venue_info',
    connector: 'literature',
    description:
      "Look up journals/repositories ('sources') in OpenAlex — OA status, DOAJ listing, APC, citation metrics. Args: venue (exact S-id, openalex.org URL, or ISSN for a single record; anything else is a name search), max_records (default 10, ceiling 500; name-search only). Returns: exact -> one source record + counts_by_year; name search -> {query, api_total, n_records_returned, records_truncated, records}. Source record: {source_id, display_name, type, issn_l, issn, host_organization, country_code, homepage_url, is_oa, is_in_doaj, is_core, apc_usd, works_count, cited_by_count, h_index, two_year_mean_citedness, first/last_publication_year, top_topics}.",
    input: {
      type: 'object',
      properties: {
        venue: { type: 'string' },
        max_records: { type: 'integer', default: 10 }
      },
      required: ['venue']
    },
    required: ['venue'],
    returns:
      'Exact id -> the lean source shape plus {counts_by_year}. Name search -> {query, api_total, n_records_returned, records_truncated, records[]}.',
    example:
      'result = host.mcp("literature", "openalex_venue_info", {"venue": "Nature", "max_records": 10})',
    run: async (ctx, a) => {
      const venue = String(a.venue)
      if (isExactSourceId(venue)) {
        const source = (await ctx.fetchJson(
          `${BASE}/sources/${normalizeSourceId(venue)}?select=${SOURCE_SELECT}`
        )) as OpenAlexSource
        return { ...leanSource(source), counts_by_year: source.counts_by_year }
      }
      const maxRecords = clampInt(a.max_records, 10, 1, 500)
      // Cursor-paginate the name search (OpenAlex caps per-page at 200, but max_records goes to 500).
      const buildUrl = (cursor: string): string =>
        `${BASE}/sources?search=${encodeURIComponent(venue)}&select=${SOURCE_SELECT}&per-page=${PER_PAGE}&cursor=${cursor}`
      const { results, count } = await paginate<OpenAlexSource>(ctx, buildUrl, maxRecords)
      const records = results.map(leanSource)
      return {
        query: venue,
        api_total: count,
        n_records_returned: records.length,
        records_truncated: count > records.length,
        records
      }
    }
  }
]
