import type { ToolDescriptor } from '../types'

// CartBlanche22 (ZINC22 purchasable-compound search) — every search endpoint is ASYNC and
// POST-only (form-encoded): submit returns a task receipt {"task": "<uuid>"}, and the result is
// fetched by polling GET /search/result/<uuid> until `status` is SUCCESS (or a status-less body
// carries a `result` key). A naive GET ?param=value returns HTTP 400 or the HTML SPA shell.
// ToolContext's fetchJson/fetchText/postJson can't express a form-encoded POST or a manual poll
// loop, so this tool talks to the API directly via the global fetch (mirrors upstream
// mcp_zinc/client.py's ZincClient, simplified to the one endpoint this tool needs).
const BASE_URL = 'https://cartblanche22.docking.org'
const OUTPUT_FIELDS = 'zinc_id,smiles,tranche_name,catalogs'
const USER_AGENT = 'OpenScience/1.0 (+https://github.com/aipoch/open-science)'

// Overall submit->result budget (default/clamp mirrors upstream DEFAULT/MIN/MAX_TIMEOUT_S, pulled
// in a bit under the MCP-style 60s transport ceiling that upstream targets).
const DEFAULT_TIMEOUT_S = 25
const MIN_TIMEOUT_S = 5
const MAX_TIMEOUT_S = 45
const POLL_INTERVAL_MS = 1500
const HTTP_TIMEOUT_MS = 10_000

const DEFAULT_MAX_RESULTS = 50
const MAX_RESULTS_CAP = 500
const MAX_IDS_PER_CALL = 100

const ZINC_ID_RE = /^ZINC[a-zA-Z]?\d+$/i
const ID_DELIM_RE = /[,\s]/
// Result sources, presentation order (current release first) — mirrors upstream SOURCE_ORDER.
const SOURCE_ORDER = ['zinc22', 'zinc20']

type ZincRecord = {
  zinc_id?: string
  smiles?: string
  tranche_name?: string
  catalogs?: unknown
  source?: string
}

type SubmitResponse = { task?: string }
type PollResponse = { status?: string; result?: unknown }

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

// Normalizes + bounds a ZINC id list. Entries are joined with commas into the upstream form
// field, so a single entry containing a delimiter would let one list element submit many ids and
// defeat MAX_IDS_PER_CALL — reject those explicitly (mirrors upstream _require_ids).
function normalizeZincIds(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [raw]
  const cleaned = list.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (!cleaned.length) throw new Error('provide at least one ZINC id')
  if (cleaned.length > MAX_IDS_PER_CALL) {
    throw new Error(
      `${cleaned.length} ZINC ids exceeds the per-call bound of ${MAX_IDS_PER_CALL} — split the lookup into smaller batches`
    )
  }
  for (const id of cleaned) {
    if (ID_DELIM_RE.test(id)) {
      throw new Error(
        `ZINC id ${idRepr(id)} contains a comma or whitespace — pass each id as its own list element`
      )
    }
    if (!ZINC_ID_RE.test(id)) {
      throw new Error(
        `ZINC id ${idRepr(id)} is not a valid ZINC id (expected pattern ${ZINC_ID_RE})`
      )
    }
  }
  return cleaned
}

// Quotes the offending value unambiguously in error messages (mirrors Python's !r used in the
// upstream error messages this tool's wording is transcribed from).
function idRepr(id: string): string {
  return `'${id}'`
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

// Flattens a per-source result ({zinc22: [...], zinc20: [...]}, or a bare list for a
// single-source deployment) into one record list tagged with `source`, zinc22 first.
function flattenResult(result: unknown): ZincRecord[] {
  if (result == null) return []
  if (Array.isArray(result)) {
    return result
      .filter((r): r is ZincRecord => typeof r === 'object' && r !== null)
      .map((r) => ({ ...r, source: 'zinc22' }))
  }
  if (typeof result !== 'object') return []
  const bySource = result as Record<string, unknown>
  const sources = [
    ...SOURCE_ORDER.filter((s) => s in bySource),
    ...Object.keys(bySource).filter((s) => !SOURCE_ORDER.includes(s))
  ]
  const records: ZincRecord[] = []
  for (const source of sources) {
    const rows = bySource[source]
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      if (row && typeof row === 'object') records.push({ ...(row as ZincRecord), source })
    }
  }
  return records
}

// ZINC22 purchasable-compound search (CartBlanche22): direct ZINC-id lookup only.
// zinc_search_by_smiles / zinc_search_by_supplier / zinc_random_sample / zinc_get_3d are upstream
// tools on the same async submit-poll transport, deliberately left as follow-up (the SMILES/
// docking-analog search in particular is the slow path this tool intentionally avoids).
export const ZINC_TOOLS: ToolDescriptor[] = [
  {
    id: 'zinc_search_by_id',
    connector: 'zinc',
    description:
      'Look up purchasable compounds in ZINC22/ZINC20 by ZINC identifier — answers "what is this compound and who sells it". Async upstream (submit + poll); can take up to timeout_s seconds.',
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
          description: 'Overall submit->result budget in seconds (clamped 5-45).'
        }
      },
      required: ['zinc_ids']
    },
    required: ['zinc_ids'],
    run: async (_ctx, a) => {
      const ids = normalizeZincIds(a.zinc_ids)
      const cap = clampMaxResults(a.max_results)
      const timeoutS = clampTimeoutS(a.timeout_s)
      const deadline = Date.now() + timeoutS * 1000

      const task = await submit(
        'substances.txt',
        { zinc_ids: ids.join(','), output_fields: OUTPUT_FIELDS },
        deadline
      )
      const payload = await poll(task, deadline)
      const records = flattenResult(payload.result)
      const total = records.length
      const page = records.slice(0, cap)

      return {
        query: { zinc_ids: ids },
        total_available: total,
        returned_count: page.length,
        truncated: total > page.length,
        records: page.map((r) => ({
          zinc_id: r.zinc_id,
          smiles: r.smiles,
          tranche_name: r.tranche_name,
          catalogs: r.catalogs,
          source: r.source
        }))
      }
    }
  }
]
