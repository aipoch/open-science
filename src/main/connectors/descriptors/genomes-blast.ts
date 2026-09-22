import type { ToolContext, ToolDescriptor } from '../types'
import { netFetchStandard } from '../../skills/net-fetch'
import { withTimeoutSignal } from '../request-policy'
import { redactSensitiveText } from '../../diagnostic-redaction'

const BLAST_URL = 'https://blast.ncbi.nlm.nih.gov/Blast.cgi'
const TOOL_NAME = 'open_science'
const HTTP_TIMEOUT_MS = 30_000
const MAX_SEQUENCE_CHARS = 100_000
const MAX_STATUS_BYTES = 256 * 1024
const MAX_RESULT_BYTES = 2 * 1024 * 1024
const MIN_POLL_SECONDS = 60

const NUCLEOTIDE_DATABASES = new Set(['nt', 'core_nt', 'refseq_rna'])
const PROTEIN_DATABASES = new Set(['nr', 'refseq_protein', 'swissprot'])

type MoleculeType = 'nucleotide' | 'protein'
type BlastStatus = 'WAITING' | 'READY' | 'FAILED' | 'UNKNOWN'
type BlastFormat = 'json2' | 'xml2' | 'text' | 'tabular'

const contactParams = (params: URLSearchParams, credentials: ToolContext['credentials']): void => {
  params.set('tool', TOOL_NAME)
  if (credentials.ncbiEmail) params.set('email', credentials.ncbiEmail)
  // BLAST does not document support for the E-utilities API key. Never forward it.
}

const ridOf = (raw: unknown): string => {
  const rid = String(raw ?? '').trim()
  if (!/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/.test(rid) || rid.length > 128) {
    throw new Error('RID must be a non-empty NCBI BLAST request identifier')
  }
  return rid
}

// Lifecycle owner: this descriptor owns submission and returns the exact provider RID to the caller.
// The caller must retain that receipt to resume status/results; this module has no job registry,
// result cache, background worker, crash recovery, or automatic resubmission. Existing conversation/
// notebook persistence may retain tool inputs and outputs; "no cache" does not mean no local copy.
// NCBI generally retains RID results for 36 hours (not a deletion guarantee or an app-owned TTL):
// https://www.ncbi.nlm.nih.gov/books/NBK569839/
// The documented Common URL API exposes Put/Get, not a supported cancel/delete operation:
// https://blast.ncbi.nlm.nih.gov/doc/blast-help/urlapi.html
// Abort, shutdown and uninstall stop local activity only. They cannot stop or delete the provider
// job. A lost receipt cannot be recovered by scanning NCBI; never retry submission automatically.
// This provider-controlled expiry is a lifecycle limitation, not full durable-component cleanup.
const LIFECYCLE_GUIDANCE =
  'Keep the RID to resume after restart. NCBI generally retains results for 36 hours; this is not a deletion guarantee. ' +
  'Cancellation, app exit and uninstall stop local requests only; this API has no documented remote cancel/delete operation. ' +
  'No job registry or result cache is added; normal conversation/notebook persistence may retain inputs and outputs.'

class BlastSubmissionUnknownError extends Error {
  override readonly name = 'BlastSubmissionUnknownError'
  readonly code = 'blast_submission_unknown'

  constructor() {
    super(
      'blast_submission_unknown: NCBI may have accepted the job, but no valid RID was received. ' +
        'Do not automatically resubmit. No RID is available to resume or cancel this submission. ' +
        'A new submission requires an explicit decision to accept a possible duplicate job.'
    )
  }
}

