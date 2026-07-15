import type { ToolDescriptor } from '../types'

// CartBlanche22 (ZINC22 purchasable-compound search) — every search endpoint is ASYNC and
// POST-only (form-encoded): submit returns a task receipt {"task": "<uuid>"}, and the result is
// fetched by polling GET /search/result/<uuid> until `status` is SUCCESS (or a status-less body
// carries a `result` key). A naive GET ?param=value returns HTTP 400 or the HTML SPA shell.
// ToolContext's fetchJson/fetchText/postJson can't express a form-encoded POST or a manual poll
// loop, so these tools talk to the API directly via the global fetch (mirrors upstream
// mcp_zinc/client.py's ZincClient). All five ZINC tools share this one submit-poll transport.
const BASE_URL = 'https://cartblanche22.docking.org'
const FILES_BASE_URL = 'https://files.docking.org/zinc22'
const OUTPUT_FIELDS = 'zinc_id,smiles,tranche_name,catalogs'
const USER_AGENT = 'OpenScience/1.0 (+https://github.com/aipoch/open-science)'

// Overall submit->result budget (default/clamp mirrors upstream DEFAULT/MIN/MAX_TIMEOUT_S, pulled
// in a bit under the MCP-style 60s transport ceiling that upstream targets).
const DEFAULT_TIMEOUT_S = 25
const MIN_TIMEOUT_S = 5
const MAX_TIMEOUT_S = 55
const POLL_INTERVAL_MS = 1500
const HTTP_TIMEOUT_MS = 10_000

const DEFAULT_MAX_RESULTS = 50
const MAX_RESULTS_CAP = 500
const MAX_IDS_PER_CALL = 100 // batch lookup bound (one submit, many ids)
const MAX_IDS_3D = 50 // 3D prep is per-compound work; keep batches small

// Known CartBlanche22 random-sample subsets (passed through verbatim so new upstream subsets keep
// working; these are the documented ones).
const KNOWN_SUBSETS = ['fragment', 'lead-like', 'drug-like', 'lugs']

const ZINC_ID_RE = /^ZINC[a-zA-Z]?\d+$/i
const NORMALIZE_RE = /^(ZINC[a-zA-Z]?)(\d+)$/i
const TRANCHE_RE = /^H(\d{2})([PM])(\d{3})$/
const ID_DELIM_RE = /[,\s]/
// Result sources, presentation order (current release first) — mirrors upstream SOURCE_ORDER.
const SOURCE_ORDER = ['zinc22', 'zinc20']

type ZincRecord = {
  zinc_id?: string
  smiles?: string
  tranche_name?: string
  tranche?: string | Record<string, unknown>
  tranche_details?: Record<string, unknown>
  catalogs?: unknown
  supplier_code?: unknown
  source?: string
}

type TrancheProps = { heavy_atoms: number; logp: number }
type SubmitResponse = { task?: string }
type PollResponse = { status?: string; result?: unknown }
type FlatResult = { records: ZincRecord[]; counts: Record<string, number> }
type PageResult = {
  query: Record<string, unknown>
  total_available: number
  returned_count: number
  truncated: boolean
  source_counts: Record<string, number>
  records: Array<Record<string, unknown>>
}

function clampTimeoutS(raw: unknown): number {
  const n = Number(raw ?? DEFAULT_TIMEOUT_S)
  return Math.max(
    MIN_TIMEOUT_S,
    Math.min(MAX_TIMEOUT_S, Number.isFinite(n) ? n : DEFAULT_TIMEOUT_S)
  )
}

function clampMaxResults(raw: unknown): number {
  const n = Number(raw ?? DEFAULT_MAX_RESULTS)
  return Math.max(
    1,
    Math.min(MAX_RESULTS_CAP, Number.isFinite(n) ? Math.trunc(n) : DEFAULT_MAX_RESULTS)
  )
}

// Quotes the offending value unambiguously in error messages (mirrors Python's !r used in the
// upstream error messages this tool's wording is transcribed from).
function idRepr(id: string): string {
  return `'${id}'`
}

