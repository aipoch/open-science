import { z } from 'zod'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'
import { tagColorKeySchema } from './tags'

export const JOURNAL_IMPORT_MAX_BYTES = 32 * 1024 * 1024
export const JOURNAL_IMPORT_MAX_ROWS = 100_000
export const JOURNAL_ATTRIBUTE_FILTER_MAX = 8
export const JOURNAL_FIELD_KINDS = ['text', 'number', 'singleSelect', 'multiSelect'] as const
export const JOURNAL_EXTERNAL_ID_NAMESPACES = ['jcr', 'wos', 'scopus', 'nlm'] as const
const externalIdNamespace = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9._-]*$/i)
  .transform((value) => value.toLowerCase())
const externalIdValue = z.string().trim().min(1).max(500)
export const journalExternalIdSchema = z
  .object({ namespace: externalIdNamespace, value: externalIdValue })
  .strict()
const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value))
const text = z.string().max(8_000)
export const journalFieldSchema = z
  .object({
    id,
    label: z.string().trim().min(1).max(100),
    kind: z.enum(JOURNAL_FIELD_KINDS),
    colors: z.record(z.string().max(200), tagColorKeySchema).default({}),
    visible: z.boolean().default(true),
    columnKey: z.string().min(1).max(401).optional()
  })
  .strict()
export const journalAttributeFilterSchema = z
  .object({
    datasetId: id,
    fieldId: id,
    operator: z.enum(['equals', 'contains', 'gt', 'gte', 'lt', 'lte', 'missing']),
    value: z.string().trim().max(500).optional()
  })
  .strict()
  .refine(({ operator, value }) => operator === 'missing' || value !== undefined, {
    message: 'A value is required for this journal attribute filter.'
  })
// Omitted sources follow the latest imported year; null hides a source.
export const journalSourceYearsSchema = z.record(
  z.string().min(1).max(100),
  z.number().int().min(1800).max(9999).nullable()
)
export type JournalSourceYears = z.infer<typeof journalSourceYearsSchema>

export function selectJournalDatasets(
  datasets: readonly JournalDataset[],
  sourceYears: JournalSourceYears = {}
): JournalDataset[] {
  const selected = new Map<string, JournalDataset>()
  for (const dataset of datasets) {
    const year = Object.hasOwn(sourceYears, dataset.source)
      ? sourceYears[dataset.source]
      : undefined
    if (year === null || (year !== undefined && dataset.year !== year)) continue
    const previous = selected.get(dataset.source)
    if (!previous || previous.year < dataset.year) selected.set(dataset.source, dataset)
  }
  return [...selected.values()]
}

export const journalIdentitySchema = z
  .object({
    name: z.string().trim().max(500),
    aliases: z.array(z.string().trim().max(500)).max(20).default([]),
    issns: z.array(z.string().trim().max(100)).max(10).default([]),
    externalIds: z.array(journalExternalIdSchema).max(32).optional()
  })
  .strict()
export const journalImportRowSchema = journalIdentitySchema
  .extend({
    row: z.number().int().positive(),
    values: z.record(id, text)
  })
  .strict()
export const journalDatasetSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(100).nullish(),
    source: z.string().trim().min(1).max(100),
    year: z.number().int().min(1800).max(9999),
    revision: z.number().int().positive(),
    fields: z.array(journalFieldSchema).max(64),
    count: z.number().int().nonnegative(),
    importedAt: z.number().finite()
  })
  .strict()
const definition = journalDatasetSchema.omit({
  id: true,
  revision: true,
  count: true,
  importedAt: true
})
// Portable datasets carry presentation, never local database or reference identities.
export const journalBundleSchema = z
  .object({
    format: z.literal('open-science-journals'),
    version: z.literal(1),
    dataset: definition
      .extend({
        fields: z
          .array(journalFieldSchema.omit({ columnKey: true }))
          .min(1)
          .max(64)
          .refine((fields) => new Set(fields.map(({ id }) => id)).size === fields.length)
      })
      .strict(),
    rows: z.array(journalImportRowSchema).min(1).max(JOURNAL_IMPORT_MAX_ROWS)
  })
  .strict()
export type JournalBundle = z.infer<typeof journalBundleSchema>

