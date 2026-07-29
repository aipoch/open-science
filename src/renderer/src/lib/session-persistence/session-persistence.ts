import { useCallback, useEffect, useRef, useState } from 'react'

import type { ArtifactFile, ReconcilePendingArtifactsRequest } from '../../../../shared/artifacts'
import type {
  DeleteSessionRequest,
  LoadAllSessionsResult,
  PersistedChatSession,
  SaveSessionManifestRequest
} from '../../../../shared/session-persistence'
import { PENDING_UPLOAD_SESSION_ID } from '../../../../shared/uploads'
import {
  isExternallyHydratedSession,
  toPersistedSession,
  useSessionStore
} from '../../stores/session-store'
import type { ChatSession } from '../../stores/session-store'

type SessionPersistenceApi = {
  loadAll: () => Promise<LoadAllSessionsResult>
  saveSession: (session: PersistedChatSession) => Promise<PersistedChatSession>
  deleteSession: (request: DeleteSessionRequest) => Promise<void>
  saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
}

// The one artifact command startup reconciliation needs; kept narrow so it is trivial to fake in tests.
type ArtifactReconcileApi = {
  reconcilePendingArtifacts: (request: ReconcilePendingArtifactsRequest) => Promise<ArtifactFile[]>
}

// A crash between persisting a pending artifact reference and finalizing it strands the file in
// `.pending/<run>/`. The path segment is stable across OSes, so detect it structurally.
const isPendingArtifactPath = (path: string | undefined): path is string =>
  typeof path === 'string' && path.split(/[\\/]/).includes('.pending')

// Re-finalizes artifacts a prior crash left in `.pending` after the in-memory finalize claim was lost.
// For each hydrated message still referencing a pending path, ask the main process to complete the
// move (idempotent) and replace the message's stale references with the finalized files. Runs once at
// startup after the store saver is subscribed, so each replacement is persisted. Per-message failures
// are isolated and never block the rest; an empty result leaves references untouched so a file still
// readable at its pending path is never dropped.
const reconcilePendingArtifacts = async (api: ArtifactReconcileApi): Promise<void> => {
  for (const session of useSessionStore.getState().sessions) {
    if (session.isPending || !session.projectId) continue

    const artifactsById = new Map(
      (session.artifacts ?? []).map((artifact) => [artifact.id, artifact])
    )

    for (const message of session.messages) {
      const pendingPaths = (message.artifactIds ?? [])
        .map((id) => artifactsById.get(id)?.path)
        .filter(isPendingArtifactPath)

      if (pendingPaths.length === 0) continue

      try {
        const finalized = await api.reconcilePendingArtifacts({
          projectName: session.projectId,
          sessionId: session.id,
          messageId: message.id,
          pendingPaths
        })

        if (finalized.length > 0) {
          useSessionStore.getState().replaceMessageArtifacts({
            sessionId: session.id,
            messageId: message.id,
            artifacts: finalized
          })
        }
      } catch (error) {
        reportPersistenceError(error)
      }
    }
  }
}

type SessionStoreSnapshot = {
  sessions: ChatSession[]
  selectedSessionId: string | undefined
}

type SessionPersistenceState = {
  isHydrated: boolean
  isReady: boolean
  loadError: string | undefined
  loadWarning: string | undefined
  writeError: string | undefined
  retryLoad: () => void
  retryWrites: () => void
}

type StoreSaverOptions = {
  forceTargets?: ReadonlySet<string>
}

type StoreSaverObserver = {
  onFailure?: (target: string, error: unknown) => void
  onSuccess?: (target: string) => void
}

type StoreSaver = (state: SessionStoreSnapshot, options?: StoreSaverOptions) => Promise<unknown>

// Retains full diagnostics in the console while the hook exposes renderer-safe recovery state.
const reportPersistenceError = (error: unknown): void => {
  console.warn('Session persistence failed', error)
}

// Hydrates the in-memory session store from the per-session files loaded by the main process.
const loadPersistedSessions = async (
  api: SessionPersistenceApi,
  shouldHydrate: () => boolean = () => true
): Promise<LoadAllSessionsResult | undefined> => {
  const result = await api.loadAll()
  if (!shouldHydrate()) return undefined

  useSessionStore.getState().hydrateSessions(result.sessions, result.manifest)
  return result
}

