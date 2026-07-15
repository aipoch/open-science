import type { ToolContext, ToolDescriptor } from '../types'

// gnomAD is GraphQL-only: every call is a POST of {query, variables} to a single endpoint. Ported
// from the upstream gnomad_variants library (client/queries/records/tool) — the 10 mirrored MCP
// methods, with the same lean field selections (the API is complexity-limited) and record shaping.
const GNOMAD_API = 'https://gnomad.broadinstitute.org/api'

// Dataset pins frozen to the 14 short-variant datasets the upstream tool exposes. Default is the
// current release gnomad_r4 (exomes+genomes, GRCh38); r2.1/exac are GRCh37, r3 is genome-only.
const DATASETS = [
  'gnomad_r4',
  'gnomad_r4_non_ukb',
  'gnomad_r3',
  'gnomad_r3_controls_and_biobanks',
  'gnomad_r3_non_cancer',
  'gnomad_r3_non_neuro',
  'gnomad_r3_non_topmed',
  'gnomad_r3_non_v2',
  'gnomad_r2_1',
  'gnomad_r2_1_controls',
  'gnomad_r2_1_non_cancer',
  'gnomad_r2_1_non_neuro',
  'gnomad_r2_1_non_topmed',
  'exac'
] as const
const SV_DATASETS = ['gnomad_sv_r4', 'gnomad_sv_r2_1'] as const
const DEFAULT_DATASET = 'gnomad_r4'
const DEFAULT_SV_DATASET = 'gnomad_sv_r4'
// Region queries are capped so a runaway window can't ask gnomAD for the whole genome.
const MAX_REGION_BP = 1_000_000

// ---- GraphQL documents (transcribed verbatim from upstream queries.py) ----------------------

const VARIANT_QUERY = `
query Variant($variantId: String!, $dataset: DatasetId!) {
  variant(variantId: $variantId, dataset: $dataset) {
    variant_id reference_genome chrom pos ref alt rsids
    exome { ac an af homozygote_count hemizygote_count filters }
    genome { ac an af homozygote_count hemizygote_count filters }
  }
}
`

const VARIANT_SEARCH_QUERY = `
query VariantSearch($query: String!, $dataset: DatasetId!) {
  variant_search(query: $query, dataset: $dataset) { variant_id }
}
`

const GENE_VARIANTS_QUERY = `
query GeneVariants($symbol: String, $geneId: String, $dataset: DatasetId!) {
  gene(gene_symbol: $symbol, gene_id: $geneId, reference_genome: GRCh38) {
    gene_id symbol start stop chrom
    variants(dataset: $dataset) {
      variant_id pos ref alt rsids
      exome { ac an af } genome { ac an af }
    }
  }
}
`

const GENE_CONSTRAINT_QUERY = `
query GeneConstraint($symbol: String, $geneId: String) {
  gene(gene_symbol: $symbol, gene_id: $geneId, reference_genome: GRCh38) {
    gene_id symbol canonical_transcript_id chrom start stop strand
    gnomad_constraint {
      exp_lof obs_lof oe_lof oe_lof_lower oe_lof_upper
      exp_mis obs_mis oe_mis oe_mis_lower oe_mis_upper
      exp_syn obs_syn oe_syn oe_syn_lower oe_syn_upper
      pli lof_z mis_z syn_z
    }
  }
}
`

const REGION_VARIANTS_QUERY = `
query RegionVariants($chrom: String!, $start: Int!, $stop: Int!, $dataset: DatasetId!) {
  region(chrom: $chrom, start: $start, stop: $stop, reference_genome: GRCh38) {
    variants(dataset: $dataset) {
      variant_id pos ref alt rsids
      exome { ac an af } genome { ac an af }
    }
  }
}
`

const LIFTOVER_QUERY = `
query Liftover($source: String!, $rg: ReferenceGenomeId!) {
  liftover(source_variant_id: $source, reference_genome: $rg) {
    source { variant_id reference_genome }
    liftover { variant_id reference_genome }
    datasets
  }
}
`

const CLINVAR_VARIANTS_QUERY = `
query ClinvarVariants($symbol: String, $geneId: String) {
  meta { clinvar_release_date }
  gene(gene_symbol: $symbol, gene_id: $geneId, reference_genome: GRCh38) {
    gene_id symbol
    clinvar_variants {
      variant_id clinvar_variation_id clinical_significance gold_stars
      review_status major_consequence pos transcript_id
      in_gnomad
    }
  }
}
`

