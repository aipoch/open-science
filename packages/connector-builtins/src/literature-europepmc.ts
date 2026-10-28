import { z } from 'zod'
import type { ToolDescriptor } from '@aipoch/connector-core'
import { objectInput, provenance } from './official-file-links'

const SEARCH = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search'
const response = z.object({
  hitCount: z.number().int().nonnegative(),
  resultList: z.object({ result: z.array(z.object({ id: z.string() }).passthrough()) }),
  nextCursorMark: z.string().optional()
})

export const EUROPEPMC_TOOLS: ToolDescriptor[] = [
  {
    id: 'search_europepmc',
    connector: 'europepmc',
    credentialKeys: [],
    description:
      'Search Europe PMC directly using Boolean, field and date syntax. Returns core records including actual available abstracts and an explicit pagination cursor. Public: no NCBI key or contact email is required for this method. A full-text URL is not retrieved full text; follow PMC identifiers using the existing full-text tools.',
    input: objectInput(
      {
        query: { type: 'string', minLength: 1, maxLength: 12000 },
        page_size: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        cursor: { type: 'string', minLength: 1, maxLength: 4096, default: '*' }
      },
      ['query']
    ),
    required: ['query'],
    exampleArgs: { query: 'TP53 AND liver fibrosis', page_size: 5 },
    maxResponseBytes: 8_000_000,
    returns:
      '{ source, source_url, retrieved_at, query, total_count, returned_count, records: [core records with id and optional abstractText/DOI/PMCID], cursor, next_cursor, continuation_available, pagination_note }. One page is not an exhaustive search; continuation does not guarantee a nonempty next page.',
    run: async (ctx, args) => {
      const query = String(args.query)
      if (!query.trim()) throw new Error('query must not be blank')
      const cursor = String(args.cursor ?? '*')
      const url = new URL(SEARCH)
      url.search = new URLSearchParams({
        query,
        format: 'json',
        resultType: 'core',
        pageSize: String(args.page_size ?? 20),
        cursorMark: cursor
      }).toString()
      const data = response.parse(await ctx.fetchJson(url.href))
      return {
        ...provenance('Europe PMC', url.href),
        query,
        total_count: data.hitCount,
        returned_count: data.resultList.result.length,
        records: data.resultList.result,
        cursor,
        next_cursor: data.nextCursorMark ?? null,
        continuation_available: Boolean(
          data.resultList.result.length && data.nextCursorMark && data.nextCursorMark !== cursor
        ),
        pagination_note:
          'Use the returned cursor with the identical query/page_size. Missing abstracts are not reconstructed. Availability links do not establish that full text was read.'
      }
    }
  }
]
