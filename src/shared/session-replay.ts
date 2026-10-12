import {
  readObservationBindingsRequestSchema,
  readObservationBindingsResultSchema
} from './research-replay-observations'
import { persistedChatSessionCodec } from './session-persistence'
import { z } from 'zod'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'

const identity = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\s/\\]+$/)
  .refine((value) => value !== '.' && value !== '..' && !value.includes('\0'))
export const sessionReplayRequestSchema = z
  .object({
    projectId: identity,
    sourceSessionId: identity
  })
  .strict()
export type SessionReplayRequest = z.infer<typeof sessionReplayRequestSchema>
const sessionDiscussionMatchSchema = z.object({ sessionId: identity }).strict().nullable()
export type SessionDiscussionMatch = z.infer<typeof sessionDiscussionMatchSchema>
export const sessionReplayListRequestSchema = z.object({ projectId: identity }).strict()
export type SessionReplayListRequest = z.infer<typeof sessionReplayListRequestSchema>
export const replayViewStateSchema = z
  .object({
    fingerprint: z.string().min(1).max(1024),
    generatorVersion: z.number().int().positive(),
    presentationVersion: z.number().int().positive().optional(),
    // Local viewing state only. Legacy checkpoints used reconstructed presentation time.
    clock: z.enum(['presentation', 'recorded']).optional(),
    branchId: z.string().min(1).max(1024),
    stepId: z.string().min(1).max(2048).optional(),
    stepOffsetMs: z.number().finite().nonnegative().optional(),
    anchor: z
      .object({
        kind: z.enum([
          'message',
          'activity',
          'notebook-run',
          'artifact-version',
          'upload-version',
          'review'
        ]),
        id: z.string().min(1).max(1024)
      })
      .strict()
      .optional(),
    timeMs: z.number().finite().nonnegative(),
    branchPositions: z
      .array(
        z
          .object({
            branchId: z.string().min(1).max(1024),
            clock: z.enum(['presentation', 'recorded']).optional(),
            stepId: z.string().min(1).max(2048).optional(),
            stepOffsetMs: z.number().finite().nonnegative(),
            timeMs: z.number().finite().nonnegative()
          })
          .strict()
      )
      .max(512)
      .optional(),
    // Keep legacy rates readable; playback normalizes them to the current default.
    rate: z.union([z.literal(0.5), z.literal(1), z.literal(1.5), z.literal(2), z.literal(4)])
  })
  .strict()
export type ReplayViewState = z.infer<typeof replayViewStateSchema>
export const saveSessionReplayProgressRequestSchema = sessionReplayRequestSchema
  .extend({
    state: replayViewStateSchema,
    expectedRevision: z.number().int().nonnegative()
  })
  .strict()
export type SaveSessionReplayProgressRequest = z.infer<
  typeof saveSessionReplayProgressRequestSchema
>

