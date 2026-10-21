import { literatureItemInputSchema, type LiteratureItemInput } from './item.js'
import {
  JOURNAL_ATTRIBUTE_FILTER_MAX,
  journalAttributeFilterSchema
} from '@aipoch/journal-catalog/contracts'
import {
  LITERATURE_CITATION_LOCALES,
  LITERATURE_IMPORT_WARNINGS,
  LITERATURE_ITEM_TYPES,
  LITERATURE_RECORD_IMPORT_FORMATS,
  LITERATURE_RECORD_IMPORT_MAX_BYTES,
  LITERATURE_RECORD_IMPORT_MAX_RECORDS,
  literatureCitationStylesRequestSchema,
  literatureCitationStylesResultSchema,
  literatureIdentifierInputSchema
} from '@aipoch/literature-citations/contracts'
import {
  createFullTextResultSchema,
  createMetadataCompletionResultSchema
} from '@aipoch/literature-discovery/contracts'
import {
  smartCollectionCommandSchemas,
  smartCollectionPreviewSchema,
  smartCollectionRowSchema,
  smartCollectionViewSchema,
  smartEvidenceModeSchema,
  smartHistorySchema,
  smartRunProgressSchema,
  smartScopeSchema
} from '@aipoch/literature-screening/contracts'
import {
  SMART_RULE_STORAGE_MAX_LENGTH,
  serializedSmartRuleSchema
} from '@aipoch/literature-screening/rules'
import { z } from 'zod'

const LITERATURE_INBOX_STATES = ['pending', 'accepted', 'dismissed'] as const

export const LITERATURE_IMPORT_IDENTITY_CONFLICT =
  'Import contains conflicting identifiers. Keep separate copies or correct the source file.'

const LITERATURE_COLLECTION_NAME_CONFLICT = 'literature_collection_name_conflict'

const LITERATURE_COLLECTION_NAME_MAX_LENGTH = 200

const LITERATURE_COLLECTION_DESCRIPTION_MAX_LENGTH = 1_000

const LITERATURE_LIFECYCLE_STATES = ['active', 'deleted'] as const

const LITERATURE_SORT_FIELDS = ['updated', 'created', 'title', 'year', 'rating'] as const

const LITERATURE_SORT_DIRECTIONS = ['asc', 'desc'] as const

const LITERATURE_IMPORT_STATUSES = ['ready', 'warning', 'existing', 'conflict', 'invalid'] as const

const nonEmptyTextSchema = z.string().trim().min(1)

const optionalTextSchema = z.string().trim().optional()

const literatureFilterSchema = z
  .object({
    query: optionalTextSchema,
    tagIds: z.array(nonEmptyTextSchema).max(20).optional(),
    creator: optionalTextSchema,
    yearFrom: z.number().int().min(0).max(9999).optional(),
    yearTo: z.number().int().min(0).max(9999).optional(),
    containerTitle: optionalTextSchema,
    itemTypes: z.array(z.enum(LITERATURE_ITEM_TYPES)).max(LITERATURE_ITEM_TYPES.length).optional(),
    hasFullText: z.boolean().optional(),
    collectionId: optionalTextSchema,
    projectId: optionalTextSchema,
    journalAttributes: z
      .array(journalAttributeFilterSchema)
      .max(JOURNAL_ATTRIBUTE_FILTER_MAX)
      .optional()
  })
  .strict()
  .refine(
    ({ yearFrom, yearTo }) => yearFrom === undefined || yearTo === undefined || yearFrom <= yearTo,
    { message: 'The start year must not be after the end year.' }
  )

const literatureSourceInputSchema = z
  .object({
    provider: nonEmptyTextSchema,
    externalId: optionalTextSchema,
    sourceUrl: optionalTextSchema,
    rawMetadata: z.record(z.string(), z.unknown())
  })
  .strict()

// Current persisted metadata evidence, not an application history. savedAt is the legacy
// source-record write timestamp; it does not claim the time of network acquisition.
const literatureSourceRecordViewSchema = literatureSourceInputSchema.extend({
  id: nonEmptyTextSchema,
  savedAt: z.number().int().nonnegative()
})

type LiteratureSourceRecordView = z.infer<typeof literatureSourceRecordViewSchema>

const literatureCandidateOriginSchema = z
  .object({
    kind: nonEmptyTextSchema,
    projectId: optionalTextSchema,
    sessionId: optionalTextSchema
  })
  .strict()

