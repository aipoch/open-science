import type { ToolContext, ToolDescriptor } from '../types'

// bioRxiv/medRxiv REST API (api.biorxiv.org): read-only preprint metadata, published-article links,
// funder listings, and platform statistics. There is NO keyword/text search — filter by date and
// category only. Every route answers an empty result with HTTP 200 + status "no posts found".
const BASE = 'https://api.biorxiv.org'

// The 27 bioRxiv submission categories (captured from the platform). The API accepts the underscore
// form in ?category= and echoes back the spaced form.
const BIORXIV_CATEGORIES = [
  'animal behavior and cognition',
  'biochemistry',
  'bioengineering',
  'bioinformatics',
  'biophysics',
  'cancer biology',
  'cell biology',
  'clinical trials',
  'developmental biology',
  'ecology',
  'epidemiology',
  'evolutionary biology',
  'genetics',
  'genomics',
  'immunology',
  'microbiology',
  'molecular biology',
  'neuroscience',
  'paleontology',
  'pathology',
  'pharmacology and toxicology',
  'physiology',
  'plant biology',
  'scientific communication and education',
  'synthetic biology',
  'systems biology',
  'zoology'
]

// Public web domain per server, used to build the preprint pdf_url / web_url.
const SERVER_DOMAINS: Record<string, string> = {
  biorxiv: 'www.biorxiv.org',
  medrxiv: 'www.medrxiv.org'
}

const DEFAULT_WINDOW_DAYS = 60 // no search method specified -> last 60 days
const RECENT_COUNT_WINDOW_DAYS = 90 // recent_count searches a 90-day window
const PREVIEW_CHARS = 200 // abstract_preview length before the "..." ellipsis

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const PUBLISHER_RE = /^10\.\d{4,9}$/
const ROR_RE = /^[0-9a-z]{9}$/
// one slash only (prefix/suffix); suffix restricted to DOI-safe chars — no ?, #, /
const DOI_RE = /^10\.\d{4,9}\/[A-Za-z0-9][A-Za-z0-9._;()-]*$/

type BiorxivMessage = { status?: string; total?: string | number }
type BiorxivRecord = Record<string, unknown>
type BiorxivPayload = {
  messages?: BiorxivMessage[] | BiorxivMessage
  collection?: BiorxivRecord[]
} & Record<string, unknown>

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// Coerce the API's sometimes-string, sometimes-int numeric fields to a number.
const toInt = (value: unknown): number => Number.parseInt(String(value), 10)

// Validate the server selector; anything but the two known servers is a hard error.
const checkServer = (server: unknown): 'biorxiv' | 'medrxiv' => {
  const s = server == null ? 'biorxiv' : String(server)
  if (s !== 'biorxiv' && s !== 'medrxiv') {
    throw new Error(`server must be 'biorxiv' or 'medrxiv', got '${s}'`)
  }
  return s
}

// Validate a YYYY-MM-DD date string.
const checkDate = (value: unknown, name: string): string => {
  const s = String(value)
  if (!DATE_RE.test(s)) throw new Error(`${name} must be 'YYYY-MM-DD', got '${s}'`)
  return s
}

// Strip a doi.org URL prefix; the API path takes the bare "10.xxxx/yyyy" DOI (slash kept literal).
const normalizeDoi = (doi: string): string => {
  const d = doi.trim()
  const marker = 'doi.org/'
  const idx = d.indexOf(marker)
  return idx >= 0 ? d.slice(idx + marker.length) : d
}

// Validate a preprint DOI shape after normalization.
const checkDoi = (doi: string): string => {
  const s = doi.trim()
  if (!DOI_RE.test(s)) throw new Error(`not a valid preprint DOI: '${doi}'`)
  return s
}

// UTC date (YYYY-MM-DD) N days before today; N=0 is today.
const daysAgo = (days: number): string =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

const today = (): string => new Date().toISOString().slice(0, 10)

// The "...?category=<underscored>" suffix, empty when no category is given.
const categorySuffix = (category: unknown): string => {
  if (!category) return ''
  const norm = String(category).trim().toLowerCase().replace(/ /g, '_')
  return `?category=${encodeURIComponent(norm)}`
}

type SearchWindow = { from: string; to: string; recentCount: number | null }

