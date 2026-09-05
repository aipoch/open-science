import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  ARTIFACT_FINALIZATION_INVALID_PROOF,
  type ReconcilePendingArtifactsRequest,
  type ReconcilePendingArtifactsResult
} from '../../../../shared/artifacts'
import {
  projectConversationMessage,
  resolveActiveConversationActivities,
  resolveActiveConversationMessages
} from '../../../../shared/conversation-graph'
import type { RendererFailureContext } from '../../../../shared/diagnostics'
import {
  ConversationGraphMaterializationError,
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
import type { ChatSession, SessionHydrationSelection } from '../../stores/session-store'
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

const toPersistedSessionForAuthorityMaterialization = (
  session: ChatSession
): PersistedChatSession => {
  const persisted = toPersistedSession(session)
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
    options?: SaveSessionOptions
  ) => Promise<PersistedChatSession>
  saveSessionWithRecovery: (
    session: PersistedChatSession,
    options: SaveSessionOptions | undefined,
    recover: OrderedSessionSaveRecovery
  ) => Promise<PersistedChatSession>
  seedAcknowledgedSessions: (sessions: readonly PersistedChatSession[]) => void
  getAcknowledgedSession: (sessionId: string) => PersistedChatSession | undefined
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

const MAIN_OWNED_SESSION_FIELDS = new Set<keyof PersistedChatSession>([
  'revision',
  'runtimeContext',
  'planHistoryProjections',
  'archivedAt',
  'branchSource',
  'delegationPolicy',
  'enabledComputeHosts',
  'selectedComputeHosts',
  'computeConcurrencyLimit',
  'specialistId',
  'specialistBindingPending'
])

const MAIN_OWNED_SESSION_DETAILS_FIELDS = new Set<keyof PersistedChatSession>([
  'title',
  'description',
  'sessionDetailsSource',
  'sessionDetailsGenerationEligible',
  'sessionDetailsGeneration'
])

const jsonValuesEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    )
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(rightRecord, key) && jsonValuesEqual(leftRecord[key], rightRecord[key])
    )
  )
}

const conversationGraphsEqualIgnoringBranchTimestamps = (
  left: PersistedChatSession['conversationGraph'],
  right: PersistedChatSession['conversationGraph']
): boolean => {
  if (!left || !right) return left === right
  const withoutBranchTimestamps = (
    graph: NonNullable<PersistedChatSession['conversationGraph']>
  ): PersistedChatSession['conversationGraph'] => ({
    ...graph,
    branches: graph.branches.map((branch) => ({ ...branch, updatedAt: 0 }))
  })
  return jsonValuesEqual(withoutBranchTimestamps(left), withoutBranchTimestamps(right))
}

type SessionConversationGraph = NonNullable<PersistedChatSession['conversationGraph']>

const graphItemsEqual = <Item extends { id: string }>(
  left: Item | undefined,
  right: Item | undefined,
  ignoreUpdatedAt: boolean
): boolean => {
  if (!left || !right) return left === right
  return ignoreUpdatedAt
    ? jsonValuesEqual({ ...left, updatedAt: 0 }, { ...right, updatedAt: 0 })
    : jsonValuesEqual(left, right)
}

// Replays identity-disjoint graph edits onto the latest durable graph. An edit or deletion of the
// same identity on both sides remains a real conflict; Branch updatedAt alone is derived metadata and
// does not turn otherwise-disjoint Message/Activity additions into a conflict.
const rebaseConversationGraphCollection = <Item extends { id: string }>(
  baseItems: readonly Item[],
  submittedItems: readonly Item[],
  latestItems: readonly Item[],
  ignoreUpdatedAt = false,
  resolveConcurrent?: (
    baseItem: Item | undefined,
    submittedItem: Item,
    latestItem: Item
  ) => Item | undefined
): Item[] | undefined => {
  const baseById = new Map(baseItems.map((item) => [item.id, item]))
  const submittedById = new Map(submittedItems.map((item) => [item.id, item]))
  const latestById = new Map(latestItems.map((item) => [item.id, item]))
  const orderedIds = [
    ...new Set([
      ...latestItems.map(({ id }) => id),
      ...submittedItems.map(({ id }) => id),
      ...baseItems.map(({ id }) => id)
    ])
  ]
  const rebased: Item[] = []

  for (const id of orderedIds) {
    const baseItem = baseById.get(id)
    const submittedItem = submittedById.get(id)
    const latestItem = latestById.get(id)
    let selected: Item | undefined
    if (graphItemsEqual(submittedItem, baseItem, ignoreUpdatedAt)) {
      selected = latestItem
    } else if (graphItemsEqual(latestItem, baseItem, ignoreUpdatedAt)) {
      selected = submittedItem
    } else if (graphItemsEqual(submittedItem, latestItem, ignoreUpdatedAt)) {
      selected = submittedItem
    } else {
      selected =
        submittedItem && latestItem
          ? resolveConcurrent?.(baseItem, submittedItem, latestItem)
          : undefined
      if (!selected) return undefined
    }
    if (selected) rebased.push(structuredClone(selected))
  }

  return rebased
}