// POST replies may echo the query and credentials in HTML. Never include an untrusted reply or
// transport error in a submission error. An unreadable/missing receipt is conservatively uncertain.
async function readSubmission(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new BlastSubmissionUnknownError()
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
      if (bytes > MAX_STATUS_BYTES) {
        void reader.cancel().catch(() => {})
        throw new BlastSubmissionUnknownError()
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

async function submitBlast(
  ctx: ToolContext,
  body: URLSearchParams
): Promise<{
  rid: string
  rtoeSeconds: number | null
}> {
  ctx.signal?.throwIfAborted() // Not dispatched: preserve ordinary cancellation.
  try {
    return await withTimeoutSignal(HTTP_TIMEOUT_MS, ctx.signal, async (signal) => {
      const response = await netFetchStandard(BLAST_URL, {
        method: 'POST',
        redirect: 'error', // Never replay a submission through an HTTP redirect.
        headers: {
          accept: 'text/plain, */*',
          'user-agent': 'Open-Science/1.0 (+https://github.com/aipoch/open-science)',
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: body.toString(),
        signal
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw new BlastSubmissionUnknownError()
      }
      return parseSubmission(await readSubmission(response, signal))
    })
  } catch (error) {
    // Preserve ordinary caller cancellation. A timeout or transport failure from the
    // descriptor-owned signal remains uncertain because NCBI may already have accepted Put.
    if (ctx.signal?.aborted) throw ctx.signal.reason ?? error
    // Includes timeouts, partial bodies, redirects, and invalid receipts. None proves non-creation.
    throw new BlastSubmissionUnknownError()
  }
}

async function getBlast(ctx: ToolContext, params: URLSearchParams): Promise<string> {
  contactParams(params, ctx.credentials)
  try {
    // Use the engine's byte cap, deadlines and cancellation, but no rapid automatic polling retry.
    return await ctx.fetchText(`${BLAST_URL}?${params}`, undefined, { retry: false })
  } catch (error) {
    if (ctx.signal?.aborted) throw ctx.signal.reason
    let message = error instanceof Error ? error.message : 'NCBI BLAST GET failed'
    // Engine HTTP errors already redact the URL. Injected/network errors can still contain it.
    for (const secret of [ctx.credentials.ncbiEmail, ctx.credentials.ncbiApiKey]) {
      if (!secret) continue
      for (const value of [
        secret,
        encodeURIComponent(secret),
        encodeURIComponent(secret).replace(/%20/g, '+')
      ]) {
        message = message.replaceAll(value, '[redacted]')
      }
    }
    throw new Error(
      `${redactSensitiveText(message).slice(0, 1000)}. Wait at least 60 seconds before retrying this RID; do not resubmit the sequence.`
    )
  }
}

function normalizeSequence(
  raw: unknown,
  moleculeType: MoleculeType
): {
  query: string
  length: number
} {
  const source = String(raw ?? '').trim()
  if (!source) throw new Error('sequence must be a non-empty nucleotide or protein sequence')
  if (source.length > MAX_SEQUENCE_CHARS)
    throw new Error(`sequence exceeds the ${MAX_SEQUENCE_CHARS}-character limit`)

  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const fasta = lines.some((line) => line.startsWith('>'))
  if (
    fasta &&
    (lines[0]?.startsWith('>') !== true || lines.slice(1).some((line) => line.startsWith('>')))
  ) {
    throw new Error('sequence may contain at most one FASTA header')
  }
  const sequence = (fasta ? lines.slice(1).join('') : lines.join(''))
    .replace(/\s+/g, '')
    .toUpperCase()
  if (!sequence) throw new Error('sequence must contain residues after removing whitespace')
  const pattern = moleculeType === 'nucleotide' ? /^[ACGTURYSWKMBDHVN.-]+$/ : /^[A-Z*.-]+$/
  if (!pattern.test(sequence)) {
    throw new Error(
      moleculeType === 'nucleotide'
        ? 'nucleotide sequence contains characters outside IUPAC bases and gaps'
        : 'protein sequence contains characters outside amino-acid symbols and gaps'
    )
  }
  const header = fasta ? lines[0] : undefined
  return { query: header ? `${header}\n${sequence}` : sequence, length: sequence.length }
}

function parseSubmission(text: string): { rid: string; rtoeSeconds: number | null } {
  const rid = /(?:^|\n)\s*RID\s*=\s*([^\s<]+)/i.exec(text)?.[1]
  if (!rid) {
    throw new BlastSubmissionUnknownError()
  }
  const rtoeText = /(?:^|\n)\s*RTOE\s*=\s*(\d+)/i.exec(text)?.[1]
  return { rid: ridOf(rid), rtoeSeconds: rtoeText ? Number(rtoeText) : null }
}

function responseStatus(text: string): BlastStatus | undefined {
  // Read protocol metadata, never arbitrary status-looking text in a report body.
  const block =
    /<!--\s*QBlastInfoBegin\s*([\s\S]*?)\s*QBlastInfoEnd\s*-->/i.exec(text)?.[1] ??
    /^\s*QBlastInfoBegin\s*([\s\S]*?)\s*QBlastInfoEnd\s*$/i.exec(text)?.[1]
  const status =
    block !== undefined
      ? /^\s*Status[ \t]*=[ \t]*(WAITING|READY|FAILED|UNKNOWN)[ \t]*$/im.exec(block)?.[1]
      : /^\s*(?:<!--\s*)?Status[ \t]*=[ \t]*(WAITING|READY|FAILED|UNKNOWN)\s*(?:-->)?\s*$/i.exec(
          text
        )?.[1]
  return status?.toUpperCase() as BlastStatus | undefined
}

function parseStatus(text: string): BlastStatus {
  const status = responseStatus(text)
  if (status) return status
  throw new Error(
    'NCBI BLAST returned no recognizable status; the reply was omitted to avoid echoing request data.'
  )
}

function formatParams(format: BlastFormat): { formatType: string; alignmentView?: string } {
  // The *_S variants are the single-file forms. Plain JSON2/XML2 are ZIP archives for alignment
  // responses, which cannot be returned as the bounded text payload this connector promises.
  if (format === 'json2') return { formatType: 'JSON2_S' }
  if (format === 'xml2') return { formatType: 'XML2_S' }
  if (format === 'tabular') return { formatType: 'Text', alignmentView: 'Tabular' }
  return { formatType: 'Text' }
}

const databaseSchema = {
  type: 'string',
  enum: ['nt', 'core_nt', 'refseq_rna', 'nr', 'refseq_protein', 'swissprot'],
  description:
    'Requested database, not a guarantee of the effective search database. NCBI may automatically switch nt to core_nt; inspect the completed report for the database actually searched.'
}

export const GENOMES_BLAST_TOOLS: ToolDescriptor[] = [
  {
    id: 'blast_submit',
    connector: 'genomes',
    description:
      'Submit one nucleotide or protein sequence to the public NCBI BLAST service for asynchronous similarity search. Set molecule_type explicitly because a protein made only of A/C/G/T is otherwise ambiguous. Returns a RID and the server estimate; call blast_status no more often than once per minute, then blast_results after READY. The sequence is sent to NCBI and is not cached locally; a lost submit response raises blast_submission_unknown and must not be retried automatically. Space all BLAST requests by at least 10 seconds and all requests for the same RID by at least 60 seconds. ' +
      LIFECYCLE_GUIDANCE,
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sequence: { type: 'string', minLength: 1, maxLength: MAX_SEQUENCE_CHARS },
        molecule_type: { type: 'string', enum: ['nucleotide', 'protein'] },
        database: databaseSchema,
        evalue: { type: 'number', exclusiveMinimum: 0, maximum: 1000 },
        hitlist_size: { type: 'integer', minimum: 1, maximum: 100 },
        megablast: { type: 'boolean' }
      },
      required: ['sequence', 'molecule_type']
    },
    required: ['sequence', 'molecule_type'],
    returns:
      '{rid, rtoe_seconds, poll_after_seconds, program, requested_database, molecule_type, sequence_length} — requested_database is the submitted value; NCBI may switch nt to core_nt. The completed report identifies the actual database. Keep rid and wait at least 60 seconds before checking status. Throws blast_submission_unknown if dispatch may have succeeded without a usable receipt.',
    example:
      'const result = await host.mcp("genomes", "blast_submit", {"sequence": "ATGCGTACGTAGCTAG", "molecule_type": "nucleotide", "database": "nt"})',
    // Leave headroom for the POST-specific timeout to surface its uncertainty diagnosis.
    totalTimeoutMs: HTTP_TIMEOUT_MS + 5_000,
    maxResponseBytes: MAX_STATUS_BYTES,
    run: async (ctx, a) => {
      const moleculeType = String(a.molecule_type) as MoleculeType
      if (moleculeType !== 'nucleotide' && moleculeType !== 'protein')
        throw new Error('molecule_type must be nucleotide or protein')
      const { query, length } = normalizeSequence(a.sequence, moleculeType)
      const defaultDatabase = moleculeType === 'nucleotide' ? 'nt' : 'nr'
      const database = String(a.database ?? defaultDatabase)
      const compatible = moleculeType === 'nucleotide' ? NUCLEOTIDE_DATABASES : PROTEIN_DATABASES
      if (!compatible.has(database)) {
        throw new Error(
          `database ${JSON.stringify(database)} is incompatible with ${moleculeType} BLAST`
        )
      }
      const params = new URLSearchParams({
        CMD: 'Put',
        PROGRAM: moleculeType === 'nucleotide' ? 'blastn' : 'blastp',
        DATABASE: database,
        QUERY: query,
        EXPECT: String(a.evalue ?? 10),
        HITLIST_SIZE: String(a.hitlist_size ?? 25)
      })
      if (moleculeType === 'nucleotide' && a.megablast === true) params.set('MEGABLAST', 'on')
      contactParams(params, ctx.credentials)
      const submission = await submitBlast(ctx, params)
      const rtoeSeconds = submission.rtoeSeconds
      return {
        rid: submission.rid,
        rtoe_seconds: rtoeSeconds,
        poll_after_seconds: Math.max(MIN_POLL_SECONDS, rtoeSeconds ?? MIN_POLL_SECONDS),
        program: moleculeType === 'nucleotide' ? 'blastn' : 'blastp',
        requested_database: database,
        molecule_type: moleculeType,
        sequence_length: length
      }
    }
  },
  {
    id: 'blast_status',
    connector: 'genomes',
    description:
      'Check one NCBI BLAST RID once. This is a single SearchInfo request and never polls or waits; respect NCBI guidance to wait at least 60 seconds between checks. Returns WAITING, READY, FAILED, or UNKNOWN (unknown or expired RID). Space all BLAST requests by at least 10 seconds and same-RID requests, including results retrieval, by at least 60 seconds.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: { rid: { type: 'string', minLength: 1, maxLength: 128 } },
      required: ['rid']
    },
    required: ['rid'],
    returns: '{rid, status, ready, retry_after_seconds?}',
    example: 'const result = await host.mcp("genomes", "blast_status", {"rid": "AYEFB4DT014"})',
    totalTimeoutMs: HTTP_TIMEOUT_MS,
    maxResponseBytes: MAX_STATUS_BYTES,
    run: async (ctx, a) => {
      const rid = ridOf(a.rid)
      const params = new URLSearchParams({ CMD: 'Get', RID: rid, FORMAT_OBJECT: 'SearchInfo' })
      const text = await getBlast(ctx, params)
      const status = parseStatus(text)
      return {
        rid,
        status,
        ready: status === 'READY',
        ...(status === 'WAITING' ? { retry_after_seconds: MIN_POLL_SECONDS } : {})
      }
    }
  },
  {
    id: 'blast_results',
    connector: 'genomes',
    description:
      'Fetch bounded results for an NCBI BLAST RID. It makes one request and returns ready=false when the job is still waiting; choose json2, xml2, text, or tabular output after blast_status reports READY. Results are capped at 2 MiB and returned verbatim. tabular means NCBI Text + ALIGNMENT_VIEW=Tabular, which may include HTML comments, PRE tags and report headers; it is not pure TSV or CSV. Wait at least 60 seconds after the last request for this RID, including blast_status. No automatic retries.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rid: { type: 'string', minLength: 1, maxLength: 128 },
        format: { type: 'string', enum: ['json2', 'xml2', 'text', 'tabular'] }
      },
      required: ['rid']
    },
    required: ['rid'],
    returns:
      '{rid, status, ready, format, results?} — results is a bounded verbatim string; tabular is an NCBI text report, not pure TSV/CSV.',
    example:
      'const result = await host.mcp("genomes", "blast_results", {"rid": "AYEFB4DT014", "format": "json2"})',
    totalTimeoutMs: HTTP_TIMEOUT_MS,
    maxResponseBytes: MAX_RESULT_BYTES,
    run: async (ctx, a) => {
      const rid = ridOf(a.rid)
      const format = (a.format ?? 'json2') as BlastFormat
      if (!['json2', 'xml2', 'text', 'tabular'].includes(format))
        throw new Error('format must be json2, xml2, text, or tabular')
      const selected = formatParams(format)
      const params = new URLSearchParams({
        CMD: 'Get',
        RID: rid,
        FORMAT_TYPE: selected.formatType,
        FORMAT_OBJECT: 'Alignment'
      })
      if (selected.alignmentView) params.set('ALIGNMENT_VIEW', selected.alignmentView)
      const text = await getBlast(ctx, params)
      // A successful HTTP response is not evidence of a completed report: NCBI can return HTML
      // error pages. Validate the envelope without projecting or rewriting biological results.
      let validReport = false
      if (format === 'json2') {
        try {
          const parsed = JSON.parse(text)
          validReport =
            Array.isArray(parsed?.BlastOutput2) &&
            parsed.BlastOutput2.length > 0 &&
            parsed.BlastOutput2.every(
              (item: { report?: unknown }) => item?.report && typeof item.report === 'object'
            )
        } catch {
          /* Invalid JSON must not be reported as READY. */
        }
      } else if (format === 'xml2') {
        validReport = /<BlastXML2(?:\s|>)/.test(text) && /<\/BlastXML2>\s*$/.test(text)
      } else if (format === 'tabular') {
        // NCBI's real tabular reports use a program-only header such as `# blastp`.
        // Require the READY protocol envelope, the tabular field declaration, and either
        // a hit-count declaration (including zero hits) or at least one tab-delimited row.
        const hasProgramHeader =
          /(?:^|<PRE>[ \t]*)#[ \t]*(?:blastn|blastp|blastx|tblastn|tblastx)[ \t]*$/im.test(text)
        const hasFields = /^[ \t]*#[ \t]*Fields:[ \t]*\S.+$/im.test(text)
        const hasHitCount = /^[ \t]*#[ \t]*\d+[ \t]+hits?[ \t]+found[ \t]*$/im.test(text)
        const hasTabularRow = /^(?![ \t]*#)(?:[^\r\n]*\t){1,}[^\r\n]*$/m.test(text)
        validReport =
          responseStatus(text) === 'READY' &&
          hasProgramHeader &&
          hasFields &&
          (hasHitCount || hasTabularRow)
      } else {
        validReport =
          /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<PRE>\s*)?(?:#\s*)?BLAST[NPX]?\s+\d+\.\d+/i.test(text) ||
          (responseStatus(text) === 'READY' &&
            /<PRE>\s*(?:#\s*)?BLAST[NPX]?\s+\d+\.\d+/i.test(text))
      }
      if (!validReport) {
        const status = responseStatus(text)
        if (status && status !== 'READY') {
          return {
            rid,
            status,
            ready: false,
            format,
            ...(status === 'WAITING' ? { retry_after_seconds: MIN_POLL_SECONDS } : {})
          }
        }
        throw new Error(
          'NCBI BLAST returned an invalid result report; reply omitted. Keep the RID; do not resubmit the sequence.'
        )
      }
      return { rid, status: 'READY' as const, ready: true, format, results: text }
    }
  }
]
