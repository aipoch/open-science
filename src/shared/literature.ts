import {
  literatureFullTextRequestSchema,
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
          .regex(/^(?:10\.\d{4,9}\/\S+|pmid:\d+)$/u)
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
