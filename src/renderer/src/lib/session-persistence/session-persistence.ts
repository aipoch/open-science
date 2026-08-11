import { useCallback, useEffect, useRef, useState } from 'react'

import type { ArtifactFile, ReconcilePendingArtifactsRequest } from '../../../../shared/artifacts'
import type { RendererFailureContext } from '../../../../shared/diagnostics'
import {
  ConversationGraphMaterializationError,
  type DeleteSessionRequest,
  type LoadAllSessionsResult,
  type PersistedChatSession,
  type SaveSessionOptions,
  type SessionConflictRebaseField,
  type SaveSessionManifestRequest
} from '../../../../shared/session-persistence'
import { PENDING_UPLOAD_SESSION_ID } from '../../../../shared/uploads'
import {
  isExternallyHydratedSession,
  toPersistedSession,
  useSessionStore
} from '../../stores/session-store'
import type { ChatSession, SessionHydrationSelection } from '../../stores/session-store'
import { projectRendererFailure } from '../../renderer-diagnostics'

type SessionPersistenceApi = {
  loadAll: () => Promise<LoadAllSessionsResult>
  saveSession: (
    session: PersistedChatSession,
    options?: SaveSessionOptions
  ) => Promise<PersistedChatSession>
  deleteSession: (request: DeleteSessionRequest) => Promise<void>
  saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
}

type LatestSessionSaveTask = (options?: SaveSessionOptions) => Promise<PersistedChatSession>

type OrderedSessionPersistence = Pick<SessionPersistenceApi, 'saveSession' | 'saveManifest'> & {
  saveLatestSession: (
    target: string,
    task: LatestSessionSaveTask,
    options?: SaveSessionOptions
  ) => Promise<PersistedChatSession>
  flush: () => Promise<void>
}

const SESSION_CONFLICT_REBASE_FIELDS = [
  'title',
  'permissionProfile',
  'autoReviewEnabled',
  'enabledComputeHosts',
  'pinned',
  'specialistId'
] as const satisfies readonly SessionConflictRebaseField[]

const conflictRebaseFieldChanged = (
  previous: ChatSession,
  next: ChatSession,
  field: SessionConflictRebaseField
): boolean => {
  if (field !== 'enabledComputeHosts') return previous[field] !== next[field]
  const previousHosts = previous.enabledComputeHosts ?? []
  const nextHosts = next.enabledComputeHosts ?? []
  return (
    previousHosts.length !== nextHosts.length ||
    previousHosts.some((host, index) => host !== nextHosts[index])
  )
}

const mergeSaveSessionOptions = (
  previous: SaveSessionOptions | undefined,
  next: SaveSessionOptions | undefined
): SaveSessionOptions | undefined => {
  const conflictRebaseFields = [
    ...new Set([...(previous?.conflictRebaseFields ?? []), ...(next?.conflictRebaseFields ?? [])])
  ]
  return conflictRebaseFields.length > 0 ? { conflictRebaseFields } : undefined
}