const literatureCandidateInputSchema = z
  .object({
    item: literatureItemInputSchema,
    source: literatureSourceInputSchema,
    origin: literatureCandidateOriginSchema
  })
  .strict()

// A source-reported snapshot for these exact bytes, independent of bibliographic metadata.
export const literaturePdfProvenanceSchema = z
  .object({
    provider: nonEmptyTextSchema,
    source: nonEmptyTextSchema,
    sourceUrl: z.string().url(),
    acquiredAt: z.number().int().nonnegative(),
    version: z.enum(['published', 'accepted', 'submitted']).optional(),
    license: nonEmptyTextSchema.optional()
  })
  .strict()

export type LiteraturePdfProvenance = z.infer<typeof literaturePdfProvenanceSchema>

const literatureAttachmentVersionViewSchema = z
  .object({
    id: nonEmptyTextSchema,
    versionNumber: z.number().int().positive(),
    provenance: literaturePdfProvenanceSchema.optional(),
    filename: nonEmptyTextSchema,
    contentType: nonEmptyTextSchema,
    sizeBytes: z.number().int().nonnegative(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/u),
    pageCount: z.number().int().positive().optional(),
    availability: z.enum(['unknown', 'available', 'unavailable']).optional(),
    verificationFailure: z.string().optional(),
    verificationAttemptAt: z.number().int().nonnegative().optional(),
    createdAt: z.number().int().nonnegative()
  })
  .strict()

