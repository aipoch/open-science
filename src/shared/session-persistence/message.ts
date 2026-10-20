import { MAX_ACP_RUNTIME_EVENTS } from '../acp'
import type {
  MessagePart,
  PersistedChatMessage,
  SessionReference
} from '../session-message-contract'
export {
  type LiteratureReference,
  type LiteratureScopeReference,
  type MessageAttribution,
  type MessagePart,
  type PersistedActivityGroup,
  type PersistedArtifact,
  type PersistedArtifactKind,
  type PersistedChatMessage,
  type PersistedMessageAgentTarget,
  type PersistedMessageImage,
  type PersistedMessagePresentation,
  type PersistedMessageRole,
  type PersistedMessageStatus,
  type PersistedToolActivity,
  type PersistedToolActivityDisposition,
  type PersistedToolActivityStatus,
  type PersistedToolCallLocation,
  type SessionReference
} from '../session-message-contract'

export const MAX_SESSION_REFERENCES_PER_MESSAGE = 5

export const MAX_SESSION_REFERENCE_ID_LENGTH = 512

export const MAX_SESSION_REFERENCE_TITLE_LENGTH = 4096

export const MAX_LITERATURE_SCOPE_ID_LENGTH = 512

export const MAX_LITERATURE_SCOPE_NAME_LENGTH = 4096

export const collectSessionReferences = (
  parts: readonly MessagePart[] | undefined
): SessionReference[] => {
  const references: SessionReference[] = []
  for (const part of parts ?? []) {
    if (
      part.type !== 'session' ||
      references.some((reference) => reference.sessionId === part.sessionId)
    ) {
      continue
    }
    references.push({ type: 'session', sessionId: part.sessionId, title: part.title })
    if (references.length >= MAX_SESSION_REFERENCES_PER_MESSAGE) break
  }
  return references
}

// Runtime recovery can replay only its bounded suffix. Once a projection is terminal, older IDs no
// longer provide supported duplicate-suppression coverage and must not grow the Session forever.
export const retainRecentSessionEventIds = (eventIds: readonly string[]): string[] => {
  if (eventIds.length <= MAX_ACP_RUNTIME_EVENTS) return [...eventIds]

  const recent: string[] = []
  const seen = new Set<string>()
  for (
    let index = eventIds.length - 1;
    index >= 0 && recent.length < MAX_ACP_RUNTIME_EVENTS;
    index--
  ) {
    const eventId = eventIds[index]
    if (eventId === undefined || seen.has(eventId)) continue
    seen.add(eventId)
    recent.push(eventId)
  }
  return recent.reverse()
}

export const isHiddenControlMessage = (
  message: Pick<PersistedChatMessage, 'turnIntent'>
): boolean => message.turnIntent === 'save-as-skill'

export const isHumanUserMessage = (
  message: Pick<PersistedChatMessage, 'role' | 'attribution' | 'presentation' | 'relayedFrom'>
): boolean =>
  message.role === 'user' && !message.attribution && !message.presentation && !message.relayedFrom
