import { parse, type DefaultTreeAdapterMap } from 'parse5'
import type { ToolContext, ToolDescriptor } from '../../connector-core/types'

// NCBI contracts: /geo/info/download.html and /geo/info/rnaseqcounts.html.
// Discover advertised files; never guess an assembly or promise that a file exists.
const DOWNLOAD = 'https://www.ncbi.nlm.nih.gov/geo/download/'
const TEXT_LIMIT = 8 * 1024 * 1024
const KINDS = ['series_matrix', 'raw_counts', 'normalized_counts', 'unknown'] as const
type Kind = (typeof KINDS)[number]
type FileRecord = {
  name: string
  url: string
  kind: Kind | 'gene_annotation'
  format: 'tsv'
  compression: 'gzip'
  platform_id: string | null
  source_url: string
}

function links(html: string): string[] {
  const result: string[] = []
  const walk = (node: DefaultTreeAdapterMap['node']): void => {
    if ('tagName' in node && node.tagName === 'a') {
      const href = node.attrs.find((attribute) => attribute.name === 'href')?.value
      if (href) result.push(href)
    }
    if ('childNodes' in node) node.childNodes.forEach(walk)
  }
  walk(parse(html))
  return result
}

async function discover(ctx: ToolContext, accession: string): Promise<unknown> {
  if (!/^GSE[1-9]\d*$/.test(accession)) throw new Error('accession must be a GSE accession')
  const bucket = accession.length <= 6 ? 'GSEnnn' : `${accession.slice(0, -3)}nnn`
  const matrixUrl = `https://ftp.ncbi.nlm.nih.gov/geo/series/${bucket}/${accession}/matrix/`
  const countsUrl = `${DOWNLOAD}?type=rnaseq_counts&acc=${accession}`
  const files = new Map<string, FileRecord>()
  const sources: Array<{
    url: string
    status: 'files_listed' | 'no_recognized_links' | 'unavailable'
    error?: string
  }> = []
  for (const source of [matrixUrl, countsUrl]) {
    try {
      const html = await ctx.fetchText(source, 'text/html')
      if (/recaptcha|checking your browser|access denied/i.test(html)) {
        throw new Error('NCBI returned an access challenge instead of a file listing')
      }
      const before = files.size
      for (const href of links(html)) {
        let url: URL
        try {
          url = new URL(href, source)
        } catch {
          continue
        }
        if (url.protocol === 'ftp:' && url.hostname === 'ftp.ncbi.nlm.nih.gov') {
          url.protocol = 'https:'
        }
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash)
          continue
        let name: string
        let kind: FileRecord['kind']
        let platform: string | null = null
        if (source === matrixUrl) {
          if (!url.href.startsWith(matrixUrl) || url.search) continue
          name = decodeURIComponent(url.pathname.slice(new URL(matrixUrl).pathname.length))
          const match = new RegExp(`^${accession}(?:-(GPL\\d+))?_series_matrix\\.txt\\.gz$`).exec(
            name
          )
          if (!match) continue
          kind = 'series_matrix'
          platform = match[1] ?? null
        } else {
          if (`${url.origin}${url.pathname}` !== DOWNLOAD) continue
          if (
            url.searchParams.get('type') !== 'rnaseq_counts' ||
            url.searchParams.get('format') !== 'file'
          )
            continue
          name = url.searchParams.get('file') ?? ''
          if (/^[A-Za-z0-9_.-]+\.annot\.tsv\.gz$/.test(name)) {
            kind = 'gene_annotation'
          } else {
            if (url.searchParams.get('acc') !== accession) continue
            if (
              new RegExp(`^${accession}_raw_counts_[A-Za-z0-9_.-]+_NCBI\\.tsv\\.gz$`).test(name)
            ) {
              kind = 'raw_counts'
            } else if (
              new RegExp(
                `^${accession}_norm_counts_(?:FPKM|TPM)_[A-Za-z0-9_.-]+_NCBI\\.tsv\\.gz$`
              ).test(name)
            ) {
              kind = 'normalized_counts'
            } else continue
          }
        }
        files.set(url.href, {
          name,
          url: url.href,
          kind,
          format: 'tsv',
          compression: 'gzip',
          platform_id: platform,
          source_url: source
        })
      }
      // A changed HTML layout is not evidence that this study has no matrices.
      sources.push({
        url: source,
        status: files.size > before ? 'files_listed' : 'no_recognized_links'
      })
    } catch (error) {
      ctx.signal?.throwIfAborted()
      sources.push({
        url: source,
        status: 'unavailable',
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  if (sources.every((source) => source.status === 'unavailable')) {
    throw new Error(
      `GEO matrix discovery failed for ${accession}: ${sources.map((source) => `${source.url}: ${source.error}`).join('; ')}`
    )
  }
  return {
    accession,
    files: [...files.values()],
    sources,
    status: sources.every((source) => source.status === 'files_listed')
      ? 'ok'
      : files.size
        ? 'partial'
        : 'unrecognized',
    next_steps: [
      'Use geo_get_series to obtain sample metadata and submitter supplementary-file URLs.',
      'Offer the official URL for manual download by the user. This connector does not download or decompress matrices; do not bypass host.mcp with raw HTTP.',
      'After the user downloads and decompresses the file, read the local text in the REPL and call geo_preflight_matrix with the series samples. Keep separate Series Matrix platform files separate.',
      'Set complete only when supplying the entire file. For plain TSV, completeness is caller-declared, not independently verified; a preview cannot establish total dimensions.',
      'Resolve unmatched or ambiguous sample columns, review omitted samples, and align metadata to the returned column order before analysis.',
      'Confirm assay, organism, genome build, processing, replication and design. Series Matrix values and FPKM/TPM are not raw counts; NCBI counts may differ from the publication.'
    ]
  }
}

// GEO tables are line-oriented TSV. Support quoted fields and escaped quotes, but reject
// multiline fields rather than silently shifting sample columns or counting physical lines as rows.
function fields(line: string): string[] {
  const values: string[] = []
  let value = ''
  let quoted = false
  let closed = false
  for (let i = 0; i < line.length; i++) {
    const character = line[i]
    if (quoted) {
      if (character === '"' && line[i + 1] === '"') {
        value += '"'
        i++
      } else if (character === '"') {
        quoted = false
        closed = true
      } else value += character
    } else if (character === '\t') {
      values.push(value)
      value = ''
      closed = false
    } else if (character === '"' && value === '' && !closed) quoted = true
    else {
      if (closed || character === '"') throw new Error('Malformed quoted TSV field')
      value += character
    }
  }
  if (quoted) throw new Error('Unterminated or multiline TSV field is unsupported')
  values.push(value)
  return values
}

// Called after numeric syntax validation. Check decimal integrality before Number rounding
// can hide a fractional part or underflow a negative value to zero.
function rawCountChecks(
  value: string,
  numericValue: number
): { negative: boolean; safeInteger: boolean } {
  const [coefficient, exponent = '0'] = value.split(/e/i)
  const digits = coefficient.replace(/^[+-]/, '').replace('.', '')
  let trailingZeros = 0
  while (trailingZeros < digits.length && digits[digits.length - trailingZeros - 1] === '0') {
    trailingZeros++
  }
  if (trailingZeros === digits.length) return { negative: false, safeInteger: true }
  const point = coefficient.indexOf('.')
  const fractionalDigits = point < 0 ? 0 : coefficient.length - point - 1
  return {
    negative: coefficient.startsWith('-'),
    safeInteger:
      Number(exponent) - fractionalDigits + trailingZeros >= 0 && Number.isSafeInteger(numericValue)
  }
}

type Sample = { accession: string; title?: string; platform_id?: string }
function preflight(args: Record<string, unknown>): unknown {
  if (
    typeof args.text !== 'string' ||
    !args.text.trim() ||
    Buffer.byteLength(args.text) > TEXT_LIMIT
  ) {
    throw new Error('text must contain decompressed TSV text of at most 8 MiB')
  }
  if (args.complete !== undefined && typeof args.complete !== 'boolean') {
    throw new Error('complete must be boolean')
  }
  const kind = (args.matrix_kind ?? 'unknown') as Kind
  if (!KINDS.includes(kind)) throw new Error('Unsupported matrix_kind')
  const samples = args.samples as Sample[] | undefined
  if (
    samples !== undefined &&
    (!Array.isArray(samples) ||
      samples.length > 10000 ||
      samples.some(
        (sample) =>
          !sample ||
          typeof sample.accession !== 'string' ||
          !/^GSM[1-9]\d*$/.test(sample.accession) ||
          (sample.title !== undefined && typeof sample.title !== 'string') ||
          (sample.platform_id !== undefined && !/^GPL[1-9]\d*$/.test(sample.platform_id))
      ))
  ) {
    throw new Error('samples must contain GEO sample metadata with GSM accessions')
  }
  const lines = args.text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (
    args.text.includes(String.fromCharCode(0)) ||
    args.text.includes('\uFFFD') ||
    args.text.charCodeAt(0) === 31 ||
    /^\s*(?:<|%%MatrixMarket)/.test(args.text)
  ) {
    throw new Error('Expected decompressed dense TSV, not HTML, binary, or Matrix Market data')
  }
  const begin = lines.indexOf('!series_matrix_table_begin')
  const end = lines.indexOf('!series_matrix_table_end')
  const series = begin >= 0 || lines.some((line) => /^!(?:Series|Sample)_/.test(line))
  if (series && begin < 0) throw new Error('Series Matrix table start is missing')
  if (kind === 'series_matrix' && !series) {
    throw new Error('Expected Series Matrix metadata and table markers')
  }
  if (series && kind !== 'unknown' && kind !== 'series_matrix') {
    throw new Error('Series Matrix cannot be declared as a count matrix')
  }
  if (
    series &&
    ((end >= 0 && end <= begin) ||
      lines.filter((line) => line === '!series_matrix_table_begin').length !== 1 ||
      lines.filter((line) => line === '!series_matrix_table_end').length > 1)
  ) {
    throw new Error('Invalid or multiple Series Matrix tables; inspect platforms separately')
  }
  if (!series && end >= 0) throw new Error('Unexpected Series Matrix table end')
  if (series && end >= 0 && lines.slice(end + 1).some((line) => line.trim())) {
    throw new Error('Unexpected content after Series Matrix table end')
  }
  const complete = args.complete === true && (!series || end > begin)
  const table = series ? lines.slice(begin + 1, end > begin ? end : undefined) : lines
  while (table.at(-1) === '') table.pop()
  const header = fields(table[0] ?? '')
  if (header.length < 2 || header.length > 10001 || !header[0]) {
    throw new Error('Expected a feature ID column followed by 1–10000 sample columns in TSV format')
  }
  if (series && header[0] !== 'ID_REF')
    throw new Error('Series Matrix feature column must be ID_REF')
  const columns = header.slice(1)
  const issues = new Set<string>()
  const warnings = new Set<string>()
  if (!complete) issues.add('partial_input: total row count and full-file validity are unknown')
  if (columns.some((column) => !column)) issues.add('empty_sample_column')
  if (new Set(columns).size !== columns.length) issues.add('duplicate_sample_columns')
  const sampleHeaders = series
    ? lines.slice(0, begin).filter((line) => line.startsWith('!Sample_geo_accession\t'))
    : []
  const declaredSamples = sampleHeaders.length === 1 ? fields(sampleHeaders[0]).slice(1) : []
  if (
    sampleHeaders.length > 1 ||
    (sampleHeaders.length === 1 &&
      (declaredSamples.some((accession) => !/^GSM[1-9]\d*$/.test(accession)) ||
        JSON.stringify(declaredSamples) !== JSON.stringify(columns)))
  ) {
    issues.add('series_sample_header_mismatch')
  }
  if (series && !sampleHeaders.length) issues.add('series_sample_metadata_missing')
  const platformHeaders = series
    ? lines.slice(0, begin).filter((line) => line.startsWith('!Sample_platform_id\t'))
    : []
  const declaredPlatforms = platformHeaders.length === 1 ? fields(platformHeaders[0]).slice(1) : []
  if (
    platformHeaders.length > 1 ||
    (platformHeaders.length === 1 &&
      (declaredPlatforms.length !== columns.length ||
        declaredPlatforms.some((platform) => !/^GPL[1-9]\d*$/.test(platform))))
  ) {
    issues.add('series_platform_header_mismatch')
  }
  let ragged = 0
  let missing = 0
  let nonNumeric = 0
  let negative = 0
  let nonInteger = 0
  let duplicateFeatures = 0
  let emptyFeatures = 0
  const features = new Set<string>()
  for (const line of table.slice(1)) {
    const row = fields(line)
    if (row.length !== header.length) ragged++
    if (!row[0]) emptyFeatures++
    else if (features.has(row[0])) duplicateFeatures++
    else features.add(row[0])
    for (const cell of row.slice(1)) {
      const value = cell.trim()
      if (!value || /^(?:NA|N\/A|null|NaN)$/i.test(value)) {
        missing++
        continue
      }
      if (
        !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) ||
        !Number.isFinite(Number(value))
      ) {
        nonNumeric++
        continue
      }
      const number = Number(value)
      if (kind === 'raw_counts') {
        const checks = rawCountChecks(value, number)
        if (checks.negative) negative++
        if (!checks.safeInteger) nonInteger++
      } else {
        if (number < 0) negative++
        if (!Number.isSafeInteger(number)) nonInteger++
      }
    }
  }
  const rows = Math.max(0, table.length - 1)
  if (!rows) issues.add('empty_matrix')
  if (ragged) issues.add('inconsistent_row_width')
  if (missing) issues.add('missing_values')
  if (nonNumeric) issues.add('non_numeric_values')
  if (duplicateFeatures) issues.add('duplicate_feature_ids')
  if (emptyFeatures) issues.add('empty_feature_ids')
  if (kind === 'raw_counts' && (negative || nonInteger)) {
    issues.add('raw_counts_require_nonnegative_safe_integers')
  }
  // Index once: the allowed 10,000-column input must not repeatedly scan all metadata.
  const byAccession = new Map<string, Sample[]>()
  const byTitle = new Map<string, Sample[]>()
  for (const sample of samples ?? []) {
    const accessionMatches = byAccession.get(sample.accession) ?? []
    accessionMatches.push(sample)
    byAccession.set(sample.accession, accessionMatches)
    if (sample.title) {
      const titleMatches = byTitle.get(sample.title) ?? []
      titleMatches.push(sample)
      byTitle.set(sample.title, titleMatches)
    }
  }
  const mapping = columns.map((column, index) => {
    const exact = byAccession.get(column) ?? []
    // Series Matrix and accession-shaped headers are identities, never sample titles.
    const candidates =
      series || exact.length || /^GSM\d+$/i.test(column) ? exact : (byTitle.get(column) ?? [])
    if (
      candidates.length === 1 &&
      declaredPlatforms.length === columns.length &&
      candidates[0].platform_id &&
      candidates[0].platform_id !== declaredPlatforms[index]
    ) {
      issues.add('series_platform_metadata_mismatch')
    }
    return {
      column_index: index + 1,
      column,
      accession: candidates.length === 1 ? candidates[0].accession : null,
      matched_by: candidates.length === 1 ? (exact.length ? 'accession' : 'unique_title') : null,
      status:
        samples === undefined
          ? 'not_checked'
          : candidates.length === 1
            ? 'matched'
            : candidates.length
              ? 'ambiguous'
              : 'unmatched'
    }
  })
  if (mapping.some((entry) => entry.status !== 'matched')) issues.add('sample_mapping_incomplete')
  const matched = mapping.flatMap((entry) => (entry.accession ? [entry.accession] : []))
  const matchedSet = new Set(matched)
  if (matchedSet.size !== matched.length) issues.add('multiple_columns_map_to_same_sample')
  if (samples && byAccession.size !== samples.length) {
    issues.add('duplicate_metadata_accessions')
  }
  const platforms = [
    ...new Set(
      samples
        ?.filter((sample) => matchedSet.has(sample.accession))
        .map((sample) => sample.platform_id)
        .filter(Boolean)
    )
  ]
  if (platforms.length > 1 || new Set(declaredPlatforms).size > 1) {
    warnings.add(
      'multiple_platforms_in_matrix: review assay and feature compatibility before analysis'
    )
  }
  return {
    format: series ? 'series_matrix' : 'tsv',
    matrix_kind: series ? 'series_matrix' : kind,
    complete,
    dimensions: {
      features: complete ? rows : null,
      features_observed: rows,
      samples: columns.length
    },
    feature_column: header[0],
    sample_mapping: mapping,
    metadata_samples_not_in_matrix:
      samples
        ?.filter((sample) => !matchedSet.has(sample.accession))
        .map((sample) => sample.accession) ?? [],
    diagnostics: {
      ragged_rows: ragged,
      missing_values: missing,
      non_numeric_values: nonNumeric,
      negative_values: negative,
      non_integer_or_unsafe_values: nonInteger,
      duplicate_feature_ids: duplicateFeatures,
      empty_feature_ids: emptyFeatures
    },
    issues: [...issues],
    warnings: [...warnings],
    structural_checks_passed: issues.size === 0,
    analysis_notes: [
      'Structural preflight does not establish biological comparability or approve differential expression analysis.',
      'Matrix kind is caller-supplied except for Series Matrix detection. Confirm provenance and processing; integer values alone do not prove raw counts.',
      'Use sample_mapping in matrix column order; investigate metadata_samples_not_in_matrix before choosing a cohort.',
      'Use raw counts for count-based models. Do not substitute Series Matrix values, FPKM or TPM. Review gene annotation, genome build, design, covariates and replication.'
    ]
  }
}

export const GEO_MATRIX_TOOLS: ToolDescriptor[] = [
  {
    id: 'geo_get_matrix_files',
    connector: 'omics-archives',
    maxResponseBytes: 2 * 1024 * 1024,
    description:
      'Discover Series Matrix files and NCBI-generated RNA-seq raw counts, FPKM/TPM and gene annotation files for one GSE from live NCBI listings. Returns advertised URLs, not downloaded matrices or verified file contents. Start with geo_get_series for sample metadata. Offer the official URL for manual download by the user, then use geo_preflight_matrix on locally read decompressed text. Do not bypass host.mcp with raw HTTP. Missing or failed listings do not prove absence of data; also inspect the series supplementary files.',
    input: {
      type: 'object',
      properties: { accession: { type: 'string', pattern: '^GSE[1-9][0-9]*$' } },
      required: ['accession'],
      additionalProperties: false
    },
    required: ['accession'],
    returns:
      '{accession, files:[{name,url,kind,format,compression,platform_id,source_url}], sources:[{url,status,error?}], status, next_steps}. kind separates series_matrix, raw_counts, normalized_counts and gene_annotation. status is ok when both sources list recognized files, partial when files are found but a source fails or has no recognized links, and unrecognized when no files are recognized. None proves an exhaustive inventory or absence of data. If both sources are unavailable, the call throws with source errors. Never infer matrix dimensions or sample coverage from these filenames.',
    example:
      'const result = await host.mcp("omics-archives", "geo_get_matrix_files", {"accession":"GSE164073"})',
    run: (ctx, args) => discover(ctx, String(args.accession))
  },
  {
    id: 'geo_preflight_matrix',
    connector: 'omics-archives',
    description:
      'Preflight decompressed dense TSV or Series Matrix text (up to 8 MiB) without network or filesystem access. Supply samples from geo_get_series (accession, title, platform_id) to map columns by GSM, never by position. Only plain TSV supports unique exact title matching; GSM-shaped columns never fall back to titles. Series Matrix requires exactly one !Sample_geo_accession header containing valid GSM accessions matching the sample column count and order, and never falls back to title matching. For larger files use complete:false and perform full validation in the analysis environment. For plain TSV previews, pass the table header plus complete preview rows. For Series Matrix previews, also preserve the preceding metadata, including !Sample_geo_accession and any !Sample_platform_id header, and !series_matrix_table_begin; do not submit only the table or fabricate !series_matrix_table_end. Set complete:true only when text contains the entire file. For plain TSV, completeness is caller-declared, not independently verified. A preview cannot establish total dimensions. Does not handle sparse Matrix Market, archives, HDF5 or multiline TSV fields. Preserve sample_mapping column order when preparing the analysis matrix.',
    input: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: TEXT_LIMIT },
        complete: { type: 'boolean', default: false },
        matrix_kind: { type: 'string', enum: KINDS, default: 'unknown' },
        samples: {
          type: 'array',
          maxItems: 10000,
          items: {
            type: 'object',
            properties: {
              accession: { type: 'string', pattern: '^GSM[1-9][0-9]*$' },
              title: { type: 'string' },
              platform_id: { type: 'string', pattern: '^GPL[1-9][0-9]*$' }
            },
            required: ['accession'],
            additionalProperties: true
          }
        }
      },
      required: ['text'],
      additionalProperties: false
    },
    required: ['text'],
    returns:
      '{format,matrix_kind,complete,dimensions:{features:number|null,features_observed,samples},feature_column,sample_mapping:[{column_index,column,accession,matched_by,status}],metadata_samples_not_in_matrix,diagnostics,issues,warnings,structural_checks_passed,analysis_notes}. column_index is one-based among sample columns. features is null for partial input; structural_checks_passed requires complete numeric data and unambiguous sample mapping. Series Matrix platform conflicts are issues; multiple platforms alone are advisory warnings. It is not an analysis-readiness guarantee.',
    example:
      'const result = await host.mcp("omics-archives", "geo_preflight_matrix", {"text":"GeneID\\tGSM5000001\\n1\\t12\\n","complete":false,"matrix_kind":"raw_counts","samples":[{"accession":"GSM5000001"}]})',
    run: async (_ctx, args) => preflight(args)
  }
]
