import { z } from 'zod'
import type { ToolDescriptor } from '../types'

// UniProt's generic results endpoint returns identifier pairs, without full protein records.
// https://www.uniprot.org/help/id_mapping_prog
const API = 'https://rest.uniprot.org/idmapping'
const JOB_PATTERN = '^[A-Za-z0-9_-]+$'
const DB_PATTERN = '^[A-Za-z][A-Za-z0-9_-]*$'
const ID_PATTERN = '^[^,;\\s\\u0000-\\u001f\\u007f]+$'
const CURSOR_PATTERN = '^[^\\s\\u0000-\\u001f\\u007f]+$'
const jobId = z.string().min(1).max(100).regex(new RegExp(JOB_PATTERN))
const database = z.string().min(1).max(100).regex(new RegExp(DB_PATTERN))
const identifier = z.string().min(1).max(200).regex(new RegExp(ID_PATTERN))
const cursorValue = z.string().min(1).max(4096).regex(new RegExp(CURSOR_PATTERN))
const jobProperty = { type: 'string', minLength: 1, maxLength: 100, pattern: JOB_PATTERN }
const databaseProperty = { type: 'string', minLength: 1, maxLength: 100, pattern: DB_PATTERN }

const submitArgs = z
  .object({
    from_db: database,
    to_db: database,
    ids: z.array(identifier).min(1).max(100_000),
    taxon_id: z.number().int().min(1).max(2_147_483_647).optional()
  })
  .strict()
  .refine((a) => a.taxon_id === undefined || a.from_db === 'Gene_Name', {
    message: 'taxon_id is supported only for from_db=Gene_Name'
  })
const statusArgs = z.object({ job_id: jobId }).strict()
const resultsArgs = statusArgs.extend({
  page_size: z.number().int().min(1).max(500).default(100),
  cursor: cursorValue.optional()
})
const pair = z.object({ from: identifier, to: identifier })
const resultPage = z
  .object({
    results: z.array(pair).optional(),
    failedIds: z.array(identifier).optional(),
    jobStatus: z.never().optional(),
    messages: z.never().optional()
  })
  .refine((v) => v.results !== undefined || v.failedIds !== undefined, {
    message: 'UniProt mapping response must contain results or failedIds'
  })

function nextCursor(headers: Headers, job: string, current?: string): string | null {
  const link = headers.get('link')
  if (!link) return null
  const links = [...link.matchAll(/<([^>]+)>\s*;\s*rel="?([^";,]+)"?/g)]
  if (!links.length) throw new Error('Invalid UniProt mapping pagination Link')
  const next = links.filter((m) => m[2].split(/\s+/).includes('next'))
  if (!next.length) return null
  if (next.length !== 1) throw new Error('Multiple UniProt mapping next links')
  const url = new URL(next[0][1])
  const cursor = cursorValue.parse(url.searchParams.get('cursor'))
  if (
    url.origin !== 'https://rest.uniprot.org' ||
    url.pathname !== `/idmapping/results/${job}` ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.getAll('cursor').length !== 1 ||
    cursor === current
  )
    throw new Error('Invalid or repeated UniProt mapping next cursor')
  // Never fetch an upstream Link target; rebuild the fixed job endpoint with the opaque cursor.
  return cursor
}

function totalResults(headers: Headers): number | null {
  const value = headers.get('x-total-results')
  if (value === null) return null
  const n = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n))
    throw new Error('Invalid UniProt mapping x-total-results')
  return n
}