// Serializes every renderer-originated Session write through one ordering seam. Store snapshots at
// the queue tail use latest-wins coalescing; explicit Session and Manifest writes remain barriers, so
// Artifact finalization cannot be overtaken by an older store snapshot.
const createOrderedSessionPersistence = (
  api: Pick<SessionPersistenceApi, 'saveSession' | 'saveManifest'>
): OrderedSessionPersistence => {
  let queue: Promise<unknown> = Promise.resolve()
  let pendingLatest:
    | {
        target: string
        task: LatestSessionSaveTask
        options: SaveSessionOptions | undefined
      }
    | undefined
  let pendingLatestPromise: Promise<PersistedChatSession> | undefined

  const enqueue = <Result>(task: () => Promise<Result>): Promise<Result> => {
    pendingLatest = undefined
    pendingLatestPromise = undefined
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  const saveLatestSession = (
    target: string,
    task: LatestSessionSaveTask,
    options?: SaveSessionOptions
  ): Promise<PersistedChatSession> => {
    if (pendingLatest?.target === target && pendingLatestPromise) {
      pendingLatest.task = task
      pendingLatest.options = mergeSaveSessionOptions(pendingLatest.options, options)
      return pendingLatestPromise
    }

    const entry = { target, task, options }
    const runTask = (): Promise<PersistedChatSession> => {
      if (pendingLatest === entry) {
        pendingLatest = undefined
        pendingLatestPromise = undefined
      }
      return entry.task(entry.options)
    }
    const run = queue.then(runTask, runTask)
    pendingLatest = entry
    pendingLatestPromise = run
    queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  return {
    saveLatestSession,
    saveSession: (session, options) =>
      enqueue(() => (options ? api.saveSession(session, options) : api.saveSession(session))),
    saveManifest: (request) => enqueue(() => api.saveManifest(request)),
    flush: () => queue.then(() => undefined)
  }
}

// The Store saver and Artifact finalization share this instance in production. Its adapters resolve
// window.api lazily, keeping module import safe in tests before the preload bridge is installed.
const liveSessionPersistence = createOrderedSessionPersistence({
  saveSession: (session, options) =>
    options
      ? window.api.sessions.saveSession(session, options)
      : window.api.sessions.saveSession(session),
  saveManifest: (request) => window.api.sessions.saveManifest(request)
})

const saveSessionInOrder = (session: PersistedChatSession): Promise<PersistedChatSession> =>
  liveSessionPersistence.saveSession(session)

const flushSessionPersistence = (): Promise<void> => liveSessionPersistence.flush()

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
        reportPersistenceError(error, 'artifact-reconcile')
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
  isLoading: boolean
  isReady: boolean
  hasCompleteSessionCatalog: boolean
  canDeleteSessionsAndProjects: boolean
  loadError: string | undefined
  loadWarning: string | undefined
  writeError: string | undefined
  dismissLoadWarning: () => void
  retryLoad: () => void
  retryWrites: () => void
}

type StoreSaverOptions = {
  forceTargets?: ReadonlySet<string>
  conflictRebaseFieldsByTarget?: ReadonlyMap<string, readonly SessionConflictRebaseField[]>
}

type StoreSaverFailureContext = {
  conflictRebaseFields?: readonly SessionConflictRebaseField[]
}

type StoreSaverObserver = {
  onFailure?: (target: string, error: unknown, context: StoreSaverFailureContext) => void
  onSuccess?: (target: string) => void
}

type StoreSaver = (state: SessionStoreSnapshot, options?: StoreSaverOptions) => Promise<unknown>

const pruneRemovedSessionWriteTargets = (
  targets: Set<string>,
  sessions: readonly Pick<ChatSession, 'id'>[],
  conflictRebaseFields?: Map<string, SessionConflictRebaseField[]>
): void => {
  const activeSessionTargets = new Set(sessions.map((session) => `session:${session.id}`))
  for (const target of targets) {
    if (target.startsWith('session:') && !activeSessionTargets.has(target)) {
      targets.delete(target)
      conflictRebaseFields?.delete(target)
    }
  }
}

const reportedPersistenceFailures = new WeakSet<object>()

// Retains full diagnostics in the local console while the main-process log receives only a bounded,
// allowlisted phase, error category, and stack fingerprint. Never bridge raw messages or paths.
const reportPersistenceError = (
  error: unknown,
  context: RendererFailureContext = 'session-persistence-unknown'
): void => {
  console.warn('Session persistence failed', error)
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
    if (reportedPersistenceFailures.has(error)) return
    reportedPersistenceFailures.add(error)
  }
  try {
    window.api.diagnostics?.reportRendererFailure(
      projectRendererFailure('handled-error', error, 'unknown', context)
    )
  } catch {
    // Diagnostics are best-effort and must never replace the persistence failure being handled.
  }
}

const reportSessionSerializationError = (error: unknown): void => {
  let context: RendererFailureContext = 'session-serialize'
  if (error instanceof ConversationGraphMaterializationError) {
    context = `session-serialize-${error.phase}`
    if (error.phase === 'messages' && error.cause instanceof Error) {
      if (error.cause.message === 'Active Agent Frame not found.') {
        context = 'session-serialize-messages-active-frame'
      } else if (error.cause.message === 'Active Message Branch not found.') {
        context = 'session-serialize-messages-active-branch'
      } else if (
        /^Message .+ belongs to another conversation Branch\.$/.test(error.cause.message)
      ) {
        context = 'session-serialize-messages-off-branch'
      } else {
        context = 'session-serialize-messages-invalid-graph'
      }
    }
  }
  reportPersistenceError(error, context)
}

const observePersistencePhase = <Result>(
  context: RendererFailureContext,
  operation: () => Result
): Result => {
  try {
    return operation()
  } catch (error) {
    if (context === 'session-serialize') reportSessionSerializationError(error)
    else reportPersistenceError(error, context)
    throw error
  }
}

const SAFE_SESSION_LOAD_ERROR =
  'Open Science could not read saved conversation data. Retry to continue.'
const SAFE_SESSION_WRITE_ERROR =
  'Open Science could not save the latest conversation changes. Retry before closing the app.'

