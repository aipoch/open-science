import type { ToolContext, ToolDescriptor } from '../types'

// Drugs@FDA applications (NDA/ANDA/BLA) and product labels (SPL), both served by openFDA. Read-only;
// anonymous rate limits apply (the engine retries 429/5xx). openFDA envelope: { meta, results }.
const APPLICATIONS = 'https://api.fda.gov/drug/drugsfda.json'
const LABELS = 'https://api.fda.gov/drug/label.json'

// openFDA can only page while skip+limit stays under ~26k; larger result sets must be narrowed first.
const MAX_PAGEABLE = 26_000
// openFDA caps a count aggregation at 1000 buckets.
const MAX_BUCKETS = 1000

type ActiveIngredient = { name?: string; strength?: string }
type Product = {
  brand_name?: string
  active_ingredients?: ActiveIngredient[]
  dosage_form?: string
  route?: string
  marketing_status?: string
  te_code?: string
}
type OpenFdaAppBlock = {
  generic_name?: string[]
  pharm_class_epc?: string[]
  pharm_class_moa?: string[]
  pharm_class_cs?: string[]
  pharm_class_pe?: string[]
  substance_name?: string[]
  route?: string[]
  manufacturer_name?: string[]
  product_type?: string[]
}
type Application = {
  application_number?: string
  sponsor_name?: string
  products?: Product[]
  submissions?: unknown[]
  openfda?: OpenFdaAppBlock
}

type OpenFdaLabelBlock = {
  brand_name?: string[]
  generic_name?: string[]
  substance_name?: string[]
  manufacturer_name?: string[]
  route?: string[]
  product_type?: string[]
  application_number?: string[]
}
type LabelRecord = {
  set_id?: string
  version?: number
  effective_time?: string
  boxed_warning?: string[]
  indications_and_usage?: string[]
  openfda?: OpenFdaLabelBlock
} & Record<string, unknown>

type CountBucket = { term?: string; count?: number }
type OpenFdaMeta = {
  last_updated?: string
  results?: { total?: number; skip?: number; limit?: number }
}
type OpenFdaResults<T> = { meta?: OpenFdaMeta; results?: T[] }

// openFDA answers a zero-hit search with HTTP 404; the engine surfaces that as an "HTTP 404" error.
function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.includes('HTTP 404')
}

// Encodes a full openFDA search/count expression for the query string. openFDA accepts %20 for spaces
// and %20AND%20 / %20OR%20 as boolean separators, so the whole expression can be encoded verbatim.
const enc = (s: string): string => encodeURIComponent(s)

// Wraps a filter value as an openFDA exact phrase, neutralising embedded double quotes that would
// otherwise close the phrase and inject boolean logic into the query.
const phrase = (value: unknown): string => `"${String(value).replace(/"/g, ' ')}"`

// Drugs@FDA search filters that map onto always-present product/top-level fields. generic and pharm
// class instead hit the harmonized openfda.* block (absent on older applications, so silently skipped
// upstream); they are added separately.
const APP_FILTER_FIELDS: Record<string, string> = {
  brand: 'products.brand_name',
  active_ingredient: 'products.active_ingredients.name',
  sponsor: 'sponsor_name',
  marketing_status: 'products.marketing_status',
  dosage_form: 'products.dosage_form',
  route: 'products.route'
}

// Normalizes a pharm-class type arg to one of openFDA's four class axes.
function classType(value: unknown): 'epc' | 'moa' | 'cs' | 'pe' {
  const t = String(value ?? 'epc').toLowerCase()
  return t === 'moa' || t === 'cs' || t === 'pe' ? t : 'epc'
}

// Builds the [from TO to] status-date range clause, defaulting the open side to a wide bound.
function dateRange(from: unknown, to: unknown): string {
  if (from == null && to == null) return ''
  const f = from != null ? String(from).replace(/-/g, '') : '19000101'
  const t = to != null ? String(to).replace(/-/g, '') : '30001231'
  return `submissions.submission_status_date:[${f} TO ${t}]`
}

