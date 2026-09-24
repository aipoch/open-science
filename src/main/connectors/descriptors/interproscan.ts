import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '../types'

// EMBL-EBI Job Dispatcher REST API, distinct from the precomputed InterPro annotation API.
// https://www.ebi.ac.uk/jdispatcher/docs/webservices/
const API = 'https://www.ebi.ac.uk/Tools/services/rest/iprscan5'
// Job Dispatcher job identifiers are provider receipts, not a versioned public type. Keep only
// path-safe characters and a bounded length; do not couple callers to the current `iprscan5-` prefix.
const JOB_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$'
const jobId = z.string().max(200).regex(new RegExp(JOB_PATTERN))
const jobProperty = { type: 'string', maxLength: 200, pattern: JOB_PATTERN }
const jobArgs = z.object({ job_id: jobId }).strict()
const statuses = z.enum([
  'PENDING',
  'QUEUED',
  'RUNNING',
  'FINISHED',
  'ERROR',
  'FAILURE',
  'NOT_FOUND'
])
const MAX_RESULT_BYTES = 2 * 1024 * 1024
const POLL_SECONDS = 10

async function statusOf(ctx: ToolContext, job: string): Promise<z.infer<typeof statuses>> {
  const text = await ctx.fetchText(`${API}/status/${job}`, 'text/plain', { retry: false })
  const parsed = statuses.safeParse(text.trim())
  if (!parsed.success)
    throw new Error(
      'InterProScan returned an unrecognized job status; reply omitted. Keep job_id; do not resubmit.'
    )
  return parsed.data
}

// TSV fields are documented at https://interproscan-docs.readthedocs.io/en/v5/OutputFormats.html.
// Keep all columns and raw scores, including optional InterPro/GO/pathway annotations.
function matchCount(text: string): number {
  if (!text.trim()) return 0
  const rows = text.trimEnd().split(/\r?\n/)
  for (const row of rows) {
    const fields = row.split('\t')
    const length = Number(fields[2])
    const start = Number(fields[6])
    const end = Number(fields[7])
    if (
      fields.length < 11 ||
      fields.length > 15 ||
      !fields[0] ||
      !/^[a-f0-9]{32}$/i.test(fields[1]) ||
      !fields[3] ||
      !fields[4] ||
      !/^\d+$/.test(fields[2]) ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      !/^\d+$/.test(fields[6]) ||
      !Number.isSafeInteger(start) ||
      start < 1 ||
      !/^\d+$/.test(fields[7]) ||
      !Number.isSafeInteger(end) ||
      end < start ||
      end > length ||
      fields[9] !== 'T'
    )
      throw new Error(
        'InterProScan returned an invalid TSV report; reply omitted. Keep job_id; do not resubmit.'
      )
  }
  return rows.length
}

export const INTERPROSCAN_TOOLS: ToolDescriptor[] = [
  {
    connector: 'interproscan',
    id: 'status',
    description:
      'Check one InterProScan job once, without retrying or polling. Wait at least 10 seconds between checks. FINISHED means results can be retrieved; ERROR/FAILURE are job failures, NOT_FOUND means unknown or expired, never a zero-hit result. Keep the exact job_id; this tool never resubmits.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: { job_id: jobProperty },
      required: ['job_id']
    },
    required: ['job_id'],
    returns:
      '{job_id,status:"PENDING"|"QUEUED"|"RUNNING"|"FINISHED"|"ERROR"|"FAILURE"|"NOT_FOUND",ready,poll_after_seconds:number|null}. ready is true only for FINISHED.',
    example:
      'const result = await host.mcp("interproscan", "status", {"job_id":"iprscan5-R20260922-123456-0123-12345678-p1m"})',
    maxResponseBytes: 1024,
    totalTimeoutMs: 30_000,
    run: async (ctx, args) => {
      const a = jobArgs.parse(args)
      const status = await statusOf(ctx, a.job_id)
      return {
        job_id: a.job_id,
        status,
        ready: status === 'FINISHED',
        poll_after_seconds: ['PENDING', 'QUEUED', 'RUNNING'].includes(status) ? POLL_SECONDS : null
      }
    }
  },
  {
    connector: 'interproscan',
    id: 'results',
    description:
      'Retrieve the complete InterProScan TSV report for a job, capped at 2 MiB (oversized reports fail, never truncate). Checks status once first, then fetches TSV only for FINISHED. No retries, polling, or resubmission. Preserve the report in a Notebook artifact promptly because provider results expire. TSV contains one row per signature match; coordinates are 1-based inclusive and scores are application-specific. Optional columns hold InterPro, GO and pathway annotations. An empty TSV after FINISHED means no reported matches, not evidence that the protein lacks function.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: { job_id: jobProperty },
      required: ['job_id']
    },
    required: ['job_id'],
    returns:
      '{job_id,status,ready:false} when not FINISHED, otherwise {job_id,status:"FINISHED",ready:true,format:"tsv",n_matches,data:string}. data is the complete verbatim TSV (no header); n_matches counts rows, not unique domains or proteins. Failure/expired statuses have no data or match count.',
    example:
      'const result = await host.mcp("interproscan", "results", {"job_id":"iprscan5-R20260922-123456-0123-12345678-p1m"})',
    maxResponseBytes: MAX_RESULT_BYTES,
    totalTimeoutMs: 60_000,
    run: async (ctx, args) => {
      const a = jobArgs.parse(args)
      const status = await statusOf(ctx, a.job_id)
      if (status !== 'FINISHED') return { job_id: a.job_id, status, ready: false }
      const data = await ctx.fetchText(`${API}/result/${a.job_id}/tsv`, 'text/plain', {
        retry: false
      })
      return {
        job_id: a.job_id,
        status,
        ready: true,
        format: 'tsv',
        n_matches: matchCount(data),
        data
      }
    }
  }
]
