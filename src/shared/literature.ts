import {
  literaturePublicationCheckRequestSchema,
  literaturePublicationCheckResultSchema,
  literatureRelatedRequestSchema,
  literatureRelatedResultSchema,
  literatureFullTextRequestSchema,
  literatureFullTextProgressSchema,
  literatureSupplementRequestSchema,
  literatureSupplementAttachmentRequestSchema,
  literatureSupplementAttachmentResultSchema,
  literatureSupplementResultSchema,
  literatureMetadataCompletionRequestSchema
} from '@aipoch/literature-discovery/contracts'

import {
  LITERATURE_ATTACHMENT_VERSION_REFERENCE_PREFIX,
  createLiteratureAttachmentVersionReference,
  parseLiteratureAttachmentVersionReference
} from './literature-attachment-reference'

import { pdfAddToLiteratureRequestSchema, pdfAnnotationSchema } from './pdf-annotations'

import { z } from 'zod'

import { defineApplicationCommandContract, validationCodec } from './application-command-contract'

import { uploadedAttachmentSchema } from './uploads'

import {
  LITERATURE_INBOX_STATES,
  literatureCatalogCommandSchema,
  literatureCatalogReceiptSchema,
  literatureCatalogSearchRequestSchema,
  literatureCitationStylesRequestSchema,
  literatureCitationStylesResultSchema,
  literatureCollectionViewSchema,
  literatureDuplicateGroupSchema,
  literatureFormatDocumentRequestSchema,
  literatureFormatDocumentResultSchema,
  literatureFormatReferencesRequestSchema,
  literatureFormatReferencesResultSchema,
  literatureFullTextResultSchema,
  literatureInboxCandidateViewSchema,
  literatureItemViewSchema,
  literatureMetadataCompletionResultSchema,
  literaturePdfCancelImportRequestSchema,
  literaturePdfImportReceiptSchema,
  literatureProjectCountViewSchema,
  literatureRecordImportRequestSchema,
  literatureRecordImportResultSchema,
  literatureSourceRecordViewSchema
} from '@aipoch/literature-library/contracts'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'

const nonEmptyTextSchema = z.string().trim().min(1)

// Read current state without changing the immutable tool receipt that supplied these IDs.
export const literatureCandidateStatesRequestSchema = z
  .object({ candidateIds: z.array(nonEmptyTextSchema.max(256)).min(1).max(200) })
  .strict()

export const literatureCandidateStatesResultSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            candidateId: nonEmptyTextSchema,
            state: z.enum(LITERATURE_INBOX_STATES),
            // Omitted when the accepted reference is no longer available.
            acceptedItemId: nonEmptyTextSchema.optional()
          })
          .strict()
      )
      .max(200)
  })
  .strict()

export type LiteratureCandidateStatesRequest = z.infer<
  typeof literatureCandidateStatesRequestSchema
>
export type LiteratureCandidateStatesResult = z.infer<typeof literatureCandidateStatesResultSchema>

export const literatureAnnotationSearchViewSchema = z
  .object({
    id: nonEmptyTextSchema,
    annotation: pdfAnnotationSchema
  })
  .strict()

export type LiteratureAnnotationSearchView = z.infer<typeof literatureAnnotationSearchViewSchema>

const literatureCatalogSearchPageSchema = z
  .object({
    entries: z.array(
      z.union([
        literatureItemViewSchema,
        literatureInboxCandidateViewSchema,
        literatureCollectionViewSchema,
        literatureProjectCountViewSchema,
        literatureDuplicateGroupSchema,
        literatureAnnotationSearchViewSchema
      ])
    ),
    itemIds: z.array(nonEmptyTextSchema).optional(),
    totalCount: z.number().int().nonnegative().optional(),
    nextOffset: z.number().int().nonnegative().optional()
  })
  .strict()

const literaturePdfImportRequestSchema = z
  .object({
    itemId: nonEmptyTextSchema,
    attachment: uploadedAttachmentSchema,
    operationId: nonEmptyTextSchema.optional()
  })
  .strict()

export const pdfAddToLiteratureContract = defineApplicationCommandContract(
  validationCodec(z.tuple([pdfAddToLiteratureRequestSchema])),
  validationCodec(literaturePdfImportReceiptSchema)
)

const literatureApplicationCommandContracts = Object.freeze({
  getCandidateStates: defineApplicationCommandContract(
    validationCodec(z.tuple([literatureCandidateStatesRequestSchema])),
    validationCodec(literatureCandidateStatesResultSchema)
  ),
  supplementAttachmentProgress: defineApplicationCommandContract(
    validationCodec(z.tuple([literatureSupplementAttachmentRequestSchema])),
    validationCodec(literatureFullTextProgressSchema.nullable())
  ),
  supplementAttachment: defineApplicationCommandContract(
    validationCodec(z.tuple([literatureSupplementAttachmentRequestSchema])),
    validationCodec(literatureSupplementAttachmentResultSchema)
  ),
  publicationCheck: defineApplicationCommandContract(
    validationCodec(z.tuple([literaturePublicationCheckRequestSchema])),
    validationCodec(literaturePublicationCheckResultSchema)
  ),
  related: defineApplicationCommandContract(
    validationCodec(z.tuple([literatureRelatedRequestSchema])),
    validationCodec(literatureRelatedResultSchema)
  ),
  supplements: defineApplicationCommandContract(
    validationCodec(z.tuple([literatureSupplementRequestSchema])),
    validationCodec(literatureSupplementResultSchema)
  ),
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
          .regex(/^(?:10\.\d{4,9}\/\S+|pmid:\d+|arxiv:(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7}))$/u)
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
  cancelPdfImport: defineApplicationCommandContract(
    validationCodec(z.tuple([literaturePdfCancelImportRequestSchema])),
    validationCodec(z.object({ cancelled: z.boolean() }).strict())
  ),
  transact: defineApplicationCommandContract(
    validationCodec(z.tuple([literatureCatalogCommandSchema])),
    validationCodec(literatureCatalogReceiptSchema)
  )
})

type LiteratureCatalogSearchPage = z.infer<typeof literatureCatalogSearchPageSchema>

type LiteraturePdfImportRequest = z.infer<typeof literaturePdfImportRequestSchema>
export {
  LITERATURE_ATTACHMENT_VERSION_REFERENCE_PREFIX,
  createLiteratureAttachmentVersionReference,
  literatureApplicationCommandContracts,
  literatureCatalogSearchPageSchema,
  literaturePdfImportRequestSchema,
  parseLiteratureAttachmentVersionReference
}

export type { LiteratureCatalogSearchPage, LiteraturePdfImportRequest }

export {
  literatureIssuedYear,
  normalizeLiteratureIdentifierKey
} from '@aipoch/literature-citations/contracts'
