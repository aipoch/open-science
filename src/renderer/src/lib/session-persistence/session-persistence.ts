import { useEffect, useState } from 'react'

import type {
  DeleteSessionRequest,
  LoadAllSessionsResult,
  PersistedChatSession,
  SaveSessionManifestRequest
} from '../../../../shared/session-persistence'
import { toPersistedSession, useSessionStore } from '../../stores/session-store'
import type { ChatSession } from '../../stores/session-store'

type SessionPersistenceApi = {
  loadAll: () => Promise<LoadAllSessionsResult>
  saveSession: (session: PersistedChatSession) => Promise<void>
  deleteSession: (request: DeleteSessionRequest) => Promise<void>
  saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
}

type SessionStoreSnapshot = {
  sessions: ChatSession[]
  selectedSessionId: string | undefined
}

// Keeps persistence failures visible to developers without blocking the chat UI.
const reportPersistenceError = (error: unknown): void => {
  console.warn('Session persistence failed', error)
}

// Hydrates the in-memory session store from the per-session files loaded by the main process.
const loadPersistedSessions = async (api: SessionPersistenceApi): Promise<void> => {
  const { sessions, manifest } = await api.loadAll()

  useSessionStore.getState().hydrateSessions(sessions, manifest)
}

// Indexes sessions by id for reference-equality diffing between store snapshots.
const indexById = (sessions: ChatSession[]): Map<string, ChatSession> =>
  new Map(sessions.map((session) => [session.id, session]))

// Builds an incremental saver: on each store change it persists only the sessions whose reference
// changed, deletes the ones that disappeared, and updates the manifest when selection moves. Writes are
// serialized through a single queue so snapshots reach disk in mutation order.
const createStoreSaver = (
  api: SessionPersistenceApi,
  initial: SessionStoreSnapshot = useSessionStore.getState()
): ((state: SessionStoreSnapshot) => Promise<unknown>) => {
  let previousSessions = initial.sessions
  let previousSelection = initial.selectedSessionId
  let queue: Promise<unknown> = Promise.resolve()

  // Runs each write regardless of whether an earlier one rejected, preserving order.
  const enqueue = (task: () => Promise<unknown>): Promise<unknown> => {
    queue = queue.then(task, task)

    return queue
  }

  return (state) => {
    const nextSessions = state.sessions
    const previousById = indexById(previousSessions)
    const nextById = indexById(nextSessions)
    const tasks: Array<() => Promise<unknown>> = []

    // Persist new or mutated sessions; pending sessions never touch disk until they bind a real id. A
    // session without a projectId cannot map to a sessions/<projectId>/ path (the main repository rejects
    // an empty segment), so skip it rather than enqueue a write that would throw and be swallowed.
    for (const session of nextSessions) {
      if (session.isPending || !session.projectId) continue

      if (previousById.get(session.id) !== session) {
        const persisted = toPersistedSession(session)

        tasks.push(() => api.saveSession(persisted))
      }
    }

    // Delete sessions that were persisted before but are gone now.
    for (const session of previousSessions) {
      if (session.isPending || !session.projectId) continue

      if (!nextById.has(session.id)) {
        tasks.push(() => api.deleteSession({ projectId: session.projectId, sessionId: session.id }))
      }
    }

    // Track the last-open selection, ignoring transient pending selections.
    if (state.selectedSessionId !== previousSelection) {
      const selectedSession = state.selectedSessionId
        ? nextById.get(state.selectedSessionId)
        : undefined

      if (!selectedSession?.isPending) {
        tasks.push(() =>
          api.saveManifest({
            lastSessionId: state.selectedSessionId,
            lastProjectId: selectedSession?.projectId
          })
        )
      }
    }

    previousSessions = nextSessions
    previousSelection = state.selectedSessionId

    let lastTask: Promise<unknown> = Promise.resolve()

    for (const task of tasks) {
      lastTask = enqueue(task)
    }

    return lastTask
  }
}

// Starts session persistence and returns readiness so the workspace can gate early input.
const useSessionPersistence = (): boolean => {
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    let isMounted = true
    let unsubscribe: (() => void) | undefined

    // Loads before subscribing so the initial empty store cannot overwrite disk state.
    const startPersistence = async (): Promise<void> => {
      try {
        await loadPersistedSessions(window.api.sessions)
      } catch (error) {
        reportPersistenceError(error)
      }

      if (!isMounted) return

      setIsReady(true)
      // Snapshot the hydrated state as the diff baseline so hydration itself is not re-saved.
      const save = createStoreSaver(window.api.sessions)

      unsubscribe = useSessionStore.subscribe((state) => {
        void save(state).catch(reportPersistenceError)
      })
    }

    void startPersistence()

    return () => {
      isMounted = false
      unsubscribe?.()
    }
  }, [])

  return isReady
}

export { createStoreSaver, loadPersistedSessions, useSessionPersistence }
export type { SessionPersistenceApi }