export const GENES_UNIPROT_MAPPING_TOOLS: ToolDescriptor[] = [
  {
    id: 'submit_uniprot_id_mapping',
    connector: 'genes',
    description:
      'Submit up to 100,000 identifiers for UniProt batch ID mapping. from_db/to_db are exact UniProt API database names (e.g. Gene_Name, GeneID, Ensembl, RefSeq_Protein, UniProtKB_AC-ID -> UniProtKB; UniProtKB_AC-ID -> Ensembl or GeneID). Valid pairs are defined by https://rest.uniprot.org/configure/idmapping/fields; unsupported pairs fail upstream. taxon_id is optional only for Gene_Name; specify it to disambiguate species. IDs must be individual strings without whitespace or separators; case and versions are preserved, exact duplicates submitted once. Pass accessions from search_uniprot_entries as ids with from_db=UniProtKB_AC-ID. Sends one POST, never automatically retries or polls. Save job_id, then use get_uniprot_id_mapping_status and get_uniprot_id_mapping_results. UniProt expires results after up to 7 days; cancellation or app shutdown stops local requests, not the remote job. No local job cache or remote cancellation/deletion API is provided. If submission loses its response, a job may exist; do not blindly resubmit.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from_db: databaseProperty,
        to_db: databaseProperty,
        ids: {
          type: 'array',
          minItems: 1,
          maxItems: 100_000,
          items: { type: 'string', minLength: 1, maxLength: 200, pattern: ID_PATTERN }
        },
        taxon_id: { type: 'integer', minimum: 1, maximum: 2_147_483_647 }
      },
      required: ['from_db', 'to_db', 'ids'],
      if: { properties: { taxon_id: {} }, required: ['taxon_id'] },
      then: { properties: { from_db: { const: 'Gene_Name' } } }
    },
    required: ['from_db', 'to_db', 'ids'],
    returns:
      '{job_id,from_db,to_db,taxon_id:number|null,n_input,n_submitted,n_duplicates_removed}. Submission is not completion; retain the exact job_id to resume after a restart.',
    example:
      'const result = await host.mcp("genes", "submit_uniprot_id_mapping", {"from_db":"Gene_Name","to_db":"UniProtKB","ids":["TP53","BRCA1"],"taxon_id":9606})',
    run: async (ctx, args) => {
      const a = submitArgs.parse(args)
      const ids = [...new Set(a.ids)]
      const form = new FormData()
      form.set('from', a.from_db)
      form.set('to', a.to_db)
      form.set('ids', ids.join(','))
      if (a.taxon_id !== undefined) form.set('taxId', String(a.taxon_id))
      let response: { jobId: string }
      try {
        response = z.object({ jobId }).parse(await ctx.postForm(`${API}/run`, form))
      } catch (error) {
        ctx.signal?.throwIfAborted()
        // The shared engine's Retry-After hint is unsuitable for a non-idempotent submission.
        // Preserve the cause for diagnostics, but expose no instruction to repeat the POST.
        const httpStatus =
          error instanceof Error ? /^HTTP (\d{3}) for /.exec(error.message)?.[1] : undefined
        // UniProt rejects invalid submission parameters with HTTP 400 before creating a job.
        if (httpStatus === '400')
          throw new Error(
            'UniProt ID mapping submission was rejected (HTTP 400). ' +
              'Check from_db, to_db, ids and taxon_id against the UniProt mapping parameters. ' +
              'Correct the parameters before submitting again; do not retry unchanged.',
            { cause: error }
          )
        throw new Error(
          `UniProt ID mapping submission returned no valid job_id${httpStatus ? ` (HTTP ${httpStatus})` : ''}. ` +
            'The submission outcome is unconfirmed; a remote job may already exist. ' +
            'Do not automatically resubmit. If a job_id was received, check its status instead.',
          { cause: error }
        )
      }
      return {
        job_id: response.jobId,
        from_db: a.from_db,
        to_db: a.to_db,
        taxon_id: a.taxon_id ?? null,
        n_input: a.ids.length,
        n_submitted: ids.length,
        n_duplicates_removed: a.ids.length - ids.length
      }
    }
  },
  {
    id: 'get_uniprot_id_mapping_status',
    connector: 'genes',
    description:
      'Check an existing UniProt ID mapping job once. NEW/RUNNING means poll this tool later (at least 3 seconds apart); FINISHED means fetch all pages with get_uniprot_id_mapping_results. Upstream ERROR is normalized to FAILED, a terminal job failure, not unmatched IDs. HTTP 400/500 job failures are read without automatic retries; other HTTP failures (including unknown/expired jobs) propagate. Does not submit a new job or automatically poll.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: { job_id: jobProperty },
      required: ['job_id']
    },
    required: ['job_id'],
    returns:
      '{job_id,status:"NEW"|"RUNNING"|"FINISHED"|"FAILED",ready:boolean,messages:string[]}. Upstream errors are preserved in messages as "[code] message"; FAILED may have no details. A completed status response may redirect to a result page; its rows are not returned here. Retrieve results separately to collect mapping pairs and failed_ids.',
    example:
      'const result = await host.mcp("genes", "get_uniprot_id_mapping_status", {"job_id":"ecuuh9h0Md"})',
    run: async (ctx, args) => {
      const a = statusArgs.parse(args)
      const { body: raw, status: httpStatus } = await ctx.fetchJsonWithHeaders(
        `${API}/status/${a.job_id}`,
        { allowHttpStatuses: [400, 500] }
      )
      const body = z
        .object({
          jobStatus: z.enum(['NEW', 'RUNNING', 'FINISHED', 'ERROR']).optional(),
          messages: z.array(z.string()).optional(),
          errors: z
            .array(z.object({ code: z.number().int(), message: z.string().min(1) }))
            .optional()
        })
        .passthrough()
        .parse(raw)
      if (httpStatus >= 400 && body.jobStatus !== 'ERROR')
        throw new Error(
          `HTTP ${httpStatus} for UniProt mapping status: ${body.messages?.join('; ') || 'no terminal job status returned'}`
        )
      if (body.errors?.length && body.jobStatus !== 'ERROR')
        throw new Error('Invalid UniProt mapping status: errors without ERROR status')
      let status = body.jobStatus
      if (!status) {
        if (body.messages?.length) throw new Error(`UniProt mapping: ${body.messages.join('; ')}`)
        // Native fetch follows UniProt's completion redirect. Enriched target objects are valid
        // here; the generic results endpoint below supplies the compact identifier pairs.
        z.object({
          results: z.array(z.unknown()).optional(),
          failedIds: z.array(identifier).optional()
        })
          .refine((v) => v.results !== undefined || v.failedIds !== undefined)
          .parse(raw)
        status = 'FINISHED'
      }
      return {
        job_id: a.job_id,
        status: status === 'ERROR' ? 'FAILED' : status,
        ready: status === 'FINISHED',
        messages: [
          ...(body.messages ?? []),
          ...(body.errors ?? []).map((error) => `[${error.code}] ${error.message}`)
        ]
      }
    }
  },
  {
    id: 'get_uniprot_id_mapping_results',
    connector: 'genes',
    description:
      'Fetch one page of compact UniProt ID mapping pairs for a finished job. Repeat with next_cursor and identical job_id/page_size until has_more=false; cursors are opaque, not offsets or durable snapshots. Every from/to row is retained, including one-to-many mappings. Merge pairs by from across ALL pages before interpreting multiplicity; a source can span pages. Collect the union of failed_ids reported across pages; never infer unmatched IDs from absence on a page. UniProtKB target IDs can be passed to get_uniprot_entries for annotations or sequences.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        job_id: jobProperty,
        page_size: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        cursor: { type: 'string', minLength: 1, maxLength: 4096, pattern: CURSOR_PATTERN }
      },
      required: ['job_id']
    },
    required: ['job_id'],
    returns:
      '{job_id,page_size,n_records,total_results:number|null,has_more,next_cursor:string|null,records:[{from,to}],failed_ids:string[],one_to_many_in_page:[{from,to:string[]}]}. total_results is the upstream count of mapping rows, not matched input IDs; null if absent. failed_ids contains only upstream-reported misses on this page (empty if omitted). one_to_many_in_page lists sources with multiple distinct targets on this page only; an empty list does not establish one-to-one mapping across the job. No automatic traversal or truncation.',
    example:
      'const result = await host.mcp("genes", "get_uniprot_id_mapping_results", {"job_id":"ecuuh9h0Md","page_size":100})',
    run: async (ctx, args) => {
      const a = resultsArgs.parse(args)
      const query = new URLSearchParams({ format: 'json', size: String(a.page_size) })
      if (a.cursor !== undefined) query.set('cursor', a.cursor)
      const { body, headers } = await ctx.fetchJsonWithHeaders(
        `${API}/results/${a.job_id}?${query}`
      )
      const page = resultPage.parse(body)
      const records = page.results ?? []
      const next = nextCursor(headers, a.job_id, a.cursor)
      const total = totalResults(headers)
      if (
        records.length > a.page_size ||
        (next !== null && records.length === 0) ||
        (total !== null &&
          (total < records.length ||
            (!a.cursor && !next && total !== records.length) ||
            (next !== null && total <= records.length)))
      )
        throw new Error('Inconsistent UniProt mapping pagination or result count')
      const groups = new Map<string, Set<string>>()
      for (const record of records) {
        if (!groups.has(record.from)) groups.set(record.from, new Set())
        groups.get(record.from)!.add(record.to)
      }
      return {
        job_id: a.job_id,
        page_size: a.page_size,
        n_records: records.length,
        total_results: total,
        has_more: next !== null,
        next_cursor: next,
        records,
        failed_ids: page.failedIds ?? [],
        one_to_many_in_page: [...groups]
          .filter(([, targets]) => targets.size > 1)
          .map(([from, targets]) => ({ from, to: [...targets] }))
      }
    }
  }
]
