import type { ToolContext, ToolDescriptor } from '../types'

// NHGRI-EBI GWAS Catalog REST API v2. The v2 endpoints return flat snake_case records wrapped in a
// HAL collection (`_embedded` + `page` + `_links.next`) — the association record already carries the
// full row shape (study accession, pubmed, effect alleles, EFO traits) that the v1 associationBySnp
// projection only exposes across several linked resources, so every tool here reads v2 directly.
const BASE = 'https://www.ebi.ac.uk/gwas/rest/api/v2'
const PAGE_SIZE = 500

// ---- upstream v2 JSON shapes (only the fields the lean rows surface) ------------------------

type V2EfoTrait = { efo_id?: string; efo_trait?: string; uri?: string }
type V2SnpAllele = { rs_id?: string; effect_allele?: string }
type V2Association = {
  association_id?: number | string
  p_value?: number
  pvalue_mantissa?: number
  pvalue_exponent?: number
  pvalue_description?: string
  or_value?: string | null
  beta?: string | null
  ci_lower?: number | null
  ci_upper?: number | null
  range?: string | null
  risk_frequency?: string
  snp_effect_allele?: string[]
  snp_allele?: V2SnpAllele[]
  locations?: string[]
  mapped_genes?: string[]
  efo_traits?: V2EfoTrait[]
  bg_efo_traits?: V2EfoTrait[]
  reported_trait?: string[]
  multi_snp_haplotype?: boolean
  snp_interaction?: boolean
  accession_id?: string
  pubmed_id?: string
  first_author?: string
}
type V2Study = {
  accession_id?: string
  disease_trait?: string
  efo_traits?: V2EfoTrait[]
  bg_efo_traits?: V2EfoTrait[]
  pubmed_id?: string
  initial_sample_size?: string
  replication_sample_size?: string
  discovery_ancestry?: unknown
  replication_ancestry?: unknown
  genotyping_technologies?: unknown
  platforms?: unknown
  cohort?: unknown
  full_summary_stats_available?: boolean
  imputed?: boolean
  gxe?: boolean
  gxg?: boolean
}
type V2Location = {
  chromosome_name?: string
  chromosome_position?: number
  region?: { name?: string }
}
type V2Variant = {
  rs_id?: string
  merged?: number
  functional_class?: string
  most_severe_consequence?: string
  alleles?: string
  mapped_genes?: string[]
  locations?: V2Location[]
  last_update_date?: string
}
type HalPage = { size?: number; totalElements?: number; totalPages?: number; number?: number }
type HalResponse<T> = {
  _embedded?: Record<string, T[]>
  _links?: { next?: { href?: string } }
  page?: HalPage
}

// ---- small helpers --------------------------------------------------------------------------

// Reads an integer arg, applying a default when unset and clamping into [lo, hi].
function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  const base = Number.isFinite(n) && v != null && v !== '' ? Math.trunc(n) : def
  return Math.min(hi, Math.max(lo, base))
}

// True for the engine's HTTP-404 error, which the get_* tools map to a found:false result.
function isNotFound(err: unknown): boolean {
  return err instanceof Error && /HTTP 404\b/.test(err.message)
}

// Walks a HAL collection following `_links.next` until max_records rows are collected or the pages
// run out; returns the rows plus the catalog's own total from the first page's `page.totalElements`.
async function walkHal<T>(
  ctx: ToolContext,
  firstUrl: string,
  embeddedKey: string,
  maxRecords: number
): Promise<{ rows: T[]; apiTotal: number }> {
  const rows: T[] = []
  let url: string | undefined = firstUrl
  let apiTotal = 0
  let first = true
  while (url && rows.length < maxRecords) {
    const resp = (await ctx.fetchJson(url)) as HalResponse<T>
    if (first) {
      apiTotal = resp.page?.totalElements ?? 0
      first = false
    }
    const page = resp._embedded?.[embeddedKey] ?? []
    for (const r of page) {
      rows.push(r)
      if (rows.length >= maxRecords) break
    }
    url = page.length > 0 ? resp._links?.next?.href : undefined
  }
  return { rows, apiTotal }
}

// Maps EFO trait refs to the lean {efo_id, efo_trait} pair used throughout.
const leanEfoTraits = (
  traits: V2EfoTrait[] | undefined
): { efo_id?: string; efo_trait?: string }[] =>
  (traits ?? []).map((t) => ({ efo_id: t.efo_id, efo_trait: t.efo_trait }))