// Assembles the openFDA search= expression for the applications tools from the shared filter args. A
// verbatim raw_search overrides every mapped filter; the submission-date range is always ANDed on.
function appSearchExpr(a: Record<string, unknown>): string {
  const range = dateRange(a.submission_date_from, a.submission_date_to)
  if (a.raw_search != null && a.raw_search !== '') {
    const raw = String(a.raw_search)
    return range ? `(${raw}) AND ${range}` : raw
  }
  const op = String(a.search_type ?? 'and').toLowerCase() === 'or' ? ' OR ' : ' AND '
  const clauses: string[] = []
  for (const [key, field] of Object.entries(APP_FILTER_FIELDS)) {
    if (a[key] != null && a[key] !== '') clauses.push(`${field}:${phrase(a[key])}`)
  }
  if (a.generic != null && a.generic !== '')
    clauses.push(`openfda.generic_name:${phrase(a.generic)}`)
  if (a.pharm_class != null && a.pharm_class !== '') {
    clauses.push(`openfda.pharm_class_${classType(a.pharm_class_type)}:${phrase(a.pharm_class)}`)
  }
  const expr = clauses.join(op)
  if (!range) return expr
  return expr ? `(${expr}) AND ${range}` : range
}

// Friendly count-field names mapped to their openFDA field paths (with .exact where the field is
// analyzed and must be counted on its keyword variant). An unknown name is passed through verbatim so
// a caller can supply any raw openFDA field path.
const COUNT_FIELDS: Record<string, string> = {
  sponsor_name: 'sponsor_name',
  application_number: 'application_number',
  dosage_form: 'products.dosage_form.exact',
  route: 'products.route.exact',
  marketing_status: 'products.marketing_status',
  te_code: 'products.te_code',
  pharm_class_epc: 'openfda.pharm_class_epc.exact',
  pharm_class_moa: 'openfda.pharm_class_moa.exact',
  pharm_class_cs: 'openfda.pharm_class_cs.exact',
  pharm_class_pe: 'openfda.pharm_class_pe.exact'
}

// The distinct, sorted, upper-cased active-ingredient name set of one product.
function ingredientSet(product: Product): string[] {
  const names = (product.active_ingredients ?? [])
    .map((i) => (i.name ?? '').trim().toUpperCase())
    .filter(Boolean)
  return [...new Set(names)].sort()
}

// Flattens the harmonized openfda block into convenience arrays alongside the raw application fields.
function shapeApplication(app: Application): Record<string, unknown> {
  const of = app.openfda ?? {}
  return {
    application_number: app.application_number,
    sponsor_name: app.sponsor_name,
    products: app.products ?? [],
    submissions: app.submissions ?? [],
    openfda_generic_name: of.generic_name ?? [],
    openfda_pharm_class_epc: of.pharm_class_epc ?? [],
    openfda_pharm_class_moa: of.pharm_class_moa ?? [],
    openfda_pharm_class_cs: of.pharm_class_cs ?? [],
    openfda_pharm_class_pe: of.pharm_class_pe ?? [],
    openfda_substance_name: of.substance_name ?? [],
    openfda_route: of.route ?? [],
    openfda_manufacturer_name: of.manufacturer_name ?? [],
    openfda_product_type: of.product_type ?? []
  }
}

