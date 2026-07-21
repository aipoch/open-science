import type { ToolContext, ToolDescriptor } from '../types'

// PheWeb PheWAS portals. Endpoints below were verified live (2026-07):
//   FinnGen R12 (GRCh38, base https://r12.finngen.fi):
//     variant       GET /api/variant/{chr}-{pos}-{ref}-{alt}  -> {variant:{...}, results:[...]}
//     gene          GET /api/gene_phenos/{symbol}             -> {phenotypes:[{assoc,pheno,variant}], region}
//     phenotypes    GET /api/phenos                           -> [{phenocode, phenostring, ...}]
//     autocomplete  GET /api/autocomplete?query={q}           -> [{display, pheno}]
//   BioBank Japan (GRCh37, base https://pheweb.jp):
//     variant       GET /api/variant/{chr}-{pos}-{ref}-{alt}  -> {chrom,pos,ref,alt,rsids,nearest_genes,phenos:[...]}
//     autocomplete  GET /api/autocomplete?query={q}           -> [{display, url, value}]
//     (gene + phenos endpoints return 404 — not published on this instance)
// The two portals ship DIFFERENT JSON shapes, so each is normalized to a shared phenotype row below.

type Capability = 'variant' | 'gene' | 'phenotypes' | 'autocomplete'
type PhewebInstance = {
  label: string
  base_url: string
  genome_build: string
  capabilities: Capability[]
  notes: string
}
type PhewebKey = 'finngen' | 'bbj'

// In-code registry of the public PheWeb portals this connector can query — drives base URLs,
// genome build and per-instance capability guards for every tool below.
const PHEWEB_INSTANCES: Record<PhewebKey, PhewebInstance> = {
  finngen: {
    label: 'FinnGen R12',
    base_url: 'https://r12.finngen.fi',
    genome_build: 'GRCh38',
    capabilities: ['variant', 'gene', 'phenotypes', 'autocomplete'],
    notes:
      'FinnGen release 12, ~2470 disease endpoints; variant coordinates are GRCh38. ' +
      'Exposes variant, gene-level, full phenotype-catalogue and autocomplete APIs. ' +
      'Rows carry maf triplets + mlogp and a lean gnomAD AF block in variant_meta.'
  },
  bbj: {
    label: 'BioBank Japan (pheweb.jp)',
    base_url: 'https://pheweb.jp',
    genome_build: 'GRCh37',
    capabilities: ['variant', 'autocomplete'],
    notes:
      'BioBank Japan PheWeb; coordinates are GRCh37/hg19 — liftover before cross-querying FinnGen ' +
      '(GRCh38). Only variant and autocomplete endpoints are published (no gene or ' +
      'phenotype-catalogue API); rows carry af (not maf) and no mlogp.'
  }
}

// ---- minimal upstream shapes (only the fields the normalized records read) ------------------

type FinngenGnomad = Record<string, unknown>
type FinngenAnnotation = {
  annot?: { gene_most_severe?: string; most_severe?: string }
  gnomad?: FinngenGnomad
  rsids?: string
}
type FinngenVariantMeta = {
  chr?: number | string
  pos?: number | string
  ref?: string
  alt?: string
  varid?: string
  annotation?: FinngenAnnotation
}
type FinngenPhenoRow = {
  phenocode?: string
  phenostring?: string
  category?: string
  pval?: number
  mlogp?: number
  beta?: number
  sebeta?: number
  maf?: number
  maf_case?: number
  maf_control?: number
  n_case?: number
  n_control?: number
  n_sample?: number
}
type FinngenVariantResp = { variant?: FinngenVariantMeta; results?: FinngenPhenoRow[] }
type FinngenGeneRow = { assoc?: FinngenPhenoRow; pheno?: unknown; variant?: FinngenVariantMeta }
type FinngenGeneResp = { phenotypes?: FinngenGeneRow[]; region?: unknown }
type FinngenPheno = {
  phenocode?: string
  phenostring?: string
  category?: string
  num_cases?: number
  num_controls?: number
  num_gw_significant?: number
}

type BbjPhenoRow = {
  phenocode?: string
  phenostring?: string
  category?: string
  pval?: number
  beta?: number
  sebeta?: number
  af?: number
  num_cases?: number
  num_controls?: number
  num_samples?: number
}
type BbjVariantResp = {
  chrom?: string
  pos?: number | string
  ref?: string
  alt?: string
  rsids?: string
  nearest_genes?: string
  phenos?: BbjPhenoRow[]
}

type AutocompleteRow = { display?: string; pheno?: string; value?: string; url?: string }

