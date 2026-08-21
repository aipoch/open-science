import type { DurableAttempt, DurableChild, DurableSnapshot } from './delegated-work-record-types'

type SessionIdentity = DurableSnapshot['session']

const sameSession = (left: SessionIdentity, right: SessionIdentity): boolean =>
  left.projectId === right.projectId && left.sessionId === right.sessionId

const currentAttempt = (child: DurableChild): DurableAttempt =>
  child.attempts[child.attempts.length - 1]

type DurableSettledAttemptStatus = Exclude<DurableAttempt['status'], 'running'>

const isDelegatedAttemptSettled = (
  status: DurableAttempt['status']
): status is DurableSettledAttemptStatus =>
  status === 'completed' || status === 'cancelled' || status === 'error'

export { currentAttempt, isDelegatedAttemptSettled, sameSession }
export type { DurableSettledAttemptStatus }