// Message payloads have more than one legitimate owner: runtime streaming updates content while
// artifact/upload finalization can update a disjoint field on the same durable identity. Apply a
// property-level three-way merge, union append-only event evidence, and fail closed whenever both
// sides changed the same semantic property differently.
const rebaseMessageCollection = <Item extends { id: string; eventIds: string[] }>(
  baseItems: readonly Item[],
  submittedItems: readonly Item[],
  latestItems: readonly Item[]
): Item[] | undefined =>
  rebaseConversationGraphCollection(
    baseItems,
    submittedItems,
    latestItems,
    false,
    (baseItem, submittedItem, latestItem) => {
      const rebased = structuredClone(latestItem) as Record<string, unknown>
      const base = baseItem as Record<string, unknown> | undefined
      const submitted = submittedItem as Record<string, unknown>
      const latest = latestItem as Record<string, unknown>
      const keys = new Set([
        ...Object.keys(base ?? {}),
        ...Object.keys(submitted),
        ...Object.keys(latest)
      ])

      for (const key of keys) {
        if (key === 'id') continue
        if (key === 'eventIds') {
          const baseEventIds = (base?.eventIds as string[] | undefined) ?? []
          const submittedEventIds = submitted.eventIds as string[]
          const latestEventIds = latest.eventIds as string[]
          const onlyAppends = (candidate: readonly string[]): boolean =>
            baseEventIds.every((eventId) => candidate.includes(eventId))
          if (!onlyAppends(submittedEventIds) || !onlyAppends(latestEventIds)) return undefined
          rebased.eventIds = [...new Set([...latestEventIds, ...submittedEventIds])]
          continue
        }
        if (key === 'updatedAt') {
          rebased.updatedAt = Math.max(
            Number(base?.updatedAt ?? 0),
            Number(submitted.updatedAt ?? 0),
            Number(latest.updatedAt ?? 0)
          )
          continue
        }

        const baseValue = base?.[key]
        const submittedValue = submitted[key]
        const latestValue = latest[key]
        const localChanged = !jsonValuesEqual(submittedValue, baseValue)
        const remoteChanged = !jsonValuesEqual(latestValue, baseValue)
        if (localChanged && remoteChanged && !jsonValuesEqual(submittedValue, latestValue)) {
          return undefined
        }
        const selected = localChanged ? submittedValue : latestValue
        if (selected === undefined && !Object.hasOwn(localChanged ? submitted : latest, key)) {
          Reflect.deleteProperty(rebased, key)
        } else {
          rebased[key] = structuredClone(selected)
        }
      }

      return rebased as Item
    }
  )

