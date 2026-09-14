import { z } from 'zod'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'
import { sanitizeAnnotation } from './annotations'
import { PERMISSION_PROFILE_IDS } from './permission-profiles'
import { sessionAgentConfigurationSchema } from './session-configuration'
import { sanitizeMessageParts, sanitizeMessagePdfContextSnapshot } from './session-persistence'
import { uploadedAttachmentSchema, MAX_COMPOSER_ATTACHMENTS } from './uploads'

const identity = z.string().min(1)
const source = z
  .object({
    sourceKind: z.enum(['upload-version', 'artifact-version', 'literature-attachment-version']),
    sourceFileId: identity.optional(),
    sourceVersionId: identity
  })
  .strict()

// Reuse the message boundary validators; a rejected element must fail the entire queued input,
// rather than silently dropping part of a draft that the user believes was saved.
const messagePart = z.unknown().transform((value, context) => {
  const parts = sanitizeMessageParts([value])
  if (parts.length !== 1) {
    context.addIssue({ code: 'custom', message: 'Invalid queued message part.' })
    return z.NEVER
  }
  return parts[0]
})
const pastedText = z
  .object({
    type: z.literal('pasted-text'),
    id: identity,
    text: z.string(),
    attachmentId: identity
  })
  .strict()
const annotation = z.unknown().transform((value, context) => {
  const result = sanitizeAnnotation(value)
  if (!result) {
    context.addIssue({ code: 'custom', message: 'Invalid queued annotation.' })
    return z.NEVER
  }
  return result
})
const pdfContext = z.unknown().transform((value, context) => {
  const result = sanitizeMessagePdfContextSnapshot(value)
  if (!result) {
    context.addIssue({ code: 'custom', message: 'Invalid queued PDF context.' })
    return z.NEVER
  }
  return result
})

const pendingInputContent = z
  .object({
    schemaVersion: z.literal(1),
    id: identity,
    projectId: identity,
    sessionId: identity,
    agentFrameId: identity,
    messageBranchId: identity,
    text: z.string(),
    forcedSkillIds: z.array(identity),
    permissionProfile: z.enum(PERMISSION_PROFILE_IDS),
    agentConfiguration: sessionAgentConfigurationSchema.optional(),
    specialistId: identity.nullable().optional(),
    agentFrameworkId: z.enum(['claude-code', 'opencode', 'codex', 'codebuddy']).optional(),
    agentBackendId: identity.optional(),
    cwd: z.string().optional(),
    revisionMessageId: identity.optional(),
    snapshot: z
      .object({
        draftKey: identity,
        version: z.number().int().nonnegative(),
        doc: z.object({ nodes: z.array(z.union([pastedText, messagePart])) }).strict(),
        annotations: z.array(annotation),
        attachments: z
          .array(uploadedAttachmentSchema.omit({ draftReceipt: true }))
          .max(MAX_COMPOSER_ATTACHMENTS),
        automaticReadingEnabled: z.boolean().optional(),
        pdfContext: pdfContext.optional(),
        pdfReadingPosition: z
          .object({
            pageNumber: z.number().int().positive(),
            pageCount: z.number().int().positive()
          })
          .strict()
          .optional(),
        pdfReadingPositionSource: z
          .union([source, z.object({ attachmentId: identity }).strict()])
          .optional(),
        pendingPdfContextAttachmentIds: z.array(identity).optional(),
        pendingPdfContextVersions: z.array(source).optional()
      })
      .strict()
  })
  .strict()

const hasUploadedPastedText = (value: {
  snapshot: {
    doc: { nodes: readonly { type: string; attachmentId?: string }[] }
    attachments: readonly { id: string }[]
  }
}): boolean =>
  value.snapshot.doc.nodes.every(
    (node) =>
      node.type !== 'pasted-text' ||
      value.snapshot.attachments.some((file) => file.id === node.attachmentId)
  )
const pastedTextError = { message: 'Pasted text has not finished uploading.' }

// Admission can contain a staging path; only Main publication can turn it into an immutable version.
export const pendingInputContentSchema = pendingInputContent.refine(
  hasUploadedPastedText,
  pastedTextError
)
const persistedAttachmentSchema = uploadedAttachmentSchema
  .omit({ path: true, draftReceipt: true, checksum: true })
  .extend({
    versionId: identity,
    versionNumber: z.number().int().positive(),
    sha256: z.string().optional()
  })
