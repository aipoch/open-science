import { ncbiEtiquette } from '../engine'
import type { ToolDescriptor } from '../types'

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'

// esummary db=gds document shape (confirmed live against real records — field names are lowercase
// and unprefixed: `accession`, `title`, `summary`, `taxon`, `n_samples`, `gdstype`).
type GdsSummaryDoc = {
  accession?: string
  title?: string
  summary?: string
  taxon?: string
  n_samples?: number | string
  gdstype?: string
}

// NCBI E-utilities in JSON mode against db=gds (GEO DataSets): esearch -> esummary (mirrors pubmed.ts).
export const GEO_TOOLS: ToolDescriptor[] = [
  {
    id: 'geo_search',
    connector: 'geo',
    description:
      'Search NCBI GEO DataSets; returns total count and series/dataset summary records.',
    input: {
      type: 'object',
      properties: { term: { type: 'string' }, retmax: { type: 'integer', default: 5 } },
      required: ['term']
    },
    required: ['term'],
    returns:
      '`{ "term": str, "count": int, "records": [ { "accession": str, "title": str, "summary": str, "taxon": str, "n_samples": int, "gdstype": str } ] }` — up to `retmax` records (default 5); `count` is the total number of GEO matches, usually far larger than the returned list. `records` is `[]` when nothing matches.',
    run: async (ctx, a) => {
      const q = ncbiEtiquette(ctx.credentials)
      const es = (await ctx.fetchJson(
        `${EUTILS}/esearch.fcgi?db=gds&retmode=json&retmax=${Number(a.retmax ?? 5)}&term=${encodeURIComponent(String(a.term))}${q}`
      )) as { esearchresult?: { count?: string; idlist?: string[] } }
      const ids = es.esearchresult?.idlist ?? []
      if (!ids.length) return { term: a.term, count: 0, records: [] }
      const sum = (await ctx.fetchJson(
        `${EUTILS}/esummary.fcgi?db=gds&retmode=json&id=${ids.join(',')}${q}`
      )) as { result: Record<string, GdsSummaryDoc> }
      return {
        term: a.term,
        count: Number(es.esearchresult?.count ?? 0),
        records: ids.map((id) => ({
          accession: sum.result[id]?.accession,
          title: sum.result[id]?.title,
          summary: sum.result[id]?.summary,
          taxon: sum.result[id]?.taxon,
          n_samples: Number(sum.result[id]?.n_samples ?? 0),
          gdstype: sum.result[id]?.gdstype
        }))
      }
    }
  }
]
