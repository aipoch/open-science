import { z } from 'zod'
import type { ToolDescriptor } from '@aipoch/connector-core'
import { rateLimitedJson } from './rate-limited-json'
import { objectInput, provenance } from './official-file-links'

const API = 'https://rest.genenames.org'
const read = rateLimitedJson(100)
const response = z
  .object({
    responseHeader: z.object({}).passthrough(),
    response: z
      .object({
        numFound: z.number().int().nonnegative(),
        docs: z.array(
          z
            .object({
              hgnc_id: z.string(),
              symbol: z.string(),
              name: z.string(),
              status: z.string()
            })
            .passthrough()
        )
      })
      .passthrough()
  })
  .passthrough()

export const HGNC_TOOLS: ToolDescriptor[] = [
  {
    id: 'get_hgnc_gene',
    field: 'symbol',
    description:
      'Fetch human gene nomenclature by exact HGNC symbol. Retains approved/withdrawn status, names, aliases, cross-references and modification dates.',
    example: 'BRCA1'
  },
  {
    id: 'resolve_hgnc_alias',
    field: 'alias_symbol',
    description:
      'Resolve an exact human gene alias symbol through HGNC. Returns every matching gene; never silently chooses among ambiguous aliases. Use get_hgnc_gene for approved symbols.',
    example: 'P53'
  }
].map(({ id, field, description, example }) => ({
  id,
  connector: 'genes',
  credentialKeys: [],
  description,
  input: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        minLength: 1,
        maxLength: 100,
        pattern: '^[A-Za-z0-9][A-Za-z0-9_.@()+-]*$'
      }
    },
    required: ['symbol'],
    additionalProperties: false
  },
  required: ['symbol'],
  exampleArgs: { symbol: example },
  maxResponseBytes: 2_000_000,
  returns:
    '{ source: "HGNC", source_url, responseHeader, response: { numFound, docs: [{ hgnc_id, symbol, name, status, alias_symbol?, prev_symbol?, date_modified?, ... }] }. Exact lookup, no pagination; empty docs means no match. Cite HGNC and retain record status.',
  run: async (ctx, args) => {
    const url = `${API}/fetch/${field}/${encodeURIComponent(String(args.symbol))}`
    const result = response.parse(await read(ctx, url))
    if (result.response.numFound !== result.response.docs.length)
      throw new Error('HGNC returned an incomplete exact lookup')
    return { source: 'HGNC', source_url: url, ...result }
  }
}))

HGNC_TOOLS.push(
  {
    id: 'get_hgnc_service_info',
    connector: 'genes',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'Read official HGNC REST service metadata, searchable fields and stored fields. Shares request admission with the existing HGNC lookups; no key is required.',
    input: objectInput({}),
    exampleArgs: {},
    returns:
      '{ source, source_url, retrieved_at, service }. Field lists describe this service, not sample-level gene availability.',
    run: async (ctx) => {
      const url = `${API}/info`
      const service = z
        .object({ searchableFields: z.array(z.string()) })
        .passthrough()
        .parse(await read(ctx, url))
      return { ...provenance('HGNC', url), service }
    }
  },
  {
    id: 'query_hgnc_field',
    connector: 'genes',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'Fetch or search a documented HGNC field, including historical symbols and external identifiers. Search returns indexed identifiers; fetch returns stored records. Preserve ambiguous matches and approved/withdrawn status instead of silently selecting one gene.',
    input: objectInput(
      {
        mode: { type: 'string', enum: ['fetch', 'search'], default: 'fetch' },
        field: {
          type: 'string',
          enum: [
            'symbol',
            'alias_symbol',
            'prev_symbol',
            'name',
            'hgnc_id',
            'entrez_id',
            'ensembl_gene_id'
          ]
        },
        value: { type: 'string', minLength: 1, maxLength: 300 },
        max_rows: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
      },
      ['field', 'value']
    ),
    required: ['field', 'value'],
    exampleArgs: { field: 'entrez_id', value: '7157', mode: 'fetch' },
    returns:
      '{ source, source_url, retrieved_at, mode, num_found, records, truncated }. A preview is not the complete match set; zero matches only describes the supplied field/value.',
    run: async (ctx, args) => {
      const value = String(args.value)
      if (!value.trim() || ['.', '..'].includes(value))
        throw new Error('Use a nonblank HGNC field value')
      const mode = String(args.mode ?? 'fetch')
      const url = `${API}/${mode}/${args.field}/${encodeURIComponent(value)}`
      const raw = z
        .object({
          response: z.object({
            numFound: z.number().int().nonnegative(),
            docs: z.array(z.record(z.string(), z.unknown()))
          })
        })
        .parse(await read(ctx, url))
      const n = Number(args.max_rows ?? 20)
      return {
        ...provenance('HGNC', url),
        mode,
        num_found: raw.response.numFound,
        records: raw.response.docs.slice(0, n),
        truncated: raw.response.numFound > Math.min(raw.response.docs.length, n)
      }
    }
  },
  {
    id: 'list_hgnc_files',
    connector: 'genes',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'List official HGNC public-bucket objects, sizes, identity/checksum metadata and page token. This only discovers download URLs; it does not download files or create local state. ETag is not a SHA256 checksum.',
    input: objectInput({
      prefix: {
        type: 'string',
        pattern: '^hgnc/[A-Za-z0-9_./-]*$',
        maxLength: 200,
        default: 'hgnc/tsv/tsv/'
      },
      cursor: { type: 'string', maxLength: 4096, default: '' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
    }),
    exampleArgs: { prefix: 'hgnc/tsv/tsv/', limit: 5 },
    returns:
      '{ source, source_url, retrieved_at, files: [{filename,url,bytes,etag,md5_base64,updated}], next_cursor, checksum_note }. A file link or declared upstream checksum is not evidence of a completed or verified download.',
    run: async (ctx, args) => {
      const prefix = String(args.prefix ?? 'hgnc/tsv/tsv/')
      if (prefix.includes('..'))
        throw new Error('Use an HGNC object prefix without parent traversal')
      const url = new URL('https://storage.googleapis.com/storage/v1/b/public-download-files/o')
      url.search = new URLSearchParams({
        prefix,
        maxResults: String(args.limit ?? 20),
        ...(args.cursor ? { pageToken: String(args.cursor) } : {})
      }).toString()
      const raw = z
        .object({
          kind: z.literal('storage#objects'),
          items: z
            .array(
              z.object({
                name: z.string(),
                size: z.string().optional(),
                etag: z.string().optional(),
                md5Hash: z.string().optional(),
                updated: z.string().optional()
              })
            )
            .default([]),
          nextPageToken: z.string().optional()
        })
        .parse(await ctx.fetchJson(url.href))
      if (raw.items.some((item) => !item.name.startsWith(prefix)))
        throw new Error('HGNC file index returned an unexpected prefix')
      return {
        ...provenance('HGNC files', url.href),
        files: raw.items.map((item) => ({
          filename: item.name.split('/').pop(),
          url:
            'https://storage.googleapis.com/public-download-files/' +
            item.name.split('/').map(encodeURIComponent).join('/'),
          bytes: item.size ?? null,
          etag: item.etag ?? null,
          md5_base64: item.md5Hash ?? null,
          updated: item.updated ?? null
        })),
        next_cursor: raw.nextPageToken ?? null,
        checksum_note:
          'Metadata only. ETag is object identity; no file was downloaded or compared against an upstream checksum.'
      }
    }
  }
)
