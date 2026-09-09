import { z } from 'zod'

import { defineApplicationCommandContract, validationCodec } from './application-command-contract'
import { uploadedAttachmentSchema, type UploadedAttachment } from './uploads'

const LITERATURE_ITEM_TYPES = [
  'journalArticle',
  'review',
  'preprint',
  'conferencePaper',
  'book',
  'bookSection',
  'thesis',
  'report',
  'dataset',
  'standard',
  'patent',
  'webpage',
  'document'
] as const

const LITERATURE_IDENTITY_SCHEMES = ['doi', 'pmid', 'pmcid', 'arxiv'] as const
const LITERATURE_IDENTIFIER_SCHEMES = [
  ...LITERATURE_IDENTITY_SCHEMES,
  'isbn',
  'issn',
  'other'
] as const
const LITERATURE_INBOX_STATES = ['pending', 'accepted', 'dismissed'] as const
const LITERATURE_CITATION_STYLES = [
  'apa',
  'mla',
  'chicago-author-date',
  'vancouver',
  'ieee',
  'nature',
  'american-medical-association',
  'harvard-cite-them-right'
] as const
const LITERATURE_CITATION_LOCALES = ['en-US', 'zh-CN'] as const
const LITERATURE_CSL_MAX_BYTES = 1024 * 1024
const LITERATURE_RECORD_IMPORT_FORMATS = ['bibtex', 'ris', 'nbib'] as const
const LITERATURE_RECORD_IMPORT_MAX_BYTES = 32 * 1024 * 1024
const LITERATURE_RECORD_IMPORT_MAX_RECORDS = 1_000
export const LITERATURE_IMPORT_IDENTITY_CONFLICT =
  'Import contains conflicting identifiers. Keep separate copies or correct the source file.'
const LITERATURE_COLLECTION_NAME_CONFLICT = 'literature_collection_name_conflict'
const LITERATURE_COLLECTION_NAME_MAX_LENGTH = 200
const LITERATURE_COLLECTION_DESCRIPTION_MAX_LENGTH = 1_000
const LITERATURE_LIFECYCLE_STATES = ['active', 'deleted'] as const
const LITERATURE_SORT_FIELDS = ['updated', 'created', 'title', 'year', 'rating'] as const
const LITERATURE_SORT_DIRECTIONS = ['asc', 'desc'] as const
const LITERATURE_IMPORT_STATUSES = ['ready', 'warning', 'existing', 'conflict', 'invalid'] as const
const LITERATURE_IMPORT_WARNINGS = [
  'missing-authors',
  'missing-year',
  'missing-container-title',
  'uncertain-author-name'
] as const
const LITERATURE_METADATA_FIELDS = [
  'title',
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
const LITERATURE_METADATA_PROVIDERS = ['crossref', 'pubmed'] as const
const LITERATURE_ATTACHMENT_VERSION_REFERENCE_PREFIX = 'literature-attachment-version:'

type LiteratureIdentifierScheme = (typeof LITERATURE_IDENTIFIER_SCHEMES)[number]

const normalizeLiteratureIdentifierValue = (
  scheme: LiteratureIdentifierScheme,
  value: string
): string => {
  const trimmed = value.trim()
  if (scheme === 'doi') {
    return trimmed
      .replace(/^doi:\s*/iu, '')
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
      .replace(/Copyright(?:\s.*)?$/iu, '')
      .replace(/[.,;:)}\]]+$/gu, '')
      .trim()
  }
  if (scheme === 'pmid') {
    const candidate = trimmed.replace(/^PMID\s*:\s*/iu, '')
    return (
      /^https?:\/\/(?:www\.)?pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)\/?(?:[?#].*)?$/iu.exec(
        candidate
      )?.[1] ?? candidate
    )
  }
  if (scheme === 'pmcid') {
    const candidate = trimmed.replace(/^PMCID\s*:\s*/iu, '')
    const fromUrl =
      /^https?:\/\/(?:pmc\.ncbi\.nlm\.nih\.gov\/articles\/(PMC\d+)|(?:www\.)?ncbi\.nlm\.nih\.gov\/pmc\/articles\/(PMC\d+))\/?(?:[?#].*)?$/iu.exec(
        candidate
      )
    const valueWithoutUrl = fromUrl?.[1] ?? fromUrl?.[2] ?? candidate
    const digits = /^(?:PMC)?(\d+)$/iu.exec(valueWithoutUrl)?.[1]
    return digits ? `PMC${digits}` : valueWithoutUrl.toUpperCase()
  }
  if (scheme === 'arxiv') {
    return trimmed
      .replace(/^arxiv:\s*/iu, '')
      .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//iu, '')
      .replace(/[?#].*$/u, '')
      .replace(/\.pdf$/iu, '')
      .replace(/v\d+$/iu, '')
      .trim()
  }
  return trimmed
}

const createLiteratureIdentifierUrl = (
  scheme: LiteratureIdentifierScheme,
  value: string
): string | undefined => {
  const normalized = normalizeLiteratureIdentifierValue(scheme, value)
  if (scheme === 'doi' && /^10\.\d{4,9}\/\S+$/u.test(normalized)) {
    const encoded = normalized.split('/').map(encodeURIComponent).join('/')
    return `https://doi.org/${encoded}`
  }
  if (scheme === 'pmid' && /^\d+$/u.test(normalized)) {
    return `https://pubmed.ncbi.nlm.nih.gov/${normalized}/`
  }
  if (scheme === 'pmcid' && /^PMC\d+$/u.test(normalized)) {
    return `https://pmc.ncbi.nlm.nih.gov/articles/${normalized}/`
  }
  if (scheme === 'arxiv' && /^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})$/iu.test(normalized)) {
    const encoded = normalized.split('/').map(encodeURIComponent).join('/')
    return `https://arxiv.org/abs/${encoded}`
  }
  return undefined
}

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
    projectId: optionalTextSchema
  })
  .strict()
  .refine(
    ({ yearFrom, yearTo }) => yearFrom === undefined || yearTo === undefined || yearFrom <= yearTo,
    { message: 'The start year must not be after the end year.' }
  )