const literatureAttachmentViewSchema = z
  .object({
    id: nonEmptyTextSchema,
    kind: nonEmptyTextSchema,
    title: z.string(),
    sortOrder: z.number().int().nonnegative(),
    versions: z.array(literatureAttachmentVersionViewSchema),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict()

const literatureItemViewSchema = z
  .object({
    id: nonEmptyTextSchema,
    item: literatureItemInputSchema,
    attachments: z.array(literatureAttachmentViewSchema),
    projectIds: z.array(nonEmptyTextSchema),
    collectionIds: z.array(nonEmptyTextSchema),
    metadataRevision: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    deletedAt: z.number().int().nonnegative().optional(),
    smartDecision: smartCollectionRowSchema.optional(),
    mergedIntoItemId: nonEmptyTextSchema.optional()
  })
  .strict()

const literatureInboxCandidateViewSchema = z
  .object({
    id: nonEmptyTextSchema,
    state: z.enum(LITERATURE_INBOX_STATES),
    candidate: literatureCandidateInputSchema,
    discoveries: z
      .array(
        z
          .object({
            origin: literatureCandidateOriginSchema,
            createdAt: z.number().int().nonnegative()
          })
          .strict()
      )
      .optional(),
    pdfs: z
      .array(
        z
          .object({
            id: nonEmptyTextSchema,
            filename: nonEmptyTextSchema,
            sizeBytes: z.number().int().nonnegative(),
            pageCount: z.number().int().positive(),
            sourceUrl: z.string().url()
          })
          .strict()
      )
      .optional(),
    acceptedItemId: nonEmptyTextSchema.optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict()

const LITERATURE_COLLECTION_REVISION_CONFLICT = 'literature_collection_revision_conflict'

const literatureCollectionViewSchema = z
  .object({
    smart: z.boolean().optional(),
    smartScope: smartScopeSchema.optional(),
    smartEvidenceMode: smartEvidenceModeSchema.optional(),
    smartAutoUpdate: z.boolean().optional(),
    revision: z.number().int().positive(),
    id: nonEmptyTextSchema,
    name: nonEmptyTextSchema.max(LITERATURE_COLLECTION_NAME_MAX_LENGTH),
    description: z.string().max(SMART_RULE_STORAGE_MAX_LENGTH),
    parentId: nonEmptyTextSchema.optional(),
    itemCount: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict()

const literatureProjectCountViewSchema = z
  .object({
    projectId: nonEmptyTextSchema,
    itemCount: z.number().int().nonnegative()
  })
  .strict()

const literatureDuplicateGroupSchema = z
  .object({
    id: nonEmptyTextSchema,
    title: z.string(),
    itemIds: z.array(nonEmptyTextSchema).min(2),
    match: z.enum(['identifier', 'metadata'])
  })
  .strict()

export type LiteratureDuplicateGroup = z.infer<typeof literatureDuplicateGroupSchema>

const literatureCatalogSearchRequestSchema = z
  .object({
    scope: z.enum([
      'library',
      'inbox',
      'collections',
      'project-counts',
      'duplicates',
      'global-search'
    ]),
    refreshDuplicates: z.boolean().optional(),
    updatedAfter: z.number().int().nonnegative().optional(),
    searchSort: z.enum(['relevance', 'recent']).optional(),
    entryKind: z.enum(['paper', 'collection', 'pdf', 'note']).optional(),
    allItemIds: z.boolean().optional(),
    countOnly: z.boolean().optional(),
    itemIds: z.array(nonEmptyTextSchema).max(200).optional(),
    query: optionalTextSchema,
    projectId: optionalTextSchema,
    collectionId: optionalTextSchema,
    smartFilter: z.enum(['match', 'review', 'no-match', 'pending']).optional(),
    smartDecisionSource: z.enum(['all', 'ai', 'manual']).optional(),
    parentId: optionalTextSchema,
    itemId: optionalTextSchema,
    inboxState: z.enum(LITERATURE_INBOX_STATES).optional(),
    lifecycle: z.enum(LITERATURE_LIFECYCLE_STATES).optional(),
    sortBy: z.enum(LITERATURE_SORT_FIELDS).optional(),
    sortDirection: z.enum(LITERATURE_SORT_DIRECTIONS).optional(),
    tagId: optionalTextSchema,
    filter: literatureFilterSchema.optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(100).optional()
  })
  .strict()
  .refine((request) => !request.allItemIds || request.scope === 'library', {
    message: 'Complete item membership is only available for the library.'
  })
  .refine((request) => request.itemIds === undefined || request.scope === 'library', {
    message: 'Selected item membership is only available for the library.'
  })
  .refine(
    (request) =>
      !request.countOnly ||
      ((request.scope === 'library' || request.scope === 'global-search') && !request.allItemIds),
    {
      message: 'Count-only queries require the library and cannot request item membership.'
    }
  )

export const literatureDuplicatePolicySchema = z.enum(['reuse', 'separate', 'fill-missing'])

export type LiteratureDuplicatePolicy = z.infer<typeof literatureDuplicatePolicySchema>

export const literatureMergeStrategySchema = z.enum([
  'conflict-free',
  'most-complete',
  'oldest',
  'newest'
])

export type LiteratureMergeStrategy = z.infer<typeof literatureMergeStrategySchema>

const mergeItemSnapshotSchema = z
  .object({
    id: nonEmptyTextSchema,
    metadataRevision: z.number().int().positive(),
    updatedAt: z.number()
  })
  .strict()

const mergeGroupPreviewSchema = z
  .object({
    survivorId: nonEmptyTextSchema,
    survivorTitle: z.string(),
    conflicts: z.boolean(),
    items: z.array(mergeItemSnapshotSchema).min(2).max(20)
  })
  .strict()

const literatureCatalogCommandSchema = z.discriminatedUnion('kind', [
  ...smartCollectionCommandSchemas,
  z
    .object({
      kind: z.literal('delete-attachment'),
      itemId: nonEmptyTextSchema,
      attachmentId: nonEmptyTextSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('verify-attachment'),
      itemId: nonEmptyTextSchema,
      versionId: nonEmptyTextSchema
    })
    .strict(),
  z
    .object({ kind: z.literal('stage-candidate'), candidate: literatureCandidateInputSchema })
    .strict(),
  z
    .object({
      kind: z.literal('create-item'),
      item: literatureItemInputSchema,
      duplicatePolicy: literatureDuplicatePolicySchema.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('merge-duplicates'),
      mode: z.enum(['preview', 'commit']),
      strategy: literatureMergeStrategySchema.optional(),
      expectedItems: z.array(mergeItemSnapshotSchema).max(400).optional(),
      groups: z.array(z.array(nonEmptyTextSchema).min(2).max(21)).min(1).max(20)
    })
    .strict(),
  z
    .object({
      kind: z.literal('update-item'),
      itemId: nonEmptyTextSchema,
      expectedMetadataRevision: z.number().int().positive(),
      item: literatureItemInputSchema
    })
    .strict(),
  z.object({ kind: z.literal('accept-candidate'), candidateId: nonEmptyTextSchema }).strict(),
  z.object({ kind: z.literal('dismiss-candidate'), candidateId: nonEmptyTextSchema }).strict(),
  z
    .object({
      kind: z.literal('settle-candidates'),
      candidateIds: z.array(nonEmptyTextSchema).min(1).max(100),
      state: z.enum(['accepted', 'dismissed'])
    })
    .strict()
    .refine(({ candidateIds }) => new Set(candidateIds).size === candidateIds.length, {
      message: 'Inbox candidate ids must be unique.',
      path: ['candidateIds']
    }),
  z
    .object({
      kind: z.literal('restore-candidates'),
      candidateIds: z.array(nonEmptyTextSchema).min(1).max(100)
    })
    .strict()
    .refine(({ candidateIds }) => new Set(candidateIds).size === candidateIds.length, {
      message: 'Inbox candidate ids must be unique.',
      path: ['candidateIds']
    }),
  z
    .object({
      kind: z.literal('create-collection'),
      name: nonEmptyTextSchema.max(LITERATURE_COLLECTION_NAME_MAX_LENGTH),
      description: z.string().trim().max(LITERATURE_COLLECTION_DESCRIPTION_MAX_LENGTH).optional(),
      parentId: nonEmptyTextSchema.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('update-collection'),
      smartScope: smartScopeSchema.optional(),
      smartEvidenceMode: smartEvidenceModeSchema.optional(),
      smartAutoUpdate: z.boolean().optional(),
      expectedRevision: z.number().int().positive(),
      collectionId: nonEmptyTextSchema,
      name: nonEmptyTextSchema.max(LITERATURE_COLLECTION_NAME_MAX_LENGTH),
      description: z.string().trim().max(SMART_RULE_STORAGE_MAX_LENGTH)
    })
    .strict()
    .refine(
      (value) =>
        serializedSmartRuleSchema.safeParse(value.description).success ||
        (!value.smartScope &&
          value.description.length <= LITERATURE_COLLECTION_DESCRIPTION_MAX_LENGTH),
      { path: ['description'], message: 'Invalid collection description.' }
    ),
  z
    .object({
      kind: z.literal('delete-collection'),
      collectionId: nonEmptyTextSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('set-collection-item'),
      collectionId: nonEmptyTextSchema,
      itemId: nonEmptyTextSchema,
      included: z.boolean()
    })
    .strict(),
  z
    .object({
      kind: z.literal('set-project-item'),
      projectId: nonEmptyTextSchema,
      itemId: nonEmptyTextSchema,
      included: z.boolean(),
      source: nonEmptyTextSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('set-project-items'),
      projectId: nonEmptyTextSchema,
      itemIds: z.array(nonEmptyTextSchema).min(1).max(200),
      included: z.boolean(),
      source: nonEmptyTextSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('set-item-lifecycle'),
      itemIds: z.array(nonEmptyTextSchema).min(1).max(200),
      state: z.enum(LITERATURE_LIFECYCLE_STATES)
    })
    .strict(),
  z
    .object({
      kind: z.literal('delete-items-permanently'),
      itemIds: z.array(nonEmptyTextSchema).min(1).max(200)
    })
    .strict(),
  z
    .object({
      kind: z.literal('move-collection-items'),
      itemIds: z.array(nonEmptyTextSchema).min(1).max(200),
      targetCollectionId: nonEmptyTextSchema,
      sourceCollectionId: nonEmptyTextSchema.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('merge-items'),
      expectedItems: z.array(mergeItemSnapshotSchema).min(2).max(20),
      survivorId: nonEmptyTextSchema,
      duplicateIds: z.array(nonEmptyTextSchema).min(1).max(19),
      expectedMetadataRevision: z.number().int().positive(),
      item: literatureItemInputSchema
    })
    .strict()
])

const literatureCatalogReceiptSchema = z
  .object({
    smartHistory: smartHistorySchema.optional(),
    smartRunProgress: smartRunProgressSchema.optional(),
    smart: smartCollectionViewSchema.optional(),
    smartPreview: smartCollectionPreviewSchema.optional(),
    smartRefreshFailed: z.boolean().optional(),
    smartDecisions: z.array(smartCollectionRowSchema).max(100).optional(),
    smartDecisionBatch: z
      .object({ saved: z.array(z.string()).max(100), failed: z.array(z.string()).max(100) })
      .strict()
      .optional(),
    cleanupPending: z.boolean().optional(),
    kind: z.enum(['candidate', 'collection', 'item']),
    id: nonEmptyTextSchema,
    state: z
      .enum([
        ...LITERATURE_INBOX_STATES,
        ...LITERATURE_LIFECYCLE_STATES,
        'present',
        'linked',
        'unlinked',
        'merged',
        'deleted-permanently'
      ])
      .optional(),
    count: z.number().int().positive().optional(),
    batch: z
      .object({
        eligible: z.number().int().nonnegative(),
        reduced: z.number().int().nonnegative(),
        review: z.number().int().nonnegative(),
        succeeded: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        groups: z.array(mergeGroupPreviewSchema).max(20).optional(),
        details: z
          .array(
            z
              .object({
                groupIndex: z.number().int().nonnegative(),
                title: z.string().optional(),
                status: z.enum(['ready', 'merged', 'skipped', 'failed']),
                reason: z
                  .enum([
                    'too-large',
                    'overlapping',
                    'unavailable',
                    'changed',
                    'identity',
                    'conflicts',
                    'failed'
                  ])
                  .optional()
              })
              .strict()
          )
          .max(20)
          .optional()
      })
      .strict()
      .optional()
  })
  .strict()

const literaturePdfImportReceiptSchema = z
  .object({
    item: literatureItemViewSchema,
    nativeAnnotations: z
      .object({
        importedCount: z.number().int().nonnegative(),
        unsupportedCount: z.number().int().nonnegative(),
        truncated: z.boolean()
      })
      .optional()
  })
  .strict()

const literaturePdfCancelImportRequestSchema = z
  .object({ operationId: nonEmptyTextSchema })
  .strict()

const literatureFormatReferencesRequestSchema = z
  .object({
    itemIds: z.array(nonEmptyTextSchema).min(1).max(200),
    styleId: nonEmptyTextSchema.max(200),
    locale: z.enum(LITERATURE_CITATION_LOCALES)
  })
  .strict()

const literatureFormattedReferenceSchema = z
  .object({
    itemId: nonEmptyTextSchema,
    reference: nonEmptyTextSchema,
    inText: nonEmptyTextSchema
  })
  .strict()

const literatureFormatReferencesResultSchema = z
  .object({
    references: z.array(literatureFormattedReferenceSchema),
    exports: z.object({ bibtex: nonEmptyTextSchema, ris: nonEmptyTextSchema }).strict()
  })
  .strict()

const literatureFormatDocumentRequestSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('preview'),
      projectId: nonEmptyTextSchema,
      sessionId: nonEmptyTextSchema,
      artifactId: nonEmptyTextSchema,
      versionId: nonEmptyTextSchema,
      styleId: nonEmptyTextSchema.max(200),
      locale: z.enum(LITERATURE_CITATION_LOCALES)
    })
    .strict(),
  z
    .object({
      mode: z.literal('save'),
      projectId: nonEmptyTextSchema,
      sessionId: nonEmptyTextSchema,
      artifactId: nonEmptyTextSchema,
      versionId: nonEmptyTextSchema,
      expectedHeadVersionId: nonEmptyTextSchema,
      operationId: nonEmptyTextSchema,
      styleId: nonEmptyTextSchema.max(200),
      locale: z.enum(LITERATURE_CITATION_LOCALES)
    })
    .strict()
])

const literatureFormatDocumentResultSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('preview'),
      references: z.array(literatureFormattedReferenceSchema).min(1).max(200)
    })
    .strict(),
  z
    .object({
      mode: z.literal('save'),
      versionId: nonEmptyTextSchema,
      versionNumber: z.number().int().positive()
    })
    .strict()
])

