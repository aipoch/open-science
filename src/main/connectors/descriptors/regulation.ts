import type { ToolContext, ToolDescriptor } from '../types'

// Gene-regulation domain connector aggregating three public REST APIs, mirroring the upstream
// mcp-regulation server: ENCODE portal (functional-genomics experiments/biosamples/files), JASPAR
// (TF binding profiles), and UniBind (ChIP-seq-derived direct TFBS). All read-only; the engine
// retries 429/5xx. Complete result sets are paged server-side and count-verified (`total`/`count`
// exact), with a `truncated` flag when row output is capped.
const ENCODE = 'https://www.encodeproject.org'
const JASPAR = 'https://jaspar.elixir.no/api/v1'
const UNIBIND = 'https://unibind.uio.no/api/v1'
const UCSC = 'https://api.genome.ucsc.edu'

// ENCODE /report/ page size (the portal default of 25 is the naive-baseline trap); JASPAR/UniBind DRF
// page sizes the servers silently cap at.
const ENCODE_PAGE_SIZE = 100
const JASPAR_PAGE_SIZE = 1000
const UNIBIND_PAGE_SIZE = 500

// UniBind region-query bounds: hubApi items scanned per call and the max region span.
const REGION_FETCH_CAP = 20_000
const MAX_REGION_SPAN = 1_000_000

// The ENCODE `organism` filter is expressed via the replicate donor's scientific name.
const ORGANISM_FIELD = 'replicates.library.biosample.donor.organism.scientific_name'

// Genomes served per UniBind hub (from the hubs' registered dbList; spo2 exists only in Permissive).
const HUB_GENOMES: Record<string, readonly string[]> = {
  Robust: ['hg38', 'mm10', 'ce11', 'dm6', 'danRer11', 'sacCer3', 'rn6', 'araTha1'],
  Permissive: ['hg38', 'mm10', 'ce11', 'dm6', 'danRer11', 'sacCer3', 'rn6', 'araTha1', 'spo2']
}

// ENCODE answers a zero-hit search with HTTP 404 (body {total:0}); the engine surfaces that as an
// "HTTP 404" error, which the search walk treats as an empty result set instead of a failure.
function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.includes('HTTP 404')
}

// The ENCODE portal returns HTTP 405 to any User-Agent beginning with "Mozilla/..." (an anti-bot
// rule), which is exactly the shared engine default UA. ToolContext.fetchJson can't override the UA,
// so ENCODE requests go through this direct global-fetch wrapper with a plain UA (the same pattern
// zinc.ts / genes-reactome.ts use). It reproduces the engine's timeout + transient-status retry so
// ENCODE calls stay as resilient as ctx.fetchJson. JASPAR and UniBind use ctx.fetchJson unchanged.
const ENCODE_UA = 'OpenScience/1.0 (+https://github.com/aipoch/open-science)'
const ENCODE_TIMEOUT_MS = 60_000
const ENCODE_RETRIES = 3
const ENCODE_RETRYABLE = new Set([429, 500, 502, 503, 504])
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function encodeFetchJson(url: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ENCODE_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': ENCODE_UA },
        signal: controller.signal
      })
    } catch (err) {
      if (attempt < ENCODE_RETRIES) {
        await sleep(Math.min(400 * 2 ** attempt, 4000))
        continue
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
    if (res.ok) return res.json()
    if (attempt < ENCODE_RETRIES && ENCODE_RETRYABLE.has(res.status)) {
      await sleep(Math.min(400 * 2 ** attempt, 4000))
      continue
    }
    throw new Error(`HTTP ${res.status} for ${url}`)
  }
}

type DrfPage = { count?: number; results?: unknown[]; next?: string | null }
type EncodeReport = { total?: number; '@graph'?: Record<string, unknown>[] }

// Embedded ENCODE objects may arrive as dicts or bare @id strings depending on the frame; pick the
// first human-readable label the object carries.
function embeddedName(obj: unknown): unknown {
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>
    return o.title ?? o.term_name ?? o.label ?? o.name ?? o['@id']
  }
  return obj
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function sortedStrings(v: unknown): string[] {
  return Array.isArray(v) ? [...v].map(String).sort() : []
}

// ENCODE stable-field record builders — extract the documented, reproducible subset of the full
// portal object (volatile audits/analyses/internal status are excluded upstream and here).
function experimentRecord(doc: Record<string, unknown>): Record<string, unknown> {
  const target = doc.target
  const bio = asRecord(doc.biosample_ontology)
  const award = asRecord(doc.award)
  return {
    record_type: 'experiment',
    accession: doc.accession,
    status: doc.status,
    assay_term_name: doc.assay_term_name,
    assay_title: doc.assay_title,
    target_label: target && typeof target === 'object' ? asRecord(target).label : target,
    biosample_term_name: bio.term_name ?? null,
    biosample_classification: bio.classification ?? null,
    biosample_summary: doc.biosample_summary,
    description: doc.description,
    lab: embeddedName(doc.lab),
    award_project: typeof doc.award === 'object' ? (award.project ?? null) : null,
    date_released: doc.date_released,
    date_submitted: doc.date_submitted,
    assembly: sortedStrings(doc.assembly),
    bio_replicate_count: doc.bio_replicate_count,
    tech_replicate_count: doc.tech_replicate_count,
    replication_type: doc.replication_type,
    dbxrefs: sortedStrings(doc.dbxrefs),
    doi: doc.doi,
    uuid: doc.uuid
  }
}