const STRUCTURAL_VARIANTS_GENE_QUERY = `
query StructuralVariantsGene($symbol: String, $geneId: String, $dataset: StructuralVariantDatasetId!) {
  gene(gene_symbol: $symbol, gene_id: $geneId, reference_genome: GRCh38) {
    gene_id symbol
    structural_variants(dataset: $dataset) {
      variant_id consequence major_consequence ac an af homozygote_count
      hemizygote_count chrom pos end chrom2 pos2 type length filters
    }
  }
}
`

const STRUCTURAL_VARIANT_QUERY = `
query StructuralVariant($variantId: String!, $dataset: StructuralVariantDatasetId!) {
  structural_variant(variantId: $variantId, dataset: $dataset) {
    variant_id chrom pos end chrom2 pos2 type length ac an af
    homozygote_count hemizygote_count filters qual
    consequences { consequence genes }
    algorithms evidence
  }
}
`

const MITO_VARIANTS_GENE_QUERY = `
query MitochondrialVariantsGene($symbol: String, $geneId: String, $dataset: DatasetId!) {
  gene(gene_symbol: $symbol, gene_id: $geneId, reference_genome: GRCh38) {
    gene_id symbol
    mitochondrial_variants(dataset: $dataset) {
      variant_id pos ac_het ac_hom an max_heteroplasmy filters
    }
  }
}
`

const MITO_VARIANTS_REGION_QUERY = `
query MitochondrialVariantsRegion($start: Int!, $stop: Int!, $dataset: DatasetId!) {
  region(chrom: "M", start: $start, stop: $stop, reference_genome: GRCh38) {
    mitochondrial_variants(dataset: $dataset) {
      variant_id pos ac_het ac_hom an max_heteroplasmy filters
    }
  }
}
`

// ---- Minimal shapes of the gnomAD GraphQL JSON we read --------------------------------------

type FreqBlock = Record<string, unknown> | null

type ShortVariant = {
  variant_id: string
  pos?: number | null
  ref?: string | null
  alt?: string | null
  rsids?: string[] | null
  exome?: FreqBlock
  genome?: FreqBlock
}

type FullVariant = ShortVariant & {
  reference_genome?: string | null
  chrom?: string | null
}

type GeneNode = {
  gene_id: string
  symbol?: string | null
  chrom?: string | null
  start?: number | null
  stop?: number | null
  strand?: string | null
  canonical_transcript_id?: string | null
  gnomad_constraint?: Record<string, unknown> | null
  variants?: ShortVariant[] | null
  clinvar_variants?: ClinvarVariant[] | null
  structural_variants?: SvNode[] | null
  mitochondrial_variants?: MitoVariant[] | null
}

type ClinvarVariant = {
  variant_id: string
  clinvar_variation_id?: string | null
  clinical_significance?: string | null
  gold_stars?: number | null
  review_status?: string | null
  major_consequence?: string | null
  pos?: number | null
  transcript_id?: string | null
  in_gnomad?: boolean | null
}

type SvNode = {
  variant_id: string
  filters?: string[] | null
  algorithms?: string[] | null
  evidence?: string[] | null
  consequences?: Array<{ consequence?: string | null; genes?: string[] | null }> | null
  [k: string]: unknown
}

type MitoVariant = {
  variant_id: string
  pos?: number | null
  ac_het?: number | null
  ac_hom?: number | null
  an?: number | null
  max_heteroplasmy?: number | null
  filters?: string[] | null
}

type GqlResponse = {
  data?: {
    variant?: FullVariant | null
    variant_search?: Array<{ variant_id: string }> | null
    gene?: GeneNode | null
    region?: {
      variants?: ShortVariant[] | null
      mitochondrial_variants?: MitoVariant[] | null
    } | null
    liftover?: LiftoverRow[] | null
    structural_variant?: SvNode | null
    meta?: { clinvar_release_date?: string | null } | null
  } | null
  errors?: Array<{ message?: string }>
}

type LiftoverRow = {
  source?: { variant_id?: string; reference_genome?: string } | null
  liftover?: { variant_id?: string; reference_genome?: string } | null
  datasets?: string[] | null
}

// ---- helpers --------------------------------------------------------------------------------

// GraphQL error messages that mean "entity absent", not "request failed" — mirrors the upstream
// client's NOT_FOUND_MESSAGES. When only these are present the entity is simply not found.
const NOT_FOUND_MESSAGES = new Set([
  'variant not found',
  'gene not found',
  'transcript not found',
  'structural variant not found',
  'copy number variant not found'
])