// v2 sends "-" for the statistic a row does not carry (or_value and beta are mutually exclusive).
const orNull = (v: string | null | undefined): string | null => (v && v !== '-' ? v : null)

// Shared association-row parser — the single row shape returned by every gwas_associations_* tool.
function toAssociationRow(a: V2Association): Record<string, unknown> {
  return {
    association_id: a.association_id,
    p_value: a.p_value,
    pvalue_mantissa: a.pvalue_mantissa,
    pvalue_exponent: a.pvalue_exponent,
    pvalue_description: a.pvalue_description || null,
    or_value: orNull(a.or_value),
    beta: orNull(a.beta),
    ci_lower: a.ci_lower ?? null,
    ci_upper: a.ci_upper ?? null,
    range: a.range || null,
    risk_frequency: a.risk_frequency,
    snp_effect_alleles: a.snp_effect_allele ?? [],
    rs_ids: (a.snp_allele ?? []).map((s) => s.rs_id).filter((r): r is string => Boolean(r)),
    locations: a.locations ?? [],
    mapped_genes: a.mapped_genes ?? [],
    efo_traits: leanEfoTraits(a.efo_traits),
    bg_efo_traits: leanEfoTraits(a.bg_efo_traits),
    reported_trait: a.reported_trait ?? [],
    multi_snp_haplotype: a.multi_snp_haplotype,
    snp_interaction: a.snp_interaction,
    study_accession_id: a.accession_id,
    pubmed_id: a.pubmed_id,
    first_author: a.first_author
  }
}

// Lean study record, shared by gwas_search_studies and gwas_get_study.
function toStudyRow(s: V2Study): Record<string, unknown> {
  return {
    accession_id: s.accession_id,
    disease_trait: s.disease_trait,
    efo_traits: leanEfoTraits(s.efo_traits),
    bg_efo_traits: leanEfoTraits(s.bg_efo_traits),
    pubmed_id: s.pubmed_id,
    initial_sample_size: s.initial_sample_size,
    replication_sample_size: s.replication_sample_size,
    discovery_ancestry: s.discovery_ancestry,
    replication_ancestry: s.replication_ancestry,
    genotyping_technologies: s.genotyping_technologies,
    platforms: s.platforms,
    cohort: s.cohort,
    full_summary_stats_available: s.full_summary_stats_available,
    imputed: s.imputed,
    // Report the two interaction flags separately — v2 search rows carry gxg (gene×gene) but no
    // gxe; conflating them mislabels the data. get_study exposes both.
    gxe: s.gxe ?? null,
    gxg: s.gxg ?? null
  }
}

// Lean variant record for gwas_get_variant (GRCh38 positions).
function toVariantRow(v: V2Variant): Record<string, unknown> {
  return {
    rs_id: v.rs_id,
    merged: v.merged,
    functional_class: v.functional_class,
    most_severe_consequence: v.most_severe_consequence,
    alleles: v.alleles,
    mapped_genes: v.mapped_genes ?? [],
    locations: (v.locations ?? []).map((l) => ({
      chromosome: l.chromosome_name,
      position: l.chromosome_position,
      region: l.region?.name ?? null
    })),
    last_update_date: v.last_update_date
  }
}

// Fetches p-value-ascending association rows for one v2 filter param and shapes the common envelope.
async function fetchAssociations(
  ctx: ToolContext,
  param: string,
  value: string,
  maxRecords: number
): Promise<{ api_total: number; returned: number; truncated: boolean; associations: unknown[] }> {
  const firstUrl = `${BASE}/associations?${param}=${encodeURIComponent(value)}&size=${PAGE_SIZE}&sort=p_value&direction=asc`
  const { rows, apiTotal } = await walkHal<V2Association>(ctx, firstUrl, 'associations', maxRecords)
  const associations = rows.map(toAssociationRow)
  return {
    api_total: apiTotal,
    returned: associations.length,
    truncated: apiTotal > associations.length,
    associations
  }
}

// ---- the 7 tools ----------------------------------------------------------------------------

