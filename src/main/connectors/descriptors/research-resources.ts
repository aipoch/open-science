import type { ToolContext, ToolDescriptor } from '../types'

// Research Resources aggregates two read-only registries:
//  * Grants.gov search2 (POST-only funding-opportunity search, complete + count-verified).
//  * The Antibody Registry (antibodyregistry.org, ~3.2M full-text antibody records).
// Both mirror the upstream mcp-research-resources server (grants_gov_search + antibody_registry).

// ------------------------------------------------------------------ Grants.gov

const GRANTS_URL = 'https://api.grants.gov/v1/api/search2'
// search2 has no documented page-size limit; the upstream client walks 1000 rows per POST.
const GRANTS_ROWS_PER_PAGE = 1000
// Valid oppStatuses; an invalid value is silently accepted upstream and yields empty pages.
const VALID_STATUSES = ['forecasted', 'posted', 'closed', 'archived']
// The API's own default status set when oppStatuses is omitted (current opportunities).
const DEFAULT_STATUSES = 'forecasted|posted'
// Facet blocks returned by search2 (each ignores the filter on its own dimension); the count route
// omits dateRangeOptions.
const SEARCH_FACET_KEYS = [
  'oppStatusOptions',
  'agencies',
  'eligibilities',
  'fundingCategories',
  'fundingInstruments',
  'dateRangeOptions'
]
const COUNT_FACET_KEYS = SEARCH_FACET_KEYS.filter((k) => k !== 'dateRangeOptions')

type OppHit = { id?: string; number?: string } & Record<string, unknown>
type Search2Data = { hitCount: number; oppHits: OppHit[] } & Record<string, unknown>
type Search2Envelope = { errorcode?: number; msg?: string; data?: Search2Data }

// Accepts a string, an array of values, or null/undefined; returns the pipe-joined string ("" empty).
const pipeJoin = (value: unknown): string => {
  if (value == null) return ''
  if (Array.isArray(value)) return value.map((v) => String(v)).join('|')
  return String(value)
}

// Builds one search2 POST body from the tool args (mirrors GrantsSearchSpec.to_payload).
const grantsPayload = (
  a: Record<string, unknown>,
  statuses: string,
  rows: number,
  start: number
): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    rows,
    startRecordNum: start,
    oppStatuses: statuses,
    sortBy: 'oppNum|asc'
  }
  if (a.keyword) body.keyword = String(a.keyword)
  if (a.opportunity_number) body.oppNum = String(a.opportunity_number)
  if (a.aln) body.cfda = String(a.aln)
  const agencies = pipeJoin(a.agencies)
  if (agencies) body.agencies = agencies
  const eligibilities = pipeJoin(a.eligibilities)
  if (eligibilities) body.eligibilities = eligibilities
  const fundingCategories = pipeJoin(a.funding_categories)
  if (fundingCategories) body.fundingCategories = fundingCategories
  const fundingInstruments = pipeJoin(a.funding_instruments)
  if (fundingInstruments) body.fundingInstruments = fundingInstruments
  return body
}

// One throttled POST to search2; unwraps the envelope and raises on a non-zero errorcode.
const postSearch2 = async (
  ctx: ToolContext,
  body: Record<string, unknown>
): Promise<Search2Data> => {
  const env = (await ctx.postJson(GRANTS_URL, body)) as Search2Envelope
  if (env.errorcode !== 0) {
    throw new Error(`grants.gov errorcode ${env.errorcode}: ${env.msg ?? ''}`)
  }
  if (!env.data) throw new Error('grants.gov response missing data envelope')
  return env.data
}