// Hydrates the in-memory session store from the per-session files loaded by the main process.
const loadPersistedSessions = async (
  api: SessionPersistenceApi,
  shouldHydrate: () => boolean = () => true,
  preferredSelection?: SessionHydrationSelection
): Promise<LoadAllSessionsResult | undefined> => {
  const result = await api.loadAll()
  if (!shouldHydrate()) return undefined

  // Retry captures live navigation as an explicit tri-state. If the user had no selection, or the
  // selected Session disappeared before recovery completed, do not replay a stale disk manifest or
  // fall through to the globally newest Session from another Project. Passing the selection into
  // hydration applies the sessions and selection atomically for all Zustand subscribers.
  useSessionStore.getState().hydrateSessions(result.sessions, result.manifest, preferredSelection)
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
  observer: StoreSaverObserver = {},
  persistence: OrderedSessionPersistence = createOrderedSessionPersistence(api)
): StoreSaver => {
  let previousSessions = initial.sessions
  let previousSelection = initial.selectedSessionId

  return (state, options) => {
    const nextSessions = state.sessions
    const previousById = indexById(previousSessions)
    const nextById = indexById(nextSessions)
    const tasks: Array<{
      target: string
      run: () => Promise<unknown>
      failureContext: StoreSaverFailureContext
    }> = []

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
        const previousSession = previousById.get(session.id)
        const changedConflictRebaseFields = previousSession
          ? SESSION_CONFLICT_REBASE_FIELDS.filter((field) =>
              conflictRebaseFieldChanged(previousSession, session, field)
            )
          : []
        const conflictRebaseFields = [
          ...new Set([
            ...changedConflictRebaseFields,
            ...(options?.conflictRebaseFieldsByTarget?.get(target) ?? [])
          ])
        ]

        const saveOptions = conflictRebaseFields.length > 0 ? { conflictRebaseFields } : undefined
        const applyDurableSession = (
          durableSession: PersistedChatSession,
          options: SaveSessionOptions | undefined
        ): void => {
          useSessionStore.getState().applyDurableSessionProjection({
            source: session,
            session: durableSession,
            mode:
              (options?.conflictRebaseFields?.length ?? 0) > 0
                ? 'replace-persisted-if-current'
                : 'merge-upload-identities'
          })
        }

        tasks.push({
          target,
          failureContext: { conflictRebaseFields },
          run: isForced
            ? async () => {
                const persisted = observePersistencePhase('session-serialize', () =>
                  toPersistedSession(session)
                )
                let durableSession: PersistedChatSession
                try {
                  durableSession = await persistence.saveSession(persisted, saveOptions)
                } catch (error) {
                  reportPersistenceError(error, 'session-save')
                  throw error
                }
                observePersistencePhase('session-apply-durable', () =>
                  applyDurableSession(durableSession, saveOptions)
                )
              }
            : () =>
                persistence.saveLatestSession(
                  target,
                  async (coalescedOptions) => {
                    const persisted = observePersistencePhase('session-serialize', () =>
                      toPersistedSession(session)
                    )
                    let durableSession: PersistedChatSession
                    try {
                      durableSession = await (coalescedOptions
                        ? api.saveSession(persisted, coalescedOptions)
                        : api.saveSession(persisted))
                    } catch (error) {
                      reportPersistenceError(error, 'session-save')
                      throw error
                    }
                    observePersistencePhase('session-apply-durable', () =>
                      applyDurableSession(durableSession, coalescedOptions)
                    )
                    return durableSession
                  },
                  saveOptions
                )
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
          failureContext: {},
          run: async () => {
            try {
              await persistence.saveManifest({
                lastSessionId: state.selectedSessionId,
                lastProjectId: selectedSession?.projectId
              })
            } catch (error) {
              reportPersistenceError(error, 'session-manifest-save')
              throw error
            }
          }
        })
      }
    }

    previousSessions = nextSessions
    previousSelection = state.selectedSessionId

    const scheduledTasks = tasks.map(({ target, run, failureContext }) => {
      // Invoke every task now so it takes its place in the shared persistence queue at snapshot time.
      return run().then(
        (result) => {
          observer.onSuccess?.(target)
          return result
        },
        (error: unknown) => {
          observer.onFailure?.(target, error, failureContext)
          throw error
        }
      )
    })

    return Promise.all(scheduledTasks).then(() => undefined)
  }
}