const literaturePersonCreatorSchema = z
  .object({
    nameMode: z.literal('person'),
    givenName: z.string().trim().default(''),
    familyName: z.string().trim().default(''),
    creatorType: nonEmptyTextSchema
  })
  .refine(({ familyName, givenName }) => familyName.length > 0 || givenName.length > 0, {
    message: 'A person creator requires a given or family name.'
  })

const literatureOrganizationCreatorSchema = z
  .object({
    nameMode: z.literal('organization'),
    literalName: nonEmptyTextSchema,
    creatorType: nonEmptyTextSchema
  })
  .strict()

const literatureCreatorInputSchema = z.discriminatedUnion('nameMode', [
  literaturePersonCreatorSchema,
  literatureOrganizationCreatorSchema
])

const literatureIdentifierInputSchema = z
  .object({
    scheme: z.enum(LITERATURE_IDENTIFIER_SCHEMES),
    value: nonEmptyTextSchema,
    isPrimary: z.boolean().default(false)
  })
  .strict()
  .transform((identifier) => ({
    ...identifier,
    value: normalizeLiteratureIdentifierValue(identifier.scheme, identifier.value)
  }))
  .refine(({ value }) => value.length > 0, { message: 'Literature identifier is empty.' })

const literatureItemInputSchema = z
  .object({
    itemType: z.enum(LITERATURE_ITEM_TYPES),
    title: nonEmptyTextSchema,
    abstract: z.string().trim().default(''),
    issuedText: z.string().trim().default(''),
    issuedYear: z.number().int().min(0).max(9999).optional(),
    containerTitle: z.string().trim().default(''),
    shortTitle: z.string().trim().default(''),
    language: z.string().trim().default(''),
    rights: z.string().trim().default(''),
    url: z.string().trim().default(''),
    accessedAt: z.number().int().nonnegative().optional(),
    citationKey: optionalTextSchema,
    extra: z.string().default(''),
    rating: z.number().int().min(0).max(5).optional(),
    personalNote: z.string().trim().max(10_000).optional(),
    typeFields: z.record(z.string(), z.unknown()).default({}),
    creators: z.array(literatureCreatorInputSchema).default([]),
    identifiers: z.array(literatureIdentifierInputSchema).default([])
  })
  .strict()

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