// Indexes sessions by id for reference-equality diffing between store snapshots.
const indexById = (sessions: ChatSession[]): Map<string, ChatSession> =>
  new Map(sessions.map((session) => [session.id, session]))

// Upload publication owns the staged path -> immutable Version transition. Saving between append and
// finalize would race the main-process legacy upgrader and could publish the same bytes twice, so the
// bridge waits for every pending attachment to acquire its Version identity.
const hasStagedUploads = (session: ChatSession): boolean =>
  session.messages.some((message) =>
    message.uploads?.some(
      (upload) => upload.sessionId === PENDING_UPLOAD_SESSION_ID && !upload.versionId
    )
  )

// Builds an incremental saver: on each store change it persists only sessions whose reference changed
// and updates the manifest when selection moves. Explicit deletion owns its durable coordinator call.
const createStoreSaver = (
  api: SessionPersistenceApi,
  initial: SessionStoreSnapshot = useSessionStore.getState(),
  observer: StoreSaverObserver = {}
): StoreSaver => {
  let previousSessions = initial.sessions
  let previousSelection = initial.selectedSessionId
  let queue: Promise<unknown> = Promise.resolve()

  // Runs each write regardless of whether an earlier one rejected, preserving order.
  const enqueue = (task: () => Promise<unknown>): Promise<unknown> => {
    queue = queue.then(task, task)

    return queue
  }

  return (state, options) => {
    const nextSessions = state.sessions
    const previousById = indexById(previousSessions)
    const nextById = indexById(nextSessions)
    const tasks: Array<{ target: string; run: () => Promise<unknown> }> = []

    // Persist new or mutated sessions; pending sessions never touch disk until they bind a real id. A
    // session without a projectId cannot map to a sessions/<projectId>/ path (the main repository rejects
    // an empty segment), so skip it rather than enqueue a write that would throw and be swallowed.
    for (const session of nextSessions) {
      if (session.isPending || !session.projectId) continue

      const target = `session:${session.id}`
      const isForced = options?.forceTargets?.has(target) === true

      if (
        (previousById.get(session.id) !== session || isForced) &&
        (isForced || !isExternallyHydratedSession(session)) &&
        !hasStagedUploads(session) &&
        // A terminal graph-integrity failure keeps the renderer responsive, but the flat projection
        // is no longer proven to match the immutable Branch graph. Preserve the last durable copy.
        !session.conversationGraphSyncBlocked
      ) {
        const persisted = toPersistedSession(session)

        tasks.push({
          target,
          run: async () => {
            const durableSession = await api.saveSession(persisted)
            useSessionStore.getState().applyDurableSessionProjection({
              source: session,
              session: durableSession
            })
          }
        })
      }
    }

    // Track the last-open selection, ignoring transient pending selections.
    if (
      state.selectedSessionId !== previousSelection ||
      options?.forceTargets?.has('manifest') === true
    ) {
      const selectedSession = state.selectedSessionId
        ? nextById.get(state.selectedSessionId)
        : undefined

      if (!selectedSession?.isPending) {
        tasks.push({
          target: 'manifest',
          run: () =>
            api.saveManifest({
              lastSessionId: state.selectedSessionId,
              lastProjectId: selectedSession?.projectId
            })
        })
      }
    }

    previousSessions = nextSessions
    previousSelection = state.selectedSessionId

    const scheduledTasks = tasks.map(({ target, run }) =>
      enqueue(async () => {
        try {
          const result = await run()
          observer.onSuccess?.(target)
          return result
        } catch (error) {
          observer.onFailure?.(target, error)
          throw error
        }
      })
    )

    return Promise.all(scheduledTasks).then(() => undefined)
  }
}

