import { z } from 'zod'
import type { ToolDescriptor } from '@aipoch/connector-core'
import { rateLimitedJson } from './rate-limited-json'

const API = 'https://www.ncbi.nlm.nih.gov/research/pubtator3-api'
const read = rateLimitedJson(334)
const annotations = z
  .object({
    PubTator3: z.array(
      z
        .object({
          id: z.string(),
          passages: z.array(
            z
              .object({
                offset: z.number().int(),
                text: z.string(),
                annotations: z.array(z.object({}).passthrough())
              })
              .passthrough()
          )
        })
        .passthrough()
    )
  })
  .passthrough()
const search = z
  .object({
    results: z.array(z.object({ pmid: z.number().int().positive() }).passthrough()),
    page_size: z.number().int().positive(),
    current: z.number().int().positive(),
    count: z.number().int().nonnegative(),
    total_pages: z.number().int().nonnegative()
  })
  .passthrough()

export const PUBTATOR_TOOLS: ToolDescriptor[] = [
  {
    id: 'get_pubtator_annotations',
    connector: 'pubmed',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'Export PubTator 3 BioC JSON entity and relation annotations for published PubMed articles (title/abstract). Keeps passage text, offsets, normalized IDs and relations. Does not submit raw text.',
    input: {
      type: 'object',
      properties: {
        pmids: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          uniqueItems: true,
          items: { type: 'string', pattern: '^[1-9][0-9]{0,8}$' }
        }
      },
      required: ['pmids'],
      additionalProperties: false
    },
    required: ['pmids'],
    exampleArgs: { pmids: ['29355051'] },
    returns:
      '{ source: "PubTator 3", source_url, requested_pmids, missing_pmids, PubTator3: [{ id, passages: [{ offset, text, annotations, relations?, ... }], relations?, ... }] }. Missing IDs mean no annotation was returned, not absence of entities. Preserve BioC offsets and cite the original publication; article text retains its original rights.',
    run: async (ctx, args) => {
      const requested = args.pmids as string[]
      const url = `${API}/publications/export/biocjson?${new URLSearchParams({ pmids: requested.join(',') })}`
      const result = annotations.parse(await read(ctx, url))
      if (result.PubTator3.some((item) => !requested.includes(item.id)))
        throw new Error('PubTator returned an unrequested publication')
      return {
        source: 'PubTator 3',
        source_url: url,
        requested_pmids: requested,
        missing_pmids: requested.filter((id) => !result.PubTator3.some((item) => item.id === id)),
        ...result
      }
    }
  },
  {
    id: 'search_pubtator',
    connector: 'pubmed',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'Search one page of PubTator 3 publications by text, entity IDs or relations (e.g. relations:ANY|@CHEMICAL_Doxorubicin|@DISEASE_Neoplasms). Automated relations are research evidence, not clinical conclusions.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 1000, pattern: '\\S' },
        page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 }
      },
      required: ['query'],
      additionalProperties: false
    },
    required: ['query'],
    exampleArgs: { query: 'relations:ANY|@CHEMICAL_Doxorubicin|@DISEASE_Neoplasms', page: 1 },
    returns:
      '{ source: "PubTator 3", source_url, results: [{ pmid, title?, text_hl?, citations?, ... }], current, page_size, count, total_pages, next_page, ... }. Server controls page size; fetch subsequent pages explicitly. Publication citations and search evidence are retained.',
    run: async (ctx, args) => {
      const page = Number(args.page ?? 1)
      const url = `${API}/search/?${new URLSearchParams({ text: String(args.query), page: String(page) })}`
      const result = search.parse(await read(ctx, url))
      if (result.current !== page) throw new Error('PubTator returned an unexpected page')
      return {
        source: 'PubTator 3',
        source_url: url,
        ...result,
        next_page: result.current < result.total_pages ? result.current + 1 : null
      }
    }
  }
]
