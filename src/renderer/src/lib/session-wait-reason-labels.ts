import type { SessionWaitReason } from '../../../shared/session-persistence'

export const sessionWaitReasonLabelKeys = {
  'waiting-for-user': 'Waiting for your answer',
  'waiting-permission': 'Waiting for permission',
  'waiting-plan-approval': 'Waiting for plan approval'
} as const satisfies Record<SessionWaitReason, string>
