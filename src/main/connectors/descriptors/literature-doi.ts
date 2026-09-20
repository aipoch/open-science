import { z } from 'zod'
import type { ToolDescriptor } from '../types'

// Public metadata APIs. Keep their distinct relationship vocabularies and provenance intact.
// https://www.crossref.org/documentation/retrieve-metadata/rest-api/
// https://support.datacite.org/docs/api-queries
const CROSSREF = 'https://api.crossref.org/works/'
const DATACITE = 'https://api.datacite.org/dois'
const DOI_INPUT = {
  type: 'object',
  properties: { doi: { type: 'string', minLength: 1, maxLength: 2048 } },
  required: ['doi'],
  additionalProperties: false
}

const normalizeDoi = (value: unknown): string => {
  const doi = String(value ?? '')
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase()
  if (!/^10\.\d{4,9}\/\S+$/u.test(doi)) throw new Error('A valid DOI or doi.org URL is required')
  return doi
}

const object = z.record(z.string(), z.unknown())
const crossrefUpdate = z.object({ DOI: z.string().min(1), type: z.string().min(1) }).passthrough()
const crossrefWork = z.object({
  DOI: z.string().min(1),
  title: z.array(z.string()).optional(),
  author: z.array(object).optional(),
  publisher: z.string().optional(),
  type: z.string().optional(),
  published: object.optional(),
  'container-title': z.array(z.string()).optional(),
  URL: z.string().optional(),
  license: z.array(object).optional(),
  'update-to': z.array(crossrefUpdate).optional(),
  'updated-by': z.array(crossrefUpdate).optional(),
  relation: object.optional()
})
const crossrefResponse = z.object({ status: z.literal('ok'), message: crossrefWork })
const dataciteRecord = z.object({
  id: z.string().min(1),
  type: z.literal('dois'),
  attributes: z.object({
    doi: z.string().min(1),
    titles: z.array(z.object({ title: z.string() }).passthrough()),
    creators: z.array(object),
    publisher: z.union([z.string(), object]).nullish(),
    publicationYear: z.number().int().nullish(),
    types: z.object({ resourceTypeGeneral: z.string().nullish() }).passthrough(),
    url: z.string().nullish(),
    rightsList: z.array(object).optional(),
    relatedIdentifiers: z.array(object).optional(),
    version: z.string().nullish()
  })
})
const datacitePage = z.object({
  data: z.array(dataciteRecord),
  meta: z.object({ total: z.number().int().nonnegative() })
})

const assertIdentity = (actual: string, expected: string): void => {
  if (normalizeDoi(actual) !== expected) throw new Error('Upstream returned a different DOI')
}

const summarizeDataCite = (record: z.infer<typeof dataciteRecord>): Record<string, unknown> => {
  const a = record.attributes
  assertIdentity(record.id, normalizeDoi(a.doi))
  return {
    doi: a.doi,
    titles: a.titles,
    creators: a.creators,
    publisher: a.publisher ?? null,
    publication_year: a.publicationYear ?? null,
    resource_type: a.types,
    url: a.url ?? null,
    rights: a.rightsList ?? [],
    related_identifiers: a.relatedIdentifiers ?? [],
    version: a.version ?? null
  }
}

const DATACITE_RETURNS =
  '{ doi, titles:[{title,...}], creators:[{name?,...}], publisher:string|object|null, publication_year:number|null, resource_type:{resourceTypeGeneral?,...}, url:string|null, rights:[...], related_identifiers:[{relatedIdentifier?,relatedIdentifierType?,relationType?,...}], version:string|null }'

