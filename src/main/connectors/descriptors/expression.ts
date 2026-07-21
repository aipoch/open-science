import type { ToolContext, ToolDescriptor } from '../types'

const GTEX = 'https://gtexportal.org/api/v2'
const DEFAULT_DATASET = 'gtex_v8'
// GTEx caps a single page at 1000 rows; use it to minimise round-trips when walking paged routes.
const PAGE_SIZE = 1000

// A pinned dataset release maps to a fixed GENCODE version; the /reference/gene route keys off the
// GENCODE version (it has no datasetId param) so gene resolution can be pinned to the release.
const DATASET_GENCODE_VERSION: Record<string, string> = {
  gtex_v7: 'v19',
  gtex_v8: 'v26',
  gtex_v10: 'v39'
}

// Standard GTEx v2 paged envelope: rows under `data`, page counts under `paging_info`.
type PagingInfo = { numberOfPages?: number; page?: number; totalNumberOfItems?: number }
type PagedResponse = { data?: Record<string, unknown>[]; paging_info?: PagingInfo }

// Reads a top-level `dataset_id` arg, falling back to the default release.
function datasetOf(args: Record<string, unknown>): string {
  return String(args.dataset_id ?? DEFAULT_DATASET)
}

// Renders repeated query params for a list-valued arg (GTEx accepts `name=a&name=b`); '' when empty.
function repeatParam(name: string, value: unknown): string {
  if (value == null) return ''
  const values = Array.isArray(value) ? value : [value]
  return values.map((v) => `&${name}=${encodeURIComponent(String(v))}`).join('')
}

// Walks every page of a GTEx paged route and returns the collected rows plus the API-reported total.
// Stops early once `cap` rows are gathered (then `truncated` reflects that more rows exist upstream).
async function walkPages(
  ctx: ToolContext,
  baseUrl: string,
  cap?: number
): Promise<{ rows: Record<string, unknown>[]; total: number; truncated: boolean }> {
  const rows: Record<string, unknown>[] = []
  let total = 0
  for (let page = 0; ; page++) {
    const sep = baseUrl.includes('?') ? '&' : '?'
    const res = (await ctx.fetchJson(
      `${baseUrl}${sep}page=${page}&itemsPerPage=${PAGE_SIZE}`
    )) as PagedResponse
    const data = res.data ?? []
    total = res.paging_info?.totalNumberOfItems ?? total
    for (const row of data) {
      rows.push(row)
      if (cap != null && rows.length >= cap) return { rows, total, truncated: total > rows.length }
    }
    const numPages = res.paging_info?.numberOfPages ?? 1
    if (data.length === 0 || page + 1 >= numPages) break
  }
  // A complete (uncapped) walk is count-verified against the API's own total, mirroring upstream.
  if (cap == null && total > 0 && rows.length !== total) {
    throw new Error(`GTEx paging count mismatch: collected ${rows.length} of ${total} rows`)
  }
  return { rows, total, truncated: cap != null && total > rows.length }
}

// Maps a raw /reference/gene record to the curated gene reference shape shared by resolve + summary.
function geneRecord(g: Record<string, unknown>): Record<string, unknown> {
  return {
    gene_symbol: g.geneSymbol,
    gencode_id: g.gencodeId,
    ensembl_id: typeof g.gencodeId === 'string' ? g.gencodeId.split('.')[0] : undefined,
    gencode_version: g.gencodeVersion,
    genome_build: g.genomeBuild,
    chromosome: g.chromosome,
    start: g.start,
    end: g.end,
    strand: g.strand,
    entrez_gene_id: g.entrezGeneId,
    gene_type: g.geneType,
    description: g.description
  }
}

