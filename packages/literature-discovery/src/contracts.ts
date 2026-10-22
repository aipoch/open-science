import { z } from 'zod'
import { bibliographicRecordSchema } from '@aipoch/literature-citations/contracts'
export { literatureFailureSchema, type LiteratureFailure } from './failure.js'
import { literatureFailureSchema } from './failure.js'
const nonEmptyTextSchema = z.string().trim().min(1)
const optionalTextSchema = z.string().trim().optional()
// Discovery preserves caller-owned metadata without interpreting Library state.
export const discoveryRecordSchema = bibliographicRecordSchema.loose()
export type DiscoveryRecord = z.infer<typeof discoveryRecordSchema>
export const discoveryReferenceSchema = z
  .object({
    id: nonEmptyTextSchema,
    item: discoveryRecordSchema,
    attachments: z.array(
      z
        .object({
          kind: z.string(),
          versions: z.array(z.object({ contentType: z.string() }).loose())
        })
        .loose()
    ),
    metadataRevision: z.number().int().positive(),
    deletedAt: z.number().optional()
  })
  .loose()
export type DiscoveryReference = z.infer<typeof discoveryReferenceSchema>
export const literatureSourceInputSchema = z
  .object({
    provider: nonEmptyTextSchema,
    externalId: optionalTextSchema,
    sourceUrl: optionalTextSchema,
    rawMetadata: z.record(z.string(), z.unknown())
  })
  .strict()

export const LITERATURE_METADATA_FIELDS = [
  'title',
  'abstract',
  'authors',
  'identifiers',
  'publicationDate',
  'year',
  'journal',
  'shortTitle',
  'volume',
  'issue',
  'pages',
  'publisher',
  'issn',
  'language',
  'url'
] as const
export const LITERATURE_METADATA_PROVIDERS = [
  'crossref',
  'pubmed',
  'europe-pmc',
  'datacite'
] as const

export const literatureMetadataCompletionRequestSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('preview'),
      itemId: nonEmptyTextSchema,
      identifier: z
        .object({ scheme: z.enum(['doi', 'pmid']), value: nonEmptyTextSchema })
        .strict()
        .optional()
    })
    .strict(),
  z
    .object({
      mode: z.literal('commit'),
      itemId: nonEmptyTextSchema,
      reviewToken: z.string().uuid().optional(),
      expectedMetadataRevision: z.number().int().positive(),
      identifier: z
        .object({ scheme: z.enum(['doi', 'pmid']), value: nonEmptyTextSchema })
        .strict()
        .optional(),
      overwriteFields: z
        .array(z.enum(LITERATURE_METADATA_FIELDS))
        .max(LITERATURE_METADATA_FIELDS.length)
    })
    .strict()
])

export const literatureMetadataValueSchema = z
  .object({ field: z.enum(LITERATURE_METADATA_FIELDS), value: nonEmptyTextSchema })
  .strict()

export const literatureMetadataConflictSchema = literatureMetadataValueSchema
  .extend({ currentValue: nonEmptyTextSchema })
  .strict()

// Review versions describe replay semantics, not provider wire formats. V2 commits the
// normalized proposal; source payloads are provenance only. Provider additions and optional,
// defaulted fields should retain v2 when existing snapshots keep their meaning. Preserve
// conflict choices, identifier replacement, revision checks and idempotency when evolving it.
// New readers must keep reading earlier v2 snapshots; this is not a downgrade guarantee.
// Preserve Zod’s inferred output for the caller-provided reference schema.

export const createMetadataCompletionResultSchema = <T extends z.ZodType<DiscoveryReference>>(
  itemSchema: T
  // Zod must retain the inferred caller-specific output type.
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
) =>
  z
    .object({
      mode: z.enum(['preview', 'commit']),
      provider: z.enum(LITERATURE_METADATA_PROVIDERS),
      sourceUrl: nonEmptyTextSchema,
      item: itemSchema,
      filled: z.array(literatureMetadataValueSchema),
      conflicts: z.array(literatureMetadataConflictSchema),
      reviewToken: z.string().uuid().optional(),
      reviewVersion: z.union([z.literal(1), z.literal(2)]).optional(),
      proposal: discoveryRecordSchema.extend({ title: z.string() }).optional(),
      sources: z.array(literatureSourceInputSchema).max(8).optional(),
      failures: z.array(literatureFailureSchema).max(10).optional(),
      source: literatureSourceInputSchema.optional()
    })
    .strict()

export const literatureFullTextCandidateSchema = z
  .object({
    id: nonEmptyTextSchema,
    provider: z.enum(['europe-pmc', 'openalex', 'unpaywall', 'pmc', 'arxiv']),
    url: z.string().url(),
    sourceUrl: z.string().url().optional(),
    source: nonEmptyTextSchema,
    version: z.enum(['published', 'accepted', 'submitted']).optional(),
    license: nonEmptyTextSchema.optional()
  })
  .strict()
