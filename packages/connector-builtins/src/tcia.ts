import { z } from 'zod'
import type { ToolDescriptor } from '@aipoch/connector-core'

const COLLECTIONS = 'https://www.cancerimagingarchive.net/api/v2/collections/'
const SERIES = 'https://services.cancerimagingarchive.net/nbia-api/services/v1/getSeriesMetaData'
const fields =
  'id,collection_short_title,collection_title,collection_doi,data_types,cancer_types,cancer_locations,subjects,collection_downloads'
const text = z.string().max(4000)
const link = text.refine((value) => /^https?:\/\//u.test(value))
// TCIA uses false, empty strings and empty arrays for some unpopulated metadata.
const optionalLink = z
  .union([link, z.literal(''), z.literal(false)])
  .transform((value) => value || null)
const labels = z
  .array(z.union([text, z.literal(false)]))
  .transform((values) => values.filter((value): value is string => value !== false))
const download = z.object({
  'download url': optionalLink.optional(),
  'download requirements': z
    .object({
      label: z
        .union([text, z.literal(false)])
        .transform((value) => (value === false ? null : value)),
      url: z
        .union([link, z.literal(false)])
        .transform((value) => (value === false ? null : value))
        .optional()
    })
    .optional(),
  license: z.object({ label: text, url: optionalLink.optional() }).optional(),
  'file type': labels.optional(),
  'download size': z
    .union([text, z.tuple([])])
    .transform((value) => (Array.isArray(value) ? null : value))
    .optional(),
  'download size unit': text.optional()
})
const collection = z.object({
  id: z.number().int().positive(),
  collection_short_title: text,
  collection_title: text,
  collection_doi: text,
  data_types: labels,
  cancer_types: labels,
  cancer_locations: labels,
  subjects: z.union([text, z.number()]).optional(),
  collection_downloads: z.array(download)
})
const pageSchema = z.object({
  page: z.number().int().positive(),
  per_page: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
  results: z.array(collection)
})
function summarize(
  row: z.infer<typeof collection>
): z.infer<typeof collection> & { details_truncated: boolean } {
  return {
    ...row,
    data_types: row.data_types.slice(0, 30),
    cancer_types: row.cancer_types.slice(0, 30),
    cancer_locations: row.cancer_locations.slice(0, 30),
    collection_downloads: row.collection_downloads.slice(0, 10).map((entry) => ({
      ...entry,
      'file type': entry['file type']?.slice(0, 20)
    })),
    details_truncated:
      row.data_types.length > 30 ||
      row.cancer_types.length > 30 ||
      row.cancer_locations.length > 30 ||
      row.collection_downloads.length > 10 ||
      row.collection_downloads.slice(0, 10).some((d) => (d['file type']?.length ?? 0) > 20)
  }
}
const query = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' }
const common = { connector: 'tcia', credentialKeys: [], maxResponseBytes: 2_000_000 }
export const TCIA_TOOLS: ToolDescriptor[] = [
  {
    ...common,
    id: 'search_collections',
    description:
      'Search public TCIA collections by keyword, one page at a time. Includes cancer, modality, DOI and download requirements. Collection Manager and NBIA have different coverage. Download links may be Data Retriever manifests, not images. Does not download DICOM or access restricted data.',
    input: {
      type: 'object',
      properties: {
        query,
        page: { type: 'integer', minimum: 1, maximum: 1000 },
        page_size: { type: 'integer', minimum: 1, maximum: 20 }
      },
      required: ['query'],
      additionalProperties: false
    },
    required: ['query'],
    exampleArgs: { query: 'LIDC-IDRI', page_size: 5 },
    returns:
      '{ source_url, total, page, next_page, collections, records_truncated }. Selected metadata only; per-record details_truncated marks capped lists. Empty results do not prove absence outside TCIA.',
    run: async (ctx, args) => {
      const page = Number(args.page ?? 1),
        size = Number(args.page_size ?? 10)
      const url = `${COLLECTIONS}?${new URLSearchParams({ search: String(args.query), page: String(page), per_page: String(size), fields })}`
      const result = pageSchema.parse(await ctx.fetchJson(url))
      if (
        result.page !== page ||
        result.per_page !== size ||
        result.results.length > size ||
        result.total < result.results.length
      )
        throw new Error('TCIA returned an inconsistent result page')
      return {
        source_url: url,
        total: result.total,
        page,
        next_page: page < result.total_pages && page < 1000 ? page + 1 : null,
        collections: result.results.map(summarize),
        records_truncated: result.total > result.results.length
      }
    }
  },
  {
    ...common,
    id: 'get_collection',
    description:
      'Find one TCIA collection by exact short title returned by search_collections. Searches up to 20 candidates and verifies identity: the upstream include=id filter is unreliable. A null result with lookup_complete=false means refine the lookup, not absence. Returns license and downloader requirements; does not download files.',
    input: {
      type: 'object',
      properties: { short_title: query },
      required: ['short_title'],
      additionalProperties: false
    },
    required: ['short_title'],
    exampleArgs: { short_title: '4D-Lung' },
    returns:
      '{ source_url, collection: object|null, lookup_complete, candidates_total }. Exact case-insensitive short-title match; duplicate identities fail. Selected metadata only.',
    run: async (ctx, args) => {
      const title = String(args.short_title).trim()
      const url = `${COLLECTIONS}?${new URLSearchParams({ search: title, page: '1', per_page: '20', v: '1', fields })}`
      const result = pageSchema.parse(await ctx.fetchJson(url))
      if (
        result.page !== 1 ||
        result.per_page !== 20 ||
        result.results.length > 20 ||
        result.total < result.results.length
      )
        throw new Error('TCIA returned an inconsistent lookup page')
      const matches = result.results.filter(
        (row) => row.collection_short_title.toLowerCase() === title.toLowerCase()
      )
      if (matches.length > 1) throw new Error('TCIA returned ambiguous collection identities')
      return {
        source_url: url,
        collection: matches[0] ? summarize(matches[0]) : null,
        lookup_complete: result.total === result.results.length,
        candidates_total: result.total
      }
    }
  },
  {
    ...common,
    id: 'get_series',
    description:
      'Retrieve public NBIA metadata for an exact DICOM SeriesInstanceUID: collection, subject/study identity, modality, image count, byte size and license. Use an existing UID from TCIA; no broad enumeration or image download. This endpoint does not cover every TCIA collection.',
    input: {
      type: 'object',
      properties: {
        series_uid: { type: 'string', maxLength: 64, pattern: '^[0-9]+(?:\\.[0-9]+)+$' }
      },
      required: ['series_uid'],
      additionalProperties: false
    },
    required: ['series_uid'],
    exampleArgs: { series_uid: '1.3.6.1.4.1.14519.5.2.1.6834.5010.189721824525842725510380467695' },
    returns:
      '{ source_url, series: object|null }. Empty NBIA response means no public record. Selected upstream fields retain original names and number strings.',
    run: async (ctx, args) => {
      const url = `${SERIES}?${new URLSearchParams({ SeriesInstanceUID: String(args.series_uid) })}`
      const raw = await ctx.fetchText(url, 'application/json')
      // NBIA public metadata routes return HTTP 200 with no body when no record matches.
      const rows = raw.trim()
        ? z
            .array(
              z.object({
                'Series UID': text,
                Collection: text,
                'Subject ID': text,
                'Study UID': text,
                Modality: text,
                'Series Description': text.optional(),
                'Number of Images': z.string().regex(/^\d+$/u),
                'File Size': z.string().regex(/^\d+$/u),
                'License Name': text.optional(),
                'License URL': link.optional(),
                'Data Description URI': link.optional()
              })
            )
            .max(1)
            .parse(JSON.parse(raw))
        : []
      if (rows[0] && rows[0]['Series UID'] !== args.series_uid)
        throw new Error('TCIA returned a different series UID')
      return { source_url: url, series: rows[0] ?? null }
    }
  }
]
