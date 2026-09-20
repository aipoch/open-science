import { z } from 'zod'
import { TAG_RESOURCE_ID_MAX_LENGTH } from './tags'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'
import {
  PDF_MARK_COLORS,
  PDF_MARK_KINDS,
  sanitizePdfDocumentTarget,
  sanitizePdfDocumentSource,
  type PdfDocumentSource,
  type PdfBookmarkTextSelector,
  type PdfBookmarkRegionSelector,
  type PdfBookmarkPageNoteSelector,
  type PdfBookmarkDocumentNoteSelector,
  type PdfMarkKind
} from './pdf-bookmarks'

export type PdfAnnotationKind = PdfMarkKind | 'page-note' | 'document-note'
export const PDF_ANNOTATION_ORIGINS = ['user', 'imported'] as const
export type PdfAnnotationOrigin = (typeof PDF_ANNOTATION_ORIGINS)[number]
export const PDF_NATIVE_ANNOTATION_SOURCE_KINDS = ['artifact-version', 'upload-version'] as const
export type PdfNativeAnnotationSourceKind = (typeof PDF_NATIVE_ANNOTATION_SOURCE_KINDS)[number]
export type PdfAnnotationSource = PdfDocumentSource
export type PdfAnnotationSelector =
  | Omit<PdfBookmarkTextSelector, 'markKind' | 'color' | 'tags'>
  | Omit<PdfBookmarkRegionSelector, 'markKind' | 'color' | 'tags'>
  | PdfBookmarkPageNoteSelector
  | PdfBookmarkDocumentNoteSelector
export type PdfAnnotationTarget = Readonly<{
  source: PdfAnnotationSource
  selector: PdfAnnotationSelector
}>

export const PDF_ANNOTATION_LIMITS = Object.freeze({
  note: 20_000,
  tag: 1_024,
  tagCount: 24,
  pageSize: 100,
  targetBytes: 65_536
})
export const PDF_ANNOTATION_EXTERNAL_SUBTYPE_MAX_LENGTH = 64

const identity = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => value === value.trim())
const scopeSchema = z
  .object({
    projectId: identity.optional(),
    sessionId: identity.optional(),
    literatureVersionId: identity.optional()
  })
  .strict()
export type PdfAnnotationScope = z.infer<typeof scopeSchema>
export type PdfAnnotationsChangedEvent = {
  scope: PdfAnnotationScope
  id?: string
  updatedAt?: string
}
export const pdfAnnotationScope = ({
  projectId,
  sessionId,
  literatureVersionId
}: PdfAnnotationScope): PdfAnnotationScope =>
  literatureVersionId ? { literatureVersionId } : { projectId, sessionId }
const hasValidScope = (scope: PdfAnnotationScope): boolean =>
  scope.literatureVersionId !== undefined
    ? scope.projectId === undefined && scope.sessionId === undefined
    : Boolean(scope.projectId && scope.sessionId)
const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: identity }).strict()
const annotationKindSchema = z.enum([...PDF_MARK_KINDS, 'page-note', 'document-note'] as [
  PdfAnnotationKind,
  ...PdfAnnotationKind[]
])
const annotationOriginSchema = z.enum(PDF_ANNOTATION_ORIGINS)
const externalSubtypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(PDF_ANNOTATION_EXTERNAL_SUBTYPE_MAX_LENGTH)

const pdfNativeAnnotationImportRequestSchema = z
  .object({
    operationId: identity,
    projectId: identity,
    sessionId: identity,
    sourceKind: z.enum(PDF_NATIVE_ANNOTATION_SOURCE_KINDS),
    sourceFileId: identity,
    versionId: identity
  })
  .strict()
const pdfNativeAnnotationImportProgressSchema = z
  .object({
    operationId: identity,
    phase: z.enum(['parsing', 'saving', 'completed', 'cancelled', 'failed']),
    source: pdfNativeAnnotationImportRequestSchema.omit({ operationId: true }).optional(),
    pagesProcessed: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative(),
    importedCount: z.number().int().nonnegative(),
    unsupportedCount: z.number().int().nonnegative(),
    truncated: z.boolean().optional()
  })
  .strict()
