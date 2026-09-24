import type { ToolContext, ToolDescriptor } from '../types'
import { netFetchStandard } from '../../skills/net-fetch'
import { withTimeoutSignal } from '../request-policy'
import { redactSensitiveText } from '../../diagnostic-redaction'

const CLUSTALO_URL = 'https://www.ebi.ac.uk/Tools/services/rest/clustalo'
const HTTP_TIMEOUT_MS = 30_000
const MAX_SUBMISSION_BYTES = 4 * 1024 * 1024
const MAX_SEQUENCE_COUNT = 4_000
const MAX_STATUS_BYTES = 256 * 1024
const MAX_RESULT_BYTES = 8 * 1024 * 1024
const MIN_POLL_SECONDS = 10

const OUTPUT_FORMATS = ['clustal_num'] as const
type OutputFormat = (typeof OUTPUT_FORMATS)[number]
type SequenceType = 'protein' | 'dna' | 'rna'
type JobStatus = 'QUEUED' | 'RUNNING' | 'FINISHED' | 'ERROR' | 'FAILURE' | 'NOT_FOUND'

const CONTACT_EMAIL_GUIDANCE =
  'Set a contact email in Settings → Privacy → Share contact email with research data services.'
const LIFECYCLE_GUIDANCE =
  'EMBL-EBI stores results for a limited provider-controlled period (documented as up to one week); this is not an app-owned deletion guarantee. ' +
  'Keep the job_id to resume after restart. This connector adds no job registry, result cache or automatic resubmission, and cancellation/app exit only stop local requests. ' +
  'The sequence is sent to EMBL-EBI, and the host may retain tool inputs and returned alignment content in conversation or Notebook persistence. ' +
  'Respect EMBL-EBI fair-use guidance: submit no more than 30 jobs in a batch and wait for processing/results before submitting more; this connector does not enforce cross-call throttling.'

const redactClustalMessage = (message: string, ctx: ToolContext): string => {
  let redacted = message
  for (const secret of [ctx.credentials.ncbiEmail, ctx.credentials.ncbiApiKey]) {
    if (!secret) continue
    for (const value of [
      secret,
      encodeURIComponent(secret),
      encodeURIComponent(secret).replace(/%20/g, '+')
    ]) {
      redacted = redacted.replaceAll(value, '[redacted]')
    }
  }
  return redactSensitiveText(redacted)
}

// Lifecycle owner: this descriptor owns submission and returns the exact provider job_id to the
// caller. The caller must retain that receipt to resume status/results; there is no local job
// registry, cache, background worker or automatic resubmission. EMBL-EBI controls result expiry
// (up to the provider's documented retention period) and exposes no documented cancel/delete route
// for this service. Abort, shutdown and uninstall stop local requests only.

const resultType = (format: OutputFormat): string => `aln-${format}`

const resultSuffix = (format: OutputFormat): string => {
  void format
  return 'aln'
}

class ClustalSubmissionRejectedError extends Error {
  override readonly name = 'ClustalSubmissionRejectedError'
}

const jobIdOf = (raw: unknown): string => {
  const jobId = String(raw ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId)) {
    throw new Error('job_id must be a valid EMBL-EBI Job Dispatcher identifier')
  }
  return jobId
}

const contactEmail = (ctx: ToolContext): string => {
  const email = ctx.credentials.ncbiEmail?.trim()
  if (!email) throw new Error(`contact_email_required: ${CONTACT_EMAIL_GUIDANCE}`)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(
      `contact_email_invalid: provide a valid contact email. ${CONTACT_EMAIL_GUIDANCE}`
    )
  }
  return email
}

