import { z } from 'zod'
import type { ToolDescriptor } from '@aipoch/connector-core'

const API = 'https://api.orphadata.com'
const disease = z.object({ ORPHAcode: z.number().int().positive() }).passthrough()
const genes = disease.extend({
  Date: z.string(),
  DisorderGeneAssociation: z.array(
    z
      .object({
        Gene: z.object({ Symbol: z.string() }).passthrough(),
        DisorderGeneAssociationType: z.string(),
        DisorderGeneAssociationStatus: z.string()
      })
      .passthrough()
  )
})
const phenotypes = z
  .object({
    Date: z.string(),
    Disorder: disease.extend({
      HPODisorderAssociation: z.array(
        z
          .object({
            HPO: z.object({ HPOId: z.string(), HPOTerm: z.string() }).passthrough(),
            HPOFrequency: z.string()
          })
          .passthrough()
      )
    })
  })
  .passthrough()

export const ORPHADATA_TOOLS: ToolDescriptor[] = (['genes', 'phenotypes'] as const).map((kind) => ({
  id: `get_disease_${kind}`,
  connector: 'orphadata',
  credentialKeys: [],
  maxResponseBytes: 2_000_000,
  description:
    kind === 'genes'
      ? 'Retrieve Orphadata rare-disease gene associations by ORPHAcode, including association type/status, validation sources and gene database mappings.'
      : 'Retrieve Orphadata rare-disease HPO phenotypes and frequency categories by ORPHAcode. Keeps diagnostic criteria and validation metadata; frequency categories are not patient-specific probabilities.',
  input: {
    type: 'object',
    properties: { orphacode: { type: 'integer', minimum: 1, maximum: 2147483647 } },
    required: ['orphacode'],
    additionalProperties: false
  },
  required: ['orphacode'],
  exampleArgs: { orphacode: kind === 'genes' ? 166024 : 58 },
  returns:
    '{ source: "Orphadata / Orphanet", api_version: "1.0.0", source_url, data: { __count, __licence, results: { Date, ... } }, datasetCategory, ... }. Gene results contain DisorderGeneAssociation; phenotype results contain Disorder.HPODisorderAssociation with HPO and HPOFrequency. Retains dataset dates, validation and CC BY 4.0 attribution. Single disease, no pagination; HTTP 404 means no dataset record.',
  run: async (ctx, args) => {
    const route = kind === 'genes' ? 'rd-associated-genes' : 'rd-phenotypes'
    const url = `${API}/${route}/orphacodes/${args.orphacode}`
    const envelope = z
      .object({
        data: z
          .object({
            __count: z.literal(1),
            __licence: z
              .object({ identifier: z.string(), link: z.string(), name: z.string() })
              .passthrough(),
            results: z.unknown()
          })
          .passthrough(),
        datasetCategory: z.object({ name: z.string(), lang: z.string() }).passthrough()
      })
      .passthrough()
      .parse(await ctx.fetchJson(url))
    const result =
      kind === 'genes'
        ? genes.parse(envelope.data.results)
        : phenotypes.parse(envelope.data.results)
    const code =
      kind === 'genes' ? genes.parse(result).ORPHAcode : phenotypes.parse(result).Disorder.ORPHAcode
    if (code !== args.orphacode) throw new Error('Orphadata returned a different ORPHAcode')
    return {
      source: 'Orphadata / Orphanet',
      api_version: '1.0.0',
      source_url: url,
      ...envelope,
      data: { ...envelope.data, results: result }
    }
  }
}))