// Starts session persistence and returns health/recovery state so App can gate input and surface failures.
const useSessionPersistence = (): SessionPersistenceState => {
  const [isHydrated, setIsHydrated] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isReady, setIsReady] = useState(false)
  const [hasCompleteSessionCatalog, setHasCompleteSessionCatalog] = useState(false)
  const [canDeleteSessionsAndProjects, setCanDeleteSessionsAndProjects] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [loadWarning, setLoadWarning] = useState<string | undefined>(undefined)
  const [writeError, setWriteError] = useState<string | undefined>(undefined)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const retrySelection = useRef<SessionHydrationSelection | undefined>(undefined)
  const failedWriteTargets = useRef(new Set<string>())
  const failedConflictRebaseFields = useRef(new Map<string, SessionConflictRebaseField[]>())
  const retryManifestWritePending = useRef(false)
  const saverRef = useRef<StoreSaver | undefined>(undefined)
  const dismissLoadWarning = useCallback(() => setLoadWarning(undefined), [])
  const retryLoad = useCallback(() => {
    // A partial snapshot remains interactive. Keep the session the user chose from that snapshot so
    // a successful retry cannot replay the older on-disk manifest over their live navigation.
    if (isHydrated) {
      retrySelection.current = { sessionId: useSessionStore.getState().selectedSessionId }
    }
    setIsHydrated(false)
    setIsLoading(true)
    setIsReady(false)
    setHasCompleteSessionCatalog(false)
    setCanDeleteSessionsAndProjects(false)
    setLoadError(undefined)
    setLoadWarning(undefined)
    setWriteError(undefined)
    retryManifestWritePending.current = false
    setLoadAttempt((attempt) => attempt + 1)
  }, [isHydrated])
  const retryWrites = useCallback(() => {
    const saver = saverRef.current
    if (!saver || failedWriteTargets.current.size === 0) return

    const state = useSessionStore.getState()
    pruneRemovedSessionWriteTargets(
      failedWriteTargets.current,
      state.sessions,
      failedConflictRebaseFields.current
    )
    if (failedWriteTargets.current.size === 0) {
      setWriteError(undefined)
      return
    }

    void saver(state, {
      forceTargets: new Set(failedWriteTargets.current),
      conflictRebaseFieldsByTarget: new Map(failedConflictRebaseFields.current)
    }).catch(reportPersistenceError)
  }, [])

  useEffect(() => {
    let isMounted = true
    let unsubscribe: (() => void) | undefined
    let activeSaver: StoreSaver | undefined
    saverRef.current = undefined
    failedWriteTargets.current.clear()
    failedConflictRebaseFields.current.clear()

    // Loads before subscribing so the initial empty store cannot overwrite disk state.
    const startPersistence = async (): Promise<void> => {
      const preferredSelection = retrySelection.current
      try {
        const result = await loadPersistedSessions(
          window.api.sessions,
          () => isMounted,
          preferredSelection
        )
        if (!result || !isMounted) return
        setIsHydrated(true)
        const loadWarnings = result.diagnostics?.warnings ?? []
        const sessionWarningCount = loadWarnings.filter(
          (warning) => warning.kind !== 'manifest-corrupt' && warning.kind !== 'manifest-unreadable'
        ).length
        setHasCompleteSessionCatalog(
          result.diagnostics?.isComplete !== false && sessionWarningCount === 0
        )
        setCanDeleteSessionsAndProjects(
          result.diagnostics?.isProjectDeletionRecoveryComplete === true
        )

        if (result.diagnostics?.isComplete === false) {
          setLoadError(
            result.diagnostics.failure === 'startup-reconciliation-failed'
              ? 'Saved conversations loaded, but storage recovery could not finish. Retry before creating or saving conversations.'
              : 'Some saved conversations could not be read. Retry before creating or saving conversations.'
          )
          setIsLoading(false)
          return
        }

        if (loadWarnings.length > 0) {
          const manifestWasRecovered = loadWarnings.some(
            (warning) => warning.kind === 'manifest-corrupt' && warning.recovered
          )
          const manifestRecoveryFailed = loadWarnings.some(
            (warning) => warning.kind === 'manifest-corrupt' && !warning.recovered
          )
          const manifestWasUnreadable = loadWarnings.some(
            (warning) => warning.kind === 'manifest-unreadable'
          )
          const warningMessages = [
            manifestWasRecovered
              ? 'Conversation selection data was damaged and moved aside.'
              : undefined,
            manifestRecoveryFailed
              ? 'Conversation selection data was damaged and could not be moved aside, so no conversation was selected.'
              : undefined,
            manifestWasUnreadable
              ? 'Conversation selection data could not be read, so no conversation was selected.'
              : undefined,
            sessionWarningCount > 0
              ? `${sessionWarningCount} saved conversation file${sessionWarningCount === 1 ? ' was' : 's were'} damaged and moved aside.`
              : undefined,
            'The remaining conversations were loaded.'
          ]
          setLoadWarning(warningMessages.filter(Boolean).join(' '))
        }
      } catch (error) {
        reportPersistenceError(error, 'session-load')
        if (isMounted) {
          setHasCompleteSessionCatalog(false)
          setCanDeleteSessionsAndProjects(false)
          setLoadError(SAFE_SESSION_LOAD_ERROR)
          setIsLoading(false)
        }
        return
      }

      let hasStartedPendingArtifactReconciliation = false
      const startPendingArtifactReconciliation = (): void => {
        if (hasStartedPendingArtifactReconciliation) return
        hasStartedPendingArtifactReconciliation = true
        // Runs after the saver subscribes so finalized references are persisted. A failed startup
        // manifest write defers this until that retry succeeds and persistence becomes ready.
        void reconcilePendingArtifacts(window.api.artifacts)
      }

      // Snapshot the hydrated state as the diff baseline so hydration itself is not re-saved.
      const save = createStoreSaver(
        window.api.sessions,
        useSessionStore.getState(),
        {
          onFailure: (target, _error, context) => {
            if (!isMounted) return
            failedWriteTargets.current.add(target)
            const conflictRebaseFields = context.conflictRebaseFields
            if (conflictRebaseFields && conflictRebaseFields.length > 0) {
              failedConflictRebaseFields.current.set(target, [
                ...new Set([
                  ...(failedConflictRebaseFields.current.get(target) ?? []),
                  ...conflictRebaseFields
                ])
              ])
            }
            pruneRemovedSessionWriteTargets(
              failedWriteTargets.current,
              useSessionStore.getState().sessions,
              failedConflictRebaseFields.current
            )
            // A queued save can lose a race with an authoritative deletion. Its tombstone rejection
            // must not resurrect a retry target for a Session that no longer exists in the store.
            if (!failedWriteTargets.current.has(target)) {
              if (failedWriteTargets.current.size === 0) setWriteError(undefined)
              return
            }
            setWriteError(SAFE_SESSION_WRITE_ERROR)
          },
          onSuccess: (target) => {
            if (!isMounted) return
            failedWriteTargets.current.delete(target)
            failedConflictRebaseFields.current.delete(target)
            if (target === 'manifest' && retryManifestWritePending.current) {
              retryManifestWritePending.current = false
              setIsReady(true)
              startPendingArtifactReconciliation()
            }
            if (failedWriteTargets.current.size === 0) setWriteError(undefined)
          }
        },
        liveSessionPersistence
      )
      activeSaver = save
      saverRef.current = save

      unsubscribe = useSessionStore.subscribe((state) => {
        pruneRemovedSessionWriteTargets(
          failedWriteTargets.current,
          state.sessions,
          failedConflictRebaseFields.current
        )
        if (failedWriteTargets.current.size === 0) setWriteError(undefined)
        void save(state).catch(reportPersistenceError)
      })

      // Hydration intentionally uses the user's live selection instead of the older disk manifest
      // on retry. Force that tri-state selection (including an explicit empty selection) back to
      // disk before declaring persistence ready, because the saver baseline already contains it.
      if (preferredSelection !== undefined) {
        try {
          await save(useSessionStore.getState(), {
            forceTargets: new Set(['manifest'])
          })
        } catch (error) {
          retryManifestWritePending.current = true
          reportPersistenceError(error)
        }
        if (!isMounted) return
      }

      retrySelection.current = undefined
      setIsLoading(false)
      if (retryManifestWritePending.current) return
      setIsReady(true)
      startPendingArtifactReconciliation()
    }

    void startPersistence()

    return () => {
      isMounted = false
      if (saverRef.current === activeSaver) saverRef.current = undefined
      unsubscribe?.()
    }
  }, [loadAttempt])

  return {
    isHydrated,
    isLoading,
    isReady,
    hasCompleteSessionCatalog,
    canDeleteSessionsAndProjects,
    loadError,
    loadWarning,
    writeError,
    dismissLoadWarning,
    retryLoad,
    retryWrites
  }
}

export {
  createOrderedSessionPersistence,
  createStoreSaver,
  flushSessionPersistence,
  loadPersistedSessions,
  reconcilePendingArtifacts,
  saveSessionInOrder,
  useSessionPersistence
}
export type {
  ArtifactReconcileApi,
  OrderedSessionPersistence,
  SessionPersistenceApi,
  SessionPersistenceState
}
