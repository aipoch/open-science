import { DOMParser } from '@xmldom/xmldom'
import type { ToolDescriptor } from '../types'

const ARXIV_API = 'https://export.arxiv.org/api/query'

// One parsed arXiv paper, shared shape for both tools' `records`.
type ArxivRecord = {
  arxiv_id: string
  version: number | null
  id_versioned: string
  title: string
  abstract: string
  authors: string[]
  published: string | null
  updated: string | null
  primary_category: string | null
  categories: string[]
  doi: string | null
  journal_ref: string | null
  comment: string | null
  abs_url: string
  pdf_url: string | null
}

// Trimmed text of the first descendant with the given (possibly namespaced) tag name, else null.
function tagText(parent: Element, tag: string): string | null {
  const t = parent.getElementsByTagName(tag)[0]?.textContent
  return t != null ? t.trim() : null
}

// Collapses internal whitespace/newlines to single spaces and trims (for title/abstract).
function collapse(value: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

// Clamps a finite integer into [lo, hi]; non-finite input falls back to lo.
function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}

// Reads an integer-valued tag off the feed document, with a fallback when absent/unparseable.
function intTag(doc: Document, tag: string, fallback: number): number {
  const t = doc.getElementsByTagName(tag)[0]?.textContent
  const n = t != null ? parseInt(t.trim(), 10) : NaN
  return Number.isFinite(n) ? n : fallback
}

// Extracts the bare id from an arXiv abs URL: everything after "/abs/" (keeps old-style
// "archive/NNNN" ids intact), falling back to the last path segment.
function idFromAbsUrl(absUrl: string): string {
  const marker = '/abs/'
  const idx = absUrl.indexOf(marker)
  if (idx >= 0) return absUrl.slice(idx + marker.length)
  return absUrl.split('/').pop() ?? absUrl
}

// Splits a trailing "vN" version suffix off an id.
function splitVersion(id: string): { base: string; version: number | null } {
  const m = /v(\d+)$/.exec(id)
  if (m) return { base: id.slice(0, m.index), version: Number(m[1]) }
  return { base: id, version: null }
}

// Collects <author><name> strings on an entry.
function authorNames(entry: Element): string[] {
  const names: string[] = []
  const authors = entry.getElementsByTagName('author')
  for (let i = 0; i < authors.length; i++) {
    const name = authors[i].getElementsByTagName('name')[0]?.textContent?.trim()
    if (name) names.push(name)
  }
  return names
}

// Collects the term attribute from every <category> element on an entry.
function categoryTerms(entry: Element): string[] {
  const terms: string[] = []
  const cats = entry.getElementsByTagName('category')
  for (let i = 0; i < cats.length; i++) {
    const term = cats[i].getAttribute('term')
    if (term) terms.push(term)
  }
  return terms
}

// Finds the PDF href on an entry: a <link title="pdf"> or a type="application/pdf" link, else null.
function pdfUrl(entry: Element): string | null {
  const links = entry.getElementsByTagName('link')
  for (let i = 0; i < links.length; i++) {
    const link = links[i]
    if (link.getAttribute('title') === 'pdf' || link.getAttribute('type') === 'application/pdf') {
      return link.getAttribute('href')
    }
  }
  return null
}

// Maps one Atom <entry> to an ArxivRecord (namespaced fields matched by qualified name).
function parseEntry(entry: Element): ArxivRecord {
  const absUrl = (entry.getElementsByTagName('id')[0]?.textContent ?? '').trim()
  const idVersioned = idFromAbsUrl(absUrl)
  const { base, version } = splitVersion(idVersioned)
  const primary = entry.getElementsByTagName('arxiv:primary_category')[0]?.getAttribute('term')
  return {
    arxiv_id: base,
    version,
    id_versioned: idVersioned,
    title: collapse(tagText(entry, 'title')),
    abstract: collapse(tagText(entry, 'summary')),
    authors: authorNames(entry),
    published: tagText(entry, 'published'),
    updated: tagText(entry, 'updated'),
    primary_category: primary ?? null,
    categories: categoryTerms(entry),
    doi: tagText(entry, 'arxiv:doi'),
    journal_ref: tagText(entry, 'arxiv:journal_ref'),
    comment: tagText(entry, 'arxiv:comment'),
    abs_url: absUrl,
    pdf_url: pdfUrl(entry)
  }
}

// Parses the Atom feed to a Document, detecting arXiv's HTTP-200 error feed (a single entry whose
// <id> points at /api/errors) and throwing with the entry's summary rather than returning it.
function parseFeed(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const entries = doc.getElementsByTagName('entry')
  if (entries.length === 1) {
    const id = entries[0].getElementsByTagName('id')[0]?.textContent ?? ''
    if (id.includes('/api/errors')) {
      throw new Error(`arXiv API error: ${collapse(tagText(entries[0], 'summary'))}`)
    }
  }
  return doc
}