// Indices in parsed items, not error rows; omission preserves whole-file imports.
const literatureImportSelectionSchema = z
  .array(z.number().int().nonnegative())
  .min(1)
  .max(LITERATURE_RECORD_IMPORT_MAX_RECORDS)
  .refine(
    (indexes) => new Set(indexes).size === indexes.length,
    'Import selection contains duplicate indices.'
  )

const literatureRecordImportRequestSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('preview'),
      content: z.string().min(1).max(LITERATURE_RECORD_IMPORT_MAX_BYTES),
      selectedItemIndexes: literatureImportSelectionSchema.optional()
    })
    .strict(),
  z
    .object({
      mode: z.literal('commit'),
      content: z.string().min(1).max(LITERATURE_RECORD_IMPORT_MAX_BYTES),
      selectedItemIndexes: literatureImportSelectionSchema.optional(),
      duplicatePolicy: literatureDuplicatePolicySchema.optional(),
      collectionId: nonEmptyTextSchema.optional()
    })
    .strict()
])

const literatureRecordImportErrorSchema = z
  .object({ preview: z.string(), error: nonEmptyTextSchema })
  .strict()

const literatureRecordImportEntrySchema = z
  .object({
    index: z.number().int().nonnegative(),
    title: z.string(),
    status: z.enum(LITERATURE_IMPORT_STATUSES),
    warnings: z.array(z.enum(LITERATURE_IMPORT_WARNINGS)),
    item: literatureItemInputSchema.optional(),
    existingItemId: nonEmptyTextSchema.optional(),
    conflict: z
      .object({
        identifiers: z.array(literatureIdentifierInputSchema),
        matches: z.array(
          z
            .object({
              itemId: nonEmptyTextSchema.optional(),
              inputIndex: z.number().int().nonnegative().optional(),
              title: z.string()
            })
            .strict()
        )
      })
      .strict()
      .optional(),
    error: nonEmptyTextSchema.optional()
  })
  .strict()

