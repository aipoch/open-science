import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '@aipoch/connector-core'

const API = 'https://depmap.org/portal/breadbox'
const MODEL = '^ACH-[0-9]{6}$'
const text = z.string().min(1).max(300)
const modelId = z.string().regex(new RegExp(MODEL))
const columns = ['CellLineName', 'OncotreeLineage', 'OncotreePrimaryDisease', 'CCLEName', 'RRID']
const datasetSchema = z.object({
  id: z.uuid(),
  given_id: text,
  name: text,
  format: z.enum(['matrix_dataset', 'tabular_dataset']),
  units: text.nullish(),
  feature_type_name: text.nullish(),
  sample_type_name: text.nullish(),
  index_type_name: text.nullish(),
  dataset_metadata: z.object({
    download_file_info: z.object({ release_name: text, file_name: text })
  })
})
const searchRow = z.object({ type_name: text, id: text, label: text })
const profileArgs = z.object({
  model_ids: z
    .array(modelId)
    .min(1)
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length)
    .optional(),
  limit: z.number().int().min(1).max(50).default(20)
})
const profileInput = {
  model_ids: {
    type: 'array',
    items: { type: 'string', pattern: MODEL },
    minItems: 1,
    maxItems: 20,
    uniqueItems: true,
    description:
      'Optional exact ModelIDs from depmap_search_models; omit for a ranked profile across models.'
  },
  limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
}
const source = { source: 'DepMap', source_url: 'https://depmap.org/portal/' }