export const journalMatchStatusSchema = z.enum(['matched', 'missing', 'ambiguous'])
export const journalMatchReasonSchema = z.enum([
  'manual',
  'external-id',
  'issn',
  'name',
  'multiple-candidates',
  'identifier-conflict',
  'missing-identity',
  'not-found'
])
const journalCandidateSchema = journalIdentitySchema.extend({ id })
const journalAlignmentSchema = z.object({
  token: z.string().uuid(),
  counts: z.object({
    matched: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative()
  }),
  total: z.number().int().nonnegative(),
  rows: z
    .array(
      z.object({
        itemId: id,
        metadataRevision: z.number().int().positive(),
        bindingRevision: z.string().uuid().nullable(),
        title: z.string().max(500),
        identity: journalIdentitySchema,
        status: journalMatchStatusSchema,
        reason: journalMatchReasonSchema,
        candidates: z.array(journalCandidateSchema).max(5),
        candidateTotal: z.number().int().nonnegative()
      })
    )
    .max(100)
})
export type JournalMatchStatus = z.infer<typeof journalMatchStatusSchema>
export type JournalMatchReason = z.infer<typeof journalMatchReasonSchema>
export type JournalAlignment = z.infer<typeof journalAlignmentSchema>
export const journalRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z
    .object({
      action: z.literal('export'),
      datasetId: id,
      expectedRevision: z.number().int().positive(),
      after: id.optional(),
      snapshot: z.string().max(100).optional()
    })
    .strict(),
  z.object({ action: z.literal('audit-step'), token: z.string().uuid().optional() }).strict(),
  z.object({ action: z.literal('audit-cancel'), token: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal('remove-preview'),
      datasetId: id,
      expectedRevision: z.number().int().positive()
    })
    .strict(),
  z
    .object({
      action: z.literal('bind'),
      token: z.string().uuid(),
      itemId: id,
      journalId: id.nullable(),
      expectedMetadataRevision: z.number().int().positive(),
      expectedBindingRevision: z.string().uuid().nullable()
    })
    .strict(),
  z
    .object({
      action: z.literal('audit'),
      token: z.string().uuid().optional(),
      status: journalMatchStatusSchema.default('missing'),
      limit: z.union([z.literal(25), z.literal(50), z.literal(100)]).optional(),
      offset: z.number().int().nonnegative().default(0)
    })
    .strict(),
  z.object({ action: z.literal('candidates'), query: z.string().trim().min(2).max(500) }).strict(),
  z
    .object({
      action: z.literal('begin'),
      definition,
      datasetId: id.optional(),
      expectedRevision: z.number().int().positive().optional(),
      policy: z.enum(['fill', 'replace'])
    })
    .strict(),
  z
    .object({
      action: z.literal('append'),
      token: z.string().uuid(),
      offset: z.number().int().nonnegative(),
      rows: z.array(journalImportRowSchema).min(1).max(200)
    })
    .strict(),
  z
    .object({
      action: z.literal('preview'),
      token: z.string().uuid(),
      problemsOnly: z.boolean().optional(),
      limit: z.union([z.literal(25), z.literal(50)]).optional(),
      offset: z.number().int().nonnegative().default(0)
    })
    .strict(),
  z
    .object({
      action: z.literal('commit'),
      token: z.string().uuid(),
      digest: z.string().length(64),
      skipProblems: z.boolean()
    })
    .strict(),
  z.object({ action: z.literal('discard'), token: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal('remove'),
      datasetId: id,
      expectedRemovalDigest: z.string().length(64).optional(),
      expectedRevision: z.number().int().positive()
    })
    .strict(),
  z
    .object({
      action: z.literal('fields'),
      datasetId: id,
      expectedRevision: z.number().int().positive(),
      fields: z.array(journalFieldSchema).max(64)
    })
    .strict(),
  z
    .object({
      action: z.literal('rename'),
      datasetId: id,
      expectedRevision: z.number().int().positive(),
      name: z.string().trim().min(1).max(100),
      source: journalDatasetSchema.shape.source.optional(),
      year: journalDatasetSchema.shape.year.optional()
    })
    .strict(),
  z
    .object({
      action: z.literal('entry'),
      datasetId: id,
      expectedRevision: z.number().int().positive(),
      journalId: id,
      values: z.record(id, text)
    })
    .strict(),
  z
    .object({
      action: z.literal('entries'),
      datasetId: id,
      query: z.string().max(500).default(''),
      offset: z.number().int().nonnegative().default(0),
      limit: z.union([z.literal(25), z.literal(50), z.literal(100)]).optional(),
      sortField: id.optional(),
      descending: z.boolean().default(false)
    })
    .strict(),
  z
    .object({
      action: z.literal('choices'),
      datasetId: id,
      expectedRevision: z.number().int().positive(),
      fieldId: id,
      query: z.string().max(500).default(''),
      offset: z.number().int().nonnegative().default(0)
    })
    .strict(),
  z
    .object({
      action: z.literal('resolve'),
      sourceYears: journalSourceYearsSchema.optional(),
      identities: z.array(journalIdentitySchema.extend({ itemId: id.optional() })).max(200)
    })
    .strict()
])
export const journalAttributeSchema = z
  .object({
    key: z.string().min(1).max(401),
    label: z.string(),
    kind: z.enum(JOURNAL_FIELD_KINDS),
    value: text,
    source: z.string(),
    year: z.number(),
    colors: z.record(z.string(), tagColorKeySchema)
  })
  .strict()
