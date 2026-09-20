import type { ToolContext, ToolDescriptor } from '../types'

const FILE_REPORT = 'https://www.ebi.ac.uk/ena/portal/api/filereport'
const RUN_ACCESSION = /^[SED]RR\d+$/
const REPORT_ACCESSION = /^(?:[SED]R[PSXR]\d+|PRJ[END][AB]\d+|SAM[END][AG]?\d+)$/
const RUN_FIELDS = [
  'run_accession',
  'study_accession',
  'secondary_study_accession',
  'sample_accession',
  'experiment_accession',
  'tax_id',
  'scientific_name',
  'instrument_platform',
  'instrument_model',
  'library_layout',
  'library_strategy',
  'library_source'
] as const
const FILE_FIELDS = ['fastq_ftp', 'fastq_bytes', 'fastq_md5'] as const

type Row = Record<string, unknown>

function invalidReport(detail: string): never {
  throw new Error(`Invalid ENA file report: ${detail}`)
}

function accession(value: unknown, runOnly = false): string {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : ''
  if (!(runOnly ? RUN_ACCESSION : REPORT_ACCESSION).test(normalized)) {
    throw new Error(
      runOnly
        ? 'run_accession must be an ERR, SRR or DRR accession'
        : 'accession must be an ENA/INSDC study, experiment, sample or run accession; resolve GEO/ArrayExpress/MGnify identifiers to an INSDC accession first'
    )
  }
  return normalized
}

function nullableText(row: Row, field: string): string | null {
  const value = row[field]
  if (value == null) return null
  if (typeof value !== 'string') invalidReport(`${field} must be a string`)
  return value.trim() || null
}

async function report(
  ctx: ToolContext,
  queryAccession: string,
  fields: readonly string[],
  limit: number
): Promise<Row[]> {
  const params = new URLSearchParams({
    accession: queryAccession,
    result: 'read_run',
    format: 'json',
    fields: fields.join(','),
    limit: String(limit)
  })
  const raw = await ctx.fetchJson(`${FILE_REPORT}?${params}`)
  if (!Array.isArray(raw)) invalidReport('expected an array of run records')
  if (raw.length > limit) invalidReport('response exceeds the requested run limit')
  const seen = new Set<string>()
  return raw.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      invalidReport('expected a run record')
    }
    const row = value as Row
    const run = nullableText(row, 'run_accession')
    if (!run || !RUN_ACCESSION.test(run)) invalidReport('missing or invalid run_accession')
    if (RUN_ACCESSION.test(queryAccession) && run !== queryAccession) {
      invalidReport('returned run does not match the requested accession')
    }
    if (seen.has(run)) invalidReport(`duplicate run_accession ${run}`)
    seen.add(run)
    return row
  })
}

// Preserve empty positions. Independently filtering these lists would misassign checksums/files.
function fileValues(row: Row, field: string): string[] {
  if (!(field in row)) invalidReport(`missing ${field}`)
  const value = nullableText(row, field)
  return value === null ? [] : value.split(';').map((part) => part.trim())
}

function alignedValues(row: Row, field: string, count: number): string[] {
  const values = fileValues(row, field)
  if (!values.length) return Array<string>(count).fill('')
  if (values.length !== count) invalidReport(`${field} count does not match fastq_ftp`)
  return values
}

function downloadUrl(value: string): string {
  // ENA reports scheme-less FTP paths. Do not guess directories or substitute HTTPS mirrors.
  const qualified = value.startsWith('ftp.sra.ebi.ac.uk/') ? `ftp://${value}` : value
  let url: URL
  try {
    url = new URL(qualified)
  } catch {
    return invalidReport('invalid FASTQ URL')
  }
  if (
    !['ftp:', 'http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  ) {
    invalidReport('invalid FASTQ URL')
  }
  return qualified
}

function fileSize(value: string): number | null {
  if (!value) return null
  const size = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(size)) {
    invalidReport('fastq_bytes must contain safe nonnegative integers')
  }
  return size
}

function checksum(value: string): string | null {
  if (!value) return null
  if (!/^[a-f\d]{32}$/i.test(value)) invalidReport('invalid fastq_md5')
  return value.toLowerCase()
}

