import { formatFallbackSessionDetails } from '../../../shared/session-details'
import {
  isHiddenControlMessage,
  isHumanUserMessage,
  sessionRevision
} from '../../../shared/session-persistence'
import type {
  PersistedChatMessage,
  PersistedChatSession
} from '../../../shared/session-persistence'

type SessionDetailsPatch = Pick<
  PersistedChatSession,
  'title' | 'description' | 'sessionDetailsSource' | 'sessionDetailsGenerationEligible'
>

const qualifiesForSessionDetails = (message: PersistedChatMessage): boolean =>
  isHumanUserMessage(message) && !isHiddenControlMessage(message)

const prepareExistingSessionDetails = (
  session: Pick<
    PersistedChatSession,
    'sessionDetailsGenerationEligible' | 'branchSource' | 'sessionDetailsSource' | 'description'
  >,
  message: PersistedChatMessage
): Partial<SessionDetailsPatch> => {
  if (
    session.sessionDetailsGenerationEligible !== true ||
    session.branchSource ||
    (session.sessionDetailsSource === 'fallback' && session.description !== undefined) ||
    !qualifiesForSessionDetails(message)
  ) {
    return {}
  }
  const fallback = formatFallbackSessionDetails(message)
  return {
    title: fallback.title,
    description: fallback.description,
    sessionDetailsSource: 'fallback',
    sessionDetailsGenerationEligible: true
  }
}

const prepareNewRootSessionDetails = (
  message: PersistedChatMessage,
  defaultTitle: string
): SessionDetailsPatch => {
  if (!qualifiesForSessionDetails(message)) {
    return {
      title: defaultTitle,
      description: undefined,
      sessionDetailsSource: undefined,
      sessionDetailsGenerationEligible: true
    }
  }
  const fallback = formatFallbackSessionDetails(message)
  return {
    title: fallback.title,
    description: fallback.description,
    sessionDetailsSource: 'fallback',
    sessionDetailsGenerationEligible: true
  }
}

const projectLegacySessionDetails = (
  session: PersistedChatSession
): Partial<Pick<PersistedChatSession, 'description'>> => {
  if (session.description !== undefined) return {}
  return { description: '' }
}

const projectSessionDetailsAuthority = <Session extends PersistedChatSession>(
  current: Session,
  authority: PersistedChatSession
): Session => ({
  ...current,
  title: authority.title,
  description: authority.description,
  sessionDetailsSource: authority.sessionDetailsSource,
  sessionDetailsGeneration: authority.sessionDetailsGeneration,
  sessionDetailsGenerationEligible: authority.sessionDetailsGenerationEligible,
  revision: Math.max(sessionRevision(current), sessionRevision(authority)),
  updatedAt: Math.max(current.updatedAt, authority.updatedAt)
})

const withAcknowledgedUnsavedTitle = <
  Session extends PersistedChatSession & { unsavedTitle?: true }
>(
  projected: Session,
  durable: PersistedChatSession
): Session => {
  if (projected.unsavedTitle !== true || projected.title !== durable.title) return projected
  const next = { ...projected }
  delete next.unsavedTitle
  return next
}

export {
  prepareExistingSessionDetails,
  prepareNewRootSessionDetails,
  projectLegacySessionDetails,
  projectSessionDetailsAuthority,
  withAcknowledgedUnsavedTitle
}