// Normalizes + bounds an id list. Entries are joined with commas into the upstream form field, so a
// single entry containing a delimiter would let one list element submit many ids and defeat the
// per-call bound — reject those explicitly. ZINC ids are additionally shape-validated; supplier
// codes are free-form so they only get the delimiter check (mirrors upstream _require_ids).
function requireIds(raw: unknown, bound: number, what: string, pattern?: RegExp): string[] {
  const list = Array.isArray(raw) ? raw : [raw]
  const cleaned = list.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (!cleaned.length) throw new Error(`provide at least one ${what}`)
  if (cleaned.length > bound) {
    throw new Error(
      `${cleaned.length} ${what}s exceeds the per-call bound of ${bound} — split the lookup into smaller batches`
    )
  }
  for (const entry of cleaned) {
    if (ID_DELIM_RE.test(entry)) {
      throw new Error(
        `${what} entry ${idRepr(entry)} contains a comma or whitespace — pass each id as its own list element`
      )
    }
    if (pattern && !pattern.test(entry)) {
      throw new Error(
        `${what} entry ${idRepr(entry)} is not a valid ${what} (expected pattern ${pattern})`
      )
    }
  }
  return cleaned
}

// Canonicalize a ZINC id for result-map lookup: upstream returns zero-padded ZINC000000000012, so a
// short-form input like ZINC12 must be padded to 12 digits or it misses its own result (mirrors
// upstream _normalize_zinc_id). Non-ZINC strings pass through unchanged.
function normalizeZincId(s: string): string {
  const m = NORMALIZE_RE.exec(s)
  if (!m) return s
  return `${m[1].toUpperCase()}${m[2].padStart(12, '0')}`
}

// Decode a ZINC tranche code (H##P###/H##M###) into heavy-atom count + logP bin (P positive,
// M negative, value/100). Returns the properties and the validated code; non-string input (the
// smiles.txt endpoint sends `tranche` as a dict) returns null (mirrors upstream parse_tranche).
function parseTranche(name: unknown): { props: TrancheProps; code: string } | null {
  if (typeof name !== 'string') return null
  const m = TRANCHE_RE.exec(name.trim())
  if (!m) return null
  const sign = m[2] === 'P' ? 1 : -1
  return { props: { heavy_atoms: Number(m[1]), logp: (sign * Number(m[3])) / 100 }, code: m[0] }
}

// Decode a record's tranche across all three upstream shapes: pre-decoded tranche_details dict, a
// tranche dict {h_num, p_num, ...} (smiles.txt), or a tranche_name/tranche code string
// (substances.txt, catitems.txt) (mirrors upstream _tranche_properties).
function trancheProperties(rec: ZincRecord): Record<string, unknown> | null {
  const details = rec.tranche_details
  if (details && typeof details === 'object' && 'heavy_atoms' in details) {
    const props: Record<string, unknown> = { heavy_atoms: details.heavy_atoms, logp: details.logp }
    if (details.mwt != null) props.mwt = details.mwt
    return props
  }
  let tranche: unknown = rec.tranche_name ?? rec.tranche
  if (tranche && typeof tranche === 'object') {
    const t = tranche as Record<string, unknown>
    tranche = `${t.h_num ?? ''}${t.p_num ?? ''}`
  }
  const decoded = parseTranche(tranche)
  return decoded ? decoded.props : null
}

// Project a record to the standard bounded output fields plus decoded tranche_properties; carries
// supplier_code through when present (the supplier-resolution path).
function projectRecord(rec: ZincRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    zinc_id: rec.zinc_id,
    smiles: rec.smiles,
    tranche_name: rec.tranche_name,
    catalogs: rec.catalogs,
    source: rec.source
  }
  if (rec.supplier_code !== undefined) out.supplier_code = rec.supplier_code
  const props = trancheProperties(rec)
  if (props) out.tranche_properties = props
  return out
}

function looksLikeHtml(text: string): boolean {
  const head = text.trimStart().slice(0, 300).toLowerCase()
  return head.startsWith('<!doctype') || head.startsWith('<html')
}

