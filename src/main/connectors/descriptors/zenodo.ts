import type { ToolDescriptor } from '../types'

const BASE = 'https://zenodo.org/api/records'
const MAX_SEARCH_RESULTS = 10000
type JsonObject = Record<string, unknown>

const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Zenodo response: expected an object')
  }
  return value as JsonObject
}
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const identifier = (value: unknown): string => {
  if (
    (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) ||
    !/^[1-9]\d*$/.test(String(value))
  ) {
    throw new Error('Invalid Zenodo response: expected a positive record ID')
  }
  return String(value)
}
const array = (value: unknown): unknown[] | null => {
  if (value == null) return null
  if (!Array.isArray(value)) throw new Error('Invalid Zenodo response: expected an array')
  return value
}

const summary = (raw: unknown): JsonObject => {
  const record = object(raw)
  const metadata = object(record.metadata)
  const id = identifier(record.id)
  if (typeof metadata.title !== 'string' || !metadata.title.trim()) {
    throw new Error('Invalid Zenodo response: missing record title')
  }
  return {
    record_id: id,
    concept_record_id: record.conceptrecid == null ? null : identifier(record.conceptrecid),
    doi: text(record.doi) ?? text(metadata.doi),
    concept_doi: text(record.conceptdoi),
    title: metadata.title,
    creators: array(metadata.creators),
    publication_date: text(metadata.publication_date),
    resource_type: metadata.resource_type ?? null,
    version: text(metadata.version),
    access_right: text(metadata.access_right),
    license: metadata.license ?? null,
    record_url: `https://zenodo.org/records/${id}`
  }
}

// Pagination comes from the server, never from the number of hits or an approximate total.
// Only return a page number; subsequent calls reconstruct the URL on the fixed public endpoint.
const nextPage = (raw: unknown, page: number): number | null => {
  const links = object(raw)
  if (links.next == null) return null
  if (typeof links.next !== 'string') throw new Error('Invalid Zenodo pagination link')
  const next = new URL(links.next)
  const value = next.searchParams.get('page') ?? ''
  if (
    next.origin !== 'https://zenodo.org' ||
    !/^\/api\/records\/?$/.test(next.pathname) ||
    !/^[1-9]\d*$/.test(value) ||
    Number(value) !== page + 1
  ) {
    throw new Error('Invalid Zenodo pagination link')
  }
  return Number(value)
}