async function datasets(ctx: ToolContext): Promise<unknown[]> {
  return z.array(z.unknown()).parse(await ctx.fetchJson(`${API}/datasets/`))
}
function dataset(catalog: unknown[], givenId: string): z.infer<typeof datasetSchema> {
  const matches = catalog.filter(
    (r) => r && typeof r === 'object' && 'given_id' in r && r.given_id === givenId
  )
  if (matches.length !== 1) throw new Error(`DepMap dataset unavailable or ambiguous: ${givenId}`)
  return datasetSchema.parse(matches[0])
}
function provenance(d: z.infer<typeof datasetSchema>): Record<string, unknown> {
  return {
    id: d.id,
    given_id: d.given_id,
    name: d.name,
    release: d.dataset_metadata.download_file_info.release_name,
    file: d.dataset_metadata.download_file_info.file_name,
    units: d.units ?? null
  }
}
async function search(
  ctx: ToolContext,
  query: string,
  type: string,
  limit: number
): Promise<z.infer<typeof searchRow>[]> {
  const params = new URLSearchParams({ substring: query, type_name: type, limit: String(limit) })
  const rows = z
    .array(searchRow)
    .max(limit)
    .parse(await ctx.fetchJson(`${API}/datasets/dimensions/?${params}`))
  if (rows.some((r) => r.type_name !== type) || new Set(rows.map((r) => r.id)).size !== rows.length)
    throw new Error('DepMap returned inconsistent search identities')
  return rows
}
async function metadata(
  ctx: ToolContext,
  catalog: unknown[],
  ids: string[]
): Promise<{
  dataset: Record<string, unknown>
  rows: Record<string, unknown>[]
}> {
  const d = dataset(catalog, 'depmap_model_metadata')
  if (d.format !== 'tabular_dataset' || d.index_type_name !== 'depmap_model')
    throw new Error('DepMap returned an incompatible model metadata dataset')
  const raw = z.record(z.string(), z.record(modelId, z.string().max(1000).nullable())).parse(
    await ctx.postJson(`${API}/datasets/tabular/${d.id}`, {
      indices: ids,
      identifier: 'id',
      columns
    })
  )
  if (
    Object.keys(raw).some((c) => !columns.includes(c)) ||
    Object.values(raw).some((v) => Object.keys(v).some((id) => !ids.includes(id))) ||
    (Object.keys(raw).length > 0 && columns.some((c) => !(c in raw)))
  )
    throw new Error('DepMap returned inconsistent model metadata')
  return {
    dataset: provenance(d),
    rows: ids.map((id) => ({
      model_id: id,
      ...Object.fromEntries(columns.map((c) => [c, raw[c]?.[id] ?? null]))
    }))
  }
}
async function profile(
  ctx: ToolContext,
  feature: string,
  kind: 'gene' | 'drug',
  models: string[] | undefined,
  limit: number
): Promise<unknown> {
  const catalog = await datasets(ctx)
  const d = dataset(catalog, kind === 'gene' ? 'Chronos_Combined' : 'REPURPOSING_AUC_collapsed')
  const units = kind === 'gene' ? 'Gene Effect (Chronos)' : 'AUC'
  if (
    d.format !== 'matrix_dataset' ||
    d.sample_type_name !== 'depmap_model' ||
    d.feature_type_name !== (kind === 'gene' ? 'gene' : 'compound_v2') ||
    d.units !== units
  )
    throw new Error('DepMap returned an incompatible score dataset')
  const raw = z.record(z.string(), z.record(modelId, z.number().finite().nullable())).parse(
    await ctx.postJson(`${API}/datasets/matrix/${d.id}`, {
      features: [feature],
      feature_identifier: kind === 'gene' ? 'label' : 'id',
      ...(models ? { samples: models, sample_identifier: 'id' } : {})
    })
  )
  if (Object.keys(raw).some((key) => key !== feature))
    throw new Error('DepMap returned a different feature')
  const values = raw[feature] ?? {}
  if (
    (models && Object.keys(values).some((id) => !models.includes(id))) ||
    (kind === 'drug' && Object.values(values).some((v) => v !== null && (v < 0 || v > 1)))
  )
    throw new Error('DepMap returned inconsistent scores')
  const entries = Object.entries(values).sort(
    ([a, x], [b, y]) =>
      (x === null ? (y === null ? 0 : 1) : y === null ? -1 : x - y) || a.localeCompare(b)
  )
  const selected = entries.slice(0, limit)
  const annotations = selected.length
    ? await metadata(
        ctx,
        catalog,
        selected.map(([id]) => id)
      )
    : undefined
  return {
    ...source,
    feature,
    dataset: provenance(d),
    model_metadata_dataset: annotations?.dataset ?? null,
    total_models: entries.length,
    missing_values: entries.filter(([, v]) => v === null).length,
    returned: selected.length,
    truncated: entries.length > selected.length,
    unavailable_model_ids: models?.filter((id) => !(id in values)) ?? [],
    sort: 'score_ascending_nulls_last',
    interpretation:
      kind === 'gene'
        ? 'Chronos gene effect, not dependency probability. More negative scores indicate stronger growth effects. Empty or null values do not establish biological independence.'
        : 'PRISM secondary screen AUC over the screened dose range, not IC50 or viability. Lower AUC indicates greater sensitivity. Null values are unmeasured, not zero.',
    records: selected.map(([, score], i) => ({ ...annotations!.rows[i], score }))
  }
}