// Resolve the three mutually-exclusive search methods to a closed date interval. Precedence matches
// the source: explicit date_from+date_to, then recent_days, then recent_count (90-day window, tail of
// N records), else the default 60-day window. `is not None` semantics honour recent_days/count of 0.
const resolveWindow = (a: Record<string, unknown>): SearchWindow => {
  if (a.date_from && a.date_to) {
    return {
      from: checkDate(a.date_from, 'date_from'),
      to: checkDate(a.date_to, 'date_to'),
      recentCount: null
    }
  }
  if (a.recent_days != null) {
    return { from: daysAgo(Math.trunc(Number(a.recent_days))), to: today(), recentCount: null }
  }
  if (a.recent_count != null) {
    return {
      from: daysAgo(RECENT_COUNT_WINDOW_DAYS),
      to: today(),
      recentCount: Math.trunc(Number(a.recent_count))
    }
  }
  return { from: daysAgo(DEFAULT_WINDOW_DAYS), to: today(), recentCount: null }
}

// Clamp the caller's limit into the supported 1..100 range (default 10).
const resolveLimit = (a: Record<string, unknown>): number => {
  const raw = a.limit == null ? 10 : Math.trunc(Number(a.limit))
  return Math.max(1, Math.min(100, raw))
}

// The first message block, tolerating both the list form (listing routes) and the bare-object form
// (statistics routes).
const firstMessage = (payload: BiorxivPayload): BiorxivMessage => {
  const m = payload.messages
  if (Array.isArray(m)) return m[0] ?? {}
  return m ?? {}
}

type Page = { records: BiorxivRecord[]; total: number; status: string }

// Fetch one upstream page: empty on "no posts found", raise on any non-"ok" status.
const fetchPage = async (ctx: ToolContext, path: string): Promise<Page> => {
  const payload = (await ctx.fetchJson(BASE + path)) as BiorxivPayload
  const msg = firstMessage(payload)
  const status = String(msg.status ?? '')
  if (status === 'no posts found') return { records: [], total: 0, status }
  if (status !== 'ok') throw new Error(`bioRxiv API status '${status}' at ${path}`)
  const total = toInt(msg.total ?? 0) || 0
  return { records: payload.collection ?? [], total, status }
}

type Collected = { records: BiorxivRecord[]; total: number }

// Cursor walk from `start` until `needed` records are gathered (or the stream is exhausted). Detail
// pages carry 30 records, pubs/publisher pages carry 100; the cursor advances by the page length.
const collect = async (
  ctx: ToolContext,
  pathFn: (cursor: number) => string,
  start: number,
  needed: number
): Promise<Collected> => {
  const records: BiorxivRecord[] = []
  let total = 0
  let cursor = start
  while (records.length < needed) {
    const page = await fetchPage(ctx, pathFn(cursor))
    total = page.total
    if (page.records.length === 0) break
    records.push(...page.records)
    cursor += page.records.length
    if (cursor >= total) break
  }
  return { records: records.slice(0, needed), total }
}

// Resolve a search into records: a plain cursor walk, or (recent_count) learn the window total then
// read the most-recent N-record tail.
const searchWindow = async (
  ctx: ToolContext,
  pathFn: (cursor: number) => string,
  cursor: number,
  limit: number,
  recentCount: number | null
): Promise<Collected> => {
  if (recentCount === null) return collect(ctx, pathFn, cursor, limit)
  const first = await fetchPage(ctx, pathFn(0))
  if (first.status === 'no posts found' || first.total === 0) return { records: [], total: 0 }
  // "0 most recent" is a valid empty page, but the window total must still be reported.
  if (recentCount === 0) return { records: [], total: first.total }
  const start = Math.max(first.total - recentCount, 0) + cursor
  return collect(ctx, pathFn, start, Math.min(limit, recentCount))
}

// A <=200-char abstract preview (with ellipsis); null when the record has no string abstract.
const preview = (abstract: unknown): string | null => {
  if (typeof abstract !== 'string') return null
  return abstract.length > PREVIEW_CHARS ? `${abstract.slice(0, PREVIEW_CHARS)}...` : abstract
}

// Compact per-record summary shared by search_preprints and search_by_funder.
const preprintSummary = (r: BiorxivRecord): Record<string, unknown> => ({
  doi: r.doi,
  title: r.title,
  authors: r.authors,
  date: r.date,
  category: r.category,
  version: r.version,
  abstract_preview: preview(r.abstract)
})

// Standard listing envelope. total is null on the funder route (no upstream total) so callers use
// count < limit to detect end-of-stream, never a lying 0 next to a non-empty page.
const searchResponse = (
  records: BiorxivRecord[],
  cursor: number,
  total: number
): Record<string, unknown> => {
  const results = records.map(preprintSummary)
  const t = !total && results.length ? null : total
  return { success: true, results, cursor, count: results.length, total: t, error: null }
}

