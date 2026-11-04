import type { ToolContext, ToolDescriptor } from '@aipoch/connector-core'
import { eqtlTabixLines, type EqtlRegion } from './humangenetics-eqtl-tabix'

// The retired REST service is replaced by the official release-7 file catalogue and TBI/BGZF
// region reads over HTTPS. Pin the manifest; upstream data URLs themselves are not immutable.
const SNAPSHOT = '7a5b65b8c2eb54bc7432825f265a449f604f906b'
const MANIFEST = `https://raw.githubusercontent.com/eQTL-Catalogue/eQTL-Catalogue-resources/${SNAPSHOT}/tabix/tabix_ftp_paths.tsv`
const DATA_ACCESS = 'https://www.ebi.ac.uk/eqtl/Data_access/'
const MAX_COORDINATE = 2 ** 29
const MAX_REGION = 5_000_000
const DATASET_FIELDS = [
  'study_id',
  'dataset_id',
  'study_label',
  'sample_group',
  'tissue_id',
  'tissue_label',
  'condition_label',
  'sample_size',
  'quant_method'
] as const
const ASSOCIATION_FIELDS = [
  'molecular_trait_id',
  'gene_id',
  'variant',
  'rsid',
  'chromosome',
  'position',
  'ref',
  'alt',
  'type',
  'beta',
  'se',
  'pvalue',
  'nlog10p',
  'maf',
  'ac',
  'an',
  'r2',
  'median_tpm'
] as const
const NUMERIC_FIELDS = new Set([
  'position',
  'beta',
  'se',
  'pvalue',
  'maf',
  'ac',
  'an',
  'r2',
  'median_tpm'
])
type Row = Record<string, string>
type Dataset = Record<string, string | number> & {
  dataset_id: string
  study_id: string
  file_url: string
}

function text(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function cap(value: unknown): number {
  if (value === undefined) return 1000
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error('max_records must be an integer between 1 and 1000')
  }
  return value
}

function columns(line: string, required: readonly string[]): string[] {
  const names = line.replace(/^\uFEFF/, '').split('\t')
  if (new Set(names).size !== names.length || required.some((name) => !names.includes(name))) {
    throw new Error('eQTL file has missing or duplicate required columns')
  }
  return names
}

function row(line: string, names: string[]): Row {
  const values = line.split('\t')
  if (values.length !== names.length) throw new Error('eQTL file has an incomplete TSV row')
  return Object.fromEntries(names.map((name, index) => [name, values[index]]))
}

async function datasets(ctx: ToolContext): Promise<Dataset[]> {
  const body = await ctx.fetchText(MANIFEST, 'text/tab-separated-values')
  if (Buffer.byteLength(body) > 1_000_000)
    throw new Error('eQTL dataset manifest exceeds its size limit')
  const lines = body.trimEnd().split(/\r?\n/)
  const names = columns(lines.shift() ?? '', [...DATASET_FIELDS, 'ftp_path'])
  const seen = new Set<string>()
  const result = lines.map((line) => {
    const r = row(line, names)
    if (
      !/^QTD\d{6}$/.test(r.dataset_id) ||
      !/^QTS\d{6}$/.test(r.study_id) ||
      seen.has(r.dataset_id)
    ) {
      throw new Error('eQTL manifest has invalid or duplicate dataset identities')
    }
    seen.add(r.dataset_id)
    const url = new URL(r.ftp_path)
    if (
      !['ftp:', 'https:'].includes(url.protocol) ||
      url.hostname !== 'ftp.ebi.ac.uk' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !new RegExp(
        `^/pub/databases/spot/eQTL/sumstats/${r.study_id}/${r.dataset_id}/${r.dataset_id}\\.(?:all|cc)\\.tsv\\.gz$`
      ).test(url.pathname)
    )
      throw new Error('eQTL manifest contains an unexpected file URL')
    if (
      !/^\d+$/.test(r.sample_size) ||
      !Number.isSafeInteger(Number(r.sample_size)) ||
      Number(r.sample_size) < 1
    ) {
      throw new Error('eQTL manifest has an invalid sample size')
    }
    url.protocol = 'https:'
    return {
      ...Object.fromEntries(DATASET_FIELDS.map((key) => [key, r[key]])),
      dataset_id: r.dataset_id,
      study_id: r.study_id,
      sample_size: Number(r.sample_size),
      file_url: url.href
    }
  })
  if (!result.length) throw new Error('eQTL manifest contains no datasets')
  return result.sort((a, b) => a.dataset_id.localeCompare(b.dataset_id))
}