// Returns the response's `data` payload, or null when the only GraphQL errors are entity-not-found
// messages. Throws on any other GraphQL error (schema/complexity/etc.) so real failures surface.
function gqlData(result: GqlResponse): NonNullable<GqlResponse['data']> | null {
  const errors = result.errors ?? []
  if (errors.length) {
    const allNotFound = errors.every((e) =>
      NOT_FOUND_MESSAGES.has(
        String(e.message ?? '')
          .trim()
          .toLowerCase()
      )
    )
    if (allNotFound) return null
    throw new Error(`gnomAD GraphQL error: ${errors.map((e) => e.message).join('; ')}`)
  }
  return result.data ?? null
}

// Coerces a value to an integer, clamped to an optional [min, max]. Non-finite input falls back.
function clampInt(value: unknown, min?: number, max?: number, fallback = 0): number {
  const n = Math.trunc(Number(value))
  let v = Number.isFinite(n) ? n : fallback
  if (min != null && v < min) v = min
  if (max != null && v > max) v = max
  return v
}

// Enforces the upstream "pass exactly one of gene_symbol / gene_id" ValueError — a usage error, not
// an empty result. Returns the GraphQL {symbol, geneId} variable pair.
function geneArgs(a: Record<string, unknown>): { symbol: string | null; geneId: string | null } {
  const symbol = a.gene_symbol == null ? null : String(a.gene_symbol)
  const geneId = a.gene_id == null ? null : String(a.gene_id)
  if ((symbol === null) === (geneId === null)) {
    throw new Error('pass exactly one of gene_symbol / gene_id')
  }
  return { symbol, geneId }
}

// Rejects an unknown dataset pin (usage error), matching upstream _check_dataset.
function checkDataset(dataset: string, allowed: readonly string[]): string {
  if (!allowed.includes(dataset)) {
    throw new Error(`unknown dataset '${dataset}'; allowed: ${allowed.join(', ')}`)
  }
  return dataset
}

// Frequency block reduced to the keys the query actually selected (all six for a single variant,
// ac/an/af for the lean gene/region rows), with filters sorted for deterministic output.
function freqBlock(block: FreqBlock): FreqBlock {
  if (block == null) return null
  const keys = ['ac', 'an', 'af', 'homozygote_count', 'hemizygote_count', 'filters'] as const
  const out: Record<string, unknown> = {}
  for (const k of keys) if (k in block) out[k] = block[k]
  if ('filters' in out && out.filters != null) out.filters = [...(out.filters as string[])].sort()
  return out
}

function sortedStrings(xs: string[] | null | undefined): string[] {
  return [...(xs ?? [])].sort()
}

// Full single-variant record: identity + population frequency blocks (null where the dataset has no
// such call set, e.g. r3 is genome-only).
function buildVariantRecord(v: FullVariant, dataset: string): Record<string, unknown> {
  return {
    variant_id: v.variant_id,
    dataset,
    reference_genome: v.reference_genome ?? null,
    chrom: v.chrom ?? null,
    pos: v.pos ?? null,
    ref: v.ref ?? null,
    alt: v.alt ?? null,
    rsids: sortedStrings(v.rsids),
    exome: freqBlock(v.exome ?? null),
    genome: freqBlock(v.genome ?? null)
  }
}

// Lean row for gene/region variant listings.
function buildShortVariantRow(v: ShortVariant): {
  variant_id: string
  pos?: number | null
  ref?: string | null
  alt?: string | null
  rsids: string[]
  exome: FreqBlock
  genome: FreqBlock
} {
  return {
    variant_id: v.variant_id,
    pos: v.pos ?? null,
    ref: v.ref ?? null,
    alt: v.alt ?? null,
    rsids: sortedStrings(v.rsids),
    exome: freqBlock(v.exome ?? null),
    genome: freqBlock(v.genome ?? null)
  }
}

const CONSTRAINT_KEYS = [
  'exp_lof',
  'obs_lof',
  'oe_lof',
  'oe_lof_lower',
  'oe_lof_upper',
  'exp_mis',
  'obs_mis',
  'oe_mis',
  'oe_mis_lower',
  'oe_mis_upper',
  'exp_syn',
  'obs_syn',
  'oe_syn',
  'oe_syn_lower',
  'oe_syn_upper',
  'pli',
  'lof_z',
  'mis_z',
  'syn_z'
] as const