const previewRow = journalImportRowSchema.extend({
  status: z.enum(['matched', 'new', 'ambiguous', 'invalid', 'duplicate']),
  warnings: z.array(
    z.enum([
      'invalid-issn',
      'invalid-value',
      'missing-identity',
      'identity-conflict',
      'identity-limit',
      'duplicate-row'
    ])
  ),
  previous: z.record(id, text).optional()
})
export const journalResultSchema = z
  .object({
    scan: z
      .object({
        token: z.string().uuid(),
        processed: z.number().int().nonnegative(),
        done: z.boolean()
      })
      .optional(),
    removal: z
      .object({
        journals: z.number().int().nonnegative(),
        bindings: z.number().int().nonnegative(),
        digest: z.string().length(64)
      })
      .optional(),
    exportPage: z
      .object({
        dataset: journalDatasetSchema,
        snapshot: z.string(),
        next: id.optional(),
        rows: z.array(journalImportRowSchema).max(100)
      })
      .strict()
      .optional(),
    datasets: z.array(journalDatasetSchema).optional(),
    alignment: journalAlignmentSchema.optional(),
    candidates: z.array(journalCandidateSchema).max(20).optional(),
    token: z.string().uuid().optional(),
    digest: z.string().optional(),
    total: z.number().int().nonnegative().optional(),
    ready: z.number().int().nonnegative().optional(),
    problems: z.number().int().nonnegative().optional(),
    rows: z.array(previewRow).max(50).optional(),
    entries: z.array(journalImportRowSchema.extend({ id })).max(100).optional(),
    matches: z
      .array(
        z.object({
          status: z.enum(['matched', 'missing', 'ambiguous']),
          attributes: z.array(journalAttributeSchema),
          identity: journalIdentitySchema.optional()
        })
      )
      .max(200)
      .optional(),
    choices: z.array(z.string().max(200)).max(50).optional(),
    imported: z.number().int().nonnegative().optional()
  })
  .strict()
export const journalAttributesContract = defineApplicationCommandContract(
  validationCodec(z.tuple([journalRequestSchema])),
  validationCodec(journalResultSchema)
)
export type JournalRequest = z.infer<typeof journalRequestSchema>
export type JournalResult = z.infer<typeof journalResultSchema>
export type JournalField = z.infer<typeof journalFieldSchema>
export type JournalDataset = z.infer<typeof journalDatasetSchema>

export const journalDatasetLabel = (
  dataset: Pick<JournalDataset, 'name' | 'source'> & { year?: number }
): string => {
  if (dataset.name) return dataset.name
  const source = dataset.source.trim()
  return dataset.year === undefined || source.endsWith(String(dataset.year))
    ? source
    : `${source} ${dataset.year}`
}
export type JournalIdentity = z.infer<typeof journalIdentitySchema>
export type JournalImportRow = z.infer<typeof journalImportRowSchema>
export type JournalAttributeFilter = z.infer<typeof journalAttributeFilterSchema>
export type JournalAttribute = z.infer<typeof journalAttributeSchema>
export type JournalPreviewRow = z.infer<typeof previewRow>

export const journalColumnKey = (datasetId: string, field: JournalField): string =>
  field.columnKey ?? `${datasetId}:${field.id}`

export const normalizeJournalName = (value: string): string =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

export function normalizeIssn(value: string): string | undefined {
  const normalized = value.replace(/[\s-]/g, '').toUpperCase()
  if (!/^\d{7}[\dX]$/.test(normalized)) return undefined
  const sum = [...normalized].reduce(
    (total, char, index) => total + (char === 'X' ? 10 : Number(char)) * (8 - index),
    0
  )
  return sum % 11 === 0 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : undefined
}

export function normalizeJournalExternalIdNamespace(value: string): string {
  return value.trim().toLowerCase()
}

export function normalizeJournalExternalIdValue(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase()
}

const externalIdKey = (namespace: string, value: string): string =>
  `${normalizeJournalExternalIdNamespace(namespace)}:${normalizeJournalExternalIdValue(value)}`

