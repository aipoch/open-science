import { z } from 'zod'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'
import { researchWorkspaceRequestSchema } from './research-workspace'
import { uploadedAttachmentSchema, MAX_COMPOSER_ATTACHMENTS } from './uploads'
import { sanitizeAnnotation, type Annotation } from './annotations'
import {
  sanitizeMessageParts,
  sanitizeMessagePdfContextSnapshot,
  delegationPolicySchema,
  type MessagePart,
  type MessagePdfContextSnapshot,
  type PersistedChatSession
} from './session-persistence'
import { persistedChatSessionCodec } from './session-persistence'
import { PERMISSION_PROFILE_IDS } from './permission-profiles'

const id = researchWorkspaceRequestSchema.shape.projectId
const text = z.string().max(2_000_000)
const position = z
  .object({ pageNumber: z.number().int().positive(), pageCount: z.number().int().positive() })
  .strict()
const pdfSource = z
  .object({
    sourceKind: z.enum(['artifact-version', 'upload-version', 'literature-attachment-version']),
    sourceFileId: id.optional(),
    sourceVersionId: id
  })
  .strict()
const reference = z.union([
  z
    .object({
      id,
      name: text,
      source: z.literal('linked-folder'),
      rootId: id,
      relativePath: text,
      mimeType: text.optional()
    })
    .strict(),
  z
    .object({
      id,
      name: text,
      source: z.enum(['upload', 'artifact', 'literature']),
      path: text,
      sourceFileId: id.optional(),
      mimeType: text.optional(),
      versionId: id.optional(),
      checksum: text.optional(),
      pdfReadingPosition: position.optional(),
      pdfContextDocumentId: id.optional(),
      pdfContextDocumentCount: z.number().int().positive().optional(),
      pdfContextActive: z.boolean().optional()
    })
    .strict()
])
// This journal holds ordinary user send intent, never runtime/provider authority or executable callbacks.
export const researchSubmissionPayloadSchema = z
  .object({
    text,
    attachments: z.array(uploadedAttachmentSchema).max(MAX_COMPOSER_ATTACHMENTS),
    annotations: z
      .array(z.custom<Annotation>((value) => sanitizeAnnotation(value) !== undefined))
      .max(64),
    parts: z
      .custom<MessagePart[]>(
        (value) =>
          Array.isArray(value) &&
          value.length <= 1000 &&
          (value.length === 0 || sanitizeMessageParts(value)?.length === value.length)
      )
      .optional(),
    referencedArtifacts: z.array(reference).max(1000).optional(),
    pdfContext: z
      .custom<MessagePdfContextSnapshot>(
        (value) => sanitizeMessagePdfContextSnapshot(value) !== undefined
      )
      .optional(),
    pdfReadingPosition: position.optional(),
    pdfReadingPositionSource: z
      .union([pdfSource, z.object({ attachmentId: id }).strict()])
      .optional(),
    pendingPdfContextAttachmentIds: z.array(id).max(10).optional(),
    pendingPdfContextVersions: z.array(pdfSource).max(10).optional(),
    permissionProfile: z.enum(PERMISSION_PROFILE_IDS),
    agentConfiguration: z
      .object({
        providerId: id,
        model: text.optional(),
        reasoningEffort: z.enum(['default', 'low', 'medium', 'high', 'xhigh', 'max'])
      })
      .strict(),
    forcedSkillIds: z.array(id).max(1000),
    specialistId: id.nullable().optional(),
    memoryEnabled: z.boolean().optional(),
    autoReviewEnabled: z.boolean().optional(),
    delegationPolicy: delegationPolicySchema.optional(),
    enabledComputeHosts: z.array(id).max(1000).optional(),
    selectedComputeHosts: z.array(id).max(1000).optional(),
    setupSessionToken: id.optional(),
    turnIntent: z.literal('plan-first').optional()
  })
  .strict()
  .refine(
    (value) => JSON.stringify(value).length <= 4_000_000,
    'Research question exceeds the journal size limit.'
  )
export type ResearchSubmissionPayload = z.infer<typeof researchSubmissionPayloadSchema>
export const enqueueResearchSubmissionSchema = researchWorkspaceRequestSchema
  .extend({
    id,
    payload: researchSubmissionPayloadSchema
  })
  .strict()
export type EnqueueResearchSubmissionRequest = z.infer<typeof enqueueResearchSubmissionSchema>
export const researchSubmissionSchema = researchWorkspaceRequestSchema
  .extend({
    id,
    sequence: z.number().int().positive(),
    messageId: id,
    discussionSessionId: id.optional(),
    state: z.enum(['queued', 'sending', 'accepted', 'failed', 'uncertain', 'cancelled']),
    payload: researchSubmissionPayloadSchema,
    error: z.string().max(4000).optional(),
    createdAt: z.number().int().nonnegative(),
    claimToken: id.optional()
  })
  .strict()
export type ResearchSubmission = z.infer<typeof researchSubmissionSchema>
export const researchSubmissionClaimSchema = z.object({ runtimeWriterToken: id }).strict()
export type ResearchSubmissionClaimRequest = z.infer<typeof researchSubmissionClaimSchema>
export const researchSubmissionFinishSchema = z
  .object({
    id,
    claimToken: id,
    runtimeWriterToken: id,
    disposition: z.enum(['accepted', 'failed']),
    error: z.string().max(4000).optional()
  })
  .strict()
export type ResearchSubmissionFinishRequest = z.infer<typeof researchSubmissionFinishSchema>
export const researchSubmissionActionSchema = researchWorkspaceRequestSchema
  .extend({ id, action: z.enum(['retry', 'cancel']) })
  .strict()
export type ResearchSubmissionActionRequest = z.infer<typeof researchSubmissionActionSchema>
const sessionSchema = z.custom<PersistedChatSession>((value) => {
  try {
    persistedChatSessionCodec.parse(value)
    return true
  } catch {
    return false
  }
})
export const researchSubmissionClaimResultSchema = z
  .object({ submission: researchSubmissionSchema, session: sessionSchema })
  .strict()
  .nullable()
export type ResearchSubmissionClaim = z.infer<typeof researchSubmissionClaimResultSchema>
export const researchSubmissionCommandContracts = {
  enqueue: defineApplicationCommandContract(
    validationCodec(z.tuple([enqueueResearchSubmissionSchema])),
    validationCodec(researchSubmissionSchema)
  ),
  list: defineApplicationCommandContract(
    validationCodec(z.tuple([researchWorkspaceRequestSchema])),
    validationCodec(z.array(researchSubmissionSchema))
  ),
  claim: defineApplicationCommandContract(
    validationCodec(z.tuple([researchSubmissionClaimSchema])),
    validationCodec(researchSubmissionClaimResultSchema)
  ),
  finish: defineApplicationCommandContract(
    validationCodec(z.tuple([researchSubmissionFinishSchema])),
    validationCodec(researchSubmissionSchema)
  ),
  act: defineApplicationCommandContract(
    validationCodec(z.tuple([researchSubmissionActionSchema])),
    validationCodec(researchSubmissionSchema)
  )
}