const pdfNativeAnnotationImportResultSchema = z
  .object({
    operationId: identity,
    importedCount: z.number().int().nonnegative(),
    unsupportedCount: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    cancelled: z.boolean()
  })
  .strict()
const pdfNativeAnnotationCancelRequestSchema = z.object({ operationId: identity }).strict()
const colorSchema = z.enum(PDF_MARK_COLORS)
const targetSchema = z.custom<PdfAnnotationTarget>((value) => {
  try {
    const serialized = JSON.stringify(value)
    if (
      !serialized ||
      new TextEncoder().encode(serialized).byteLength > PDF_ANNOTATION_LIMITS.targetBytes
    )
      return false
  } catch {
    return false
  }
  return (
    typeof value === 'object' &&
    value !== null &&
    'source' in value &&
    'selector' in value &&
    Object.keys(value).every((key) => key === 'source' || key === 'selector') &&
    typeof value.selector === 'object' &&
    value.selector !== null &&
    !['markKind', 'color', 'tags', 'tagIds'].some((key) => Object.hasOwn(value.selector!, key)) &&
    sanitizePdfDocumentSource((value as { source: unknown }).source) !== undefined &&
    sanitizePdfDocumentTarget({
      kind: 'pdf',
      source: (value as { source: unknown }).source,
      selector: (value as { selector: unknown }).selector
    }) !== undefined
  )
})
const tagsSchema = z
  .array(z.string().trim().min(1).max(PDF_ANNOTATION_LIMITS.tag))
  .max(PDF_ANNOTATION_LIMITS.tagCount)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate Tag IDs.' })

const createSchema = scopeSchema
  .extend({
    id: identity.max(TAG_RESOURCE_ID_MAX_LENGTH),
    target: targetSchema,
    createdAt: z.iso.datetime().optional(),
    kind: annotationKindSchema,
    color: colorSchema.optional(),
    origin: annotationOriginSchema.optional(),
    externalSubtype: externalSubtypeSchema.optional(),
    tagIds: tagsSchema,
    note: z.string().max(PDF_ANNOTATION_LIMITS.note)
  })
  .strict()
  .refine(
    (value) => (value.origin ?? 'user') === 'imported' || value.externalSubtype === undefined,
    { message: 'User annotations cannot have an external subtype.' }
  )
const hasMatchingKind = (value: z.infer<typeof createSchema>): boolean => {
  const selector = value.target.selector
  if (selector.kind === 'text')
    return ['highlight', 'underline', 'squiggly', 'strikethrough'].includes(value.kind)
  return value.kind === (selector.kind === 'region' ? 'area' : selector.kind)
}
const hasMatchingScope = (value: z.infer<typeof createSchema>): boolean =>
  hasValidScope(value) &&
  (value.literatureVersionId
    ? value.target.source.kind === 'literature-attachment-version' &&
      value.target.source.versionId === value.literatureVersionId &&
      value.target.source.projectId === undefined &&
      value.target.source.sessionId === undefined
    : value.target.source.projectId === value.projectId)
export const createPdfAnnotationRequestSchema = createSchema
  .refine(hasMatchingScope)
  .refine(hasMatchingKind, {
    message: 'Annotation kind must match its selector.'
  })
export const listPdfAnnotationsRequestSchema = scopeSchema
  .extend({
    id: identity.max(TAG_RESOURCE_ID_MAX_LENGTH).optional(),
    sourceFileId: identity.optional(),
    versionId: identity.optional(),
    cursor: cursorSchema.optional(),
    limit: z.number().int().min(1).max(PDF_ANNOTATION_LIMITS.pageSize).optional()
  })
  .strict()
  .refine(hasValidScope)
export const updatePdfAnnotationRequestSchema = scopeSchema
  .extend({
    id: identity.max(TAG_RESOURCE_ID_MAX_LENGTH),
    note: z.string().max(PDF_ANNOTATION_LIMITS.note).optional(),
    color: colorSchema.nullable().optional(),
    tagIds: tagsSchema.optional(),
    expectedUpdatedAt: z.iso.datetime().optional()
  })
  .strict()
  .refine(hasValidScope)
export const deletePdfAnnotationRequestSchema = scopeSchema
  .extend({
    id: identity.max(TAG_RESOURCE_ID_MAX_LENGTH),
    expectedUpdatedAt: z.iso.datetime().optional()
  })
  .strict()
  .refine(hasValidScope)