export const ENA_OMICS_TOOLS: ToolDescriptor[] = [
  {
    id: 'ena_search_runs',
    connector: 'omics-archives',
    description:
      'Find public sequencing runs associated with one ENA/INSDC study, experiment, sample or run accession. Accepts PRJ/ERP/SRP/DRP, ERX/SRX/DRX, SAM/ERS/SRS/DRS and ERR/SRR/DRR identifiers; GEO GSE/GSM, ArrayExpress E-MTAB and MGnify MGYS identifiers need their linked INSDC accession first. Accession lookup only, not keyword search. Returns organism and library metadata without fetching data files. The result is capped at 1000 runs; a truncated result is not a complete cohort, and repeated calls are not pagination because ENA provides no offset or continuation token. Use a narrower sample or experiment accession when complete coverage is required.',
    input: {
      type: 'object',
      properties: {
        accession: { type: 'string', minLength: 1, maxLength: 64 },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 }
      },
      required: ['accession'],
      additionalProperties: false
    },
    required: ['accession'],
    returns:
      '{ accession, n_runs_returned, truncated, runs: [{ run_accession, study_accession, secondary_study_accession, sample_accession, experiment_accession, tax_id, scientific_name, instrument_platform, instrument_model, library_layout, library_strategy, library_source }] }. Metadata values are strings or null, including tax_id. Requests limit+1 rows to detect truncation; n_runs_returned is not a total. ENA selects the subset in unspecified order; returned rows are sorted by run_accession. No public matches yields runs:[]; this does not distinguish an unknown/private accession from a study without public runs. No offset or next-page token. Pass run_accession to ena_get_run_files.',
    example:
      'const result = await host.mcp("omics-archives", "ena_search_runs", {"accession": "PRJNA123835", "limit": 100})',
    run: async (ctx, args) => {
      const queryAccession = accession(args.accession)
      const limit = args.limit ?? 100
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error('limit must be an integer from 1 to 1000')
      }
      const rows = await report(ctx, queryAccession, RUN_FIELDS, limit + 1)
      const runs = rows
        .slice(0, limit)
        .map((row) =>
          Object.fromEntries(RUN_FIELDS.map((field) => [field, nullableText(row, field)]))
        )
      runs.sort((a, b) => a.run_accession!.localeCompare(b.run_accession!))
      return {
        accession: queryAccession,
        n_runs_returned: runs.length,
        truncated: rows.length > limit,
        runs
      }
    }
  },
  {
    id: 'ena_get_run_files',
    connector: 'omics-archives',
    description:
      'Get archive-generated FASTQ download URLs, byte sizes and upstream MD5 checksums for one ERR/SRR/DRR run. Returns a file inventory only; no download or checksum verification. Retains every file in report order, including unpaired or long-read files; library_layout=PAIRED does not imply exactly two files. file_index is positional only and is not an R1/R2 or mate identifier. Some runs (including some single-cell/native-format submissions) have no archive-generated FASTQ. Submitted BAM/CRAM/SRA files are outside this tool.',
    input: {
      type: 'object',
      properties: { run_accession: { type: 'string', minLength: 1, maxLength: 64 } },
      required: ['run_accession'],
      additionalProperties: false
    },
    required: ['run_accession'],
    returns:
      '{ run_accession, found, library_layout:string|null, fastq_available, n_files, fastq_files:[{ file_index, url, size_bytes:number|null, md5:string|null }] }. found means a public run report was returned; found:true with fastq_available:false is a run without listed archive-generated FASTQ, not a missing run. file_index is 1-based report order, not read/mate identity. URLs, sizes and MD5s are paired by position; unknown sizes/checksums are null, inconsistent lists fail. Scheme-less ENA FTP paths receive ftp://; sizes/checksums describe the downloadable files (typically .fastq.gz), not decompressed content. Reports come from ENA cache and may lag updates; no local result cache is added.',
    example:
      'const result = await host.mcp("omics-archives", "ena_get_run_files", {"run_accession": "SRR037073"})',
    run: async (ctx, args) => {
      const runAccession = accession(args.run_accession, true)
      const rows = await report(
        ctx,
        runAccession,
        ['run_accession', 'library_layout', ...FILE_FIELDS],
        2
      )
      if (rows.length > 1) invalidReport('expected at most one run')
      const row = rows[0]
      const urls = row ? fileValues(row, 'fastq_ftp') : []
      const sizes = row ? alignedValues(row, 'fastq_bytes', urls.length) : []
      const md5s = row ? alignedValues(row, 'fastq_md5', urls.length) : []
      const files = urls.map((url, i) => ({
        file_index: i + 1,
        url: downloadUrl(url),
        size_bytes: fileSize(sizes[i]),
        md5: checksum(md5s[i])
      }))
      return {
        run_accession: runAccession,
        found: Boolean(row),
        library_layout: row ? nullableText(row, 'library_layout') : null,
        fastq_available: files.length > 0,
        n_files: files.length,
        fastq_files: files
      }
    }
  }
]
