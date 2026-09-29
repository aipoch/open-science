import { z } from 'zod'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'
import { persistedChatSessionCodec } from './session-persistence'
import type { PersistedChatSession } from './session-persistence'

const identity = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\s/\\]+$/)
  .refine((value) => value !== '.' && value !== '..' && !value.includes('\0'))
export const researchWorkspaceRequestSchema = z
  .object({
    projectId: identity,
    sourceSessionId: identity
  })
  .strict()
export type ResearchWorkspaceRequest = z.infer<typeof researchWorkspaceRequestSchema>
export const researchWorkspaceListRequestSchema = z.object({ projectId: identity }).strict()
export type ResearchWorkspaceListRequest = z.infer<typeof researchWorkspaceListRequestSchema>
export const replayViewStateSchema = z
  .object({
    fingerprint: z.string().min(1).max(1024),
    generatorVersion: z.number().int().positive(),
    presentationVersion: z.number().int().positive().optional(),
    branchId: z.string().min(1).max(1024),
    stepId: z.string().min(1).max(2048).optional(),
    stepOffsetMs: z.number().finite().nonnegative().optional(),
    anchor: z
      .object({
        kind: z.enum(['message', 'activity', 'notebook-run', 'artifact-version', 'upload-version']),
        id: z.string().min(1).max(1024)
      })
      .strict()
      .optional(),
    timeMs: z.number().finite().nonnegative(),
    rate: z.union([z.literal(0.5), z.literal(1), z.literal(1.5), z.literal(2)])
  })
  .strict()
export type ReplayViewState = z.infer<typeof replayViewStateSchema>
export const ensureResearchDiscussionRequestSchema = researchWorkspaceRequestSchema
  .extend({
    title: z.string().min(1).max(4096).optional(),
    recreateMissing: z
      .object({
        expectedDiscussionSessionId: identity,
        expectedRevision: z.number().int().nonnegative()
      })
      .strict()
      .optional()
  })
  .strict()
export type EnsureResearchDiscussionRequest = z.infer<typeof ensureResearchDiscussionRequestSchema>
export const saveResearchReplayViewRequestSchema = researchWorkspaceRequestSchema
  .extend({
    state: replayViewStateSchema,
    expectedRevision: z.number().int().nonnegative()
  })
  .strict()
export type SaveResearchReplayViewRequest = z.infer<typeof saveResearchReplayViewRequestSchema>

const replayEvidenceReferenceSchema = z
  .object({
    kind: z.enum(['message', 'activity', 'notebook-run', 'artifact-version', 'upload-version']),
    id: identity,
    projectId: identity,
    sessionId: identity,
    branchId: z.string().min(1).max(1024).optional(),
    agentFrameId: identity.optional(),
    artifactId: identity.optional(),
    fileId: identity.optional(),
    versionId: identity.optional(),
    part: z.enum(['input', 'result', 'record']).optional()
  })
  .strict()
export const replayQuestionContextSchema = researchWorkspaceRequestSchema
  .extend({
    id: identity,
    sourceTitle: z.string().max(4096),
    fingerprint: z.string().min(1).max(1024),
    branchId: z.string().min(1).max(1024),
    stepId: z.string().min(1).max(2048),
    stepOffsetMs: z.number().finite().nonnegative().optional(),
    recordedAt: z.number().finite().nonnegative().optional(),
    // The Stage retains twelve cards with up to eight activities, plus material references.
    // Keep their entire immutable snapshot while bounding the separate message quote.
    evidence: z.array(replayEvidenceReferenceSchema).max(256),
    excerpt: z.string().max(12_000)
  })
  .strict()
  .refine(
    (context) =>
      context.evidence.every(
        (reference) =>
          reference.projectId === context.projectId &&
          reference.sessionId === context.sourceSessionId
      ),
    { message: 'Replay evidence must belong to the source research.' }
  )
export type ReplayQuestionContext = z.infer<typeof replayQuestionContextSchema>
export const saveReplayQuestionContextRequestSchema = researchWorkspaceRequestSchema
  .extend({
    context: replayQuestionContextSchema
  })
  .strict()
  .refine(
    (request) =>
      request.projectId === request.context.projectId &&
      request.sourceSessionId === request.context.sourceSessionId,
    { message: 'Replay question context identity does not match the request.' }
  )
export type SaveReplayQuestionContextRequest = z.infer<
  typeof saveReplayQuestionContextRequestSchema
>
export const getReplayQuestionContextRequestSchema = z
  .object({ projectId: identity, id: identity })
  .strict()
export type GetReplayQuestionContextRequest = z.infer<typeof getReplayQuestionContextRequestSchema>

const sessionSchema = z.custom<PersistedChatSession>((value) => {
  try {
    persistedChatSessionCodec.parse(value)
    return true
  } catch {
    return false
  }
})
const viewSnapshotSchema = z
  .object({
    state: replayViewStateSchema,
    revision: z.number().int().positive()
  })
  .strict()
export const researchWorkspaceSnapshotSchema = researchWorkspaceRequestSchema
  .extend({
    sourceStatus: z.enum(['available', 'archived', 'missing', 'unreadable', 'not-imported']),
    sourceTitle: z.string().optional(),
    discussionSessionId: identity.optional(),
    discussionStatus: z.enum([
      'none',
      'creating',
      'available',
      'archived',
      'missing',
      'unreadable'
    ]),
    discussionSession: sessionSchema.optional(),
    linkRevision: z.number().int().nonnegative(),
    view: viewSnapshotSchema.optional()
  })
  .strict()
export type ResearchWorkspaceSnapshot = z.infer<typeof researchWorkspaceSnapshotSchema>
export type ResearchReplayViewSnapshot = z.infer<typeof viewSnapshotSchema>
const saveViewResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('saved'), revision: z.number().int().positive() }).strict(),
  z.object({ status: z.literal('conflict'), snapshot: viewSnapshotSchema.nullable() }).strict()
])
export type SaveResearchReplayViewResult = z.infer<typeof saveViewResultSchema>

export const researchWorkspaceCommandContracts = {
  get: defineApplicationCommandContract(
    validationCodec(z.tuple([researchWorkspaceRequestSchema])),
    validationCodec(researchWorkspaceSnapshotSchema)
  ),
  list: defineApplicationCommandContract(
    validationCodec(z.tuple([researchWorkspaceListRequestSchema])),
    validationCodec(z.array(researchWorkspaceSnapshotSchema))
  ),
  ensureDiscussion: defineApplicationCommandContract(
    validationCodec(z.tuple([ensureResearchDiscussionRequestSchema])),
    validationCodec(researchWorkspaceSnapshotSchema)
  ),
  saveView: defineApplicationCommandContract(
    validationCodec(z.tuple([saveResearchReplayViewRequestSchema])),
    validationCodec(saveViewResultSchema)
  ),
  saveQuestionContext: defineApplicationCommandContract(
    validationCodec(z.tuple([saveReplayQuestionContextRequestSchema])),
    validationCodec(z.void())
  ),
  getQuestionContext: defineApplicationCommandContract(
    validationCodec(z.tuple([getReplayQuestionContextRequestSchema])),
    validationCodec(replayQuestionContextSchema.optional())
  ),
  listQuestionContexts: defineApplicationCommandContract(
    validationCodec(z.tuple([researchWorkspaceRequestSchema])),
    validationCodec(z.array(replayQuestionContextSchema))
  )
}