function buildConstraintRecord(g: GeneNode): Record<string, unknown> {
  const c = g.gnomad_constraint ?? {}
  const constraint: Record<string, unknown> = {}
  for (const k of CONSTRAINT_KEYS) constraint[k] = c[k] ?? null
  return {
    gene_id: g.gene_id,
    symbol: g.symbol ?? null,
    canonical_transcript_id: g.canonical_transcript_id ?? null,
    chrom: g.chrom ?? null,
    start: g.start ?? null,
    stop: g.stop ?? null,
    strand: g.strand ?? null,
    constraint
  }
}

function buildClinvarRow(
  v: ClinvarVariant
): { variant_id: string; pos: number | null } & Record<string, unknown> {
  return {
    variant_id: v.variant_id,
    clinvar_variation_id: v.clinvar_variation_id ?? null,
    clinical_significance: v.clinical_significance ?? null,
    gold_stars: v.gold_stars ?? null,
    review_status: v.review_status ?? null,
    major_consequence: v.major_consequence ?? null,
    pos: v.pos ?? null,
    transcript_id: v.transcript_id ?? null,
    in_gnomad: v.in_gnomad ?? null
  }
}

// Structural-variant row: passes every selected field through (gene-list and single-variant queries
// select different sets), sorting the list-valued fields for deterministic output.
function buildSvRow(v: SvNode): Record<string, unknown> {
  const out: Record<string, unknown> = { ...v }
  if (out.filters != null) out.filters = [...(out.filters as string[])].sort()
  if (out.algorithms != null) out.algorithms = [...(out.algorithms as string[])].sort()
  if (out.evidence != null) out.evidence = [...(out.evidence as string[])].sort()
  if (out.consequences != null) {
    const cons = (out.consequences as SvNode['consequences']) ?? []
    out.consequences = cons
      .map((c) => ({ consequence: c.consequence ?? null, genes: sortedStrings(c.genes) }))
      .sort((a, b) => String(a.consequence ?? '').localeCompare(String(b.consequence ?? '')))
  }
  return out
}

function buildMitoRow(
  v: MitoVariant
): { variant_id: string; pos: number | null } & Record<string, unknown> {
  return {
    variant_id: v.variant_id,
    pos: v.pos ?? null,
    ac_het: v.ac_het ?? null,
    ac_hom: v.ac_hom ?? null,
    an: v.an ?? null,
    max_heteroplasmy: v.max_heteroplasmy ?? null,
    filters: v.filters == null ? null : [...v.filters].sort()
  }
}

// Stable order for variant-row lists: (pos, variant_id).
function sortRows<T extends { pos?: number | null; variant_id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const pa = a.pos ?? 0
    const pb = b.pos ?? 0
    if (pa !== pb) return pa - pb
    return a.variant_id < b.variant_id ? -1 : a.variant_id > b.variant_id ? 1 : 0
  })
}

// POSTs a GraphQL document and returns the parsed response envelope.
async function postGql(
  ctx: ToolContext,
  query: string,
  variables: Record<string, unknown>
): Promise<GqlResponse> {
  return (await ctx.postJson(GNOMAD_API, { query, variables })) as GqlResponse
}

// ---- the 10 tools ---------------------------------------------------------------------------

