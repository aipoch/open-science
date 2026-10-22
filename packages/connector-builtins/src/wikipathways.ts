import { z } from 'zod'
import type { ToolDescriptor } from '@aipoch/connector-core'

const API = 'https://www.wikipathways.org/json'
const pathway = z.object({
  id: z.string().regex(/^WP\d+$/),
  url: z.string().url(),
  name: z.string(),
  species: z.string(),
  revision: z.string()
})

export const WIKIPATHWAYS_TOOLS: ToolDescriptor[] = [
  {
    id: 'search_pathways',
    connector: 'wikipathways',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'Find WikiPathways by case-insensitive name or WP identifier substring, optionally restricted to an exact scientific species name. Filters the current official listPathways JSON snapshot locally; this is not full-text or gene search.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 300, pattern: '\\S' },
        species: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
        offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
      },
      required: ['query'],
      additionalProperties: false
    },
    required: ['query'],
    exampleArgs: { query: 'glycolysis', species: 'Homo sapiens' },
    returns:
      '{ source, source_url, pagination: "local_snapshot", total, offset, next_offset, pathways: [{ id, url, name, species, revision }] }. Stable ID sorting within each fetched snapshot; data can change between calls. Only the selected slice is returned.',
    run: async (ctx, args) => {
      const url = `${API}/listPathways.json`
      const body = z
        .object({ organisms: z.array(z.object({ pathways: z.array(pathway) })) })
        .parse(await ctx.fetchJson(url))
      const query = String(args.query).trim().toLowerCase()
      const species = args.species ? String(args.species).trim().toLowerCase() : undefined
      const matches = body.organisms
        .flatMap((organism) => organism.pathways)
        .filter(
          (row) =>
            (!species || row.species.toLowerCase() === species) &&
            (row.name.toLowerCase().includes(query) || row.id.toLowerCase().includes(query))
        )
        .sort((a, b) => a.id.localeCompare(b.id, 'en'))
      const offset = Number(args.offset ?? 0)
      const limit = Number(args.limit ?? 20)
      return {
        source: 'WikiPathways',
        source_url: url,
        pagination: 'local_snapshot',
        total: matches.length,
        offset,
        next_offset: offset + limit < matches.length ? offset + limit : null,
        pathways: matches.slice(offset, offset + limit)
      }
    }
  },
  {
    id: 'get_pathway',
    connector: 'wikipathways',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'Retrieve one WikiPathways metadata record by WP identifier from the current getPathwayInfo JSON snapshot. Preserves species, revision, authors, source description and citations. Does not retrieve pathway graphs, gene mappings or historical revisions.',
    input: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^WP[0-9]{1,10}$' } },
      required: ['id'],
      additionalProperties: false
    },
    required: ['id'],
    exampleArgs: { id: 'WP534' },
    returns:
      '{ source, source_url, pathway: { id, url, name, species, revision, authors, description, citedIn } | null }. Null means absent from the current snapshot. Descriptions may already be abbreviated by the source.',
    run: async (ctx, args) => {
      const url = `${API}/getPathwayInfo.json`
      const body = z
        .object({
          pathwayInfo: z.array(
            pathway.extend({ authors: z.string(), description: z.string(), citedIn: z.string() })
          )
        })
        .parse(await ctx.fetchJson(url))
      const records = body.pathwayInfo.filter((row) => row.id === args.id)
      if (records.length > 1) throw new Error('WikiPathways returned duplicate pathway identities')
      return { source: 'WikiPathways', source_url: url, pathway: records[0] ?? null }
    }
  }
]