function fileRecord(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    record_type: 'file',
    accession: doc.accession,
    status: doc.status,
    file_format: doc.file_format,
    file_format_type: doc.file_format_type,
    output_type: doc.output_type,
    output_category: doc.output_category,
    assay_term_name: doc.assay_term_name,
    assembly: doc.assembly,
    dataset: doc.dataset,
    biological_replicates: Array.isArray(doc.biological_replicates)
      ? [...doc.biological_replicates].sort((a, b) => Number(a) - Number(b))
      : [],
    file_size: doc.file_size,
    md5sum: doc.md5sum,
    content_md5sum: doc.content_md5sum,
    run_type: doc.run_type,
    read_length: doc.read_length,
    lab: embeddedName(doc.lab),
    date_created: doc.date_created,
    href: doc.href,
    uuid: doc.uuid
  }
}

function biosampleRecord(doc: Record<string, unknown>): Record<string, unknown> {
  const bio = asRecord(doc.biosample_ontology)
  const organism = doc.organism
  const donor = doc.donor
  const treatments = Array.isArray(doc.treatments)
    ? doc.treatments
        .map((t) => asRecord(t).treatment_term_name)
        .filter((n): n is string => typeof n === 'string')
        .sort()
    : []
  const mods = Array.isArray(doc.genetic_modifications)
    ? doc.genetic_modifications
        .map((m) => (m && typeof m === 'object' ? asRecord(m)['@id'] : m))
        .map(String)
        .sort()
    : []
  return {
    record_type: 'biosample',
    accession: doc.accession,
    status: doc.status,
    term_name: bio.term_name ?? null,
    classification: bio.classification ?? null,
    organism:
      organism && typeof organism === 'object' ? asRecord(organism).scientific_name : organism,
    donor: donor && typeof donor === 'object' ? asRecord(donor).accession : donor,
    source: embeddedName(doc.source),
    lab: embeddedName(doc.lab),
    summary: doc.summary,
    life_stage: doc.life_stage,
    age_display: doc.age_display,
    sex: doc.sex,
    treatments,
    genetic_modifications: mods,
    date_created: doc.date_created,
    uuid: doc.uuid
  }
}

// Builds one /report/ page URL: sort=accession makes the from-walk cover exactly the full set
// (/search/ ignores `from` upstream, so all paging goes through /report/).
function encodeReportUrl(
  type: string,
  filters: Record<string, unknown>,
  fields: string[],
  dateCutoff: string | undefined,
  dateField: string,
  from: number
): string {
  const p = new URLSearchParams()
  p.set('type', type)
  p.set('format', 'json')
  p.set('sort', 'accession')
  p.set('limit', String(ENCODE_PAGE_SIZE))
  p.set('from', String(from))
  for (const [k, v] of Object.entries(filters)) {
    if (v != null && v !== '') p.set(k, String(v))
  }
  if (dateCutoff) p.set('advancedQuery', `${dateField}:[* TO ${dateCutoff}]`)
  for (const f of fields) p.append('field', f)
  return `${ENCODE}/report/?${p.toString()}`
}

// Walks /report/ until every row is collected, then verifies the count: the collected row count must
// equal the API's own `total`, else the retrieval is incomplete and raises.
async function encodeSearchAll(
  type: string,
  filters: Record<string, unknown>,
  fields: string[],
  dateCutoff: string | undefined,
  dateField: string
): Promise<{ total: number; rows: Record<string, unknown>[]; accessions: string[] }> {
  const rows: Record<string, unknown>[] = []
  const seen = new Set<unknown>()
  let total = 0
  let offset = 0
  for (;;) {
    let doc: EncodeReport
    try {
      doc = (await encodeFetchJson(
        encodeReportUrl(type, filters, fields, dateCutoff, dateField, offset)
      )) as EncodeReport
    } catch (err) {
      // Documented zero-hit 404 on an empty search — surface as an empty, count-verified result.
      if (isNotFound(err) && rows.length === 0) {
        total = 0
        break
      }
      throw err
    }
    total = doc.total ?? 0
    const graph = doc['@graph'] ?? []
    for (const row of graph) {
      const acc = row.accession ?? row['@id']
      if (!seen.has(acc)) {
        seen.add(acc)
        rows.push(row)
      }
    }
    offset += graph.length
    if (graph.length === 0 || rows.length >= total) break
  }
  if (rows.length !== total) {
    throw new Error(
      `ENCODE pagination incomplete for ${type}: collected ${rows.length} of ${total}`
    )
  }
  const accessions = rows
    .map((r) => r.accession)
    .filter((a): a is string => typeof a === 'string')
    .sort()
  return { total, rows, accessions }
}