function bodyExcerpt(text: string, n = 200): string {
  const excerpt = text.split(/\s+/).filter(Boolean).join(' ').slice(0, n)
  return excerpt || '<empty body>'
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
  try {
    return await fetch(url, {
      ...init,
      headers: { 'user-agent': USER_AGENT, ...init.headers },
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
  }
}

// POST form fields to a CartBlanche22 search endpoint; return the task uuid.
async function submit(
  endpoint: string,
  data: Record<string, string>,
  deadline: number
): Promise<string> {
  const url = `${BASE_URL}/${endpoint}`
  const budgetMs = Math.min(HTTP_TIMEOUT_MS, Math.max(1000, deadline - Date.now()))
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(data).toString()
    },
    budgetMs
  )
  const text = await res.text()
  if (res.status === 400) {
    throw new Error(
      `CartBlanche22 rejected the ${endpoint} submission (HTTP 400). Server detail: ${bodyExcerpt(text)}`
    )
  }
  if (!res.ok) {
    throw new Error(`CartBlanche22 ${endpoint} returned HTTP ${res.status}: ${bodyExcerpt(text)}`)
  }
  if (looksLikeHtml(text)) {
    throw new Error(
      `CartBlanche22 returned its HTML app shell instead of a JSON task receipt for ${endpoint} — the request was not understood as an API call.`
    )
  }
  let payload: SubmitResponse
  try {
    payload = JSON.parse(text) as SubmitResponse
  } catch {
    throw new Error(
      `CartBlanche22 ${endpoint} returned a non-JSON body where a task receipt was expected: ${bodyExcerpt(text)}`
    )
  }
  if (!payload.task) {
    throw new Error(
      `CartBlanche22 ${endpoint} response carried no task id — the async submit contract may have changed.`
    )
  }
  return String(payload.task)
}

const PENDING_STATUSES = new Set(['PENDING', 'STARTED', 'PROGRESS', 'RETRY'])

// Poll /search/result/<task> until completion (SUCCESS, or a status-less body whose `result` key
// is present); throws a ZINC-task-timeout error naming the task uuid for manual re-poll once the
// deadline passes, mirroring upstream ZincTaskTimeout.
async function poll(task: string, deadline: number): Promise<PollResponse> {
  const url = `${BASE_URL}/search/result/${encodeURIComponent(task)}`
  for (;;) {
    const budgetMs = Math.min(HTTP_TIMEOUT_MS, Math.max(1000, deadline - Date.now()))
    const res = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, budgetMs)
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`polling ZINC task ${task} returned HTTP ${res.status}: ${bodyExcerpt(text)}`)
    }
    if (looksLikeHtml(text)) {
      throw new Error(
        `polling ZINC task ${task} returned the HTML app shell instead of JSON — the task id was not recognized.`
      )
    }
    let payload: PollResponse
    try {
      payload = JSON.parse(text) as PollResponse
    } catch {
      throw new Error(`polling ZINC task ${task} returned a non-JSON body: ${bodyExcerpt(text)}`)
    }
    if (payload.status === 'FAILURE') {
      throw new Error(
        `ZINC task ${task} failed server-side (status FAILURE). Check the query parameters and retry.`
      )
    }
    const ready =
      payload.status === 'SUCCESS' ||
      (payload.status == null && Object.prototype.hasOwnProperty.call(payload, 'result'))
    if (ready) return payload
    const stillPending = payload.status == null || PENDING_STATUSES.has(payload.status)
    if (!stillPending) {
      throw new Error(`ZINC task ${task} reported unexpected status '${String(payload.status)}'.`)
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `ZINC task ${task} did not complete in time — the server is likely still computing. Re-poll ${BASE_URL}/search/result/${task} later, or retry with fewer ids or a larger timeout_s.`
      )
    }
    const wait = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
}

// Flattens a per-source result ({zinc22: [...], zinc20: [...]}, or a bare list for a single-source
// deployment) into one record list tagged with `source`, zinc22 first, plus per-source counts (the
// disclosure for capped responses) — mirrors upstream flatten_result.
function flattenResult(result: unknown): FlatResult {
  const records: ZincRecord[] = []
  const counts: Record<string, number> = {}
  if (result == null) return { records, counts }
  if (Array.isArray(result)) {
    const rows = result.filter((r): r is ZincRecord => typeof r === 'object' && r !== null)
    counts.zinc22 = rows.length
    for (const r of rows) records.push({ ...r, source: 'zinc22' })
    return { records, counts }
  }
  if (typeof result !== 'object') return { records, counts }
  const bySource = result as Record<string, unknown>
  const sources = [
    ...SOURCE_ORDER.filter((s) => s in bySource),
    ...Object.keys(bySource)
      .filter((s) => !SOURCE_ORDER.includes(s))
      .sort()
  ]
  for (const source of sources) {
    const rows = bySource[source]
    if (!Array.isArray(rows)) continue
    const clean = rows.filter((r) => r && typeof r === 'object') as ZincRecord[]
    counts[source] = clean.length
    for (const row of clean) records.push({ ...row, source })
  }
  return { records, counts }
}

// Submit a search and block until its result is available, flattened. The overall timeout budget is
// computed once and threaded through submit + poll so neither phase can run past the deadline.
async function runSearch(
  endpoint: string,
  data: Record<string, string>,
  timeoutS: number
): Promise<FlatResult> {
  const deadline = Date.now() + timeoutS * 1000
  const task = await submit(endpoint, data, deadline)
  const payload = await poll(task, deadline)
  return flattenResult(payload.result)
}

