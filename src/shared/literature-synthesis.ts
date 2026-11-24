import { z } from 'zod'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'
import { pdfAnnotationSchema } from './pdf-annotations'

export const MAX_SYNTHESIS_NOTE_BYTES = 2 * 1024 * 1024

const id = z.string().trim().min(1).max(1024)
const title = z.string().trim().min(1).max(300)
const itemIds = z
  .array(id)
  .min(1)
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length)
export const synthesisExcerptSelectionSchema = z
  .object({
    itemId: id,
    versionId: id,
    annotationId: id,
    expectedUpdatedAt: z.iso.datetime().optional()
  })
  .strict()
const selections = z.array(synthesisExcerptSelectionSchema).min(1).max(100)
export const synthesisCandidateCursorSchema = z.object({ createdAt: z.iso.datetime(), id }).strict()
export type SynthesisCandidateCursor = z.infer<typeof synthesisCandidateCursorSchema>
export const synthesisBibliographySchema = z
  .object({
    itemId: id,
    title: z.string().max(20000),
    authors: z.string(),
    year: z.string().max(100).optional(),
    doi: z.string().max(2048).optional()
  })
  .strict()
export const synthesisCandidateSchema = z
  .object({
    itemId: id,
    versionId: id,
    annotationId: id,
    bibliography: synthesisBibliographySchema,
    annotation: pdfAnnotationSchema,
    tags: z.array(z.object({ id, name: z.string().max(1024) }).strict()).max(24)
  })
  .strict()
export const synthesisSourceMetadataSchema = z
  .object({
    title: z.string().max(20000),
    authors: z.string(),
    // A paper may accumulate distinct tags across all 200 saved excerpt snapshots.
    tags: z.array(z.string().max(1024)).max(200 * 24)
  })
  .strict()
const heading = z
  .object({
    type: z.literal('heading'),
    id,
    text: z.string().max(2000),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)])
  })
  .strict()
const text = z.object({ type: z.literal('text'), id, text: z.string().max(20000) }).strict()
const excerptReference = z.object({ type: z.literal('excerpt'), id }).strict()
export const synthesisEditableBlockSchema = z.discriminatedUnion('type', [
  heading,
  text,
  excerptReference
])
export const synthesisStoredExcerptSchema = excerptReference
  .extend({ snapshot: synthesisCandidateSchema })
  .strict()
export const synthesisStoredBlockSchema = z.discriminatedUnion('type', [
  heading,
  text,
  synthesisStoredExcerptSchema
])
export const synthesisExcerptSchema = synthesisStoredExcerptSchema
  .extend({ sourceStatus: z.enum(['current', 'changed', 'unavailable', 'unverified']) })
  .strict()