// ---- helpers --------------------------------------------------------------------------------

// Reads an integer arg, applying a default when unset and clamping into [lo, hi].
function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  const base = Number.isFinite(n) && v != null && v !== '' ? Math.trunc(n) : def
  return Math.min(hi, Math.max(lo, base))
}

type NormVariant = { id: string; chrom: string; pos: string; ref: string; alt: string }

// Normalizes a variant string to PheWeb's `chrom-pos-ref-alt` id form: tolerates a leading `chr`
// prefix and `-`/`:`/`_` separators (e.g. "chr19:44908822:C:T" -> "19-44908822-C-T").
function normalizeVariant(input: string): NormVariant {
  const cleaned = input.trim().replace(/^chr/i, '')
  const parts = cleaned.split(/[-:_]/).filter((p) => p !== '')
  if (parts.length !== 4) {
    throw new Error(
      `Invalid variant '${input}': expected chrom-pos-ref-alt (e.g. 19-44908822-C-T; ` +
        'chr prefix and :/_ separators are tolerated).'
    )
  }
  const [chrom, pos, ref, alt] = parts
  return { id: `${chrom}-${pos}-${ref}-${alt}`, chrom, pos, ref, alt }
}

// Splits a delimited PheWeb string field (rsids, nearest_genes) into a clean array; [] when empty.
function splitList(s: unknown): string[] {
  if (typeof s !== 'string' || s.trim() === '') return []
  return s.split(/[,;\s]+/).filter((x) => x !== '')
}

// Lean gnomAD allele-frequency block from FinnGen's verbose annotation.gnomad (FinnGen only).
const GNOMAD_AF_FIELDS = [
  'AF',
  'AF_fin',
  'AF_nfe',
  'AF_afr',
  'AF_amr',
  'AF_eas',
  'AF_sas',
  'AF_asj',
  'AF_oth',
  'AF_popmax'
]
function leanGnomad(g: FinngenGnomad | undefined): Record<string, unknown> | null {
  if (!g || typeof g !== 'object') return null
  const out: Record<string, unknown> = {}
  for (const f of GNOMAD_AF_FIELDS) if (f in g) out[f] = g[f]
  return Object.keys(out).length ? out : null
}

// GET that maps an upstream 404 (unknown variant/gene) to a clean not-found error; other HTTP
// errors (surfaced by the engine as "HTTP <code>") propagate unchanged.
async function fetchOrNotFound(ctx: ToolContext, url: string, notFound: string): Promise<unknown> {
  try {
    return await ctx.fetchJson(url)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/HTTP 404/.test(msg)) throw new Error(notFound)
    throw e
  }
}

// Shared normalized phenotype row: every published field, nulls where an instance omits it.
function phenoRow(fields: {
  phenocode?: string
  phenostring?: string
  category?: string
  pval?: number
  mlogp?: number
  beta?: number
  sebeta?: number
  af?: number
  maf?: number
  maf_case?: number
  maf_control?: number
  n_cases?: number
  n_controls?: number
  n_samples?: number
}): Record<string, unknown> {
  return {
    phenocode: fields.phenocode ?? null,
    phenostring: fields.phenostring ?? null,
    category: fields.category ?? null,
    pval: fields.pval ?? null,
    mlogp: fields.mlogp ?? null,
    beta: fields.beta ?? null,
    sebeta: fields.sebeta ?? null,
    af: fields.af ?? null,
    maf: fields.maf ?? null,
    maf_case: fields.maf_case ?? null,
    maf_control: fields.maf_control ?? null,
    n_cases: fields.n_cases ?? null,
    n_controls: fields.n_controls ?? null,
    n_samples: fields.n_samples ?? null
  }
}

// FinnGen `results[]`/gene `assoc` row -> normalized phenotype row (maf triplets + mlogp; af null).
function finngenPhenoRow(r: FinngenPhenoRow): Record<string, unknown> {
  return phenoRow({
    phenocode: r.phenocode,
    phenostring: r.phenostring,
    category: r.category,
    pval: r.pval,
    mlogp: r.mlogp,
    beta: r.beta,
    sebeta: r.sebeta,
    maf: r.maf,
    maf_case: r.maf_case,
    maf_control: r.maf_control,
    n_cases: r.n_case,
    n_controls: r.n_control,
    n_samples: r.n_sample
  })
}

