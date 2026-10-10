import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '../../connector-core/types'
import { netFetchStandard } from '../../skills/net-fetch'
import { withTimeoutSignal } from '../../connector-core/request-policy'

// EMBL-EBI Job Dispatcher REST API, distinct from the precomputed InterPro annotation API.
// https://www.ebi.ac.uk/jdispatcher/docs/webservices/
const API = 'https://www.ebi.ac.uk/Tools/services/rest/iprscan5'
// Job Dispatcher job identifiers are provider receipts, not a versioned public type. Keep only
// path-safe characters and a bounded length; do not couple callers to the current `iprscan5-` prefix.
const JOB_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$'
const jobId = z.string().max(200).regex(new RegExp(JOB_PATTERN))
const jobProperty = { type: 'string', maxLength: 200, pattern: JOB_PATTERN }
const jobArgs = z.object({ job_id: jobId }).strict()
const HTTP_TIMEOUT_MS = 30_000
const MAX_RECEIPT_BYTES = 16 * 1024
// Local admission limits, not a claim about the provider's maximum sequence length.
const MAX_SEQUENCE_LENGTH = 10_000
const MAX_SEQUENCE_COUNT = 1_000
const MAX_SUBMISSION_BYTES = 4 * 1024 * 1024
const CONTACT_EMAIL_GUIDANCE =
  'Set a contact email in Settings → Credentials → Literature access. This email is sent to EMBL-EBI when submitting a job.'
const SUBMISSION_UNKNOWN =
  'InterProScan submission outcome is uncertain; the job may already exist, but no usable job_id was received. Do not resubmit automatically.'
const LIFECYCLE_GUIDANCE =
  'Keep the exact job_id to resume after restart. This connector adds no job registry, result cache or background polling. ' +
  'Cancellation, app exit and uninstall stop local requests only; this connector cannot cancel or delete remote jobs. Result expiry is controlled by EMBL-EBI. ' +
  'Sequences and contact email are sent to EMBL-EBI; tool inputs and outputs may be retained in conversation or Notebook persistence. ' +
  'Submit no more than 30 jobs in a batch and wait for processing/results before submitting more; cross-call throttling is not enforced. ' +
  'The existing results tool returns at most 2 MiB of TSV and rejects larger reports.'
const submitArgs = z
  .object({
    sequence: z.string().min(1).max(MAX_SUBMISSION_BYTES),
    title: z.string().min(1).max(200).optional()
  })
  .strict()
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

type SequenceInput = {
  sequence: string
  count: number
}

function normalizeSequenceInput(raw: string): SequenceInput {
  const source = raw.trim()
  if (!source) throw new Error('sequence must be a non-empty protein sequence or FASTA input')
  const bytes = new TextEncoder().encode(source).byteLength
  if (bytes > MAX_SUBMISSION_BYTES) {
    throw new Error(`sequence exceeds the ${MAX_SUBMISSION_BYTES}-byte submission limit`)
  }
  const lines = source.split(/\r?\n/).map((line) => line.trim())
  const hasHeaders = lines.some((line) => line.startsWith('>'))
  if (hasHeaders && !lines[0]?.startsWith('>')) {
    throw new Error('FASTA input must start with a header')
  }

  const records: Array<{ header: string; sequence: string }> = []
  if (!hasHeaders) {
    records.push({ header: 'query', sequence: lines.join('').replace(/\s+/g, '') })
  } else {
    let current: { header: string; sequence: string } | undefined
    for (const line of lines) {
      if (!line) continue
      if (line.startsWith('>')) {
        const header = line.slice(1).trim()
        if (!header) throw new Error('every FASTA record must have a non-empty header')
        if (current) records.push(current)
        current = { header, sequence: '' }
      } else {
        if (!current) throw new Error('FASTA input must start with a header')
        current.sequence += line.replace(/\s+/g, '')
      }
    }
    if (current) records.push(current)
  }

  if (records.length === 0) throw new Error('sequence must contain at least one protein sequence')
  if (records.length > MAX_SEQUENCE_COUNT) {
    throw new Error(`sequence contains more than the ${MAX_SEQUENCE_COUNT}-sequence limit`)
  }
  const names = new Set<string>()
  records.forEach(({ header, sequence }, index) => {
    const name = header.split(/\s+/, 1)[0] ?? ''
    if (names.has(name)) throw new Error(`FASTA sequence names must be unique: ${name}`)
    names.add(name)
    const normalized = sequence.toUpperCase()
    if (!normalized) throw new Error(`FASTA record ${index + 1} has no residues`)
    if (normalized.length > MAX_SEQUENCE_LENGTH) {
      throw new Error(`sequence ${index + 1} exceeds the ${MAX_SEQUENCE_LENGTH}-residue limit`)
    }
    if (!/^[A-Za-z]+$/.test(sequence)) {
      throw new Error(`sequence ${index + 1} contains invalid protein characters`)
    }
  })

  const submitted = records
    .map(({ header, sequence }) => `>${header}\n${sequence.toUpperCase()}`)
    .join('\n')
  return { sequence: submitted, count: records.length }
}

