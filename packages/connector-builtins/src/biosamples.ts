import { z } from 'zod'
import type { ToolDescriptor } from '@aipoch/connector-core'

const API = 'https://www.ebi.ac.uk/biosamples/samples'
const sample = z
  .object({ accession: z.string().regex(/^SAM[END][A-Z]?\d+$/), name: z.string() })
  .passthrough()
const link = z.object({ href: z.string().url() })

export const BIOSAMPLES_TOOLS: ToolDescriptor[] = [
  {
    id: 'search_samples',
    connector: 'biosamples',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'Search public EMBL-EBI BioSamples metadata, one cursor page at a time. Retains characteristics, ontology terms, external references and release/update dates. Use the returned next_cursor with unchanged query and page_size; no automatic traversal.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' },
        page_size: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        cursor: { type: 'string', minLength: 1, maxLength: 2048, pattern: '\\S' }
      },
      required: ['query'],
      additionalProperties: false
    },
    required: ['query'],
    exampleArgs: { query: 'leukaemia', page_size: 5 },
    returns:
      '{ source, source_url, samples: [{ accession, name, characteristics, externalReferences, ... }], next_cursor: string | null }. Cursor comes from the upstream next link; null ends the results. No total count is inferred.',
    run: async (ctx, args) => {
      const size = Number(args.page_size ?? 20)
      const cursor = String(args.cursor ?? '*')
      const params = new URLSearchParams({
        text: String(args.query),
        applyCurations: 'true',
        size: String(size),
        cursor
      })
      const url = `${API}?${params}`
      const body = z
        .object({
          _embedded: z.object({ samples: z.array(sample).max(size) }).optional(),
          _links: z.object({ self: link, next: link.optional() }).passthrough()
        })
        .parse(JSON.parse(await ctx.fetchText(url, 'application/hal+json')))
      const samples = body._embedded?.samples ?? []
      let nextCursor: string | null = null
      if (body._links.next && samples.length > 0) {
        const next = new URL(body._links.next.href)
        if (
          next.origin !== new URL(API).origin ||
          next.pathname !== new URL(API).pathname ||
          next.username ||
          next.password ||
          next.hash ||
          next.searchParams.get('text') !== args.query ||
          Number(next.searchParams.get('size')) !== size ||
          next.searchParams.get('applyCurations') !== 'true'
        )
          throw new Error('BioSamples returned an unexpected next link')
        nextCursor = next.searchParams.get('cursor')
        if (!nextCursor || nextCursor === cursor || nextCursor.length > 2048)
          throw new Error('BioSamples returned an invalid or non-advancing cursor')
      }
      return { source: 'EMBL-EBI BioSamples', source_url: url, samples, next_cursor: nextCursor }
    }
  },
  {
    id: 'get_sample',
    connector: 'biosamples',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'Retrieve a public BioSamples record by accession, with default applied curations, characteristics, ontology terms, relationships, external references and provenance dates. Linked resources and files are not fetched.',
    input: {
      type: 'object',
      properties: { accession: { type: 'string', pattern: '^SAM[END][A-Z]?[0-9]{1,15}$' } },
      required: ['accession'],
      additionalProperties: false
    },
    required: ['accession'],
    exampleArgs: { accession: 'SAMD00023550' },
    returns:
      '{ source, source_url, sample: { accession, name, ... } }. HTTP 404 means the public record is unavailable.',
    run: async (ctx, args) => {
      const url = `${API}/${args.accession}`
      const data = sample.parse(JSON.parse(await ctx.fetchText(url, 'application/hal+json')))
      if (data.accession !== args.accession)
        throw new Error('BioSamples returned a different accession')
      return { source: 'EMBL-EBI BioSamples', source_url: url, sample: data }
    }
  }
]