const searchError = (message: string, cursor: number): Record<string, unknown> => ({
  success: false,
  results: [],
  cursor,
  count: 0,
  total: 0,
  error: message
})

// Summary-mode keys for search_published_preprints when include_details is false.
const PUBLISHED_SUMMARY_KEYS = [
  'published_doi',
  'published_journal',
  'preprint_platform',
  'preprint_title',
  'preprint_category',
  'preprint_date',
  'published_date'
]

// One published-preprint link: always the preprint DOI, plus either every other field (details) or
// the fixed summary subset.
const publishedRecord = (rec: BiorxivRecord, includeDetails: boolean): Record<string, unknown> => {
  const out: Record<string, unknown> = { biorxiv_doi: rec.preprint_doi ?? rec.biorxiv_doi }
  if (includeDetails) {
    for (const [k, v] of Object.entries(rec)) {
      if (k !== 'preprint_doi' && k !== 'biorxiv_doi') out[k] = v
    }
  } else {
    for (const k of PUBLISHED_SUMMARY_KEYS) {
      if (k in rec) out[k] = rec[k]
    }
  }
  return out
}

const publishedResponse = (
  records: BiorxivRecord[],
  cursor: number,
  total: number,
  includeDetails: boolean
): Record<string, unknown> => {
  const results = records.map((r) => publishedRecord(r, includeDetails))
  const t = !total && results.length ? null : total
  return { success: true, results, cursor, count: results.length, total: t, error: null }
}

// Full single-preprint record built from the latest version, with derived pdf/web URLs.
const preprintResponse = (versions: BiorxivRecord[], server: string): Record<string, unknown> => {
  const rec = versions[versions.length - 1]
  const doi = rec.doi
  const version = rec.version
  const domain = SERVER_DOMAINS[server] ?? SERVER_DOMAINS.biorxiv
  const funder = rec.funder
  return {
    success: true,
    preprint: {
      doi,
      title: rec.title,
      authors: rec.authors,
      author_corresponding: rec.author_corresponding,
      author_corresponding_institution: rec.author_corresponding_institution,
      date: rec.date,
      version,
      type: rec.type,
      category: rec.category,
      license: rec.license,
      abstract: rec.abstract,
      jatsxml: rec.jatsxml,
      funding: funder == null || funder === 'NA' ? null : funder,
      published_doi: rec.published ?? 'NA',
      server: rec.server,
      pdf_url: `https://${domain}/content/${doi}v${version}.full.pdf`,
      web_url: `https://${domain}/content/${doi}v${version}`,
      n_versions: versions.length
    },
    error: null
  }
}

const categoriesResponse = (): Record<string, unknown> => ({
  success: true,
  categories: BIORXIV_CATEGORIES.map((name) => ({
    name,
    api_format: name.replace(/ /g, '_'),
    description: null
  })),
  error: null
})

const INTERVALS: Record<string, string> = { monthly: 'm', yearly: 'y' }

// Map the interval arg to the upstream one-letter code (default monthly).
const resolveInterval = (a: Record<string, unknown>): string => {
  const key = a.interval == null || a.interval === '' ? 'monthly' : String(a.interval)
  const code = INTERVALS[key]
  if (!code) throw new Error(`Invalid interval: ${key}. Must be one of: monthly, yearly`)
  return code
}

// Fetch a statistics route (/sum or /usage) and return its data rows.
const statsRows = async (
  ctx: ToolContext,
  route: string,
  interval: string
): Promise<BiorxivRecord[]> => {
  const payload = (await ctx.fetchJson(`${BASE}/${route}/${interval}/json`)) as BiorxivPayload
  const msg = firstMessage(payload)
  if (String(msg.status ?? '') !== 'ok') {
    throw new Error(`bioRxiv API status '${msg.status}' for /${route}/${interval}`)
  }
  // The rows live under the single non-"messages" key.
  const key = Object.keys(payload).find((k) => k !== 'messages')
  return (key ? (payload[key] as BiorxivRecord[]) : []) ?? []
}

