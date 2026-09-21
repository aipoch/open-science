import type { ToolContext, ToolDescriptor } from '../types'

const FILE_REPORT = 'https://www.ebi.ac.uk/ena/portal/api/filereport'
const SEARCH = 'https://www.ebi.ac.uk/ena/portal/api/search'
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
const TITLE_FIELDS = ['study_title', 'experiment_title', 'sample_title', 'description'] as const
const LIBRARY_STRATEGIES = [
  'AMPLICON',
  'ATAC-seq',
  'Bisulfite-Seq',
  'CLONE',
  'CLONEEND',
  'CTS',
  'ChIA-PET',
  'ChIP-Seq',
  'ChM-Seq',
  'DNase-Hypersensitivity',
  'EST',
  'FAIRE-seq',
  'FINISHING',
  'FL-cDNA',
  'GBS',
  'Hi-C',
  'MBD-Seq',
  'MNase-Seq',
  'MRE-Seq',
  'MeDIP-Seq',
  'NOMe-Seq',
  'OTHER',
  'POOLCLONE',
  'RAD-Seq',
  'RIP-Seq',
  'RNA-Seq',
  'Ribo-Seq',
  'SELEX',
  'Synthetic-Long-Read',
  'Targeted-Capture',
  'Tethered Chromatin Conformation Capture',
  'Tn-Seq',
  'VALIDATION',
  'WCS',
  'WGA',
  'WGS',
  'WXS',
  'miRNA-Seq',
  'ncRNA-Seq',
  'snRNA-seq',
  'ssRNA-seq'
] as const
// Do not interpret caller text as ENA query syntax or a wildcard expression.
const KEYWORD_PATTERN = '^(?=[\\s\\S]*\\S)[^"\\\\*?\\u0000-\\u001f\\u007f]+$'

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
  return runRows(raw, limit, queryAccession)
}