function reference(dataset?: Dataset): Record<string, unknown> {
  return {
    provider: 'eQTL Catalogue',
    genome_build: 'GRCh38',
    catalogue_release: '7',
    manifest_url: MANIFEST,
    manifest_revision: SNAPSHOT,
    data_access_url: DATA_ACCESS,
    ...(dataset
      ? {
          file_url: dataset.file_url,
          index_url: `${dataset.file_url}.tbi`,
          statistics_scope: dataset.file_url.endsWith('.all.tsv.gz') ? 'full_nominal' : 'filtered',
          note: 'The manifest is pinned; data files are served at upstream-managed URLs. Filtered .cc files omit some molecular traits. Empty results do not establish absence of an association.'
        }
      : {})
  }
}

function region(chrom: string, start: number, end: number): EqtlRegion {
  if (
    !/^(?:[1-9]|1\d|2[0-2]|X|Y)$/.test(chrom) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end < start ||
    end > MAX_COORDINATE
  ) {
    throw new Error('Use GRCh38 chromosome 1-22, X or Y and positive 1-based inclusive coordinates')
  }
  if (end - start + 1 > MAX_REGION)
    throw new Error('eQTL region exceeds 5 Mb; split the query or use local Tabix')
  return { chrom, start, end }
}

function queryRegion(filters: Record<string, string | number>): {
  region: EqtlRegion
  coordinate_source: string
} {
  if (typeof filters.pos === 'string') {
    const m = /^(\w+):(\d+)-(\d+)$/.exec(filters.pos)
    if (!m) throw new Error('pos must be chromosome:start-end on GRCh38, without a chr prefix')
    return { region: region(m[1], Number(m[2]), Number(m[3])), coordinate_source: 'caller_GRCh38' }
  }
  if (typeof filters.variant === 'string') {
    const m = /^chr([\dXY]+)_(\d+)_([ACGTN]+)_([ACGTN]+)$/.exec(filters.variant)
    if (!m) throw new Error('variant must be chrN_position_ref_alt on GRCh38')
    return {
      region: region(m[1], Number(m[2]), Number(m[2])),
      coordinate_source: 'caller_GRCh38_variant'
    }
  }
  throw new Error(
    'eqtl_associations requires explicit GRCh38 pos or variant; gene_id and rsid are exact filters, not coordinate references'
  )
}

function numeric(value: string, name: string): number | null {
  if (value === 'NA' || value === '') return null
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value))) {
    throw new Error(`Invalid eQTL ${name}`)
  }
  return Number(value)
}

function association(r: Row): Record<string, unknown> {
  const out = Object.fromEntries(
    ASSOCIATION_FIELDS.filter((name) => name !== 'nlog10p').map((name) => [
      name,
      NUMERIC_FIELDS.has(name)
        ? numeric(r[name] ?? 'NA', name)
        : !r[name] || r[name] === 'NA'
          ? null
          : r[name]
    ])
  )
  const p = out.pvalue as number | null
  if (p !== null && (p < 0 || p > 1 || r.pvalue.startsWith('-')))
    throw new Error('Invalid eQTL pvalue')
  // Normalize the decimal text before Number can underflow a nonzero p-value.
  const [coefficient, exponent = '0'] = (r.pvalue ?? '').replace(/^\+/, '').toLowerCase().split('e')
  const [whole, fraction = ''] = coefficient.split('.')
  const digits = whole + fraction
  const first = digits.search(/[1-9]/)
  let nlog10p: number | null = null
  if (p !== null && first >= 0) {
    const mantissa = Number(`${digits[first]}.${digits.slice(first + 1, first + 17)}`)
    nlog10p = -Math.log10(mantissa) - (Number(exponent) + whole.length - first - 1)
    if (!Number.isFinite(nlog10p)) throw new Error('Invalid eQTL pvalue exponent')
  }
  return { ...out, nlog10p, pvalue_text: r.pvalue === 'NA' ? null : r.pvalue }
}