const contentStatsResponse = (rows: BiorxivRecord[]): Record<string, unknown> => ({
  success: true,
  results: rows.map((r) => {
    const out: Record<string, unknown> = {}
    if ('month' in r) out.month = String(r.month)
    else out.year = toInt(r.year)
    out.new_papers = toInt(r.new_papers)
    out.new_papers_cumulative = toInt(r.new_papers_cumulative)
    out.revised_papers = toInt(r.revised_papers)
    out.revised_papers_cumulative = toInt(r.revised_papers_cumulative)
    return out
  }),
  error: null
})

const USAGE_KEYS = [
  'abstract_views',
  'full_text_views',
  'pdf_downloads',
  'abstract_cumulative',
  'full_text_cumulative',
  'pdf_cumulative'
]

const usageStatsResponse = (rows: BiorxivRecord[]): Record<string, unknown> => ({
  success: true,
  results: rows.map((r) => {
    const out: Record<string, unknown> = {}
    if ('month' in r) out.month = String(r.month)
    else out.year = String(r.year)
    for (const k of USAGE_KEYS) out[k] = toInt(r[k])
    return out
  }),
  error: null
})

const statsError = (message: string): Record<string, unknown> => ({
  success: false,
  results: [],
  error: message
})

// Shared JSON-schema fragments reused across tool inputs.
const CATEGORY_SCHEMA = {
  type: 'string',
  enum: BIORXIV_CATEGORIES,
  description: 'Subject category to filter by (see get_categories)'
}
const SERVER_SCHEMA = {
  type: 'string',
  enum: ['biorxiv', 'medrxiv'],
  default: 'biorxiv',
  description: "'biorxiv' (biological sciences) or 'medrxiv' (medical sciences)"
}