export const ZENODO_TOOLS: ToolDescriptor[] = [
  {
    connector: 'zenodo',
    id: 'search_records',
    description:
      'Search public Zenodo records (datasets, software and publications) using Zenodo query-string syntax, e.g. title:"climate" or doi:"10.5281/zenodo.8435696". Fetches one page, up to 25 records, without authentication. By default only the latest version is listed; all_versions includes older versions. For the next page, keep query, page_size, sort and all_versions unchanged. The search window is limited to 10,000 results: (page - 1) * page_size must be less than 10,000; the final page may be partial. If pagination_limited is true, narrow the query. Public metadata does not imply open file access.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 1000, pattern: '\\S' },
        page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 },
        page_size: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
        sort: { type: 'string', enum: ['bestmatch', 'mostrecent'], default: 'bestmatch' },
        all_versions: { type: 'boolean', default: false }
      },
      required: ['query']
    },
    returns:
      '`{ records: [{ record_id, concept_record_id, doi, concept_doi, title, creators, publication_date, resource_type, version, access_right, license, record_url }], page, page_size, count, total, total_relation, next_page, pagination_limited }`. IDs are strings; optional metadata is null when absent. total_relation is eq (exact) or gte (lower bound). next_page is null when no next link is supplied or the next page would exceed the search window. pagination_limited is true when a supplied next page exceeds that window; this does not mean all matches were retrieved. No automatic page walking or cached results.',
    example:
      'const result = await host.mcp("zenodo", "search_records", {"query": "title:climate", "page_size": 5})',
    url: (args) => {
      if ((Number(args.page ?? 1) - 1) * Number(args.page_size ?? 10) >= MAX_SEARCH_RESULTS) {
        throw new Error(
          'Invalid Zenodo pagination: (page - 1) * page_size must be less than 10000; narrow the query'
        )
      }
      const params = new URLSearchParams({
        q: String(args.query).trim(),
        page: String(args.page ?? 1),
        size: String(args.page_size ?? 10),
        sort: String(args.sort ?? 'bestmatch'),
        all_versions: String(args.all_versions ?? false)
      })
      return `${BASE}?${params}`
    },
    parse: (raw, args) => {
      const payload = object(raw)
      const hits = object(payload.hits)
      if (!Array.isArray(hits.hits)) throw new Error('Invalid Zenodo response: missing hits')
      const page = Number(args.page ?? 1)
      const pageSize = Number(args.page_size ?? 10)
      if (hits.hits.length > pageSize) throw new Error('Invalid Zenodo response: oversized page')
      const total =
        typeof hits.total === 'number' ? { value: hits.total, relation: 'eq' } : object(hits.total)
      if (
        !Number.isSafeInteger(total.value) ||
        Number(total.value) < hits.hits.length ||
        (total.relation !== 'eq' && total.relation !== 'gte')
      )
        throw new Error('Invalid Zenodo response: invalid total')
      const records = hits.hits.map(summary)
      const next = nextPage(payload.links, page)
      const paginationLimited = next !== null && (next - 1) * pageSize >= MAX_SEARCH_RESULTS
      return {
        records,
        page,
        page_size: pageSize,
        count: records.length,
        total: total.value,
        total_relation: total.relation,
        next_page: paginationLimited ? null : next,
        pagination_limited: paginationLimited
      }
    }
  },
  {
    connector: 'zenodo',
    id: 'get_record',
    description:
      'Retrieve public Zenodo metadata and the file inventory exposed by the record endpoint. Pass a decimal record ID, not a DOI or URL. A concept ID may resolve to its latest version; requested_record_id, record_id and concept_record_id remain distinct. Use the returned version-specific record_id for reproducible lookup. description_html is upstream HTML, not sanitized. File links and checksums are metadata only: no download, checksum verification or access probe is performed. Restricted or embargoed records can have public metadata without accessible files; an empty file list does not establish that the deposit has no files.',
    input: {
      type: 'object',
      additionalProperties: false,
      properties: { record_id: { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 20 } },
      required: ['record_id']
    },
    returns:
      '`{ requested_record_id, record: { ...search record fields, description_html, keywords, related_identifiers, communities, created, modified }, files: [{ key, size_bytes, checksum, download_url }] | null }`. Missing file inventory is null; an explicitly empty inventory is []. Optional file metadata is null when absent. HTTP, network and malformed-response errors propagate; a missing record is not an empty successful result.',
    example: 'const result = await host.mcp("zenodo", "get_record", {"record_id": "8435696"})',
    url: (args) => `${BASE}/${args.record_id}`,
    parse: (raw, args) => {
      const payload = object(raw)
      const record = summary(payload)
      if (record.record_id !== args.record_id && record.concept_record_id !== args.record_id) {
        throw new Error('Invalid Zenodo response: different record ID')
      }
      const metadata = object(payload.metadata)
      const files =
        array(payload.files)?.map((rawFile) => {
          const file = object(rawFile)
          if (typeof file.key !== 'string' || !file.key) throw new Error('Invalid Zenodo file key')
          if (file.size != null && (!Number.isSafeInteger(file.size) || Number(file.size) < 0)) {
            throw new Error('Invalid Zenodo file size')
          }
          return {
            key: file.key,
            size_bytes: file.size ?? null,
            checksum: text(file.checksum),
            download_url: file.links == null ? null : text(object(file.links).self)
          }
        }) ?? null
      return {
        requested_record_id: args.record_id,
        record: {
          ...record,
          description_html: text(metadata.description),
          keywords: array(metadata.keywords),
          related_identifiers: array(metadata.related_identifiers),
          communities: array(metadata.communities),
          created: text(payload.created),
          modified: text(payload.modified)
        },
        files
      }
    }
  }
]