// Reshapes a walked ENCODE result: exact total + full accession list + a capped row list.
function encodeTruncate(
  out: { total: number; rows: Record<string, unknown>[]; accessions: string[] },
  rowsKey: string,
  maxRows: number
): Record<string, unknown> {
  const kept = out.rows.slice(0, maxRows)
  return {
    total: out.total,
    returned: kept.length,
    truncated: kept.length < out.rows.length,
    accessions: out.accessions,
    [rowsKey]: kept
  }
}

// Merges args-derived filters with any caller-supplied portal field filters (extra_filters).
function withExtraFilters(base: Record<string, unknown>, extra: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra as Record<string, unknown>)) out[k] = v
  }
  return out
}

const EXPERIMENT_FIELDS = [
  'accession',
  'assay_title',
  'assay_term_name',
  'target.label',
  'biosample_ontology.term_name',
  'status',
  'date_released',
  'lab.title'
]
const BIOSAMPLE_FIELDS = [
  'accession',
  'biosample_ontology.term_name',
  'biosample_ontology.classification',
  'organism.scientific_name',
  'status',
  'lab.title',
  'summary',
  'date_created'
]
const FILE_FIELDS = [
  'accession',
  'file_format',
  'output_type',
  'assay_term_name',
  'assembly',
  'dataset',
  'status',
  'file_size',
  'date_created'
]

// Full DRF pagination walk (JASPAR): page_size pinned to the server cap, `next` followed to the end,
// then count-verified against the API's own `count`.
async function jasparWalk(
  ctx: ToolContext,
  path: string,
  params: Record<string, unknown>
): Promise<{ count: number; results: unknown[] }> {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') p.set(k, String(v))
  }
  p.set('page_size', String(JASPAR_PAGE_SIZE))
  let doc = (await ctx.fetchJson(`${JASPAR}${path}?${p.toString()}`)) as DrfPage
  const count = doc.count ?? 0
  const results: unknown[] = [...(doc.results ?? [])]
  let next = doc.next
  while (next) {
    doc = (await ctx.fetchJson(next)) as DrfPage
    results.push(...(doc.results ?? []))
    next = doc.next
  }
  if (results.length !== count) {
    throw new Error(
      `JASPAR pagination walk of ${path} returned ${results.length} rows, count=${count}`
    )
  }
  return { count, results }
}

// Splits a UniBind dataset id '<identifier>.<cell_line>.<tf>' (cell_line may embed dots).
function parseTfId(tfId: string): { identifier: string | null; cell_line: string | null } {
  const parts = tfId.split('.')
  if (parts.length < 3) return { identifier: null, cell_line: null }
  return { identifier: parts[0], cell_line: parts.slice(1, -1).join('.') }
}

// Splits a hubApi bigBed item name '<dataset>_<cell-line>_<TF>_<JASPAR matrix>'.
function parseSiteName(name: string): {
  dataset: string | null
  cell_line: string | null
  tf_name: string | null
  jaspar_matrix: string | null
} {
  const parts = name.split('_')
  if (parts.length < 4) {
    return { dataset: null, cell_line: null, tf_name: null, jaspar_matrix: null }
  }
  return {
    dataset: parts[0],
    cell_line: parts.slice(1, -2).join('_'),
    tf_name: parts[parts.length - 2],
    jaspar_matrix: parts[parts.length - 1]
  }
}

type UnibindTfbsEntry = Record<string, unknown>
type UnibindDataset = {
  tf_id?: string
  tf_name?: string
  identifier?: unknown
  cell_line?: unknown
  biological_condition?: unknown
  jaspar_id?: unknown
  prediction_models?: unknown
  total_peaks?: unknown
  tfbs?: Record<string, UnibindTfbsEntry[]>[]
}
type UcscTrackRow = {
  chrom: string
  chromStart: number
  chromEnd: number
  strand?: string
  name?: string
}
type UcscTrackResponse = {
  UniBind?: UcscTrackRow[] | Record<string, UcscTrackRow[]>
  maxItemsLimit?: boolean
}