// The one bounded response shape: total-available vs returned, per-source counts, always.
function pageResult(
  records: ZincRecord[],
  counts: Record<string, number>,
  cap: number,
  query: Record<string, unknown>
): PageResult {
  const total = records.length
  const page = records.slice(0, cap).map(projectRecord)
  return {
    query,
    total_available: total,
    returned_count: page.length,
    truncated: total > page.length,
    source_counts: counts,
    records: page
  }
}

// Validate a Tanimoto/anonymous-graph distance parameter (0-10; throws, not clamps, mirroring
// upstream) with the fallback applied when the arg is omitted.
function requireDistance(raw: unknown, fallback: number, message: string): number {
  const n = Math.trunc(Number(raw ?? fallback))
  if (!Number.isFinite(n) || n < 0 || n > 10) throw new Error(message)
  return n
}

// ZINC22 purchasable-compound search (CartBlanche22). Five tools on the shared async submit-poll
// transport: id lookup, structure/analog search, supplier-code resolution, random sampling, and
// docking-ready 3D-structure location. Order matches the upstream server.
export const ZINC_TOOLS: ToolDescriptor[] = [
  {
    id: 'zinc_search_by_id',
    connector: 'zinc',
    description:
      'Look up purchasable compounds in ZINC22/ZINC20 by ZINC identifier — answers "what is this compound and who sells it". Batched: pass up to 100 ids in one call rather than many single-id calls. Async upstream (submit + poll); can take up to timeout_s seconds.',
    input: {
      type: 'object',
      properties: {
        zinc_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more ZINC ids, e.g. ZINC000000000012 (max 100 per call).'
        },
        max_results: {
          type: 'integer',
          default: DEFAULT_MAX_RESULTS,
          description: 'Response bound (hard cap 500).'
        },
        timeout_s: {
          type: 'number',
          default: DEFAULT_TIMEOUT_S,
          description: 'Overall submit->result budget in seconds (clamped 5-55).'
        }
      },
      required: ['zinc_ids']
    },
    required: ['zinc_ids'],
    returns:
      '`{ "query", "total_available", "returned_count", "truncated", "source_counts": { "zinc22": int, ... }, "records": [ { "zinc_id", "smiles", "tranche_name", "catalogs", "source", "tranche_properties": { "heavy_atoms", "logp" } } ] }` — records capped at `max_results` (default 50, cap 500); `truncated` true when more were available. `source` is "zinc22"/"zinc20"; ids with no match simply have no record.',
    example: 'result = host.mcp("zinc", "zinc_search_by_id", {"zinc_ids": ["ZINC000000000012"]})',
    run: async (_ctx, a) => {
      const ids = requireIds(a.zinc_ids, MAX_IDS_PER_CALL, 'ZINC id', ZINC_ID_RE)
      const cap = clampMaxResults(a.max_results)
      const { records, counts } = await runSearch(
        'substances.txt',
        { zinc_ids: ids.join(','), output_fields: OUTPUT_FIELDS },
        clampTimeoutS(a.timeout_s)
      )
      return pageResult(records, counts, cap, { zinc_ids: ids })
    }
  },
  {
    id: 'zinc_search_by_smiles',
    connector: 'zinc',
    description:
      'Search ZINC22\'s purchasable chemical space by structure — answers "what purchasable compounds look like this SMILES". This is BOTH the exact-match and the analog-discovery (similarity) tool: CartBlanche22 exposes one structure-search endpoint whose `dist` parameter spans exact through diverse, so there is deliberately no separate similarity-search tool. The slowest ZINC query — raise `dist` gradually rather than starting loose.',
    input: {
      type: 'object',
      properties: {
        smiles: {
          type: 'string',
          description: 'Query SMILES string (sent verbatim as a form field).'
        },
        dist: {
          type: 'integer',
          default: 0,
          description:
            'Tanimoto DISTANCE 0-10 (a distance, not a percent similarity): 0 = exact match, 1-3 = close analogs, 4-6 = moderate, 7-10 = diverse (looser = slower, many more hits).'
        },
        adist: {
          type: 'integer',
          description:
            'Anonymous-graph distance 0-10 (scaffold-shaped tolerance); defaults to dist.'
        },
        max_results: {
          type: 'integer',
          default: DEFAULT_MAX_RESULTS,
          description: 'Response bound (hard cap 500).'
        },
        timeout_s: {
          type: 'number',
          default: DEFAULT_TIMEOUT_S,
          description: 'Overall submit->result budget in seconds (clamped 5-55).'
        }
      },
      required: ['smiles']
    },
    required: ['smiles'],
    returns:
      'The standard bounded shape (`query`, `total_available`, `returned_count`, `truncated`, `source_counts`, `records`) with records as in `zinc_search_by_id`. `query` echoes the resolved `{ smiles, dist, adist }`.',
    example:
      'result = host.mcp("zinc", "zinc_search_by_smiles", {"smiles": "CC(=O)Oc1ccccc1C(=O)O", "dist": 2})',
    run: async (_ctx, a) => {
      const smiles = typeof a.smiles === 'string' ? a.smiles.trim() : ''
      if (!smiles) throw new Error('smiles must be a non-empty SMILES string')
      const dist = requireDistance(a.dist, 0, 'dist must be 0-10 (Tanimoto distance; 0 = exact)')
      const adist =
        a.adist == null
          ? dist
          : requireDistance(a.adist, dist, 'adist must be 0-10 (anonymous-graph distance)')
      const cap = clampMaxResults(a.max_results)
      const { records, counts } = await runSearch(
        'smiles.txt',
        { smiles, dist: String(dist), adist: String(adist), output_fields: OUTPUT_FIELDS },
        clampTimeoutS(a.timeout_s)
      )
      return pageResult(records, counts, cap, { smiles, dist, adist })
    }
  },
  {
    id: 'zinc_search_by_supplier',
    connector: 'zinc',
    description:
      'Resolve vendor catalog numbers to ZINC compounds — answers "which ZINC substance is this supplier code, and what\'s its structure". Batched: up to 100 supplier codes per call. Async upstream (submit + poll).',
    input: {
      type: 'object',
      properties: {
        supplier_codes: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more vendor catalog codes, e.g. MCULE-2311834287 (max 100 per call).'
        },
        max_results: {
          type: 'integer',
          default: DEFAULT_MAX_RESULTS,
          description: 'Response bound (hard cap 500).'
        },
        timeout_s: {
          type: 'number',
          default: DEFAULT_TIMEOUT_S,
          description: 'Overall submit->result budget in seconds (clamped 5-55).'
        }
      },
      required: ['supplier_codes']
    },
    required: ['supplier_codes'],
    returns:
      'The standard bounded shape; records additionally carry `supplier_code` alongside `zinc_id`/`smiles`/`catalogs`/`tranche_name`/`tranche_properties`.',
    example:
      'result = host.mcp("zinc", "zinc_search_by_supplier", {"supplier_codes": ["MCULE-2311834287"]})',
    run: async (_ctx, a) => {
      const codes = requireIds(a.supplier_codes, MAX_IDS_PER_CALL, 'supplier code')
      const cap = clampMaxResults(a.max_results)
      const { records, counts } = await runSearch(
        'catitems.txt',
        {
          supplier_codes: codes.join(','),
          output_fields: 'zinc_id,smiles,supplier_code,catalogs,tranche_name'
        },
        clampTimeoutS(a.timeout_s)
      )
      return pageResult(records, counts, cap, { supplier_codes: codes })
    }
  },
  {
    id: 'zinc_random_sample',
    connector: 'zinc',
    description:
      "Draw a random sample of purchasable compounds from ZINC22 — for building screening decks, property baselines, or decoy sets. `count` doubles as this tool's `max_results`; re-calling draws a fresh sample. Async upstream (submit + poll).",
    input: {
      type: 'object',
      properties: {
        count: {
          type: 'integer',
          default: DEFAULT_MAX_RESULTS,
          description: 'Sample size; doubles as max_results (default 50, hard cap 500).'
        },
        subset: {
          type: 'string',
          description:
            'Optional predefined property filter: fragment (MW < 250), lead-like (MW 250-350, logP <= 3.5), drug-like (MW 350-500, Lipinski), lugs (curated). Other upstream subset names pass through verbatim.'
        },
        timeout_s: {
          type: 'number',
          default: DEFAULT_TIMEOUT_S,
          description: 'Overall submit->result budget in seconds (clamped 5-55).'
        }
      },
      required: []
    },
    returns:
      'The standard bounded shape with records as in `zinc_search_by_id` (random order). `query` echoes `{ count, subset, known_subsets }`.',
    example:
      'result = host.mcp("zinc", "zinc_random_sample", {"count": 25, "subset": "lead-like"})',
    run: async (_ctx, a) => {
      const cap = clampMaxResults(a.count)
      const subset = typeof a.subset === 'string' && a.subset.trim() ? a.subset.trim() : undefined
      const data: Record<string, string> = { count: String(cap), output_fields: OUTPUT_FIELDS }
      if (subset) data.subset = subset
      const { records, counts } = await runSearch(
        'substance/random.txt',
        data,
        clampTimeoutS(a.timeout_s)
      )
      return pageResult(records, counts, cap, {
        count: cap,
        subset: subset ?? null,
        known_subsets: [...KNOWN_SUBSETS]
      })
    }
  },
  {
    id: 'zinc_get_3d',
    connector: 'zinc',
    description:
      'Locate docking-ready 3D structures for ZINC compounds. ZINC22 ships pre-generated 3D conformers (DOCK .db2.gz, .mol2.gz, .sdf.gz) in its file repository, organized by tranche — this tool resolves each id to its tranche and returns the repository locations to download from for docking prep (DOCK6, AutoDock Vina, etc.). Max 50 ids per call (3D retrieval is per-compound work). Async upstream (submit + poll).',
    input: {
      type: 'object',
      properties: {
        zinc_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'ZINC ids to prepare, e.g. ZINC000000000012 (max 50 per call).'
        },
        timeout_s: {
          type: 'number',
          default: DEFAULT_TIMEOUT_S,
          description: 'Overall lookup budget in seconds (clamped 5-55).'
        }
      },
      required: ['zinc_ids']
    },
    required: ['zinc_ids'],
    returns:
      '`{ "query", "returned_count", "structures", "repository_note" }`; each structure carries `zinc_id`, `found`, `smiles`, `source`, `tranche_name` + `tranche_properties`, and (when the tranche decodes) `download`: `{ repository, tranche_path_pattern: "zinc-22*/H##/<tranche>/", formats }`. Sub-release directories (zinc-22a, zinc-22b, …) must be browsed for exact file names — the repository has no per-compound fetch URL.',
    example: 'result = host.mcp("zinc", "zinc_get_3d", {"zinc_ids": ["ZINC000000000012"]})',
    run: async (_ctx, a) => {
      const ids = requireIds(a.zinc_ids, MAX_IDS_3D, 'ZINC id', ZINC_ID_RE)
      const canonical = ids.map(normalizeZincId)
      const { records } = await runSearch(
        'substances.txt',
        { zinc_ids: canonical.join(','), output_fields: OUTPUT_FIELDS },
        clampTimeoutS(a.timeout_s)
      )
      // Key the result map by NORMALIZED id: upstream returns zero-padded ids, so a short-form
      // input would otherwise miss its own result and report an authoritative-looking found:false.
      const byId = new Map<string, ZincRecord>()
      for (const rec of records) {
        if (rec.zinc_id) {
          const key = normalizeZincId(String(rec.zinc_id))
          if (!byId.has(key)) byId.set(key, rec)
        }
      }
      const structures = ids.map((zid, i) => {
        const czid = canonical[i]
        const rec = byId.get(czid)
        if (!rec) return { zinc_id: zid, found: false }
        const decoded = parseTranche(rec.tranche_name ?? rec.tranche)
        const entry: Record<string, unknown> = {
          zinc_id: rec.zinc_id ?? czid,
          found: true,
          smiles: rec.smiles,
          source: rec.source,
          tranche_name: decoded ? decoded.code : null,
          tranche_properties: decoded ? decoded.props : null
        }
        if (decoded) {
          const heavyDir = `H${String(decoded.props.heavy_atoms).padStart(2, '0')}`
          entry.download = {
            repository: `${FILES_BASE_URL}/`,
            tranche_path_pattern: `zinc-22*/${heavyDir}/${decoded.code}/`,
            formats: {
              'db2.gz': 'DOCK 3.x/6 multi-conformer database',
              'mol2.gz': 'Tripos MOL2 with 3D coordinates',
              'sdf.gz': 'SDF with 3D coordinates',
              smi: 'SMILES (no 3D; for bookkeeping)'
            }
          }
        }
        return entry
      })
      return {
        query: { zinc_ids: ids },
        returned_count: structures.length,
        structures,
        repository_note:
          'Browse the sub-release directories (zinc-22a, zinc-22b, …) under the tranche path for exact file names before bulk download; convert with OpenBabel / prepare_ligand4.py for your docking engine.'
      }
    }
  }
]