// Normalizes a user-supplied arXiv id: strips an "arXiv:" prefix and abs/pdf URL wrappers while
// keeping any version suffix and the old-style "archive/NNNN" shape.
function normalizeId(raw: string): string {
  return raw
    .trim()
    .replace(/^arxiv:/i, '')
    .replace(/^https?:\/\/arxiv\.org\/abs\//i, '')
    .replace(/^https?:\/\/arxiv\.org\/pdf\//i, '')
    .replace(/\.pdf$/i, '')
    .trim()
}

// arXiv id grammar: new-style "NNNN.NNNNN(vN)" or old-style "archive(.subject)/NNNNNNN(vN)".
// arXiv answers a whole id_list batch containing ANY malformed id with an HTTP-200 error feed, so
// non-matching ids must be routed to not_found rather than sent (which would lose every valid id).
const NEW_ARXIV_ID = /^\d{4}\.\d{4,5}(v\d+)?$/
const OLD_ARXIV_ID = /^[a-z-]+(\.[a-z-]+)?\/\d{7}(v\d+)?$/i
function isValidArxivId(id: string): boolean {
  return NEW_ARXIV_ID.test(id) || OLD_ARXIV_ID.test(id)
}

// arXiv Atom API (export.arxiv.org): read-only preprint search + batch metadata fetch.
export const ARXIV_LITERATURE_TOOLS: ToolDescriptor[] = [
  {
    id: 'arxiv_search',
    connector: 'literature',
    description:
      "Search arXiv preprints (physics, math, CS, stats, q-bio, ...) via the official Atom API. Args: query (arXiv query string; plain terms search all fields, field prefixes ti:/au:/abs: and booleans AND/OR/ANDNOT work; optional if category or a date range is set), category (arXiv code AND-ed in, e.g. q-bio.GN, cs.LG, stat.ML), date_from / date_to (submission date YYYY-MM-DD, inclusive), start (0-based paging offset; the API paces ~3s between requests — page politely), max_results (default 25, max 100 per call), sort_by (relevance default / submittedDate / lastUpdatedDate), sort_order (descending default / ascending). Returns {search_query (the exact query sent), api_total (arXiv's total match count), start_index, n_records_returned, records_truncated, sort_by, sort_order, records}; each record {arxiv_id, version, id_versioned, title, abstract, authors, published, updated, primary_category, categories, doi, journal_ref, comment, abs_url, pdf_url}. doi/journal_ref appear only after journal publication. Malformed queries raise an error (arXiv's HTTP-200 error feed is detected, never returned as data).",
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        category: { type: 'string' },
        date_from: { type: 'string' },
        date_to: { type: 'string' },
        start: { type: 'integer', default: 0 },
        max_results: { type: 'integer', default: 25 },
        sort_by: {
          type: 'string',
          enum: ['relevance', 'submittedDate', 'lastUpdatedDate'],
          default: 'relevance'
        },
        sort_order: { type: 'string', enum: ['descending', 'ascending'], default: 'descending' }
      },
      required: []
    },
    required: [],
    returns:
      '`{ search_query, api_total, start_index, n_records_returned, records_truncated, sort_by, sort_order, records: [ { arxiv_id, version, id_versioned, title, abstract, authors, published, updated, primary_category, categories, doi, journal_ref, comment, abs_url, pdf_url } ] }` — `records_truncated` flags more matches beyond this page; `records` is `[]` when nothing matches.',
    example:
      'result = host.mcp("literature", "arxiv_search", {"query": "ti:transformer", "category": "cs.LG", "max_results": 10})',
    run: async (ctx, a) => {
      // At least one search dimension is required — an empty query is meaningless to arXiv.
      const query = a.query != null ? String(a.query).trim() : ''
      const category = a.category != null ? String(a.category).trim() : ''
      const dateFrom = a.date_from != null ? String(a.date_from).trim() : ''
      const dateTo = a.date_to != null ? String(a.date_to).trim() : ''
      if (!query && !category && !dateFrom && !dateTo) {
        throw new Error('arxiv_search needs at least one of: query, category, date_from, date_to')
      }
      // Assemble the AND-joined search_query from the provided dimensions.
      const terms: string[] = []
      if (query) terms.push(query)
      if (category) terms.push(`cat:${category}`)
      if (dateFrom || dateTo) {
        const from = dateFrom ? dateFrom.replace(/-/g, '') : '19910101'
        const to = dateTo ? dateTo.replace(/-/g, '') : '30000101'
        terms.push(`submittedDate:[${from}0000 TO ${to}2359]`)
      }
      const searchQuery = terms.join(' AND ')
      // Paging + sort params (max_results clamped to arXiv's 1..100 window).
      const start = a.start != null ? Math.trunc(Number(a.start)) || 0 : 0
      const maxResults = clamp(Number(a.max_results ?? 25), 1, 100)
      const sortBy = String(a.sort_by ?? 'relevance')
      const sortOrder = String(a.sort_order ?? 'descending')
      const url =
        `${ARXIV_API}?search_query=${encodeURIComponent(searchQuery)}` +
        `&start=${start}&max_results=${maxResults}&sortBy=${sortBy}&sortOrder=${sortOrder}`
      // Fetch, parse, and read the opensearch paging counters off the feed root.
      const doc = parseFeed(await ctx.fetchText(url))
      const records = Array.from(doc.getElementsByTagName('entry')).map(parseEntry)
      const apiTotal = intTag(doc, 'opensearch:totalResults', 0)
      const startIndex = intTag(doc, 'opensearch:startIndex', 0)
      return {
        search_query: searchQuery,
        api_total: apiTotal,
        start_index: startIndex,
        n_records_returned: records.length,
        records_truncated: apiTotal > startIndex + records.length,
        sort_by: sortBy,
        sort_order: sortOrder,
        records
      }
    }
  },
  {
    id: 'arxiv_get_papers',
    connector: 'literature',
    description:
      'Batch-fetch arXiv paper metadata (incl. abstracts) by ID — one paced request for up to 100 papers. Args: arxiv_ids (up to 100 IDs in any common form — 2103.14030, versioned 2103.14030v2, old-style q-bio/0601001, arXiv:-prefixed, or abs/pdf URLs; unversioned IDs resolve to the latest version). Returns {n_requested, n_found, duplicates (inputs that resolved to an already-returned paper), not_found (unknown AND malformed IDs — arXiv silently skips unknowns and rejects whole batches over malformed ones; this tool does neither), records} — records in requested order, same shape as arxiv_search records. Withdrawn papers still return metadata (check comment for withdrawal notes).',
    input: {
      type: 'object',
      properties: {
        arxiv_ids: { type: 'array', items: { type: 'string' } }
      },
      required: ['arxiv_ids']
    },
    required: ['arxiv_ids'],
    returns:
      '`{ n_requested, n_found, duplicates: [str], not_found: [str], records: [ ...same shape as arxiv_search records ] }` — `records` in requested (deduped) order; `not_found` lists requested ids with no matching record.',
    example:
      'result = host.mcp("literature", "arxiv_get_papers", {"arxiv_ids": ["2103.14030", "1706.03762v5"]})',
    run: async (ctx, a) => {
      const rawIds = Array.isArray(a.arxiv_ids) ? (a.arxiv_ids as unknown[]).map(String) : []
      if (rawIds.length === 0)
        throw new Error('arxiv_get_papers requires a non-empty arxiv_ids array')
      if (rawIds.length > 100) throw new Error('arxiv_get_papers accepts at most 100 ids per call')
      // Normalize + dedupe by base id, preserving requested order and collecting duplicate inputs.
      const uniqueBases: string[] = []
      const uniqueNormalized: string[] = []
      const duplicates: string[] = []
      const seen = new Set<string>()
      for (const raw of rawIds) {
        const normalized = normalizeId(raw)
        const base = splitVersion(normalized).base
        if (seen.has(base)) {
          duplicates.push(raw)
          continue
        }
        seen.add(base)
        uniqueBases.push(base)
        uniqueNormalized.push(normalized)
      }
      // Divert malformed ids straight to not_found: arXiv returns a whole-batch error feed if any
      // id_list entry is malformed, which would otherwise lose every valid id in the request.
      const toRequest = uniqueNormalized.filter((id) => isValidArxivId(id))
      const byId = new Map<string, ArxivRecord>()
      if (toRequest.length > 0) {
        // Percent-encode each id — old-style ids contain '/', which arXiv rejects as a literal slash.
        const idList = toRequest.map((id) => encodeURIComponent(id)).join(',')
        const url = `${ARXIV_API}?id_list=${idList}&max_results=${toRequest.length}`
        const doc = parseFeed(await ctx.fetchText(url))
        // Index returned records by both base and versioned id for order-preserving lookup.
        for (const rec of Array.from(doc.getElementsByTagName('entry')).map(parseEntry)) {
          byId.set(rec.arxiv_id, rec)
          byId.set(rec.id_versioned, rec)
        }
      }
      // Emit records in requested (deduped) order; unknown AND malformed ids fall to not_found.
      const records: ArxivRecord[] = []
      const notFound: string[] = []
      for (let i = 0; i < uniqueBases.length; i++) {
        const rec = isValidArxivId(uniqueNormalized[i])
          ? (byId.get(uniqueNormalized[i]) ?? byId.get(uniqueBases[i]))
          : undefined
        if (rec) records.push(rec)
        else notFound.push(uniqueBases[i])
      }
      return {
        n_requested: rawIds.length,
        n_found: records.length,
        duplicates,
        not_found: notFound,
        records
      }
    }
  }
]