export const VARIANTS_GNOMAD_TOOLS: ToolDescriptor[] = [
  {
    id: 'get_variant',
    connector: 'variants',
    description:
      "Look up one gnomAD short variant by ID and return its population frequencies. `variant_id` is `chrom-pos-ref-alt` on the dataset's reference build (GRCh38 for r3/r4, GRCh37 for r2.1/ExAC), e.g. `19-44908822-C-T` (APOE rs7412); use `search_variants` to resolve an rsID first.",
    input: {
      type: 'object',
      properties: {
        variant_id: { type: 'string' },
        dataset: { type: 'string', enum: [...DATASETS], default: DEFAULT_DATASET }
      },
      required: ['variant_id']
    },
    required: ['variant_id'],
    returns:
      '`{ found: bool, variant_id: str, dataset: str, variant: null | { variant_id, dataset, reference_genome, chrom, pos, ref, alt, rsids: [str], exome: { ac, an, af, homozygote_count, hemizygote_count, filters }|null, genome: {...}|null } }`. `exome`/`genome` are null where the dataset has no such call set (e.g. r3 is genome-only).',
    example:
      'result = host.mcp("variants", "get_variant", {"variant_id": "19-44908822-C-T", "dataset": "gnomad_r4"})',
    run: async (ctx, a) => {
      const variantId = String(a.variant_id)
      const dataset = checkDataset(String(a.dataset ?? DEFAULT_DATASET), DATASETS)
      const data = gqlData(await postGql(ctx, VARIANT_QUERY, { variantId, dataset }))
      const v = data?.variant ?? null
      return {
        found: v != null,
        variant_id: variantId,
        dataset,
        variant: v ? buildVariantRecord(v, dataset) : null
      }
    }
  },
  {
    id: 'search_variants',
    connector: 'variants',
    description:
      'Search gnomAD for variant IDs matching a query string (an rsID like `rs7412`, a variant ID, or a prefix). Use this to resolve rsIDs to `chrom-pos-ref-alt` IDs for `get_variant`.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        dataset: { type: 'string', enum: [...DATASETS], default: DEFAULT_DATASET }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '`{ query: str, dataset: str, n_matches: int, variant_ids: [str] }` — `variant_ids` sorted. Empty list when nothing matches.',
    example:
      'result = host.mcp("variants", "search_variants", {"query": "rs7412", "dataset": "gnomad_r4"})',
    run: async (ctx, a) => {
      const query = String(a.query)
      const dataset = checkDataset(String(a.dataset ?? DEFAULT_DATASET), DATASETS)
      const data = gqlData(await postGql(ctx, VARIANT_SEARCH_QUERY, { query, dataset }))
      const ids = (data?.variant_search ?? []).map((r) => r.variant_id).sort()
      return { query, dataset, n_matches: ids.length, variant_ids: ids }
    }
  },
  {
    id: 'gene_variants',
    connector: 'variants',
    description:
      'List ALL gnomAD short variants in a gene (complete listing — can be thousands of rows for large genes). Pass exactly one of `gene_symbol` (HGNC symbol, e.g. `APOE`) or `gene_id` (Ensembl gene ID, e.g. `ENSG00000130203`).',
    input: {
      type: 'object',
      properties: {
        gene_symbol: { type: 'string' },
        gene_id: { type: 'string' },
        dataset: { type: 'string', enum: [...DATASETS], default: DEFAULT_DATASET }
      }
    },
    returns:
      '`{ gene_id: str|null, symbol: str, chrom: str, start: int, stop: int, dataset: str, n_variants: int, variants: [ { variant_id, pos, ref, alt, rsids: [str], exome: { ac, an, af }|null, genome: {...}|null } ] }`, rows sorted by (pos, variant_id). Unknown gene returns `gene_id: null`, an echoed `gene_query`, and an empty `variants` list.',
    example:
      'result = host.mcp("variants", "gene_variants", {"gene_symbol": "APOE", "dataset": "gnomad_r4"})',
    run: async (ctx, a) => {
      const { symbol, geneId } = geneArgs(a)
      const dataset = checkDataset(String(a.dataset ?? DEFAULT_DATASET), DATASETS)
      const data = gqlData(await postGql(ctx, GENE_VARIANTS_QUERY, { symbol, geneId, dataset }))
      const g = data?.gene ?? null
      if (!g) {
        // Absent gene — compact empty result rather than an error (never throw on empty).
        return {
          gene_id: null,
          symbol: symbol ?? null,
          gene_query: symbol ?? geneId,
          dataset,
          n_variants: 0,
          variants: []
        }
      }
      const rows = sortRows((g.variants ?? []).map(buildShortVariantRow))
      return {
        gene_id: g.gene_id,
        symbol: g.symbol ?? symbol,
        chrom: g.chrom ?? null,
        start: g.start ?? null,
        stop: g.stop ?? null,
        dataset,
        n_variants: rows.length,
        variants: rows
      }
    }
  },
  {
    id: 'gene_constraint',
    connector: 'variants',
    description:
      "gnomAD gene constraint metrics: pLI, observed/expected LoF-missense-synonymous counts with oe ratios + 90% CI bounds, and per-class z-scores. Use to judge a gene's intolerance to loss-of-function (pLI >= 0.9 or oe_lof_upper (LOEUF) < 0.6 ~ LoF-intolerant). Pass exactly one of `gene_symbol` (e.g. `TP53`) or `gene_id`.",
    input: {
      type: 'object',
      properties: {
        gene_symbol: { type: 'string' },
        gene_id: { type: 'string' }
      }
    },
    returns:
      '`{ found: bool, gene_id: str|null, symbol: str, canonical_transcript_id: str, chrom: str, start: int, stop: int, strand: str, constraint: { exp_lof, obs_lof, oe_lof, oe_lof_lower, oe_lof_upper, exp_mis, obs_mis, oe_mis, oe_mis_lower, oe_mis_upper, exp_syn, obs_syn, oe_syn, oe_syn_lower, oe_syn_upper, pli, lof_z, mis_z, syn_z }|null }`. Unknown gene returns `found: false`, an echoed `gene_query`, and `constraint: null`.',
    example: 'result = host.mcp("variants", "gene_constraint", {"gene_symbol": "TP53"})',
    run: async (ctx, a) => {
      const { symbol, geneId } = geneArgs(a)
      const data = gqlData(await postGql(ctx, GENE_CONSTRAINT_QUERY, { symbol, geneId }))
      const g = data?.gene ?? null
      if (!g) {
        return {
          found: false,
          gene_id: null,
          symbol: symbol ?? null,
          gene_query: symbol ?? geneId,
          constraint: null
        }
      }
      return { found: true, ...buildConstraintRecord(g) }
    }
  },
  {
    id: 'region_variants',
    connector: 'variants',
    description:
      'List ALL gnomAD short variants in a genomic region (max 1 Mb — split larger regions into consecutive windows). `chrom` is a chromosome name without `chr` prefix (`1`-`22`, `X`, `Y`); `start`/`stop` are 1-based inclusive and `stop - start` must be <= 1,000,000. The dataset determines the reference build of the coordinates (GRCh38 for r3/r4).',
    input: {
      type: 'object',
      properties: {
        chrom: { type: 'string' },
        start: { type: 'integer' },
        stop: { type: 'integer' },
        dataset: { type: 'string', enum: [...DATASETS], default: DEFAULT_DATASET }
      },
      required: ['chrom', 'start', 'stop']
    },
    required: ['chrom', 'start', 'stop'],
    returns:
      '`{ chrom: str, start: int, stop: int, dataset: str, n_variants: int, variants: [...] }` with the same lean variant rows as `gene_variants`, sorted by (pos, variant_id).',
    example:
      'result = host.mcp("variants", "region_variants", {"chrom": "1", "start": 55039475, "stop": 55064852, "dataset": "gnomad_r4"})',
    run: async (ctx, a) => {
      const chrom = String(a.chrom)
      const start = clampInt(a.start, 0)
      const stop = clampInt(a.stop, 0)
      const dataset = checkDataset(String(a.dataset ?? DEFAULT_DATASET), DATASETS)
      // Region size cap is a usage error (matches upstream ValueError), not an empty result.
      if (stop - start > MAX_REGION_BP) {
        throw new Error(`region exceeds ${MAX_REGION_BP} bp; split the query`)
      }
      const data = gqlData(
        await postGql(ctx, REGION_VARIANTS_QUERY, { chrom, start, stop, dataset })
      )
      const region = data?.region ?? null
      const rows = sortRows((region?.variants ?? []).map(buildShortVariantRow))
      return { chrom, start, stop, dataset, n_variants: rows.length, variants: rows }
    }
  },
  {
    id: 'liftover_variant',
    connector: 'variants',
    description:
      "Map a variant ID between reference builds (GRCh37 <-> GRCh38) using gnomAD's liftover table. `variant_id` is `chrom-pos-ref-alt` on `source_build`. The route is directional: a GRCh38 ID passed with `source_build=GRCh37` returns zero results, not an error.",
    input: {
      type: 'object',
      properties: {
        variant_id: { type: 'string' },
        source_build: { type: 'string', enum: ['GRCh37', 'GRCh38'], default: 'GRCh37' }
      },
      required: ['variant_id']
    },
    required: ['variant_id'],
    returns:
      '`{ source_variant_id: str, source_build: str, n_results: int, results: [ { source: { variant_id, reference_genome }, liftover: { variant_id, reference_genome }, datasets: [str] } ] }`, sorted by liftover variant_id. `n_results: 0` when the ID does not lift over in that direction.',
    example:
      'result = host.mcp("variants", "liftover_variant", {"variant_id": "1-55516888-G-GA", "source_build": "GRCh37"})',
    run: async (ctx, a) => {
      const variantId = String(a.variant_id)
      const sourceBuild = String(a.source_build ?? 'GRCh37')
      // Directionality: source_build selects the reference genome of the input ID.
      if (sourceBuild !== 'GRCh37' && sourceBuild !== 'GRCh38') {
        throw new Error('source_build must be GRCh37 or GRCh38')
      }
      const data = gqlData(
        await postGql(ctx, LIFTOVER_QUERY, { source: variantId, rg: sourceBuild })
      )
      const rows = (data?.liftover ?? []).map((row) => ({
        source: row.source ?? null,
        liftover: row.liftover ?? null,
        datasets: sortedStrings(row.datasets)
      }))
      rows.sort((x, y) =>
        String(x.liftover?.variant_id ?? '').localeCompare(String(y.liftover?.variant_id ?? ''))
      )
      return {
        source_variant_id: variantId,
        source_build: sourceBuild,
        n_results: rows.length,
        results: rows
      }
    }
  },
  {
    id: 'clinvar_variants',
    connector: 'variants',
    description:
      "List ClinVar variants in a gene as mirrored by gnomAD, with clinical significance, review status and gold stars. The output pins gnomAD's ClinVar snapshot via `clinvar_release_date`. Pass exactly one of `gene_symbol` (e.g. `BRCA1`) or `gene_id`.",
    input: {
      type: 'object',
      properties: {
        gene_symbol: { type: 'string' },
        gene_id: { type: 'string' }
      }
    },
    returns:
      '`{ gene_id: str|null, symbol: str, clinvar_release_date: str, n_variants: int, variants: [ { variant_id, clinvar_variation_id, clinical_significance, gold_stars, review_status, major_consequence, pos, transcript_id, in_gnomad } ] }`, sorted by (pos, variant_id). Unknown gene returns `gene_id: null`, an echoed `gene_query`, and an empty `variants` list.',
    example: 'result = host.mcp("variants", "clinvar_variants", {"gene_symbol": "BRCA1"})',
    run: async (ctx, a) => {
      const { symbol, geneId } = geneArgs(a)
      const data = gqlData(await postGql(ctx, CLINVAR_VARIANTS_QUERY, { symbol, geneId }))
      const releaseDate = data?.meta?.clinvar_release_date ?? null
      const g = data?.gene ?? null
      if (!g) {
        return {
          gene_id: null,
          symbol: symbol ?? null,
          gene_query: symbol ?? geneId,
          clinvar_release_date: releaseDate,
          n_variants: 0,
          variants: []
        }
      }
      const rows = sortRows((g.clinvar_variants ?? []).map(buildClinvarRow))
      return {
        gene_id: g.gene_id,
        symbol: g.symbol ?? symbol,
        clinvar_release_date: releaseDate,
        n_variants: rows.length,
        variants: rows
      }
    }
  },
  {
    id: 'structural_variants',
    connector: 'variants',
    description:
      'List gnomAD structural variants (deletions, duplications, insertions, inversions, CNVs...) overlapping a gene. Pass exactly one of `gene_symbol` (e.g. `TP53`) or `gene_id`. `dataset` is an SV pin — `gnomad_sv_r4` (default, GRCh38) or `gnomad_sv_r2_1` (GRCh37); SV IDs are release-specific.',
    input: {
      type: 'object',
      properties: {
        gene_symbol: { type: 'string' },
        gene_id: { type: 'string' },
        dataset: { type: 'string', enum: [...SV_DATASETS], default: DEFAULT_SV_DATASET }
      }
    },
    returns:
      '`{ gene_id: str|null, symbol: str, dataset: str, n_variants: int, variants: [...] }`; rows carry SV `variant_id`, `type`, position/length, allele counts/frequencies, `filters`, and per-gene `consequence`/`major_consequence`, sorted by variant_id. Unknown gene returns `gene_id: null`, an echoed `gene_query`, and an empty list.',
    example:
      'result = host.mcp("variants", "structural_variants", {"gene_symbol": "TP53", "dataset": "gnomad_sv_r4"})',
    run: async (ctx, a) => {
      const { symbol, geneId } = geneArgs(a)
      const dataset = checkDataset(String(a.dataset ?? DEFAULT_SV_DATASET), SV_DATASETS)
      const data = gqlData(
        await postGql(ctx, STRUCTURAL_VARIANTS_GENE_QUERY, { symbol, geneId, dataset })
      )
      const g = data?.gene ?? null
      if (!g) {
        return {
          gene_id: null,
          symbol: symbol ?? null,
          gene_query: symbol ?? geneId,
          dataset,
          n_variants: 0,
          variants: []
        }
      }
      const rows = (g.structural_variants ?? [])
        .map(buildSvRow)
        .sort((x, y) => String(x.variant_id).localeCompare(String(y.variant_id)))
      return {
        gene_id: g.gene_id,
        symbol: g.symbol ?? symbol,
        dataset,
        n_variants: rows.length,
        variants: rows
      }
    }
  },
  {
    id: 'get_structural_variant',
    connector: 'variants',
    description:
      'Look up one gnomAD structural variant by its release-specific SV ID (e.g. `DEL_CHR17_599B1512` in gnomad_sv_r4). IDs do NOT carry across releases — `dataset` (`gnomad_sv_r4` default, or `gnomad_sv_r2_1`) must match the release the ID came from.',
    input: {
      type: 'object',
      properties: {
        sv_id: { type: 'string' },
        dataset: { type: 'string', enum: [...SV_DATASETS], default: DEFAULT_SV_DATASET }
      },
      required: ['sv_id']
    },
    required: ['sv_id'],
    returns:
      '`{ found: bool, sv_id: str, dataset: str, structural_variant: null | { variant_id, chrom, pos, end, chrom2, pos2, type, length, ac, an, af, homozygote_count, hemizygote_count, filters, qual, consequences: [ { consequence, genes: [str] } ], algorithms: [str], evidence: [str], dataset } }`. Null when not found.',
    example:
      'result = host.mcp("variants", "get_structural_variant", {"sv_id": "DEL_CHR17_A5250EA9", "dataset": "gnomad_sv_r4"})',
    run: async (ctx, a) => {
      const svId = String(a.sv_id)
      const dataset = checkDataset(String(a.dataset ?? DEFAULT_SV_DATASET), SV_DATASETS)
      const data = gqlData(
        await postGql(ctx, STRUCTURAL_VARIANT_QUERY, { variantId: svId, dataset })
      )
      const v = data?.structural_variant ?? null
      const record = v ? { ...buildSvRow(v), dataset } : null
      return { found: record != null, sv_id: svId, dataset, structural_variant: record }
    }
  },
  {
    id: 'mitochondrial_variants',
    connector: 'variants',
    description:
      'List gnomAD mitochondrial variants with heteroplasmy-aware counts (`ac_het`, `ac_hom`, `max_heteroplasmy`) for a mitochondrial gene OR a chrM coordinate window. Pass a gene (`gene_symbol` like `MT-TL1`, or `gene_id`) OR a region (`region_start` + `region_stop`), not both.',
    input: {
      type: 'object',
      properties: {
        gene_symbol: { type: 'string' },
        gene_id: { type: 'string' },
        region_start: { type: 'integer' },
        region_stop: { type: 'integer' },
        dataset: { type: 'string', enum: [...DATASETS], default: DEFAULT_DATASET }
      }
    },
    returns:
      '`{ gene_id+symbol | region: "M:start-stop", dataset: str, n_variants: int, variants: [ { variant_id, pos, ac_het, ac_hom, an, max_heteroplasmy, filters } ] }`, sorted by (pos, variant_id). Unknown gene returns `gene_id: null`, an echoed `gene_query`, and an empty list.',
    example:
      'result = host.mcp("variants", "mitochondrial_variants", {"gene_symbol": "MT-TL1", "dataset": "gnomad_r4"})',
    run: async (ctx, a) => {
      const dataset = checkDataset(String(a.dataset ?? DEFAULT_DATASET), DATASETS)
      const hasStart = a.region_start != null
      const hasStop = a.region_stop != null
      // Both region bounds go together (upstream ValueError), and a region excludes a gene.
      if (hasStart !== hasStop) throw new Error('pass region_start and region_stop together')
      if (hasStart) {
        if (a.gene_symbol != null || a.gene_id != null) {
          throw new Error('pass gene OR region, not both')
        }
        const start = clampInt(a.region_start, 0)
        const stop = clampInt(a.region_stop, 0)
        const data = gqlData(
          await postGql(ctx, MITO_VARIANTS_REGION_QUERY, { start, stop, dataset })
        )
        const rows = sortRows((data?.region?.mitochondrial_variants ?? []).map(buildMitoRow))
        return { region: `M:${start}-${stop}`, dataset, n_variants: rows.length, variants: rows }
      }
      const { symbol, geneId } = geneArgs(a)
      const data = gqlData(
        await postGql(ctx, MITO_VARIANTS_GENE_QUERY, { symbol, geneId, dataset })
      )
      const g = data?.gene ?? null
      if (!g) {
        return {
          gene_id: null,
          symbol: symbol ?? null,
          gene_query: symbol ?? geneId,
          dataset,
          n_variants: 0,
          variants: []
        }
      }
      const rows = sortRows((g.mitochondrial_variants ?? []).map(buildMitoRow))
      return {
        gene_id: g.gene_id,
        symbol: g.symbol ?? symbol,
        dataset,
        n_variants: rows.length,
        variants: rows
      }
    }
  }
]
