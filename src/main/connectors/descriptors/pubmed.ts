import { DOMParser } from '@xmldom/xmldom'
import { ncbiEtiquette } from '../engine'
import type { ToolDescriptor } from '../types'

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'

// One PubMed record as returned by esummary (JSON). Only the fields pubmed_fetch surfaces are typed.
type PubmedSummary = {
  title?: string
  pubdate?: string
  source?: string
  authors?: { name?: string; authtype?: string }[]
  articleids?: { idtype?: string; value?: string }[]
}

// Maps each PMID to its abstract text from an efetch XML document. Labeled sections (BACKGROUND,
// METHODS, ...) are concatenated in order; PMID/abstract are read within one <PubmedArticle> so they
// never cross-match between articles.
const parseAbstracts = (xml: string): Record<string, string> => {
  const out: Record<string, string> = {}
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  for (const article of Array.from(doc.getElementsByTagName('PubmedArticle'))) {
    const pmid = article.getElementsByTagName('PMID')[0]?.textContent?.trim()
    if (!pmid) continue
    const parts = Array.from(article.getElementsByTagName('AbstractText'))
      .map((el) => el.textContent?.trim())
      .filter((t): t is string => Boolean(t))
    if (parts.length) out[pmid] = parts.join(' ')
  }
  return out
}

// NCBI E-utilities in JSON mode (no biopython/XML needed): esearch -> esummary.
export const PUBMED_TOOLS: ToolDescriptor[] = [
  {
    id: 'pubmed_search',
    connector: 'pubmed',
    description:
      'Search PubMed (biomedical & life-sciences literature) for articles matching a query; returns the total match count plus the top article titles/dates. For a specific article’s authors, journal, DOI, or abstract, pass its PMID to `pubmed_fetch`. PubMed does not index physics / CS / math / pure-chemistry papers (use other connectors for those).',
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
  },
  {
    id: 'pubmed_fetch',
    connector: 'pubmed',
    description:
      'Fetch full details for one or more PubMed articles by PMID (bulk): title, authors, journal, DOI, and the abstract text. Use this after `pubmed_search` when you need more than the title. Prefer one call with many PMIDs over one call per PMID.',
    input: {
      type: 'object',
      properties: {
        pmids: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more PubMed IDs, e.g. ["40302006", "31452104"].'
        }
      },
      required: ['pmids']
    },
    required: ['pmids'],
    returns:
      '`{ "pmids": [str], "articles": [ { "pmid": str, "title": str, "authors": [str], "journal": str, "date": str, "doi": str|null, "abstract": str|null } ] }` — one entry per requested PMID (order preserved); `doi`/`abstract` are null when PubMed has none, `authors` is `[]` when unlisted.',
    run: async (ctx, a) => {
      const ids = (Array.isArray(a.pmids) ? a.pmids : [a.pmids]).map((x) => String(x))
      const q = ncbiEtiquette(ctx.credentials)
      const [sum, xml] = await Promise.all([
        ctx.fetchJson(
          `${EUTILS}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}${q}`
        ) as Promise<{ result?: Record<string, PubmedSummary> }>,
        ctx.fetchText(
          `${EUTILS}/efetch.fcgi?db=pubmed&retmode=xml&rettype=abstract&id=${ids.join(',')}${q}`
        )
      ])
      const abstracts = parseAbstracts(xml)
      const result = sum.result ?? {}
      return {
        pmids: ids,
        articles: ids.map((id) => {
          const r = result[id]
          return {
            pmid: id,
            title: r?.title,
            authors: (r?.authors ?? [])
              .filter((x) => x.authtype === 'Author' && x.name)
              .map((x) => x.name as string),
            journal: r?.source,
            date: r?.pubdate,
            doi: r?.articleids?.find((x) => x.idtype === 'doi')?.value ?? null,
            abstract: abstracts[id] ?? null
          }
        })
      }
    }
  }
]
