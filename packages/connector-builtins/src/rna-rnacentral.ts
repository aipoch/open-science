import { z } from 'zod'
import type { ToolDescriptor } from '@aipoch/connector-core'
import { rateLimitedJson } from './rate-limited-json'

const API = 'https://rnacentral.org/api/v1'
const read = rateLimitedJson(50)
const id = { type: 'string', pattern: '^URS[0-9A-F]{10}$' }
const record = z
  .object({
    rnacentral_id: z.string(),
    sequence: z.string(),
    length: z.number().int().nonnegative()
  })
  .passthrough()
const xrefs = z
  .object({
    count: z.number().int().nonnegative(),
    next: z.string().nullable(),
    previous: z.string().nullable(),
    results: z.array(
      z
        .object({
          upi: z.string(),
          database: z.string(),
          accession: z.object({ id: z.string() }).passthrough()
        })
        .passthrough()
    )
  })
  .passthrough()

export const RNACENTRAL_TOOLS: ToolDescriptor[] = [
  {
    id: 'get_rnacentral_record',
    connector: 'rna',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'Fetch an RNAcentral sequence record by URS accession using API v1. Retains sequence, MD5, activity status, organism and RNA type metadata.',
    input: {
      type: 'object',
      properties: { urs: id },
      required: ['urs'],
      additionalProperties: false
    },
    required: ['urs'],
    exampleArgs: { urs: 'URS0000000001' },
    returns:
      '{ source: "RNAcentral", api_version: "v1", source_url, record: { rnacentral_id, sequence, length, md5?, is_active?, ... } }. API version is not a dataset release. Linked resources are not fetched. Cite RNAcentral and the originating expert database.',
    run: async (ctx, args) => {
      const url = `${API}/rna/${args.urs}/?format=json`
      const result = record.parse(await read(ctx, url))
      if (result.rnacentral_id !== args.urs)
        throw new Error('RNAcentral returned a different accession')
      return { source: 'RNAcentral', api_version: 'v1', source_url: url, record: result }
    }
  },
  {
    id: 'get_rnacentral_xrefs',
    connector: 'rna',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'Map an RNAcentral URS accession to one page of expert-database identifiers. Retains source database, taxonomy, accession version, activity and first/last-seen dates; no automatic page traversal.',
    input: {
      type: 'object',
      properties: {
        urs: id,
        page: { type: 'integer', minimum: 1, maximum: 100000, default: 1 },
        page_size: { type: 'integer', minimum: 1, maximum: 100, default: 10 }
      },
      required: ['urs'],
      additionalProperties: false
    },
    required: ['urs'],
    exampleArgs: { urs: 'URS0000000001', page: 1, page_size: 10 },
    returns:
      '{ source: "RNAcentral", api_version: "v1", source_url, count, next, previous, next_page, results: [{ upi, database, taxid?, is_active?, first_seen?, last_seen?, accession: { id, ... }, ... }] }. Each page retains full mapping evidence. Links are informational and never followed.',
    run: async (ctx, args) => {
      const page = Number(args.page ?? 1)
      const url = `${API}/rna/${args.urs}/xrefs/?${new URLSearchParams({ format: 'json', page: String(page), page_size: String(args.page_size ?? 10) })}`
      const result = xrefs.parse(await read(ctx, url))
      if (result.results.some((item) => item.upi !== args.urs))
        throw new Error('RNAcentral returned mappings for a different accession')
      return {
        source: 'RNAcentral',
        api_version: 'v1',
        source_url: url,
        ...result,
        next_page: result.next === null ? null : page + 1
      }
    }
  }
]