const literatureCollectionViewSchema = z
  .object({
    id: nonEmptyTextSchema,
    name: nonEmptyTextSchema.max(LITERATURE_COLLECTION_NAME_MAX_LENGTH),
    description: z.string().max(LITERATURE_COLLECTION_DESCRIPTION_MAX_LENGTH),
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
    scope: z.enum(['library', 'inbox', 'collections', 'project-counts', 'duplicates']),
    refreshDuplicates: z.boolean().optional(),
    allItemIds: z.boolean().optional(),
    countOnly: z.boolean().optional(),
    itemIds: z.array(nonEmptyTextSchema).max(200).optional(),
    query: optionalTextSchema,
    projectId: optionalTextSchema,
    collectionId: optionalTextSchema,
    parentId: optionalTextSchema,
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
  .refine((request) => !request.countOnly || (request.scope === 'library' && !request.allItemIds), {
    message: 'Count-only queries require the library and cannot request item membership.'
  })

const literatureCatalogSearchPageSchema = z
  .object({
    entries: z.array(
      z.union([
        literatureItemViewSchema,
        literatureInboxCandidateViewSchema,
        literatureCollectionViewSchema,
        literatureProjectCountViewSchema,
        literatureDuplicateGroupSchema
      ])
    ),
    itemIds: z.array(nonEmptyTextSchema).optional(),
    totalCount: z.number().int().nonnegative().optional(),
    nextOffset: z.number().int().nonnegative().optional()
  })
  .strict()

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
      collectionId: nonEmptyTextSchema,
      name: nonEmptyTextSchema.max(LITERATURE_COLLECTION_NAME_MAX_LENGTH),
      description: z.string().trim().max(LITERATURE_COLLECTION_DESCRIPTION_MAX_LENGTH)
    })
    .strict(),
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

const literaturePdfImportRequestSchema = z
  .object({
    itemId: nonEmptyTextSchema,
    attachment: uploadedAttachmentSchema
  })
  .strict()

const literaturePdfImportReceiptSchema = z.object({ item: literatureItemViewSchema }).strict()

const literatureFormatReferencesRequestSchema = z
  .object({
    itemIds: z.array(nonEmptyTextSchema).min(1).max(200),
    styleId: nonEmptyTextSchema.max(200),
    locale: z.enum(LITERATURE_CITATION_LOCALES)
  })
  .strict()

const literatureCitationStylePreviewSchema = z
  .object({ inText: nonEmptyTextSchema, reference: nonEmptyTextSchema })
  .strict()

const literatureCitationStyleViewSchema = z
  .object({
    id: nonEmptyTextSchema,
    title: nonEmptyTextSchema,
    source: z.enum(['built-in', 'custom']),
    summary: optionalTextSchema,
    rights: optionalTextSchema,
    preview: literatureCitationStylePreviewSchema.optional()
  })
  .strict()

const literatureCitationStylesRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list') }).strict(),
  z
    .object({ kind: z.literal('import'), content: z.string().min(1).max(LITERATURE_CSL_MAX_BYTES) })
    .strict(),
  z.object({ kind: z.literal('delete'), styleId: nonEmptyTextSchema }).strict(),
  z.object({ kind: z.literal('preview'), styleId: nonEmptyTextSchema }).strict()
])