const readBoundedText = async (
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
  unknownMessage: string
): Promise<string> => {
  if (!response.body) throw new Error(unknownMessage)
  const reader = response.body.getReader()
  const cancel = (): void => {
    void reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytes = 0
  try {
    for (;;) {
      const part = await reader.read()
      signal.throwIfAborted()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => {})
        throw new Error(`EMBL-EBI response exceeded the ${maxBytes}-byte limit`)
      }
      chunks.push(decoder.decode(part.value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

const parseJobId = (text: string): string => {
  const jobId = text.trim().split(/\s+/)[0]
  if (!jobId) throw new Error('EMBL-EBI returned an empty job identifier')
  return jobIdOf(jobId)
}

const parseStatus = (text: string): JobStatus => {
  const status = text.trim().toUpperCase()
  if (!['QUEUED', 'RUNNING', 'FINISHED', 'ERROR', 'FAILURE', 'NOT_FOUND'].includes(status)) {
    throw new Error('EMBL-EBI returned an unrecognized Clustal Omega job status')
  }
  return status as JobStatus
}

const resultStatus = (text: string): JobStatus | undefined => {
  const firstLine = text.trim().split(/\r?\n/, 1)[0]?.trim().toUpperCase()
  if (!firstLine) return undefined
  return ['QUEUED', 'RUNNING', 'FINISHED', 'ERROR', 'FAILURE', 'NOT_FOUND'].includes(firstLine)
    ? (firstLine as JobStatus)
    : undefined
}

const normalizeSequenceInput = (raw: unknown): { sequence: string; count: number } => {
  const sequence = String(raw ?? '')
  if (!sequence.trim()) throw new Error('sequence must contain at least three sequences')
  const bytes = new TextEncoder().encode(sequence).byteLength
  if (bytes > MAX_SUBMISSION_BYTES) {
    throw new Error(`sequence exceeds the ${MAX_SUBMISSION_BYTES}-byte EMBL-EBI input limit`)
  }
  if (
    [...sequence].some((character) => {
      const code = character.charCodeAt(0)
      return (
        (code >= 0 && code <= 8) ||
        code === 11 ||
        code === 12 ||
        (code >= 14 && code <= 31) ||
        code === 127
      )
    })
  ) {
    throw new Error('sequence contains control characters')
  }

  const lines = sequence.split(/\r?\n/)
  while (lines.at(-1) === '') lines.pop()
  const headers = lines.filter((line) => line.startsWith('>'))
  if (!lines[0]?.startsWith('>')) throw new Error('sequence must be formatted FASTA input')
  if (lines.some((line) => line.trim() === '')) {
    throw new Error('sequence must not contain empty lines between FASTA records')
  }
  const names = headers.map((line) => line.slice(1).trim().split(/\s+/)[0] ?? '')
  if (names.some((name) => !name)) throw new Error('every FASTA record must have a name')
  const truncatedNames = names.map((name) => name.slice(0, 30))
  if (new Set(truncatedNames).size !== truncatedNames.length) {
    throw new Error('FASTA sequence names must be unique in their first 30 characters')
  }
  const count = headers.length
  if (count < 3) throw new Error('Clustal Omega requires at least three sequences')
  if (count > MAX_SEQUENCE_COUNT) {
    throw new Error(`sequence contains more than the ${MAX_SEQUENCE_COUNT}-sequence limit`)
  }
  return { sequence, count }
}

const submitClustal = async (ctx: ToolContext, params: URLSearchParams): Promise<string> => {
  ctx.signal?.throwIfAborted()
  try {
    return await withTimeoutSignal(HTTP_TIMEOUT_MS, ctx.signal, async (signal) => {
      const response = await netFetchStandard(`${CLUSTALO_URL}/run`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'text/plain, */*',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'Open-Science/1.0 (+https://github.com/aipoch/open-science)'
        },
        body: params.toString(),
        signal
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        if (response.status >= 400 && response.status < 500) {
          throw new ClustalSubmissionRejectedError(
            `clustalo_submission_rejected: EMBL-EBI rejected the Clustal Omega submission (HTTP ${response.status})`
          )
        }
        throw new Error('EMBL-EBI returned an uncertain submission response')
      }
      return parseJobId(
        await readBoundedText(
          response,
          signal,
          MAX_STATUS_BYTES,
          'EMBL-EBI returned no Clustal Omega job receipt'
        )
      )
    })
  } catch (error) {
    if (ctx.signal?.aborted) throw ctx.signal.reason ?? error
    const message = error instanceof Error ? error.message : 'Clustal Omega submission failed'
    if (error instanceof ClustalSubmissionRejectedError) {
      throw new Error(redactClustalMessage(message, ctx).slice(0, 300))
    }
    throw new Error(
      `clustalo_submission_unknown: the job may have been accepted, but no usable job_id was received. Do not resubmit automatically. ${redactClustalMessage(message, ctx).slice(0, 300)}`
    )
  }
}

const clustalGet = async (ctx: ToolContext, url: string, accept: string): Promise<string> => {
  try {
    return await ctx.fetchText(url, accept, { retry: false })
  } catch (error) {
    if (ctx.signal?.aborted) throw ctx.signal.reason
    const message = error instanceof Error ? error.message : 'EMBL-EBI Clustal Omega request failed'
    throw new Error(redactClustalMessage(message, ctx).slice(0, 1000))
  }
}

const baseInput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sequence: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_SUBMISSION_BYTES,
      description: 'Three or more uniquely named FASTA records.'
    },
    stype: { type: 'string', enum: ['protein', 'dna', 'rna'] },
    outfmt: { type: 'string', enum: OUTPUT_FORMATS },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    dealign: { type: 'boolean' },
    order: { type: 'string', enum: ['aligned', 'input'] }
  },
  required: ['sequence', 'stype']
}