export const HUMANGENETICS_EQTL_TOOLS: ToolDescriptor[] = [
  {
    id: 'eqtl_list_datasets',
    connector: 'human-genetics',
    credentialKeys: [],
    maxResponseBytes: 1_000_000,
    description:
      'List eQTL Catalogue release-7 datasets from the pinned official TSV file catalogue; the REST API is retired. Optional exact filters: study_label, tissue_label, quant_method (ge, exon, tx, txrev, microarray, leafcutter, aptamer). max_records defaults to 1000 (1-1000). Returns sorted metadata and official HTTPS file URLs, total matched count, exact truncation and reference_data. Gene-expression .all files contain full nominal statistics; .cc files are filtered. Metadata pinning does not freeze the upstream data files.',
    input: {
      type: 'object',
      properties: {
        study_label: { type: 'string' },
        tissue_label: { type: 'string' },
        quant_method: { type: 'string' },
        max_records: { type: 'integer', minimum: 1, maximum: 1000, default: 1000 }
      }
    },
    returns:
      '{filters, total, returned, truncated, datasets:[{dataset_id,study_id,study_label,sample_group,tissue_id,tissue_label,condition_label,quant_method,sample_size,file_url}], reference_data}',
    exampleArgs: { study_label: 'Alasoo_2018', quant_method: 'ge' },
    run: async (ctx, args) => {
      const max = cap(args.max_records)
      const filters: Record<string, string> = {}
      for (const name of ['study_label', 'tissue_label', 'quant_method']) {
        const value = text(args[name], name)
        if (value) filters[name] = value
      }
      const rows = (await datasets(ctx)).filter((r) =>
        Object.entries(filters).every(([k, v]) => r[k] === v)
      )
      return {
        filters,
        total: rows.length,
        returned: Math.min(rows.length, max),
        truncated: rows.length > max,
        datasets: rows.slice(0, max),
        reference_data: reference()
      }
    }
  },
  {
    id: 'eqtl_associations',
    connector: 'human-genetics',
    credentialKeys: [],
    maxResponseBytes: 1_000_000,
    totalTimeoutMs: 180_000,
    description:
      'Query eQTL Catalogue release-7 official indexed TSV files via bounded HTTPS Tabix reads, replacing the retired REST API. Requires dataset_id, explicit genome_build=GRCh38 (no default), and pos or variant. For a GRCh37 variant, first use the variants connector liftover_variant tool with source_build=GRCh37; proceed only with a unique GRCh38 mapping and preserve the original variant and mapping provenance. No automatic liftover or region conversion is performed. gene_id and rsid are optional exact filters. pos is 1-based inclusive chromosome:start-end GRCh38 (no chr prefix, at most 5 Mb); variant is chrN_position_ref_alt. Coordinates must match the dataset annotation; use the existing genome tools to resolve coordinates explicitly. This connector does not infer historical gene windows or call Ensembl. Additional filters intersect exactly. nlog10p_min filters derived -log10(p) locally; max_records defaults to 1000 (1-1000). Fetch at most 1001 matching rows to prove truncation. Oversized reads fail explicitly; use smaller regions or local Tabix for bulk work. Preserve reference_data, pvalue_text and ALT as the effect allele. Filtered .cc files omit traits; empty results mean no matching published rows, not absence of association. Files cover only tested cis windows.',
    input: {
      type: 'object',
      properties: {
        dataset_id: { type: 'string', pattern: '^QTD[0-9]{6}$' },
        genome_build: { type: 'string', enum: ['GRCh38'] },
        gene_id: { type: 'string', pattern: '^ENSG[0-9]{11}$' },
        rsid: { type: 'string', pattern: '^rs[0-9]+$' },
        variant: { type: 'string' },
        pos: { type: 'string' },
        nlog10p_min: { type: 'number', minimum: 0 },
        max_records: { type: 'integer', minimum: 1, maximum: 1000, default: 1000 }
      },
      required: ['dataset_id', 'genome_build'],
      anyOf: [
        { properties: { pos: {} }, required: ['pos'] },
        { properties: { variant: {} }, required: ['variant'] }
      ]
    },
    required: ['dataset_id', 'genome_build'],
    returns:
      '{dataset_id,filters,region:{chrom,start,end},coordinate_source,returned,truncated,associations:[{molecular_trait_id,gene_id,variant,rsid,chromosome,position,ref,alt,type,beta,se,pvalue,pvalue_text,nlog10p,maf,ac,an,r2,median_tpm}],reference_data}',
    exampleArgs: {
      dataset_id: 'QTD000021',
      genome_build: 'GRCh38',
      pos: '20:46120612-46120613',
      max_records: 25
    },
    run: async (ctx, args) => {
      if (args.genome_build !== 'GRCh38') {
        throw new Error(
          'genome_build must be explicitly set to GRCh38. For a GRCh37 variant, first use liftover_variant with source_build=GRCh37 and require a unique GRCh38 mapping. Automatic liftover and region conversion are not supported.'
        )
      }
      const id = text(args.dataset_id, 'dataset_id')
      if (!/^QTD\d{6}$/.test(id ?? '')) throw new Error('dataset_id must be a QTD accession')
      const max = cap(args.max_records)
      const filters: Record<string, string | number> = {}
      for (const name of ['gene_id', 'rsid', 'variant', 'pos']) {
        const value = text(args[name], name)
        if (value) filters[name] = value
      }
      if (!Object.keys(filters).length)
        throw new Error('eqtl_associations requires at least one of gene_id, rsid, variant, or pos')
      if (filters.gene_id && !/^ENSG\d{11}$/.test(String(filters.gene_id)))
        throw new Error('gene_id must be an unversioned human Ensembl gene ID')
      if (filters.rsid && !/^rs\d+$/.test(String(filters.rsid)))
        throw new Error('rsid must be rs followed by digits')
      if (
        filters.variant &&
        !/^chr(?:[1-9]|1\d|2[0-2]|X|Y)_\d+_[ACGTN]+_[ACGTN]+$/.test(String(filters.variant))
      )
        throw new Error('variant must be chrN_position_ref_alt on GRCh38')
      if (typeof filters.variant === 'string') {
        const [, chrom, position] = /^chr([\dXY]+)_(\d+)_/.exec(filters.variant)!
        region(chrom, Number(position), Number(position))
      }
      if (args.nlog10p_min !== undefined) {
        if (
          typeof args.nlog10p_min !== 'number' ||
          !Number.isFinite(args.nlog10p_min) ||
          args.nlog10p_min < 0
        )
          throw new Error('nlog10p_min must be a nonnegative finite number')
        filters.nlog10p_min = args.nlog10p_min
      }
      // Resolve only caller-supplied coordinates; current gene annotations cannot prove historical coverage.
      const location = queryRegion(filters)
      const dataset = (await datasets(ctx)).find((d) => d.dataset_id === id)
      if (!dataset) throw new Error(`Dataset ${id} is not in the pinned release-7 catalogue`)
      const records: Record<string, unknown>[] = []
      let names: string[] | undefined
      for await (const line of eqtlTabixLines(ctx, dataset.file_url, location.region)) {
        ctx.signal?.throwIfAborted()
        if (!names) {
          names = columns(line, [
            'chromosome',
            'position',
            'gene_id',
            'variant',
            'molecular_trait_id',
            'pvalue',
            'ref',
            'alt'
          ])
          continue
        }
        const r = row(line, names)
        const position = numeric(r.position, 'position')
        if (position === null || !Number.isSafeInteger(position) || position < 1)
          throw new Error('Invalid eQTL position')
        if (
          r.chromosome !== location.region.chrom ||
          position < location.region.start ||
          position > location.region.end
        )
          continue
        if (
          ['gene_id', 'rsid', 'variant'].some(
            (key) => filters[key] !== undefined && r[key] !== filters[key]
          )
        )
          continue
        const record = association(r)
        if (
          filters.nlog10p_min !== undefined &&
          (record.nlog10p === null || Number(record.nlog10p) < Number(filters.nlog10p_min))
        )
          continue
        records.push(record)
        if (records.length > max) break
      }
      return {
        dataset_id: id,
        filters,
        ...location,
        returned: Math.min(records.length, max),
        truncated: records.length > max,
        associations: records.slice(0, max),
        reference_data: reference(dataset)
      }
    }
  }
]