// Pages an openFDA endpoint until max_records is reached or the result set is exhausted, tolerating a
// zero-hit 404. openFDA caps skip+limit at MAX_PAGEABLE, so paging never advances past it; when
// guarding, only a request that wants MORE records than that cap over a larger result set raises with
// guidance — a capped request always succeeds and flags `truncated`.
async function fetchPaged<T>(
  ctx: ToolContext,
  endpoint: string,
  expr: string,
  maxRecords: number,
  guard: boolean
): Promise<{ total: number; lastUpdated?: string; records: T[] }> {
  const searchParam = expr ? `search=${enc(expr)}&` : ''
  const records: T[] = []
  let total = 0
  let lastUpdated: string | undefined
  let skip = 0
  let checked = false
  while (records.length < maxRecords && skip < MAX_PAGEABLE) {
    const pageLimit = Math.min(1000, maxRecords - records.length, MAX_PAGEABLE - skip)
    let resp: OpenFdaResults<T>
    try {
      resp = (await ctx.fetchJson(
        `${endpoint}?${searchParam}limit=${pageLimit}&skip=${skip}`
      )) as OpenFdaResults<T>
    } catch (err) {
      if (isNotFound(err)) break
      throw err
    }
    total = resp.meta?.results?.total ?? 0
    lastUpdated = resp.meta?.last_updated
    // Only raise when the caller asked for more records than openFDA can page to; a capped request is
    // served (truncated) with the true total, so a broad search with a small max_records still works.
    if (guard && !checked && maxRecords > MAX_PAGEABLE && total > MAX_PAGEABLE) {
      throw new Error(
        `search matches ${total} applications; narrow with submission_date_from/to or more filters to stay under ${MAX_PAGEABLE}`
      )
    }
    checked = true
    const batch = resp.results ?? []
    records.push(...batch)
    skip += batch.length
    if (!batch.length || batch.length < pageLimit || skip >= total) break
  }
  return { total, lastUpdated, records }
}

// Runs a single count aggregation and returns its buckets (empty on a zero-hit 404).
async function countBuckets(
  ctx: ToolContext,
  apiField: string,
  searchExpr: string,
  maxBuckets: number
): Promise<{ term?: string; count?: number }[]> {
  const searchParam = searchExpr ? `search=${enc(searchExpr)}&` : ''
  const url = `${APPLICATIONS}?${searchParam}count=${enc(apiField)}&limit=${maxBuckets}`
  try {
    const resp = (await ctx.fetchJson(url)) as OpenFdaResults<CountBucket>
    return (resp.results ?? []).map((b) => ({ term: b.term, count: b.count }))
  } catch (err) {
    if (isNotFound(err)) return []
    throw err
  }
}

// Label sections that carry warning/precaution text; search_drug_labels reports which exist per label.
const WARNING_SECTIONS = [
  'boxed_warning',
  'warnings',
  'warnings_and_cautions',
  'precautions',
  'user_safety_warnings',
  'general_precautions'
]

// Label filter args mapped onto their openfda.* label fields.
const LABEL_FILTER_FIELDS: Record<string, string> = {
  active_ingredient: 'openfda.substance_name',
  generic_name: 'openfda.generic_name',
  brand_name: 'openfda.brand_name',
  route: 'openfda.route',
  product_type: 'openfda.product_type'
}

// Builds the label search expression; raw_search overrides the mapped filters, exact swaps to the
// non-analyzed .exact field variants.
function labelSearchExpr(a: Record<string, unknown>): string {
  if (a.raw_search != null && a.raw_search !== '') return String(a.raw_search)
  const exact = a.exact === true
  const clauses: string[] = []
  for (const [key, field] of Object.entries(LABEL_FILTER_FIELDS)) {
    if (a[key] != null && a[key] !== '') {
      clauses.push(`${exact ? `${field}.exact` : field}:${phrase(a[key])}`)
    }
  }
  return clauses.join(' AND ')
}

// Joins an SPL section value (openFDA stores section text as a string array) into a single string.
function joinText(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join('\n\n') : value == null ? '' : String(value)
}

// The default structured label record: identity block, boxed-warning presence, which warning-type
// sections exist, and the indications text.
function defaultLabelRecord(r: LabelRecord): Record<string, unknown> {
  const of = r.openfda ?? {}
  return {
    identification: {
      set_id: r.set_id,
      spl_version: r.version,
      effective_time: r.effective_time,
      brand_name: of.brand_name ?? [],
      generic_name: of.generic_name ?? [],
      substance_name: of.substance_name ?? [],
      manufacturer: of.manufacturer_name ?? [],
      route: of.route ?? [],
      product_type: of.product_type ?? [],
      application_number: of.application_number ?? []
    },
    has_boxed_warning: Array.isArray(r.boxed_warning) && r.boxed_warning.length > 0,
    warning_sections: WARNING_SECTIONS.filter((s) => s in r),
    indications_and_usage: joinText(r.indications_and_usage)
  }
}

