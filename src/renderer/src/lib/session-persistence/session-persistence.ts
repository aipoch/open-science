import { rebaseSessionAfterRevisionConflict } from '../../../../shared/session-rebase'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { shallow } from 'zustand/vanilla/shallow'
import {
  packageOperationActive,
  usePackageOperationStore
} from '../../stores/package-operation-store'

import {
  ARTIFACT_FINALIZATION_INVALID_PROOF,
  type ReconcilePendingArtifactsRequest,
  type ReconcilePendingArtifactsResult
} from '../../../../shared/artifacts'
import {
  activateConversationBranch,
  projectConversationMessage,
  resolveActiveConversationActivities,
  resolveActiveConversationMessages
} from '../../../../shared/conversation-graph'
import type { RendererFailureContext } from '../../../../shared/diagnostics'
import {
  ConversationGraphMaterializationError,
  SessionRevisionConflictError,
  isSessionSizeLimitError,
  isSessionRevisionConflictError,
  sessionRevision,
  type DeleteSessionRequest,
  type DelegationPolicy,
  type LoadAllSessionsResult,
  type ListSessionSummariesResult,
  type LoadSessionRequest,
  type PersistedChatSession,
  type SaveSessionOptions,
  type SessionConflictRebaseField,
  type SessionLoadDiagnostics,
  type SaveSessionManifestRequest,
  type SessionDeletionResult
} from '../../../../shared/session-persistence'
import { PENDING_UPLOAD_SESSION_ID } from '../../../../shared/uploads'
import {
  getExternallyHydratedSessionAuthority,
  isArtifactFinalizationError,
  isExternallyHydratedSession,
  toPersistedSession,
  useSessionStore
} from '../../stores/session-store'
import type {
  ChatSession,
  SessionHydrationSelection,
  StreamingMessageContentByMessageId
} from '../../stores/session-store'
import { projectRendererFailure } from '../../renderer-diagnostics'

type SessionPersistenceApi = {
  list?: () => Promise<ListSessionSummariesResult>
  loadAll: () => Promise<LoadAllSessionsResult>
  loadOne: (request: LoadSessionRequest) => Promise<PersistedChatSession | undefined>
  saveSession: (
    session: PersistedChatSession,
    options?: SaveSessionOptions
  ) => Promise<PersistedChatSession>
  deleteSession: (request: DeleteSessionRequest) => Promise<SessionDeletionResult>
  saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
}

type SessionReadApi = Pick<SessionPersistenceApi, 'loadAll'> &
  Partial<Pick<SessionPersistenceApi, 'loadOne'>>

const loadPersistedSession = async (
  request: LoadSessionRequest,
  api: SessionReadApi = window.api.sessions
): Promise<PersistedChatSession | undefined> => {
  if (typeof api.loadOne === 'function') return api.loadOne(request)
  const result = await api.loadAll()
  return result.sessions.find(
    (session) => session.id === request.sessionId && session.projectId === request.projectId
  )
}

const hydratePersistedSessionIfPresent = (
  persisted: PersistedChatSession
): ChatSession | undefined => {
  const store = useSessionStore.getState()
  const current = store.sessions.find(
    (session) => session.id === persisted.id && session.projectId === persisted.projectId
  )
  if (!current || current.contentLoaded !== false) return current
  store.upsertPersistedSession(persisted)
  return useSessionStore
    .getState()
    .sessions.find(
      (session) => session.id === persisted.id && session.projectId === persisted.projectId
    )
}

const deleteSession = (request: DeleteSessionRequest): Promise<SessionDeletionResult> =>
  window.api.sessions.deleteSession(request)

const MAX_HISTORY_BODY_BYTES = 64 * 1024 * 1024

// A soft retention weight, not a measurement of the JS heap or serialized file size. Count UTF-16
// text and object/slot overhead once on load, including inactive branches, without copying text.
// Bound traversal too: unusually wide metadata is conservatively treated as an oversized body.
const estimateHistoryBodyBytes = (session: ChatSession): number => {
  const pending: object[] = [session]
  const seen = new WeakSet<object>(pending)
  let bytes = 64
  let values = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const key in current) {
      if (!Object.hasOwn(current, key)) continue
      const value: unknown = Reflect.get(current, key)
      bytes += 16 + key.length * 2
      if (typeof value === 'string') bytes += value.length * 2
      else if (value !== null && typeof value === 'object' && !seen.has(value)) {
        seen.add(value)
        pending.push(value)
        bytes += 64
      }
      if (bytes > MAX_HISTORY_BODY_BYTES || ++values > 100_000) return MAX_HISTORY_BODY_BYTES + 1
    }
  }
  return bytes
}

const toPersistedSessionForAuthorityMaterialization = (
  session: ChatSession
): PersistedChatSession => {
  const persisted = toPersistedSession(session, useSessionStore.getState().streamingMessages)
  return session.delegationPolicyAuthorityPending
    ? { ...persisted, delegationPolicy: 'allow' }
    : persisted
}

const setDelegationPolicyAuthority = async (
  projectId: string,
  sessionId: string,
  policy: DelegationPolicy
): Promise<PersistedChatSession> => {
  const authoritative = await window.api.sessions.setDelegationPolicy(projectId, sessionId, policy)
  useSessionStore.getState().applyDelegationPolicyAuthority(authoritative)
  return authoritative
}

type LatestSessionSaveTask = (options?: SaveSessionOptions) => Promise<PersistedChatSession>
type OrderedSessionSaveRecovery = (
  error: unknown,
  submitted: PersistedChatSession,
  retry: SessionPersistenceApi['saveSession']
) => Promise<PersistedChatSession>

type OrderedSessionPersistence = Pick<SessionPersistenceApi, 'saveSession' | 'saveManifest'> & {
  saveLatestSession: (
    target: string,
    task: LatestSessionSaveTask,
    options?: SaveSessionOptions,
    streaming?: boolean
  ) => Promise<PersistedChatSession>
  saveSessionWithRecovery: (
    session: PersistedChatSession,
    options: SaveSessionOptions | undefined,
    recover: OrderedSessionSaveRecovery
  ) => Promise<PersistedChatSession>
  prepareSessionSave: (
    session: PersistedChatSession,
    options?: SaveSessionOptions
  ) => PersistedChatSession
  acknowledgeSavedSession: (source: PersistedChatSession, durable: PersistedChatSession) => void
  seedAcknowledgedSessions: (sessions: readonly PersistedChatSession[]) => void
  getAcknowledgedSession: (sessionId: string) => PersistedChatSession | undefined
  releaseAcknowledgedSessionBody: (sessionId: string) => boolean
  clearWriteFailure: (target: string) => void
  clearWriteFailures: () => void
  flush: () => Promise<void>
}

const SESSION_CONFLICT_REBASE_FIELDS = [
  'title',
  'permissionProfile',
  'autoReviewEnabled',
  'memoryEnabled',
  'agentConfiguration',
  'pinned'
] as const satisfies readonly SessionConflictRebaseField[]

const conflictRebaseFieldChanged = (
  previous: ChatSession,
  next: ChatSession,
  field: SessionConflictRebaseField
): boolean => {
  if (field === 'agentConfiguration') {
    return JSON.stringify(previous.agentConfiguration) !== JSON.stringify(next.agentConfiguration)
  }
  return previous[field] !== next[field]
}

// A first-turn renderer transcript save can overlap several legitimate Main-owned advances:
// Session details queued/running/terminal, Session status, runtime context, and auxiliary usage.
// Rebase each newly observed authority in sequence. Keep a hard cap so a genuine second writer
// cannot livelock persistence.
const MAX_SESSION_REVISION_REBASE_ATTEMPTS = 8