function contactEmail(ctx: ToolContext): string {
  const email = ctx.credentials.ncbiEmail?.trim()
  if (!email) throw new Error(`contact_email_required: ${CONTACT_EMAIL_GUIDANCE}`)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(
      `contact_email_invalid: provide a valid contact email. ${CONTACT_EMAIL_GUIDANCE}`
    )
  }
  return email
}

function parseSubmittedJobId(text: string): string {
  const value = text.trim()
  const parsed = jobId.safeParse(value)
  // Restrict new receipts to this service; status/results still accept historical job IDs.
  if (!parsed.success || !/^iprscan5-[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(SUBMISSION_UNKNOWN)
  }
  return parsed.data
}

// This descriptor owns the single submission request and hands the provider receipt to the caller.
// Remote execution/expiry are provider-owned; there is no cancel/delete or recovery-by-sequence path.
class SubmissionRejectedError extends Error {}

async function submitJob(ctx: ToolContext, params: URLSearchParams): Promise<string> {
  const body = params.toString()
  if (new TextEncoder().encode(body).byteLength > MAX_SUBMISSION_BYTES) {
    throw new Error(`encoded submission exceeds the ${MAX_SUBMISSION_BYTES}-byte limit`)
  }
  ctx.signal?.throwIfAborted()
  try {
    return await withTimeoutSignal(HTTP_TIMEOUT_MS, ctx.signal, async (signal) => {
      const response = await netFetchStandard(`${API}/run`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'text/plain',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'Open-Science/1.0 (+https://github.com/aipoch/open-science)'
        },
        body,
        signal
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        // Timeouts, throttling, proxy failures and redirects can leave acceptance uncertain.
        if ([400, 401, 403, 404, 405, 413, 415, 422].includes(response.status)) {
          throw new SubmissionRejectedError(
            `InterProScan submission rejected (HTTP ${response.status}); no job_id received. Do not resubmit automatically.`
          )
        }
        throw new Error(SUBMISSION_UNKNOWN)
      }
      if (!response.body) throw new Error(SUBMISSION_UNKNOWN)
      const reader = response.body.getReader()
      const cancel = (): void => {
        void reader.cancel(signal.reason).catch(() => {})
      }
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
      const decoder = new TextDecoder()
      let bytes = 0
      let receipt = ''
      try {
        for (;;) {
          const part = await reader.read()
          signal.throwIfAborted()
          if (part.done) break
          bytes += part.value.byteLength
          if (bytes > MAX_RECEIPT_BYTES) {
            void reader.cancel().catch(() => {})
            throw new Error(SUBMISSION_UNKNOWN)
          }
          receipt += decoder.decode(part.value, { stream: true })
        }
        return parseSubmittedJobId(receipt + decoder.decode())
      } finally {
        signal.removeEventListener('abort', cancel)
        reader.releaseLock()
      }
    })
  } catch (error) {
    if (error instanceof SubmissionRejectedError) throw error
    // Never include upstream text, request bodies, email, or transport errors in the response.
    throw new Error(SUBMISSION_UNKNOWN)
  }
}

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
    id: 'submit',
    description:
      'Submit one or more protein sequences to EMBL-EBI InterProScan for asynchronous domain and family annotation. Accepts raw protein sequence or FASTA input with at most 1,000 records, a local limit of 10,000 residues per record and a 4 MiB encoded request body limit. Returns a job_id immediately and never polls. Keep the job_id, then call status and results yourself after waiting at least 10 seconds between status checks. A lost response may represent an accepted job; do not resubmit automatically. A valid contact email is required. ' +
      CONTACT_EMAIL_GUIDANCE +
      ' ' +
      LIFECYCLE_GUIDANCE,
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sequence: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_SUBMISSION_BYTES,
          description: 'A raw protein sequence or FASTA input with up to 1,000 records.'
        },
        title: { type: 'string', minLength: 1, maxLength: 200 }
      },
      required: ['sequence']
    },
    required: ['sequence'],
    returns:
      '{job_id,status:"SUBMITTED",ready:false,sequence_count,poll_after_seconds:10}. Submission is not completion; retain job_id and call status/results explicitly.',
    example:
      'const result = await host.mcp("interproscan", "submit", {"sequence":">query\\nMKTIIALSYIFCLVFADYKDDDDK"})',
    totalTimeoutMs: HTTP_TIMEOUT_MS + 5_000,
    maxResponseBytes: MAX_RECEIPT_BYTES,
    run: async (ctx, args) => {
      const a = submitArgs.parse(args)
      const input = normalizeSequenceInput(a.sequence)
      const params = new URLSearchParams({
        email: contactEmail(ctx),
        sequence: input.sequence,
        stype: 'p',
        goterms: 'true',
        pathways: 'true'
      })
      if (a.title !== undefined) params.set('title', a.title)

      const job = await submitJob(ctx, params)
      return {
        job_id: job,
        status: 'SUBMITTED' as const,
        ready: false,
        sequence_count: input.count,
        poll_after_seconds: POLL_SECONDS
      }
    }
  },
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