const rebaseConversationGraph = (
  base: PersistedChatSession['conversationGraph'],
  submitted: PersistedChatSession['conversationGraph'],
  latest: PersistedChatSession['conversationGraph']
): PersistedChatSession['conversationGraph'] | undefined => {
  if (conversationGraphsEqualIgnoringBranchTimestamps(submitted, base)) {
    return latest ? structuredClone(latest) : undefined
  }
  if (conversationGraphsEqualIgnoringBranchTimestamps(latest, base)) {
    return submitted ? structuredClone(submitted) : undefined
  }
  if (conversationGraphsEqualIgnoringBranchTimestamps(submitted, latest)) {
    return submitted ? structuredClone(submitted) : undefined
  }
  if (!base || !submitted || !latest) return undefined

  const resolveScalar = <Value>(
    baseValue: Value,
    submittedValue: Value,
    latestValue: Value
  ): Value | undefined => {
    if (jsonValuesEqual(submittedValue, baseValue)) return structuredClone(latestValue)
    if (jsonValuesEqual(latestValue, baseValue) || jsonValuesEqual(submittedValue, latestValue)) {
      return structuredClone(submittedValue)
    }
    return undefined
  }
  const schemaVersion = resolveScalar(
    base.schemaVersion,
    submitted.schemaVersion,
    latest.schemaVersion
  )
  const rootFrameId = resolveScalar(base.rootFrameId, submitted.rootFrameId, latest.rootFrameId)
  const activeFrameId = resolveScalar(
    base.activeFrameId,
    submitted.activeFrameId,
    latest.activeFrameId
  )
  const frames = rebaseConversationGraphCollection(base.frames, submitted.frames, latest.frames)
  const branches = rebaseConversationGraphCollection(
    base.branches,
    submitted.branches,
    latest.branches,
    true
  )
  const messages = rebaseMessageCollection(base.messages, submitted.messages, latest.messages)
  const activities = rebaseConversationGraphCollection(
    base.activities,
    submitted.activities,
    latest.activities
  )
  const activityGroups = rebaseConversationGraphCollection(
    base.activityGroups,
    submitted.activityGroups,
    latest.activityGroups
  )
  const runtimeSegments = rebaseConversationGraphCollection(
    base.runtimeSegments,
    submitted.runtimeSegments,
    latest.runtimeSegments
  )

  if (
    schemaVersion === undefined ||
    rootFrameId === undefined ||
    activeFrameId === undefined ||
    !frames ||
    !branches ||
    !messages ||
    !activities ||
    !activityGroups ||
    !runtimeSegments
  ) {
    return undefined
  }

  return {
    schemaVersion,
    rootFrameId,
    activeFrameId,
    frames,
    branches,
    messages,
    activities,
    activityGroups,
    runtimeSegments
  } satisfies SessionConversationGraph
}

const sessionFieldValuesEqual = (
  key: keyof PersistedChatSession,
  left: unknown,
  right: unknown
): boolean =>
  key === 'conversationGraph'
    ? conversationGraphsEqualIgnoringBranchTimestamps(
        left as PersistedChatSession['conversationGraph'],
        right as PersistedChatSession['conversationGraph']
      )
    : jsonValuesEqual(left, right)

