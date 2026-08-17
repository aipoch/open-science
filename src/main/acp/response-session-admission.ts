import type { AcpPermissionResponse, AcpStateSnapshot, ElicitationResponse } from '../../shared/acp'

type AcpResponseAdmissionSnapshot = Pick<
  AcpStateSnapshot,
  'pendingPermissions' | 'pendingElicitations'
>

const assertMatchingSession = (
  authoritativeSessionId: string,
  suppliedSessionId: string | undefined,
  responseKind: string
): void => {
  if (suppliedSessionId && suppliedSessionId !== authoritativeSessionId) {
    throw new Error(`${responseKind} Session does not match the pending request.`)
  }
}

const resolvePermissionResponseSessionId = (
  snapshot: AcpResponseAdmissionSnapshot,
  response: AcpPermissionResponse
): string => {
  // A live request id is authoritative. The restored locator is only an admission locator when no
  // live request exists; the permission owner still validates its durable authority before mutation.
  const pending = snapshot.pendingPermissions.find(
    (request) => request.requestId === response.requestId
  )
  if (pending) {
    assertMatchingSession(pending.sessionId, response.restored?.sessionId, 'Permission response')
    return pending.sessionId
  }
  if (response.restored) return response.restored.sessionId
  throw new Error('Unknown permission request.')
}

const resolveElicitationResponseSessionId = (
  snapshot: AcpResponseAdmissionSnapshot,
  response: ElicitationResponse
): string => {
  if (response.request && response.request.requestId !== response.requestId) {
    throw new Error('Structured input response request does not match its restored authority.')
  }

  // Detached durable questions and delegated questions are absent from the live ACP queue. Their
  // owners validate the echoed request/project authority after this Session admission check.
  const pending = snapshot.pendingElicitations?.find(
    (request) => request.requestId === response.requestId
  )
  if (pending) {
    assertMatchingSession(
      pending.sessionId,
      response.request?.sessionId,
      'Structured input response'
    )
    assertMatchingSession(
      pending.sessionId,
      response.delegatedQuestion?.sessionId,
      'Structured input response'
    )
    return pending.sessionId
  }

  const restoredSessionId = response.request?.sessionId
  const delegatedSessionId = response.delegatedQuestion?.sessionId
  if (restoredSessionId && delegatedSessionId && restoredSessionId !== delegatedSessionId) {
    throw new Error('Structured input response Session locators do not match.')
  }
  if (delegatedSessionId) return delegatedSessionId
  if (restoredSessionId) return restoredSessionId
  throw new Error('Unknown structured input request.')
}

export { resolveElicitationResponseSessionId, resolvePermissionResponseSessionId }