const saveAfterSessionRevisionConflict = async (
  initialError: unknown,
  initialBase: PersistedChatSession,
  initialSubmitted: PersistedChatSession,
  loadLatest: () => Promise<PersistedChatSession | undefined>,
  save: (session: PersistedChatSession) => Promise<PersistedChatSession>
): Promise<PersistedChatSession> => {
  if (!isSessionRevisionConflictError(initialError)) throw initialError
  let conflict: unknown = initialError
  let base = initialBase
  let submitted = initialSubmitted

  for (let attempt = 0; attempt < MAX_SESSION_REVISION_REBASE_ATTEMPTS; attempt += 1) {
    let latest: PersistedChatSession | undefined
    try {
      latest = await loadLatest()
    } catch {
      throw conflict
    }
    if (!latest) throw conflict
    const rebased = rebaseSessionAfterRevisionConflict(base, submitted, latest)
    if (!rebased) throw conflict

    try {
      return await save(rebased)
    } catch (error) {
      if (!isSessionRevisionConflictError(error)) throw error
      conflict = error
      base = latest
      submitted = rebased
    }
  }

  throw conflict
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

const LATEST_SESSION_SAVE_INTERVAL_MS = 500
// While a turn is streaming, intermediate flushes only bound crash loss and the terminal commit
// still flushes at the normal cadence, so relax the intermediate cadence: each flush serializes
// the whole (growing) Session and must not run at the streaming tick rate.
const STREAMING_SESSION_SAVE_INTERVAL_MS = 2_000

type PendingLatestSessionSave = {
  target: string
  task: LatestSessionSaveTask
  options: SaveSessionOptions | undefined
  generation: number
  streaming?: boolean
  promise?: Promise<PersistedChatSession>
  bypassCadence?: boolean
  releaseCadence?: () => void
  recheckCadence?: () => void
}

class SessionPersistenceGenerationChangedError extends Error {
  constructor() {
    super('Session persistence hydration generation changed.')
    this.name = 'SessionPersistenceGenerationChangedError'
  }
}

class SessionExportSaveDeferred extends Error {
  constructor(readonly released: Promise<void>) {
    super('Session save waits for package export.')
  }
}

const deferExportedSessionSave = (target: string): void => {
  const blocked = (): boolean => {
    const operation = usePackageOperationStore.getState().operation
    return (
      operation?.kind === 'export' &&
      packageOperationActive(operation) &&
      target === `session:${operation.session?.sessionId}`
    )
  }
  if (!blocked()) return
  throw new SessionExportSaveDeferred(
    new Promise<void>((resolve) => {
      const remove = usePackageOperationStore.subscribe(() => {
        if (!blocked()) {
          remove()
          resolve()
        }
      })
    })
  )
}

// Serializes every renderer-originated Session write through one ordering seam. Store snapshots at
// the queue tail use latest-wins coalescing; explicit Session and Manifest writes remain barriers, so
// Artifact finalization cannot be overtaken by an older store snapshot.
const createOrderedSessionPersistence = (
  api: Pick<SessionPersistenceApi, 'saveSession' | 'saveManifest'>
): OrderedSessionPersistence => {
  let queue: Promise<unknown> = Promise.resolve()
  let pendingWriteCount = 0
  let activeFlushes = 0
  const deferredSaves = new Set<Promise<unknown>>()
  const acknowledgedRevisions = new Map<string, number>()
  const acknowledgedSessions = new Map<string, PersistedChatSession>()
  const acknowledgedSources = new Map<string, PersistedChatSession>()
  const pendingLatestByTarget = new Map<string, PendingLatestSessionSave>()
  // The queue swallows rejections to stay usable; retain terminal failures until that target heals.
  const failedWritesByTarget = new Map<string, unknown>()
  let hydrationGeneration = 0
  let latestSessionSaveStartedAt = Number.NEGATIVE_INFINITY

  const waitForLatestSessionSaveCadence = async (
    entry: PendingLatestSessionSave
  ): Promise<void> => {
    // A terminal save may downgrade an in-flight wait from the relaxed streaming cadence back to
    // the normal one; loop so the wait re-arms instead of sleeping out the streaming interval.
    for (;;) {
      const intervalMs = entry.streaming
        ? STREAMING_SESSION_SAVE_INTERVAL_MS
        : LATEST_SESSION_SAVE_INTERVAL_MS
      const waitMs = latestSessionSaveStartedAt + intervalMs - performance.now()
      if (waitMs <= 0 || entry.bypassCadence || activeFlushes > 0) break
      const recheck = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), waitMs)
        entry.releaseCadence = () => {
          clearTimeout(timeout)
          resolve(false)
        }
        entry.recheckCadence = () => {
          clearTimeout(timeout)
          resolve(true)
        }
      })
      entry.releaseCadence = undefined
      entry.recheckCadence = undefined
      if (!recheck) break
    }
    if (entry.generation === hydrationGeneration) latestSessionSaveStartedAt = performance.now()
  }

  const acknowledgeSession = (session: PersistedChatSession): void => {
    const revision = sessionRevision(session)
    const acknowledged = acknowledgedSessions.get(session.id)
    if (
      acknowledged &&
      (sessionRevision(acknowledged) > revision ||
        (sessionRevision(acknowledged) === revision && acknowledged.updatedAt > session.updatedAt))
    ) {
      return
    }
    acknowledgedRevisions.set(
      session.id,
      Math.max(acknowledgedRevisions.get(session.id) ?? 0, revision)
    )
    acknowledgedSessions.set(session.id, structuredClone(session))
  }

  // A revision acknowledges a complete snapshot, never just a counter. Replay the
  // caller's subsequent edits over the last receipt before advancing its revision.
  const prepareSessionSave = (
    session: PersistedChatSession,
    options?: SaveSessionOptions
  ): PersistedChatSession => {
    const durable = acknowledgedSessions.get(session.id)
    const revision = acknowledgedRevisions.get(session.id) ?? 0
    if (revision <= sessionRevision(session)) return structuredClone(session)
    const source = acknowledgedSources.get(session.id)
    if (!durable || !source || sessionRevision(session) < sessionRevision(source)) {
      throw new SessionRevisionConflictError(sessionRevision(session), revision)
    }
    const rebased = rebaseSessionAfterRevisionConflict(source, session, durable)
    if (!rebased) throw new SessionRevisionConflictError(sessionRevision(session), revision)
    for (const field of options?.conflictRebaseFields ?? []) {
      Object.assign(rebased, { [field]: structuredClone(session[field]) })
    }
    return rebased
  }

  const acknowledgeSavedSession = (
    source: PersistedChatSession,
    durable: PersistedChatSession
  ): void => {
    if (sessionRevision(durable) < (acknowledgedRevisions.get(durable.id) ?? 0)) return
    acknowledgeSession(durable)
    acknowledgedSources.set(durable.id, structuredClone(source))
  }

  const releasePendingLatestCadence = (): void => {
    for (const entry of pendingLatestByTarget.values()) {
      entry.bypassCadence = true
      entry.releaseCadence?.()
    }
  }

  const trackWrite = async <Result>(
    target: string,
    task: () => Promise<Result>
  ): Promise<Result> => {
    try {
      const result = await task()
      failedWritesByTarget.delete(target)
      return result
    } catch (error) {
      if (
        !(error instanceof SessionPersistenceGenerationChangedError) &&
        !(error instanceof SessionExportSaveDeferred)
      ) {
        failedWritesByTarget.set(target, error)
      }
      throw error
    }
  }

  // Exported targets wait outside the shared queue. Explicit writes for another Session and its
  // manifest can still establish their usual durable barrier before starting a new conversation.
  const schedule = <Result>(target: string, task: () => Promise<Result>): Promise<Result> => {
    pendingWriteCount += 1
    const run = queue.then(async () => {
      try {
        deferExportedSessionSave(target)
        return { kind: 'completed' as const, value: await trackWrite(target, task) }
      } catch (error) {
        if (error instanceof SessionExportSaveDeferred)
          return { kind: 'deferred' as const, released: error.released }
        throw error
      }
    })
    queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
      .then(async (result) => {
        if (result.kind === 'completed') return result.value
        const resumed = result.released.then(() => schedule(target, task))
        deferredSaves.add(resumed)
        try {
          return await resumed
        } finally {
          deferredSaves.delete(resumed)
        }
      })
      .finally(() => {
        pendingWriteCount -= 1
      })
  }

  const enqueue = <Result>(target: string, task: () => Promise<Result>): Promise<Result> => {
    releasePendingLatestCadence()
    pendingLatestByTarget.clear()
    return schedule(target, task)
  }

  const saveSubmittedSession = async (
    session: PersistedChatSession,
    options?: SaveSessionOptions
  ): Promise<PersistedChatSession> => {
    const submitted = prepareSessionSave(session, options)
    const durable = options
      ? await api.saveSession(submitted, options)
      : await api.saveSession(submitted)
    acknowledgeSavedSession(session, durable)
    return durable
  }

  const saveLatestSession = (
    target: string,
    task: LatestSessionSaveTask,
    options?: SaveSessionOptions,
    streaming?: boolean
  ): Promise<PersistedChatSession> => {
    const pending = pendingLatestByTarget.get(target)
    if (pending?.promise) {
      pending.task = task
      pending.options = mergeSaveSessionOptions(pending.options, options)
      if (pending.streaming && !streaming) {
        // The turn ended: flush the terminal snapshot at the normal cadence instead of waiting
        // out the relaxed streaming interval.
        pending.streaming = false
        pending.recheckCadence?.()
      }
      return pending.promise
    }

    const entry: PendingLatestSessionSave = {
      target,
      task,
      options,
      streaming,
      generation: hydrationGeneration
    }
    const runTask = async (): Promise<PersistedChatSession> => {
      // A fast IPC/disk round-trip otherwise defeats latest-wins coalescing and rewrites the entire
      // Session at the live presentation frame rate. Keep the entry replaceable while it waits.
      await waitForLatestSessionSaveCadence(entry)
      deferExportedSessionSave(target)
      if (pendingLatestByTarget.get(target) === entry) pendingLatestByTarget.delete(target)
      if (entry.generation !== hydrationGeneration) {
        throw new SessionPersistenceGenerationChangedError()
      }
      const durable = await entry.task(entry.options)
      acknowledgeSession(durable)
      return durable
    }
    const run = schedule(target, runTask)
    entry.promise = run
    pendingLatestByTarget.set(target, entry)
    return run
  }

  return {
    prepareSessionSave,
    acknowledgeSavedSession,
    saveLatestSession,
    seedAcknowledgedSessions: (sessions) => {
      // A newly hydrated store invalidates delayed snapshots from the previous store generation.
      // The shared queue still preserves barriers, but stale local state can no longer write later.
      hydrationGeneration += 1
      releasePendingLatestCadence()
      pendingLatestByTarget.clear()
      latestSessionSaveStartedAt = Number.NEGATIVE_INFINITY
      for (const target of failedWritesByTarget.keys()) {
        if (target.startsWith('session:')) failedWritesByTarget.delete(target)
      }
      for (const session of sessions) {
        acknowledgedRevisions.set(session.id, sessionRevision(session))
        acknowledgedSessions.set(session.id, structuredClone(session))
        acknowledgedSources.set(session.id, structuredClone(session))
      }
    },
    getAcknowledgedSession: (sessionId) => {
      const session = acknowledgedSessions.get(sessionId)
      return session ? structuredClone(session) : undefined
    },
    releaseAcknowledgedSessionBody: (sessionId) => {
      if (pendingWriteCount > 0 || failedWritesByTarget.has(`session:${sessionId}`)) return false
      acknowledgedSessions.delete(sessionId)
      acknowledgedSources.delete(sessionId)
      // Keep the small revision watermark: later explicit writes must not regress their revision.
      return true
    },
    clearWriteFailure: (target) => failedWritesByTarget.delete(target),
    clearWriteFailures: () => failedWritesByTarget.clear(),
    saveSession: (session, options) =>
      enqueue(`session:${session.id}`, () => saveSubmittedSession(session, options)),
    saveSessionWithRecovery: (session, options, recover) =>
      enqueue(`session:${session.id}`, async () => {
        const submitted = prepareSessionSave(session, options)
        let durable: PersistedChatSession
        try {
          durable = await saveSubmittedSession(submitted, options)
        } catch (error) {
          durable = await recover(error, submitted, saveSubmittedSession)
        }
        acknowledgeSavedSession(session, durable)
        return durable
      }),
    saveManifest: (request) => enqueue('manifest', () => api.saveManifest(request)),
    flush: async () => {
      // Runtime/store updates can admit new snapshots while earlier writes are in flight.
      // Keep cadence disabled until every overlapping flush has finished.
      activeFlushes += 1
      try {
        releasePendingLatestCadence()
        for (;;) {
          const draining = queue
          await draining
          await Promise.allSettled([...deferredSaves])
          if (queue === draining && deferredSaves.size === 0) break
        }
        const failure = failedWritesByTarget.values().next()
        if (!failure.done) throw failure.value
      } finally {
        activeFlushes -= 1
      }
    }
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

const unresolvedSessionRevisionConflictTargets = new Set<string>()

const resetSessionPersistenceWriteFailuresForTests = (): void => {
  liveSessionPersistence.clearWriteFailures()
}

const saveSessionInOrder = async (
  session: PersistedChatSession,
  persistence: OrderedSessionPersistence = liveSessionPersistence,
  api: SessionReadApi = window.api.sessions
): Promise<PersistedChatSession> => {
  const target = `session:${session.id}`
  try {
    const durable = await persistence.saveSessionWithRecovery(
      session,
      undefined,
      async (error, submitted, retry) => {
        if (!isSessionRevisionConflictError(error)) throw error
        const base = persistence.getAcknowledgedSession(submitted.id)
        if (!base) throw error
        return saveAfterSessionRevisionConflict(
          error,
          base,
          submitted,
          () =>
            loadPersistedSession(
              {
                projectId: submitted.projectId,
                sessionId: submitted.id
              },
              api
            ),
          retry
        )
      }
    )
    unresolvedSessionRevisionConflictTargets.delete(target)
    return durable
  } catch (error) {
    if (isSessionRevisionConflictError(error)) unresolvedSessionRevisionConflictTargets.add(target)
    throw error
  }
}

const confirmPendingDelegationPolicyAuthority = async (
  session: ChatSession
): Promise<PersistedChatSession | undefined> => {
  if (!session.delegationPolicyAuthorityPending) return undefined
  const materialized = await saveSessionInOrder(
    toPersistedSessionForAuthorityMaterialization(session)
  )
  return setDelegationPolicyAuthority(
    materialized.projectId,
    materialized.id,
    session.delegationPolicy ?? 'allow'
  )
}

class SessionPersistenceFlushConflictError extends Error {
  readonly code = 'session-revision-conflict' as const

  constructor() {
    super('Session persistence has an unresolved revision conflict.')
    this.name = 'SessionPersistenceFlushConflictError'
  }
}

const flushSessionPersistence = async (): Promise<void> => {
  await liveSessionPersistence.flush()
  if (unresolvedSessionRevisionConflictTargets.size > 0) {
    throw new SessionPersistenceFlushConflictError()
  }
}

// The one artifact command startup reconciliation needs; kept narrow so it is trivial to fake in tests.
type ArtifactReconcileApi = {
  reconcilePendingArtifacts: (
    request: ReconcilePendingArtifactsRequest
  ) => Promise<ReconcilePendingArtifactsResult>
}

const invalidArtifactFinalizationProofError = (message: string): Error =>
  Object.assign(new Error(message), { code: ARTIFACT_FINALIZATION_INVALID_PROOF })

const isInvalidArtifactFinalizationProofError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === ARTIFACT_FINALIZATION_INVALID_PROOF

// A crash between persisting a pending artifact reference and finalizing it strands the file in
// `.pending/<run>/`. The path segment is stable across OSes, so detect it structurally.
const isPendingArtifactPath = (path: string | undefined): path is string =>
  typeof path === 'string' && path.split(/[\\/]/).includes('.pending')

const pendingArtifactRunId = (path: string | undefined): string | undefined => {
  if (!path) return undefined
  const parts = path.split(/[\\/]/)
  const pendingIndex = parts.lastIndexOf('.pending')
  return pendingIndex >= 0 ? parts[pendingIndex + 1] : undefined
}

const pendingArtifactRequests = (
  session: ChatSession,
  includeNativeVersions = false
): Array<{ messageId: string; pendingPaths: string[]; artifactVersionIds?: string[] }> => {
  const artifactsById = new Map(
    (session.artifacts ?? []).map((artifact) => [artifact.id, artifact])
  )
  const messages = session.conversationGraph?.messages ?? session.messages
  return messages.flatMap((message) => {
    const artifacts = (message.artifactIds ?? []).flatMap((id) => {
      const artifact = artifactsById.get(id)
      return artifact ? [artifact] : []
    })
    const pendingPaths = artifacts.map((artifact) => artifact.path).filter(isPendingArtifactPath)
    const artifactVersionIds = includeNativeVersions
      ? [
          ...new Set(
            artifacts.flatMap((artifact) => (artifact.versionId ? [artifact.versionId] : []))
          )
        ]
      : []
    return pendingPaths.length > 0 || artifactVersionIds.length > 0
      ? [
          {
            messageId: message.id,
            pendingPaths,
            ...(artifactVersionIds.length > 0 ? { artifactVersionIds } : {})
          }
        ]
      : []
  })
}

const reconcileSessionPendingArtifacts = async (
  session: ChatSession,
  api: ArtifactReconcileApi,
  includeNativeVersions = false
): Promise<void> => {
  if (session.isPending || !session.projectId) return

  let firstFailure: unknown
  for (const request of pendingArtifactRequests(session, includeNativeVersions)) {
    try {
      const result = await api.reconcilePendingArtifacts({
        projectId: session.projectId,
        sessionId: session.id,
        ...request
      })
      if (!Array.isArray(result)) throw invalidArtifactFinalizationProofError(result.message)
      const finalized = result
      const recoveredVersionIds = new Set(
        finalized.flatMap((artifact) => (artifact.versionId ? [artifact.versionId] : []))
      )
      if (request.artifactVersionIds?.some((versionId) => !recoveredVersionIds.has(versionId))) {
        throw new Error('Artifact finalization did not resolve all native Versions.')
      }
      if (finalized.length > 0) {
        const current = useSessionStore
          .getState()
          .sessions.find((candidate) => candidate.id === session.id)
        const message = (current?.conversationGraph?.messages ?? current?.messages ?? []).find(
          (candidate) => candidate.id === request.messageId
        )
        const artifactsById = new Map(
          (current?.artifacts ?? []).map((artifact) => [artifact.id, artifact])
        )
        const recoveredRunIds = new Set(
          finalized.flatMap((artifact) => (artifact.runId ? [artifact.runId] : []))
        )
        const recoveredCompatibilityNames = new Set(
          finalized.flatMap((artifact) => (!artifact.versionId ? [artifact.name] : []))
        )
        const preserveArtifactIds = (message?.artifactIds ?? []).filter((artifactId) => {
          const artifact = artifactsById.get(artifactId)
          if (!isPendingArtifactPath(artifact?.path)) return true
          const runId = pendingArtifactRunId(artifact.path)
          const name = artifact.name ?? artifact.path.split(/[\\/]/).at(-1)
          return (
            (!runId || !recoveredRunIds.has(runId)) &&
            (!name || !recoveredCompatibilityNames.has(name))
          )
        })
        useSessionStore.getState().replaceMessageArtifacts({
          sessionId: session.id,
          messageId: request.messageId,
          artifacts: finalized,
          preserveArtifactIds
        })
      }
    } catch (error) {
      firstFailure ??= error
    }
  }
  if (firstFailure) throw firstFailure
}

const retryPendingArtifactFinalization = async (
  sessionId: string,
  api: ArtifactReconcileApi = window.api.artifacts
): Promise<void> => {
  const session = useSessionStore
    .getState()
    .sessions.find((candidate) => candidate.id === sessionId)
  if (!session) throw new Error('Session not found.')

  try {
    if (pendingArtifactRequests(session, true).length === 0) {
      throw new Error('No pending Artifact references are available to retry.')
    }
    await reconcileSessionPendingArtifacts(session, api, true)
    const current = useSessionStore
      .getState()
      .sessions.find((candidate) => candidate.id === sessionId)
    if (current && pendingArtifactRequests(current).length > 0) {
      throw new Error('Artifact finalization did not resolve all pending files.')
    }
    useSessionStore.getState().clearArtifactError(sessionId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    useSessionStore
      .getState()
      .recordArtifactError(sessionId, message, !isInvalidArtifactFinalizationProofError(error))
    reportPersistenceError(error, 'artifact-reconcile')
    throw error
  }
}

// Re-finalizes artifacts a prior crash left in `.pending` after the in-memory finalize claim was lost.
// For each hydrated message still referencing a pending path, ask the main process to complete the
// move (idempotent) and replace the message's stale references with the finalized files. Runs once at
// startup after the store saver is subscribed, so each replacement is persisted. Per-message failures
// are isolated and never block the rest; an empty result leaves references untouched so a file still
// readable at its pending path is never dropped.
const reconcilePendingArtifacts = async (api: ArtifactReconcileApi): Promise<void> => {
  for (const session of useSessionStore.getState().sessions) {
    try {
      await reconcileSessionPendingArtifacts(
        session,
        api,
        isArtifactFinalizationError(session.error)
      )
      const current = useSessionStore
        .getState()
        .sessions.find((candidate) => candidate.id === session.id)
      if (
        current &&
        isArtifactFinalizationError(current.error) &&
        pendingArtifactRequests(current).length === 0
      ) {
        useSessionStore.getState().clearArtifactError(session.id)
      }
    } catch (error) {
      reportPersistenceError(error, 'artifact-reconcile')
    }
  }
}

type SessionStoreSnapshot = {
  sessions: ChatSession[]
  selectedSessionId: string | undefined
  streamingMessages?: StreamingMessageContentByMessageId
}

type SessionCatalogRecovery =
  | { kind: 'ready' }
  | {
      kind: 'repairable'
      reason: 'session-scan' | 'startup-reconciliation'
    }
  | {
      kind: 'damaged-authority'
      affectedFiles: Array<{ projectId: string; fileName: string }>
    }
  | {
      kind: 'unsupported-version'
      affectedFileCount: number
    }
  | {
      kind: 'oversized-authority'
      affectedFiles: Array<{ projectId: string; fileName: string }>
    }
  | { kind: 'project-deletion-recovery' }

const READY_SESSION_CATALOG_RECOVERY: SessionCatalogRecovery = Object.freeze({ kind: 'ready' })

const deriveSessionCatalogRecovery = (
  diagnostics: SessionLoadDiagnostics | undefined
): SessionCatalogRecovery => {
  if (!diagnostics) return READY_SESSION_CATALOG_RECOVERY
  if (diagnostics.isProjectDeletionRecoveryComplete === false) {
    return { kind: 'project-deletion-recovery' }
  }

  const sessionWarnings = diagnostics.warnings.filter((warning) => 'projectId' in warning)
  const unsupportedVersionWarnings = sessionWarnings.filter(
    (warning) => warning.kind === 'unsupported-version'
  )
  if (unsupportedVersionWarnings.length > 0) {
    return {
      kind: 'unsupported-version',
      affectedFileCount: unsupportedVersionWarnings.length
    }
  }
  const oversizedWarnings = sessionWarnings.filter((warning) => warning.kind === 'too-large')
  if (oversizedWarnings.length > 0) {
    return {
      kind: 'oversized-authority',
      affectedFiles: oversizedWarnings.map(({ projectId, fileName }) => ({ projectId, fileName }))
    }
  }
  if (diagnostics.isComplete === false) {
    return {
      kind: 'repairable',
      reason:
        diagnostics.failure === 'startup-reconciliation-failed'
          ? 'startup-reconciliation'
          : 'session-scan'
    }
  }

  const damagedWarnings = sessionWarnings.filter(
    (warning) => warning.kind === 'corrupt' && warning.recovered
  )
  if (damagedWarnings.length > 0) {
    return {
      kind: 'damaged-authority',
      affectedFiles: damagedWarnings.map(({ projectId, fileName }) => ({ projectId, fileName }))
    }
  }

  // A warning outside a partial scan should remain recoverable rather than being collapsed into a
  // healthy catalog if a future Main diagnostic can report a readable-but-unresolved Session.
  if (sessionWarnings.length > 0) {
    return { kind: 'repairable', reason: 'session-scan' }
  }
  return READY_SESSION_CATALOG_RECOVERY
}

type SessionPersistenceState = {
  isHydrated: boolean
  isLoading: boolean
  isReady: boolean
  hasCompleteSessionCatalog: boolean
  catalogRecovery: SessionCatalogRecovery
  canDeleteSessionsAndProjects: boolean
  loadError: string | undefined
  loadWarning: string | undefined
  writeError: string | undefined
  writeErrorRetryable: boolean
  persistenceBlockedSessionIds: readonly string[]
  reportSessionSizeLimit: (sessionId: string) => void
  dismissWriteWarning: () => void
  dismissLoadWarning: () => void
  startNewConversationAfterSizeLimit: () => void
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

type StoreSaver = {
  (state: SessionStoreSnapshot, options?: StoreSaverOptions): Promise<unknown>
  releaseReadOnlySession: (source: ChatSession, summary: ChatSession) => boolean
}

const pruneRemovedSessionWriteTargets = (
  targets: Set<string>,
  sessions: readonly Pick<ChatSession, 'id'>[],
  conflictRebaseFields?: Map<string, SessionConflictRebaseField[]>,
  ...relatedTargets: Set<string>[]
): void => {
  const activeSessionTargets = new Set(sessions.map((session) => `session:${session.id}`))
  for (const target of targets) {
    if (target.startsWith('session:') && !activeSessionTargets.has(target)) {
      targets.delete(target)
      conflictRebaseFields?.delete(target)
      for (const related of relatedTargets) related.delete(target)
      liveSessionPersistence.clearWriteFailure(target)
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
const SESSION_REVISION_CONFLICT_WRITE_ERROR =
  'This conversation changed in another window. Your local changes were not saved. Retry to reload the latest version before closing the app.'
const SESSION_SIZE_LIMIT_WRITE_ERROR =
  'This conversation exceeded the 256 MiB storage limit. Its current run was stopped. Start a new conversation to keep working. Changes after the last successful save are not durable.'

// Hydrates the in-memory session store from the per-session files loaded by the main process.
const loadPersistedSessions = async (
  api: SessionPersistenceApi,
  shouldHydrate: () => boolean = () => true,
  preferredSelection?: SessionHydrationSelection
): Promise<LoadAllSessionsResult | ListSessionSummariesResult | undefined> => {
  if (api.list) {
    const result = await api.list()
    if (!shouldHydrate()) return undefined
    const retrySessionId = preferredSelection?.sessionId
    const summariesToHydrate = result.sessions.filter(
      (session) => session.needsStartupRecovery || session.id === retrySessionId
    )
    const hydratedSessions = new Map(
      await Promise.all(
        summariesToHydrate.map(
          async (summary) =>
            [
              summary.id,
              await loadPersistedSession(
                { projectId: summary.projectId, sessionId: summary.id },
                api
              )
            ] as const
        )
      )
    )
    const selected = retrySessionId ? hydratedSessions.get(retrySessionId) : undefined
    if (!shouldHydrate()) return undefined
    const missing = summariesToHydrate.find((summary) => !hydratedSessions.get(summary.id))
    if (missing) {
      throw new Error(
        'Session JSON requiring startup hydration is missing from the SQLite projection.'
      )
    }
    useSessionStore
      .getState()
      .hydrateSessionSummaries(result.sessions, selected, result.manifest, preferredSelection)
    for (const hydrated of hydratedSessions.values()) {
      if (hydrated && hydrated.id !== selected?.id) {
        useSessionStore.getState().upsertPersistedSession(hydrated)
      }
    }
    return result
  }

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

// Main-owned metadata and the transient navigation guard must not enqueue a local snapshot.
// A same-client receipt can update Main-owned fields before the save response arrives.
// Keep branchContextResetRequired in the comparison: clearing it is a renderer-persisted change.
const withoutMainOwnedOrTransientSessionMetadata = (session: ChatSession): ChatSession => ({
  ...session,
  branchSwitchBlocked: undefined,
  activePlanProjection: undefined,
  interactionState: undefined,
  agentPromptInFlight: undefined,
  awaitingFirstAgentOutput: undefined,
  revision: undefined,
  archivedAt: undefined,
  enabledComputeHosts: undefined,
  selectedComputeHosts: undefined,
  computeConcurrencyLimit: undefined
})

const selectedRootBranchId = (
  session: Pick<PersistedChatSession, 'conversationGraph'> | undefined
): string | undefined =>
  session?.conversationGraph?.frames.find(
    (frame) => frame.id === session.conversationGraph?.rootFrameId
  )?.activeBranchId

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
  let previousStreamingMessages = initial.streamingMessages ?? {}
  const acknowledgedRevisions = new Map(
    initial.sessions
      .filter((session) => session.contentLoaded !== false)
      .map((session) => [session.id, sessionRevision(session)])
  )
  const acknowledgedSessions = new Map(
    initial.sessions
      .filter((session) => session.contentLoaded !== false)
      .map((session) => [session.id, toPersistedSession(session)])
  )
  persistence.seedAcknowledgedSessions([...acknowledgedSessions.values()])
  // Keep an explicit local selection until its own receipt; a queued runtime update can coalesce
  // with that save, and an older receipt must not clear a newer navigation intent.
  const pendingBranchSelections = new Map<
    string,
    NonNullable<PersistedChatSession['conversationGraph']>
  >()

  const recoverRevisionConflict = async (
    error: unknown,
    submitted: PersistedChatSession,
    base: PersistedChatSession | undefined,
    options: SaveSessionOptions | undefined,
    save: SessionPersistenceApi['saveSession']
  ): Promise<PersistedChatSession> => {
    if (!isSessionRevisionConflictError(error)) throw error
    if (!base) throw error
    return saveAfterSessionRevisionConflict(
      error,
      base,
      submitted,
      () =>
        loadPersistedSession(
          {
            projectId: submitted.projectId,
            sessionId: submitted.id
          },
          api
        ),
      (rebased) => (options ? save(rebased, options) : save(rebased))
    )
  }

  const save: StoreSaver = (state, options) => {
    const nextSessions = state.sessions
    const previousById = indexById(previousSessions)
    const nextById = indexById(nextSessions)
    // Pure text-growth ticks keep Session identity stable and only advance the streaming slice, so
    // the slice diff must also mark a Session dirty or in-flight text would never reach disk until
    // the next identity-changing event.
    const nextStreamingMessages = state.streamingMessages ?? {}
    const streamingSessionIds = new Set<string>()
    for (const entry of Object.values(nextStreamingMessages)) {
      streamingSessionIds.add(entry.sessionId)
    }
    const streamingDirtySessionIds = new Set<string>()
    if (nextStreamingMessages !== previousStreamingMessages) {
      for (const [messageId, entry] of Object.entries(nextStreamingMessages)) {
        if (previousStreamingMessages[messageId] !== entry) {
          streamingDirtySessionIds.add(entry.sessionId)
        }
      }
      for (const [messageId, entry] of Object.entries(previousStreamingMessages)) {
        if (!(messageId in nextStreamingMessages)) streamingDirtySessionIds.add(entry.sessionId)
      }
    }
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
      const previousSession = previousById.get(session.id)
      if (session.contentLoaded === false) {
        if (previousSession === session && !isForced) continue
        const conflictRebaseFields = [
          ...new Set([
            ...(previousSession
              ? (['title', 'pinned'] as const).filter((field) =>
                  conflictRebaseFieldChanged(previousSession, session, field)
                )
              : []),
            ...(options?.conflictRebaseFieldsByTarget?.get(target) ?? [])
          ])
        ].filter((field): field is 'title' | 'pinned' => field === 'title' || field === 'pinned')
        // Catalog hydration changes object identity without introducing a local metadata edit.
        if (!isForced && conflictRebaseFields.length === 0) continue
        const saveOptions = conflictRebaseFields.length > 0 ? { conflictRebaseFields } : undefined
        tasks.push({
          target,
          failureContext: { conflictRebaseFields },
          run: () =>
            persistence.saveLatestSession(
              target,
              async (coalescedOptions) => {
                const authority = await loadPersistedSession(
                  {
                    projectId: session.projectId,
                    sessionId: session.id
                  },
                  api
                )
                if (!authority) throw new Error('Session JSON is missing for metadata persistence.')
                const fields = new Set(coalescedOptions?.conflictRebaseFields ?? [])
                const candidate: PersistedChatSession = {
                  ...authority,
                  ...(fields.has('title') ? { title: session.title } : {}),
                  ...(fields.has('pinned') ? { pinned: session.pinned } : {}),
                  ...(fields.size > 0
                    ? { updatedAt: Math.max(authority.updatedAt, session.updatedAt) }
                    : {})
                }
                const durable = coalescedOptions
                  ? await api.saveSession(candidate, coalescedOptions)
                  : await api.saveSession(candidate)
                acknowledgedRevisions.set(session.id, sessionRevision(durable))
                acknowledgedSessions.set(session.id, durable)
                useSessionStore.getState().upsertPersistedSession(durable)
                return durable
              },
              saveOptions
            )
        })
        continue
      }
      const authority = isExternallyHydratedSession(session)
        ? getExternallyHydratedSessionAuthority(session)
        : undefined
      if (authority) {
        const previousAuthority = acknowledgedSessions.get(session.id)
        const authorityIsNewer =
          !previousAuthority ||
          sessionRevision(authority) > sessionRevision(previousAuthority) ||
          (sessionRevision(authority) === sessionRevision(previousAuthority) &&
            authority.updatedAt >= previousAuthority.updatedAt)
        acknowledgedRevisions.set(
          session.id,
          Math.max(acknowledgedRevisions.get(session.id) ?? 0, sessionRevision(authority))
        )
        if (authorityIsNewer) acknowledgedSessions.set(session.id, authority)
      }

      const hasUnsavedLocalTitle =
        session.unsavedTitle === true && Boolean(authority && session.title !== authority.title)
      const rootBranchId = selectedRootBranchId(session)
      const graph = session.conversationGraph
      const previousGraph = previousSession?.conversationGraph
      if (
        graph &&
        previousGraph &&
        (rootBranchId !== selectedRootBranchId(previousSession) ||
          // Hydration retains the local root selection but can adopt remote descendant choices.
          (!authority &&
            (graph.activeFrameId !== previousGraph.activeFrameId ||
              previousGraph.frames.some(
                (previousFrame) =>
                  graph.frames.find((frame) => frame.id === previousFrame.id)?.activeBranchId !==
                  previousFrame.activeBranchId
              ))))
      ) {
        pendingBranchSelections.set(session.id, graph)
      }
      const selectionIntent = pendingBranchSelections.get(session.id)
      const hasRetainedLocalRootBranch =
        !selectionIntent &&
        rootBranchId !== undefined &&
        authority?.conversationGraph &&
        rootBranchId !== selectedRootBranchId(authority)
      // A retained local reset applies to this window's Branch. Publishing it against another
      // client's selected Branch would also write this window's old selection back to disk.
      const hasUnsavedContextReset =
        !hasRetainedLocalRootBranch &&
        Boolean(session.branchContextResetRequired) !==
          Boolean(authority?.branchContextResetRequired)
      if (
        previousSession &&
        previousSession !== session &&
        !isForced &&
        !hasUnsavedLocalTitle &&
        !(authority && hasUnsavedContextReset) &&
        !streamingDirtySessionIds.has(session.id) &&
        shallow(
          withoutMainOwnedOrTransientSessionMetadata(previousSession),
          withoutMainOwnedOrTransientSessionMetadata(session)
        )
      ) {
        continue
      }
      if (
        (previousById.get(session.id) !== session ||
          isForced ||
          streamingDirtySessionIds.has(session.id)) &&
        (isForced ||
          streamingDirtySessionIds.has(session.id) ||
          !isExternallyHydratedSession(session) ||
          hasUnsavedLocalTitle ||
          hasUnsavedContextReset) &&
        !hasStagedUploads(session) &&
        // A terminal graph-integrity failure keeps the renderer responsive, but the flat projection
        // is no longer proven to match the immutable Branch graph. Preserve the last durable copy.
        !session.conversationGraphSyncBlocked
      ) {
        const changedConflictRebaseFields = previousSession
          ? SESSION_CONFLICT_REBASE_FIELDS.filter((field) =>
              conflictRebaseFieldChanged(previousSession, session, field)
            )
          : []
        const conflictRebaseFields = [
          ...new Set([
            ...changedConflictRebaseFields,
            ...(hasUnsavedLocalTitle ? (['title'] as const) : []),
            ...(options?.conflictRebaseFieldsByTarget?.get(target) ?? [])
          ])
        ]

        const saveOptions = conflictRebaseFields.length > 0 ? { conflictRebaseFields } : undefined
        const sourceAuthority = acknowledgedSessions.get(session.id)
        let submittedAuthority = sourceAuthority
        const serializeSession = (): PersistedChatSession => {
          let persisted = toPersistedSession(session, nextStreamingMessages)
          // Explicit navigation already carries all ancestor and descendant selections. Only
          // passive saves restore the authority's root Branch over a retained window-local view.
          const selected = selectionIntent ? undefined : selectedRootBranchId(sourceAuthority)
          const graph = persisted.conversationGraph
          if (
            selected &&
            graph &&
            selected !== selectedRootBranchId(persisted) &&
            graph.branches.some((branch) => branch.id === selected)
          ) {
            const conversationGraph = activateConversationBranch(graph, selected)
            persisted = {
              ...persisted,
              conversationGraph,
              messages: resolveActiveConversationMessages(conversationGraph).map(
                projectConversationMessage
              ),
              ...resolveActiveConversationActivities(conversationGraph),
              branchContextResetRequired: sourceAuthority?.branchContextResetRequired
            }
          }
          // A passive queued snapshot can predate a remotely created Branch. Rebase its changes
          // before using a newer revision. Explicit navigation already selects the intended Branch.
          submittedAuthority = acknowledgedSessions.get(session.id)
          if (
            !selectionIntent &&
            sourceAuthority &&
            submittedAuthority &&
            selectedRootBranchId(sourceAuthority) !== selectedRootBranchId(submittedAuthority)
          ) {
            const rebased = rebaseSessionAfterRevisionConflict(
              sourceAuthority,
              persisted,
              submittedAuthority
            )
            if (!rebased) {
              throw new SessionRevisionConflictError(
                sessionRevision(sourceAuthority),
                sessionRevision(submittedAuthority)
              )
            }
            persisted = rebased
          }
          return persistence.prepareSessionSave(persisted, saveOptions)
        }

        const applyDurableSession = (
          durableSession: PersistedChatSession,
          options: SaveSessionOptions | undefined,
          recoveredRevisionConflict = false
        ): void => {
          if (selectionIntent && pendingBranchSelections.get(session.id) === selectionIntent) {
            pendingBranchSelections.delete(session.id)
          }
          const keepLocalBranch = selectedRootBranchId(durableSession) !== rootBranchId
          useSessionStore.getState().applyDurableSessionProjection({
            source: session,
            session: durableSession,
            mode:
              !keepLocalBranch &&
              (recoveredRevisionConflict || (options?.conflictRebaseFields?.length ?? 0) > 0)
                ? 'replace-persisted-if-current'
                : 'merge-upload-identities'
          })
        }

        tasks.push({
          target,
          failureContext: { conflictRebaseFields },
          run: isForced
            ? async () => {
                const persisted = observePersistencePhase('session-serialize', serializeSession)
                let durableSession: PersistedChatSession
                let recoveredRevisionConflict = false
                try {
                  durableSession = await persistence.saveSessionWithRecovery(
                    persisted,
                    saveOptions,
                    async (error, submitted, retry) => {
                      const recovered = await recoverRevisionConflict(
                        error,
                        submitted,
                        submittedAuthority,
                        saveOptions,
                        retry
                      )
                      recoveredRevisionConflict = true
                      return recovered
                    }
                  )
                } catch (finalError) {
                  reportPersistenceError(finalError, 'session-save')
                  throw finalError
                }
                persistence.acknowledgeSavedSession(
                  toPersistedSession(session, nextStreamingMessages),
                  durableSession
                )
                acknowledgedRevisions.set(session.id, sessionRevision(durableSession))
                acknowledgedSessions.set(session.id, durableSession)
                observePersistencePhase('session-apply-durable', () =>
                  applyDurableSession(durableSession, saveOptions, recoveredRevisionConflict)
                )
              }
            : () =>
                persistence.saveLatestSession(
                  target,
                  async (coalescedOptions) => {
                    const persisted = observePersistencePhase('session-serialize', serializeSession)
                    let durableSession: PersistedChatSession
                    let recoveredRevisionConflict = false
                    try {
                      durableSession = coalescedOptions
                        ? await api.saveSession(persisted, coalescedOptions)
                        : await api.saveSession(persisted)
                    } catch (error) {
                      try {
                        durableSession = await recoverRevisionConflict(
                          error,
                          persisted,
                          submittedAuthority,
                          coalescedOptions,
                          api.saveSession
                        )
                        recoveredRevisionConflict = true
                      } catch (finalError) {
                        reportPersistenceError(finalError, 'session-save')
                        throw finalError
                      }
                    }
                    persistence.acknowledgeSavedSession(
                      toPersistedSession(session, nextStreamingMessages),
                      durableSession
                    )
                    acknowledgedRevisions.set(session.id, sessionRevision(durableSession))
                    acknowledgedSessions.set(session.id, durableSession)
                    observePersistencePhase('session-apply-durable', () =>
                      applyDurableSession(
                        durableSession,
                        coalescedOptions,
                        recoveredRevisionConflict
                      )
                    )
                    return durableSession
                  },
                  saveOptions,
                  // In-flight turns flush intermediate snapshots at the relaxed streaming cadence;
                  // the terminal commit (streaming slice empty again) reverts to the normal one.
                  streamingSessionIds.has(session.id)
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
                lastSessionId: state.selectedSessionId
              })
            } catch (error) {
              reportPersistenceError(error, 'session-manifest-save')
              throw error
            }
          }
        })
      }
    }

    for (const id of pendingBranchSelections.keys()) {
      if (!nextById.has(id)) pendingBranchSelections.delete(id)
    }
    previousSessions = nextSessions
    previousSelection = state.selectedSessionId
    previousStreamingMessages = nextStreamingMessages

    const scheduledTasks = tasks.map(({ target, run, failureContext }) => {
      // Invoke every task now so it takes its place in the shared persistence queue at snapshot time.
      return run().then(
        (result) => {
          observer.onSuccess?.(target)
          return result
        },
        (error: unknown) => {
          if (error instanceof SessionPersistenceGenerationChangedError) return undefined
          observer.onFailure?.(target, error, failureContext)
          throw error
        }
      )
    })

    return Promise.all(scheduledTasks).then(() => undefined)
  }
  save.releaseReadOnlySession = (source, summary) => {
    const current = useSessionStore.getState()
    if (
      current.selectedSessionId === source.id ||
      current.sessions.find((session) => session.id === source.id) !== source ||
      previousSessions.find((session) => session.id === source.id) !== source ||
      !persistence.releaseAcknowledgedSessionBody(source.id)
    )
      return false
    acknowledgedSessions.delete(source.id)
    // Change the diff baseline before publishing the summary. Unloading is not a metadata edit
    // and must not enqueue a save which loads the same body straight back into the store.
    previousSessions = current.sessions.map((session) => (session === source ? summary : session))
    useSessionStore.setState({ sessions: previousSessions })
    return true
  }
  return save
}

// Starts session persistence and returns health/recovery state so App can gate input and surface failures.
const useSessionPersistence = (): SessionPersistenceState => {
  const { t } = useTranslation()
  const translateRef = useRef(t)
  useEffect(() => {
    translateRef.current = t
  }, [t])
  const [isHydrated, setIsHydrated] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isReady, setIsReady] = useState(false)
  const [hasCompleteSessionCatalog, setHasCompleteSessionCatalog] = useState(false)
  const [catalogRecovery, setCatalogRecovery] = useState<SessionCatalogRecovery>(
    READY_SESSION_CATALOG_RECOVERY
  )
  const [canDeleteSessionsAndProjects, setCanDeleteSessionsAndProjects] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [loadWarning, setLoadWarning] = useState<string | undefined>(undefined)
  const [writeError, setWriteError] = useState<string | undefined>(undefined)
  const [writeErrorRetryable, setWriteErrorRetryable] = useState(true)
  const [persistenceBlockedSessionIds, setPersistenceBlockedSessionIds] = useState<
    readonly string[]
  >([])
  const [loadAttempt, setLoadAttempt] = useState(0)
  const retrySelection = useRef<SessionHydrationSelection | undefined>(undefined)
  const failedWriteTargets = useRef(new Set<string>())
  const failedConflictRebaseFields = useRef(new Map<string, SessionConflictRebaseField[]>())
  const revisionConflictTargets = useRef(new Set<string>())
  const sizeLimitTargets = useRef(new Set<string>())
  const retryManifestWritePending = useRef(false)
  const saverRef = useRef<StoreSaver | undefined>(undefined)
  const presentOutstandingWriteFailures = useCallback((): void => {
    if (revisionConflictTargets.current.size > 0) {
      setWriteError(translateRef.current(SESSION_REVISION_CONFLICT_WRITE_ERROR))
      setWriteErrorRetryable(true)
      return
    }
    if ([...failedWriteTargets.current].some((target) => !sizeLimitTargets.current.has(target))) {
      setWriteError(SAFE_SESSION_WRITE_ERROR)
      setWriteErrorRetryable(true)
      return
    }
    if (sizeLimitTargets.current.size > 0) {
      setWriteError(translateRef.current(SESSION_SIZE_LIMIT_WRITE_ERROR))
      setWriteErrorRetryable(false)
      return
    }
    setWriteError(undefined)
    setWriteErrorRetryable(true)
  }, [])
  const reportSessionSizeLimit = useCallback(
    (sessionId: string): void => {
      const target = `session:${sessionId}`
      failedWriteTargets.current.add(target)
      sizeLimitTargets.current.add(target)
      setPersistenceBlockedSessionIds(
        [...sizeLimitTargets.current].map((candidate) => candidate.slice('session:'.length))
      )
      presentOutstandingWriteFailures()
    },
    [presentOutstandingWriteFailures]
  )
  // Dismiss only the presentation; failed targets still block flush and remain retryable.
  const dismissWriteWarning = useCallback(() => setWriteError(undefined), [])
  const dismissLoadWarning = useCallback(() => setLoadWarning(undefined), [])
  const startNewConversationAfterSizeLimit = useCallback(() => {
    for (const target of sizeLimitTargets.current) {
      failedWriteTargets.current.delete(target)
      failedConflictRebaseFields.current.delete(target)
      revisionConflictTargets.current.delete(target)
      unresolvedSessionRevisionConflictTargets.delete(target)
      liveSessionPersistence.clearWriteFailure(target)
    }
    useSessionStore.getState().clearSelection()
    setWriteError(undefined)
    setWriteErrorRetryable(true)
  }, [])
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
    setCatalogRecovery(READY_SESSION_CATALOG_RECOVERY)
    setCanDeleteSessionsAndProjects(false)
    setLoadError(undefined)
    setLoadWarning(undefined)
    setWriteError(undefined)
    setWriteErrorRetryable(true)
    sizeLimitTargets.current.clear()
    setPersistenceBlockedSessionIds([])
    retryManifestWritePending.current = false
    setLoadAttempt((attempt) => attempt + 1)
  }, [isHydrated])
  const retryWrites = useCallback(() => {
    if (revisionConflictTargets.current.size > 0) {
      retryLoad()
      return
    }
    const saver = saverRef.current
    if (!saver || failedWriteTargets.current.size === 0) return

    const state = useSessionStore.getState()
    pruneRemovedSessionWriteTargets(
      failedWriteTargets.current,
      state.sessions,
      failedConflictRebaseFields.current,
      revisionConflictTargets.current,
      unresolvedSessionRevisionConflictTargets,
      sizeLimitTargets.current
    )
    setPersistenceBlockedSessionIds(
      [...sizeLimitTargets.current]
        .filter((target) => target.startsWith('session:'))
        .map((target) => target.slice('session:'.length))
    )
    if (failedWriteTargets.current.size === 0) {
      presentOutstandingWriteFailures()
      return
    }

    void saver(state, {
      forceTargets: new Set(
        [...failedWriteTargets.current].filter((target) => !sizeLimitTargets.current.has(target))
      ),
      conflictRebaseFieldsByTarget: new Map(failedConflictRebaseFields.current)
    }).catch(reportPersistenceError)
  }, [presentOutstandingWriteFailures, retryLoad])

  useEffect(() => {
    let isMounted = true
    let unsubscribe: (() => void) | undefined
    let activeSaver: StoreSaver | undefined
    saverRef.current = undefined
    failedWriteTargets.current.clear()
    failedConflictRebaseFields.current.clear()
    sizeLimitTargets.current.clear()

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
        unresolvedSessionRevisionConflictTargets.clear()
        revisionConflictTargets.current.clear()
        setIsHydrated(true)
        const loadWarnings = result.diagnostics?.warnings ?? []
        const sessionWarningCount = loadWarnings.filter(
          (warning) => warning.kind !== 'manifest-corrupt' && warning.kind !== 'manifest-unreadable'
        ).length
        setCatalogRecovery(deriveSessionCatalogRecovery(result.diagnostics))
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
          setCatalogRecovery(READY_SESSION_CATALOG_RECOVERY)
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
            if (isSessionSizeLimitError(_error) && target.startsWith('session:')) {
              sizeLimitTargets.current.add(target)
              setPersistenceBlockedSessionIds(
                [...sizeLimitTargets.current].map((candidate) => candidate.slice('session:'.length))
              )
              presentOutstandingWriteFailures()
              return
            }
            if (isSessionRevisionConflictError(_error)) {
              revisionConflictTargets.current.add(target)
              unresolvedSessionRevisionConflictTargets.add(target)
              pruneRemovedSessionWriteTargets(
                failedWriteTargets.current,
                useSessionStore.getState().sessions,
                failedConflictRebaseFields.current,
                revisionConflictTargets.current,
                unresolvedSessionRevisionConflictTargets
              )
              if (!failedWriteTargets.current.has(target)) {
                if (failedWriteTargets.current.size === 0) {
                  presentOutstandingWriteFailures()
                }
                return
              }
              presentOutstandingWriteFailures()
              return
            }
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
              failedConflictRebaseFields.current,
              revisionConflictTargets.current,
              unresolvedSessionRevisionConflictTargets
            )
            // A queued save can lose a race with an authoritative deletion. Its tombstone rejection
            // must not resurrect a retry target for a Session that no longer exists in the store.
            if (!failedWriteTargets.current.has(target)) {
              if (failedWriteTargets.current.size === 0) {
                presentOutstandingWriteFailures()
              }
              return
            }
            presentOutstandingWriteFailures()
          },
          onSuccess: (target) => {
            if (!isMounted) return
            const removedFailedTarget = failedWriteTargets.current.delete(target)
            failedConflictRebaseFields.current.delete(target)
            revisionConflictTargets.current.delete(target)
            unresolvedSessionRevisionConflictTargets.delete(target)
            if (sizeLimitTargets.current.delete(target)) {
              setPersistenceBlockedSessionIds(
                [...sizeLimitTargets.current].map((candidate) => candidate.slice('session:'.length))
              )
            }
            if (target === 'manifest' && retryManifestWritePending.current) {
              retryManifestWritePending.current = false
              setIsReady(true)
              startPendingArtifactReconciliation()
            }
            if (removedFailedTarget) presentOutstandingWriteFailures()
          }
        },
        liveSessionPersistence
      )
      activeSaver = save
      saverRef.current = save
      const loadingSessionContent = new Set<string>()
      // ponytail: only unchanged, passively loaded history is reclaimable. Edited/runtime-owned
      // sessions stay resident; extend this policy only with a proven save-acknowledgement contract.
      const readOnlyHistory = new Map<
        string,
        { loaded: ChatSession; summary: ChatSession; bytes: number }
      >()
      const trimReadOnlyHistory = (): void => {
        if (!isMounted || readOnlyHistory.size === 0) return
        const state = useSessionStore.getState()
        const byId = indexById(state.sessions)
        let retainedBytes = 0
        for (const [id, entry] of readOnlyHistory) {
          if (byId.get(id) !== entry.loaded) {
            readOnlyHistory.delete(id)
          } else {
            retainedBytes += entry.bytes
          }
        }
        const selected = state.selectedSessionId && readOnlyHistory.get(state.selectedSessionId)
        if (selected) {
          readOnlyHistory.delete(selected.loaded.id)
          readOnlyHistory.set(selected.loaded.id, selected)
        }
        for (const [id, entry] of readOnlyHistory) {
          if (readOnlyHistory.size <= 16 && retainedBytes <= MAX_HISTORY_BODY_BYTES) break
          if (id === state.selectedSessionId) continue
          if (!save.releaseReadOnlySession(entry.loaded, entry.summary)) continue
          readOnlyHistory.delete(id)
          retainedBytes -= entry.bytes
        }
      }

      unsubscribe = useSessionStore.subscribe((state) => {
        const failedTargetCount = failedWriteTargets.current.size
        const sizeLimitTargetCount = sizeLimitTargets.current.size
        pruneRemovedSessionWriteTargets(
          failedWriteTargets.current,
          state.sessions,
          failedConflictRebaseFields.current,
          revisionConflictTargets.current,
          unresolvedSessionRevisionConflictTargets,
          sizeLimitTargets.current
        )
        setPersistenceBlockedSessionIds(
          [...sizeLimitTargets.current].map((target) => target.slice('session:'.length))
        )
        if (
          failedWriteTargets.current.size !== failedTargetCount ||
          sizeLimitTargets.current.size !== sizeLimitTargetCount
        ) {
          presentOutstandingWriteFailures()
        }
        const selected = state.sessions.find(
          (session) => session.id === state.selectedSessionId && session.contentLoaded === false
        )
        if (selected && !loadingSessionContent.has(selected.id)) {
          loadingSessionContent.add(selected.id)
          void loadPersistedSession({ projectId: selected.projectId, sessionId: selected.id })
            .then((session) => {
              if (!session) throw new Error('Selected Session JSON is missing.')
              if (!isMounted) return
              const unchangedSummary =
                useSessionStore
                  .getState()
                  .sessions.find((candidate) => candidate.id === selected.id) === selected
              const loaded = hydratePersistedSessionIfPresent(session)
              if (
                unchangedSummary &&
                loaded &&
                loaded.status === 'idle' &&
                !loaded.activeRun &&
                !loaded.unsavedTitle &&
                !loaded.isPending &&
                !loaded.runtimeContext?.sideChat &&
                !loaded.runtimeContext?.sideChats?.length &&
                !loaded.runtimeContext?.delegatedWork &&
                !hasStagedUploads(loaded) &&
                pendingArtifactRequests(loaded, true).length === 0
              ) {
                readOnlyHistory.set(loaded.id, {
                  loaded,
                  bytes: estimateHistoryBodyBytes(loaded),
                  summary: {
                    ...selected,
                    title: loaded.title,
                    status: loaded.status,
                    pinned: loaded.pinned,
                    archivedAt: loaded.archivedAt,
                    revision: loaded.revision,
                    filesRevision: loaded.filesRevision,
                    updatedAt: loaded.updatedAt,
                    activeMessageCount: loaded.messages.length,
                    artifactCount: loaded.artifacts?.length ?? 0
                  }
                })
                trimReadOnlyHistory()
              }
            })
            .catch((error) => {
              reportPersistenceError(error, 'session-load')
              if (isMounted) setLoadError(SAFE_SESSION_LOAD_ERROR)
            })
            .finally(() => loadingSessionContent.delete(selected.id))
        }
        void save(state).then(trimReadOnlyHistory).catch(reportPersistenceError)
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
  }, [loadAttempt, presentOutstandingWriteFailures])

  return {
    isHydrated,
    isLoading,
    isReady,
    hasCompleteSessionCatalog,
    catalogRecovery,
    canDeleteSessionsAndProjects,
    loadError,
    loadWarning,
    writeError,
    writeErrorRetryable,
    persistenceBlockedSessionIds,
    reportSessionSizeLimit,
    dismissLoadWarning,
    dismissWriteWarning,
    startNewConversationAfterSizeLimit,
    retryLoad,
    retryWrites
  }
}

export {
  MAX_SESSION_REVISION_REBASE_ATTEMPTS,
  confirmPendingDelegationPolicyAuthority,
  createOrderedSessionPersistence,
  createStoreSaver,
  flushSessionPersistence,
  hydratePersistedSessionIfPresent,
  loadPersistedSession,
  loadPersistedSessions,
  reconcilePendingArtifacts,
  retryPendingArtifactFinalization,
  resetSessionPersistenceWriteFailuresForTests,
  deriveSessionCatalogRecovery,
  deleteSession,
  saveSessionInOrder,
  setDelegationPolicyAuthority,
  toPersistedSessionForAuthorityMaterialization,
  useSessionPersistence
}
export type {
  ArtifactReconcileApi,
  OrderedSessionPersistence,
  SessionCatalogRecovery,
  SessionPersistenceApi,
  SessionPersistenceState
}
