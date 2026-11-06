import { create } from 'zustand'
import type {
  DeleteSessionRequest,
  SessionDeletionResult
} from '../../../../shared/session-persistence'
import { useSessionStore } from '../../stores/session-store'
import { deleteSession } from '../session-persistence/session-persistence'

type WorkspaceSessionCleanup = DeleteSessionRequest & {
  result: SessionDeletionResult
  error?: string
  retrying: boolean
}

// A cancelled create may return after its placeholder was deleted or retried. Keep recovery
// under its real identity, independently of the send attempt and of any newer conversation.
const useWorkspaceSessionCleanups = create<{
  cleanups: Record<string, WorkspaceSessionCleanup>
}>(() => ({ cleanups: {} }))
const activeCleanups = new Map<string, Promise<SessionDeletionResult>>()
const cleanupKey = ({ projectId, sessionId }: DeleteSessionRequest): string =>
  JSON.stringify([projectId, sessionId])

const releaseUnsentSession = ({ projectId, sessionId }: DeleteSessionRequest): void => {
  const store = useSessionStore.getState()
  if (store.sessions.some((session) => session.projectId === projectId && session.id === sessionId))
    store.deleteSession(sessionId)
  useSessionStore.setState((state) => {
    if (
      !state.sessions.some(
        (session) =>
          session.projectId === projectId && session.pendingBindingSessionId === sessionId
      )
    )
      return state
    return {
      sessions: state.sessions.map((session) =>
        session.projectId === projectId && session.pendingBindingSessionId === sessionId
          ? { ...session, pendingBindingSessionId: undefined }
          : session
      )
    }
  })
}

const cleanupUnsentWorkspaceSession = (
  { projectId, sessionId }: DeleteSessionRequest,
  detachRuntime?: () => Promise<unknown>
): Promise<SessionDeletionResult> => {
  const request = { projectId, sessionId }
  const key = cleanupKey(request)
  const active = activeCleanups.get(key)
  if (active) return active
  useWorkspaceSessionCleanups.setState(({ cleanups }) =>
    cleanups[key]
      ? { cleanups: { ...cleanups, [key]: { ...cleanups[key], retrying: true } } }
      : { cleanups }
  )
  const operation = Promise.resolve().then(async () => {
    let result: SessionDeletionResult
    let detail: string | undefined
    try {
      // Reuse Main's terminal deletion owner for runtime, JSON and file relations.
      result = await deleteSession(request)
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
      let runtimeDetached = false
      if (detachRuntime) {
        try {
          await detachRuntime()
          runtimeDetached = true
        } catch {
          // Retain the real identity even if the fallback detach also fails.
        }
      }
      result = runtimeDetached
        ? { status: 'failed', reason: 'persistence', runtimeDetached: true }
        : { status: 'failed', reason: 'runtime', runtimeDetached: false }
    }
    if (result.status === 'deleted') releaseUnsentSession(request)
    const incomplete = result.status === 'failed' || result.cleanupPending
    useWorkspaceSessionCleanups.setState(({ cleanups }) => {
      const next = { ...cleanups }
      if (incomplete) next[key] = { ...request, result, error: detail, retrying: false }
      else delete next[key]
      return { cleanups: next }
    })
    if (incomplete)
      console.warn('Unsent Session cleanup incomplete', { ...request, result, error: detail })
    return result
  })
  const settled = operation.finally(() => activeCleanups.delete(key))
  activeCleanups.set(key, settled)
  return settled
}

const retryWorkspaceSessionCleanup = async (request: DeleteSessionRequest): Promise<void> => {
  if (useWorkspaceSessionCleanups.getState().cleanups[cleanupKey(request)])
    await cleanupUnsentWorkspaceSession(request)
}

export { cleanupUnsentWorkspaceSession, retryWorkspaceSessionCleanup, useWorkspaceSessionCleanups }
export type { WorkspaceSessionCleanup }