const literatureCitationStylesResultSchema = z
  .object({
    styles: z.array(literatureCitationStyleViewSchema),
    changedStyleId: nonEmptyTextSchema.optional(),
    preview: literatureCitationStylePreviewSchema
      .extend({ styleId: nonEmptyTextSchema })
      .strict()
      .optional()
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

const literatureRecordImportRequestSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('preview'),
      content: z.string().min(1).max(LITERATURE_RECORD_IMPORT_MAX_BYTES)
    })
    .strict(),
  z
    .object({
      mode: z.literal('commit'),
      content: z.string().min(1).max(LITERATURE_RECORD_IMPORT_MAX_BYTES),
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

const literatureMetadataCompletionRequestSchema = z.discriminatedUnion('mode', [
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

const literatureMetadataValueSchema = z
  .object({ field: z.enum(LITERATURE_METADATA_FIELDS), value: nonEmptyTextSchema })
  .strict()

const literatureMetadataConflictSchema = literatureMetadataValueSchema
  .extend({ currentValue: nonEmptyTextSchema })
  .strict()

const literatureMetadataCompletionResultSchema = z
  .object({
    mode: z.enum(['preview', 'commit']),
    provider: z.enum(LITERATURE_METADATA_PROVIDERS),
    sourceUrl: nonEmptyTextSchema,
    item: literatureItemViewSchema,
    filled: z.array(literatureMetadataValueSchema),
    conflicts: z.array(literatureMetadataConflictSchema),
    reviewToken: z.string().uuid().optional(),
    reviewVersion: z.literal(1).optional(),
    source: literatureSourceInputSchema.optional()
  })
  .strict()

const literatureFullTextCandidateSchema = z
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
const literatureFullTextProgressSchema = z
  .object({
    receivedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().positive().optional(),
    bytesPerSecond: z.number().nonnegative(),
    phase: z.enum(['downloading', 'saving'])
  })
  .strict()
export type LiteratureFullTextProgress = z.infer<typeof literatureFullTextProgressSchema>

const literatureFullTextTransferSchema = z
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

const literatureFullTextRequestSchema = z.discriminatedUnion('mode', [
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
const literatureFullTextResultSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('transfer'),
      transfer: literatureFullTextTransferSchema.optional(),
      item: literatureItemViewSchema.optional()
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
    .object({ mode: z.literal('progress'), progress: literatureFullTextProgressSchema.optional() })
    .strict(),
  z
    .object({
      mode: z.literal('search'),
      candidates: z.array(literatureFullTextCandidateSchema).max(10),
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
      item: literatureItemViewSchema,
      transferId: nonEmptyTextSchema.optional()
    })
    .strict()
])
type LiteratureFullTextCandidate = z.infer<typeof literatureFullTextCandidateSchema>
type LiteratureFullTextRequest = z.infer<typeof literatureFullTextRequestSchema>
type LiteratureFullTextResult = z.infer<typeof literatureFullTextResultSchema>

const literatureApplicationCommandContracts = Object.freeze({
  fullText: defineApplicationCommandContract(
    validationCodec(z.tuple([literatureFullTextRequestSchema])),
    validationCodec(literatureFullTextResultSchema)
  ),
  search: defineApplicationCommandContract(
    validationCodec(z.tuple([literatureCatalogSearchRequestSchema])),
    validationCodec(literatureCatalogSearchPageSchema)
  ),
  sources: defineApplicationCommandContract(
    validationCodec(z.tuple([nonEmptyTextSchema])),
    validationCodec(z.array(literatureSourceRecordViewSchema))
  ),
  get: defineApplicationCommandContract(
    validationCodec(z.tuple([nonEmptyTextSchema])),
    validationCodec(literatureItemViewSchema.optional())
  ),
  formatReferences: defineApplicationCommandContract(
    validationCodec(z.tuple([literatureFormatReferencesRequestSchema])),
    validationCodec(literatureFormatReferencesResultSchema)
  ),
  formatDocument: defineApplicationCommandContract(
    validationCodec(z.tuple([literatureFormatDocumentRequestSchema])),
    validationCodec(literatureFormatDocumentResultSchema)
  ),
  citationStyles: defineApplicationCommandContract(
    validationCodec(z.tuple([literatureCitationStylesRequestSchema])),
    validationCodec(literatureCitationStylesResultSchema)
  ),
  lookupMetadata: defineApplicationCommandContract(
    validationCodec(
      z.tuple([
        z
          .string()
          .trim()
          .min(1)
          .max(2048)
          .regex(/^10\.\d{4,9}\/\S+$/u)
      ])
    ),
    validationCodec(literatureItemInputSchema)
  ),
  completeMetadata: defineApplicationCommandContract(
    validationCodec(z.tuple([literatureMetadataCompletionRequestSchema])),
    validationCodec(literatureMetadataCompletionResultSchema)
  ),
  importRecords: defineApplicationCommandContract(
    validationCodec(z.tuple([literatureRecordImportRequestSchema])),
    validationCodec(literatureRecordImportResultSchema)
  ),
  importPdf: defineApplicationCommandContract(
    validationCodec(z.tuple([literaturePdfImportRequestSchema])),
    validationCodec(literaturePdfImportReceiptSchema)
  ),
  transact: defineApplicationCommandContract(
    validationCodec(z.tuple([literatureCatalogCommandSchema])),
    validationCodec(literatureCatalogReceiptSchema)
  )
})

type LiteratureItemType = z.infer<typeof literatureItemInputSchema>['itemType']
type LiteratureIdentityScheme = (typeof LITERATURE_IDENTITY_SCHEMES)[number]
type LiteratureInboxState = (typeof LITERATURE_INBOX_STATES)[number]
type LiteratureCreatorInput = z.infer<typeof literatureCreatorInputSchema>
type LiteratureIdentifierInput = z.infer<typeof literatureIdentifierInputSchema>
// A preferred identifier is scoped to its scheme. Legacy ties use normalized value order.
export function preferredLiteratureIdentifier(
  identifiers: readonly LiteratureIdentifierInput[],
  scheme: LiteratureIdentifierScheme
): LiteratureIdentifierInput | undefined {
  return identifiers
    .filter((identifier) => identifier.scheme === scheme)
    .sort((a, b) => {
      const priority = Number(b.isPrimary) - Number(a.isPrimary)
      const left = normalizeLiteratureIdentifierValue(scheme, a.value).toLowerCase()
      const right = normalizeLiteratureIdentifierValue(scheme, b.value).toLowerCase()
      return (
        priority ||
        (left < right ? -1 : left > right ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0)
      )
    })[0]
}

export function normalizeLiteratureIdentifierPreferences<T extends LiteratureIdentifierInput>(
  identifiers: readonly T[]
): T[] {
  const preferred = new Map(
    [...new Set(identifiers.map(({ scheme }) => scheme))].map((scheme) => [
      scheme,
      preferredLiteratureIdentifier(identifiers, scheme)
    ])
  )
  return identifiers.map((identifier) => ({
    ...identifier,
    isPrimary: identifier.isPrimary && preferred.get(identifier.scheme) === identifier
  }))
}

type LiteratureItemInput = z.infer<typeof literatureItemInputSchema>
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
type LiteratureCatalogSearchPage = z.infer<typeof literatureCatalogSearchPageSchema>
type LiteratureCatalogCommand = z.infer<typeof literatureCatalogCommandSchema>
type LiteratureCatalogReceipt = z.infer<typeof literatureCatalogReceiptSchema>
type LiteraturePdfImportRequest = Readonly<{ itemId: string; attachment: UploadedAttachment }>
type LiteraturePdfImportReceipt = z.infer<typeof literaturePdfImportReceiptSchema>
type LiteratureCitationStyle = string
type LiteratureCitationLocale = (typeof LITERATURE_CITATION_LOCALES)[number]
type LiteratureCitationStyleView = z.infer<typeof literatureCitationStyleViewSchema>
type LiteratureCitationStylesRequest = z.infer<typeof literatureCitationStylesRequestSchema>
type LiteratureCitationStylesResult = z.infer<typeof literatureCitationStylesResultSchema>
type LiteratureFormatReferencesRequest = z.infer<typeof literatureFormatReferencesRequestSchema>
type LiteratureFormattedReference = z.infer<typeof literatureFormattedReferenceSchema>
type LiteratureFormatReferencesResult = z.infer<typeof literatureFormatReferencesResultSchema>
type LiteratureFormatDocumentRequest = z.infer<typeof literatureFormatDocumentRequestSchema>
type LiteratureFormatDocumentResult = z.infer<typeof literatureFormatDocumentResultSchema>
type LiteratureRecordImportFormat = (typeof LITERATURE_RECORD_IMPORT_FORMATS)[number]
type LiteratureRecordImportRequest = z.infer<typeof literatureRecordImportRequestSchema>
type LiteratureRecordImportError = z.infer<typeof literatureRecordImportErrorSchema>
type LiteratureRecordImportEntry = z.infer<typeof literatureRecordImportEntrySchema>
type LiteratureRecordImportReceipt = z.infer<typeof literatureRecordImportReceiptSchema>
type LiteratureRecordImportResult = z.infer<typeof literatureRecordImportResultSchema>
type LiteratureMetadataField = (typeof LITERATURE_METADATA_FIELDS)[number]
type LiteratureMetadataCompletionRequest = z.infer<typeof literatureMetadataCompletionRequestSchema>
type LiteratureMetadataValue = z.infer<typeof literatureMetadataValueSchema>
type LiteratureMetadataConflict = z.infer<typeof literatureMetadataConflictSchema>
type LiteratureMetadataCompletionResult = z.infer<typeof literatureMetadataCompletionResultSchema>

const createLiteratureAttachmentVersionReference = (versionId: string): string => {
  const normalized = versionId.trim()
  if (!normalized) throw new Error('Literature Attachment Version id is required.')
  return `${LITERATURE_ATTACHMENT_VERSION_REFERENCE_PREFIX}${encodeURIComponent(normalized)}`
}

const parseLiteratureAttachmentVersionReference = (reference: string): string | undefined => {
  if (!reference.startsWith(LITERATURE_ATTACHMENT_VERSION_REFERENCE_PREFIX)) return undefined
  const encoded = reference.slice(LITERATURE_ATTACHMENT_VERSION_REFERENCE_PREFIX.length)
  if (!encoded) return undefined
  try {
    const versionId = decodeURIComponent(encoded)
    return versionId && !versionId.includes('/') ? versionId : undefined
  } catch {
    return undefined
  }
}

export {
  literatureFullTextCandidateSchema,
  literatureFullTextProgressSchema,
  LITERATURE_ATTACHMENT_VERSION_REFERENCE_PREFIX,
  LITERATURE_CITATION_LOCALES,
  LITERATURE_CITATION_STYLES,
  LITERATURE_CSL_MAX_BYTES,
  LITERATURE_COLLECTION_DESCRIPTION_MAX_LENGTH,
  LITERATURE_COLLECTION_NAME_MAX_LENGTH,
  LITERATURE_COLLECTION_NAME_CONFLICT,
  LITERATURE_IDENTITY_SCHEMES,
  LITERATURE_IDENTIFIER_SCHEMES,
  LITERATURE_INBOX_STATES,
  LITERATURE_IMPORT_WARNINGS,
  LITERATURE_ITEM_TYPES,
  LITERATURE_METADATA_FIELDS,
  LITERATURE_LIFECYCLE_STATES,
  LITERATURE_SORT_FIELDS,
  LITERATURE_RECORD_IMPORT_FORMATS,
  LITERATURE_RECORD_IMPORT_MAX_BYTES,
  LITERATURE_RECORD_IMPORT_MAX_RECORDS,
  literatureCandidateInputSchema,
  literatureCandidateOriginSchema,
  literatureAttachmentVersionViewSchema,
  literatureAttachmentViewSchema,
  literatureApplicationCommandContracts,
  literatureCatalogCommandSchema,
  literatureCatalogReceiptSchema,
  literatureCatalogSearchPageSchema,
  literatureCatalogSearchRequestSchema,
  literatureCollectionViewSchema,
  literatureFilterSchema,
  literatureCreatorInputSchema,
  literatureIdentifierInputSchema,
  literatureInboxCandidateViewSchema,
  literatureFormatReferencesRequestSchema,
  literatureFormatReferencesResultSchema,
  literatureFormatDocumentRequestSchema,
  literatureFormatDocumentResultSchema,
  literatureFormattedReferenceSchema,
  literatureCitationStylesRequestSchema,
  literatureCitationStylesResultSchema,
  literatureCitationStyleViewSchema,
  literatureRecordImportErrorSchema,
  literatureRecordImportEntrySchema,
  literatureRecordImportReceiptSchema,
  literatureRecordImportRequestSchema,
  literatureRecordImportResultSchema,
  literatureItemInputSchema,
  literatureItemViewSchema,
  literatureMetadataCompletionRequestSchema,
  literatureMetadataCompletionResultSchema,
  literaturePdfImportReceiptSchema,
  createLiteratureIdentifierUrl,
  createLiteratureAttachmentVersionReference,
  literaturePdfImportRequestSchema,
  literatureSourceInputSchema,
  parseLiteratureAttachmentVersionReference,
  normalizeLiteratureIdentifierValue
}
export type {
  LiteratureFullTextCandidate,
  LiteratureFullTextRequest,
  LiteratureFullTextResult,
  LiteratureCatalogCommand,
  LiteratureCollectionView,
  LiteratureProjectCountView,
  LiteratureFilter,
  LiteratureCatalogReceipt,
  LiteratureCatalogSearchPage,
  LiteratureCatalogSearchRequest,
  LiteratureCitationLocale,
  LiteratureCitationStyle,
  LiteratureCitationStyleView,
  LiteratureCitationStylesRequest,
  LiteratureCitationStylesResult,
  LiteratureCandidateInput,
  LiteratureAttachmentVersionView,
  LiteratureAttachmentView,
  LiteratureCandidateOrigin,
  LiteratureCreatorInput,
  LiteratureIdentifierInput,
  LiteratureIdentifierScheme,
  LiteratureIdentityScheme,
  LiteratureInboxState,
  LiteratureInboxCandidateView,
  LiteratureItemInput,
  LiteratureItemView,
  LiteratureSourceRecordView,
  LiteratureMetadataCompletionRequest,
  LiteratureMetadataCompletionResult,
  LiteratureMetadataConflict,
  LiteratureMetadataField,
  LiteratureMetadataValue,
  LiteratureItemType,
  LiteratureFormattedReference,
  LiteratureFormatReferencesRequest,
  LiteratureFormatReferencesResult,
  LiteratureFormatDocumentRequest,
  LiteratureFormatDocumentResult,
  LiteratureRecordImportError,
  LiteratureRecordImportEntry,
  LiteratureRecordImportFormat,
  LiteratureRecordImportReceipt,
  LiteratureRecordImportRequest,
  LiteratureRecordImportResult,
  LiteraturePdfImportReceipt,
  LiteraturePdfImportRequest,
  LiteratureSourceInput
}
