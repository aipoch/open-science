import { isDeepStrictEqual } from 'node:util'

import {
  materializeSessionConversationGraph,
  SessionRevisionConflictError,
  sessionRevision,
  type PersistedChatSession,
  type SessionConflictRebaseField
} from '../../shared/session-persistence'

export type MainSessionConflictRebaseField =
  SessionConflictRebaseField | 'specialistId' | 'specialistBindingPending'

export type MainSaveSessionOptions = {
  conflictRebaseFields?: MainSessionConflictRebaseField[]
}

type RebaseFields = NonNullable<MainSaveSessionOptions['conflictRebaseFields']>

export const rebaseSafeSessionFields = (
  authoritative: PersistedChatSession,
  submitted: PersistedChatSession,
  fields: RebaseFields
): PersistedChatSession => {
  const rebased = { ...authoritative }
  for (const field of fields) {
    switch (field) {
      case 'title':
        rebased.title = submitted.title
        break
      case 'permissionProfile':
        rebased.permissionProfile = submitted.permissionProfile
        break
      case 'autoReviewEnabled':
        rebased.autoReviewEnabled = submitted.autoReviewEnabled
        break
      case 'enabledComputeHosts':
        // Retained in the wire-compatible enum, but this field is now changed only by its command.
        break
      case 'pinned':
        rebased.pinned = submitted.pinned
        break
      case 'specialistId':
        rebased.specialistId = submitted.specialistId
        break
      case 'specialistBindingPending':
        rebased.specialistBindingPending = submitted.specialistBindingPending
        break
    }
  }
  rebased.updatedAt = Math.max(authoritative.updatedAt, submitted.updatedAt) + 1
  return rebased
}

export const resolveRevisionedSessionSave = (
  authoritative: PersistedChatSession | undefined,
  submitted: PersistedChatSession,
  conflictRebaseFields: RebaseFields = []
): Readonly<{ session: PersistedChatSession; expectedRevision: number }> => {
  const expectedRevision = sessionRevision(submitted)
  if (!authoritative || expectedRevision === sessionRevision(authoritative)) {
    return { session: submitted, expectedRevision }
  }
  const submittedGraph = materializeSessionConversationGraph(submitted).conversationGraph
  const authoritativeGraph = materializeSessionConversationGraph(authoritative).conversationGraph
  if (conflictRebaseFields.length === 0 || !isDeepStrictEqual(submittedGraph, authoritativeGraph)) {
    throw new SessionRevisionConflictError(expectedRevision, sessionRevision(authoritative))
  }
  return {
    session: rebaseSafeSessionFields(authoritative, submitted, conflictRebaseFields),
    expectedRevision: sessionRevision(authoritative)
  }
}
