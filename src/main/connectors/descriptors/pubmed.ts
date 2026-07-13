import { ncbiEtiquette } from '../engine'
import type { ToolDescriptor } from '../types'

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'

// NCBI E-utilities in JSON mode (no biopython/XML needed): esearch -> esummary.
export const PUBMED_TOOLS: ToolDescriptor[] = [
  {
    id: 'pubmed_search',
    connector: 'pubmed',
    description:
      'Search PubMed (biomedical & life-sciences literature) for articles matching a query; returns the total match count plus the top article titles/dates. Search-only: it does NOT return abstracts, authors, or journals, and there is no fetch-by-PMID tool in this connector. PubMed does not index physics / CS / math / pure-chemistry papers (use other connectors for those).',
    input: {
      type: 'object',
      properties: { term: { type: 'string' }, retmax: { type: 'integer', default: 5 } },
      required: ['term']
    },
    required: ['term'],
    returns:
      '`{ "term": str, "count": int, "articles": [ { "pmid": str, "title": str, "date": str } ] }` — up to `retmax` articles (default 5); `count` is the total number of PubMed matches and is usually far larger than the returned list. `articles` is `[]` when nothing matches.',
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
