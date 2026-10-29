import { z } from 'zod'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'
import {
  literatureItemInputSchema,
  literatureSourceInputSchema,
  literatureDuplicatePolicySchema
} from '@aipoch/literature-library/contracts'
import {
  literatureIdentifierInputSchema,
  literatureCreatorInputSchema
} from '@aipoch/literature-citations/contracts'

export const ZOTERO_BATCH_POLICY_CONFLICT = 'ZOTERO_BATCH_POLICY_CONFLICT'
export const ZOTERO_FILL_TYPE_CONFLICT = 'ZOTERO_FILL_TYPE_CONFLICT'
export const ZOTERO_COLLECTION_CONFLICT = 'ZOTERO_COLLECTION_CONFLICT'
export const ZOTERO_PREVIEW_CHANGED = 'ZOTERO_PREVIEW_CHANGED'
export const ZOTERO_CONNECTION_FAILED = 'ZOTERO_CONNECTION_FAILED'
export const ZOTERO_REQUEST_TIMED_OUT = 'ZOTERO_REQUEST_TIMED_OUT'
export const ZOTERO_LOCAL_API_DISABLED = 'ZOTERO_LOCAL_API_DISABLED'
export const ZOTERO_TAG_LIMIT = 'ZOTERO_TAG_LIMIT'

const name = z.string().trim().min(1).max(64)
export const collectedCollectionPathsSchema = z
  .array(z.array(z.string().trim().min(1).max(200)).min(1).max(20))
  .max(5000)
export const collectedReferenceSchema = z
  .object({
    item: literatureItemInputSchema,
    source: literatureSourceInputSchema,
    tags: z.array(name).max(100),
    collectionPaths: collectedCollectionPathsSchema
  })
  .strict()
export type CollectedReference = z.infer<typeof collectedReferenceSchema>

export const collectorRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('zotero-preview'),
      collectionKey: z
        .string()
        .regex(/^[A-Z0-9]{8}$/)
        .optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('zotero-commit'),
      snapshotId: z.string().min(1),
      keys: z.array(z.string().regex(/^[A-Z0-9]{8}$/)).max(1000),
      includePdfs: z.boolean()
    })
    .strict(),
  z
    .object({
      kind: z.literal('zotero-revise'),
      snapshotId: z.string().min(1),
      key: z.string().regex(/^[A-Z0-9]{8}$/),
      item: literatureItemInputSchema.optional(),
      policy: literatureDuplicatePolicySchema.optional()
    })
    .strict()
    .refine(
      ({ item, policy }) => item !== undefined || policy !== undefined,
      'Select an edit or import policy.'
    )
])
export const collectedIdentitySchema = z
  .object({
    status: z.enum(['new', 'reuse', 'review', 'conflict']),
    reason: z.enum(['new', 'source', 'identifier', 'title', 'metadata', 'trash', 'conflict']),
    identifiers: z.array(literatureIdentifierInputSchema),
    matches: z.array(
      z
        .object({
          title: z.string(),
          itemType: literatureItemInputSchema.shape.itemType.optional(),
          creators: z.array(literatureCreatorInputSchema).optional(),
          issuedYear: z.number().int().min(0).max(9999).optional(),
          issuedText: z.string().optional(),
          containerTitle: z.string().optional(),
          identifiers: z.array(literatureIdentifierInputSchema)
        })
        .strict()
    )
  })
  .strict()
export type CollectedIdentity = z.infer<typeof collectedIdentitySchema>

const collectorResultSchema = z
  .object({
    snapshotId: z.string().optional(),
    entries: z
      .array(
        z
          .object({
            key: z.string(),
            title: z.string(),
            item: literatureItemInputSchema,
            policy: literatureDuplicatePolicySchema,
            pdfCount: z.number().int().nonnegative(),
            identity: collectedIdentitySchema
          })
          .strict()
      )
      .max(1000),
    savedItemIds: z.array(z.string()).max(1000),
    failures: z.array(z.object({ key: z.string(), message: z.string() }).strict()),
    pdfCount: z.number().int().nonnegative(),
    collectionCount: z.number().int().nonnegative().optional()
  })
  .strict()
export type CollectorRequest = z.infer<typeof collectorRequestSchema>
export type CollectorResult = z.infer<typeof collectorResultSchema>
export const literatureCollectorContract = defineApplicationCommandContract(
  validationCodec(z.tuple([collectorRequestSchema])),
  validationCodec(collectorResultSchema)
)
