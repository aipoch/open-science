import { z } from 'zod'
import type { ToolDescriptor } from '@aipoch/connector-core'

const API = 'https://dgidb.org/api/graphql'
const identity = z
  .object({ name: z.string().nullable(), conceptId: z.string().nullable() })
  .passthrough()
const interaction = z
  .object({
    interactionScore: z.number().nullable(),
    interactionTypes: z.array(
      z.object({ type: z.string().nullable(), directionality: z.string().nullable() }).passthrough()
    ),
    interactionAttributes: z.array(
      z.object({ name: z.string().nullable(), value: z.string().nullable() }).passthrough()
    ),
    publications: z.array(z.object({ pmid: z.number().int() }).passthrough()),
    sources: z.array(
      z
        .object({
          sourceDbName: z.string(),
          sourceDbVersion: z.string().nullable(),
          license: z.string().nullable(),
          licenseLink: z.string().nullable()
        })
        .passthrough()
    )
  })
  .passthrough()

export const DGIDB_TOOLS: ToolDescriptor[] = (['genes', 'drugs'] as const).map((root) => {
  const other = root === 'genes' ? 'drug' : 'gene'
  const pageSchema = z.object({
    pageInfo: z.object({ endCursor: z.string().nullable(), hasNextPage: z.boolean() }),
    nodes: z.array(
      identity.extend({ interactions: z.array(interaction.extend({ [other]: identity })) })
    )
  })
  const query = `query($name: String!, $after: String) {
    ${root}(names: [$name], first: 1, after: $after) {
      pageInfo { endCursor hasNextPage }
      nodes { name conceptId interactions {
        ${other} { name conceptId }
        interactionScore interactionTypes { type directionality }
        interactionAttributes { name value } publications { pmid }
        sources { sourceDbName sourceDbVersion license licenseLink }
      } }
    }
  }`
  return {
    id: root === 'genes' ? 'get_dgidb_gene_drugs' : 'get_dgidb_drug_genes',
    connector: 'clinical-genomics',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description: `Query DGIdb drug–gene interactions by ${root === 'genes' ? 'gene' : 'drug'} name. One matching record per page, with full interaction sources, source versions, licenses, types, attributes and publication evidence. Names can match multiple records; follow next_cursor explicitly.`,
    input: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
        after: { type: 'string', minLength: 1, maxLength: 500 }
      },
      required: ['name'],
      additionalProperties: false
    },
    required: ['name'],
    exampleArgs: { name: root === 'genes' ? 'BRAF' : 'IMATINIB' },
    returns:
      '{ source: "DGIdb", source_url, nodes: [{ name, conceptId, interactions: [{ gene|drug, interactionScore, interactionTypes, interactionAttributes, publications, sources }] }], pageInfo, next_cursor }. Interactions within each node are unpaginated upstream; oversized replies fail explicitly. Aggregated evidence is not clinical advice. Cite DGIdb and individual sources; source-specific reuse terms apply.',
    run: async (ctx, args) => {
      const raw = z
        .object({
          errors: z.array(z.unknown()).optional(),
          data: z.record(z.string(), z.unknown()).nullish()
        })
        .parse(
          await ctx.postJson(API, {
            query,
            variables: { name: args.name, after: args.after ?? null }
          })
        )
      if (raw.errors?.length)
        throw new Error('DGIdb returned GraphQL errors; no partial results were accepted')
      const page = pageSchema.parse(raw.data?.[root])
      if (
        page.pageInfo.hasNextPage &&
        (!page.pageInfo.endCursor || page.pageInfo.endCursor === args.after)
      )
        throw new Error('DGIdb returned a non-advancing page cursor')
      return {
        source: 'DGIdb',
        source_url: API,
        ...page,
        next_cursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
      }
    }
  }
})