// Pulls the requested facet blocks out of a search2 data payload.
const pickFacets = (data: Search2Data, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(keys.map((k) => [k, data[k]]))

// Full retrieval: walk startRecordNum until every hit is fetched, then verify completeness
// (len == hitCount, ids unique). One automatic re-walk on mismatch (the live corpus can move
// mid-walk); a persistent mismatch raises, mirroring IncompleteRetrievalError.
const walkGrants = async (
  ctx: ToolContext,
  a: Record<string, unknown>,
  statuses: string
): Promise<{ records: OppHit[]; hitCount: number; facets: Record<string, unknown> }> => {
  let records: OppHit[] = []
  let ids: string[] = []
  let hitCount = 0
  for (let attempt = 1; attempt <= 2; attempt++) {
    records = []
    let facets: Record<string, unknown> = {}
    let start = 0
    hitCount = 0
    let first = true
    for (;;) {
      const data = await postSearch2(ctx, grantsPayload(a, statuses, GRANTS_ROWS_PER_PAGE, start))
      if (first) {
        hitCount = data.hitCount
        facets = pickFacets(data, SEARCH_FACET_KEYS)
        first = false
      }
      const hits = data.oppHits ?? []
      records.push(...hits)
      start += hits.length
      if (start >= data.hitCount || hits.length === 0) break
    }
    ids = records.map((r) => String(r.id))
    if (records.length === hitCount && new Set(ids).size === records.length) {
      return { records, hitCount, facets }
    }
  }
  throw new Error(
    `incomplete grants.gov retrieval: ${records.length} records (${new Set(ids).size} unique ids) ` +
      `vs hitCount ${hitCount} after retry — check sortBy validity / corpus motion`
  )
}

// --------------------------------------------------------- Antibody Registry

const AB_BASE = 'https://www.antibodyregistry.org/api'
// Deepest row reachable without authentication on /fts-antibodies (page*size beyond this -> HTTP 401).
const ANON_ROW_LIMIT = 500
// Fields that change as the registry re-curates records; stripped from returned records (upstream _norm).
const VOLATILE_FIELDS = new Set([
  'curateTime',
  'lastEditTime',
  'ix',
  'showLink',
  'feedback',
  'numOfCitation'
])

type AntibodyRecord = {
  abId?: number
  catalogNum?: string
  catAlt?: string
  vendorName?: string
} & Record<string, unknown>
type FtsResponse = { totalElements?: number; items?: AntibodyRecord[] }

// Drops volatile fields from a record (does not reorder — key order is immaterial to callers/tests).
const normAntibody = (r: AntibodyRecord): Record<string, unknown> =>
  Object.fromEntries(Object.entries(r).filter(([k]) => !VOLATILE_FIELDS.has(k)))

const toRrid = (num: number): string => `AB_${num}`

// Accepts 3643095, "3643095", "AB_3643095" or "RRID:AB_3643095"; returns the bare numeric id.
const parseAbId = (value: unknown): number => {
  const s = String(value).trim()
  const m = /^(?:RRID:)?AB_(\d+)$/i.exec(s)
  if (m) return Number(m[1])
  if (/^\d+$/.test(s)) return Number(s)
  throw new Error(`not a valid antibody id / RRID: ${String(value)}`)
}

const ftsUrl = (q: string, page: number, size: number): string =>
  `${AB_BASE}/fts-antibodies?q=${encodeURIComponent(q)}&page=${page}&size=${size}`

// Walks all fts-antibodies pages up to max_records or the anonymous depth cap. Rows beyond offset 500
// need authentication (HTTP 401) — the walk stops and flags anonymous_limit_hit, never silently
// dropping. Mirrors AntibodyRegistryClient.search_antibodies (page=None branch).
const walkAntibodies = async (
  ctx: ToolContext,
  q: string,
  size: number,
  maxRecords: number
): Promise<{
  total: number | undefined
  items: Record<string, unknown>[]
  limitHit: boolean
}> => {
  const items: Record<string, unknown>[] = []
  let total: number | undefined
  let limitHit = false
  let pg = 1
  for (;;) {
    if (pg * size > ANON_ROW_LIMIT) {
      limitHit = true
      break
    }
    const data = (await ctx.fetchJson(ftsUrl(q, pg, size))) as FtsResponse
    total = data.totalElements
    const batch = data.items ?? []
    if (batch.length === 0) break
    items.push(...batch.map(normAntibody))
    if (items.length >= Math.min(total ?? 0, maxRecords)) break
    pg += 1
  }
  return { total, items, limitHit }
}

export const RESEARCH_RESOURCES_TOOLS: ToolDescriptor[] = [
  {
    id: 'search_grants',
    connector: 'research_resources',
    description:
      'Search Grants.gov funding opportunities via the search2 API (complete, count-verified retrieval). At least one criterion is required (keyword, opportunity_number, aln/CFDA, agencies, eligibilities, funding_categories, or funding_instruments). opportunity_statuses defaults to ["forecasted","posted"] (current opportunities); add "closed"/"archived" for historical ones. agencies takes codes like ["HHS-NIH11"] (NIH), ["HHS-FDA"], ["NSF"]. Set count_only for just the hit count + facets; max_records caps returned records (the walk still retrieves the complete set and flags truncated).',
    input: {
      type: 'object',
      properties: {
        keyword: { type: 'string' },
        opportunity_number: { type: 'string' },
        aln: { type: 'string' },
        agencies: { type: 'array', items: { type: 'string' } },
        opportunity_statuses: {
          type: 'array',
          items: { type: 'string', enum: ['forecasted', 'posted', 'closed', 'archived'] }
        },
        eligibilities: { type: 'array', items: { type: 'string' } },
        funding_categories: { type: 'array', items: { type: 'string' } },
        funding_instruments: { type: 'array', items: { type: 'string' } },
        count_only: { type: 'boolean', default: false },
        max_records: { type: 'integer', default: 100 },
        include_facets: { type: 'boolean', default: true }
      }
    },
    returns:
      '`{ hit_count, n_returned, truncated, records: [ { id, number, title, agencyCode, agency, oppStatus, openDate, closeDate, docType, cfdaList } ], facets? }` — records are the raw search2 hits (verbatim, sorted by oppNum). `truncated` is true when `hit_count` exceeds the returned count. `facets` (when include_facets) holds oppStatusOptions/agencies/eligibilities/fundingCategories/fundingInstruments/dateRangeOptions value counts. With `count_only`, records is [] and n_returned 0.',
    example:
      'const result = await host.mcp("research_resources", "search_grants", {"keyword": "cancer", "agencies": ["HHS-NIH11"], "max_records": 25})',
    run: async (ctx, a) => {
      const statuses = pipeJoin(a.opportunity_statuses) || DEFAULT_STATUSES
      for (const s of statuses.split('|')) {
        if (!VALID_STATUSES.includes(s)) {
          throw new Error(`invalid oppStatus '${s}'; valid: ${VALID_STATUSES.join(', ')}`)
        }
      }
      // At least one search criterion (statuses alone is not a criterion).
      const hasCriterion =
        Boolean(a.keyword) ||
        Boolean(a.opportunity_number) ||
        Boolean(a.aln) ||
        Boolean(pipeJoin(a.agencies)) ||
        Boolean(pipeJoin(a.eligibilities)) ||
        Boolean(pipeJoin(a.funding_categories)) ||
        Boolean(pipeJoin(a.funding_instruments))
      if (!hasCriterion) throw new Error('search_grants needs at least one search criterion')
      const includeFacets = a.include_facets !== false

      if (a.count_only === true) {
        const data = await postSearch2(ctx, grantsPayload(a, statuses, 0, 0))
        const out: Record<string, unknown> = {
          hit_count: data.hitCount,
          n_returned: 0,
          truncated: false,
          records: []
        }
        if (includeFacets) out.facets = pickFacets(data, COUNT_FACET_KEYS)
        return out
      }

      const { records, hitCount, facets } = await walkGrants(ctx, a, statuses)
      const maxRecords = Math.max(0, Number(a.max_records ?? 100))
      const kept = records.slice(0, maxRecords)
      const out: Record<string, unknown> = {
        hit_count: hitCount,
        n_returned: kept.length,
        truncated: hitCount > kept.length,
        records: kept
      }
      if (includeFacets) out.facets = facets
      return out
    }
  },
  {
    id: 'search_antibodies',
    connector: 'research_resources',
    description:
      'Full-text search the Antibody Registry (antibodyregistry.org, ~3.2M records). Token-based matching against antibody name/target/catalog text ("TP53" and "p53" are different queries). With page omitted, all pages are walked up to max_records or the anonymous depth cap (rows beyond offset 500 need authentication upstream, flagged as anonymous_limit_hit — never silently dropped). Pass a 1-based page for single-page retrieval (page*page_size must stay <= 500).',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        page: { type: 'integer' },
        page_size: { type: 'integer', default: 100 },
        max_records: { type: 'integer', default: 500 }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      'Walk mode (page omitted): `{ query, total_elements, retrieved, unique_ab_ids, complete, truncated_at_max_records, anonymous_limit_hit, items: [ { abId, abName, abTarget, catalogNum, vendorName, cloneId, sourceOrganism, targetSpecies, ... } ] }`. `total_elements` counts index rows (not unique antibodies). Single-page mode (page given): `{ query, page, total_elements, retrieved, complete, items }`.',
    example:
      'const result = await host.mcp("research_resources", "search_antibodies", {"query": "CD4", "max_records": 100})',
    run: async (ctx, a) => {
      const q = String(a.query ?? '').trim()
      if (!q) throw new Error('query must be non-empty')
      const size = Math.max(1, Number(a.page_size ?? 100))

      if (a.page != null) {
        const page = Math.max(1, Number(a.page))
        if (page * size > ANON_ROW_LIMIT) {
          throw new Error(
            `page*size=${page * size} exceeds the anonymous row limit (${ANON_ROW_LIMIT}); ` +
              'upstream returns HTTP 401 beyond it'
          )
        }
        const data = (await ctx.fetchJson(ftsUrl(q, page, size))) as FtsResponse
        const items = (data.items ?? []).map(normAntibody)
        return {
          query: q,
          page,
          total_elements: data.totalElements,
          retrieved: items.length,
          complete: items.length === data.totalElements,
          items
        }
      }

      const maxRecords = Math.max(1, Number(a.max_records ?? 500))
      const { total, items, limitHit } = await walkAntibodies(ctx, q, size, maxRecords)
      const truncated = total != null && items.length < total
      return {
        query: q,
        total_elements: total,
        retrieved: items.length,
        unique_ab_ids: new Set(items.map((r) => r.abId)).size,
        complete: !truncated,
        truncated_at_max_records: truncated && !limitHit,
        anonymous_limit_hit: limitHit,
        items
      }
    }
  },
  {
    id: 'get_antibody',
    connector: 'research_resources',
    description:
      'Fetch Antibody Registry detail record(s) for one antibody accession / RRID. Accepts a plain number ("3643095"), "AB_3643095", or "RRID:AB_3643095". The upstream route is list-valued (an accession can map to several curated records, e.g. multi-vendor duplicates). A nonexistent id yields record_count 0, not an error.',
    input: {
      type: 'object',
      properties: { antibody_id: { type: 'string' } },
      required: ['antibody_id']
    },
    required: ['antibody_id'],
    returns:
      '`{ ab_id (numeric), rrid ("AB_<id>"), record_count, records: [ full antibody records ] }`. `record_count` is 0 (with records []) when the accession has no records.',
    example:
      'const result = await host.mcp("research_resources", "get_antibody", {"antibody_id": "RRID:AB_3643095"})',
    url: (a) => `${AB_BASE}/antibodies/${parseAbId(a.antibody_id)}`,
    parse: (raw, a) => {
      const num = parseAbId(a.antibody_id)
      const records = (Array.isArray(raw) ? raw : [raw]) as AntibodyRecord[]
      return {
        ab_id: num,
        rrid: toRrid(num),
        record_count: records.length,
        records: records.map(normAntibody)
      }
    }
  },
  {
    id: 'find_antibodies_by_catalog',
    connector: 'research_resources',
    description:
      'Find antibodies by vendor catalog number (exact, case-insensitive). Implemented as a full-text search plus client-side exact matching on the catalog number (or its listed alternatives), because the upstream column-filter route returns HTTP 500 for every key. Pass an optional vendor name (exact, case-insensitive) to further narrow the matches.',
    input: {
      type: 'object',
      properties: {
        catalog_number: { type: 'string' },
        vendor: { type: 'string' },
        page_size: { type: 'integer', default: 100 }
      },
      required: ['catalog_number']
    },
    required: ['catalog_number'],
    returns:
      '`{ catalog_num, vendor, match_count, search_total_elements, matches: [ full antibody records ] }`. `search_total_elements` is the underlying full-text hit count; `matches` are the exact catalog-number matches.',
    example:
      'const result = await host.mcp("research_resources", "find_antibodies_by_catalog", {"catalog_number": "ab32572"})',
    run: async (ctx, a) => {
      const catalog = String(a.catalog_number ?? '').trim()
      if (!catalog) throw new Error('catalog_number must be non-empty')
      const size = Math.max(1, Number(a.page_size ?? 100))
      const vendor = a.vendor != null ? String(a.vendor) : null
      const want = catalog.toLowerCase()
      // Walk the full-text search, then keep exact catalog-number matches (upstream default max 5000).
      const { total, items } = await walkAntibodies(ctx, catalog, size, 5000)
      const wantVendor = vendor != null ? vendor.trim().toLowerCase() : null
      const matches = items.filter((r) => {
        const cat = String(r.catalogNum ?? '')
          .trim()
          .toLowerCase()
        const alts = new Set(
          String(r.catAlt ?? '')
            .split(/[,;]/)
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
        )
        if (want !== cat && !alts.has(want)) return false
        if (wantVendor == null) return true
        return (
          String(r.vendorName ?? '')
            .trim()
            .toLowerCase() === wantVendor
        )
      })
      return {
        catalog_num: catalog,
        vendor,
        match_count: matches.length,
        search_total_elements: total,
        matches
      }
    }
  },
  {
    id: 'get_antibody_registry_stats',
    connector: 'research_resources',
    description:
      'Antibody Registry statistics: total antibody count and last-update date. Returns the upstream /api/datainfo payload.',
    input: { type: 'object', properties: {} },
    returns:
      '`{ total (registry size), lastupdate (YYYY-MM-DD) }` — the upstream /api/datainfo payload.',
    example:
      'const result = await host.mcp("research_resources", "get_antibody_registry_stats", {})',
    url: () => `${AB_BASE}/datainfo`,
    parse: (raw) => raw
  }
]