export const DOI_LITERATURE_TOOLS: ToolDescriptor[] = [
  {
    id: 'crossref_get_work',
    connector: 'literature',
    description:
      'Retrieve publisher-deposited bibliographic metadata for a Crossref DOI. Accepts a bare DOI, doi: prefix or doi.org URL. No API key required. A DOI registered elsewhere may return HTTP 404; use datacite_get_record for DataCite DOIs.',
    input: DOI_INPUT,
    returns:
      '{ doi, title:string[], authors:[...], publisher:string|null, type:string|null, published:object|null, container_title:string[], url:string|null, license:[...], source_url }. Optional upstream bibliographic fields are null or empty arrays, not inferred.',
    example:
      'const result = await host.mcp("literature", "crossref_get_work", {"doi": "10.1038/nature12968"})',
    run: async (ctx, args) => {
      const doi = normalizeDoi(args.doi)
      const sourceUrl = `${CROSSREF}${encodeURIComponent(doi)}`
      const { message: work } = crossrefResponse.parse(await ctx.fetchJson(sourceUrl))
      assertIdentity(work.DOI, doi)
      return {
        doi: work.DOI,
        title: work.title ?? [],
        authors: work.author ?? [],
        publisher: work.publisher ?? null,
        type: work.type ?? null,
        published: work.published ?? null,
        container_title: work['container-title'] ?? [],
        url: work.URL ?? null,
        license: work.license ?? [],
        source_url: sourceUrl
      }
    }
  },
  {
    id: 'crossref_get_updates',
    connector: 'literature',
    description:
      'Check Crossref-deposited corrections, retractions and other update relationships for a DOI. updated_by points to notices updating this work; update_to points to works that this DOI updates. Preserves publisher/Retraction Watch source labels and other relation types. No API key required. An empty result is not evidence that a paper is reliable or has never been retracted.',
    input: DOI_INPUT,
    returns:
      '{ doi, updated_by:[{DOI,type,source?,label?,updated?,...}], update_to:[{DOI,type,source?,label?,updated?,...}], relation:object, source_url, coverage_note }. Arrays contain only deposited metadata; retain duplicate DOI notices with different sources. Does not assign an inferred retraction status.',
    example:
      'const result = await host.mcp("literature", "crossref_get_updates", {"doi": "10.1038/nature12968"})',
    run: async (ctx, args) => {
      const doi = normalizeDoi(args.doi)
      const sourceUrl = `${CROSSREF}${encodeURIComponent(doi)}`
      const { message: work } = crossrefResponse.parse(await ctx.fetchJson(sourceUrl))
      assertIdentity(work.DOI, doi)
      return {
        doi: work.DOI,
        updated_by: work['updated-by'] ?? [],
        update_to: work['update-to'] ?? [],
        relation: work.relation ?? {},
        source_url: sourceUrl,
        coverage_note:
          'Deposited Crossref metadata only; missing updates do not establish reliability.'
      }
    }
  },
  {
    id: 'datacite_search_records',
    connector: 'literature',
    description:
      'Find public DataCite dataset/software DOI records by query and/or related DOI. query uses DataCite OpenSearch syntax; related_doi searches deposited links to a paper or other DOI; verify the exact identifier and relationship direction in related_identifiers. resource_type defaults to dataset; use software for code. Returns one bounded page (1-100 records, default 20); pass next_page with the same filters and page_size to continue. Page-number retrieval is limited to the first 10,000 records; narrow the query beyond that. Metadata and landing URLs do not guarantee downloadable files or reuse permission.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 2000 },
        related_doi: { type: 'string', minLength: 1, maxLength: 2048 },
        resource_type: { type: 'string', enum: ['dataset', 'software'], default: 'dataset' },
        page_size: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 }
      },
      anyOf: [
        { properties: { query: {} }, required: ['query'] },
        { properties: { related_doi: {} }, required: ['related_doi'] }
      ],
      additionalProperties: false
    },
    returns: `{ api_total, n_returned, page, page_size, next_page:number|null, records_truncated, records:[${DATACITE_RETURNS}], source_url }. records_truncated compares this page to the total, including preceding pages. next_page=null at the end or the 10,000-record window; consult api_total and narrow the query if needed.`,
    example:
      'const result = await host.mcp("literature", "datacite_search_records", {"query": "climate", "resource_type": "dataset", "page_size": 5})',
    run: async (ctx, args) => {
      const pageSize = Number(args.page_size ?? 20)
      const page = Number(args.page ?? 1)
      if (
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 100 ||
        !Number.isInteger(page) ||
        page < 1 ||
        page * pageSize > 10000
      ) {
        throw new Error('Use page_size 1-100 and pages within the first 10,000 records')
      }
      const query = String(args.query ?? '').trim()
      const related = args.related_doi === undefined ? undefined : normalizeDoi(args.related_doi)
      if (!query && !related) throw new Error('query or related_doi is required')
      const relatedQuery = related
        ? `relatedIdentifiers.relatedIdentifier:${JSON.stringify(related)} AND relatedIdentifiers.relatedIdentifierType:DOI`
        : ''
      const params = new URLSearchParams({
        query: query && relatedQuery ? `(${query}) AND (${relatedQuery})` : query || relatedQuery,
        'resource-type-id': String(args.resource_type ?? 'dataset'),
        'page[size]': String(pageSize),
        'page[number]': String(page)
      })
      const sourceUrl = `${DATACITE}?${params}`
      const payload = datacitePage.parse(await ctx.fetchJson(sourceUrl))
      if (
        payload.data.length > pageSize ||
        payload.meta.total < payload.data.length ||
        (payload.data.length === 0 && (page - 1) * pageSize < payload.meta.total)
      ) {
        throw new Error('DataCite returned an inconsistent result page')
      }
      return {
        api_total: payload.meta.total,
        n_returned: payload.data.length,
        page,
        page_size: pageSize,
        next_page:
          page * pageSize < payload.meta.total && (page + 1) * pageSize <= 10000 ? page + 1 : null,
        records_truncated: payload.data.length < payload.meta.total,
        records: payload.data.map(summarizeDataCite),
        source_url: sourceUrl
      }
    }
  },
  {
    id: 'datacite_get_record',
    connector: 'literature',
    description:
      'Retrieve a public DataCite DOI record, including dataset/software identity, creators, rights, version, landing URL and registered publication/data relationships. Accepts a bare DOI, doi: prefix or doi.org URL. No API key required. Metadata does not guarantee access to files; HTTP 404 may mean the DOI is private, unknown or registered elsewhere.',
    input: DOI_INPUT,
    returns: `{ record:${DATACITE_RETURNS}, source_url }. Preserves upstream relatedIdentifierType and relationType; absent optional fields are null or empty arrays.`,
    example:
      'const result = await host.mcp("literature", "datacite_get_record", {"doi": "10.14454/qdd3-ps68"})',
    run: async (ctx, args) => {
      const doi = normalizeDoi(args.doi)
      const sourceUrl = `${DATACITE}/${encodeURIComponent(doi)}`
      const { data } = z.object({ data: dataciteRecord }).parse(await ctx.fetchJson(sourceUrl))
      assertIdentity(data.attributes.doi, doi)
      return { record: summarizeDataCite(data), source_url: sourceUrl }
    }
  }
]
