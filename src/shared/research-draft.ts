import { z } from 'zod'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'
import { researchWorkspaceRequestSchema } from './research-workspace'
import { uploadedAttachmentSchema, MAX_COMPOSER_ATTACHMENTS } from './uploads'
import { sanitizeAnnotation, type Annotation } from './annotations'
import { sanitizeMessageParts, type MessagePart } from './session-persistence'
const id = researchWorkspaceRequestSchema.shape.projectId
const pastedText = z
  .object({
    type: z.literal('pasted-text'),
    id,
    text: z.string().max(2_000_000),
    attachmentId: id.optional(),
    transferId: id.optional()
  })
  .strict()
export const researchDraftPayloadSchema = z
  .object({
    doc: z
      .object({
        nodes: z
          .array(
            z.union([
              pastedText,
              z.custom<MessagePart>((value) => sanitizeMessageParts([value])?.length === 1)
            ])
          )
          .max(1000)
      })
      .strict(),
    annotations: z
      .array(z.custom<Annotation>((value) => sanitizeAnnotation(value) !== undefined))
      .max(64),
    attachments: z.array(uploadedAttachmentSchema).max(MAX_COMPOSER_ATTACHMENTS),
    transfers: z
      .array(
        z
          .object({
            name: z.string().max(4096),
            size: z.number().finite().nonnegative(),
            mimeType: z.string().max(512).optional()
          })
          .strict()
      )
      .max(MAX_COMPOSER_ATTACHMENTS),
    automaticReadingEnabled: z.boolean(),
    editRevision: z.number().int().nonnegative(),
    intentId: id
  })
  .strict()
  .refine(
    (value) => JSON.stringify(value).length <= 4_000_000,
    'Research draft exceeds the storage limit.'
  )
export type ResearchDraftPayload = z.infer<typeof researchDraftPayloadSchema>
export const researchDraftSchema = researchWorkspaceRequestSchema
  .extend({
    id,
    editorId: id,
    revision: z.number().int().positive(),
    state: z.enum(['active', 'discarded']),
    payload: researchDraftPayloadSchema,
    updatedAt: z.number().int().nonnegative()
  })
  .strict()
export type ResearchDraft = z.infer<typeof researchDraftSchema>
export const saveResearchDraftSchema = researchWorkspaceRequestSchema
  .extend({
    id,
    editorId: id,
    expectedRevision: z.number().int().nonnegative(),
    payload: researchDraftPayloadSchema
  })
  .strict()
export type SaveResearchDraftRequest = z.infer<typeof saveResearchDraftSchema>
export const actResearchDraftSchema = researchWorkspaceRequestSchema
  .extend({
    id,
    editorId: id,
    expectedRevision: z.number().int().positive(),
    action: z.enum(['claim', 'discard']),
    releaseAttachments: z.boolean().optional()
  })
  .strict()
export type ActResearchDraftRequest = z.infer<typeof actResearchDraftSchema>
export const researchDraftMutationResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('saved'), draft: researchDraftSchema }).strict(),
  z.object({ status: z.literal('conflict'), draft: researchDraftSchema.nullable() }).strict()
])
export type ResearchDraftMutationResult = z.infer<typeof researchDraftMutationResultSchema>
export const researchDraftCommandContracts = {
  list: defineApplicationCommandContract(
    validationCodec(z.tuple([researchWorkspaceRequestSchema])),
    validationCodec(z.array(researchDraftSchema))
  ),
  save: defineApplicationCommandContract(
    validationCodec(z.tuple([saveResearchDraftSchema])),
    validationCodec(researchDraftMutationResultSchema)
  ),
  act: defineApplicationCommandContract(
    validationCodec(z.tuple([actResearchDraftSchema])),
    validationCodec(researchDraftMutationResultSchema)
  )
}