const literatureRecordImportReceiptSchema = z
  .object({
    itemIds: z.array(nonEmptyTextSchema).max(LITERATURE_RECORD_IMPORT_MAX_RECORDS),
    createdCount: z.number().int().nonnegative(),
    reusedCount: z.number().int().nonnegative()
  })
  .strict()

const literatureRecordImportResultSchema = z
  .object({
    format: z.enum(LITERATURE_RECORD_IMPORT_FORMATS),
    items: z.array(literatureItemInputSchema).max(LITERATURE_RECORD_IMPORT_MAX_RECORDS),
    entries: z
      .array(literatureRecordImportEntrySchema)
      .max(LITERATURE_RECORD_IMPORT_MAX_RECORDS * 2),
    errors: z.array(literatureRecordImportErrorSchema),
    truncated: z.boolean(),
    scannedEntries: z.number().int().nonnegative(),
    imported: literatureRecordImportReceiptSchema.optional()
  })
  .strict()

const literatureMetadataCompletionResultSchema = createMetadataCompletionResultSchema(
  literatureItemViewSchema
).extend({
  proposal: literatureItemInputSchema.extend({ title: z.string() }).optional()
})

const literatureFullTextResultSchema = createFullTextResultSchema(literatureItemViewSchema)

type LiteratureFullTextResult = z.infer<typeof literatureFullTextResultSchema>

