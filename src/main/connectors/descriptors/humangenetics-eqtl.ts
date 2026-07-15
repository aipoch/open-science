import type { ToolDescriptor } from '../types'

// eQTL Catalogue REST API v2 (molecular-QTL summary statistics; ~760 datasets). The API publishes
// NO total count and NO pagination link headers, so exhaustion is inferred from the page fill: a
// short page (returned < size) proves the listing/query is complete. Empty queries come back as a
// {message:"No results"} object rather than an empty array — normalized to [] here.
const BASE = 'https://www.ebi.ac.uk/eqtl/api/v2'
const MAX_SIZE = 1000

// ---- Minimal shapes of the eQTL Catalogue JSON we read ---------------------------------------

type EqtlDataset = {
  dataset_id?: string
  study_id?: string
  study_label?: string
  sample_group?: string
  tissue_id?: string
  tissue_label?: string
  condition_label?: string
  quant_method?: string
  sample_size?: number
}
type EqtlAssociation = {
  molecular_trait_id?: string
  gene_id?: string
  variant?: string
  rsid?: string
  chromosome?: string
  position?: number
  ref?: string
  alt?: string
  type?: string
  beta?: number
  se?: number
  pvalue?: number
  nlog10p?: number
  maf?: number
  ac?: number
  an?: number
  r2?: number
  median_tpm?: number
}

// ---- helpers ---------------------------------------------------------------------------------

// Reads an integer arg, applying a default when unset and clamping into [lo, hi].
function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  const base = Number.isFinite(n) && v != null && v !== '' ? Math.trunc(n) : def
  return Math.min(hi, Math.max(lo, base))
}

// The API returns either a JSON array of rows or a {message:"No results"} object; coerce the
// no-results object (and any non-array error body) to an empty list so run() never throws on empty.
function asRows<T>(resp: unknown): T[] {
  return Array.isArray(resp) ? (resp as T[]) : []
}

// Assembles a query string from entries whose value is set, URL-encoding each value.
function queryString(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')
}

function leanDataset(d: EqtlDataset): Record<string, unknown> {
  return {
    dataset_id: d.dataset_id,
    study_id: d.study_id,
    study_label: d.study_label,
    sample_group: d.sample_group,
    tissue_id: d.tissue_id,
    tissue_label: d.tissue_label,
    condition_label: d.condition_label,
    quant_method: d.quant_method,
    sample_size: d.sample_size
  }
}

function leanAssociation(r: EqtlAssociation): Record<string, unknown> {
  return {
    molecular_trait_id: r.molecular_trait_id,
    gene_id: r.gene_id,
    variant: r.variant,
    rsid: r.rsid,
    chromosome: r.chromosome,
    position: r.position,
    ref: r.ref,
    alt: r.alt,
    type: r.type,
    beta: r.beta,
    se: r.se,
    pvalue: r.pvalue,
    nlog10p: r.nlog10p,
    maf: r.maf,
    ac: r.ac,
    an: r.an,
    r2: r.r2,
    median_tpm: r.median_tpm
  }
}

// ---- the 2 tools -----------------------------------------------------------------------------