// Use only explicit PDF filenames from the source link; otherwise name the attachment after the reference.
export function getFullTextFilename(url: string, title: string): string {
  const clean = (name: string): string => name.replace(/[<>:"/\\|?*\p{Cc}]/gu, ' ').trim()
  try {
    const link = new URL(url)
    const pathName = decodeURIComponent(link.pathname.split('/').at(-1) ?? '')
    for (const name of [
      pathName,
      link.searchParams.get('filename'),
      link.searchParams.get('file')
    ]) {
      if (!name || !/[^.].*\.pdf$/iu.test(name)) continue
      const stem = clean(name.slice(0, -4)).slice(0, 120)
      if (stem && stem !== '.' && stem !== '..') return `${stem}.pdf`
    }
  } catch {
    // A malformed encoded filename must not hide an otherwise usable search result.
  }
  return `${
    clean(title)
      .replace(/\.pdf$/iu, '')
      .slice(0, 120) || 'paper'
  }.pdf`
}

export const literatureFullTextProgressSchema = z
  .object({
    receivedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().positive().optional(),
    bytesPerSecond: z.number().nonnegative(),
    phase: z.enum(['downloading', 'saving'])
  })
  .strict()
export type LiteratureFullTextProgress = z.infer<typeof literatureFullTextProgressSchema>

export const literatureFullTextTransferSchema = z
  .object({
    id: nonEmptyTextSchema,
    itemId: nonEmptyTextSchema,
    candidate: literatureFullTextCandidateSchema,
    status: z.enum(['running', 'succeeded', 'failed']),
    progress: literatureFullTextProgressSchema,
    attachmentId: nonEmptyTextSchema.optional(),
    versionId: nonEmptyTextSchema.optional(),
    retryAt: z.number().finite().nonnegative().optional()
  })
  .strict()
export type LiteratureFullTextTransfer = z.infer<typeof literatureFullTextTransferSchema>

export const literatureFullTextRequestSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('transfer'),
      itemId: nonEmptyTextSchema,
      acknowledgeId: nonEmptyTextSchema.optional()
    })
    .strict(),
  z
    .object({
      mode: z.literal('progress'),
      itemId: nonEmptyTextSchema,
      candidateId: nonEmptyTextSchema
    })
    .strict(),
  z.object({ mode: z.literal('search'), itemId: nonEmptyTextSchema }).strict(),
  z
    .object({
      mode: z.literal('attach'),
      itemId: nonEmptyTextSchema,
      candidateId: nonEmptyTextSchema
    })
    .strict()
])

export const createFullTextResultSchema = <T extends z.ZodType<DiscoveryReference>>(
  itemSchema: T
  // Zod must retain the inferred caller-specific output type.
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
) =>
  z.discriminatedUnion('mode', [
    z
      .object({
        mode: z.literal('transfer'),
        transfer: literatureFullTextTransferSchema.optional(),
        item: itemSchema.optional()
      })
      .strict(),
    z
      .object({
        mode: z.literal('attach-error'),
        reason: z.literal('rate-limited'),
        retryAt: z.number().finite().nonnegative()
      })
      .strict(),
    z
      .object({
        mode: z.literal('progress'),
        progress: literatureFullTextProgressSchema.optional()
      })
      .strict(),
    z
      .object({
        mode: z.literal('search'),
        candidates: z.array(literatureFullTextCandidateSchema).max(10),
        failures: z.array(literatureFailureSchema).max(10).optional(),
        notices: z.array(
          z.enum([
            'missing-identifiers',
            'openalex-not-configured',
            'europe-pmc-unavailable',
            'openalex-unavailable',
            'unpaywall-not-configured',
            'unpaywall-unavailable',
            'pmc-unavailable',
            'pmc-no-record'
          ])
        )
      })
      .strict(),
    z
      .object({
        mode: z.literal('attach'),
        item: itemSchema,
        transferId: nonEmptyTextSchema.optional()
      })
      .strict()
  ])
export type LiteratureFullTextCandidate = z.infer<typeof literatureFullTextCandidateSchema>
export type LiteratureFullTextRequest = z.infer<typeof literatureFullTextRequestSchema>
export const literatureFullTextResultSchema = createFullTextResultSchema(discoveryReferenceSchema)
type FullTextBase = z.infer<typeof literatureFullTextResultSchema>
export type LiteratureFullTextResult<Item extends DiscoveryReference = DiscoveryReference> =
  | Exclude<FullTextBase, { mode: 'attach' | 'transfer' }>
  | { mode: 'attach'; item: Item; transferId?: string }
  | { mode: 'transfer'; item?: Item; transfer?: LiteratureFullTextTransfer }
export const literatureMetadataCompletionResultSchema =
  createMetadataCompletionResultSchema(discoveryReferenceSchema)
export type LiteratureMetadataCompletionResult<
  Item extends DiscoveryReference = DiscoveryReference
> = Omit<z.infer<typeof literatureMetadataCompletionResultSchema>, 'item'> & { item: Item }
export type LiteratureMetadataCompletionRequest = z.infer<
  typeof literatureMetadataCompletionRequestSchema
>
export type LiteratureMetadataField = (typeof LITERATURE_METADATA_FIELDS)[number]
export type LiteratureMetadataValue = z.infer<typeof literatureMetadataValueSchema>
export type LiteratureMetadataConflict = z.infer<typeof literatureMetadataConflictSchema>
export type LiteratureSourceInput = z.infer<typeof literatureSourceInputSchema>

export * from './supplement-contracts.js'
