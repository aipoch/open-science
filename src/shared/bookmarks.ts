import { z } from 'zod'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'
import {
  ANNOTATION_LIMITS,
  resolveManagedProjectFileAnnotationIdentity,
  type TextAnnotationSource,
  type TextAnnotationAnchor
} from './annotations'
import {
  sanitizePdfBookmarkTarget,
  sanitizePdfBookmarkSource,
  type PdfBookmarkSource,
  type PdfBookmarkTarget
} from './pdf-bookmarks'

export type TextBookmarkTarget = Readonly<{
  kind: 'text'
  source: TextAnnotationSource
  quote: string
  anchor?: TextAnnotationAnchor
}>
export type BookmarkTarget = TextBookmarkTarget | PdfBookmarkTarget
export const BOOKMARK_LIMITS = Object.freeze({
  quote: ANNOTATION_LIMITS.quote,
  note: ANNOTATION_LIMITS.note,
  targetBytes: 65_536,
  pageSize: 100
})

const identity = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => value === value.trim())
const textSourceSchema = z
  .discriminatedUnion('kind', [
    z
      .object({ kind: z.literal('agent-message'), sessionId: identity, messageId: identity })
      .strict(),
    z
      .object({
        kind: z.literal('session-item'),
        sessionId: identity,
        itemId: identity,
        itemType: z.enum([
          'tool-activity',
          'plan',
          'elicitation',
          'delegated-elicitation',
          'subagent-message'
        ]),
        sectionId: identity.optional()
      })
      .strict(),
    z
      .object({
        kind: z.literal('project-file'),
        projectId: identity,
        path: z.string().min(1).max(8192),
        name: identity.optional(),
        fileSource: z.enum(['artifact', 'upload']).optional(),
        sourceFileId: identity.optional(),
        versionId: identity.optional(),
        sessionId: identity.optional()
      })
      .strict()
  ])
  .refine(
    (source) =>
      source.kind !== 'project-file' || resolveManagedProjectFileAnnotationIdentity(source) !== null
  )
const textTargetSchema = z
  .object({
    kind: z.literal('text'),
    source: textSourceSchema,
    quote: z
      .string()
      .min(1)
      .max(BOOKMARK_LIMITS.quote)
      .refine((value) => value.trim().length > 0),
    anchor: z
      .object({
        position: z
          .object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
          .strict(),
        prefix: z.string().min(1).max(256).optional(),
        suffix: z.string().min(1).max(256).optional()
      })
      .strict()
      .optional()
  })
  .strict()
  .refine(
    (target) =>
      !target.anchor ||
      target.anchor.position.end === target.anchor.position.start + target.quote.length
  )

export const sanitizeBookmarkTarget = (value: unknown): BookmarkTarget | undefined => {
  try {
    const serialized = JSON.stringify(value)
    if (
      !serialized ||
      new TextEncoder().encode(serialized).byteLength > BOOKMARK_LIMITS.targetBytes
    )
      return undefined
  } catch {
    return undefined
  }
  const parsed = textTargetSchema.safeParse(value)
  return parsed.success ? parsed.data : sanitizePdfBookmarkTarget(value)
}
const targetSchema = z.custom<BookmarkTarget>(
  (value) => sanitizeBookmarkTarget(value) !== undefined
)
const scopeSchema = z.object({ projectId: identity, sessionId: identity }).strict()
export const resolvePdfBookmarkSourceRequestSchema = scopeSchema
  .extend({
    sourceKind: z.enum(['artifact-version', 'upload-version', 'literature-attachment-version']),
    sourceFileId: identity,
    versionId: identity
  })
  .strict()
export const bookmarkPdfSourceResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      source: z.custom<PdfBookmarkSource>((value) => sanitizePdfBookmarkSource(value) !== undefined)
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(['source-unavailable', 'identity-mismatch', 'unsupported-source'])
    })
    .strict()
])
export type ResolvePdfBookmarkSourceRequest = z.infer<typeof resolvePdfBookmarkSourceRequestSchema>
export type BookmarkPdfSourceResult = z.infer<typeof bookmarkPdfSourceResultSchema>
const timestampSchema = z.iso.datetime()
const cursorSchema = z.object({ createdAt: timestampSchema, id: identity }).strict()
export const createBookmarkRequestSchema = scopeSchema
  .extend({ id: identity, target: targetSchema, note: z.string().max(BOOKMARK_LIMITS.note) })
  .strict()
export const listBookmarksRequestSchema = scopeSchema
  .extend({
    cursor: cursorSchema.optional(),
    limit: z.number().int().min(1).max(BOOKMARK_LIMITS.pageSize).optional()
  })
  .strict()
export const updateBookmarkNoteRequestSchema = scopeSchema
  .extend({ id: identity, note: z.string().max(BOOKMARK_LIMITS.note) })
  .strict()
export const deleteBookmarkRequestSchema = scopeSchema.extend({ id: identity }).strict()
export const bookmarkSchema = createBookmarkRequestSchema
  .extend({ version: z.literal(1), createdAt: timestampSchema, updatedAt: timestampSchema })
  .strict()
export const bookmarkListResultSchema = z
  .object({
    items: z.array(bookmarkSchema).max(BOOKMARK_LIMITS.pageSize),
    total: z.number().int().nonnegative(),
    nextCursor: cursorSchema.optional()
  })
  .strict()
export const deleteBookmarkResultSchema = z.object({ deleted: z.boolean() }).strict()
export type Bookmark = z.infer<typeof bookmarkSchema>
export type CreateBookmarkRequest = z.infer<typeof createBookmarkRequestSchema>
export type ListBookmarksRequest = z.infer<typeof listBookmarksRequestSchema>
export type BookmarkListResult = z.infer<typeof bookmarkListResultSchema>
export type UpdateBookmarkNoteRequest = z.infer<typeof updateBookmarkNoteRequestSchema>
export type DeleteBookmarkRequest = z.infer<typeof deleteBookmarkRequestSchema>
export type DeleteBookmarkResult = z.infer<typeof deleteBookmarkResultSchema>
export const bookmarkApplicationCommandContracts = Object.freeze({
  resolvePdfSource: defineApplicationCommandContract(
    validationCodec(z.tuple([resolvePdfBookmarkSourceRequestSchema])),
    validationCodec(bookmarkPdfSourceResultSchema)
  ),
  list: defineApplicationCommandContract(
    validationCodec(z.tuple([listBookmarksRequestSchema])),
    validationCodec(bookmarkListResultSchema)
  ),
  create: defineApplicationCommandContract(
    validationCodec(z.tuple([createBookmarkRequestSchema])),
    validationCodec(bookmarkSchema)
  ),
  updateNote: defineApplicationCommandContract(
    validationCodec(z.tuple([updateBookmarkNoteRequestSchema])),
    validationCodec(bookmarkSchema)
  ),
  delete: defineApplicationCommandContract(
    validationCodec(z.tuple([deleteBookmarkRequestSchema])),
    validationCodec(deleteBookmarkResultSchema)
  )
})
