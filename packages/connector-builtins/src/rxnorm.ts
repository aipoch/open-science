import { z } from 'zod'
import type { ToolDescriptor } from '@aipoch/connector-core'
import { rateLimitedJson } from './rate-limited-json'

const API = 'https://rxnav.nlm.nih.gov/REST'
const read = rateLimitedJson(100)
const rxcui = { type: 'string', pattern: '^[0-9]{1,12}$' }

export const RXNORM_TOOLS: ToolDescriptor[] = [
  {
    id: 'resolve_name',
    connector: 'rxnorm',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'Resolve a drug name to active RxNorm RxCUIs. Exact matching is the default; normalized matching can ignore salts and word order. Retains all ambiguous matches and does not establish clinical equivalence.',
    input: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 300, pattern: '\\S' },
        search: {
          type: 'integer',
          enum: [0, 1, 2],
          description: '0 exact (default), 1 normalized, 2 exact then normalized.'
        }
      },
      required: ['name'],
      additionalProperties: false
    },
    required: ['name'],
    exampleArgs: { name: 'aspirin' },
    returns:
      '{ source, source_url, search, rxcuis: string[] }. Empty array means no active match. No pagination; all returned identities are retained.',
    run: async (ctx, args) => {
      const search = Number(args.search ?? 0)
      const url = `${API}/rxcui.json?${new URLSearchParams({ name: String(args.name), allsrc: '0', search: String(search) })}`
      const body = z
        .object({
          idGroup: z
            .object({ rxnormId: z.array(z.string().regex(/^\d+$/)).nullish() })
            .passthrough()
        })
        .parse(await read(ctx, url))
      return {
        source: 'RxNorm / RxNav',
        source_url: url,
        search,
        rxcuis: body.idGroup.rxnormId ?? []
      }
    }
  },
  {
    id: 'get_concept',
    connector: 'rxnorm',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'Retrieve active RxNorm concept properties by RxCUI: name, synonym, term type, language and suppression flag. An absent record is not proof that an identifier never existed.',
    input: {
      type: 'object',
      properties: { rxcui },
      required: ['rxcui'],
      additionalProperties: false
    },
    required: ['rxcui'],
    exampleArgs: { rxcui: '1191' },
    returns:
      '{ source, source_url, rxcui, properties: { rxcui, name, tty, ... } | null }. Null means no active concept properties; historical identifiers are not automatically remapped.',
    run: async (ctx, args) => {
      const url = `${API}/rxcui/${args.rxcui}/properties.json`
      const body = z
        .object({
          properties: z
            .object({ rxcui: z.string(), name: z.string(), tty: z.string() })
            .passthrough()
            .nullish()
        })
        .strict()
        .parse(await read(ctx, url))
      if (body.properties && body.properties.rxcui !== args.rxcui)
        throw new Error('RxNorm returned a different RxCUI')
      return {
        source: 'RxNorm / RxNav',
        source_url: url,
        rxcui: args.rxcui,
        properties: body.properties ?? null
      }
    }
  }
]
