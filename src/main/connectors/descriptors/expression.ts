import type { ToolDescriptor } from '../types'

const GTEX = 'https://gtexportal.org/api/v2'
const DEFAULT_DATASET = 'gtex_v8'

type GtexGeneRef = {
  geneSymbol?: string
  gencodeId?: string
  gencodeVersion?: string
  genomeBuild?: string
}

type GtexGeneRefResponse = { data?: GtexGeneRef[] }

type GtexMedianExpressionRow = {
  tissueSiteDetailId?: string
  median?: number
  unit?: string
}

type GtexMedianExpressionResponse = { data?: GtexMedianExpressionRow[] }

// GTEx Portal API v2: read-only gene reference resolution + median tissue expression (bulk RNA-seq).
// Both routes wrap their rows in a top-level `data` array (confirmed live against v2).
export const EXPRESSION_TOOLS: ToolDescriptor[] = [
  {
    id: 'gtex_resolve_gene',
    connector: 'expression',
    description:
      'Resolve a gene symbol (or unversioned Ensembl id) to its versioned GTEx gencodeId, e.g. BRCA2 -> ENSG00000139618.14.',
    input: {
      type: 'object',
      properties: { geneId: { type: 'string' } },
      required: ['geneId']
    },
    required: ['geneId'],
    returns:
      '`[ { "gene_symbol": str, "gencode_id": str, "gencode_version": str, "genome_build": str } ]` — array of matching gene references (usually one); `[]` when the gene isn\'t found. Fields are undefined if absent upstream.',
    url: (a) => `${GTEX}/reference/gene?geneId=${encodeURIComponent(String(a.geneId))}`,
    parse: (raw) =>
      ((raw as GtexGeneRefResponse).data ?? []).map((g) => ({
        gene_symbol: g.geneSymbol,
        gencode_id: g.gencodeId,
        gencode_version: g.gencodeVersion,
        genome_build: g.genomeBuild
      }))
  },
  {
    id: 'gtex_gene_expression',
    connector: 'expression',
    description:
      'Median gene expression (TPM) across GTEx tissues for a versioned GENCODE id (use gtex_resolve_gene first to get one from a gene symbol).',
    input: {
      type: 'object',
      properties: {
        gencodeId: { type: 'string' },
        datasetId: { type: 'string', default: DEFAULT_DATASET }
      },
      required: ['gencodeId']
    },
    required: ['gencodeId'],
    returns:
      '`[ { "tissue": str, "median_tpm": float, "unit": str } ]` — one row per GTEx tissue site; `median_tpm` in TPM. `[]` when the gencodeId is unknown for the dataset.',
    url: (a) => {
      const dataset = String(a.datasetId ?? DEFAULT_DATASET)
      return `${GTEX}/expression/medianGeneExpression?gencodeId=${encodeURIComponent(String(a.gencodeId))}&datasetId=${encodeURIComponent(dataset)}`
    },
    parse: (raw) =>
      ((raw as GtexMedianExpressionResponse).data ?? []).map((r) => ({
        tissue: r.tissueSiteDetailId,
        median_tpm: r.median,
        unit: r.unit
      }))
  }
]
