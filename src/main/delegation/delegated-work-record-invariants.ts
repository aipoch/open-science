import type { DurableAttempt, DurableChild, DurableSnapshot } from './delegated-work-record-types'

type SessionIdentity = DurableSnapshot['session']

const sameSession = (left: SessionIdentity, right: SessionIdentity): boolean =>
  left.projectId === right.projectId && left.sessionId === right.sessionId

const currentAttempt = (child: DurableChild): DurableAttempt =>
  child.attempts[child.attempts.length - 1]

export { currentAttempt, sameSession }
