import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '../types'

// EMBL-EBI's asynchronous HMMER web API. The service runs HMMER3 against curated
// sequence/profile databases and returns a provider-owned job receipt.
const API = 'https://www.ebi.ac.uk/Tools/hmmer/api/v1'
const MAX_INPUT_CHARS = 200_000
const MAX_RESULT_BYTES = 8 * 1024 * 1024
const MAX_RESULT_PAGES = 100
const POLL_SECONDS = 10

const programs = ['phmmer', 'hmmscan', 'hmmsearch', 'jackhmmer'] as const
const databases = [
  'refprot',
  'uniprot',
  'swissprot',
  'pdb',
  'rp15',
  'rp35',
  'rp55',
  'rp75',
  'pfam'
] as const
const programProperty = { type: 'string', enum: [...programs] }
const databaseProperty = { type: 'string', enum: [...databases] }
const inputProperty = { type: 'string', minLength: 1, maxLength: MAX_INPUT_CHARS }
const jobIdPattern = '^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$'
const jobIdProperty = { type: 'string', pattern: jobIdPattern, maxLength: 36 }

const jobId = z.string().regex(new RegExp(jobIdPattern))
const searchArgs = z
  .object({
    program: z.enum(programs),
    database: z.enum(databases),
    input: z.string().min(1).max(MAX_INPUT_CHARS),
    incE: z.number().finite().positive().max(10).optional(),
    incdomE: z.number().finite().positive().max(10).optional(),
    incT: z.number().finite().positive().optional(),
    incdomT: z.number().finite().positive().optional(),
    E: z.number().finite().positive().max(10).optional(),
    domE: z.number().finite().positive().max(10).optional(),
    T: z.number().finite().positive().optional(),
    domT: z.number().finite().positive().optional(),
    popen: z.number().finite().min(0).lt(0.5).optional(),
    pextend: z.number().finite().min(0).lt(1).optional(),
    mx: z.enum(['BLOSUM45', 'BLOSUM62', 'BLOSUM90', 'PAM30', 'PAM70']).optional(),
    iterations: z.number().int().min(1).max(9).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.program === 'hmmscan' && value.database !== 'pfam') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['database'],
        message: 'hmmscan currently supports the Pfam database only'
      })
    }
    if (value.program !== 'hmmscan' && value.database === 'pfam') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['database'],
        message: 'the Pfam database is supported only by hmmscan'
      })
    }
    if (
      !['phmmer', 'jackhmmer'].includes(value.program) &&
      [value.popen, value.pextend, value.mx].some((parameter) => parameter !== undefined)
    ) {
      for (const field of ['popen', 'pextend', 'mx'] as const) {
        if (value[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is supported only for phmmer or jackhmmer`
          })
        }
      }
    }
    if (value.program !== 'jackhmmer' && value.iterations !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['iterations'],
        message: 'iterations is supported only for jackhmmer'
      })
    }
  })

const jobArgs = z.object({ job_id: jobId }).strict()

type HmmerStatus = {
  status: string
  payload: Record<string, unknown>
}

function parseStatus(raw: unknown, httpStatus?: number): HmmerStatus {
  if (httpStatus === 404) return { status: 'NOT_FOUND', payload: {} }
  const body = z.record(z.string(), z.unknown()).safeParse(raw)
  if (
    !body.success ||
    typeof body.data.status !== 'string' ||
    !/^[A-Z_]{2,32}$/.test(body.data.status)
  ) {
    throw new Error(
      'HMMER returned an invalid job response; keep the job_id and do not resubmit the search.'
    )
  }
  return { status: body.data.status, payload: body.data }
}

async function getStatus(ctx: ToolContext, id: string): Promise<HmmerStatus> {
  const response = await ctx.fetchJsonWithHeaders(`${API}/search/${id}`, {
    allowHttpStatuses: [404]
  })
  if (response.status === 404) return { status: 'NOT_FOUND', payload: {} }
  const body = z
    .object({ task: z.object({ status: z.string() }).nullable().optional() })
    .passthrough()
    .safeParse(response.body)
  if (!body.success || typeof body.data.task?.status !== 'string') {
    throw new Error(
      'HMMER returned an invalid job response; keep the job_id and do not resubmit the search.'
    )
  }
  return parseStatus({ ...body.data, status: body.data.task.status }, response.status)
}

async function getResultPage(ctx: ToolContext, id: string, page: number): Promise<unknown> {
  const response = await ctx.fetchJsonWithHeaders(
    `${API}/result/${id}?page=${page}&page_size=50&with_domains=true`,
    { allowHttpStatuses: [404] }
  )
  return response.status === 404 ? { status: 'NOT_FOUND' } : response.body
}

function resultBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  return new TextEncoder().encode(serialized).byteLength
}

export const HMMER_TOOLS: ToolDescriptor[] = [
  {
    connector: 'hmmer',
    id: 'search',
    description:
      'Submit one asynchronous EMBL-EBI HMMER3 search. program selects phmmer (protein sequence against a sequence database), hmmscan (protein sequence against Pfam profiles), hmmsearch (profile HMM/alignment against a sequence database), or jackhmmer (iterative remote-homolog search). input is the FASTA sequence, profile HMM, or alignment text accepted by that program. database is the provider database name. Optional thresholds use HMMER parameter names (incE/incdomE, E/domE, incT/incdomT, T/domT); iterations controls jackhmmer rounds. Submission is not completion: retain the returned job_id and poll with status. The service may accept a job even if the response is lost; never automatically resubmit an uncertain submission.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        program: programProperty,
        database: databaseProperty,
        input: inputProperty,
        incE: { type: 'number', exclusiveMinimum: 0, maximum: 10 },
        incdomE: { type: 'number', exclusiveMinimum: 0, maximum: 10 },
        incT: { type: 'number', exclusiveMinimum: 0 },
        incdomT: { type: 'number', exclusiveMinimum: 0 },
        E: { type: 'number', exclusiveMinimum: 0, maximum: 10 },
        domE: { type: 'number', exclusiveMinimum: 0, maximum: 10 },
        T: { type: 'number', exclusiveMinimum: 0 },
        domT: { type: 'number', exclusiveMinimum: 0 },
        popen: { type: 'number', minimum: 0, exclusiveMaximum: 0.5 },
        pextend: { type: 'number', minimum: 0, exclusiveMaximum: 1 },
        mx: { type: 'string', enum: ['BLOSUM45', 'BLOSUM62', 'BLOSUM90', 'PAM30', 'PAM70'] },
        iterations: { type: 'integer', minimum: 1, maximum: 9 }
      },
      required: ['program', 'database', 'input'],
      allOf: [
        {
          if: { properties: { program: { const: 'hmmscan' } }, required: ['program'] },
          then: { properties: { database: { const: 'pfam' } } }
        },
        {
          if: {
            properties: { program: { enum: ['phmmer', 'hmmsearch', 'jackhmmer'] } },
            required: ['program']
          },
          then: { properties: { database: { not: { const: 'pfam' } } } }
        },
        ...(['popen', 'pextend', 'mx'] as const).map((field) => ({
          if: {
            properties: {
              program: { not: { enum: ['phmmer', 'jackhmmer'] } },
              [field]: {}
            },
            required: ['program', field]
          },
          then: { not: { required: [field] } }
        })),
        {
          if: {
            properties: { program: { not: { const: 'jackhmmer' } }, iterations: {} },
            required: ['program', 'iterations']
          },
          then: { not: { required: ['iterations'] } }
        }
      ]
    },
    required: ['program', 'database', 'input'],
    returns:
      '{job_id,program,database,status:"SUBMITTED"}. Keep job_id and call status until ready=true; this connector does not poll or resubmit automatically.',
    example:
      'const result = await host.mcp("hmmer", "search", {"program":"hmmscan","database":"pfam","input":">query\\nMKTIIALSYIFCLVFADYKDDDDK"})',
    totalTimeoutMs: 60_000,
    maxResponseBytes: 16 * 1024,
    run: async (ctx, args) => {
      const a = searchArgs.parse(args)
      const body: Record<string, unknown> = {
        database: a.database,
        input: a.input
      }
      for (const key of [
        'incE',
        'incdomE',
        'incT',
        'incdomT',
        'E',
        'domE',
        'T',
        'domT',
        'popen',
        'pextend',
        'mx',
        'iterations'
      ] as const) {
        if (a[key] !== undefined) body[key] = a[key]
      }
      let response: unknown
      try {
        response = await ctx.postJson(`${API}/search/${a.program}`, body, { retry: false })
      } catch (error) {
        ctx.signal?.throwIfAborted()
        throw new Error(
          'HMMER submission outcome is uncertain; a remote job may already exist. Do not automatically resubmit. ' +
            'If a job_id was returned, use hmmer/status to resume.',
          { cause: error }
        )
      }
      const receipt = z.object({ id: jobId }).passthrough().safeParse(response)
      if (!receipt.success) {
        throw new Error(
          'HMMER returned no valid job_id; the submission outcome is uncertain. Do not automatically resubmit.'
        )
      }
      return {
        job_id: receipt.data.id,
        program: a.program,
        database: a.database,
        status: 'SUBMITTED'
      }
    }
  },
  {
    connector: 'hmmer',
    id: 'status',
    description:
      'Check one HMMER job once, without polling or resubmitting. SUCCESS means results are available; PENDING/RUNNING means wait before checking again; ERROR/FAILURE/NOT_FOUND are terminal outcomes and never mean zero hits. Keep the exact job_id.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: { job_id: jobIdProperty },
      required: ['job_id']
    },
    required: ['job_id'],
    returns:
      '{job_id,status,ready,poll_after_seconds}. ready is true only when status is SUCCESS; unknown provider statuses are preserved for forward compatibility.',
    example:
      'const result = await host.mcp("hmmer", "status", {"job_id":"8ebb1d5f-4457-4da8-808c-f811105c3654"})',
    maxResponseBytes: 16 * 1024,
    totalTimeoutMs: 30_000,
    run: async (ctx, args) => {
      const a = jobArgs.parse(args)
      const { status } = await getStatus(ctx, a.job_id)
      return {
        job_id: a.job_id,
        status,
        ready: status === 'SUCCESS',
        poll_after_seconds: ['PENDING', 'RUNNING', 'QUEUED'].includes(status) ? POLL_SECONDS : null
      }
    }
  },
  {
    connector: 'hmmer',
    id: 'results',
    description:
      'Retrieve one HMMER job result once. Checks the provider status first and returns no result payload while the job is pending or failed. On SUCCESS, retrieves all result pages, including domain annotations; jackhmmer iteration records are returned in the provider array shape. Preserve the result in a Notebook artifact because provider retention is finite; an empty match list is a completed zero-hit result, distinct from a pending or failed job.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: { job_id: jobIdProperty },
      required: ['job_id']
    },
    required: ['job_id'],
    returns:
      '{job_id,status,ready:false} until SUCCESS; otherwise {job_id,status:"SUCCESS",ready:true,result:object|array}. Result pages are merged into one result object.',
    example:
      'const result = await host.mcp("hmmer", "results", {"job_id":"8ebb1d5f-4457-4da8-808c-f811105c3654"})',
    maxResponseBytes: MAX_RESULT_BYTES,
    totalTimeoutMs: 60_000,
    run: async (ctx, args) => {
      const a = jobArgs.parse(args)
      const { status } = await getStatus(ctx, a.job_id)
      if (status !== 'SUCCESS') return { job_id: a.job_id, status, ready: false }
      const first = await getResultPage(ctx, a.job_id, 1)
      let totalBytes = resultBytes(first)
      if (totalBytes > MAX_RESULT_BYTES) {
        throw new Error('HMMER result exceeds the connector 8 MiB output budget.')
      }
      if (Array.isArray(first)) return { job_id: a.job_id, status, ready: true, result: first }
      const page = z
        .object({
          status: z.string(),
          result: z.record(z.string(), z.unknown()).nullable().optional(),
          page_count: z.number().int().positive().nullable().optional()
        })
        .passthrough()
        .parse(first)
      if (page.status !== 'SUCCESS') return { job_id: a.job_id, status: page.status, ready: false }
      const merged = page.result ? { ...page.result } : null
      const hits = Array.isArray(merged?.hits) ? [...merged.hits] : []
      if (page.page_count === null || page.page_count === undefined) {
        if (hits.length > 0) {
          throw new Error('HMMER did not provide a page count for a non-empty result.')
        }
      } else if (page.page_count > MAX_RESULT_PAGES) {
        throw new Error(`HMMER result has too many pages (maximum ${MAX_RESULT_PAGES}).`)
      }
      for (let current = 2; current <= (page.page_count ?? 1); current++) {
        const next = await getResultPage(ctx, a.job_id, current)
        totalBytes += resultBytes(next)
        if (totalBytes > MAX_RESULT_BYTES) {
          throw new Error('HMMER result exceeds the connector 8 MiB output budget.')
        }
        if (Array.isArray(next)) return { job_id: a.job_id, status, ready: true, result: next }
        const nextPage = z
          .object({ result: z.record(z.string(), z.unknown()).nullable().optional() })
          .passthrough()
          .parse(next)
        if (Array.isArray(nextPage.result?.hits)) hits.push(...nextPage.result.hits)
      }
      if (merged && 'hits' in merged) merged.hits = hits
      return {
        job_id: a.job_id,
        status,
        ready: true,
        result: { ...page, ...(merged ? { result: merged } : {}) }
      }
    }
  }
]