// BBJ `phenos[]` row -> normalized phenotype row (af; no mlogp/maf triplets).
function bbjPhenoRow(r: BbjPhenoRow): Record<string, unknown> {
  return phenoRow({
    phenocode: r.phenocode,
    phenostring: r.phenostring,
    category: r.category,
    pval: r.pval,
    beta: r.beta,
    sebeta: r.sebeta,
    af: r.af,
    n_cases: r.num_cases,
    n_controls: r.num_controls,
    n_samples: r.num_samples
  })
}

// Sorts phenotype rows by p-value ascending (missing p-values sort last).
function sortByPval(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const pv = (r: Record<string, unknown>): number =>
    typeof r.pval === 'number' ? r.pval : Number.POSITIVE_INFINITY
  return [...rows].sort((a, b) => pv(a) - pv(b))
}

// Resolves an instance key to its registry entry (throws on an unknown key).
function requireInstance(key: string): PhewebInstance {
  const inst = PHEWEB_INSTANCES[key as PhewebKey]
  if (!inst) {
    throw new Error(
      `Unknown PheWeb instance '${key}'. Known instances: ${Object.keys(PHEWEB_INSTANCES).join(', ')}.`
    )
  }
  return inst
}

// Guards an instance against a capability it does not expose.
function requireCapability(inst: PhewebInstance, cap: Capability, key: string): void {
  if (!inst.capabilities.includes(cap)) {
    throw new Error(
      `PheWeb instance '${key}' (${inst.label}) does not support '${cap}'. ` +
        `Capabilities: ${inst.capabilities.join(', ')}.`
    )
  }
}

// ---- the 5 tools ----------------------------------------------------------------------------

