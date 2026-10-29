import { z } from 'zod'
import type { ToolDescriptor } from '@aipoch/connector-core'

const API = 'https://omnipathdb.org/interactions/'
const accessionPattern =
  '(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})'
// OmniPath keeps complexes as one node; expanding them would invent pairwise relations.
const entity = z
  .string()
  .max(2000)
  .regex(
    new RegExp(
      `^(?:${accessionPattern}|COMPLEX:${accessionPattern}(?:_${accessionPattern})+)$`,
      'u'
    )
  )
const interaction = z.object({
  source: entity,
  target: entity,
  source_genesymbol: z.string().min(1).max(2000),
  target_genesymbol: z.string().min(1).max(2000),
  is_directed: z.literal(true),
  is_stimulation: z.boolean(),
  is_inhibition: z.boolean(),
  consensus_direction: z.boolean(),
  consensus_stimulation: z.boolean(),
  consensus_inhibition: z.boolean(),
  sources: z.array(z.string().min(1).max(100)).max(500),
  references: z.string().max(100_000)
})

export const STRUCTURES_OMNIPATH_TOOLS: ToolDescriptor[] = [
  {
    connector: 'structures',
    id: 'omnipath_query_regulation',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'Query directed, signed human protein regulation from OmniPath. Provide one canonical human UniProt accession (resolve names with the Genes connector first). Partner nodes may be proteins or native COMPLEX: identifiers; never expand complexes into inferred pairwise edges. upstream returns sources regulating the queried target; downstream returns targets regulated by the queried source. Both stimulation and inhibition can be true: preserve conflicting evidence and separate consensus flags. Uses the omnipath dataset and the upstream commercial license filter; original resource terms still apply. Relations and citations aggregate multiple sources and biological contexts, not tissue-specific causal proof. Results use upstream order, not confidence ranking; limited results are not the complete network. No pagination or bulk download.',
    input: {
      type: 'object',
      properties: {
        accession: { type: 'string', pattern: `^${accessionPattern}$` },
        direction: { type: 'string', enum: ['upstream', 'downstream'] },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 }
      },
      required: ['accession', 'direction'],
      additionalProperties: false
    },
    required: ['accession', 'direction'],
    exampleArgs: { accession: 'P00533', direction: 'upstream', limit: 10 },
    returns:
      '{ source_url, accession, direction, organism:9606, license_filter:"commercial", returned, records_truncated, records }. Each record preserves source/target identifiers (UniProt or native COMPLEX: accessions), gene symbols, direction/sign/consensus booleans, up to 10 source names and 10 source-qualified reference strings, source_count, reference_count and evidence_truncated. Counts describe each edge\'s upstream evidence, not independent studies. No global result total. Empty records mean no matching curated signed human relations, not biological absence.',
    run: async (ctx, args) => {
      const id = String(args.accession)
      const limit = Number(args.limit ?? 10)
      const side = args.direction === 'upstream' ? 'target' : 'source'
      const params = new URLSearchParams({
        format: 'json',
        datasets: 'omnipath',
        organisms: '9606',
        directed: '1',
        signed: '1',
        genesymbols: '1',
        fields: 'sources,references',
        license: 'commercial',
        [side === 'target' ? 'targets' : 'sources']: id,
        limit: String(limit + 1)
      })
      const url = `${API}?${params}`
      // The service also returns HTTP 200 nested string arrays for invalid queries.
      const parsed = z
        .array(interaction)
        .max(limit + 1)
        .safeParse(await ctx.fetchJson(url))
      if (!parsed.success) throw new Error('OmniPath returned an error or invalid interaction data')
      if (
        parsed.data.some((row) => row[side] !== id || (!row.is_stimulation && !row.is_inhibition))
      )
        throw new Error('OmniPath returned interactions inconsistent with the requested filters')
      const records = parsed.data.slice(0, limit).map((row) => {
        const references = row.references.split(';').filter(Boolean)
        if (references.some((reference) => reference.length > 200))
          throw new Error('OmniPath returned an invalid reference identifier')
        return {
          ...row,
          sources: row.sources.slice(0, 10),
          references: references.slice(0, 10),
          source_count: row.sources.length,
          reference_count: references.length,
          evidence_truncated: row.sources.length > 10 || references.length > 10
        }
      })
      return {
        source_url: url,
        accession: id,
        direction: args.direction,
        organism: 9606,
        license_filter: 'commercial',
        returned: records.length,
        records_truncated: parsed.data.length > limit,
        records
      }
    }
  }
]