const rebaseSessionAfterRevisionConflict = (
  base: PersistedChatSession,
  submitted: PersistedChatSession,
  latest: PersistedChatSession
): PersistedChatSession | undefined => {
  const rebased: PersistedChatSession = structuredClone(latest)
  const graphOwnsCompatibilityProjections = Boolean(
    base.conversationGraph && submitted.conversationGraph && latest.conversationGraph
  )
  const keys = new Set([
    ...Object.keys(base),
    ...Object.keys(submitted),
    ...Object.keys(latest)
  ] as Array<keyof PersistedChatSession>)
  const mainOwnsStatus =
    latest.runtimeContext?.permission?.state === 'pending' ||
    latest.status === 'waiting-plan-approval'
  const mainOwnsSessionDetails =
    latest.sessionDetailsSource !== undefined || latest.sessionDetailsGeneration !== undefined

  for (const key of keys) {
    if (
      graphOwnsCompatibilityProjections &&
      (key === 'messages' || key === 'activities' || key === 'activityGroups')
    ) {
      continue
    }
    if (
      MAIN_OWNED_SESSION_FIELDS.has(key) ||
      (mainOwnsSessionDetails && MAIN_OWNED_SESSION_DETAILS_FIELDS.has(key)) ||
      key === 'updatedAt' ||
      (key === 'status' && mainOwnsStatus)
    ) {
      continue
    }
    const baseValue = base[key]
    const submittedValue = submitted[key]
    const latestValue = latest[key]
    const localChanged = !sessionFieldValuesEqual(key, submittedValue, baseValue)
    if (!localChanged) continue
    const remoteChanged = !sessionFieldValuesEqual(key, latestValue, baseValue)
    if (remoteChanged && !sessionFieldValuesEqual(key, submittedValue, latestValue)) {
      if (key === 'messages') {
        const messages = rebaseMessageCollection(
          baseValue as PersistedChatSession['messages'],
          submittedValue as PersistedChatSession['messages'],
          latestValue as PersistedChatSession['messages']
        )
        if (!messages) return undefined
        rebased.messages = messages
      } else if (key === 'conversationGraph') {
        const graph = rebaseConversationGraph(
          baseValue as PersistedChatSession['conversationGraph'],
          submittedValue as PersistedChatSession['conversationGraph'],
          latestValue as PersistedChatSession['conversationGraph']
        )
        if (!graph) return undefined
        rebased.conversationGraph = graph
      } else if (key === 'activeRun') {
        const submittedRun = submittedValue as PersistedChatSession['activeRun']
        const latestRun = latestValue as PersistedChatSession['activeRun']
        const baseRun = baseValue as PersistedChatSession['activeRun']
        if (!submittedRun) {
          if (!latestRun || latestRun.promptMessageId === baseRun?.promptMessageId) {
            delete rebased.activeRun
            continue
          }
          return undefined
        }
        if (!latestRun) {
          rebased.activeRun = structuredClone(submittedRun)
          continue
        }
        if (submittedRun.promptMessageId !== latestRun.promptMessageId) return undefined
        rebased.activeRun = {
          promptMessageId: submittedRun.promptMessageId,
          startedAt: Math.min(submittedRun.startedAt, latestRun.startedAt)
        }
      } else if (key === 'contextUsage') {
        // Main does not persist live context-window snapshots. Keep the renderer value, including
        // an explicit clear, instead of resurrecting a stale durable copy.
        if (submittedValue === undefined) delete rebased.contextUsage
        else {
          rebased.contextUsage = structuredClone(
            submittedValue as PersistedChatSession['contextUsage']
          )
        }
      } else {
        return undefined
      }
      continue
    }

    if (Object.hasOwn(submitted, key)) {
      Object.assign(rebased, { [key]: structuredClone(submittedValue) })
    } else {
      Reflect.deleteProperty(rebased, key)
    }
  }

  // messages/activities/activityGroups are compatibility views of the active Branch. Rebasing them
  // independently can project a concurrent Main insertion from the previous Branch onto a locally
  // selected or newly edited Branch. Once all three snapshots carry a graph, derive those flat views
  // from the rebased graph instead of treating them as separate authorities.
  if (graphOwnsCompatibilityProjections && rebased.conversationGraph) {
    rebased.messages = resolveActiveConversationMessages(rebased.conversationGraph).map(
      projectConversationMessage
    )
    const projection = resolveActiveConversationActivities(rebased.conversationGraph)
    if (projection.activities.length > 0) rebased.activities = projection.activities
    else delete rebased.activities
    if (projection.activityGroups.length > 0) rebased.activityGroups = projection.activityGroups
    else delete rebased.activityGroups
  }

  rebased.revision = sessionRevision(latest)
  rebased.updatedAt = Math.max(base.updatedAt, submitted.updatedAt, latest.updatedAt) + 1
  return rebased
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

type PendingLatestSessionSave = {
  target: string
  task: LatestSessionSaveTask
  options: SaveSessionOptions | undefined
  generation: number
  promise?: Promise<PersistedChatSession>
  bypassCadence?: boolean
  releaseCadence?: () => void
}

class SessionPersistenceGenerationChangedError extends Error {
  constructor() {
    super('Session persistence hydration generation changed.')
    this.name = 'SessionPersistenceGenerationChangedError'
  }
}

// Serializes every renderer-originated Session write through one ordering seam. Store snapshots at
// the queue tail use latest-wins coalescing; explicit Session and Manifest writes remain barriers, so
// Artifact finalization cannot be overtaken by an older store snapshot.
const createOrderedSessionPersistence = (
  api: Pick<SessionPersistenceApi, 'saveSession' | 'saveManifest'>
): OrderedSessionPersistence => {
  let queue: Promise<unknown> = Promise.resolve()
  const acknowledgedRevisions = new Map<string, number>()
  const acknowledgedSessions = new Map<string, PersistedChatSession>()
  const pendingLatestByTarget = new Map<string, PendingLatestSessionSave>()
  // The queue swallows rejections to stay usable; retain terminal failures until that target heals.
  const failedWritesByTarget = new Map<string, unknown>()
  let hydrationGeneration = 0
  let latestSessionSaveStartedAt = Number.NEGATIVE_INFINITY

  const waitForLatestSessionSaveCadence = async (
    entry: PendingLatestSessionSave
  ): Promise<void> => {
    const waitMs = latestSessionSaveStartedAt + LATEST_SESSION_SAVE_INTERVAL_MS - performance.now()
    if (waitMs > 0 && !entry.bypassCadence) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, waitMs)
        entry.releaseCadence = () => {
          clearTimeout(timeout)
          resolve()
        }
      })
    }
    entry.releaseCadence = undefined
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
      if (!(error instanceof SessionPersistenceGenerationChangedError)) {
        failedWritesByTarget.set(target, error)
      }
      throw error
    }
  }

  const enqueue = <Result>(target: string, task: () => Promise<Result>): Promise<Result> => {
    releasePendingLatestCadence()
    pendingLatestByTarget.clear()
    const run = queue.then(
      () => trackWrite(target, task),
      () => trackWrite(target, task)
    )
    queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  const saveSubmittedSession = async (
    session: PersistedChatSession,
    options?: SaveSessionOptions
  ): Promise<PersistedChatSession> => {
    const submitted = structuredClone(session)
    submitted.revision = Math.max(
      sessionRevision(submitted),
      acknowledgedRevisions.get(submitted.id) ?? 0
    )
    const durable = options
      ? await api.saveSession(submitted, options)
      : await api.saveSession(submitted)
    acknowledgeSession(durable)
    return durable
  }

  const saveLatestSession = (
    target: string,
    task: LatestSessionSaveTask,
    options?: SaveSessionOptions
  ): Promise<PersistedChatSession> => {
    const pending = pendingLatestByTarget.get(target)
    if (pending?.promise) {
      pending.task = task
      pending.options = mergeSaveSessionOptions(pending.options, options)
      return pending.promise
    }

    const entry: PendingLatestSessionSave = {
      target,
      task,
      options,
      generation: hydrationGeneration
    }
    const runTask = async (): Promise<PersistedChatSession> => {
      // A fast IPC/disk round-trip otherwise defeats latest-wins coalescing and rewrites the entire
      // Session at the live presentation frame rate. Keep the entry replaceable while it waits.
      await waitForLatestSessionSaveCadence(entry)
      if (pendingLatestByTarget.get(target) === entry) pendingLatestByTarget.delete(target)
      if (entry.generation !== hydrationGeneration) {
        throw new SessionPersistenceGenerationChangedError()
      }
      const durable = await entry.task(entry.options)
      acknowledgeSession(durable)
      return durable
    }
    const run = queue.then(
      () => trackWrite(target, runTask),
      () => trackWrite(target, runTask)
    )
    entry.promise = run
    pendingLatestByTarget.set(target, entry)
    queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  return {
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
      }
    },
    getAcknowledgedSession: (sessionId) => {
      const session = acknowledgedSessions.get(sessionId)
      return session ? structuredClone(session) : undefined
    },
    clearWriteFailure: (target) => failedWritesByTarget.delete(target),
    clearWriteFailures: () => failedWritesByTarget.clear(),
    saveSession: (session, options) =>
      enqueue(`session:${session.id}`, () => saveSubmittedSession(session, options)),
    saveSessionWithRecovery: (session, options, recover) =>
      enqueue(`session:${session.id}`, async () => {
        const submitted = structuredClone(session)
        submitted.revision = Math.max(
          sessionRevision(submitted),
          acknowledgedRevisions.get(submitted.id) ?? 0
        )
        try {
          return await saveSubmittedSession(submitted, options)
        } catch (error) {
          return recover(error, submitted, saveSubmittedSession)
        }
      }),
    saveManifest: (request) => enqueue('manifest', () => api.saveManifest(request)),
    flush: async () => {
      releasePendingLatestCadence()
      await queue
      const failure = failedWritesByTarget.values().next()
      if (!failure.done) throw failure.value
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

  const recoverRevisionConflict = async (
    error: unknown,
    submitted: PersistedChatSession,
    options: SaveSessionOptions | undefined,
    save: SessionPersistenceApi['saveSession']
  ): Promise<PersistedChatSession> => {
    if (!isSessionRevisionConflictError(error)) throw error
    const base = acknowledgedSessions.get(submitted.id)
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
      if (
        (previousById.get(session.id) !== session || isForced) &&
        (isForced || !isExternallyHydratedSession(session) || hasUnsavedLocalTitle) &&
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
        const applyDurableSession = (
          durableSession: PersistedChatSession,
          options: SaveSessionOptions | undefined,
          recoveredRevisionConflict = false
        ): void => {
          useSessionStore.getState().applyDurableSessionProjection({
            source: session,
            session: durableSession,
            mode:
              recoveredRevisionConflict || (options?.conflictRebaseFields?.length ?? 0) > 0
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
                persisted.revision =
                  acknowledgedRevisions.get(session.id) ?? sessionRevision(persisted)
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
                    const persisted = observePersistencePhase('session-serialize', () =>
                      toPersistedSession(session)
                    )
                    persisted.revision =
                      acknowledgedRevisions.get(session.id) ?? sessionRevision(persisted)
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
                          coalescedOptions,
                          api.saveSession
                        )
                        recoveredRevisionConflict = true
                      } catch (finalError) {
                        reportPersistenceError(finalError, 'session-save')
                        throw finalError
                      }
                    }
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
          if (error instanceof SessionPersistenceGenerationChangedError) return undefined
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
  const [loadAttempt, setLoadAttempt] = useState(0)
  const retrySelection = useRef<SessionHydrationSelection | undefined>(undefined)
  const failedWriteTargets = useRef(new Set<string>())
  const failedConflictRebaseFields = useRef(new Map<string, SessionConflictRebaseField[]>())
  const revisionConflictTargets = useRef(new Set<string>())
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
    setCatalogRecovery(READY_SESSION_CATALOG_RECOVERY)
    setCanDeleteSessionsAndProjects(false)
    setLoadError(undefined)
    setLoadWarning(undefined)
    setWriteError(undefined)
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
      unresolvedSessionRevisionConflictTargets
    )
    if (failedWriteTargets.current.size === 0) {
      setWriteError(undefined)
      return
    }

    void saver(state, {
      forceTargets: new Set(failedWriteTargets.current),
      conflictRebaseFieldsByTarget: new Map(failedConflictRebaseFields.current)
    }).catch(reportPersistenceError)
  }, [retryLoad])

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
                if (failedWriteTargets.current.size === 0) setWriteError(undefined)
                return
              }
              setWriteError(translateRef.current(SESSION_REVISION_CONFLICT_WRITE_ERROR))
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
              if (failedWriteTargets.current.size === 0) setWriteError(undefined)
              return
            }
            setWriteError(SAFE_SESSION_WRITE_ERROR)
          },
          onSuccess: (target) => {
            if (!isMounted) return
            failedWriteTargets.current.delete(target)
            failedConflictRebaseFields.current.delete(target)
            revisionConflictTargets.current.delete(target)
            unresolvedSessionRevisionConflictTargets.delete(target)
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
      const loadingSessionContent = new Set<string>()

      unsubscribe = useSessionStore.subscribe((state) => {
        pruneRemovedSessionWriteTargets(
          failedWriteTargets.current,
          state.sessions,
          failedConflictRebaseFields.current,
          revisionConflictTargets.current,
          unresolvedSessionRevisionConflictTargets
        )
        if (failedWriteTargets.current.size === 0) setWriteError(undefined)
        const selected = state.sessions.find(
          (session) => session.id === state.selectedSessionId && session.contentLoaded === false
        )
        if (selected && !loadingSessionContent.has(selected.id)) {
          loadingSessionContent.add(selected.id)
          void loadPersistedSession({ projectId: selected.projectId, sessionId: selected.id })
            .then((session) => {
              if (!session) throw new Error('Selected Session JSON is missing.')
              if (isMounted) hydratePersistedSessionIfPresent(session)
            })
            .catch((error) => {
              reportPersistenceError(error, 'session-load')
              if (isMounted) setLoadError(SAFE_SESSION_LOAD_ERROR)
            })
            .finally(() => loadingSessionContent.delete(selected.id))
        }
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
    catalogRecovery,
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