const replayEvidenceReferenceSchema = z
  .object({
    kind: z.enum([
      'message',
      'activity',
      'notebook-run',
      'artifact-version',
      'upload-version',
      'review'
    ]),
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
export const REPLAY_CAPTURE_RECORD_LIMIT = 64 * 1024
export const REPLAY_CAPTURE_TOTAL_LIMIT = 512 * 1024
export const replayCapturedRecordSchema = z
  .object({
    id: z.string().min(1).max(2048),
    scope: z.enum(['step', 'background']),
    title: z.string().max(240),
    text: z.string().max(REPLAY_CAPTURE_RECORD_LIMIT),
    status: z.enum(['recorded', 'unavailable']),
    truncated: z.boolean()
  })
  .strict()
export type ReplayCapturedRecord = z.infer<typeof replayCapturedRecordSchema>

export const sessionDiscussionSnapshotSchema = sessionReplayRequestSchema
  .extend({
    id: identity,
    sourceTitle: z.string().max(4096),
    scope: z.enum(['step', 'session']).optional(),
    fingerprint: z.string().min(1).max(1024),
    branchId: z.string().min(1).max(1024),
    stepId: z.string().min(1).max(2048),
    stepOffsetMs: z.number().finite().nonnegative().optional(),
    recordedAt: z.number().finite().nonnegative().optional(),
    // The Stage retains twelve cards with up to eight activities, plus material references.
    // Keep their entire immutable snapshot while bounding the separate message quote.
    evidence: z.array(replayEvidenceReferenceSchema).max(256),
    excerpt: z.string().max(12_000),
    stepTitle: z.string().max(240).optional(),
    branchIndex: z.number().int().nonnegative().optional(),
    stepNumber: z.number().int().positive().optional(),
    phase: z.enum(['input', 'activity', 'result']).optional(),
    records: z
      .array(replayCapturedRecordSchema)
      .max(256)
      .refine(
        (records) =>
          records.reduce((size, record) => size + record.text.length, 0) <=
            REPLAY_CAPTURE_TOTAL_LIMIT &&
          new Set(records.map((record) => record.id)).size === records.length,
        { message: 'Replay captured records exceed their budget or repeat an identity.' }
      )
      .optional()
  })
  .strict()
  .refine(
    (context) =>
      context.evidence.every(
        (reference) =>
          reference.projectId === context.projectId &&
          reference.sessionId === context.sourceSessionId
      ),
    { message: 'Replay evidence must belong to the source Session.' }
  )
export type SessionDiscussionSnapshot = z.infer<typeof sessionDiscussionSnapshotSchema>
export const saveSessionDiscussionSnapshotRequestSchema = sessionReplayRequestSchema
  .extend({
    context: sessionDiscussionSnapshotSchema
  })
  .strict()
  .refine(
    (request) =>
      request.projectId === request.context.projectId &&
      request.sourceSessionId === request.context.sourceSessionId,
    { message: 'Session discussion snapshot identity does not match the request.' }
  )
export type SaveSessionDiscussionSnapshotRequest = z.infer<
  typeof saveSessionDiscussionSnapshotRequestSchema
>
export const getSessionDiscussionSnapshotRequestSchema = z
  .object({ projectId: identity, id: identity })
  .strict()
export type GetSessionDiscussionSnapshotRequest = z.infer<
  typeof getSessionDiscussionSnapshotRequestSchema
>

const viewSnapshotSchema = z
  .object({
    state: replayViewStateSchema,
    revision: z.number().int().positive()
  })
  .strict()
export const sessionReplaySnapshotSchema = sessionReplayRequestSchema
  .extend({
    sourceStatus: z.enum(['available', 'archived', 'missing', 'unreadable']),
    sourceTitle: z.string().optional(),
    view: viewSnapshotSchema.optional()
  })
  .strict()
export type SessionReplaySnapshot = z.infer<typeof sessionReplaySnapshotSchema>
export type SessionReplayProgressSnapshot = z.infer<typeof viewSnapshotSchema>
const saveViewResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('saved'), revision: z.number().int().positive() }).strict(),
  z.object({ status: z.literal('conflict'), snapshot: viewSnapshotSchema.nullable() }).strict()
])
export type SaveSessionReplayProgressResult = z.infer<typeof saveViewResultSchema>

export const unlinkSessionReadingRequestSchema = z
  .object({
    projectId: identity,
    sessionId: identity,
    sourceSessionId: identity,
    expectedRevision: z.number().int().nonnegative()
  })
  .strict()
export type UnlinkSessionReadingRequest = z.infer<typeof unlinkSessionReadingRequestSchema>

export const setResearchMembershipRequestSchema = z
  .object({
    projectId: identity,
    sessionId: identity,
    expectedRevision: z.number().int().nonnegative(),
    source: sessionReplayRequestSchema.extend({ importId: identity }).strict().optional()
  })
  .strict()
export type SetResearchMembershipRequest = z.infer<typeof setResearchMembershipRequestSchema>

export const sessionReplayCommandContracts = {
  readObservationBindings: defineApplicationCommandContract(
    validationCodec(z.tuple([readObservationBindingsRequestSchema])),
    validationCodec(readObservationBindingsResultSchema)
  ),
  setResearchMembership: defineApplicationCommandContract(
    validationCodec(z.tuple([setResearchMembershipRequestSchema])),
    persistedChatSessionCodec
  ),
  findDiscussion: defineApplicationCommandContract(
    validationCodec(z.tuple([sessionReplayRequestSchema])),
    validationCodec(sessionDiscussionMatchSchema)
  ),
  unlinkSession: defineApplicationCommandContract(
    validationCodec(z.tuple([unlinkSessionReadingRequestSchema])),
    validationCodec(z.void())
  ),
  get: defineApplicationCommandContract(
    validationCodec(z.tuple([sessionReplayRequestSchema])),
    validationCodec(sessionReplaySnapshotSchema)
  ),
  list: defineApplicationCommandContract(
    validationCodec(z.tuple([sessionReplayListRequestSchema])),
    validationCodec(z.array(sessionReplaySnapshotSchema))
  ),
  saveView: defineApplicationCommandContract(
    validationCodec(z.tuple([saveSessionReplayProgressRequestSchema])),
    validationCodec(saveViewResultSchema)
  ),
  saveSelectionSnapshot: defineApplicationCommandContract(
    validationCodec(z.tuple([saveSessionDiscussionSnapshotRequestSchema])),
    validationCodec(z.void())
  ),
  getSelectionSnapshot: defineApplicationCommandContract(
    validationCodec(z.tuple([getSessionDiscussionSnapshotRequestSchema])),
    validationCodec(sessionDiscussionSnapshotSchema.optional())
  ),
  listSelectionSnapshots: defineApplicationCommandContract(
    validationCodec(z.tuple([sessionReplayRequestSchema])),
    validationCodec(z.array(sessionDiscussionSnapshotSchema))
  )
}