export const persistedPendingInputContentSchema = pendingInputContent
  .extend({
    snapshot: pendingInputContent.shape.snapshot.extend({
      attachments: z.array(persistedAttachmentSchema).max(MAX_COMPOSER_ATTACHMENTS)
    })
  })
  .refine(hasUploadedPastedText, pastedTextError)

export type PendingInputContent = z.infer<typeof pendingInputContentSchema>
export type PersistedPendingInputContent = z.infer<typeof persistedPendingInputContentSchema>
export type PendingInputPhase =
  'queued' | 'interrupting' | 'sending' | 'error' | 'recovery-required'
export type PendingInput = PersistedPendingInputContent & {
  revision: number
  position: number
  phase: PendingInputPhase
  error?: { kind: 'branch' | 'send' | 'edit' | 'cancel'; detail?: string }
  deferredUntilIdle?: boolean
}
export type PendingInputSnapshot = { generation: string; revision: number; items: PendingInput[] }
export type PendingInputCommand =
  | { operation: 'list' }
  | { operation: 'enqueue'; content: PendingInputContent; expectedRevision?: number }
  | { operation: 'remove' | 'resume' | 'edit'; id: string; revision: number }
  | { operation: 'claim'; id: string; revision: number; claimId: string; prioritize?: boolean }
  | { operation: 'move'; id: string; revision: number; targetId: string; edge: 'before' | 'after' }
  | {
      operation: 'settle'
      id: string
      revision: number
      claimId?: string
      outcome: 'sent' | 'deferred' | 'error' | 'uncertain'
      error?: PendingInput['error']
    }
export type PendingInputResult = PendingInputSnapshot & { item?: PendingInput }

export const pendingInputMatchesContent = (
  saved: PendingInput,
  expected: PendingInputContent | PersistedPendingInputContent
): boolean => {
  const content = persistedPendingInputContentSchema.strip().parse(saved)
  const canonical = (input: PendingInputContent | PersistedPendingInputContent): string =>
    JSON.stringify(
      {
        ...input,
        snapshot: {
          ...input.snapshot,
          attachments: input.snapshot.attachments.map((file, index) => ({
            id: file.id,
            name: file.originalName,
            size: file.size,
            mimeType: file.mimeType,
            ...(expected.snapshot.attachments[index]?.versionId
              ? { versionId: file.versionId }
              : {})
          }))
        }
      },
      (_key, value: unknown) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
            )
          : value
    )
  return canonical(content) === canonical(expected)
}

export const pendingInputCommandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list') }).strict(),
  z
    .object({
      operation: z.literal('enqueue'),
      content: pendingInputContentSchema,
      expectedRevision: z.number().int().positive().optional()
    })
    .strict(),
  ...(['remove', 'resume', 'edit'] as const).map((operation) =>
    z
      .object({
        operation: z.literal(operation),
        id: identity,
        revision: z.number().int().positive()
      })
      .strict()
  ),
  z
    .object({
      operation: z.literal('claim'),
      id: identity,
      claimId: identity,
      revision: z.number().int().positive(),
      prioritize: z.boolean().optional()
    })
    .strict(),
  z
    .object({
      operation: z.literal('move'),
      id: identity,
      revision: z.number().int().positive(),
      targetId: identity,
      edge: z.enum(['before', 'after'])
    })
    .strict(),
  z
    .object({
      operation: z.literal('settle'),
      id: identity,
      revision: z.number().int().positive(),
      claimId: identity.optional(),
      outcome: z.enum(['sent', 'deferred', 'error', 'uncertain']),
      error: z
        .object({
          kind: z.enum(['branch', 'send', 'edit', 'cancel']),
          detail: z.string().optional()
        })
        .strict()
        .optional()
    })
    .strict()
])

const pendingInputSchema = persistedPendingInputContentSchema.safeExtend({
  revision: z.number().int().positive(),
  position: z.number().int(),
  phase: z.enum(['queued', 'interrupting', 'sending', 'error', 'recovery-required']),
  error: z
    .object({ kind: z.enum(['branch', 'send', 'edit', 'cancel']), detail: z.string().optional() })
    .optional(),
  deferredUntilIdle: z.boolean().optional()
})
export const pendingInputCommandContract = defineApplicationCommandContract(
  validationCodec(z.tuple([pendingInputCommandSchema])),
  validationCodec(
    z.object({
      generation: identity,
      revision: z.number().int().nonnegative(),
      items: z.array(pendingInputSchema),
      item: pendingInputSchema.optional()
    })
  )
)