type LiteratureInboxState = (typeof LITERATURE_INBOX_STATES)[number]

type LiteratureSourceInput = z.infer<typeof literatureSourceInputSchema>

type LiteratureCandidateOrigin = z.infer<typeof literatureCandidateOriginSchema>

type LiteratureCandidateInput = z.infer<typeof literatureCandidateInputSchema>

type LiteratureAttachmentVersionView = z.infer<typeof literatureAttachmentVersionViewSchema>

type LiteratureAttachmentView = z.infer<typeof literatureAttachmentViewSchema>

type LiteratureItemView = z.infer<typeof literatureItemViewSchema>

type LiteratureInboxCandidateView = z.infer<typeof literatureInboxCandidateViewSchema>

type LiteratureCollectionView = z.infer<typeof literatureCollectionViewSchema>

type LiteratureProjectCountView = z.infer<typeof literatureProjectCountViewSchema>

type LiteratureFilter = z.infer<typeof literatureFilterSchema>

type LiteratureCatalogSearchRequest = z.infer<typeof literatureCatalogSearchRequestSchema>

type LiteratureCatalogCommand = z.infer<typeof literatureCatalogCommandSchema>

type LiteratureCatalogReceipt = z.infer<typeof literatureCatalogReceiptSchema>

type LiteraturePdfImportReceipt = z.infer<typeof literaturePdfImportReceiptSchema>

type LiteraturePdfCancelImportRequest = z.infer<typeof literaturePdfCancelImportRequestSchema>

type LiteratureCitationStylesRequest = z.infer<typeof literatureCitationStylesRequestSchema>

type LiteratureCitationStylesResult = z.infer<typeof literatureCitationStylesResultSchema>

type LiteratureFormatReferencesRequest = z.infer<typeof literatureFormatReferencesRequestSchema>

type LiteratureFormattedReference = z.infer<typeof literatureFormattedReferenceSchema>

type LiteratureFormatReferencesResult = z.infer<typeof literatureFormatReferencesResultSchema>