export const pdfAnnotationSchema = createSchema
  .safeExtend({
    origin: annotationOriginSchema,
    version: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime()
  })
  .strict()
  .refine(hasMatchingScope)
  .refine(hasMatchingKind)
// PDF.js indirect-object IDs (e.g. 12R or 12R2), scoped to immutable source bytes.
export const pdfNativeImportReceiptSchema = z
  .object({
    nativeRefs: z
      .array(
        z
          .object({ pageNumber: z.number().int().positive(), id: z.string().regex(/^\d+R\d*$/) })
          .strict()
      )
      .max(500),
    pageCount: z.number().int().nonnegative(),
    unsupportedCount: z.number().int().nonnegative(),
    truncated: z.boolean()
  })
  .strict()
export type PdfNativeImportReceipt = z.infer<typeof pdfNativeImportReceiptSchema>

export const pdfAnnotationListResultSchema = z
  .object({
    items: z.array(pdfAnnotationSchema).max(PDF_ANNOTATION_LIMITS.pageSize),
    total: z.number().int().nonnegative(),
    nativeImport: pdfNativeImportReceiptSchema.optional(),
    source: z
      .custom<PdfAnnotationSource>((value) => sanitizePdfDocumentSource(value) !== undefined)
      .optional(),
    nextCursor: cursorSchema.optional()
  })
  .strict()
export const deletePdfAnnotationResultSchema = z.object({ deleted: z.boolean() }).strict()

export type PdfAnnotation = z.infer<typeof pdfAnnotationSchema>
export type CreatePdfAnnotationRequest = z.infer<typeof createPdfAnnotationRequestSchema>
export type ListPdfAnnotationsRequest = z.infer<typeof listPdfAnnotationsRequestSchema>
export type PdfAnnotationListResult = z.infer<typeof pdfAnnotationListResultSchema>
export type UpdatePdfAnnotationRequest = z.infer<typeof updatePdfAnnotationRequestSchema>
export type DeletePdfAnnotationRequest = z.infer<typeof deletePdfAnnotationRequestSchema>
export type DeletePdfAnnotationResult = z.infer<typeof deletePdfAnnotationResultSchema>
export type PdfNativeAnnotationImportRequest = z.infer<
  typeof pdfNativeAnnotationImportRequestSchema
>
export type PdfNativeAnnotationImportProgress = z.infer<
  typeof pdfNativeAnnotationImportProgressSchema
>
export type PdfNativeAnnotationImportResult = z.infer<typeof pdfNativeAnnotationImportResultSchema>
export type PdfNativeAnnotationCancelRequest = z.infer<
  typeof pdfNativeAnnotationCancelRequestSchema
>

export const pdfAnnotationApplicationCommandContracts = Object.freeze({
  list: defineApplicationCommandContract(
    validationCodec(z.tuple([listPdfAnnotationsRequestSchema])),
    validationCodec(pdfAnnotationListResultSchema)
  ),
  create: defineApplicationCommandContract(
    validationCodec(z.tuple([createPdfAnnotationRequestSchema])),
    validationCodec(pdfAnnotationSchema)
  ),
  update: defineApplicationCommandContract(
    validationCodec(z.tuple([updatePdfAnnotationRequestSchema])),
    validationCodec(pdfAnnotationSchema)
  ),
  delete: defineApplicationCommandContract(
    validationCodec(z.tuple([deletePdfAnnotationRequestSchema])),
    validationCodec(deletePdfAnnotationResultSchema)
  ),
  importNative: defineApplicationCommandContract(
    validationCodec(z.tuple([pdfNativeAnnotationImportRequestSchema])),
    validationCodec(pdfNativeAnnotationImportResultSchema)
  ),
  cancelImport: defineApplicationCommandContract(
    validationCodec(z.tuple([pdfNativeAnnotationCancelRequestSchema])),
    validationCodec(z.object({ cancelled: z.boolean() }).strict())
  )
})

export {
  pdfNativeAnnotationCancelRequestSchema,
  pdfNativeAnnotationImportProgressSchema,
  pdfNativeAnnotationImportRequestSchema,
  pdfNativeAnnotationImportResultSchema
}