export const synthesisBlockSchema = z.discriminatedUnion('type', [
  heading,
  text,
  synthesisExcerptSchema
])
export const synthesisMutationReceiptSchema = z
  .object({ id, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
export type SynthesisMutationReceipt = z.infer<typeof synthesisMutationReceiptSchema>
export const synthesisStoredNoteSchema = z
  .object({
    id,
    title,
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    blocks: z.array(synthesisStoredBlockSchema).max(200),
    creationRequest: synthesisMutationReceiptSchema.optional(),
    lastMutation: synthesisMutationReceiptSchema.optional(),
    lastNoopAppend: synthesisMutationReceiptSchema.optional()
  })
  .strict()
export const synthesisNoteSchema = synthesisStoredNoteSchema.extend({
  blocks: z.array(synthesisBlockSchema).max(200)
})
export const synthesisNoteSummarySchema = synthesisNoteSchema
  .omit({ blocks: true, creationRequest: true, lastMutation: true, lastNoopAppend: true })
  .extend({
    searchText: z.string().max(MAX_SYNTHESIS_NOTE_BYTES).optional(),
    sourceMetadata: z.array(synthesisSourceMetadataSchema).max(200).optional()
  })
const noteIdentity = { noteId: id, expectedRevision: z.number().int().positive() }
export const literatureSynthesisRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('read'), noteId: id }).strict(),
  z.object({ action: z.literal('revision'), noteId: id }).strict(),
  z.object({ action: z.literal('source'), noteId: id, blockId: id }).strict(),
  z
    .object({
      action: z.literal('candidates'),
      itemIds,
      tagId: id.optional(),
      cursor: synthesisCandidateCursorSchema.optional(),
      limit: z.number().int().min(1).max(100).optional()
    })
    .strict(),
  z
    .object({
      action: z.literal('create'),
      requestId: id.optional(),
      title,
      itemIds,
      excerpts: selections
    })
    .strict(),
  z
    .object({
      action: z.literal('append'),
      requestId: id.optional(),
      ...noteIdentity,
      itemIds,
      excerpts: selections
    })
    .strict(),
  z
    .object({
      action: z.literal('update'),
      requestId: id.optional(),
      ...noteIdentity,
      title,
      blocks: z.array(synthesisEditableBlockSchema).max(200)
    })
    .strict(),
  z.object({ action: z.literal('delete'), requestId: id.optional(), ...noteIdentity }).strict(),
  z.object({ action: z.literal('export'), ...noteIdentity }).strict()
])
export const literatureSynthesisResultSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('list'),
      notes: z.array(synthesisNoteSummarySchema).max(200)
    })
    .strict(),
  z.object({ action: z.literal('read'), note: synthesisNoteSchema }).strict(),
  z
    .object({ action: z.literal('revision'), noteId: id, revision: z.number().int().positive() })
    .strict(),
  z.object({ action: z.literal('source'), block: synthesisExcerptSchema }).strict(),
  z
    .object({
      action: z.literal('candidates'),
      candidates: z.array(synthesisCandidateSchema).max(100),
      nextCursor: synthesisCandidateCursorSchema.optional()
    })
    .strict(),
  z.object({ action: z.literal('create'), note: synthesisNoteSchema }).strict(),
  z.object({ action: z.literal('append'), note: synthesisNoteSchema }).strict(),
  z
    .object({
      action: z.literal('append-rejected'),
      reason: z.literal('block-limit'),
      maxBlocks: z.literal(200)
    })
    .strict(),
  z.object({ action: z.literal('update'), note: synthesisNoteSchema }).strict(),
  z.object({ action: z.literal('delete'), deleted: z.boolean() }).strict(),
  z
    .object({
      action: z.literal('export'),
      filename: z.string().max(512),
      // The longest plain-text escape is a six-character indentation entity.
      markdown: z.string().max(MAX_SYNTHESIS_NOTE_BYTES * 6)
    })
    .strict()
])
export type SynthesisExcerptSelection = z.infer<typeof synthesisExcerptSelectionSchema>
export type SynthesisCandidate = z.infer<typeof synthesisCandidateSchema>
export type SynthesisSourceMetadata = z.infer<typeof synthesisSourceMetadataSchema>
export type SynthesisBlock = z.infer<typeof synthesisBlockSchema>
export type SynthesisExcerpt = z.infer<typeof synthesisExcerptSchema>
export type SynthesisStoredNote = z.infer<typeof synthesisStoredNoteSchema>
export type SynthesisEditableBlock = z.infer<typeof synthesisEditableBlockSchema>
export type SynthesisNote = z.infer<typeof synthesisNoteSchema>
export type SynthesisNoteSummary = z.infer<typeof synthesisNoteSummarySchema>
export function annotationQuote(
  selector: SynthesisCandidate['annotation']['target']['selector']
): string {
  return 'exact' in selector
    ? selector.exact
    : selector.kind === 'region'
      ? (selector.text ?? '')
      : ''
}

export function synthesisNoteSourceMetadata(
  note: Pick<SynthesisStoredNote, 'blocks'>
): SynthesisSourceMetadata[] {
  const sources = new Map<string, SynthesisSourceMetadata>()
  for (const block of note.blocks) {
    if (block.type !== 'excerpt') continue
    const { bibliography, tags } = block.snapshot
    // Preserve older bibliography values when the same paper changes between snapshots.
    const key = JSON.stringify([bibliography.itemId, bibliography.title, bibliography.authors])
    const existing = sources.get(key)
    if (!existing) {
      sources.set(key, {
        title: bibliography.title,
        authors: bibliography.authors,
        tags: [...new Set(tags.map((tag) => tag.name))]
      })
      continue
    }
    for (const tag of tags.map((value) => value.name))
      if (!existing.tags.includes(tag)) existing.tags.push(tag)
  }
  return [...sources.values()]
}
/** Content only: bibliography and tags travel once, in sourceMetadata. */
export function synthesisNoteSearchText(note: Pick<SynthesisStoredNote, 'blocks'>): string {
  return [
    ...new Set(
      note.blocks
        .flatMap((block) => {
          if (block.type !== 'excerpt') return [block.text]
          const { annotation } = block.snapshot
          return [annotationQuote(annotation.target.selector), annotation.note ?? '']
        })
        .filter(Boolean)
    )
  ].join('\n')
}

/** Shared by list responses and local mutation results; never retain snapshot blocks. */
export function synthesisNoteSummary(note: SynthesisStoredNote): SynthesisNoteSummary {
  const searchText = synthesisNoteSearchText(note)
  const sourceMetadata = synthesisNoteSourceMetadata(note)
  return {
    id: note.id,
    title: note.title,
    revision: note.revision,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    ...(searchText ? { searchText } : {}),
    ...(sourceMetadata.length ? { sourceMetadata } : {})
  }
}
export type LiteratureSynthesisRequest = z.infer<typeof literatureSynthesisRequestSchema>
export type LiteratureSynthesisResult = z.infer<typeof literatureSynthesisResultSchema>
export const literatureSynthesisContract = defineApplicationCommandContract(
  validationCodec(z.tuple([literatureSynthesisRequestSchema])),
  validationCodec(literatureSynthesisResultSchema)
)
