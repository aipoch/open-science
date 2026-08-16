import type {
  PersistedChatSession,
  PersistedSessionStatus
} from '../../../../shared/session-persistence'

import { hasAnswerableDelegatedQuestion } from './subagent-release-projection'

export type SessionWaitReason = Extract<
  PersistedSessionStatus,
  'waiting-for-user' | 'waiting-permission' | 'waiting-plan-approval'
>

export const sessionWaitReasonLabelKeys = {
  'waiting-for-user': 'Waiting for your answer',
  'waiting-permission': 'Waiting for permission',
  'waiting-plan-approval': 'Waiting for plan approval'
} as const satisfies Record<SessionWaitReason, string>

export const isSessionWaitReason = (status: string): status is SessionWaitReason =>
  status === 'waiting-for-user' ||
  status === 'waiting-permission' ||
  status === 'waiting-plan-approval'

export const resolveSessionWaitReason = (
  session: PersistedChatSession
): SessionWaitReason | undefined => {
  if (isSessionWaitReason(session.status)) return session.status
  return hasAnswerableDelegatedQuestion(session) ? 'waiting-for-user' : undefined
}
