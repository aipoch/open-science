import type { ToolDescriptor } from '../types'

const GNOMAD_API = 'https://gnomad.broadinstitute.org/api'
// gnomAD defaults its own UI/API to gnomad_r4 (current release); pin it explicitly rather than
// relying on the server-side default so callers get a stable, documented dataset.
const DEFAULT_DATASET = 'gnomad_r4'
// A gene like TTN/BRCA2 can carry tens of thousands of variants — bound the response like geo
// (retmax) and openalex (per_page) do, rather than returning every row unbounded.
const DEFAULT_LIMIT = 25

// Lean gene-scoped variant listing (transcribed from the upstream gnomad_variants GraphQL
// document): gene id/span plus a compact per-variant row. Field selection matches gnomAD's
// complexity-limited API — only scientifically load-bearing fields are requested.
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

type FreqBlock = { ac?: number; an?: number; af?: number } | null

type GeneVariantRow = {
  variant_id: string
  pos?: number
  ref?: string
  alt?: string
  rsids?: string[] | null
  exome?: FreqBlock
  genome?: FreqBlock
}

type GeneVariantsResponse = {
  data?: {
    gene?: {
      gene_id: string
      symbol?: string
      chrom?: string
      start?: number
      stop?: number
      variants?: GeneVariantRow[] | null
    } | null
  }
  errors?: Array<{ message?: string }>
}

// GraphQL error messages that mean "entity absent", not "request failed" — mirrors the upstream
// gnomad_variants client's NOT_FOUND_MESSAGES handling for the gene lookup.
const NOT_FOUND_MESSAGES = new Set(['gene not found'])

function freqBlock(block: FreqBlock): FreqBlock {
  if (!block) return null
  return { ac: block.ac, an: block.an, af: block.af }
}

// gnomAD is GraphQL-only: every call is a POST of {query, variables} to a single endpoint.
export const GNOMAD_TOOLS: ToolDescriptor[] = [
  {
    id: 'gnomad_gene_variants',
    connector: 'gnomad',
    description:
      'gnomAD population variants for a gene by symbol: variant ids, positions, alleles, rsids, and exome/genome allele counts and frequencies.',
    input: {
      type: 'object',
      properties: {
        gene_symbol: { type: 'string' },
        dataset: { type: 'string', default: DEFAULT_DATASET },
        limit: { type: 'integer', default: DEFAULT_LIMIT }
      },
      required: ['gene_symbol']
    },
    required: ['gene_symbol'],
    returns:
      '`{ "gene_id": str, "symbol": str, "chrom": str, "start": int, "stop": int, "dataset": str, "n_variants_total": int, "returned": int, "variants": [ { "variant_id": str, "pos": int, "ref": str, "alt": str, "rsids": [str], "exome": { "ac": int, "an": int, "af": float }|null, "genome": {...}|null } ] }` — variants capped at `limit` (default 25); `n_variants_total` is the full count. `exome`/`genome` are null when absent. Unknown gene returns `{ "symbol": str, "dataset": str, "gene_id": null, "n_variants": 0, "variants": [] }`.',
    run: async (ctx, a) => {
      const symbol = String(a.gene_symbol)
      const dataset = String(a.dataset ?? DEFAULT_DATASET)
      const limit = Number(a.limit ?? DEFAULT_LIMIT)
      const result = (await ctx.postJson(GNOMAD_API, {
        query: GENE_VARIANTS_QUERY,
        variables: { symbol, geneId: null, dataset }
      })) as GeneVariantsResponse

      const errors = result.errors ?? []
      if (
        errors.length &&
        !errors.every((e) =>
          NOT_FOUND_MESSAGES.has(
            String(e.message ?? '')
              .trim()
              .toLowerCase()
          )
        )
      ) {
        throw new Error(`gnomAD GraphQL error: ${errors.map((e) => e.message).join('; ')}`)
      }

      const gene = result.data?.gene
      if (!gene) {
        // Absent entity (data null, or only "gene not found" errors) — compact empty result.
        return { symbol, dataset, gene_id: null, n_variants: 0, variants: [] }
      }

      const allVariants = (gene.variants ?? []).map((v) => ({
        variant_id: v.variant_id,
        pos: v.pos,
        ref: v.ref,
        alt: v.alt,
        rsids: v.rsids ?? [],
        exome: freqBlock(v.exome ?? null),
        genome: freqBlock(v.genome ?? null)
      }))
      const variants = allVariants.slice(0, limit)

      return {
        gene_id: gene.gene_id,
        symbol: gene.symbol ?? symbol,
        chrom: gene.chrom,
        start: gene.start,
        stop: gene.stop,
        dataset,
        n_variants_total: allVariants.length,
        returned: variants.length,
        variants
      }
    }
  }
]