// A label record reduced to caller-requested raw sections instead of the default structured shape.
function sectionLabelRecord(r: LabelRecord, sections: string[]): Record<string, unknown> {
  const of = r.openfda ?? {}
  return {
    set_id: r.set_id,
    brand_name: of.brand_name ?? [],
    generic_name: of.generic_name ?? [],
    sections: Object.fromEntries(sections.map((s) => [s, joinText(r[s])]))
  }
}

export const DRUG_REGULATORY_TOOLS: ToolDescriptor[] = [
  {
    id: 'search_drug_applications',
    connector: 'drug_regulatory',
    description:
      'Search Drugs@FDA applications (NDA/ANDA/BLA) by any combination of exact-phrase filters (brand, generic, active_ingredient, sponsor, marketing_status, dosage_form, route, pharm_class). generic and pharm_class query the harmonized openfda block (absent on older applications, so silently skipped there). A broad search returns the first max_records with the true total and truncated=true; to page beyond ~26,000 records, narrow with submission_date_from/to.',
    input: {
      type: 'object',
      properties: {
        brand: { type: 'string' },
        generic: { type: 'string' },
        active_ingredient: { type: 'string' },
        sponsor: { type: 'string' },
        marketing_status: {
          type: 'string',
          enum: ['Prescription', 'Over-the-counter', 'Discontinued', 'None (Tentative Approval)']
        },
        dosage_form: { type: 'string' },
        route: { type: 'string' },
        pharm_class: { type: 'string' },
        pharm_class_type: {
          type: 'string',
          enum: ['epc', 'moa', 'cs', 'pe'],
          description:
            'Which openFDA pharmacologic-class facet `pharm_class` matches: epc (established pharmacologic class), moa (mechanism of action), cs (chemical/structural class), pe (physiologic effect).'
        },
        search_type: {
          type: 'string',
          enum: ['and', 'or'],
          default: 'and',
          description: 'How to combine the mapped filters: "and" (default) or "or".'
        },
        submission_date_from: {
          type: 'string',
          description: 'Earliest submission date (inclusive), YYYY-MM-DD; ANDed onto the query.'
        },
        submission_date_to: {
          type: 'string',
          description: 'Latest submission date (inclusive), YYYY-MM-DD; ANDed onto the query.'
        },
        raw_search: {
          type: 'string',
          description:
            'Verbatim openFDA Lucene query; when set, overrides every mapped filter above.'
        },
        max_records: { type: 'integer', default: 50 }
      }
    },
    returns:
      '`{ total (API meta count), n_returned, truncated, last_updated, records: [ { application_number, sponsor_name, products: [...], submissions: [...], openfda_generic_name, openfda_pharm_class_epc, openfda_pharm_class_moa, openfda_pharm_class_cs, openfda_pharm_class_pe, openfda_substance_name, openfda_route, openfda_manufacturer_name, openfda_product_type } ] }`. `truncated` is true when fewer than `total` records were returned.',
    example:
      'const result = await host.mcp("drug_regulatory", "search_drug_applications", {"generic": "ATORVASTATIN CALCIUM", "marketing_status": "Prescription", "max_records": 25})',
    run: async (ctx, a) => {
      const expr = appSearchExpr(a)
      const maxRecords = Math.max(1, Number(a.max_records ?? 50))
      const { total, lastUpdated, records } = await fetchPaged<Application>(
        ctx,
        APPLICATIONS,
        expr,
        maxRecords,
        true
      )
      return {
        total,
        n_returned: records.length,
        truncated: records.length < total,
        last_updated: lastUpdated,
        records: records.map(shapeApplication)
      }
    }
  },
  {
    id: 'get_drug_application',
    connector: 'drug_regulatory',
    description:
      'Fetch one Drugs@FDA application by its number (e.g. "NDA020702", "ANDA076543", "BLA125514"). Returns the full record — sponsor, products (brand, active ingredients + strengths, dosage form, route, marketing status, TE code), complete submissions history, and harmonized openfda fields when present.',
    input: {
      type: 'object',
      properties: { application_number: { type: 'string' } },
      required: ['application_number']
    },
    required: ['application_number'],
    returns:
      '`{ application_number, found (bool), record }`. `record` is the full Drugs@FDA application object (sponsor_name, products, submissions, openfda); it is null and `found` false when the number does not exist.',
    example:
      'const result = await host.mcp("drug_regulatory", "get_drug_application", {"application_number": "NDA020702"})',
    run: async (ctx, a) => {
      const num = String(a.application_number)
      const url = `${APPLICATIONS}?search=${enc(`application_number:${phrase(num)}`)}&limit=1`
      try {
        const resp = (await ctx.fetchJson(url)) as OpenFdaResults<Application>
        const record = resp.results?.[0]
        if (!record) return { application_number: num, found: false, record: null }
        return { application_number: num, found: true, record }
      } catch (err) {
        if (isNotFound(err)) return { application_number: num, found: false, record: null }
        throw err
      }
    }
  },
  {
    id: 'count_drug_applications',
    connector: 'drug_regulatory',
    description:
      'Aggregate Drugs@FDA bucket counts over one field, optionally narrowed by the same filters as search_drug_applications. count_field accepts friendly names (sponsor_name, application_number, dosage_form, route, marketing_status, te_code, pharm_class_epc/moa/cs/pe) or a raw openFDA field path (append .exact yourself for analyzed fields).',
    input: {
      type: 'object',
      properties: {
        count_field: {
          type: 'string',
          description:
            'Field to bucket on — a friendly name (sponsor_name, application_number, dosage_form, route, marketing_status, te_code, pharm_class_epc/moa/cs/pe) or a raw openFDA field path.'
        },
        brand: { type: 'string' },
        generic: { type: 'string' },
        active_ingredient: { type: 'string' },
        sponsor: { type: 'string' },
        marketing_status: { type: 'string' },
        dosage_form: { type: 'string' },
        route: { type: 'string' },
        pharm_class: { type: 'string' },
        pharm_class_type: {
          type: 'string',
          enum: ['epc', 'moa', 'cs', 'pe'],
          description:
            'Which openFDA pharmacologic-class facet `pharm_class` matches: epc (established pharmacologic class), moa (mechanism of action), cs (chemical/structural class), pe (physiologic effect).'
        },
        search_type: {
          type: 'string',
          enum: ['and', 'or'],
          default: 'and',
          description: 'How to combine the mapped filters: "and" (default) or "or".'
        },
        submission_date_from: {
          type: 'string',
          description: 'Earliest submission date (inclusive), YYYY-MM-DD; ANDed onto the query.'
        },
        submission_date_to: {
          type: 'string',
          description: 'Latest submission date (inclusive), YYYY-MM-DD; ANDed onto the query.'
        },
        raw_search: {
          type: 'string',
          description:
            'Verbatim openFDA Lucene query; when set, overrides every mapped filter above.'
        },
        max_buckets: { type: 'integer', default: 100 }
      },
      required: ['count_field']
    },
    required: ['count_field'],
    returns:
      '`{ count_field, api_field (resolved openFDA path), n_buckets, bucket_sum, buckets: [ { term, count } ] }` — buckets are descending by count.',
    example:
      'const result = await host.mcp("drug_regulatory", "count_drug_applications", {"count_field": "marketing_status"})',
    run: async (ctx, a) => {
      const countField = String(a.count_field)
      const apiField = COUNT_FIELDS[countField] ?? countField
      const maxBuckets = Math.min(Math.max(1, Number(a.max_buckets ?? 100)), MAX_BUCKETS)
      const buckets = await countBuckets(ctx, apiField, appSearchExpr(a), maxBuckets)
      return {
        count_field: countField,
        api_field: apiField,
        n_buckets: buckets.length,
        bucket_sum: buckets.reduce((sum, b) => sum + (b.count ?? 0), 0),
        buckets
      }
    }
  },
  {
    id: 'get_drug_statistics',
    connector: 'drug_regulatory',
    description:
      'Corpus-level Drugs@FDA statistics in one call — total applications, marketing-status split, top dosage forms and routes (with distinct counts), and top sponsors by application count.',
    input: { type: 'object', properties: {} },
    returns:
      '`{ total_applications, last_updated, marketing_status: [ { term, count } ], dosage_form_top (top 25), dosage_form_distinct, route_top (top 25), route_distinct, sponsor_top (top 25 by application count) }`.',
    example: 'const result = await host.mcp("drug_regulatory", "get_drug_statistics", {})',
    run: async (ctx) => {
      // Base query only for the total count and last-updated stamp (count queries omit results.total).
      const base = (await ctx.fetchJson(`${APPLICATIONS}?limit=1`)) as OpenFdaResults<Application>
      const marketingStatus = await countBuckets(ctx, 'products.marketing_status', '', MAX_BUCKETS)
      const dosageForm = await countBuckets(ctx, 'products.dosage_form.exact', '', MAX_BUCKETS)
      const route = await countBuckets(ctx, 'products.route.exact', '', MAX_BUCKETS)
      const sponsor = await countBuckets(ctx, 'sponsor_name', '', 25)
      return {
        total_applications: base.meta?.results?.total ?? 0,
        last_updated: base.meta?.last_updated,
        marketing_status: marketingStatus,
        dosage_form_top: dosageForm.slice(0, 25),
        dosage_form_distinct: dosageForm.length,
        route_top: route.slice(0, 25),
        route_distinct: route.length,
        sponsor_top: sponsor
      }
    }
  },
  {
    id: 'list_pharmacologic_classes',
    connector: 'drug_regulatory',
    description:
      'Enumerate pharmacologic classes with their application counts, counted over the harmonized openfda.pharm_class_<type> block. Counts reflect only applications carrying that block.',
    input: {
      type: 'object',
      properties: {
        class_type: {
          type: 'string',
          enum: ['epc', 'moa', 'cs', 'pe'],
          default: 'epc',
          description:
            'Pharmacologic-class facet to enumerate: epc (established pharmacologic class), moa (mechanism of action), cs (chemical/structural class), pe (physiologic effect).'
        },
        max_buckets: { type: 'integer', default: 100 }
      }
    },
    returns:
      '`{ class_type, n_classes, classes: [ { term, count } ] }` — classes descending by count.',
    example:
      'const result = await host.mcp("drug_regulatory", "list_pharmacologic_classes", {"class_type": "epc", "max_buckets": 50})',
    url: (a) => {
      const max = Math.min(Math.max(1, Number(a.max_buckets ?? 100)), MAX_BUCKETS)
      return `${APPLICATIONS}?count=${enc(`openfda.pharm_class_${classType(a.class_type)}.exact`)}&limit=${max}`
    },
    parse: (raw, a) => {
      const classes = ((raw as OpenFdaResults<CountBucket>).results ?? []).map((b) => ({
        term: b.term,
        count: b.count
      }))
      return { class_type: classType(a.class_type), n_classes: classes.length, classes }
    }
  },
  {
    id: 'get_generic_equivalents',
    connector: 'drug_regulatory',
    description:
      'Find generic equivalents of a brand drug: resolve the brand to its reference application(s), extract the exact active-ingredient name set(s), then return every Drugs@FDA application with a product whose active-ingredient set matches (including TE codes and marketing status).',
    input: {
      type: 'object',
      properties: { brand: { type: 'string' } },
      required: ['brand']
    },
    required: ['brand'],
    returns:
      '`{ brand, reference_applications: [appnums], active_ingredient_sets: [[names]], equivalents: [ full application records ] }`.',
    example:
      'const result = await host.mcp("drug_regulatory", "get_generic_equivalents", {"brand": "Lipitor"})',
    run: async (ctx, a) => {
      const brand = String(a.brand)
      // Step 1: resolve the brand to its applications and their distinct active-ingredient sets.
      const refUrl = `${APPLICATIONS}?search=${enc(`products.brand_name:${phrase(brand)}`)}&limit=100`
      let refApps: Application[] = []
      try {
        refApps = ((await ctx.fetchJson(refUrl)) as OpenFdaResults<Application>).results ?? []
      } catch (err) {
        if (!isNotFound(err)) throw err
      }
      const referenceApplications: string[] = []
      const sets: string[][] = []
      const seenSets = new Set<string>()
      for (const app of refApps) {
        if (app.application_number) referenceApplications.push(app.application_number)
        for (const product of app.products ?? []) {
          if ((product.brand_name ?? '').toUpperCase() !== brand.toUpperCase()) continue
          const names = ingredientSet(product)
          const key = names.join('|')
          if (names.length && !seenSets.has(key)) {
            seenSets.add(key)
            sets.push(names)
          }
        }
      }
      // Step 2: for each ingredient set, gather candidates and keep exact-set matches (deduped by app).
      const equivalents: Application[] = []
      const seenApps = new Set<string>()
      for (const names of sets) {
        const expr = names.map((n) => `products.active_ingredients.name:${phrase(n)}`).join(' AND ')
        let candidates: Application[] = []
        try {
          candidates =
            (
              (await ctx.fetchJson(
                `${APPLICATIONS}?search=${enc(expr)}&limit=1000`
              )) as OpenFdaResults<Application>
            ).results ?? []
        } catch (err) {
          if (!isNotFound(err)) throw err
        }
        const target = names.join('|')
        for (const app of candidates) {
          const matches = (app.products ?? []).some((p) => ingredientSet(p).join('|') === target)
          if (matches && app.application_number && !seenApps.has(app.application_number)) {
            seenApps.add(app.application_number)
            equivalents.push(app)
          }
        }
      }
      return {
        brand,
        reference_applications: referenceApplications,
        active_ingredient_sets: sets,
        equivalents
      }
    }
  },
  {
    id: 'search_drug_labels',
    connector: 'drug_regulatory',
    description:
      'Retrieve FDA drug product labels (SPL) by ingredient/name/route with targeted section extraction. Filters (active_ingredient, generic_name, brand_name, route, product_type) hit the openfda label block; set exact to query the non-analyzed .exact variants. Pass sections to extract raw openFDA label sections instead of the default structured record. raw_search is mutually exclusive with the mapped filters.',
    input: {
      type: 'object',
      properties: {
        active_ingredient: { type: 'string' },
        generic_name: { type: 'string' },
        brand_name: { type: 'string' },
        route: { type: 'string' },
        product_type: {
          type: 'string',
          enum: ['HUMAN PRESCRIPTION DRUG', 'HUMAN OTC DRUG']
        },
        exact: {
          type: 'boolean',
          default: false,
          description:
            'Query the non-analyzed `.exact` field variants (exact match instead of tokenized).'
        },
        raw_search: {
          type: 'string',
          description:
            'Verbatim openFDA Lucene query; when set, overrides every mapped filter above.'
        },
        sections: {
          type: 'array',
          items: { type: 'string' },
          description:
            'openFDA label section names to extract (e.g. ["boxed_warning", "warnings"]); returns raw section text instead of the default structured record.'
        },
        max_records: { type: 'integer', default: 25 }
      }
    },
    returns:
      'Default: `{ search, total (API count), n_returned, truncated, records: [ { identification: { set_id, spl_version, effective_time, brand_name, generic_name, substance_name, manufacturer, route, product_type, application_number }, has_boxed_warning, warning_sections: [str], indications_and_usage } ] }`. When `sections` is given, each record is `{ set_id, brand_name, generic_name, sections: { <name>: text } }`.',
    example:
      'const result = await host.mcp("drug_regulatory", "search_drug_labels", {"brand_name": "Tylenol", "max_records": 5})',
    run: async (ctx, a) => {
      const expr = labelSearchExpr(a)
      const maxRecords = Math.max(1, Number(a.max_records ?? 25))
      const sections = Array.isArray(a.sections) ? a.sections.map(String) : null
      const { total, records } = await fetchPaged<LabelRecord>(ctx, LABELS, expr, maxRecords, false)
      return {
        search: expr,
        total,
        n_returned: records.length,
        truncated: records.length < total,
        records: records.map((r) =>
          sections ? sectionLabelRecord(r, sections) : defaultLabelRecord(r)
        )
      }
    }
  }
]
