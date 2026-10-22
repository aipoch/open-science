import type { PersistedChatSession } from '../../../../shared/session-persistence'
import {
  isSessionWaitReason,
  projectSessionActionability,
  type SessionActionabilityProjection,
  type SessionActionabilityFacts
} from '@/stores/session-actionability'
import type { SessionWaitReason as StoreSessionWaitReason } from '../../../../shared/session-persistence'
import { hasCurrentRunningDelegatedAttempt } from '../../../../shared/delegated-work-projection'

import { hasAnswerableDelegatedQuestion } from './subagent-release-projection'

export type SessionWaitReason = StoreSessionWaitReason

export { isSessionWaitReason }

export const projectPresentedSessionActionability = (
  session: PersistedChatSession,
  facts: Pick<SessionActionabilityFacts, 'credentialPending' | 'rootPermissionPending'> = {}
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