export const REGULATION_TOOLS: ToolDescriptor[] = [
  // ---- ENCODE --------------------------------------------------------------
  {
    id: 'encode_search_experiments',
    connector: 'regulation',
    description:
      'Search ENCODE functional-genomics experiments (ChIP-seq, ATAC-seq, ...). Filters: assay_title (e.g. "TF ChIP-seq"), target (protein label, e.g. "CTCF"), organism (scientific name), status (default "released"), date_released_before (ISO date — a closed window), plus arbitrary portal field filters via extra_filters. The full result set is paged and count-verified; `accessions` lists every match, at most max_rows row summaries are returned.',
    input: {
      type: 'object',
      properties: {
        assay_title: { type: 'string' },
        target: { type: 'string' },
        organism: { type: 'string' },
        status: { type: 'string', default: 'released' },
        date_released_before: { type: 'string' },
        extra_filters: { type: 'object', additionalProperties: { type: 'string' } },
        max_rows: { type: 'integer', default: 100 }
      }
    },
    returns:
      '`{ total (exact), returned, truncated, accessions: [every matching accession, sorted], experiments: [ report rows: accession, assay_title, assay_term_name, target.label, biosample_ontology.term_name, status, date_released, lab.title ] }`.',
    example:
      'const result = await host.mcp("regulation", "encode_search_experiments", {"target": "CTCF", "assay_title": "TF ChIP-seq", "max_rows": 50})',
    run: async (_ctx, a) => {
      const filters = withExtraFilters(
        {
          status: a.status ?? 'released',
          assay_title: a.assay_title,
          'target.label': a.target,
          [ORGANISM_FIELD]: a.organism
        },
        a.extra_filters
      )
      const out = await encodeSearchAll(
        'Experiment',
        filters,
        EXPERIMENT_FIELDS,
        a.date_released_before ? String(a.date_released_before) : undefined,
        'date_released'
      )
      return encodeTruncate(out, 'experiments', Math.max(0, Number(a.max_rows ?? 100)))
    }
  },
  {
    id: 'encode_search_biosamples',
    connector: 'regulation',
    description:
      'Search ENCODE biosamples (cell lines, tissues, primary cells). Filters: term_name (ontology term, e.g. "K562"), classification ("cell line", "tissue", ...), organism (scientific name), status (default "released"), date_created_before (ISO date), plus arbitrary portal field filters via extra_filters. Complete, count-verified: `accessions` is the full match list, at most max_rows row summaries are returned.',
    input: {
      type: 'object',
      properties: {
        term_name: { type: 'string' },
        classification: { type: 'string' },
        organism: { type: 'string' },
        status: { type: 'string', default: 'released' },
        date_created_before: { type: 'string' },
        extra_filters: { type: 'object', additionalProperties: { type: 'string' } },
        max_rows: { type: 'integer', default: 100 }
      }
    },
    returns:
      '`{ total, returned, truncated, accessions: [...], biosamples: [ report rows: accession, biosample_ontology.term_name/classification, organism.scientific_name, status, lab.title, summary, date_created ] }`.',
    example:
      'const result = await host.mcp("regulation", "encode_search_biosamples", {"term_name": "K562", "classification": "cell line", "max_rows": 25})',
    run: async (_ctx, a) => {
      const filters = withExtraFilters(
        {
          status: a.status ?? 'released',
          'biosample_ontology.term_name': a.term_name,
          'biosample_ontology.classification': a.classification,
          'organism.scientific_name': a.organism
        },
        a.extra_filters
      )
      const out = await encodeSearchAll(
        'Biosample',
        filters,
        BIOSAMPLE_FIELDS,
        a.date_created_before ? String(a.date_created_before) : undefined,
        'date_created'
      )
      return encodeTruncate(out, 'biosamples', Math.max(0, Number(a.max_rows ?? 100)))
    }
  },
  {
    id: 'encode_list_files',
    connector: 'regulation',
    description:
      'List ENCODE data files by format / assay / biosample. Filters: file_format ("fastq", "bam", "bigWig", "bed", ...), assay_term_name (the ontology term e.g. "ChIP-seq" — NOT the display assay_title like "TF ChIP-seq", which matches nothing; pass titles via extra_filters={"assay_title": ...}), biosample_term_name (e.g. "K562"), status (default "released"), date_created_before, plus arbitrary portal field filters via extra_filters. File queries match millions of rows unfiltered — always combine several filters. Complete + count-verified; at most max_rows row summaries returned.',
    input: {
      type: 'object',
      properties: {
        file_format: { type: 'string' },
        assay_term_name: { type: 'string' },
        biosample_term_name: { type: 'string' },
        status: { type: 'string', default: 'released' },
        date_created_before: { type: 'string' },
        extra_filters: { type: 'object', additionalProperties: { type: 'string' } },
        max_rows: { type: 'integer', default: 100 }
      }
    },
    returns:
      '`{ total, returned, truncated, accessions: [...], files: [ report rows: accession, file_format, output_type, assay_term_name, assembly, dataset, status, file_size, date_created ] }`.',
    example:
      'const result = await host.mcp("regulation", "encode_list_files", {"file_format": "bed", "assay_term_name": "ChIP-seq", "biosample_term_name": "K562", "extra_filters": {"output_type": "peaks", "assembly": "GRCh38"}, "max_rows": 50})',
    run: async (_ctx, a) => {
      const filters = withExtraFilters(
        {
          status: a.status ?? 'released',
          file_format: a.file_format,
          assay_term_name: a.assay_term_name,
          'biosample_ontology.term_name': a.biosample_term_name
        },
        a.extra_filters
      )
      const out = await encodeSearchAll(
        'File',
        filters,
        FILE_FIELDS,
        a.date_created_before ? String(a.date_created_before) : undefined,
        'date_created'
      )
      return encodeTruncate(out, 'files', Math.max(0, Number(a.max_rows ?? 100)))
    }
  },
  {
    id: 'encode_get_experiment',
    connector: 'regulation',
    description:
      'Get one ENCODE experiment by accession (e.g. "ENCSR000AKP"). Returns a stable-field record: assay, target, biosample ontology + summary, description, lab, award project, release/submission dates, assemblies, replicate counts, replication type, dbxrefs, DOI and uuid. Volatile portal fields (audits, analyses, internal status) are excluded.',
    input: {
      type: 'object',
      properties: { accession: { type: 'string' } },
      required: ['accession']
    },
    required: ['accession'],
    returns:
      '`{ record_type: "experiment", accession, status, assay_term_name, assay_title, target_label, biosample_term_name, biosample_classification, biosample_summary, description, lab, award_project, date_released, date_submitted, assembly: [...], bio_replicate_count, tech_replicate_count, replication_type, dbxrefs: [...], doi, uuid }`.',
    example:
      'const result = await host.mcp("regulation", "encode_get_experiment", {"accession": "ENCSR000AKP"})',
    run: async (_ctx, a) => {
      const raw = await encodeFetchJson(
        `${ENCODE}/${encodeURIComponent(String(a.accession))}/?format=json`
      )
      return experimentRecord(asRecord(raw))
    }
  },
  {
    id: 'encode_get_file',
    connector: 'regulation',
    description:
      'Get one ENCODE file by accession (e.g. "ENCFF002JUR"). Returns a stable-field record: format, output type/category, assay, assembly, parent dataset, biological replicates, file size, md5sums, run type, read length, lab, creation date, download href and uuid.',
    input: {
      type: 'object',
      properties: { accession: { type: 'string' } },
      required: ['accession']
    },
    required: ['accession'],
    returns:
      '`{ record_type: "file", accession, status, file_format, file_format_type, output_type, output_category, assay_term_name, assembly, dataset, biological_replicates: [...], file_size, md5sum, content_md5sum, run_type, read_length, lab, date_created, href, uuid }`.',
    example:
      'const result = await host.mcp("regulation", "encode_get_file", {"accession": "ENCFF002JUR"})',
    run: async (_ctx, a) => {
      const raw = await encodeFetchJson(
        `${ENCODE}/${encodeURIComponent(String(a.accession))}/?format=json`
      )
      return fileRecord(asRecord(raw))
    }
  },
  {
    id: 'encode_get_biosample',
    connector: 'regulation',
    description:
      'Get one ENCODE biosample by accession (e.g. "ENCBS013JZP"). Returns a stable-field record: ontology term + classification, organism, summary/description, source, donor, treatments, genetic modifications, life stage, age, sex, lab, creation date, status and uuid.',
    input: {
      type: 'object',
      properties: { accession: { type: 'string' } },
      required: ['accession']
    },
    required: ['accession'],
    returns:
      '`{ record_type: "biosample", accession, status, term_name, classification, organism, donor, source, lab, summary, life_stage, age_display, sex, treatments: [...], genetic_modifications: [...], date_created, uuid }`.',
    example:
      'const result = await host.mcp("regulation", "encode_get_biosample", {"accession": "ENCBS013JZP"})',
    run: async (_ctx, a) => {
      const raw = await encodeFetchJson(
        `${ENCODE}/${encodeURIComponent(String(a.accession))}/?format=json`
      )
      return biosampleRecord(asRecord(raw))
    }
  },
  // ---- JASPAR --------------------------------------------------------------
  {
    id: 'jaspar_get_matrix',
    connector: 'regulation',
    description:
      'Get one JASPAR TF binding profile by VERSIONED matrix id (e.g. "MA0002.2"). Returns the full record: position frequency matrix (pfm), TF name/class/family, species, data type, literature references (pubmed/medline), sequence logo URL. Requires a versioned id ("MA0002.2", not "MA0002") — use jaspar_matrix_versions to enumerate versions. Versioned matrices are immutable, so results are reproducible.',
    input: {
      type: 'object',
      properties: { matrix_id: { type: 'string' } },
      required: ['matrix_id']
    },
    required: ['matrix_id'],
    returns:
      '`{ matrix_id, name, base_id, version, collection, pfm: { A:[...], C:[...], G:[...], T:[...] }, class, family, species: [ { tax_id, name } ], pubmed_ids, uniprot_ids, tax_group, type, sequence_logo, versions_url, sites_url, ... }` — the full immutable JASPAR record.',
    example:
      'const result = await host.mcp("regulation", "jaspar_get_matrix", {"matrix_id": "MA0002.2"})',
    url: (a) => {
      const id = String(a.matrix_id)
      // JASPAR requires a versioned id; a base id ('MA0002') resolves to a redirect list, not a PFM.
      if (!id.includes('.')) {
        throw new Error(
          `${id} is a base id, not a versioned matrix id; use jaspar_matrix_versions to enumerate versions`
        )
      }
      return `${JASPAR}/matrix/${encodeURIComponent(id)}/`
    },
    parse: (raw) => raw
  },
  {
    id: 'jaspar_matrix_versions',
    connector: 'regulation',
    description:
      'List all versions of a JASPAR base matrix id (e.g. "MA0002"). Returns every released version with its matrix_id, name, collection and URL — count-verified. Use to pin an exact version before jaspar_get_matrix, or to track how a profile changed across releases. A versioned id ("MA0002.2") is accepted and reduced to its base.',
    input: {
      type: 'object',
      properties: { base_id: { type: 'string' } },
      required: ['base_id']
    },
    required: ['base_id'],
    returns:
      '`{ count, results: [ { matrix_id, name, base_id, version, collection, sequence_logo, url } ] }`.',
    example:
      'const result = await host.mcp("regulation", "jaspar_matrix_versions", {"base_id": "MA0002"})',
    run: async (ctx, a) => {
      const base = String(a.base_id).split('.')[0]
      return jasparWalk(ctx, `/matrix/${encodeURIComponent(base)}/versions/`, {})
    }
  },
  {
    id: 'jaspar_list_matrices',
    connector: 'regulation',
    description:
      'Search/list JASPAR TF binding profiles (the full profile catalog). Filters (all optional): collection ("CORE", "UNVALIDATED"), tax_group ("vertebrates", "plants", ...), tax_id (NCBI taxonomy id, e.g. 9606 for human — this is how you filter by species; enumerate ids with jaspar_list_species), name (exact TF name, e.g. "FOXA1"), search (free text), version="latest" (restrict to latest versions only). The full filtered catalog is paginated and count-verified; at most max_rows summary rows are returned.',
    input: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        tax_group: { type: 'string' },
        tax_id: { type: 'integer' },
        name: { type: 'string' },
        search: { type: 'string' },
        version: { type: 'string' },
        max_rows: { type: 'integer', default: 1000 }
      }
    },
    returns:
      '`{ count (exact), returned, truncated, matrices: [ { matrix_id, name, base_id, version, collection, sequence_logo, url } ] }`.',
    example:
      'const result = await host.mcp("regulation", "jaspar_list_matrices", {"tax_id": 9606, "collection": "CORE", "version": "latest", "max_rows": 200})',
    run: async (ctx, a) => {
      const out = await jasparWalk(ctx, '/matrix/', {
        collection: a.collection,
        tax_group: a.tax_group,
        tax_id: a.tax_id,
        name: a.name,
        search: a.search,
        version: a.version
      })
      const maxRows = Math.max(0, Number(a.max_rows ?? 1000))
      const kept = out.results.slice(0, maxRows)
      return {
        count: out.count,
        returned: kept.length,
        truncated: kept.length < out.results.length,
        matrices: kept
      }
    }
  },
  {
    id: 'jaspar_list_species',
    connector: 'regulation',
    description:
      'List all species with JASPAR profiles (NCBI tax_id + name); count-verified full listing. Use the tax_id values to filter jaspar_list_matrices (e.g. 9606 = Homo sapiens, 10090 = Mus musculus).',
    input: { type: 'object', properties: {} },
    returns: '`{ count, results: [ { tax_id, species, url, matrix_url } ] }`.',
    example: 'const result = await host.mcp("regulation", "jaspar_list_species", {})',
    run: async (ctx) => jasparWalk(ctx, '/species/', {})
  },
  {
    id: 'jaspar_list_taxa',
    connector: 'regulation',
    description:
      'List all JASPAR taxonomic groups (vertebrates, plants, fungi, insects, ...); count-verified full listing. Use the group names as the tax_group filter of jaspar_list_matrices.',
    input: { type: 'object', properties: {} },
    returns: '`{ count, results: [ { name, url } ] }`.',
    example: 'const result = await host.mcp("regulation", "jaspar_list_taxa", {})',
    run: async (ctx) => jasparWalk(ctx, '/taxon/', {})
  },
  {
    id: 'jaspar_list_collections',
    connector: 'regulation',
    description:
      'List all JASPAR collections (CORE, UNVALIDATED, ...); count-verified full listing. Use the collection names as the collection filter of jaspar_list_matrices (CORE = curated, non-redundant profiles).',
    input: { type: 'object', properties: {} },
    returns: '`{ count, results: [ { name, url } ] }`.',
    example: 'const result = await host.mcp("regulation", "jaspar_list_collections", {})',
    run: async (ctx) => jasparWalk(ctx, '/collections/', {})
  },
  {
    id: 'jaspar_list_releases',
    connector: 'regulation',
    description:
      'List all JASPAR database releases (year, release number, active flag); count-verified full listing. Record the active release when selecting motifs for reproducibility, or check release history before comparing results across JASPAR versions.',
    input: { type: 'object', properties: {} },
    returns: '`{ count, results: [ { year, release_number, pubmed_id, website, active, url } ] }`.',
    example: 'const result = await host.mcp("regulation", "jaspar_list_releases", {})',
    run: async (ctx) => jasparWalk(ctx, '/releases/', {})
  },
  // ---- UniBind -------------------------------------------------------------
  {
    id: 'unibind_search_tfbs',
    connector: 'regulation',
    description:
      'Search UniBind ChIP-seq datasets with high-confidence TFBS predictions (unibind.uio.no, 2021 release; direct TF-DNA interactions from ~10k datasets across 9 species). Each dataset is one (experiment, cell type, TF) triple. Filters (all optional, AND-combined, exact-match unless noted): tf_name (gene symbol, e.g. "CTCF"), cell_line (verbose UniBind title — prefer `search` for fuzzy matching), species (scientific name), collection ("Robust" = best-model / high confidence, or "Permissive"), jaspar_id (versioned, e.g. "MA0139.1"), search (free text). `total` is the API\'s exact count; at most max_rows rows are returned (a stable prefix).',
    input: {
      type: 'object',
      properties: {
        tf_name: { type: 'string' },
        cell_line: { type: 'string' },
        species: { type: 'string' },
        collection: { type: 'string', enum: ['Robust', 'Permissive'] },
        jaspar_id: { type: 'string' },
        search: { type: 'string' },
        max_rows: { type: 'integer', default: 200 }
      }
    },
    returns:
      '`{ total (exact), returned, truncated, datasets: [ { tf_id (key for unibind_get_dataset), tf_name, total_peaks (ChIP-seq peak count, NOT TFBS count), identifier, cell_line } ] }`.',
    example:
      'const result = await host.mcp("regulation", "unibind_search_tfbs", {"tf_name": "CTCF", "collection": "Robust", "max_rows": 50})',
    run: async (ctx, a) => {
      const p = new URLSearchParams()
      for (const [k, v] of Object.entries({
        tf_name: a.tf_name,
        cell_line: a.cell_line,
        species: a.species,
        collection: a.collection,
        jaspar_id: a.jaspar_id,
        search: a.search
      })) {
        if (v != null && v !== '') p.set(k, String(v))
      }
      p.set('page_size', String(UNIBIND_PAGE_SIZE))
      const maxRows = Math.max(0, Number(a.max_rows ?? 200))

      let doc = (await ctx.fetchJson(`${UNIBIND}/datasets/?${p.toString()}`)) as DrfPage
      const total = doc.count ?? 0
      const raw: Record<string, unknown>[] = [...((doc.results ?? []) as Record<string, unknown>[])]
      let next = doc.next
      while (next && raw.length < maxRows) {
        doc = (await ctx.fetchJson(next)) as DrfPage
        raw.push(...((doc.results ?? []) as Record<string, unknown>[]))
        next = doc.next
      }
      // When the whole set fits under the cap, the collected count must match the API total.
      if (next == null && raw.length !== total) {
        throw new Error(`UniBind pagination walk returned ${raw.length} rows, count=${total}`)
      }
      const datasets = raw.slice(0, maxRows).map((r) => {
        const url = String(r.url ?? '')
        const tfId = url.replace(/\/$/, '').split('/').pop() ?? ''
        return {
          tf_id: tfId,
          tf_name: r.tf_name,
          total_peaks: r.total_peaks,
          ...parseTfId(tfId)
        }
      })
      return { total, returned: datasets.length, truncated: datasets.length < total, datasets }
    }
  },
  {
    id: 'unibind_get_dataset',
    connector: 'regulation',
    description:
      'Get one UniBind dataset\'s detail: per-model TFBS counts + file URLs. tf_id is the dataset key "<identifier>.<cell_line>.<TF>" as returned by unibind_search_tfbs (e.g. "ENCSR000AUE.A549_lung_carcinoma.CTCF"). Returns the TF name, source identifiers (ENCODE/GEO/GTRD), cell lines, biological conditions, JASPAR matrix ids, ChIP-seq peak count, and one row per TFBS prediction model (DAMO/PWM/...) with total_tfbs, score/distance thresholds, adjusted CentriMo p-value, and direct BED/FASTA download URLs — use those URLs (not an MCP call) to retrieve the complete site list.',
    input: {
      type: 'object',
      properties: { tf_id: { type: 'string' } },
      required: ['tf_id']
    },
    required: ['tf_id'],
    returns:
      '`{ tf_id, tf_name, identifiers: [...], cell_lines: [...], biological_conditions: [...], jaspar_ids: [...], prediction_models: [...], total_peaks, n_models, models: [ { prediction_model, jaspar_id, jaspar_version, total_tfbs, score_threshold, distance_threshold, adj_centrimo_pvalue, bed_url, fasta_url } ] }`.',
    example:
      'const result = await host.mcp("regulation", "unibind_get_dataset", {"tf_id": "ENCSR000AUE.A549_lung_carcinoma.CTCF"})',
    url: (a) => `${UNIBIND}/datasets/${encodeURIComponent(String(a.tf_id))}/`,
    parse: (raw) => {
      const d = raw as UnibindDataset
      const models: Record<string, unknown>[] = []
      for (const modelGroup of d.tfbs ?? []) {
        for (const [modelName, entries] of Object.entries(modelGroup)) {
          for (const e of entries) {
            models.push({
              prediction_model: modelName,
              jaspar_id: e.jaspar_id,
              jaspar_version: e.jaspar_version,
              total_tfbs: e.total_tfbs,
              score_threshold: e.score_threshold,
              distance_threshold: e.distance_threshold,
              adj_centrimo_pvalue: e.adj_centrimo_pvalue,
              bed_url: e.bed_url,
              fasta_url: e.fasta_url
            })
          }
        }
      }
      return {
        tf_id: d.tf_id,
        tf_name: d.tf_name,
        identifiers: d.identifier,
        cell_lines: d.cell_line,
        biological_conditions: d.biological_condition,
        jaspar_ids: d.jaspar_id,
        prediction_models: d.prediction_models,
        total_peaks: d.total_peaks,
        n_models: models.length,
        models
      }
    }
  },
  {
    id: 'unibind_tfbs_in_region',
    connector: 'regulation',
    description:
      'TF binding sites overlapping a genomic region (UniBind 2021 maps), served via the UCSC hubApi against UniBind\'s registered public track hubs (UniBind\'s own REST API has no region endpoint). Coordinates are 0-based half-open. genome: UCSC assembly — Robust hub: hg38, mm10, ce11, dm6, danRer11, sacCer3, rn6, araTha1; Permissive adds spo2 (no hg19 — lift first). chrom: with "chr" prefix. start/end: interval, end-start <= 1,000,000 bp. HONEST-CAP: at most 20,000 items are scanned per call; region_scan_complete=false means the region has more sites than were scanned (narrow the window) and, with tf_name set, matches may be missing. n_matching counts scanned sites passing the filter; returned/truncated describe the max_sites cap.',
    input: {
      type: 'object',
      properties: {
        genome: { type: 'string' },
        chrom: { type: 'string' },
        start: { type: 'integer' },
        end: { type: 'integer' },
        tf_name: { type: 'string' },
        collection: { type: 'string', enum: ['Robust', 'Permissive'], default: 'Robust' },
        max_sites: { type: 'integer', default: 2000 }
      },
      required: ['genome', 'chrom', 'start', 'end']
    },
    required: ['genome', 'chrom', 'start', 'end'],
    returns:
      '`{ genome, chrom, start, end, collection, tf_name_filter, items_scanned, region_scan_complete, n_matching, returned, truncated, sites: [ { chrom, start, end, strand, dataset, cell_line, tf_name, jaspar_matrix } ] }`.',
    example:
      'const result = await host.mcp("regulation", "unibind_tfbs_in_region", {"genome": "hg38", "chrom": "chr1", "start": 1000000, "end": 1010000, "collection": "Robust"})',
    run: async (ctx, a) => {
      const collection = String(a.collection ?? 'Robust')
      const genome = String(a.genome)
      const chrom = String(a.chrom)
      const start = Number(a.start)
      const end = Number(a.end)
      const genomes = HUB_GENOMES[collection]
      if (!genomes) {
        throw new Error(
          `collection must be one of ${Object.keys(HUB_GENOMES).join(', ')}, got ${collection}`
        )
      }
      if (!genomes.includes(genome)) {
        throw new Error(
          `genome ${genome} is not in the UniBind ${collection} hub; valid: ${genomes.join(', ')}`
        )
      }
      if (end <= start) throw new Error('end must be > start')
      if (end - start > MAX_REGION_SPAN) {
        throw new Error(
          `region span ${end - start} exceeds the ${MAX_REGION_SPAN} bp limit; query smaller windows`
        )
      }
      const maxSites = Math.max(0, Number(a.max_sites ?? 2000))

      const hubUrl = `https://unibind.uio.no/static/data/latest/UniBind_hubs_${collection}/UCSC/hub.txt`
      const p = new URLSearchParams({
        hubUrl,
        genome,
        track: 'UniBind',
        chrom,
        start: String(start),
        end: String(end),
        maxItemsOutput: String(REGION_FETCH_CAP)
      })
      const payload = (await ctx.fetchJson(
        `${UCSC}/getData/track?${p.toString()}`
      )) as UcscTrackResponse
      if (payload.UniBind == null) {
        throw new Error(
          `hubApi response missing track data: ${JSON.stringify(payload).slice(0, 300)}`
        )
      }
      // hubApi may key rows by chromosome for multi-chrom queries; flatten to a single list.
      const raw = payload.UniBind
      const items: UcscTrackRow[] = Array.isArray(raw) ? raw : Object.values(raw).flat()
      const scanComplete = !payload.maxItemsLimit

      const wantTf = a.tf_name ? String(a.tf_name).toLowerCase() : null
      const sites: Record<string, unknown>[] = []
      for (const it of items) {
        const meta = parseSiteName(it.name ?? '')
        if (wantTf && (meta.tf_name ?? '').toLowerCase() !== wantTf) continue
        sites.push({
          chrom: it.chrom,
          start: it.chromStart,
          end: it.chromEnd,
          strand: it.strand,
          ...meta
        })
      }
      const nMatching = sites.length
      const returned = sites.slice(0, maxSites)
      return {
        genome,
        chrom,
        start,
        end,
        collection,
        tf_name_filter: a.tf_name ?? null,
        items_scanned: items.length,
        region_scan_complete: scanComplete,
        n_matching: nMatching,
        returned: returned.length,
        truncated: returned.length < nMatching || !scanComplete,
        sites: returned
      }
    }
  }
]
