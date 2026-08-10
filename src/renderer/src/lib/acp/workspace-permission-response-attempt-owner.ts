import {
  ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_REARM_FAILED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE,
  type AcpPermissionRequest,
  type AcpRuntimeEvent
} from '../../../../shared/acp'
import type { ChatSession } from '../../stores/session-store'

type PermissionResponseAttempt = {
  accepted: boolean
  rearmed: boolean
  settled: boolean
  authorityRemoved: boolean
  restored: boolean
  sessionId?: string
  promise: Promise<void>
}
type ObservedPermissionLifecycleEvents = { sessionId?: string; eventIds: Set<string> }
type RetiredPermissionResponse = ObservedPermissionLifecycleEvents & { promise: Promise<void> }
type PermissionLifecycleEvent = AcpRuntimeEvent & { permissionRequestId: string }
type PermissionResponseAttemptOwner = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => readonly string[]
  getPromise: (requestId: string) => Promise<void> | undefined
  begin: (requestId: string) => PermissionResponseAttempt
  accept: (requestId: string, attempt: PermissionResponseAttempt) => void
  fail: (requestId: string, attempt: PermissionResponseAttempt) => void
  shouldApplyLifecycle: (event: PermissionLifecycleEvent) => boolean
  observeLifecycle: (event: PermissionLifecycleEvent) => void
  cleanSessions: (sessions: ChatSession[]) => void
  cleanLive: (requests: AcpPermissionRequest[]) => void
}

const createPermissionResponseAttemptOwner = (): PermissionResponseAttemptOwner => {
  const attempts = new Map<string, PermissionResponseAttempt>()
  const observedLifecycleEvents = new Map<string, ObservedPermissionLifecycleEvents>()
  const retiredResponses = new Map<string, RetiredPermissionResponse>()
  const listeners = new Set<() => void>()
  let hiddenRequestIds: readonly string[] = []

  const publish = (): void => {
    hiddenRequestIds = [...new Set([...attempts.keys(), ...retiredResponses.keys()])]
    for (const listener of listeners) listener()
  }
  const release = (requestId: string, attempt?: PermissionResponseAttempt): void => {
    if (attempt && attempts.get(requestId) !== attempt) return
    const activeChanged = attempts.delete(requestId)
    const retiredChanged = retiredResponses.delete(requestId)
    if (activeChanged || retiredChanged) publish()
  }
  const retire = (requestId: string, attempt?: PermissionResponseAttempt): void => {
    if (attempt && attempts.get(requestId) !== attempt) return
    const observed = observedLifecycleEvents.get(requestId)
    const retired = retiredResponses.get(requestId)
    const sessionId = attempt?.sessionId ?? observed?.sessionId ?? retired?.sessionId
    attempts.delete(requestId)
    observedLifecycleEvents.delete(requestId)
    retiredResponses.set(requestId, {
      sessionId,
      eventIds: new Set([...(retired?.eventIds ?? []), ...(observed?.eventIds ?? [])]),
      promise: attempt?.promise ?? retired?.promise ?? Promise.resolve()
    })
    publish()
  }

  return {
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: (): readonly string[] => hiddenRequestIds,
    getPromise: (requestId: string): Promise<void> | undefined =>
      attempts.get(requestId)?.promise ?? retiredResponses.get(requestId)?.promise,
    begin: (requestId: string): PermissionResponseAttempt => {
      const attempt: PermissionResponseAttempt = {
        accepted: false,
        rearmed: false,
        settled: false,
        authorityRemoved: false,
        restored: false,
        promise: Promise.resolve()
      }
      attempts.set(requestId, attempt)
      publish()
      return attempt
    },
    accept: (requestId: string, attempt: PermissionResponseAttempt): void => {
      attempt.accepted = true
      if (attempt.rearmed) release(requestId, attempt)
      else if (attempt.settled || attempt.authorityRemoved) retire(requestId, attempt)
    },
    fail: (requestId: string, attempt: PermissionResponseAttempt): void => {
      if (attempt.settled || attempt.authorityRemoved) retire(requestId, attempt)
      else if (!attempt.accepted) release(requestId, attempt)
    },
    shouldApplyLifecycle: (event: PermissionLifecycleEvent): boolean =>
      event.title !== ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE ||
      !(
        observedLifecycleEvents.get(event.permissionRequestId)?.eventIds.has(event.id) ||
        retiredResponses.get(event.permissionRequestId)?.eventIds.has(event.id)
      ),
    observeLifecycle: (event: PermissionLifecycleEvent): void => {
      const attempt = attempts.get(event.permissionRequestId)
      const settled =
        event.title === ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE ||
        event.title === ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE ||
        event.title === ACP_RESTORED_PERMISSION_REARM_FAILED_EVENT_TITLE
      if (event.title === ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE) {
        const retired = retiredResponses.get(event.permissionRequestId)
        if (retired?.eventIds.has(event.id)) return
        const observed = observedLifecycleEvents.get(event.permissionRequestId) ?? {
          sessionId: event.sessionId,
          eventIds: new Set(retired?.eventIds)
        }
        if (observed.eventIds.has(event.id)) return
        observed.eventIds.add(event.id)
        observedLifecycleEvents.set(event.permissionRequestId, observed)
        if (retired) release(event.permissionRequestId)
        if (attempt) {
          attempt.rearmed = true
          if (attempt.accepted) release(event.permissionRequestId, attempt)
        }
      } else if (settled) {
        if (attempt) {
          attempt.settled = true
          if (attempt.accepted) retire(event.permissionRequestId, attempt)
        } else {
          const observed = observedLifecycleEvents.get(event.permissionRequestId)
          observedLifecycleEvents.set(event.permissionRequestId, {
            sessionId: event.sessionId ?? observed?.sessionId,
            eventIds: new Set([
              ...(retiredResponses.get(event.permissionRequestId)?.eventIds ?? []),
              ...(observed?.eventIds ?? [])
            ])
          })
          retire(event.permissionRequestId)
        }
      }
    },
    cleanSessions: (sessions: ChatSession[]): void => {
      const sessionsById = new Map(sessions.map((session) => [session.id, session]))
      for (const [requestId, attempt] of attempts) {
        if (!attempt.sessionId) continue
        const session = sessionsById.get(attempt.sessionId)
        if (session) {
          const currentRequestId = session.runtimeContext?.permission?.request.requestId
          if (currentRequestId === requestId || !attempt.restored) continue
          attempt.authorityRemoved = true
          if (attempt.accepted) retire(requestId, attempt)
          continue
        }
        observedLifecycleEvents.delete(requestId)
        release(requestId, attempt)
      }
      for (const [requestId, observed] of observedLifecycleEvents) {
        if (!observed.sessionId) continue
        const session = sessionsById.get(observed.sessionId)
        if (session) {
          const currentRequestId = session.runtimeContext?.permission?.request.requestId
          if (currentRequestId === requestId) continue
          retire(requestId)
          continue
        }
        observedLifecycleEvents.delete(requestId)
      }
      for (const [requestId, retired] of retiredResponses) {
        if (retired.sessionId && !sessionsById.has(retired.sessionId)) {
          retiredResponses.delete(requestId)
          publish()
        }
      }
    },
    cleanLive: (requests: AcpPermissionRequest[]): void => {
      const liveRequestIds = new Set(requests.map((request) => request.requestId))
      for (const [requestId, attempt] of attempts) {
        if (attempt.accepted && !attempt.restored && !liveRequestIds.has(requestId)) {
          observedLifecycleEvents.delete(requestId)
          release(requestId, attempt)
        }
      }
    }
  }
}

export { createPermissionResponseAttemptOwner }