function runRows(raw: unknown, limit: number, queryAccession?: string): Row[] {
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
    if (queryAccession && RUN_ACCESSION.test(queryAccession) && run !== queryAccession) {
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

function alignedValues(row: Row, field: string, count: number, locations = 'fastq_ftp'): string[] {
  const values = fileValues(row, field)
  if (!values.length) return Array<string>(count).fill('')
  if (values.length !== count) invalidReport(`${field} count does not match ${locations}`)
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

function fileSize(value: string, field = 'fastq_bytes'): number | null {
  if (!value) return null
  const size = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(size)) {
    invalidReport(`${field} must contain safe nonnegative integers`)
  }
  return size
}

function checksum(value: string, field = 'fastq_md5'): string | null {
  if (!value) return null
  if (!/^[a-f\d]{32}$/i.test(value)) invalidReport(`invalid ${field}`)
  return value.toLowerCase()
}

export const ENA_OMICS_TOOLS: ToolDescriptor[] = [
  {
    id: 'ena_query_runs',
    connector: 'omics-archives',
    description:
      'Discover public sequencing runs by NCBI tax_id (including descendant taxa), library_strategy and/or a keyword in study, experiment or sample titles and run descriptions. Supplied filters are combined with AND; at least one is required. Taxonomy describes the sequenced organism, not the host of a microbiome sample. Keyword is a literal substring, not ENA query syntax; double quotes, backslashes, wildcards and control characters are rejected. Includes public metagenome records. Returns bounded metadata only, not a complete cohort when truncated. Narrow filters to retrieve a smaller set; repeated calls are not pagination. For known INSDC accessions use ena_search_runs.',
    input: {
      type: 'object',
      properties: {
        tax_id: { type: 'integer', minimum: 1, maximum: 2147483647 },
        library_strategy: { type: 'string', enum: [...LIBRARY_STRATEGIES] },
        keyword: { type: 'string', minLength: 1, maxLength: 200, pattern: KEYWORD_PATTERN },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 }
      },
      anyOf: ['tax_id', 'library_strategy', 'keyword'].map((field) => ({
        properties: { [field]: {} },
        required: [field]
      })),
      additionalProperties: false
    },
    returns:
      '{ filters:{tax_id:number|null, library_strategy:string|null, keyword:string|null}, query, n_runs_returned, truncated, runs:[{run_accession, study_accession, secondary_study_accession, sample_accession, experiment_accession, tax_id, scientific_name, instrument_platform, instrument_model, library_layout, library_strategy, library_source, study_title, experiment_title, sample_title, description}] }. Run metadata values are strings or null. query is the generated ENA expression. Requests limit+1 rows to detect truncation; n_runs_returned is not a total. ENA chooses the subset in unspecified order; returned rows are sorted by run_accession. No offset or continuation token and no local result cache. Pass a run_accession to ena_get_run_files for generated FASTQ or ena_get_submitted_files for original submissions.',
    example:
      'const result = await host.mcp("omics-archives", "ena_query_runs", {"tax_id": 6239, "library_strategy": "RNA-Seq", "keyword": "transcriptome", "limit": 20})',
    run: async (ctx, args) => {
      const limit = args.limit ?? 100
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new Error('limit must be an integer from 1 to 1000')
      const clauses: string[] = []
      if (args.tax_id !== undefined) {
        if (
          typeof args.tax_id !== 'number' ||
          !Number.isInteger(args.tax_id) ||
          args.tax_id < 1 ||
          args.tax_id > 2147483647
        )
          throw new Error('tax_id must be a positive NCBI taxonomy integer')
        clauses.push(`tax_tree(${args.tax_id})`)
      }
      if (args.library_strategy !== undefined) {
        if (!LIBRARY_STRATEGIES.some((strategy) => strategy === args.library_strategy))
          throw new Error('library_strategy must be a supported ENA library strategy')
        clauses.push(`library_strategy="${args.library_strategy}"`)
      }
      let keyword: string | null = null
      if (args.keyword !== undefined) {
        if (
          typeof args.keyword !== 'string' ||
          [...args.keyword].length > 200 ||
          !new RegExp(KEYWORD_PATTERN).test(args.keyword) ||
          !args.keyword.trim()
        )
          throw new Error(
            'keyword must be nonempty text without quotes, backslashes, wildcards or control characters'
          )
        keyword = args.keyword.trim()
        clauses.push(`(${TITLE_FIELDS.map((field) => `${field}="*${keyword}*"`).join(' OR ')})`)
      }
      if (!clauses.length) throw new Error('provide tax_id, library_strategy or keyword')
      const query = clauses.join(' AND ')
      const fields = [...RUN_FIELDS, ...TITLE_FIELDS]
      const params = new URLSearchParams({
        result: 'read_run',
        query,
        fields: fields.join(','),
        format: 'json',
        limit: String(limit + 1),
        includeMetagenomes: 'true'
      })
      const rows = runRows(await ctx.fetchJson(`${SEARCH}?${params}`), limit + 1)
      const runs = rows
        .slice(0, limit)
        .map((row) => Object.fromEntries(fields.map((field) => [field, nullableText(row, field)])))
      runs.sort((a, b) => a.run_accession!.localeCompare(b.run_accession!))
      return {
        filters: {
          tax_id: args.tax_id ?? null,
          library_strategy: args.library_strategy ?? null,
          keyword
        },
        query,
        n_runs_returned: runs.length,
        truncated: rows.length > limit,
        runs
      }
    }
  },
  {
    id: 'ena_get_submitted_files',
    connector: 'omics-archives',
    description:
      'List original submitted files for one ERR/SRR/DRR run, including submitted BAM, CRAM or FASTQ when ENA exposes them. Returns FTP locations, submitted formats, byte sizes and MD5 checksums as metadata only. Does not download, convert formats, retrieve reference genomes or verify checksums. These are submitted files, not the archive-generated FASTQ returned by ena_get_run_files and not a list of archive-generated SRA containers. A CRAM may require its matching reference for analysis.',
    input: {
      type: 'object',
      properties: { run_accession: { type: 'string', minLength: 1, maxLength: 64 } },
      required: ['run_accession'],
      additionalProperties: false
    },
    required: ['run_accession'],
    returns:
      '{run_accession, found, library_layout:string|null, submitted_available, n_files, submitted_files:[{file_index, ftp_location, format:string|null, size_bytes:number|null, md5:string|null}]}. found means a public run report was returned; found:true with submitted_available:false means no submitted FTP files are listed, not that the run is missing. file_index is 1-based report order, not read/mate identity. Locations, formats, sizes and checksums are aligned by position; inconsistent lists fail, missing metadata values are null. ftp_location preserves the upstream address, often a scheme-less FTP path: filenames may contain literal # or other URI-reserved characters, so it must not be parsed as an already encoded URL. MD5s are validated as hexadecimal and normalized to lowercase. Metadata comes from ENA cache and may lag updates; no local cache is added.',
    example:
      'const result = await host.mcp("omics-archives", "ena_get_submitted_files", {"run_accession": "ERR10015065"})',
    run: async (ctx, args) => {
      const runAccession = accession(args.run_accession, true)
      const rows = await report(
        ctx,
        runAccession,
        [
          'run_accession',
          'library_layout',
          'submitted_ftp',
          'submitted_format',
          'submitted_bytes',
          'submitted_md5'
        ],
        2
      )
      if (rows.length > 1) invalidReport('expected at most one run')
      const row = rows[0]
      const locations = row ? fileValues(row, 'submitted_ftp') : []
      const aligned = (field: string): string[] =>
        row ? alignedValues(row, field, locations.length, 'submitted_ftp') : []
      const formats = aligned('submitted_format')
      const sizes = aligned('submitted_bytes')
      const md5s = aligned('submitted_md5')
      const files = locations.map((location, i) => {
        if (!location) invalidReport('empty submitted FTP location')
        return {
          file_index: i + 1,
          ftp_location: location,
          format: formats[i] || null,
          size_bytes: fileSize(sizes[i], 'submitted_bytes'),
          md5: checksum(md5s[i], 'submitted_md5')
        }
      })
      return {
        run_accession: runAccession,
        found: Boolean(row),
        library_layout: row ? nullableText(row, 'library_layout') : null,
        submitted_available: files.length > 0,
        n_files: files.length,
        submitted_files: files
      }
    }
  },
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
