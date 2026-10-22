import { z } from 'zod'
import type { ToolDescriptor, ToolContext } from '@aipoch/connector-core'

const API = 'https://dailymed.nlm.nih.gov/dailymed/services/v2'
const setid = {
  type: 'string',
  pattern: '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
}
const pagination = {
  page: { type: 'integer', minimum: 1, maximum: 100000, default: 1 },
  page_size: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
}
// Published examples encode numbers as strings; current responses also use JSON numbers.
const numberString = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
const setIdValue = z.string().regex(new RegExp(setid.pattern))
const metadata = z
  .object({
    current_page: numberString,
    total_pages: numberString,
    total_elements: numberString,
    next_page: numberString.or(z.literal('null')).nullable()
  })
  .passthrough()
const version = z.object({ spl_version: numberString, published_date: z.string() }).passthrough()

async function readPage(
  ctx: ToolContext,
  url: string,
  page: number
): Promise<{ metadata: z.infer<typeof metadata>; data: unknown; next_page: number | null }> {
  const body = z.object({ metadata, data: z.unknown() }).parse(await ctx.fetchJson(url))
  if (Number(body.metadata.current_page) !== page)
    throw new Error('DailyMed returned an unexpected page')
  const next =
    body.metadata.next_page === null || body.metadata.next_page === 'null'
      ? null
      : Number(body.metadata.next_page)
  if (next !== null && (next <= page || next > Number(body.metadata.total_pages)))
    throw new Error('DailyMed returned an invalid next page')
  return { ...body, next_page: next }
}

export const DAILYMED_TOOLS: ToolDescriptor[] = [
  {
    id: 'search_labels',
    connector: 'dailymed',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'Search DailyMed SPL label identities, titles, versions and publication dates by drug name, optionally narrowed to an RxCUI. Retrieves one metadata page; label presence does not establish FDA approval.',
    input: {
      type: 'object',
      properties: {
        drug_name: { type: 'string', minLength: 1, maxLength: 300, pattern: '\\S' },
        rxcui: { type: 'string', pattern: '^[0-9]{1,12}$' },
        ...pagination
      },
      required: ['drug_name'],
      additionalProperties: false
    },
    required: ['drug_name'],
    exampleArgs: { drug_name: 'aspirin', page_size: 5 },
    returns:
      '{ source, source_url, api_version, metadata, data: [{ setid, title, spl_version, published_date }], next_page }. Explicit one-based pagination; null next_page ends the results. No full label or file download.',
    run: async (ctx, args) => {
      const page = Number(args.page ?? 1)
      const size = Number(args.page_size ?? 20)
      const params = new URLSearchParams({
        drug_name: String(args.drug_name),
        page: String(page),
        pagesize: String(size)
      })
      if (args.rxcui) params.set('rxcui', String(args.rxcui))
      const url = `${API}/spls.json?${params}`
      const body = await readPage(ctx, url, page)
      const data = z
        .array(version.extend({ setid: setIdValue, title: z.string().nullable() }))
        .max(size)
        .parse(body.data)
      return { source: 'DailyMed', source_url: url, api_version: 'v2', ...body, data }
    }
  },
  {
    id: 'get_label_history',
    connector: 'dailymed',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'Retrieve one page of DailyMed SPL version history for an exact SET ID, preserving the label identity, title and publication dates. Does not download historical label content.',
    input: {
      type: 'object',
      properties: { setid, ...pagination },
      required: ['setid'],
      additionalProperties: false
    },
    required: ['setid'],
    exampleArgs: { setid: '9aa7140c-012c-4ea6-866d-4732e915dab6' },
    returns:
      '{ source, source_url, api_version, metadata, data: { spl: { setid, title }, history: [{ spl_version, published_date }] }, next_page }. Explicit one-based pagination.',
    run: async (ctx, args) => {
      const page = Number(args.page ?? 1)
      const size = Number(args.page_size ?? 20)
      const id = String(args.setid).toLowerCase()
      const url = `${API}/spls/${id}/history.json?${new URLSearchParams({ page: String(page), pagesize: String(size) })}`
      const body = await readPage(ctx, url, page)
      const data = z
        .object({
          spl: z.object({ setid: setIdValue, title: z.string().nullable() }).passthrough(),
          history: z.array(version).max(size)
        })
        .parse(body.data)
      if (data.spl.setid.toLowerCase() !== id)
        throw new Error('DailyMed returned a different SET ID')
      return { source: 'DailyMed', source_url: url, api_version: 'v2', ...body, data }
    }
  }
]
