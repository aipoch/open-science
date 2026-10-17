import type { PersistedChatSession } from '../../../../shared/session-persistence'
import {
  isSessionWaitReason,
  projectSessionActionability,
  type SessionActionabilityProjection,
  type SessionActionabilityFacts,
  type SessionWaitReason as StoreSessionWaitReason
} from '@/stores/session-store'
import { hasCurrentRunningDelegatedAttempt } from '../../../../shared/delegated-work-projection'

import { hasAnswerableDelegatedQuestion } from './subagent-release-projection'

export type SessionWaitReason = StoreSessionWaitReason

export { isSessionWaitReason }

export const projectPresentedSessionActionability = (
  session: PersistedChatSession,
  facts: Pick<SessionActionabilityFacts, 'credentialPending'> = {}
): SessionActionabilityProjection =>
  projectSessionActionability(session, {
    presentedWaitReason:
      facts.credentialPending || hasAnswerableDelegatedQuestion(session)
        ? 'waiting-for-user'
        : undefined,
    hasRunningWork: hasCurrentRunningDelegatedAttempt(session),
    ...facts
  })

export const resolveSessionWaitReason = (
  session: PersistedChatSession
): SessionWaitReason | undefined => projectPresentedSessionActionability(session).waitReason