type LiteratureFormatDocumentRequest = z.infer<typeof literatureFormatDocumentRequestSchema>

type LiteratureFormatDocumentResult = z.infer<typeof literatureFormatDocumentResultSchema>

type LiteratureRecordImportRequest = z.infer<typeof literatureRecordImportRequestSchema>

type LiteratureRecordImportError = z.infer<typeof literatureRecordImportErrorSchema>

type LiteratureRecordImportEntry = z.infer<typeof literatureRecordImportEntrySchema>

type LiteratureRecordImportReceipt = z.infer<typeof literatureRecordImportReceiptSchema>

type LiteratureRecordImportResult = z.infer<typeof literatureRecordImportResultSchema>

type LiteratureMetadataCompletionResult = z.infer<typeof literatureMetadataCompletionResultSchema>

// Invalidation hints only; clients re-read authoritative records rather than applying event content.
export type LiteratureChangedEvent = Readonly<{
  revision: number
  itemIds?: readonly string[]
  collectionIds?: readonly string[]
  candidateIds?: readonly string[]
}>

// Provider names are product identifiers, shared by the single and batch review surfaces.
export const literatureMetadataProviderLabel = (provider: string): string =>
  ({ crossref: 'Crossref', pubmed: 'PubMed', 'europe-pmc': 'Europe PMC', datacite: 'DataCite' })[
    provider
  ] ?? provider
export {
  LITERATURE_COLLECTION_DESCRIPTION_MAX_LENGTH,
  LITERATURE_COLLECTION_NAME_CONFLICT,
  LITERATURE_COLLECTION_NAME_MAX_LENGTH,
  LITERATURE_COLLECTION_REVISION_CONFLICT,
  LITERATURE_INBOX_STATES,
  LITERATURE_LIFECYCLE_STATES,
  LITERATURE_SORT_FIELDS,
  literatureAttachmentVersionViewSchema,
  literatureAttachmentViewSchema,
  literatureCandidateInputSchema,
  literatureCandidateOriginSchema,
  literatureCatalogCommandSchema,
  literatureCatalogReceiptSchema,
  literatureCatalogSearchRequestSchema,
  literatureCitationStylesRequestSchema,
  literatureCitationStylesResultSchema,
  literatureCollectionViewSchema,
  literatureFilterSchema,
  literatureFormatDocumentRequestSchema,
  literatureFormatDocumentResultSchema,
  literatureFormatReferencesRequestSchema,
  literatureFormatReferencesResultSchema,
  literatureFormattedReferenceSchema,
  literatureInboxCandidateViewSchema,
  literatureItemInputSchema,
  literatureItemViewSchema,
  literatureMetadataCompletionResultSchema,
  literaturePdfCancelImportRequestSchema,
  literaturePdfImportReceiptSchema,
  literatureRecordImportEntrySchema,
  literatureRecordImportErrorSchema,
  literatureRecordImportReceiptSchema,
  literatureRecordImportRequestSchema,
  literatureRecordImportResultSchema,
  literatureSourceInputSchema
}
export type {
  LiteratureAttachmentVersionView,
  LiteratureAttachmentView,
  LiteratureCandidateInput,
  LiteratureCandidateOrigin,
  LiteratureCatalogCommand,
  LiteratureCatalogReceipt,
  LiteratureCatalogSearchRequest,
  LiteratureCitationStylesRequest,
  LiteratureCitationStylesResult,
  LiteratureCollectionView,
  LiteratureFilter,
  LiteratureFormatDocumentRequest,
  LiteratureFormatDocumentResult,
  LiteratureFormatReferencesRequest,
  LiteratureFormatReferencesResult,
  LiteratureFormattedReference,
  LiteratureFullTextResult,
  LiteratureInboxCandidateView,
  LiteratureInboxState,
  LiteratureItemInput,
  LiteratureItemView,
  LiteratureMetadataCompletionResult,
  LiteraturePdfCancelImportRequest,
  LiteraturePdfImportReceipt,
  LiteratureProjectCountView,
  LiteratureRecordImportEntry,
  LiteratureRecordImportError,
  LiteratureRecordImportReceipt,
  LiteratureRecordImportRequest,
  LiteratureRecordImportResult,
  LiteratureSourceInput,
  LiteratureSourceRecordView
}

export {
  literatureDuplicateGroupSchema,
  literatureFullTextResultSchema,
  literatureProjectCountViewSchema,
  literatureSourceRecordViewSchema
}