const common = {
  connector: 'cancer-models',
  credentialKeys: [],
  totalTimeoutMs: 25_000,
  maxResponseBytes: 1_000_000
}
export const DEPMAP_TOOLS: ToolDescriptor[] = [
  {
    ...common,
    id: 'depmap_search_models',
    description:
      'Search DepMap/CCLE cancer models by name substring or exact ACH ModelID and return selected identity, lineage, disease and RRID metadata. Names may match multiple models: retain their distinct ModelIDs. No full model catalog download.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 100, pattern: '\\S' },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 }
      },
      required: ['query'],
      additionalProperties: false
    },
    required: ['query'],
    exampleArgs: { query: 'A549' },
    returns:
      '{ source, source_url, model_metadata_dataset, returned, has_more, records:[{model_id, CellLineName, OncotreeLineage, OncotreePrimaryDisease, CCLEName, RRID}] }. Missing fields remain null. has_more reports truncated search results, not a total count.',
    run: async (ctx, input) => {
      const args = z
        .object({
          query: z.string().trim().min(2).max(100),
          limit: z.number().int().min(1).max(20).default(10)
        })
        .strict()
        .parse(input)
      const exact = modelId.safeParse(args.query)
      const matches = exact.success
        ? [exact.data]
        : (await search(ctx, args.query, 'depmap_model', args.limit + 1)).map((r) =>
            modelId.parse(r.id)
          )
      if (!matches.length)
        return {
          ...source,
          model_metadata_dataset: null,
          returned: 0,
          has_more: false,
          records: []
        }
      const result = await metadata(ctx, await datasets(ctx), matches.slice(0, args.limit))
      const records = result.rows.filter((r) => r.CellLineName !== null)
      return {
        ...source,
        model_metadata_dataset: result.dataset,
        returned: records.length,
        has_more: matches.length > args.limit,
        records
      }
    }
  },
  {
    ...common,
    id: 'depmap_gene_dependency',
    description:
      'Get one exact gene symbol’s DepMap Chronos gene-effect profile, optionally restricted to ModelIDs. Returns the strongest effects first, bounded to 50 models. Missing scores are unknown, not zero; negative gene effects are not dependency probabilities. Includes current dataset release and model annotations; no full matrix download.',
    input: {
      type: 'object',
      properties: {
        gene: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$' },
        ...profileInput
      },
      required: ['gene'],
      additionalProperties: false
    },
    required: ['gene'],
    exampleArgs: { gene: 'KRAS', model_ids: ['ACH-000681'] },
    returns:
      '{ source, source_url, feature, dataset:{id,given_id,name,release,file,units}, model_metadata_dataset, total_models, missing_values, returned, truncated, unavailable_model_ids, sort, interpretation, records:[{model_id,CellLineName,OncotreeLineage,OncotreePrimaryDisease,CCLEName,RRID,score}] }. Counts cover the requested model scope before truncation; nulls sort last. Empty results mean no data for the exact request.',
    run: async (ctx, input) => {
      const args = profileArgs
        .extend({ gene: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/u) })
        .strict()
        .parse(input)
      return profile(ctx, args.gene, 'gene', args.model_ids, args.limit)
    }
  },
  {
    ...common,
    id: 'depmap_drug_response',
    description:
      'Get one compound’s DepMap PRISM secondary screen AUC profile, optionally restricted to ModelIDs. Accepts an exact DPC compound ID or full compound name (case-insensitive exact match, no fuzzy substitution). Returns lowest AUC first, bounded to 50 models. AUC is not IC50 or viability; missing values stay null. Reports the PRISM release separately from model metadata.',
    input: {
      type: 'object',
      properties: {
        compound: { type: 'string', minLength: 2, maxLength: 100, pattern: '\\S' },
        ...profileInput
      },
      required: ['compound'],
      additionalProperties: false
    },
    required: ['compound'],
    exampleArgs: { compound: 'trametinib', model_ids: ['ACH-000681'] },
    returns:
      'Same bounded score profile as depmap_gene_dependency, with feature set to the exact DPC ID and dataset.units="AUC". Unknown or ambiguous compound names raise an error; known compounds without PRISM measurements return empty records. Missing measurements do not establish drug resistance.',
    run: async (ctx, input) => {
      const args = profileArgs
        .extend({ compound: z.string().trim().min(2).max(100) })
        .strict()
        .parse(input)
      let id = args.compound
      if (!/^DPC-[0-9]{6}$/u.test(id)) {
        const candidates = await search(ctx, id, 'compound_v2', 50)
        const matches = candidates.filter((r) => r.label.toLowerCase() === id.toLowerCase())
        // A full search page cannot rule out another exact match beyond the cap.
        if (candidates.length === 50 || matches.length !== 1)
          throw new Error(
            'DepMap compound name has no unique exact match; provide its exact DPC ID'
          )
        id = matches[0].id
        if (!/^DPC-[0-9]{6}$/u.test(id)) throw new Error('DepMap returned an invalid compound ID')
      }
      return profile(ctx, id, 'drug', args.model_ids, args.limit)
    }
  }
]