export const GENOMES_CLUSTAL_TOOLS: ToolDescriptor[] = [
  {
    id: 'clustalo_submit',
    connector: 'genomes',
    description:
      'Submit three or more protein, DNA or RNA sequences to EMBL-EBI Job Dispatcher Clustal Omega for asynchronous multiple sequence alignment. Input must be uniquely named FASTA records; the service accepts at most 4000 sequences or 4 MiB. Returns a job_id; keep it and call clustalo_status before clustalo_results. The connector requests clustal_num by default, a Clustal alignment with position numbers, suitable for inspecting conserved sites and downstream evolutionary analysis. EMBL-EBI requests a valid contact email. ' +
      CONTACT_EMAIL_GUIDANCE +
      ' A lost submit response may represent an accepted remote job; do not resubmit automatically. ' +
      LIFECYCLE_GUIDANCE +
      ' See https://www.ebi.ac.uk/jdispatcher/docs/webservices/ for the official API contract.',
    input: baseInput,
    required: ['sequence', 'stype'],
    returns:
      '{job_id, status:"QUEUED", ready:false, sequence_count, sequence_type, requested_format, poll_after_seconds}. Retain job_id to resume after restart; submission is not completion.',
    example:
      'const result = await host.mcp("genomes", "clustalo_submit", {"sequence": ">human\\nMKT\\n>mouse\\nMRT\\n>rat\\nMRT\\n", "stype": "protein"})',
    totalTimeoutMs: HTTP_TIMEOUT_MS + 5_000,
    maxResponseBytes: MAX_STATUS_BYTES,
    run: async (ctx, args) => {
      const stype = String(args.stype) as SequenceType
      if (!['protein', 'dna', 'rna'].includes(stype)) {
        throw new Error('stype must be protein, dna, or rna')
      }
      const input = normalizeSequenceInput(args.sequence)
      const format = (args.outfmt ?? 'clustal_num') as OutputFormat
      if (!OUTPUT_FORMATS.includes(format))
        throw new Error('outfmt is not a supported alignment format')
      const params = new URLSearchParams({
        email: contactEmail(ctx),
        stype,
        sequence: input.sequence,
        outfmt: format,
        dealign: String(args.dealign ?? false),
        order: String(args.order ?? 'aligned')
      })
      if (args.title !== undefined) params.set('title', String(args.title))
      const jobId = await submitClustal(ctx, params)
      return {
        job_id: jobId,
        status: 'QUEUED' as const,
        ready: false,
        sequence_count: input.count,
        sequence_type: stype,
        requested_format: format,
        poll_after_seconds: MIN_POLL_SECONDS
      }
    }
  },
  {
    id: 'clustalo_status',
    connector: 'genomes',
    description:
      'Check one EMBL-EBI Clustal Omega job once. This is a single status request and never polls or waits; call it again after at least 10 seconds until FINISHED, ERROR, FAILURE or NOT_FOUND. Keep the job_id when resuming after a restart.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: { job_id: { type: 'string', minLength: 1, maxLength: 128 } },
      required: ['job_id']
    },
    required: ['job_id'],
    returns: '{job_id,status,ready,retry_after_seconds?}',
    example:
      'const result = await host.mcp("genomes", "clustalo_status", {"job_id":"clustalo-I20240923-000000-0000-0000000-p1m"})',
    totalTimeoutMs: HTTP_TIMEOUT_MS,
    maxResponseBytes: MAX_STATUS_BYTES,
    run: async (ctx, args) => {
      const jobId = jobIdOf(args.job_id)
      const status = parseStatus(
        await clustalGet(ctx, `${CLUSTALO_URL}/status/${encodeURIComponent(jobId)}`, 'text/plain')
      )
      return {
        job_id: jobId,
        status,
        ready: status === 'FINISHED',
        ...(status === 'QUEUED' || status === 'RUNNING'
          ? { retry_after_seconds: MIN_POLL_SECONDS }
          : {})
      }
    }
  },
  {
    id: 'clustalo_results',
    connector: 'genomes',
    description:
      'Fetch one bounded Clustal Omega clustal_num alignment file for a FINISHED job. Pass the same outfmt returned by clustalo_submit; this tool makes one result request and returns the alignment content plus a filename suggestion. If the provider still reports QUEUED or RUNNING, it returns ready:false with a retry hint; provider failures are errors and retain the job_id for diagnosis. Results are capped at 8 MiB and are returned verbatim so the caller can save the content as an alignment file for conserved-site inspection or downstream phylogenetic analysis. No automatic retries. ' +
      LIFECYCLE_GUIDANCE,
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        job_id: { type: 'string', minLength: 1, maxLength: 128 },
        outfmt: {
          type: 'string',
          enum: OUTPUT_FORMATS,
          description: 'Must match the requested_format returned by clustalo_submit.'
        }
      },
      required: ['job_id', 'outfmt']
    },
    required: ['job_id', 'outfmt'],
    returns:
      '{job_id,status,ready,format,filename?,size_bytes?,alignment?,retry_after_seconds?} — alignment is the verbatim output file content when ready:true.',
    example:
      'const result = await host.mcp("genomes", "clustalo_results", {"job_id":"clustalo-I20240923-000000-0000-0000000-p1m", "outfmt":"clustal_num"})',
    totalTimeoutMs: HTTP_TIMEOUT_MS,
    maxResponseBytes: MAX_RESULT_BYTES,
    run: async (ctx, args) => {
      const jobId = jobIdOf(args.job_id)
      const format = String(args.outfmt) as OutputFormat
      if (!OUTPUT_FORMATS.includes(format))
        throw new Error('outfmt is not a supported alignment format')
      const alignment = await clustalGet(
        ctx,
        `${CLUSTALO_URL}/result/${encodeURIComponent(jobId)}/${resultType(format)}`,
        'text/plain, text/x-clustalw-alignment, application/octet-stream, */*'
      )
      if (!alignment.trim()) throw new Error('EMBL-EBI returned an empty Clustal Omega alignment')
      const upstreamStatus = resultStatus(alignment)
      if (upstreamStatus === 'QUEUED' || upstreamStatus === 'RUNNING') {
        return {
          job_id: jobId,
          status: upstreamStatus,
          ready: false,
          format,
          retry_after_seconds: MIN_POLL_SECONDS
        }
      }
      if (upstreamStatus) {
        throw new Error(
          `EMBL-EBI returned Clustal Omega job status ${upstreamStatus}; keep the job_id`
        )
      }
      if (
        /^\s*<(?:html|!doctype)\b/i.test(alignment) ||
        /^\s*(?:error|failure|job not found|raw tool output|tool error details)\b/i.test(
          alignment
        ) ||
        !/^\s*CLUSTAL(?:\s|$)/i.test(alignment)
      ) {
        throw new Error(
          'EMBL-EBI returned an invalid or error response instead of a Clustal alignment file'
        )
      }
      const sizeBytes = new TextEncoder().encode(alignment).byteLength
      return {
        job_id: jobId,
        status: 'FINISHED' as const,
        ready: true,
        format,
        filename: `clustalo-${jobId}.${resultSuffix(format)}`,
        size_bytes: sizeBytes,
        alignment
      }
    }
  }
]