// GTEx Portal API v2 (https://gtexportal.org/api/v2): read-only tissue/sample metadata, bulk RNA-seq
// expression, and precomputed/on-the-fly eQTL associations. Tool ids mirror the official openscience
// GTEx surface; paged routes are walked to a count-verified `total`.
export const EXPRESSION_TOOLS: ToolDescriptor[] = [
  {
    id: 'gtex_tissue_sites',
    connector: 'expression',
    description:
      'List all tissue sites with metadata for a pinned GTEx release (54 in gtex_v8): sample counts, eGene/sGene counts, colour codes, and UBERON ontology ids.',
    input: {
      type: 'object',
      properties: { dataset_id: { type: 'string', default: DEFAULT_DATASET } }
    },
    returns:
      '`{ "total": int, "tissues": [ { "tissue_site_detail_id": str, "tissue_site_detail": str, "tissue_site": str, "abbreviation": str, "color_hex": str, "color_rgb": str, "egene_count": int, "sgene_count": int, "expressed_gene_count": int, "rnaseq_sample_count": int, "eqtl_sample_count": int, "ontology_id": str } ] }` — `total` is the API-verified row count (54 for gtex_v8).',
    example:
      'const result = await host.mcp("expression", "gtex_tissue_sites", {"dataset_id": "gtex_v8"})',
    url: (a) =>
      `${GTEX}/dataset/tissueSiteDetail?datasetId=${encodeURIComponent(String(a.dataset_id ?? DEFAULT_DATASET))}&itemsPerPage=${PAGE_SIZE}`,
    parse: (raw) => {
      const res = raw as PagedResponse
      const tissues = (res.data ?? []).map((t) => ({
        tissue_site_detail_id: t.tissueSiteDetailId,
        tissue_site_detail: t.tissueSiteDetail,
        tissue_site: t.tissueSite,
        abbreviation: t.tissueSiteDetailAbbr,
        color_hex: t.colorHex,
        color_rgb: t.colorRgb,
        egene_count: t.eGeneCount,
        sgene_count: t.sGeneCount,
        expressed_gene_count: t.expressedGeneCount,
        rnaseq_sample_count: (t.rnaSeqSampleSummary as { totalCount?: number } | undefined)
          ?.totalCount,
        eqtl_sample_count: (t.eqtlSampleSummary as { totalCount?: number } | undefined)?.totalCount,
        ontology_id: t.ontologyId
      }))
      return { total: res.paging_info?.totalNumberOfItems ?? tissues.length, tissues }
    }
  },
  {
    id: 'gtex_dataset_info',
    connector: 'expression',
    description:
      'List all GTEx dataset releases with metadata: datasetId, GENCODE version, genome build, dbSNP build, and sample/subject/tissue counts.',
    input: {
      type: 'object',
      properties: { dataset_id: { type: 'string' }, organization_name: { type: 'string' } }
    },
    returns:
      '`[ { "dataset_id": str, "display_name": str, "gencode_version": str, "genome_build": str, "dbsnp_build": int, "organization": str, "rnaseq_sample_count": int, "rnaseq_and_genotype_sample_count": int, "subject_count": int, "eqtl_subject_count": int, "eqtl_tissue_count": int, "tissue_count": int, "description": str } ]` — one row per release (e.g. gtex_v7, gtex_v8).',
    example: 'const result = await host.mcp("expression", "gtex_dataset_info", {})',
    url: (a) => {
      const params = [
        a.dataset_id ? `datasetId=${encodeURIComponent(String(a.dataset_id))}` : '',
        a.organization_name
          ? `organizationName=${encodeURIComponent(String(a.organization_name))}`
          : ''
      ].filter(Boolean)
      return `${GTEX}/metadata/dataset${params.length ? `?${params.join('&')}` : ''}`
    },
    // This route returns a bare array (no `data`/`paging_info` envelope), unlike the paged routes.
    parse: (raw) =>
      (raw as Record<string, unknown>[]).map((d) => ({
        dataset_id: d.datasetId,
        display_name: d.displayName,
        gencode_version: d.gencodeVersion,
        genome_build: d.genomeBuild,
        dbsnp_build: d.dbSnpBuild,
        organization: d.organization,
        rnaseq_sample_count: d.rnaSeqSampleCount,
        rnaseq_and_genotype_sample_count: d.rnaSeqAndGenotypeSampleCount,
        subject_count: d.subjectCount,
        eqtl_subject_count: d.eqtlSubjectCount,
        eqtl_tissue_count: d.eqtlTissuesCount,
        tissue_count: d.tissueCount,
        description: d.description
      }))
  },
  {
    id: 'gtex_sample_info',
    connector: 'expression',
    description:
      'Sample and donor metadata for a pinned GTEx release, optionally filtered by tissue_site_detail_id, data_type (e.g. RNASEQ, WGS), or subject_id. Paged and count-verified; an unfiltered call matches tens of thousands of samples, so filter or set max_samples.',
    input: {
      type: 'object',
      properties: {
        tissue_site_detail_id: { type: 'string' },
        data_type: { type: 'string' },
        subject_id: { type: 'string' },
        max_samples: { type: 'integer' },
        dataset_id: { type: 'string', default: DEFAULT_DATASET }
      }
    },
    returns:
      '`{ "total": int, "returned": int, "truncated": bool, "samples": [ { "sample_id": str, "subject_id": str, "tissue_site_detail_id": str, "tissue_site_detail": str, "data_type": str, "sex": str, "age_bracket": str, "hardy_scale": int, "ischemic_time": int, "rin": float, "autolysis_score": int, "pathology_notes": str, "uberon_id": str } ] }` — `total` is the API-verified match count; `truncated` is true when capped by max_samples.',
    example:
      'const result = await host.mcp("expression", "gtex_sample_info", {"tissue_site_detail_id": "Liver", "data_type": "RNASEQ", "max_samples": 100})',
    run: async (ctx, a) => {
      const cap = a.max_samples != null ? Math.max(1, Number(a.max_samples)) : undefined
      const base =
        `${GTEX}/dataset/sample?datasetId=${encodeURIComponent(datasetOf(a))}` +
        repeatParam('tissueSiteDetailId', a.tissue_site_detail_id) +
        repeatParam('dataType', a.data_type) +
        repeatParam('subjectId', a.subject_id)
      const { rows, total, truncated } = await walkPages(ctx, base, cap)
      return {
        total,
        returned: rows.length,
        truncated,
        samples: rows.map((r) => ({
          sample_id: r.sampleId,
          subject_id: r.subjectId,
          tissue_site_detail_id: r.tissueSiteDetailId,
          tissue_site_detail: r.tissueSiteDetail,
          data_type: r.dataType,
          sex: r.sex,
          age_bracket: r.ageBracket,
          hardy_scale: r.hardyScale,
          ischemic_time: r.ischemicTime,
          rin: r.rin,
          autolysis_score: r.autolysisScore,
          pathology_notes: r.pathologyNotes,
          uberon_id: r.uberonId
        }))
      }
    }
  },
  {
    id: 'gtex_resolve_genes',
    connector: 'expression',
    description:
      'Resolve gene symbols or unversioned Ensembl ids to versioned GENCODE ids for a pinned release, e.g. GAPDH -> ENSG00000111640.14. Feed the ids to the expression / eQTL tools.',
    input: {
      type: 'object',
      properties: {
        genes: { type: 'array', items: { type: 'string' } },
        dataset_id: { type: 'string', default: DEFAULT_DATASET }
      },
      required: ['genes']
    },
    required: ['genes'],
    returns:
      '`{ "total": int, "genes": [ { "gene_symbol": str, "gencode_id": str, "ensembl_id": str, "gencode_version": str, "genome_build": str, "chromosome": str, "start": int, "end": int, "strand": str, "entrez_gene_id": int, "gene_type": str, "description": str } ] }` — one record per matched reference gene; unmatched inputs are simply absent.',
    example:
      'const result = await host.mcp("expression", "gtex_resolve_genes", {"genes": ["GAPDH", "BRCA2"]})',
    url: (a) => {
      const version = DATASET_GENCODE_VERSION[datasetOf(a)]
      return (
        `${GTEX}/reference/gene?itemsPerPage=${PAGE_SIZE}` +
        repeatParam('geneId', a.genes) +
        (version ? `&gencodeVersion=${encodeURIComponent(version)}` : '')
      )
    },
    parse: (raw) => {
      const res = raw as PagedResponse
      const genes = (res.data ?? []).map(geneRecord)
      return { total: res.paging_info?.totalNumberOfItems ?? genes.length, genes }
    }
  },
  {
    id: 'gtex_median_expression',
    connector: 'expression',
    description:
      'Median gene expression (TPM) for one or more VERSIONED GENCODE ids across tissues (omit tissues for all). Paged and count-verified over (gene, tissue) rows.',
    input: {
      type: 'object',
      properties: {
        gencode_ids: { type: 'array', items: { type: 'string' } },
        tissue_site_detail_ids: { type: 'array', items: { type: 'string' } },
        dataset_id: { type: 'string', default: DEFAULT_DATASET }
      },
      required: ['gencode_ids']
    },
    required: ['gencode_ids'],
    returns:
      '`{ "total": int, "returned": int, "rows": [ { "gencode_id": str, "gene_symbol": str, "tissue_site_detail_id": str, "median_tpm": float, "unit": str } ] }` — one row per (gene, tissue); `total` is the API-verified row count.',
    example:
      'const result = await host.mcp("expression", "gtex_median_expression", {"gencode_ids": ["ENSG00000111640.14"]})',
    run: async (ctx, a) => {
      const base =
        `${GTEX}/expression/medianGeneExpression?datasetId=${encodeURIComponent(datasetOf(a))}` +
        repeatParam('gencodeId', a.gencode_ids) +
        repeatParam('tissueSiteDetailId', a.tissue_site_detail_ids)
      const { rows, total } = await walkPages(ctx, base)
      return {
        total,
        returned: rows.length,
        rows: rows.map((r) => ({
          gencode_id: r.gencodeId,
          gene_symbol: r.geneSymbol,
          tissue_site_detail_id: r.tissueSiteDetailId,
          median_tpm: r.median,
          unit: r.unit
        }))
      }
    }
  },
  {
    id: 'gtex_expression_summary',
    connector: 'expression',
    description:
      'Summarize a gene’s expression across ALL tissues ranked by descending median TPM. Accepts a symbol or Ensembl id and auto-resolves it to a versioned GENCODE id first.',
    input: {
      type: 'object',
      properties: {
        gene: { type: 'string' },
        dataset_id: { type: 'string', default: DEFAULT_DATASET }
      },
      required: ['gene']
    },
    required: ['gene'],
    returns:
      '`{ "gene": { gene reference record }, "total_tissues": int, "tissues": [ { "tissue_site_detail_id": str, "median_tpm": float, "unit": str } ] }` — tissues sorted by descending median TPM. Raises if the gene is not in the GTEx reference.',
    example:
      'const result = await host.mcp("expression", "gtex_expression_summary", {"gene": "GAPDH"})',
    // Multi-step: resolve the symbol, then rank its per-tissue medians.
    run: async (ctx, a) => {
      const version = DATASET_GENCODE_VERSION[datasetOf(a)]
      const refUrl =
        `${GTEX}/reference/gene?geneId=${encodeURIComponent(String(a.gene))}` +
        (version ? `&gencodeVersion=${encodeURIComponent(version)}` : '')
      const ref = (await ctx.fetchJson(refUrl)) as PagedResponse
      const query = String(a.gene)
      const q = query.toUpperCase()
      const qBare = q.split('.')[0]
      // Mirror upstream: pick the exact symbol / gencode / unversioned-Ensembl match, not just row 0.
      const first = (ref.data ?? []).find((g) => {
        const sym = String(g.geneSymbol ?? '').toUpperCase()
        const gid = String(g.gencodeId ?? '')
        return sym === q || gid === query || gid.split('.')[0].toUpperCase() === qBare
      })
      if (!first) throw new Error(`gene not found in GTEx reference: ${query}`)
      const gencodeId = String(first.gencodeId)
      const medUrl =
        `${GTEX}/expression/medianGeneExpression?datasetId=${encodeURIComponent(datasetOf(a))}` +
        `&gencodeId=${encodeURIComponent(gencodeId)}`
      const { rows } = await walkPages(ctx, medUrl)
      const tissues = rows
        .map((r) => ({
          tissue_site_detail_id: r.tissueSiteDetailId,
          median_tpm: r.median,
          unit: r.unit
        }))
        .sort((x, y) => Number(y.median_tpm ?? 0) - Number(x.median_tpm ?? 0))
      return { gene: geneRecord(first), total_tissues: tissues.length, tissues }
    }
  },
  {
    id: 'gtex_gene_expression',
    connector: 'expression',
    description:
      'Sample-level (not aggregated) expression TPM arrays for one VERSIONED GENCODE id, per tissue (omit tissues for all). Returns the full per-sample TPM array and n_samples for each tissue.',
    input: {
      type: 'object',
      properties: {
        gencode_id: { type: 'string' },
        tissue_site_detail_ids: { type: 'array', items: { type: 'string' } },
        dataset_id: { type: 'string', default: DEFAULT_DATASET }
      },
      required: ['gencode_id']
    },
    required: ['gencode_id'],
    returns:
      '`[ { "tissue_site_detail_id": str, "gencode_id": str, "gene_symbol": str, "unit": str, "n_samples": int, "expression": [float] } ]` — one entry per tissue; `expression` is the raw per-sample TPM array.',
    example:
      'const result = await host.mcp("expression", "gtex_gene_expression", {"gencode_id": "ENSG00000111640.14", "tissue_site_detail_ids": ["Whole_Blood"]})',
    url: (a) =>
      `${GTEX}/expression/geneExpression?datasetId=${encodeURIComponent(datasetOf(a))}` +
      `&gencodeId=${encodeURIComponent(String(a.gencode_id))}` +
      repeatParam('tissueSiteDetailId', a.tissue_site_detail_ids) +
      `&itemsPerPage=${PAGE_SIZE}`,
    parse: (raw) => {
      const res = raw as PagedResponse
      return (res.data ?? []).map((r) => {
        const expression = (r.data as number[] | undefined) ?? []
        return {
          tissue_site_detail_id: r.tissueSiteDetailId,
          gencode_id: r.gencodeId,
          gene_symbol: r.geneSymbol,
          unit: r.unit,
          n_samples: expression.length,
          expression
        }
      })
    }
  },
  {
    id: 'gtex_top_expressed_genes',
    connector: 'expression',
    description:
      'Top-n genes by median TPM in one tissue, using the API-side ranking. filter_mt_gene (default true) drops mitochondrial genes from the ranking.',
    input: {
      type: 'object',
      properties: {
        tissue_site_detail_id: { type: 'string' },
        n: { type: 'integer', default: 100 },
        filter_mt_gene: { type: 'boolean', default: true },
        dataset_id: { type: 'string', default: DEFAULT_DATASET }
      },
      required: ['tissue_site_detail_id']
    },
    required: ['tissue_site_detail_id'],
    returns:
      '`{ "tissue_site_detail_id": str, "total_genes_in_ranking": int, "returned": int, "genes": [ { "gencode_id": str, "gene_symbol": str, "median_tpm": float, "unit": str } ] }` — genes in rank order; `total_genes_in_ranking` is the full ranking size (~56k).',
    example:
      'const result = await host.mcp("expression", "gtex_top_expressed_genes", {"tissue_site_detail_id": "Whole_Blood", "n": 20})',
    run: async (ctx, a) => {
      const n = Math.max(0, Number(a.n ?? 100))
      const filterMt = a.filter_mt_gene ?? true
      const base =
        `${GTEX}/expression/topExpressedGene?datasetId=${encodeURIComponent(datasetOf(a))}` +
        `&tissueSiteDetailId=${encodeURIComponent(String(a.tissue_site_detail_id))}` +
        `&filterMtGene=${filterMt ? 'true' : 'false'}`
      const { rows, total } = await walkPages(ctx, base, n)
      return {
        tissue_site_detail_id: a.tissue_site_detail_id,
        total_genes_in_ranking: total,
        returned: rows.length,
        genes: rows.map((r) => ({
          gencode_id: r.gencodeId,
          gene_symbol: r.geneSymbol,
          median_tpm: r.median,
          unit: r.unit
        }))
      }
    }
  },
  {
    id: 'gtex_eqtl_genes',
    connector: 'expression',
    description:
      'All eGenes (genes with ≥1 significant cis-eQTL) for a tissue. Walked page-by-page and count-verified (e.g. Pancreas gtex_v8 = 9,660). max_genes caps how many rows are returned.',
    input: {
      type: 'object',
      properties: {
        tissue_site_detail_id: { type: 'string' },
        max_genes: { type: 'integer' },
        dataset_id: { type: 'string', default: DEFAULT_DATASET }
      },
      required: ['tissue_site_detail_id']
    },
    required: ['tissue_site_detail_id'],
    returns:
      '`{ "total": int, "returned": int, "truncated": bool, "genes": [ { "gencode_id": str, "gene_symbol": str, "empirical_p_value": float, "p_value": float, "p_value_threshold": float, "q_value": float, "log2_allelic_fold_change": float } ] }` — `total` is exact even when truncated by max_genes.',
    example:
      'const result = await host.mcp("expression", "gtex_eqtl_genes", {"tissue_site_detail_id": "Pancreas", "max_genes": 100})',
    run: async (ctx, a) => {
      const cap = a.max_genes != null ? Number(a.max_genes) : undefined
      const base =
        `${GTEX}/association/egene?datasetId=${encodeURIComponent(datasetOf(a))}` +
        `&tissueSiteDetailId=${encodeURIComponent(String(a.tissue_site_detail_id))}`
      const { rows, total, truncated } = await walkPages(ctx, base, cap)
      return {
        total,
        returned: rows.length,
        truncated,
        genes: rows.map((r) => ({
          gencode_id: r.gencodeId,
          gene_symbol: r.geneSymbol,
          empirical_p_value: r.empiricalPValue,
          p_value: r.pValue,
          p_value_threshold: r.pValueThreshold,
          q_value: r.qValue,
          log2_allelic_fold_change: r.log2AllelicFoldChange
        }))
      }
    }
  },
  {
    id: 'gtex_single_tissue_eqtls',
    connector: 'expression',
    description:
      'Significant single-tissue cis-eQTL associations for a gene and/or a variant (precomputed). Provide gencode_id and/or variant_id; tissue_site_detail_id optionally narrows. Paged and count-verified.',
    input: {
      type: 'object',
      properties: {
        gencode_id: { type: 'string' },
        variant_id: { type: 'string' },
        tissue_site_detail_id: { type: 'string' },
        max_results: { type: 'integer' },
        dataset_id: { type: 'string', default: DEFAULT_DATASET }
      }
    },
    returns:
      '`{ "total": int, "returned": int, "truncated": bool, "eqtls": [ { "gencode_id": str, "gene_symbol": str, "variant_id": str, "snp_id": str, "chromosome": str, "pos": int, "tissue_site_detail_id": str, "p_value": float, "nes": float } ] }` — precomputed significant associations.',
    example:
      'const result = await host.mcp("expression", "gtex_single_tissue_eqtls", {"gencode_id": "ENSG00000111640.14"})',
    run: async (ctx, a) => {
      if (a.gencode_id == null && a.variant_id == null) {
        throw new Error('gtex_single_tissue_eqtls requires gencode_id and/or variant_id')
      }
      const cap = a.max_results != null ? Number(a.max_results) : undefined
      const base =
        `${GTEX}/association/singleTissueEqtl?datasetId=${encodeURIComponent(datasetOf(a))}` +
        (a.gencode_id ? `&gencodeId=${encodeURIComponent(String(a.gencode_id))}` : '') +
        (a.variant_id ? `&variantId=${encodeURIComponent(String(a.variant_id))}` : '') +
        (a.tissue_site_detail_id
          ? `&tissueSiteDetailId=${encodeURIComponent(String(a.tissue_site_detail_id))}`
          : '')
      const { rows, total, truncated } = await walkPages(ctx, base, cap)
      return {
        total,
        returned: rows.length,
        truncated,
        eqtls: rows.map((r) => ({
          gencode_id: r.gencodeId,
          gene_symbol: r.geneSymbol,
          variant_id: r.variantId,
          snp_id: r.snpId,
          chromosome: r.chromosome,
          pos: r.pos,
          tissue_site_detail_id: r.tissueSiteDetailId,
          p_value: r.pValue,
          nes: r.nes
        }))
      }
    }
  },
  {
    id: 'gtex_multi_tissue_eqtls',
    connector: 'expression',
    description:
      'Multi-tissue cis-eQTL meta-analysis (METASOFT) for a VERSIONED GENCODE id. variant_id optionally narrows to one variant. Returns per-variant rows with per-tissue m-values, NES, p-values, and SEs.',
    input: {
      type: 'object',
      properties: {
        gencode_id: { type: 'string' },
        variant_id: { type: 'string' },
        dataset_id: { type: 'string', default: DEFAULT_DATASET }
      },
      required: ['gencode_id']
    },
    required: ['gencode_id'],
    returns:
      '`{ "total": int, "returned": int, "variants": [ { "gencode_id": str, "variant_id": str, "meta_p": float, "tissues": { <tissue_site_detail_id>: { "m_value": float, "nes": float, "p_value": float, "se": float } } } ] }` — one row per variant tested for the gene; `total` is the variant count.',
    example:
      'const result = await host.mcp("expression", "gtex_multi_tissue_eqtls", {"gencode_id": "ENSG00000111640.14"})',
    run: async (ctx, a) => {
      const base =
        `${GTEX}/association/metasoft?datasetId=${encodeURIComponent(datasetOf(a))}` +
        `&gencodeId=${encodeURIComponent(String(a.gencode_id))}` +
        (a.variant_id ? `&variantId=${encodeURIComponent(String(a.variant_id))}` : '')
      const { rows, total } = await walkPages(ctx, base)
      return {
        total,
        returned: rows.length,
        variants: rows.map((r) => {
          // Rename each per-tissue metric block from upstream camelCase to snake_case.
          const tissuesRaw = (r.tissues ?? {}) as Record<string, Record<string, unknown>>
          const tissues: Record<string, unknown> = {}
          for (const [name, m] of Object.entries(tissuesRaw)) {
            tissues[name] = { m_value: m.mValue, nes: m.nes, p_value: m.pValue, se: m.se }
          }
          return {
            gencode_id: r.gencodeId,
            variant_id: r.variantId,
            meta_p: r.metaP,
            tissues
          }
        })
      }
    }
  },
  {
    id: 'gtex_calculate_eqtl',
    connector: 'expression',
    description:
      'Calculate an eQTL on the fly for any gene-variant pair in one tissue, including non-significant pairs. Returns p-value, NES, t-statistic, MAF, and the per-sample genotype/expression arrays.',
    input: {
      type: 'object',
      properties: {
        gencode_id: { type: 'string' },
        variant_id: { type: 'string' },
        tissue_site_detail_id: { type: 'string' },
        dataset_id: { type: 'string', default: DEFAULT_DATASET }
      },
      required: ['gencode_id', 'variant_id', 'tissue_site_detail_id']
    },
    required: ['gencode_id', 'variant_id', 'tissue_site_detail_id'],
    returns:
      '`{ "gencode_id": str, "gene_symbol": str, "variant_id": str, "tissue_site_detail_id": str, "p_value": float, "nes": float, "t_statistic": float, "maf": float, "hom_ref_count": int, "het_count": int, "hom_alt_count": int, "n_samples": int, "samples": [ { "genotype": float, "expression": float } ] }` — `samples` sorted by (genotype, expression).',
    example:
      'const result = await host.mcp("expression", "gtex_calculate_eqtl", {"gencode_id": "ENSG00000111640.14", "variant_id": "chr12_6452899_G_A_b38", "tissue_site_detail_id": "Whole_Blood"})',
    url: (a) =>
      `${GTEX}/association/dyneqtl?datasetId=${encodeURIComponent(datasetOf(a))}` +
      `&gencodeId=${encodeURIComponent(String(a.gencode_id))}` +
      `&variantId=${encodeURIComponent(String(a.variant_id))}` +
      `&tissueSiteDetailId=${encodeURIComponent(String(a.tissue_site_detail_id))}`,
    parse: (raw) => {
      const d = raw as Record<string, unknown>
      const genotypes = (d.genotypes as number[] | undefined) ?? []
      const expression = (d.data as number[] | undefined) ?? []
      // Upstream returns genotype/expression in random order; pair and sort deterministically.
      const samples = genotypes
        .map((genotype, i) => ({ genotype, expression: expression[i] }))
        .sort((x, y) => x.genotype - y.genotype || x.expression - y.expression)
      return {
        gencode_id: d.gencodeId,
        gene_symbol: d.geneSymbol,
        variant_id: d.variantId,
        tissue_site_detail_id: d.tissueSiteDetailId,
        p_value: d.pValue,
        nes: d.nes,
        t_statistic: d.tStatistic,
        maf: d.maf,
        hom_ref_count: d.homoRefCount,
        het_count: d.hetCount,
        hom_alt_count: d.homoAltCount,
        n_samples: samples.length,
        samples
      }
    }
  }
]