const externalIdNamespaceForField = (key: string): string | undefined => {
  const normalized = key.replace(/[\s_-]+/gu, '').toLowerCase()
  if (normalized === 'jcr' || normalized === 'jcrid' || normalized === 'journalcitationreports')
    return 'jcr'
  if (normalized === 'wos' || normalized === 'wosid' || normalized === 'webofscience') return 'wos'
  if (normalized === 'scopus' || normalized === 'scopusid') return 'scopus'
  if (normalized === 'nlm' || normalized === 'nlmid' || normalized === 'nlmta') return 'nlm'
  return undefined
}

export const missingJournalValue = (value: string): boolean =>
  /^(?:\s*|n\/?a|n\.a\.|null|[-–—]+)$/i.test(value.trim())
export function journalNumber(value: string): { value: number; comparator: string } | undefined {
  const match = /^(<=|>=|<|>|≤|≥)?\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(%)?$/.exec(
    value.trim()
  )
  if (!match || !Number.isFinite(Number(match[2]))) return undefined
  return { value: Number(match[2]), comparator: match[1] ?? '' }
}
export function journalChoices(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string'))
      return [...new Set(parsed.map((item) => item.trim()).filter(Boolean))]
  } catch {
    /* Plain delimited values are also supported. */
  }
  return [
    ...new Set(
      value
        .split(/[;|]/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ]
}
export function inferJournalFieldKind(values: string[]): JournalField['kind'] {
  const present = values.filter((value) => !missingJournalValue(value))
  if (
    present.length &&
    present.every((value) => /^(?:Q[1-4]|[1-4]区|第?[一二三四]区|top\s*\d{1,2}%?)$/i.test(value))
  )
    return 'singleSelect'
  if (present.length && present.every((value) => journalNumber(value))) return 'number'
  return 'text'
}
export function journalIdentityFromItem(item: {
  containerTitle: string
  typeFields: Record<string, unknown>
  identifiers: { scheme: string; value: string }[]
}): JournalIdentity {
  const values = [
    item.typeFields.issn,
    item.typeFields.eissn,
    ...item.identifiers.filter(({ scheme }) => scheme === 'issn').map(({ value }) => value)
  ]
  const externalIds = Object.entries(item.typeFields)
    .flatMap(([key, value]) => {
      const namespace = externalIdNamespaceForField(key)
      if (!namespace || typeof value !== 'string' || !value.trim()) return []
      return [{ namespace, value: value.trim() }]
    })
    .concat(
      item.identifiers.flatMap(({ scheme, value }) =>
        ['jcr', 'wos', 'scopus', 'nlm'].includes(scheme.toLowerCase())
          ? [{ namespace: scheme.toLowerCase(), value }]
          : scheme === 'other'
            ? (() => {
                const match = /^([a-z][a-z0-9._-]*):(.+)$/iu.exec(value.trim())
                return match ? [{ namespace: match[1], value: match[2] }] : []
              })()
            : []
      )
    )
    .filter(
      ({ namespace, value }) =>
        externalIdNamespace.safeParse(namespace).success && externalIdValue.safeParse(value).success
    )
    .filter(
      (entry, index, values) =>
        values.findIndex(
          (other) =>
            externalIdKey(other.namespace, other.value) ===
            externalIdKey(entry.namespace, entry.value)
        ) === index
    )
    .slice(0, 32)
  return {
    name: item.containerTitle.slice(0, 500),
    aliases:
      typeof item.typeFields.journalAbbreviation === 'string'
        ? [item.typeFields.journalAbbreviation.slice(0, 500)]
        : [],
    issns: [
      ...new Set(
        values
          .flatMap((value) =>
            typeof value === 'string' ? (value.match(/\b\d{4}[\s-]?\d{3}[\dXx]\b/g) ?? []) : []
          )
          .flatMap((value) => normalizeIssn(value) ?? [])
      )
    ].slice(0, 10),
    ...(externalIds.length ? { externalIds } : {})
  }
}

// Exact source identity, including malformed identifiers, so changing a field cannot
// silently revive an earlier confirmation. Non-journal metadata is intentionally absent.
export function journalBindingIdentity(item: {
  itemType: string
  containerTitle: string
  typeFields: Record<string, unknown>
  identifiers: { scheme: string; value: string }[]
}): string {
  return JSON.stringify([
    item.itemType,
    item.containerTitle,
    item.typeFields.journalAbbreviation ?? null,
    item.typeFields.issn ?? null,
    item.typeFields.eissn ?? null,
    [
      ...new Set(
        item.identifiers.filter(({ scheme }) => scheme === 'issn').map(({ value }) => value)
      )
    ].sort(),
    (journalIdentityFromItem(item).externalIds ?? [])
      .map(({ namespace, value }) => [namespace, value])
      .sort(([left], [right]) => left.localeCompare(right))
  ])
}