// bioRxiv/medRxiv preprint search, metadata, publication links, funder listings, and statistics.
export const BIORXIV_TOOLS: ToolDescriptor[] = [
  {
    id: 'get_categories',
    connector: 'biorxiv',
    description:
      'List all 27 bioRxiv subject categories and their API-compatible slugs (e.g. "cancer biology" -> "cancer_biology"). Use before search_preprints to discover valid category values.',
    input: { type: 'object', properties: {} },
    returns:
      '`{ "success": true, "categories": [ { "name": str, "api_format": str, "description": null } ], "error": null }` — 27 entries.',
    example: 'const result = await host.mcp("biorxiv", "get_categories", {})',
    run: async () => categoriesResponse()
  },
  {
    id: 'search_preprints',
    connector: 'biorxiv',
    description:
      'Search bioRxiv/medRxiv preprints by date and (optionally) category. Use exactly ONE search method: date_from+date_to, recent_days (last N days), or recent_count (N most recent within a 90-day window); with none, the last 60 days. There is NO keyword/text search. cursor paginates. Returns DOI, title, authors, date, category, version, and a 200-char abstract preview.',
    input: {
      type: 'object',
      properties: {
        server: SERVER_SCHEMA,
        category: CATEGORY_SCHEMA,
        date_from: { type: 'string', description: 'Start date YYYY-MM-DD (use with date_to)' },
        date_to: { type: 'string', description: 'End date YYYY-MM-DD (use with date_from)' },
        recent_days: { type: 'integer', minimum: 1, description: 'Preprints from the last N days' },
        recent_count: {
          type: 'integer',
          minimum: 1,
          description: 'N most recent within a ~90-day window'
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
        cursor: { type: 'integer', minimum: 0, default: 0 }
      }
    },
    returns:
      '`{ "success": bool, "results": [ { "doi", "title", "authors", "date", "category", "version", "abstract_preview" } ], "cursor": int, "count": int, "total": int|null, "error": null }`. `total` is the window total (null when the route reports none).',
    example:
      'const result = await host.mcp("biorxiv", "search_preprints", {"recent_days": 30, "category": "neuroscience", "limit": 20})',
    run: async (ctx, a) => {
      const cursor = Number(a.cursor ?? 0)
      try {
        const server = checkServer(a.server)
        const w = resolveWindow(a)
        const suffix = categorySuffix(a.category)
        const pathFn = (c: number): string =>
          `/details/${server}/${w.from}/${w.to}/${c}/json${suffix}`
        const { records, total } = await searchWindow(
          ctx,
          pathFn,
          cursor,
          resolveLimit(a),
          w.recentCount
        )
        return searchResponse(records, cursor, total)
      } catch (err) {
        return searchError(errMsg(err), cursor)
      }
    }
  },
  {
    id: 'get_preprint',
    connector: 'biorxiv',
    description:
      'Get complete metadata for one preprint by DOI (bare "10.1101/..." or a full https://doi.org/ URL). Uses the latest version. Returns title, authors, corresponding author + institution, full abstract, category, license, version, JATS XML, funding, published journal DOI (if linked), PDF and web URLs, and version count. Preprints are NOT peer-reviewed.',
    input: {
      type: 'object',
      properties: {
        doi: { type: 'string', description: 'Preprint DOI, e.g. "10.1101/339747"' },
        server: SERVER_SCHEMA
      },
      required: ['doi']
    },
    returns:
      '`{ "success": bool, "preprint": { "doi", "title", "authors", "author_corresponding", "author_corresponding_institution", "date", "version", "type", "category", "license", "abstract", "jatsxml", "funding", "published_doi", "server", "pdf_url", "web_url", "n_versions" }, "error": str|null }`. On an unknown DOI: `success:false`, `preprint:null`, `error` set.',
    example: 'const result = await host.mcp("biorxiv", "get_preprint", {"doi": "10.1101/339747"})',
    run: async (ctx, a) => {
      try {
        const server = checkServer(a.server)
        const doi = checkDoi(normalizeDoi(String(a.doi)))
        const payload = (await ctx.fetchJson(
          `${BASE}/details/${server}/${doi}/na/json`
        )) as BiorxivPayload
        const status = String(firstMessage(payload).status ?? '')
        const versions = payload.collection ?? []
        if (status === 'no posts found' || versions.length === 0) {
          throw new Error(`DOI ${doi} not found on ${server}`)
        }
        if (status !== 'ok') throw new Error(`API status '${status}' for DOI ${doi} on ${server}`)
        return preprintResponse(versions, server)
      } catch (err) {
        return { success: false, preprint: null, error: errMsg(err) }
      }
    }
  },
  {
    id: 'search_published_preprints',
    connector: 'biorxiv',
    description:
      'Find preprints that were later published in peer-reviewed journals (preprint -> journal-article links). Same ONE-OF search methods as search_preprints (date_from+date_to / recent_days / recent_count). include_details=false returns a compact summary. publisher filters by journal DOI prefix (e.g. "10.1038" for Nature) via the bioRxiv-only /publisher route.',
    input: {
      type: 'object',
      properties: {
        server: SERVER_SCHEMA,
        publisher: {
          type: 'string',
          description: 'Publisher DOI prefix, e.g. "10.1038" (bioRxiv only)'
        },
        include_details: { type: 'boolean', default: true },
        date_from: { type: 'string', description: 'Start date YYYY-MM-DD (use with date_to)' },
        date_to: { type: 'string', description: 'End date YYYY-MM-DD (use with date_from)' },
        recent_days: { type: 'integer', minimum: 1 },
        recent_count: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
        cursor: { type: 'integer', minimum: 0, default: 0 }
      }
    },
    returns:
      '`{ "success": bool, "results": [ { "biorxiv_doi", ...link fields } ], "cursor": int, "count": int, "total": int|null, "error": null }`. With include_details each result carries every upstream field (published_doi, published_journal, preprint_title, dates, etc.); with include_details=false, only the summary subset.',
    example:
      'const result = await host.mcp("biorxiv", "search_published_preprints", {"publisher": "10.1038", "date_from": "2024-01-01", "date_to": "2024-01-05", "limit": 10})',
    run: async (ctx, a) => {
      const cursor = Number(a.cursor ?? 0)
      try {
        const server = checkServer(a.server)
        const w = resolveWindow(a)
        const publisher = a.publisher
        let pathFn: (c: number) => string
        if (publisher != null && publisher !== '') {
          if (server !== 'biorxiv') {
            throw new Error(
              "the upstream /publisher route is bioRxiv-only; publisher cannot be combined with server='medrxiv'"
            )
          }
          if (!PUBLISHER_RE.test(String(publisher))) {
            throw new Error(
              `publisher must be a DOI prefix like '10.1038', got '${String(publisher)}'`
            )
          }
          pathFn = (c: number): string => `/publisher/${publisher}/${w.from}/${w.to}/${c}`
        } else {
          pathFn = (c: number): string => `/pubs/${server}/${w.from}/${w.to}/${c}/json`
        }
        const { records, total } = await searchWindow(
          ctx,
          pathFn,
          cursor,
          resolveLimit(a),
          w.recentCount
        )
        const includeDetails = a.include_details == null ? true : Boolean(a.include_details)
        return publishedResponse(records, cursor, total, includeDetails)
      } catch (err) {
        return searchError(errMsg(err), cursor)
      }
    }
  },
  {
    id: 'search_by_funder',
    connector: 'biorxiv',
    description:
      'Find preprints acknowledging a funder, identified by ROR id (9-char, e.g. "021nxhr62" for NIH; a full https://ror.org/ URL is also accepted). Requires an explicit date_from + date_to; funder metadata begins 2025-04-10. Optional category filter. cursor paginates. Same compact result shape as search_preprints.',
    input: {
      type: 'object',
      properties: {
        funder_ror_id: { type: 'string', description: 'Funder ROR id, e.g. "021nxhr62" (NIH)' },
        date_from: { type: 'string', description: 'Start date YYYY-MM-DD (>= 2025-04-10)' },
        date_to: { type: 'string', description: 'End date YYYY-MM-DD' },
        server: SERVER_SCHEMA,
        category: CATEGORY_SCHEMA,
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
        cursor: { type: 'integer', minimum: 0, default: 0 }
      },
      required: ['funder_ror_id', 'date_from', 'date_to']
    },
    returns:
      '`{ "success": bool, "results": [ { "doi", "title", "authors", "date", "category", "version", "abstract_preview" } ], "cursor": int, "count": int, "total": int|null, "error": null }`. The funder route reports no total, so `total` is null when results exist; page with cursor until count < limit.',
    example:
      'const result = await host.mcp("biorxiv", "search_by_funder", {"funder_ror_id": "021nxhr62", "date_from": "2025-04-10", "date_to": "2025-05-10", "limit": 10})',
    run: async (ctx, a) => {
      const cursor = Number(a.cursor ?? 0)
      try {
        const server = checkServer(a.server)
        const ror = (String(a.funder_ror_id).split('/').pop() ?? '').trim().toLowerCase()
        if (!ROR_RE.test(ror)) throw new Error(`ROR id must be 9 chars [0-9a-z], got '${ror}'`)
        const dateFrom = checkDate(a.date_from, 'date_from')
        const dateTo = checkDate(a.date_to, 'date_to')
        const suffix = categorySuffix(a.category)
        const pathFn = (c: number): string =>
          `/funder/${server}/${dateFrom}/${dateTo}/${ror}/${c}/json${suffix}`
        const { records, total } = await collect(ctx, pathFn, cursor, resolveLimit(a))
        return searchResponse(records, cursor, total)
      } catch (err) {
        return searchError(errMsg(err), cursor)
      }
    }
  },
  {
    id: 'get_content_statistics',
    connector: 'biorxiv',
    description:
      'bioRxiv submission statistics over all history — new vs revised paper counts per period, with running cumulative totals. interval is "monthly" (default) or "yearly".',
    input: {
      type: 'object',
      properties: {
        interval: { type: 'string', enum: ['monthly', 'yearly'], default: 'monthly' }
      }
    },
    returns:
      '`{ "success": bool, "results": [ { "month"|"year", "new_papers", "new_papers_cumulative", "revised_papers", "revised_papers_cumulative" } ], "error": null }`. Monthly rows carry "month" (YYYY-MM); yearly rows carry "year".',
    example:
      'const result = await host.mcp("biorxiv", "get_content_statistics", {"interval": "yearly"})',
    run: async (ctx, a) => {
      try {
        return contentStatsResponse(await statsRows(ctx, 'sum', resolveInterval(a)))
      } catch (err) {
        return statsError(errMsg(err))
      }
    }
  },
  {
    id: 'get_usage_statistics',
    connector: 'biorxiv',
    description:
      'bioRxiv usage/engagement statistics over all history — abstract views, full-text views, and PDF downloads per period, with running cumulative totals. interval is "monthly" (default) or "yearly".',
    input: {
      type: 'object',
      properties: {
        interval: { type: 'string', enum: ['monthly', 'yearly'], default: 'monthly' }
      }
    },
    returns:
      '`{ "success": bool, "results": [ { "month"|"year", "abstract_views", "full_text_views", "pdf_downloads", "abstract_cumulative", "full_text_cumulative", "pdf_cumulative" } ], "error": null }`. Monthly rows carry "month" (YYYY-MM); yearly rows carry "year".',
    example:
      'const result = await host.mcp("biorxiv", "get_usage_statistics", {"interval": "yearly"})',
    run: async (ctx, a) => {
      try {
        return usageStatsResponse(await statsRows(ctx, 'usage', resolveInterval(a)))
      } catch (err) {
        return statsError(errMsg(err))
      }
    }
  }
]
