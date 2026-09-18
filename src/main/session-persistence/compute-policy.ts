import { decodeSessionEnvelope } from '../../shared/session-persistence'

export type SessionComputePolicy =
  | { status: 'ready'; limit: number | null; revision: number }
  | {
      status: 'blocked'
      reason:
        | 'unavailable'
        | 'identity-conflict'
        | 'missing'
        | 'deleted'
        | 'unsupported-version'
        | 'invalid-policy'
    }

// A read-only view of Session authority. It never repairs or materializes conversation content.
export function decodeSessionComputePolicy(
  value: unknown,
  sessionId: string
): SessionComputePolicy {
  const envelope = decodeSessionEnvelope(value)
  if (envelope.status !== 'ok')
    return {
      status: 'blocked',
      reason: envelope.status === 'unsupported-version' ? 'unsupported-version' : 'invalid-policy'
    }
  const session = envelope.session
  if (session.id !== sessionId) return { status: 'blocked', reason: 'identity-conflict' }
  if (session.conversationGraph === undefined && !Array.isArray(session.messages)) {
    return { status: 'blocked', reason: 'invalid-policy' }
  }
  const revision = session.revision === undefined ? 0 : session.revision
  const limit = session.computeConcurrencyLimit
  if (
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0 ||
    (limit !== undefined &&
      (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 500))
  ) {
    return { status: 'blocked', reason: 'invalid-policy' }
  }
  return {
    status: 'ready',
    limit: limit === undefined ? null : (limit as number),
    revision: revision as number
  }
}

export type SessionComputePolicyAuthority = {
  // Must be read-only and must not call back into Compute or catalog hydration. The dispatcher
  // serializes this read with admission and policy writes; an adapter must not acquire their locks.
  resolve(sessionId: string, projectId?: string): Promise<SessionComputePolicy>
  save(sessionId: string, limit: number): Promise<void>
}
