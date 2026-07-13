import { ncbiEtiquette } from '../engine'
import type { ToolDescriptor } from '../types'

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'

// NCBI E-utilities in JSON mode (no biopython/XML needed): esearch -> esummary.
export const PUBMED_TOOLS: ToolDescriptor[] = [
  {
    id: 'pubmed_search',
    connector: 'pubmed',
    description: 'Search PubMed; returns total count and article titles/dates.',
    input: {
      type: 'object',
      properties: { term: { type: 'string' }, retmax: { type: 'integer', default: 5 } },
      required: ['term']
    },
    required: ['term'],
    run: async (ctx, a) => {
      const q = ncbiEtiquette(ctx.credentials)
      const es = (await ctx.fetchJson(
        `${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&retmax=${Number(a.retmax ?? 5)}&term=${encodeURIComponent(String(a.term))}${q}`
      )) as { esearchresult?: { count?: string; idlist?: string[] } }
      const ids = es.esearchresult?.idlist ?? []
      if (!ids.length) return { term: a.term, count: 0, articles: [] }
      const sum = (await ctx.fetchJson(
        `${EUTILS}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}${q}`
      )) as {
        result: Record<string, { title?: string; pubdate?: string }>
      }
      return {
        term: a.term,
        count: Number(es.esearchresult?.count ?? 0),
        articles: ids.map((id) => ({
          pmid: id,
          title: sum.result[id]?.title,
          date: sum.result[id]?.pubdate
        }))
      }
    }
  }
]