export const HUMANGENETICS_EQTL_TOOLS: ToolDescriptor[] = [
  {
    id: 'eqtl_list_datasets',
    connector: 'human_genetics',
    description:
      'List eQTL Catalogue datasets (one dataset = one study x tissue/cell type x quantification method). Args: study_label (exact study name, e.g. GTEx, Alasoo_2018, BLUEPRINT); tissue_label (exact tissue/cell-type label, e.g. liver, macrophage, LCL — lowercase in the catalogue); quant_method (ge=gene expression, exon, tx, txrev, microarray, leafcutter, aptamer=plasma protein; for conventional gene-level eQTLs use ge); max_records (cap default 1000; the full unfiltered catalogue is ~760 datasets). Returns {filters, returned, truncated, datasets} sorted by dataset_id; each {dataset_id (QTD...), study_id (QTS...), study_label, sample_group, tissue_id, tissue_label, condition_label, quant_method, sample_size}. The API publishes no total count; truncated=false proves the listing is complete.',
    input: {
      type: 'object',
      properties: {
        study_label: { type: 'string' },
        tissue_label: { type: 'string' },
        quant_method: { type: 'string' },
        max_records: { type: 'integer', default: 1000 }
      }
    },
    returns:
      '{filters (applied filter object), returned, truncated (returned == cap; a short page proves the listing complete), datasets:[{dataset_id, study_id, study_label, sample_group, tissue_id, tissue_label, condition_label, quant_method, sample_size}]} sorted by dataset_id.',
    example:
      'result = host.mcp("human_genetics", "eqtl_list_datasets", {"study_label": "Alasoo_2018", "quant_method": "ge"})',
    run: async (ctx, a) => {
      const maxRecords = clampInt(a.max_records, 1000, 1, MAX_SIZE)
      const filters: Record<string, string> = {}
      if (a.study_label != null && String(a.study_label) !== '')
        filters['study_label'] = String(a.study_label)
      if (a.tissue_label != null && String(a.tissue_label) !== '')
        filters['tissue_label'] = String(a.tissue_label)
      if (a.quant_method != null && String(a.quant_method) !== '')
        filters['quant_method'] = String(a.quant_method)

      const qs = queryString({ ...filters, size: maxRecords })
      const resp = await ctx.fetchJson(`${BASE}/datasets?${qs}`)
      const rows = asRows<EqtlDataset>(resp)
      // Deterministic order regardless of upstream order.
      rows.sort((x, y) => String(x.dataset_id).localeCompare(String(y.dataset_id)))
      const datasets = rows.map(leanDataset)
      return {
        filters,
        returned: datasets.length,
        // A full page (== cap) may hide more rows; a short page proves exhaustion.
        truncated: datasets.length >= maxRecords,
        datasets
      }
    }
  },
  {
    id: 'eqtl_associations',
    connector: 'human_genetics',
    description:
      'Molecular-QTL association rows from one eQTL Catalogue dataset, filtered by gene, variant or region. Args: dataset_id (QTD accession from eqtl_list_datasets, e.g. QTD000266); gene_id (unversioned Ensembl gene ID e.g. ENSG00000130203 APOE; at least one of gene_id/rsid/variant/pos is required); rsid (dbSNP rsID); variant (eQTL Catalogue variant string chr19_44908822_C_T, chr-prefixed underscore GRCh38); pos (genomic window chromosome:start-end GRCh38 no chr prefix, e.g. 19:44900000-44920000); nlog10p_min (significance floor: only rows with -log10(p) >= this, applied upstream); max_records (cap default 1000 = one page). Returns {dataset_id, filters, returned, truncated, associations}; each row {molecular_trait_id, gene_id, variant, rsid, chromosome, position, ref, alt, type, beta, se, pvalue, nlog10p, maf, ac, an, r2, median_tpm}. Rows cover ONLY the cis window the dataset tested (±1 Mb of each gene); empty means "not tested / not present". No total count is published: truncated=false proves exhaustion, truncated=true means the cap was hit.',
    input: {
      type: 'object',
      properties: {
        dataset_id: { type: 'string' },
        gene_id: { type: 'string' },
        rsid: { type: 'string' },
        variant: { type: 'string' },
        pos: { type: 'string' },
        nlog10p_min: { type: 'number' },
        max_records: { type: 'integer', default: 1000 }
      },
      required: ['dataset_id']
    },
    required: ['dataset_id'],
    returns:
      '{dataset_id, filters (applied filter object incl. nlog10p_min), returned, truncated (returned == cap), associations:[{molecular_trait_id, gene_id, variant, rsid, chromosome, position, ref, alt, type, beta, se, pvalue, nlog10p, maf, ac, an, r2, median_tpm}]}.',
    example:
      'result = host.mcp("human_genetics", "eqtl_associations", {"dataset_id": "QTD000266", "gene_id": "ENSG00000130203", "nlog10p_min": 2})',
    run: async (ctx, a) => {
      const datasetId = String(a.dataset_id)
      const geneId = a.gene_id != null && String(a.gene_id) !== '' ? String(a.gene_id) : undefined
      const rsid = a.rsid != null && String(a.rsid) !== '' ? String(a.rsid) : undefined
      const variant = a.variant != null && String(a.variant) !== '' ? String(a.variant) : undefined
      const pos = a.pos != null && String(a.pos) !== '' ? String(a.pos) : undefined

      // The API rejects an unfiltered association query; require at least one locus filter.
      if (!geneId && !rsid && !variant && !pos) {
        throw new Error(
          'eqtl_associations requires at least one of gene_id, rsid, variant, or pos to filter the dataset.'
        )
      }
      const maxRecords = clampInt(a.max_records, 1000, 1, MAX_SIZE)
      const nlog10pMin =
        a.nlog10p_min != null && a.nlog10p_min !== '' && Number.isFinite(Number(a.nlog10p_min))
          ? Number(a.nlog10p_min)
          : undefined

      // Applied-filter object surfaced in the output (nlog10p_min under its tool-facing name).
      const filters: Record<string, unknown> = {}
      if (geneId) filters['gene_id'] = geneId
      if (rsid) filters['rsid'] = rsid
      if (variant) filters['variant'] = variant
      if (pos) filters['pos'] = pos
      if (nlog10pMin != null) filters['nlog10p_min'] = nlog10pMin

      // Upstream min-significance filter is the `nlog10p` query param.
      const qs = queryString({
        gene_id: geneId,
        rsid,
        variant,
        pos,
        nlog10p: nlog10pMin,
        size: maxRecords
      })
      // The v2 associations endpoint returns HTTP 400 {"message":"No results"} when a well-formed
      // filter simply matches nothing (a normal "not tested / not present" outcome, per the docs).
      // The engine strips the body, and validation errors are 422, so a 400 here is treated as empty.
      let resp: unknown
      try {
        resp = await ctx.fetchJson(
          `${BASE}/datasets/${encodeURIComponent(datasetId)}/associations?${qs}`
        )
      } catch (err) {
        if (err instanceof Error && /HTTP 400\b/.test(err.message)) {
          return { dataset_id: datasetId, filters, returned: 0, truncated: false, associations: [] }
        }
        throw err
      }
      const rows = asRows<EqtlAssociation>(resp)
      const associations = rows.map(leanAssociation)
      return {
        dataset_id: datasetId,
        filters,
        returned: associations.length,
        // No total is published: a full page (== cap) means more may exist; a short page exhausts.
        truncated: associations.length >= maxRecords,
        associations
      }
    }
  }
]
