import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '@aipoch/connector-core'

const API = 'https://www.ebi.ac.uk/pdbe/api'
const PDB_ID = '^[1-9][A-Za-z0-9]{3}$'
const score = z.number().min(0).max(100).nullable()
const summary = z
  .array(
    z.object({
      title: z.string().max(4000),
      experimental_method: z.array(z.string().max(200)).min(1).max(20)
    })
  )
  .length(1)
const quality = z.object({
  geometry_quality: score,
  data_quality: score,
  overall_quality: score,
  experiment_data_available: z.union([z.boolean(), z.literal('unknown'), z.null()])
})
const statistic = z
  .object({
    rmsz: z.number().nonnegative().nullish(),
    num_checked: z.number().int().nonnegative(),
    num_outliers: z.number().int().nonnegative(),
    percent_outliers: z.union([
      z
        .string()
        .regex(/^[0-9]+(?:\.[0-9]+)?$/)
        .max(30),
      z.null()
    ])
  })
  .refine(
    (row) =>
      row.num_outliers <= row.num_checked &&
      (row.percent_outliers === null || Number(row.percent_outliers) <= 100)
  )
const stats = z
  .object({
    bonds: statistic.optional(),
    angles: statistic.optional(),
    rna_suite: statistic.optional(),
    rna_pucker: statistic.optional(),
    protein_ramachandran: statistic.optional(),
    protein_sidechains: statistic.optional(),
    RSRZ: statistic.optional()
  })
  .refine((value) => Object.keys(value).length > 0)

async function entryData<T>(
  ctx: ToolContext,
  url: string,
  pdbId: string,
  schema: z.ZodType<T>
): Promise<T | null> {
  const { body, status } = await ctx.fetchJsonWithHeaders(url, { allowHttpStatuses: [404] })
  if (status === 404) {
    if (
      z
        .object({ message: z.literal('Requested endpoint does not contain any data') })
        .safeParse(body).success
    )
      return null
    throw new Error('PDBe returned an unexpected not-found response')
  }
  const parsed = z.object({ [pdbId]: schema }).safeParse(body)
  if (!parsed.success) throw new Error('PDBe returned invalid entry data')
  return parsed.data[pdbId]
}

export const STRUCTURES_PDBE_TOOLS: ToolDescriptor[] = [
  {
    connector: 'structures',
    id: 'pdbe_get_validation',
    credentialKeys: [],
    maxResponseBytes: 100_000,
    totalTimeoutMs: 25_000,
    description:
      'Get PDBe quality scores and key validation statistics for one experimental PDB entry. Includes the experimental method. Preserve null metrics and unknown experimental-data availability; missing metrics are not zero or evidence of poor quality. Scores are upstream summaries, not a universal ranking across experimental methods. No predicted models or residue-level reports.',
    input: {
      type: 'object',
      properties: { pdb_id: { type: 'string', pattern: PDB_ID, maxLength: 4 } },
      required: ['pdb_id'],
      additionalProperties: false
    },
    required: ['pdb_id'],
    exampleArgs: { pdb_id: '1cbs' },
    returns:
      '{ source, pdb_id, source_url, entry_found, entry, quality_scores, validation_stats, source_urls }. entry contains title and experimental_method. A confirmed absent entry has entry_found:false and null data; an existing entry can have null quality_scores or validation_stats when that report is unavailable. Preserve upstream score names, nulls, unknown availability and string percentages. Transport and malformed-response errors are not reported as missing data.',
    run: async (ctx, args) => {
      if (typeof args.pdb_id !== 'string' || !new RegExp(PDB_ID).test(args.pdb_id))
        throw new Error('Provide one four-character PDB ID')
      const pdbId = args.pdb_id.toLowerCase()
      const sourceUrls = {
        entry: `${API}/pdb/entry/summary/${pdbId}`,
        quality_scores: `${API}/validation/summary_quality_scores/entry/${pdbId}`,
        validation_stats: `${API}/validation/key_validation_stats/entry/${pdbId}`
      }
      const entries = await entryData(ctx, sourceUrls.entry, pdbId, summary)
      const [scores, statistics] = entries
        ? await Promise.all([
            entryData(ctx, sourceUrls.quality_scores, pdbId, quality),
            entryData(ctx, sourceUrls.validation_stats, pdbId, stats)
          ])
        : [null, null]
      return {
        source: 'PDBe',
        pdb_id: pdbId,
        source_url: `https://www.ebi.ac.uk/pdbe/entry/pdb/${pdbId}`,
        entry_found: entries !== null,
        entry: entries?.[0] ?? null,
        quality_scores: scores,
        validation_stats: statistics,
        source_urls: sourceUrls
      }
    }
  }
]
