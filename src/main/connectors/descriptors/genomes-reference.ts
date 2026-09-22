import type { ToolContext, ToolDescriptor } from '../types'

const NCBI_DATASETS = 'https://api.ncbi.nlm.nih.gov/datasets/v2'
const ACCESSION = /^GC[AF]_\d{9}\.\d+$/u
const MAX_SEQUENCE_PAGES = 100
const MAX_TAXON_PAGES = 100

type RecordMap = Record<string, unknown>

const asRecord = (value: unknown, label: string): RecordMap => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`NCBI returned an invalid ${label} record`)
  }
  return value as RecordMap
}

const asString = (value: unknown, label: string): string | null => {
  void label
  return typeof value === 'string' && value.trim() ? value : null
}

const asNumber = (value: unknown, label: string): number | null => {
  void label
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/u.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

const requireAccession = (value: unknown): string => {
  const accession = String(value ?? '')
    .trim()
    .toUpperCase()
  if (!ACCESSION.test(accession)) {
    throw new Error(
      'assembly_accession must be a versioned NCBI accession such as GCF_000001405.40'
    )
  }
  return accession
}

const arrayRecords = (value: unknown, label: string): RecordMap[] => {
  if (!Array.isArray(value)) throw new Error(`NCBI returned no ${label} list`)
  return value.map((entry) => asRecord(entry, label))
}

export type AssemblyInfo = {
  accession: string
  current_accession: string
  paired_accession: string | null
  tax_id: number
  organism_name: string
  common_name: string | null
  assembly_name: string | null
  synonym: string | null
  assembly_level: string | null
  assembly_status: string | null
  assembly_type: string | null
  refseq_category: string | null
  release_date: string | null
  paired_assembly: RecordMap | null
}

export type SequenceAlias = {
  assembly_accession: string
  chr_name: string | null
  ucsc_style_name: string | null
  sequence_name: string | null
  refseq_accession: string | null
  genbank_accession: string | null
  length: number
  assembly_unit: string | null
  assigned_molecule_location_type: string | null
  role: string | null
}

export type SequenceAliasReport = {
  assembly_accession: string
  n_sequences: number
  upstream_total_count: number
  sequences: SequenceAlias[]
}

function parseAssemblyReport(raw: unknown, requested: string): AssemblyInfo {
  const root = asRecord(raw, 'assembly report')
  const reports = arrayRecords(root.reports, 'assembly report')
  const report = reports.find(
    (entry) => entry.accession === requested || entry.current_accession === requested
  )
  if (!report) throw new Error(`NCBI returned no assembly for ${requested}`)
  const organism = asRecord(report.organism, 'organism')
  const info = asRecord(report.assembly_info, 'assembly_info')
  const taxId = asNumber(organism.tax_id, 'tax_id')
  const organismName = asString(organism.organism_name, 'organism_name')
  if (taxId === null || organismName === null) {
    throw new Error(`NCBI assembly ${requested} is missing organism identity`)
  }
  const accession = asString(report.accession, 'accession')
  const current = asString(report.current_accession, 'current_accession')
  if (accession === null) {
    throw new Error(`NCBI assembly ${requested} is missing its accession`)
  }
  if (accession !== requested) {
    throw new Error(`NCBI returned an assembly version different from requested ${requested}`)
  }
  const normalizedCurrent = current ?? requested
  if (current !== null && !ACCESSION.test(current)) {
    throw new Error(`NCBI returned an invalid current assembly accession for ${requested}`)
  }
  return {
    accession,
    current_accession: normalizedCurrent,
    paired_accession: asString(report.paired_accession, 'paired_accession'),
    tax_id: taxId,
    organism_name: organismName,
    common_name: asString(organism.common_name, 'common_name'),
    assembly_name: asString(info.assembly_name, 'assembly_name'),
    synonym: asString(info.synonym, 'synonym'),
    assembly_level: asString(info.assembly_level, 'assembly_level'),
    assembly_status: asString(info.assembly_status, 'assembly_status'),
    assembly_type: asString(info.assembly_type, 'assembly_type'),
    refseq_category: asString(info.refseq_category, 'refseq_category'),
    release_date: asString(info.release_date, 'release_date'),
    paired_assembly:
      typeof info.paired_assembly === 'object' && info.paired_assembly !== null
        ? (info.paired_assembly as RecordMap)
        : null
  }
}

export async function getAssemblyInfo(ctx: ToolContext, value: unknown): Promise<AssemblyInfo> {
  const accession = requireAccession(value)
  const params = new URLSearchParams({ 'filters.assembly_version': 'all_assemblies' })
  const raw = await ctx.fetchJson(
    `${NCBI_DATASETS}/genome/accession/${accession}/dataset_report?${params.toString()}`
  )
  return parseAssemblyReport(raw, accession)
}

function parseSequenceReport(entry: RecordMap, requested: string): SequenceAlias {
  const assembly = asString(entry.assembly_accession, 'assembly_accession')
  const length = asNumber(entry.length, 'length')
  if (assembly !== requested || length === null || length <= 0) {
    throw new Error(`NCBI returned a malformed sequence for ${requested}`)
  }
  return {
    assembly_accession: assembly,
    chr_name: asString(entry.chr_name, 'chr_name'),
    ucsc_style_name: asString(entry.ucsc_style_name, 'ucsc_style_name'),
    sequence_name: asString(entry.sequence_name, 'sequence_name'),
    refseq_accession: asString(entry.refseq_accession, 'refseq_accession'),
    genbank_accession: asString(entry.genbank_accession, 'genbank_accession'),
    length,
    assembly_unit: asString(entry.assembly_unit, 'assembly_unit'),
    assigned_molecule_location_type: asString(
      entry.assigned_molecule_location_type,
      'assigned_molecule_location_type'
    ),
    role: asString(entry.role, 'role')
  }
}

export async function getSequenceAliases(
  ctx: ToolContext,
  value: unknown,
  query?: unknown
): Promise<SequenceAliasReport> {
  const accession = requireAccession(value)
  const wanted = query == null || String(query).trim() === '' ? null : String(query).trim()
  const rows: SequenceAlias[] = []
  let pageToken: string | null = null
  let declaredTotal: number | null = null
  const seenTokens = new Set<string>()
  let exhausted = false
  for (let page = 0; page < MAX_SEQUENCE_PAGES; page += 1) {
    const params = new URLSearchParams({ page_size: '1000' })
    if (pageToken) params.set('page_token', pageToken)
    const raw = asRecord(
      await ctx.fetchJson(
        `${NCBI_DATASETS}/genome/accession/${accession}/sequence_reports?${params.toString()}`
      ),
      'sequence report'
    )
    const total = asNumber(raw.total_count, 'total_count')
    if (declaredTotal === null && total === null) {
      throw new Error(`NCBI sequence report for ${accession} has no total_count on its first page`)
    }
    if (declaredTotal === null) declaredTotal = total
    else if (total !== null && declaredTotal !== total)
      throw new Error(`NCBI sequence count changed while reading ${accession}`)
    for (const entry of arrayRecords(raw.reports, 'sequence'))
      rows.push(parseSequenceReport(entry, accession))
    const next = asString(raw.next_page_token, 'next_page_token')
    if (!next) {
      exhausted = true
      break
    }
    if (seenTokens.has(next)) throw new Error(`NCBI sequence pagination loop for ${accession}`)
    seenTokens.add(next)
    pageToken = next
  }
  if (!exhausted) {
    throw new Error(
      `NCBI sequence pagination exceeded ${MAX_SEQUENCE_PAGES} pages for ${accession}`
    )
  }
  if (declaredTotal === null) throw new Error(`NCBI returned no sequence reports for ${accession}`)
  if (rows.length === 0) throw new Error(`NCBI returned no sequence reports for ${accession}`)
  const sequences = filterSequenceAliases(rows, wanted)
  // Keep NCBI's upstream total separate from the number of materialized rows. The API documents
  // total_count as a cross-page summary, and some assemblies include additional scaffold rows.
  return {
    assembly_accession: accession,
    n_sequences: rows.length,
    upstream_total_count: declaredTotal,
    sequences
  }
}

export function filterSequenceAliases(
  rows: SequenceAlias[],
  query: string | null
): SequenceAlias[] {
  if (!query) return rows
  return rows.filter((row) => {
    const values = [
      row.ucsc_style_name,
      row.sequence_name,
      row.refseq_accession,
      row.genbank_accession
    ]
    // chr_name is an alias only for an assembled molecule. Alt/unlocalized sequences share it.
    if (row.role === 'assembled-molecule') values.push(row.chr_name)
    return values.some(
      (candidate) => candidate !== null && candidate.toLowerCase() === query.toLowerCase()
    )
  })
}

function parseTaxonMatches(raw: unknown): Record<string, unknown>[] {
  const root = asRecord(raw, 'taxonomy report')
  const reports = arrayRecords(root.reports, 'taxonomy')
  return reports.flatMap((report) => {
    const taxonomy = report.taxonomy
    if (typeof taxonomy !== 'object' || taxonomy === null) return []
    const t = taxonomy as RecordMap
    const taxId = asNumber(t.tax_id, 'tax_id')
    const scientific = asRecord(t.current_scientific_name, 'scientific name')
    const scientificName = asString(scientific.name, 'scientific name')
    if (taxId === null || scientificName === null) return []
    return [
      {
        tax_id: taxId,
        scientific_name: scientificName,
        common_name: asString(t.curator_common_name, 'common_name'),
        rank: asString(t.rank, 'rank')
      }
    ]
  })
}

export const GENOMES_REFERENCE_TOOLS: ToolDescriptor[] = [
  {
    id: 'ncbi_resolve_taxon',
    connector: 'genomes',
    description:
      'Resolve a species or taxon name to NCBI Taxonomy identifiers. Accepts a scientific/common name or numeric TaxID; returns every upstream match so ambiguous names are not silently assigned to the first result.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        max_matches: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
      },
      required: ['query'],
      additionalProperties: false
    },
    returns:
      '{query, n_matches, ambiguous, matches_truncated, matches:[{tax_id, scientific_name, common_name, rank}]}',
    example: 'const result = await host.mcp("genomes", "ncbi_resolve_taxon", {"query": "human"})',
    run: async (ctx, args) => {
      const query = String(args.query ?? '').trim()
      if (!query) throw new Error('query must not be empty')
      const requestedMax = Number(args.max_matches ?? 20)
      const max = Number.isFinite(requestedMax) ? Math.max(1, Math.min(100, requestedMax)) : 20
      const all: Record<string, unknown>[] = []
      let pageToken: string | null = null
      const seenTokens = new Set<string>()
      let exhausted = false
      for (let page = 0; page < MAX_TAXON_PAGES; page += 1) {
        const params = new URLSearchParams({ page_size: '1000' })
        if (pageToken) params.set('page_token', pageToken)
        const raw = await ctx.fetchJson(
          `${NCBI_DATASETS}/taxonomy/taxon/${encodeURIComponent(query)}/dataset_report?${params.toString()}`
        )
        all.push(...parseTaxonMatches(raw))
        const next = asString(asRecord(raw, 'taxonomy report').next_page_token, 'next_page_token')
        if (!next) {
          exhausted = true
          break
        }
        if (seenTokens.has(next)) throw new Error(`NCBI taxonomy pagination loop for '${query}'`)
        seenTokens.add(next)
        pageToken = next
      }
      if (!exhausted) {
        throw new Error(`NCBI taxonomy pagination exceeded ${MAX_TAXON_PAGES} pages for '${query}'`)
      }
      if (all.length === 0) throw new Error(`NCBI found no taxon match for '${query}'`)
      const matches = all.slice(0, max)
      return {
        query,
        n_matches: all.length,
        ambiguous: all.length > 1,
        matches,
        matches_truncated: all.length > matches.length
      }
    }
  },
  {
    id: 'ncbi_get_assembly_info',
    connector: 'genomes',
    description:
      'Return the exact NCBI genome assembly identity for a versioned GCF/GCA accession, including taxon, assembly name, UCSC synonym, status, and paired RefSeq/GenBank accession. Versionless accessions are rejected to prevent reproducibility and species-compatibility errors.',
    input: {
      type: 'object',
      properties: { assembly_accession: { type: 'string', pattern: '^GC[AF]_[0-9]{9}\\.[0-9]+$' } },
      required: ['assembly_accession'],
      additionalProperties: false
    },
    returns:
      '{accession, current_accession, paired_accession, tax_id, organism_name, common_name, assembly_name, synonym, assembly_level, assembly_status, assembly_type, refseq_category, release_date, paired_assembly}',
    example:
      'const result = await host.mcp("genomes", "ncbi_get_assembly_info", {"assembly_accession": "GCF_000001405.40"})',
    run: async (ctx, args) => getAssemblyInfo(ctx, args.assembly_accession)
  },
  {
    id: 'ncbi_get_sequence_aliases',
    connector: 'genomes',
    description:
      'List sequence names and exact UCSC/RefSeq/GenBank aliases for one versioned NCBI assembly. Optionally resolve one sequence name; ambiguous shared chromosome labels are retained as multiple matches instead of choosing an alt or unlocalized scaffold. Results are a bounded prefix controlled by max_sequences (default 200); use a larger cap when the full assembly report is needed.',
    input: {
      type: 'object',
      properties: {
        assembly_accession: { type: 'string', pattern: '^GC[AF]_[0-9]{9}\\.[0-9]+$' },
        sequence: { type: 'string', minLength: 1, maxLength: 200 },
        max_sequences: { type: 'integer', minimum: 1, maximum: 5000, default: 200 }
      },
      required: ['assembly_accession'],
      additionalProperties: false
    },
    returns:
      '{assembly_accession, n_sequences, upstream_total_count, n_matches, n_returned, matches_truncated, sequences:[{assembly_accession, chr_name, ucsc_style_name, sequence_name, refseq_accession, genbank_accession, length, assembly_unit, assigned_molecule_location_type, role}]}',
    example:
      'const result = await host.mcp("genomes", "ncbi_get_sequence_aliases", {"assembly_accession": "GCF_000001405.40", "sequence": "chr1"})',
    run: async (ctx, args) => {
      const requestedMax = Number(args.max_sequences ?? 200)
      const max = Number.isFinite(requestedMax) ? Math.max(1, Math.min(5000, requestedMax)) : 200
      const result = await getSequenceAliases(ctx, args.assembly_accession, args.sequence)
      const sequences = result.sequences.slice(0, max)
      return {
        ...result,
        n_matches: result.sequences.length,
        n_returned: sequences.length,
        matches_truncated: result.sequences.length > sequences.length,
        sequences
      }
    }
  }
]
