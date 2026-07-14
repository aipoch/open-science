import { ncbiEtiquette } from '../engine'
import type { ToolDescriptor } from '../types'

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'

// esummary db=clinvar document shape (confirmed live against real records — the top-level
// field is `germline_classification` with a `.description`, not a flat `clinical_significance`).
type ClinVarSummaryDoc = {
  title?: string
  germline_classification?: { description?: string }
  genes?: Array<{ symbol?: string }>
}

// esummary db=snp document shape (confirmed live against rs7412 — flat `clinical_significance`
// string, `chr`/`chrpos` for location, `spdi` (ref:alt trail) for alleles, `genes[].name`).
type DbSnpSummaryDoc = {
  snp_id?: number
  chr?: string
  chrpos?: string
  spdi?: string
  genes?: Array<{ name?: string }>
  clinical_significance?: string
}

// NCBI E-utilities in JSON mode against db=clinvar: esearch -> esummary (mirrors pubmed.ts).
export const VARIANTS_TOOLS: ToolDescriptor[] = [
  {
    id: 'clinvar_search',
    connector: 'variants',
    description: 'Search ClinVar; returns total count and variant clinical-significance records.',
    input: {
      type: 'object',
      properties: { term: { type: 'string' }, retmax: { type: 'integer', default: 5 } },
      required: ['term']
    },
    required: ['term'],
    returns:
      '`{ "term": str, "count": int, "records": [ { "uid": str, "title": str, "clinical_significance": str, "gene": str } ] }` — up to `retmax` records (default 5); `count` is the total ClinVar match count, usually larger than the returned list. `records` is `[]` when nothing matches; `clinical_significance` comes from the germline classification and per-record fields may be undefined.',
    example: 'result = host.mcp("variants", "clinvar_search", {"term": "BRCA1", "retmax": 5})',
    run: async (ctx, a) => {
      const q = ncbiEtiquette(ctx.credentials)
      const es = (await ctx.fetchJson(
        `${EUTILS}/esearch.fcgi?db=clinvar&retmode=json&retmax=${Number(a.retmax ?? 5)}&term=${encodeURIComponent(String(a.term))}${q}`
      )) as { esearchresult?: { count?: string; idlist?: string[] } }
      const ids = es.esearchresult?.idlist ?? []
      if (!ids.length) return { term: a.term, count: 0, records: [] }
      const sum = (await ctx.fetchJson(
        `${EUTILS}/esummary.fcgi?db=clinvar&retmode=json&id=${ids.join(',')}${q}`
      )) as { result: Record<string, ClinVarSummaryDoc> }
      return {
        term: a.term,
        count: Number(es.esearchresult?.count ?? 0),
        records: ids.map((id) => ({
          uid: id,
          title: sum.result[id]?.title,
          clinical_significance: sum.result[id]?.germline_classification?.description,
          gene: sum.result[id]?.genes?.[0]?.symbol
        }))
      }
    }
  },
  {
    id: 'dbsnp_get_variant',
    connector: 'variants',
    description:
      'Look up a dbSNP variant by rsID; returns chromosome, position, alleles, gene, and clinical significance.',
    input: {
      type: 'object',
      properties: { rsid: { type: 'string', description: 'rsID, with or without the rs prefix' } },
      required: ['rsid']
    },
    required: ['rsid'],
    returns:
      '`{ "rsid": str, "chr": str, "pos": int, "alleles": str, "gene": str, "clinical_significance": str }` — `rsid` is normalized to `rs<id>`; `alleles` is `ref>alt` derived from the SPDI trail. Any field is undefined when missing upstream (e.g. `alleles`/`pos` absent, no clinical significance).',
    example: 'result = host.mcp("variants", "dbsnp_get_variant", {"rsid": "rs7412"})',
    run: async (ctx, a) => {
      const q = ncbiEtiquette(ctx.credentials)
      const id = String(a.rsid).trim().replace(/^rs/i, '')
      const sum = (await ctx.fetchJson(
        `${EUTILS}/esummary.fcgi?db=snp&retmode=json&id=${encodeURIComponent(id)}${q}`
      )) as { result?: Record<string, DbSnpSummaryDoc> }
      const doc = sum.result?.[id]
      // spdi trail is `seqId:position:deletedSequence:insertedSequence` (ref:alt for the row).
      const spdiParts = (doc?.spdi ?? '').split(':')
      const ref = spdiParts[2]
      const alt = spdiParts[3]
      const pos = doc?.chrpos?.split(':')[1]
      return {
        rsid: `rs${id}`,
        chr: doc?.chr,
        pos: pos ? Number(pos) : undefined,
        alleles: ref && alt ? `${ref}>${alt}` : undefined,
        gene: doc?.genes?.[0]?.name,
        clinical_significance: doc?.clinical_significance
      }
    }
  }
]