// Starts session persistence and returns health/recovery state so App can gate input and surface failures.
const useSessionPersistence = (): SessionPersistenceState => {
  const [isHydrated, setIsHydrated] = useState(false)
  const [isReady, setIsReady] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [loadWarning, setLoadWarning] = useState<string | undefined>(undefined)
  const [writeError, setWriteError] = useState<string | undefined>(undefined)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const failedWriteTargets = useRef(new Set<string>())
  const saverRef = useRef<StoreSaver | undefined>(undefined)
  const retryLoad = useCallback(() => {
    setIsHydrated(false)
    setIsReady(false)
    setLoadError(undefined)
    setLoadWarning(undefined)
    setWriteError(undefined)
    setLoadAttempt((attempt) => attempt + 1)
  }, [])
  const retryWrites = useCallback(() => {
    const saver = saverRef.current
    if (!saver || failedWriteTargets.current.size === 0) return

    const state = useSessionStore.getState()
    const activeSessionTargets = new Set(state.sessions.map((session) => `session:${session.id}`))
    for (const target of failedWriteTargets.current) {
      if (target.startsWith('session:') && !activeSessionTargets.has(target)) {
        failedWriteTargets.current.delete(target)
      }
    }
    if (failedWriteTargets.current.size === 0) {
      setWriteError(undefined)
      return
    }

    void saver(state, {
      forceTargets: new Set(failedWriteTargets.current)
    }).catch(reportPersistenceError)
  }, [])

  useEffect(() => {
    let isMounted = true
    let unsubscribe: (() => void) | undefined
    let activeSaver: StoreSaver | undefined
    saverRef.current = undefined
    failedWriteTargets.current.clear()

    // Loads before subscribing so the initial empty store cannot overwrite disk state.
    const startPersistence = async (): Promise<void> => {
      try {
        const result = await loadPersistedSessions(window.api.sessions, () => isMounted)
        if (!result || !isMounted) return
        setIsHydrated(true)

        if (result.diagnostics?.isComplete === false) {
          setLoadError(
            result.diagnostics.failure === 'manifest-unreadable'
              ? 'Conversation selection data could not be read. Retry before creating or saving conversations.'
              : result.diagnostics.failure === 'startup-reconciliation-failed'
                ? 'Saved conversations loaded, but storage recovery could not finish. Retry before creating or saving conversations.'
                : 'Some saved conversations could not be read. Retry before creating or saving conversations.'
          )
          return
        }

        const loadWarnings = result.diagnostics?.warnings ?? []
        if (loadWarnings.length > 0) {
          const manifestWasRecovered = loadWarnings.some(
            (warning) => warning.kind === 'manifest-corrupt'
          )
          const sessionWarningCount = loadWarnings.filter(
            (warning) => warning.kind !== 'manifest-corrupt'
          ).length
          const warningMessages = [
            manifestWasRecovered
              ? 'Conversation selection data was damaged and moved aside.'
              : undefined,
            sessionWarningCount > 0
              ? `${sessionWarningCount} saved conversation file${sessionWarningCount === 1 ? ' was' : 's were'} damaged and moved aside.`
              : undefined,
            'The remaining conversations were loaded.'
          ]
          setLoadWarning(warningMessages.filter(Boolean).join(' '))
        }
      } catch (error) {
        reportPersistenceError(error)
        if (isMounted) {
          setLoadError(
            error instanceof Error ? error.message : 'Saved conversations could not be loaded.'
          )
        }
        return
      }

      setIsReady(true)
      // Snapshot the hydrated state as the diff baseline so hydration itself is not re-saved.
      const save = createStoreSaver(window.api.sessions, useSessionStore.getState(), {
        onFailure: (target, error) => {
          if (!isMounted) return
          failedWriteTargets.current.add(target)
          setWriteError(
            error instanceof Error ? error.message : 'Conversation changes could not be saved.'
          )
        },
        onSuccess: (target) => {
          if (!isMounted) return
          failedWriteTargets.current.delete(target)
          if (failedWriteTargets.current.size === 0) setWriteError(undefined)
        }
      })
      activeSaver = save
      saverRef.current = save

      unsubscribe = useSessionStore.subscribe((state) => {
        void save(state).catch(reportPersistenceError)
      })

      // Recover any artifacts a prior crash left in `.pending`; runs after the saver subscribes so the
      // finalized references are persisted. Fire-and-forget: it must not delay the workspace becoming
      // interactive, and failures are already reported per message.
      void reconcilePendingArtifacts(window.api.artifacts)
    }

    void startPersistence()

    return () => {
      isMounted = false
      if (saverRef.current === activeSaver) saverRef.current = undefined
      unsubscribe?.()
    }
  }, [loadAttempt])

  return { isHydrated, isReady, loadError, loadWarning, writeError, retryLoad, retryWrites }
}

export { createStoreSaver, loadPersistedSessions, reconcilePendingArtifacts, useSessionPersistence }
export type { ArtifactReconcileApi, SessionPersistenceApi, SessionPersistenceState }
