import { z } from 'zod'
import type { ToolDescriptor } from '@aipoch/connector-core'
import { rateLimitedJson } from './rate-limited-json'

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
