import { z } from 'zod'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'
import { persistedChatSessionCodec } from './session-persistence'
import {
  getSessionDiscussionSnapshotRequestSchema,
  saveSessionDiscussionSnapshotRequestSchema,
  saveSessionReplayProgressRequestSchema,
  saveViewResultSchema,
  sessionDiscussionMatchSchema,
  sessionDiscussionSnapshotSchema,
  sessionReplayListRequestSchema,
  sessionReplayRequestSchema,
  sessionReplaySnapshotSchema,
  setResearchMembershipRequestSchema,
  unlinkSessionReadingRequestSchema
} from './session-replay'

// Command composition may depend on persistence codecs; replay data remains a lower-level contract.
export const sessionReplayCommandContracts = {
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