export const HUMANGENETICS_PHEWAS_TOOLS: ToolDescriptor[] = [
  {
    id: 'phewas_instances',
    connector: 'human_genetics',
    description:
      'List the public PheWeb PheWAS portals this server can query, with genome build and capability registry. Returns {instances:{key:{label, base_url, genome_build, capabilities, notes}}}. capabilities name the endpoints each instance exposes: variant (phewas_variant), gene (phewas_finngen_gene), phenotypes (phewas_list_phenotypes), autocomplete (phewas_search_phenotypes). NOTE the build split: FinnGen R12 variant IDs are GRCh38; BioBank Japan (pheweb.jp) is GRCh37/hg19 — liftover coordinates before cross-querying.',
    input: { type: 'object', properties: {} },
    returns: '{instances:{key:{label, base_url, genome_build, capabilities, notes}}}.',
    example: 'const result = await host.mcp("human_genetics", "phewas_instances", {})',
    run: async () => ({ instances: PHEWEB_INSTANCES })
  },
  {
    id: 'phewas_variant',
    connector: 'human_genetics',
    description:
      "PheWAS for one variant: its association statistics against every phenotype in a biobank PheWeb portal, most significant first. Args: instance (finngen FinnGen R12 GRCh38, or bbj BioBank Japan GRCh37; variant coords MUST be on the instance's build); variant (chrom-pos-ref-alt, :/_ separators and chr prefix tolerated, e.g. 19-44908822-C-T APOE rs7412 GRCh38/finngen or 1-55505647-G-T PCSK9 rs11591147 GRCh37/bbj); max_phenos (cap default 200; FinnGen returns ~2470 rows; sorted by p-value ascending before capping). Returns {instance, genome_build, variant, variant_meta, total, returned, truncated, phenotypes}; variant_meta {chrom, pos, ref, alt, rsids, nearest_genes, gnomad (FinnGen only)}. Each phenotype row {phenocode, phenostring, category, pval, mlogp, beta, sebeta, af|maf, maf_case, maf_control, n_cases, n_controls, n_samples} (unpublished fields null; BBJ rows have af, FinnGen rows have maf triplets + mlogp). Unknown variants raise a not-found error.",
    input: {
      type: 'object',
      properties: {
        instance: { type: 'string', enum: ['finngen', 'bbj'] },
        variant: { type: 'string' },
        max_phenos: { type: 'integer', default: 200 }
      },
      required: ['instance', 'variant']
    },
    required: ['instance', 'variant'],
    returns:
      '{instance, genome_build, variant (normalized chrom-pos-ref-alt), variant_meta{chrom, pos, ref, alt, rsids[], nearest_genes[], gnomad|null}, total, returned, truncated, phenotypes[]}.',
    example:
      'const result = await host.mcp("human_genetics", "phewas_variant", {"instance": "finngen", "variant": "19-44908822-C-T", "max_phenos": 50})',
    run: async (ctx, a) => {
      const key = String(a.instance)
      const inst = requireInstance(key)
      requireCapability(inst, 'variant', key)
      const v = normalizeVariant(String(a.variant))
      const maxPhenos = clampInt(a.max_phenos, 200, 1, 100000)
      const url = `${inst.base_url}/api/variant/${v.id}`
      const raw = await fetchOrNotFound(
        ctx,
        url,
        `Variant '${v.id}' not found on PheWeb instance '${key}' (${inst.label}).`
      )

      let variantMeta: Record<string, unknown>
      let allRows: Record<string, unknown>[]
      if (key === 'finngen') {
        const data = raw as FinngenVariantResp
        const meta = data.variant
        const ann = meta?.annotation
        const gene = ann?.annot?.gene_most_severe
        variantMeta = {
          chrom: String(meta?.chr ?? v.chrom),
          pos: meta?.pos != null ? Number(meta.pos) : Number(v.pos),
          ref: meta?.ref ?? v.ref,
          alt: meta?.alt ?? v.alt,
          rsids: splitList(ann?.rsids),
          nearest_genes: gene ? [gene] : [],
          gnomad: leanGnomad(ann?.gnomad)
        }
        allRows = (data.results ?? []).map(finngenPhenoRow)
      } else {
        const data = raw as BbjVariantResp
        variantMeta = {
          chrom: String(data.chrom ?? v.chrom),
          pos: data.pos != null ? Number(data.pos) : Number(v.pos),
          ref: data.ref ?? v.ref,
          alt: data.alt ?? v.alt,
          rsids: splitList(data.rsids),
          nearest_genes: splitList(data.nearest_genes),
          gnomad: null
        }
        allRows = (data.phenos ?? []).map(bbjPhenoRow)
      }

      const sorted = sortByPval(allRows)
      const rows = sorted.slice(0, maxPhenos)
      return {
        instance: key,
        genome_build: inst.genome_build,
        variant: v.id,
        variant_meta: variantMeta,
        total: sorted.length,
        returned: rows.length,
        truncated: sorted.length > rows.length,
        phenotypes: rows
      }
    }
  },
  {
    id: 'phewas_finngen_gene',
    connector: 'human_genetics',
    description:
      'Gene-level PheWAS from FinnGen R12: for every disease endpoint, the best-associated variant in the gene region, most significant first. Args: gene_symbol (HGNC symbol e.g. PCSK9, APOE; unknown symbols raise a not-found error); max_phenos (cap default 200; FinnGen has ~2470 endpoints, one row each; sorted by p-value ascending before capping). Returns {instance:"finngen", genome_build:"GRCh38", gene_symbol, total, returned, truncated, phenotypes}; each row is the phewas_variant row shape plus variant:{chrom, pos, ref, alt, varid, rsids} — the top variant for that endpoint in this gene\'s region (region != gene body; PheWeb pads gene boundaries). Most rows are null results (pval~1) — the per-endpoint BEST variant is still reported; filter by pval yourself for significant hits.',
    input: {
      type: 'object',
      properties: {
        gene_symbol: { type: 'string' },
        max_phenos: { type: 'integer', default: 200 }
      },
      required: ['gene_symbol']
    },
    required: ['gene_symbol'],
    returns:
      '{instance:"finngen", genome_build:"GRCh38", gene_symbol, total, returned, truncated, phenotypes[<phewas_variant row> + variant:{chrom, pos, ref, alt, varid, rsids[]}]}.',
    example:
      'const result = await host.mcp("human_genetics", "phewas_finngen_gene", {"gene_symbol": "PCSK9", "max_phenos": 50})',
    run: async (ctx, a) => {
      const inst = PHEWEB_INSTANCES.finngen
      const sym = String(a.gene_symbol).trim()
      const maxPhenos = clampInt(a.max_phenos, 200, 1, 100000)
      const url = `${inst.base_url}/api/gene_phenos/${encodeURIComponent(sym)}`
      const raw = await fetchOrNotFound(ctx, url, `Gene '${sym}' not found on FinnGen R12.`)
      const data = raw as FinngenGeneResp

      const allRows = (data.phenotypes ?? []).map((p) => {
        const row = finngenPhenoRow(p.assoc ?? {})
        const vv = p.variant
        const variant = vv
          ? {
              chrom: String(vv.chr ?? ''),
              pos: vv.pos != null ? Number(vv.pos) : null,
              ref: vv.ref ?? null,
              alt: vv.alt ?? null,
              varid: vv.varid ?? null,
              rsids: splitList(vv.annotation?.rsids)
            }
          : null
        return { ...row, variant }
      })

      const sorted = sortByPval(allRows)
      const rows = sorted.slice(0, maxPhenos)
      return {
        instance: 'finngen',
        genome_build: inst.genome_build,
        gene_symbol: sym,
        total: sorted.length,
        returned: rows.length,
        truncated: sorted.length > rows.length,
        phenotypes: rows
      }
    }
  },
  {
    id: 'phewas_list_phenotypes',
    connector: 'human_genetics',
    description:
      'Complete phenotype (disease endpoint) catalogue of a PheWeb instance, with case/control counts. Args: instance (currently only finngen exposes this endpoint; BBJ does not — use phewas_search_phenotypes there); max_records (cap default 3000 > FinnGen\'s ~2470 endpoints, so the default returns the complete catalogue). Returns {instance, total, returned, truncated, phenotypes} sorted by phenocode; each row {phenocode (e.g. "T2D"), phenostring, category, num_cases, num_controls, num_gw_significant (count of genome-wide-significant loci for that endpoint)}.',
    input: {
      type: 'object',
      properties: {
        instance: { type: 'string', enum: ['finngen'], default: 'finngen' },
        max_records: { type: 'integer', default: 3000 }
      }
    },
    returns:
      '{instance, total, returned, truncated, phenotypes[{phenocode, phenostring, category, num_cases, num_controls, num_gw_significant}]} sorted by phenocode.',
    example:
      'const result = await host.mcp("human_genetics", "phewas_list_phenotypes", {"instance": "finngen", "max_records": 3000})',
    run: async (ctx, a) => {
      const key = a.instance != null ? String(a.instance) : 'finngen'
      const inst = requireInstance(key)
      requireCapability(inst, 'phenotypes', key)
      const maxRecords = clampInt(a.max_records, 3000, 1, 100000)
      const raw = (await ctx.fetchJson(`${inst.base_url}/api/phenos`)) as FinngenPheno[]
      const all = (raw ?? []).map((p) => ({
        phenocode: p.phenocode ?? null,
        phenostring: p.phenostring ?? null,
        category: p.category ?? null,
        num_cases: p.num_cases ?? null,
        num_controls: p.num_controls ?? null,
        num_gw_significant: p.num_gw_significant ?? null
      }))
      all.sort((x, y) => String(x.phenocode ?? '').localeCompare(String(y.phenocode ?? '')))
      const rows = all.slice(0, maxRecords)
      return {
        instance: key,
        total: all.length,
        returned: rows.length,
        truncated: all.length > rows.length,
        phenotypes: rows
      }
    }
  },
  {
    id: 'phewas_search_phenotypes',
    connector: 'human_genetics',
    description:
      'Search a PheWeb instance\'s phenotypes (and entities) by name — the entry point for resolving a disease name to a phenocode. Args: query (free-text phenotype query e.g. "diabetes", "asthma"; matches phenotype names/codes; some instances also match gene names and rsIDs); instance (finngen default or bbj — both expose autocomplete); max_records (cap default 500; autocomplete responses are short lists, rarely capped). Returns {instance, query, total, returned, truncated, matches}; each match {display, phenocode, url}. Use the phenocode with phewas_list_phenotypes rows or the instance website; BBJ display strings embed the code in parentheses.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        instance: { type: 'string', enum: ['finngen', 'bbj'], default: 'finngen' },
        max_records: { type: 'integer', default: 500 }
      },
      required: ['query']
    },
    required: ['query'],
    returns: '{instance, query, total, returned, truncated, matches[{display, phenocode, url}]}.',
    example:
      'const result = await host.mcp("human_genetics", "phewas_search_phenotypes", {"query": "diabetes", "instance": "finngen"})',
    run: async (ctx, a) => {
      const key = a.instance != null ? String(a.instance) : 'finngen'
      const inst = requireInstance(key)
      requireCapability(inst, 'autocomplete', key)
      const query = String(a.query)
      const maxRecords = clampInt(a.max_records, 500, 1, 100000)
      const raw = (await ctx.fetchJson(
        `${inst.base_url}/api/autocomplete?query=${encodeURIComponent(query)}`
      )) as AutocompleteRow[]
      // FinnGen carries the phenocode in `pheno`; BBJ in `value` (+ an instance-relative `url`).
      const all = (raw ?? []).map((m) => ({
        display: m.display ?? null,
        phenocode: m.pheno ?? m.value ?? null,
        url: m.url ?? null
      }))
      const rows = all.slice(0, maxRecords)
      return {
        instance: key,
        query,
        total: all.length,
        returned: rows.length,
        truncated: all.length > rows.length,
        matches: rows
      }
    }
  }
]