export const HUMANGENETICS_GWAS_TOOLS: ToolDescriptor[] = [
  {
    id: 'gwas_associations_for_variant',
    connector: 'human_genetics',
    description:
      "GWAS Catalog associations reported for one variant (rsID), most significant first. Args: rs_id (dbSNP rsID e.g. rs7412 APOE or rs699 AGT; must be the catalog's current rsID — merged/retired IDs may return zero rows rather than an error); max_records (output cap default 500; trait-hub variants can carry 1000+ associations; rows are server-sorted by p-value ascending, so a capped result is the top-signal prefix). Returns {rs_id, api_total, returned, truncated, associations}. api_total is the catalog's own total; truncated flags a capped fetch. Each association row: {association_id, p_value, pvalue_mantissa, pvalue_exponent, pvalue_description, or_value, beta, ci_lower, ci_upper, range, risk_frequency, snp_effect_alleles, rs_ids, locations, mapped_genes, efo_traits:[{efo_id, efo_trait}], bg_efo_traits, reported_trait, multi_snp_haplotype, snp_interaction, study_accession_id, pubmed_id, first_author}. or_value and beta are mutually exclusive per row (binary vs quantitative); p_value of 0.0 means p < ~1e-308 (use mantissa/exponent).",
    input: {
      type: 'object',
      properties: {
        rs_id: { type: 'string', description: 'dbSNP rsID, e.g. rs7412' },
        max_records: { type: 'integer', default: 500 }
      },
      required: ['rs_id']
    },
    required: ['rs_id'],
    returns:
      '{rs_id, api_total (page.totalElements), returned, truncated (api_total > returned), associations[]} — each row the shared association shape.',
    example:
      'result = host.mcp("human_genetics", "gwas_associations_for_variant", {"rs_id": "rs7412", "max_records": 100})',
    run: async (ctx, a) => {
      const rsId = String(a.rs_id)
      const maxRecords = clampInt(a.max_records, 500, 1, 10000)
      const res = await fetchAssociations(ctx, 'rs_id', rsId, maxRecords)
      return { rs_id: rsId, ...res }
    }
  },
  {
    id: 'gwas_associations_for_gene',
    connector: 'human_genetics',
    description:
      "GWAS Catalog associations whose variants are MAPPED to a gene (catalog's Ensembl pipeline mapping, not author-reported), most significant first. Args: gene_symbol (HGNC symbol, exact match, e.g. PCSK9, APOE; case-sensitive upstream — pass canonical uppercase; intergenic variants map to flanking genes, so rows may sit outside the gene body); max_records (cap default 500; rows server-sorted by p-value ascending). Returns {gene_symbol, api_total, returned, truncated, associations} with the same row shape as gwas_associations_for_variant. A nonexistent symbol returns api_total=0, not an error.",
    input: {
      type: 'object',
      properties: {
        gene_symbol: { type: 'string', description: 'HGNC gene symbol, exact match, e.g. PCSK9' },
        max_records: { type: 'integer', default: 500 }
      },
      required: ['gene_symbol']
    },
    required: ['gene_symbol'],
    returns:
      '{gene_symbol, api_total, returned, truncated, associations[]} — the shared association row shape.',
    example:
      'result = host.mcp("human_genetics", "gwas_associations_for_gene", {"gene_symbol": "PCSK9", "max_records": 100})',
    run: async (ctx, a) => {
      const geneSymbol = String(a.gene_symbol)
      const maxRecords = clampInt(a.max_records, 500, 1, 10000)
      const res = await fetchAssociations(ctx, 'mapped_gene', geneSymbol, maxRecords)
      return { gene_symbol: geneSymbol, ...res }
    }
  },
  {
    id: 'gwas_associations_for_trait',
    connector: 'human_genetics',
    description:
      'GWAS Catalog associations annotated to one EFO trait, most significant first. Args: efo_id (ontology term short form as used by the catalog, e.g. MONDO_0005010, EFO_0004340, HP_0003124; the catalog migrated many historical EFO ids to MONDO/HP — resolve current ids with gwas_search_traits first; pass exactly one of efo_id/efo_trait); efo_trait (exact trait LABEL alternative); max_records (cap default 500; rows p-value ascending). Returns {efo_id|efo_trait, api_total, returned, truncated, associations} with the same row shape as gwas_associations_for_variant. An unknown id/label returns api_total=0, not an error.',
    input: {
      type: 'object',
      properties: {
        efo_id: { type: 'string', description: 'EFO/MONDO/HP short form, e.g. MONDO_0005010' },
        efo_trait: { type: 'string', description: 'Exact trait label alternative' },
        max_records: { type: 'integer', default: 500 }
      }
    },
    returns:
      '{efo_id|efo_trait, api_total, returned, truncated, associations[]} — the shared association row shape.',
    example:
      'result = host.mcp("human_genetics", "gwas_associations_for_trait", {"efo_id": "MONDO_0005010", "max_records": 100})',
    run: async (ctx, a) => {
      const efoId = a.efo_id != null && String(a.efo_id).trim() !== '' ? String(a.efo_id) : null
      const efoTrait =
        a.efo_trait != null && String(a.efo_trait).trim() !== '' ? String(a.efo_trait) : null
      if ((efoId ? 1 : 0) + (efoTrait ? 1 : 0) !== 1) {
        throw new Error('gwas_associations_for_trait requires exactly one of efo_id or efo_trait.')
      }
      const maxRecords = clampInt(a.max_records, 500, 1, 10000)
      const param = efoId ? 'efo_id' : 'efo_trait'
      const value = (efoId ?? efoTrait) as string
      const res = await fetchAssociations(ctx, param, value, maxRecords)
      return { [param]: value, ...res }
    }
  },
  {
    id: 'gwas_search_traits',
    connector: 'human_genetics',
    description:
      'Search GWAS Catalog EFO trait annotations by label substring — the entry point for resolving a disease/phenotype name to the ontology ids that gwas_associations_for_trait / gwas_search_studies take. Args: query (case-insensitive substring of the trait label, e.g. "coronary" matches coronary artery disorder MONDO_0005010 etc.; the catalog mixes EFO, MONDO, HP and OBA ids — don\'t assume an EFO_ prefix); max_records (cap default 500). Returns {query, api_total, returned, truncated, efo_traits}; each row {efo_id, efo_trait, uri} sorted by label. Count-verified against the catalog\'s own total when not capped.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Trait label substring, e.g. coronary' },
        max_records: { type: 'integer', default: 500 }
      },
      required: ['query']
    },
    required: ['query'],
    returns: '{query, api_total, returned, truncated, efo_traits:[{efo_id, efo_trait, uri}]}.',
    example:
      'result = host.mcp("human_genetics", "gwas_search_traits", {"query": "coronary", "max_records": 50})',
    run: async (ctx, a) => {
      const query = String(a.query)
      const maxRecords = clampInt(a.max_records, 500, 1, 10000)
      const firstUrl = `${BASE}/efo-traits?trait=${encodeURIComponent(query)}&size=${PAGE_SIZE}`
      const { rows, apiTotal } = await walkHal<V2EfoTrait>(ctx, firstUrl, 'efo_traits', maxRecords)
      const efoTraits = rows
        .map((t) => ({ efo_id: t.efo_id, efo_trait: t.efo_trait, uri: t.uri }))
        .sort((x, y) => String(x.efo_trait ?? '').localeCompare(String(y.efo_trait ?? '')))
      return {
        query,
        api_total: apiTotal,
        returned: efoTraits.length,
        truncated: apiTotal > efoTraits.length,
        efo_traits: efoTraits
      }
    }
  },
  {
    id: 'gwas_search_studies',
    connector: 'human_genetics',
    description:
      "Search GWAS Catalog studies by trait annotation or publication. Args: efo_id (ontology short form, e.g. MONDO_0005010, resolve via gwas_search_traits; filters combine AND — usually pass one); efo_trait (exact trait label alternative); pubmed_id (PubMed ID of the study's publication, e.g. 38714703); max_records (cap default 500). Returns {filters, api_total, returned, truncated, studies}; each study row {accession_id, disease_trait, efo_traits, bg_efo_traits, pubmed_id, initial_sample_size, replication_sample_size, discovery_ancestry, replication_ancestry, genotyping_technologies, platforms, cohort, full_summary_stats_available, imputed, gxe}. Count-verified against the catalog total when not capped. At least one filter is required (the unfiltered catalog is ~90k studies).",
    input: {
      type: 'object',
      properties: {
        efo_id: { type: 'string', description: 'EFO/MONDO/HP short form' },
        efo_trait: { type: 'string', description: 'Exact trait label' },
        pubmed_id: { type: 'string', description: 'PubMed ID, e.g. 38714703' },
        max_records: { type: 'integer', default: 500 }
      }
    },
    returns:
      '{filters, api_total, returned, truncated, studies[]} — each study the lean study shape.',
    example:
      'result = host.mcp("human_genetics", "gwas_search_studies", {"efo_id": "MONDO_0005010", "max_records": 50})',
    run: async (ctx, a) => {
      const filters: Record<string, string> = {}
      if (a.efo_id != null && String(a.efo_id).trim() !== '') filters['efo_id'] = String(a.efo_id)
      if (a.efo_trait != null && String(a.efo_trait).trim() !== '')
        filters['efo_trait'] = String(a.efo_trait)
      if (a.pubmed_id != null && String(a.pubmed_id).trim() !== '')
        filters['pubmed_id'] = String(a.pubmed_id)
      if (Object.keys(filters).length === 0) {
        throw new Error(
          'gwas_search_studies requires at least one filter (efo_id, efo_trait, or pubmed_id).'
        )
      }
      const maxRecords = clampInt(a.max_records, 500, 1, 10000)
      const params = Object.entries(filters)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&')
      const firstUrl = `${BASE}/studies?${params}&size=${PAGE_SIZE}`
      const { rows, apiTotal } = await walkHal<V2Study>(ctx, firstUrl, 'studies', maxRecords)
      const studies = rows.map(toStudyRow)
      return {
        filters,
        api_total: apiTotal,
        returned: studies.length,
        truncated: apiTotal > studies.length,
        studies
      }
    }
  },
  {
    id: 'gwas_get_study',
    connector: 'human_genetics',
    description:
      'Fetch one GWAS Catalog study by its GCST accession. Args: accession_id (study accession, e.g. GCST90841394; listed in every association row as study_accession_id and in study search results). Returns {found, accession_id, study} where study is the same row shape as gwas_search_studies (null when the accession is unknown).',
    input: {
      type: 'object',
      properties: {
        accession_id: { type: 'string', description: 'Study accession, e.g. GCST90841394' }
      },
      required: ['accession_id']
    },
    required: ['accession_id'],
    returns: '{found, accession_id, study} — study is the lean study shape, null when unknown.',
    example:
      'result = host.mcp("human_genetics", "gwas_get_study", {"accession_id": "GCST90841394"})',
    run: async (ctx, a) => {
      const accessionId = String(a.accession_id)
      try {
        const study = (await ctx.fetchJson(
          `${BASE}/studies/${encodeURIComponent(accessionId)}`
        )) as V2Study
        return { found: true, accession_id: accessionId, study: toStudyRow(study) }
      } catch (err) {
        if (isNotFound(err)) return { found: false, accession_id: accessionId, study: null }
        throw err
      }
    }
  },
  {
    id: 'gwas_get_variant',
    connector: 'human_genetics',
    description:
      'Fetch one GWAS Catalog variant record (position, mapped genes, consequence) by rsID — lighter than pulling its associations. Args: rs_id (dbSNP rsID e.g. rs7412). Returns {found, rs_id, variant}; variant is {rs_id, merged, functional_class, most_severe_consequence, alleles (e.g. "C/T (forward)"), mapped_genes, locations:[{chromosome, position, region}], last_update_date} — positions GRCh38 — or null when the rsID is not in the catalog. merged=1 means the rsID was merged into another record upstream.',
    input: {
      type: 'object',
      properties: {
        rs_id: { type: 'string', description: 'dbSNP rsID, e.g. rs7412' }
      },
      required: ['rs_id']
    },
    required: ['rs_id'],
    returns:
      '{found, rs_id, variant} — variant is the lean variant shape, null when not in catalog.',
    example: 'result = host.mcp("human_genetics", "gwas_get_variant", {"rs_id": "rs7412"})',
    run: async (ctx, a) => {
      const rsId = String(a.rs_id)
      try {
        const variant = (await ctx.fetchJson(
          `${BASE}/single-nucleotide-polymorphisms/${encodeURIComponent(rsId)}`
        )) as V2Variant
        return { found: true, rs_id: rsId, variant: toVariantRow(variant) }
      } catch (err) {
        if (isNotFound(err)) return { found: false, rs_id: rsId, variant: null }
        throw err
      }
    }
  }
]
