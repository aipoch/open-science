import {
  useDesktopRuntimeRecoveryStore,
  getDesktopRuntimeEpoch,
  desktopRuntimeWritable,
  assertDesktopRuntimeWrite,
  completeDesktopSessionRecovery
} from '../../stores/desktop-runtime-recovery-store'
import type { AcpRuntimeEvent } from '../../../../shared/acp'
import {
  reportWorkspaceOperationError,
  clearWorkspaceOperationError,
  useWorkspaceOperationErrors
} from '../acp/workspace-operation-error'
import { isRuntimeWriter, runtimeWriterSaveOptions } from '../acp/runtime-writer-client'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
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
import type {
  RendererFailureContext,
  RendererSessionWriteDiagnostics,
  RendererSessionWriteRecoveryDiagnostics
} from '../../../../shared/diagnostics'
import {
  ConversationGraphMaterializationError,
  SessionRevisionConflictError,
  isSessionSizeLimitError,
  isSessionRevisionConflictError,
  latestTurnAnchor,
  sessionRevision,
  turnAnchorInterval,
  type DeleteSessionRequest,
  type DelegationPolicy,
  type LoadAllSessionsResult,
  type ListSessionSummariesResult,
  type LoadSessionRequest,
  type PersistedChatMessage,
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
  retainSessionRecoveryDrafts,
  hydrateSession,
  isExternallyHydratedSession,
  toPersistedSession,
  useSessionStore
} from '../../stores/session-store'
import type { ChatSession } from '../../stores/session-store-contract'
import type {
  SessionHydrationSelection,
  StreamingMessageContentByMessageId
} from '../../stores/session-store'
import { projectRendererFailure, sessionWriteFailureCode } from '../../renderer-diagnostics'
import {
  acknowledgeSessionConversationCommands,
  discardSessionConversationIntents,
  pendingSessionConversationCommands,
  retainActivePreparationCommands
} from '../../stores/session-conversation-intents'
import {
  SessionWriteRecovery,
  SessionWriteUnconfirmedError,
  type RetainedSessionWrite,
  type SessionWriteIntent,
  type SessionWriteIssue
} from './session-write-recovery'

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

const SESSION_CONTENT_CACHE_LIMIT = 4
const sessionContentCache = new Map<string, { revision: number; session: PersistedChatSession }>()

const sessionContentCacheKey = (request: LoadSessionRequest): string =>
  `${request.projectId}\0${request.sessionId}`

const cacheSessionContent = (session: PersistedChatSession): void => {
  if (typeof session.revision !== 'number') return
  const key = sessionContentCacheKey({ projectId: session.projectId, sessionId: session.id })
  sessionContentCache.delete(key)
  sessionContentCache.set(key, { revision: session.revision, session })
  while (sessionContentCache.size > SESSION_CONTENT_CACHE_LIMIT) {
    const oldest = sessionContentCache.keys().next().value
    if (oldest === undefined) break
    sessionContentCache.delete(oldest)
  }
}

const resetSessionContentCacheForTests = (): void => {
  sessionContentCache.clear()
}

const loadPersistedSession = async (
  request: LoadSessionRequest,
  api: SessionReadApi = window.api.sessions,
  options: { bypassCache?: boolean } = {}
): Promise<PersistedChatSession | undefined> => {
  const storeSummary = useSessionStore
    .getState()
    .sessions.find(
      (session) => session.id === request.sessionId && session.projectId === request.projectId
    )
  if (!options.bypassCache) {
    const cached = sessionContentCache.get(sessionContentCacheKey(request))
    if (
      cached &&
      storeSummary &&
      typeof storeSummary.revision === 'number' &&
      storeSummary.revision === cached.revision
    ) {
      return cached.session
    }
  }
  if (typeof api.loadOne === 'function') {
    const result = await api.loadOne(request)
    if (result) cacheSessionContent(result)
    return result
  }
  const result = await api.loadAll()
  const session = result.sessions.find(
    (candidate) => candidate.id === request.sessionId && candidate.projectId === request.projectId
  )
  if (session) cacheSessionContent(session)
  return session
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

const deleteSession = (request: DeleteSessionRequest): Promise<SessionDeletionResult> => {
  sessionContentCache.delete(
    sessionContentCacheKey({ projectId: request.projectId, sessionId: request.sessionId })
  )
  return window.api.sessions.deleteSession(request)
}

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
type LatestSessionSaveRecoveryContext = {
  base?: PersistedChatSession
  capture: (options: SaveSessionOptions | undefined, base?: PersistedChatSession) => void
}
type OrderedSessionSaveRecovery = (
  error: unknown,
  submitted: PersistedChatSession,
  retry: SessionPersistenceApi['saveSession']
) => Promise<PersistedChatSession>

type OrderedSessionPersistence = Pick<SessionPersistenceApi, 'saveSession' | 'saveManifest'> & {
  recovery: SessionWriteRecovery
  saveLatestSession: (
    target: string,
    task: LatestSessionSaveTask,
    options?: SaveSessionOptions,
    streaming?: boolean,
    recoveryContext?: LatestSessionSaveRecoveryContext
  ) => Promise<PersistedChatSession>
  saveSessionWithRecovery: (
    session: PersistedChatSession,
    options: SaveSessionOptions | undefined,
    recover: OrderedSessionSaveRecovery
  ) => Promise<PersistedChatSession>
  seedAcknowledgedSessions: (sessions: readonly PersistedChatSession[]) => void
  getAcknowledgedSession: (sessionId: string) => PersistedChatSession | undefined
  releaseAcknowledgedSessionBody: (sessionId: string) => boolean
  clearWriteFailure: (target: string) => void
  clearWriteFailures: () => void
  pruneDeferredConversationCommands: (sessions: readonly Pick<ChatSession, 'id'>[]) => void
  hasDeferredConversationCommands: (target: string) => boolean
  flush: (target?: string) => Promise<void>
}

export class SessionPersistenceDeferredError extends Error {
  readonly code = 'session-conversation-deferred' as const

  constructor(readonly target: string) {
    super('Session conversation changes are waiting for the active run to finish.')
    this.name = 'SessionPersistenceDeferredError'
  }
}

export const isSessionPersistenceDeferredError = (
  error: unknown
): error is SessionPersistenceDeferredError => error instanceof SessionPersistenceDeferredError

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
  'recordProblems',
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
  // Disk JSON omits undefined object properties; renderer projections may retain them.
  // Compare the persisted values so a missing optional field cannot create a false conflict.
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined)
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined)
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

const sessionIntentFields = (intent: SessionWriteIntent): (keyof PersistedChatSession)[] => {
  const named = intent.options?.conflictRebaseFields ?? []
  if (
    intent.base?.runtimeTranscriptOwner === 'main' ||
    intent.session.runtimeTranscriptOwner === 'main'
  )
    return [...named]
  const ignored = new Set<keyof PersistedChatSession>([
    ...MAIN_OWNED_SESSION_FIELDS,
    'updatedAt',
    'runtimeTranscriptOwner',
    'runtimeTranscriptReviewOwner',
    'runtimeTranscriptLastRun',
    'runtimeSessionAdmissions',
    'runtimeConversationCommandIds',
    'promptPreparation',
    'taskRunCommitId'
  ])
  return [
    ...new Set([
      ...Object.keys(intent.base ?? {}),
      ...Object.keys(intent.session),
      ...named
    ] as (keyof PersistedChatSession)[])
  ].filter(
    (key) =>
      !ignored.has(key) &&
      (!(intent.base?.sessionDetailsSource || intent.base?.sessionDetailsGeneration) ||
        !MAIN_OWNED_SESSION_DETAILS_FIELDS.has(key) ||
        named.includes(key as SessionConflictRebaseField)) &&
      (named.includes(key as SessionConflictRebaseField) ||
        !sessionFieldValuesEqual(key, intent.base?.[key], intent.session[key]))
  )
}

const isSessionWriteSatisfied = (
  intent: SessionWriteIntent,
  authority: PersistedChatSession
): boolean => {
  if (authority.id !== intent.session.id || authority.projectId !== intent.session.projectId)
    return false
  const acknowledged = new Set(authority.runtimeConversationCommandIds ?? [])
  const commands = retainActivePreparationCommands(intent.options?.conversationCommands ?? [])
  if (commands.some(({ id }) => !acknowledged.has(id))) return false
  return sessionIntentFields(intent).every((key) =>
    key === 'pinned'
      ? Boolean(intent.session.pinned) === Boolean(authority.pinned)
      : sessionFieldValuesEqual(key, intent.session[key], authority[key])
  )
}

const mergeSessionWriteIntent = (
  retained: SessionWriteIntent,
  next: SessionWriteIntent
): SessionWriteIntent => {
  const session = structuredClone(retained.session)
  const base = retained.base ? structuredClone(retained.base) : undefined
  const retainedFields = new Set(sessionIntentFields(retained))
  for (const key of sessionIntentFields(next)) {
    Object.assign(session, { [key]: structuredClone(next.session[key]) })
    if (base && !retainedFields.has(key))
      Object.assign(base, { [key]: structuredClone(next.base?.[key]) })
  }
  return { base, session, options: mergeSaveSessionOptions(retained.options, next.options) }
}

// Task completion and live renderer projection can assign different IDs to the same reply.
// Reconcile only a new leaf with identical runtime evidence and payload. The existing graph
// rebase retains disjoint changes (such as terminal context samples on the prompt) and rejects
// competing edits. Only an unsaved projection adopts an existing durable message identity.
const reconcileCompletedTaskReply = (
  base: PersistedChatSession,
  submitted: PersistedChatSession,
  latest: PersistedChatSession
): PersistedChatSession => {
  const graph = submitted.conversationGraph
  const authority = latest.conversationGraph
  if (
    !latest.taskRunCommitId ||
    latest.status !== 'idle' ||
    latest.activeRun ||
    !graph ||
    !authority
  )
    return submitted
  const branchId = selectedRootBranchId(submitted)
  if (branchId !== selectedRootBranchId(latest)) return submitted
  const local = graph.messages.find(
    ({ id }) => id === graph.branches.find((branch) => branch.id === branchId)?.headMessageId
  )
  const durable = authority.messages.find(
    ({ id }) => id === authority.branches.find((branch) => branch.id === branchId)?.headMessageId
  )
  if (
    !local ||
    !durable ||
    local.id === durable.id ||
    local.role !== 'agent' ||
    durable.role !== 'agent' ||
    durable.status !== 'complete' ||
    !local.eventIds.length ||
    !local.responseToMessageId ||
    local.responseToMessageId !== durable.responseToMessageId ||
    base.conversationGraph?.messages.some(({ id }) => id === local.id) ||
    !jsonValuesEqual(local.eventIds, durable.eventIds) ||
    (submitted.activeRun && submitted.activeRun.promptMessageId !== local.responseToMessageId) ||
    (submitted.status !== 'running' && submitted.status !== 'idle')
  )
    return submitted
  const normalized = { ...local }
  for (const key of [
    'id',
    'streamId',
    'status',
    'createdAt',
    'updatedAt',
    'completedAt',
    'turnUsage',
    'turnUsageUnavailable',
    'modelCallUsage'
  ] as const) {
    Reflect.deleteProperty(normalized, key)
    if (Object.hasOwn(durable, key)) Object.assign(normalized, { [key]: durable[key] })
  }
  if (!jsonValuesEqual(normalized, durable)) return submitted
  const normalizedGraph = {
    ...graph,
    messages: graph.messages.map((message) => (message === local ? durable : message)),
    branches: graph.branches.map((branch) =>
      branch.id === branchId ? { ...branch, headMessageId: durable.id } : branch
    )
  }
  const reconciledGraph = rebaseConversationGraph(
    base.conversationGraph,
    normalizedGraph,
    authority
  )
  if (!reconciledGraph) return submitted
  return {
    ...submitted,
    conversationGraph: reconciledGraph,
    messages: resolveActiveConversationMessages(reconciledGraph).map(projectConversationMessage),
    ...resolveActiveConversationActivities(reconciledGraph),
    status: latest.status,
    activeRun: latest.activeRun
  }
}

const rebaseSessionAfterRevisionConflict = (
  base: PersistedChatSession,
  submitted: PersistedChatSession,
  latest: PersistedChatSession
): PersistedChatSession | undefined => {
  submitted = reconcileCompletedTaskReply(base, submitted, latest)
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
      } else if (
        key === 'status' &&
        base.status === 'waiting-permission' &&
        latest.status === 'running' &&
        submitted.status === 'idle' &&
        !submitted.activeRun &&
        !latest.runtimeContext?.permission &&
        base.activeRun?.promptMessageId &&
        jsonValuesEqual(latest.activeRun, base.activeRun) &&
        selectedRootBranchId(base) === selectedRootBranchId(submitted) &&
        selectedRootBranchId(base) === selectedRootBranchId(latest) &&
        base.conversationGraph?.frames.every((frame) =>
          [submitted, latest].every((session) =>
            session.conversationGraph?.frames.some(
              (candidate) =>
                candidate.id === frame.id && candidate.activeBranchId === frame.activeBranchId
            )
          )
        )
      ) {
        // Permission clearance and renderer completion can overtake one another for the same turn.
        // Only the proven completed turn may supersede Main's intermediate running status.
        rebased.status = submitted.status
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

  // A terminal Task receipt describes the preceding prompt, not a locally started follow-up.
  if (
    latest.taskRunCommitId &&
    latest.taskRunCommitId !== base.taskRunCommitId &&
    latest.status === 'idle' &&
    submitted.activeRun &&
    submitted.activeRun.promptMessageId !== base.activeRun?.promptMessageId &&
    rebased.activeRun?.promptMessageId === submitted.activeRun.promptMessageId
  )
    rebased.status = submitted.status

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
  const runtimeWriterToken =
    next && Object.hasOwn(next, 'runtimeWriterToken')
      ? next.runtimeWriterToken
      : previous?.runtimeWriterToken
  const expectedRevision = next?.expectedRevision ?? previous?.expectedRevision
  const conversationCommands = [
    ...(previous?.conversationCommands ?? []),
    ...(next?.conversationCommands ?? [])
  ].filter(
    (command, index, commands) => commands.findIndex(({ id }) => id === command.id) === index
  )
  return expectedRevision !== undefined ||
    conflictRebaseFields.length > 0 ||
    runtimeWriterToken ||
    conversationCommands.length > 0
    ? {
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
        ...(runtimeWriterToken ? { runtimeWriterToken } : {}),
        ...(conflictRebaseFields.length > 0 ? { conflictRebaseFields } : {}),
        ...(conversationCommands.length > 0 ? { conversationCommands } : {})
      }
    : undefined
}

const withPendingConversationCommands = (
  session: PersistedChatSession,
  options: SaveSessionOptions | undefined
): SaveSessionOptions | undefined =>
  mergeSaveSessionOptions(options, {
    conversationCommands: pendingSessionConversationCommands(session.id)
  })

const LATEST_SESSION_SAVE_INTERVAL_MS = 500
// While a turn is streaming, intermediate flushes only bound crash loss and the terminal commit
// still flushes at the normal cadence, so relax the intermediate cadence: each flush serializes
// the whole (growing) Session and must not run at the streaming tick rate.
const STREAMING_SESSION_SAVE_INTERVAL_MS = 2_000

type PendingLatestSessionSave = {
  target: string
  task: LatestSessionSaveTask
  options: SaveSessionOptions | undefined
  recoveryBase?: PersistedChatSession
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
const activePreparationSaveOptions = (
  options: SaveSessionOptions | undefined
): SaveSessionOptions | undefined =>
  options?.conversationCommands
    ? {
        ...options,
        conversationCommands: retainActivePreparationCommands(options.conversationCommands)
      }
    : options

const createOrderedSessionPersistence = (
  api: Pick<SessionPersistenceApi, 'saveSession' | 'saveManifest'>
): OrderedSessionPersistence => {
  const recovery = new SessionWriteRecovery({
    satisfied: isSessionWriteSatisfied,
    merge: mergeSessionWriteIntent,
    ignoreError: (error) => error instanceof SessionPersistenceGenerationChangedError,
    report: reportSessionWriteRecovery
  })
  let queue: Promise<unknown> = Promise.resolve()
  let pendingWriteCount = 0
  let activeFlushes = 0
  const deferredSaves = new Set<Promise<unknown>>()
  const acknowledgedRevisions = new Map<string, number>()
  const acknowledgedSessions = new Map<string, PersistedChatSession>()
  const pendingLatestByTarget = new Map<string, PendingLatestSessionSave>()
  const deferredConversationCommandTargets = new Set<string>()
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

  const trackConversationCommandOutcome = (
    target: string,
    options: SaveSessionOptions | undefined,
    durable: PersistedChatSession
  ): void => {
    const commands = activePreparationSaveOptions(options)?.conversationCommands
    if (!commands || commands.length === 0) return
    const acknowledged = new Set(durable.runtimeConversationCommandIds ?? [])
    if (commands.some(({ id }) => !acknowledged.has(id)))
      deferredConversationCommandTargets.add(target)
    else deferredConversationCommandTargets.delete(target)
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
  const schedule = <Result>(
    target: string,
    task: () => Promise<Result>,
    epoch = getDesktopRuntimeEpoch()
  ): Promise<Result> => {
    pendingWriteCount += 1
    const run = queue.then(async () => {
      try {
        assertDesktopRuntimeWrite(epoch)
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
        const resumed = result.released.then(() => schedule(target, task, epoch))
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
    const epoch = getDesktopRuntimeEpoch()
    assertDesktopRuntimeWrite(epoch)
    const submitted = structuredClone(session)
    submitted.revision = Math.max(
      sessionRevision(submitted),
      acknowledgedRevisions.get(submitted.id) ?? 0
    )
    options = activePreparationSaveOptions(options)
    const durable = options
      ? await api.saveSession(submitted, options)
      : await api.saveSession(submitted)
    assertDesktopRuntimeWrite(epoch, 'after-submit')
    acknowledgeSession(durable)
    acknowledgeSessionConversationCommands(durable)
    trackConversationCommandOutcome(`session:${submitted.id}`, options, durable)
    return durable
  }

  const saveLatestSession = (
    target: string,
    task: LatestSessionSaveTask,
    options?: SaveSessionOptions,
    streaming?: boolean,
    recoveryContext?: LatestSessionSaveRecoveryContext
  ): Promise<PersistedChatSession> => {
    const pending = pendingLatestByTarget.get(target)
    if (pending?.promise) {
      pending.task = task
      // The latest snapshot owns its lease; explicit edits must not inherit an earlier writer's
      // token. Rebase fields and conversation commands still accumulate across queued snapshots.
      pending.options = mergeSaveSessionOptions(
        { ...pending.options, runtimeWriterToken: options?.runtimeWriterToken },
        options
      )
      // Retain the same fields/commands and original base even if the queue's connection gate
      // rejects before the latest task can serialize or load its authoritative Session.
      recoveryContext?.capture(pending.options, pending.recoveryBase)
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
      recoveryBase: recoveryContext?.base,
      streaming,
      generation: hydrationGeneration
    }
    const epoch = getDesktopRuntimeEpoch()
    const runTask = async (): Promise<PersistedChatSession> => {
      // A fast IPC/disk round-trip otherwise defeats latest-wins coalescing and rewrites the entire
      // Session at the live presentation frame rate. Keep the entry replaceable while it waits.
      await waitForLatestSessionSaveCadence(entry)
      deferExportedSessionSave(target)
      if (pendingLatestByTarget.get(target) === entry) pendingLatestByTarget.delete(target)
      if (entry.generation !== hydrationGeneration) {
        throw new SessionPersistenceGenerationChangedError()
      }
      entry.options = activePreparationSaveOptions(entry.options)
      const durable = await entry.task(entry.options)
      assertDesktopRuntimeWrite(epoch, 'after-submit')
      acknowledgeSession(durable)
      trackConversationCommandOutcome(entry.target, entry.options, durable)
      return durable
    }
    const run = schedule(target, runTask)
    entry.promise = run
    pendingLatestByTarget.set(target, entry)
    return run
  }

  return {
    recovery,
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
      const activeSessionTargets = new Set(sessions.map((session) => `session:${session.id}`))
      for (const target of deferredConversationCommandTargets) {
        if (target.startsWith('session:') && !activeSessionTargets.has(target))
          deferredConversationCommandTargets.delete(target)
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
    releaseAcknowledgedSessionBody: (sessionId) => {
      if (pendingWriteCount > 0 || failedWritesByTarget.has(`session:${sessionId}`)) return false
      acknowledgedSessions.delete(sessionId)
      // Keep the small revision watermark: later explicit writes must not regress their revision.
      return true
    },
    clearWriteFailure: (target) => {
      failedWritesByTarget.delete(target)
      deferredConversationCommandTargets.delete(target)
    },
    clearWriteFailures: () => {
      failedWritesByTarget.clear()
      deferredConversationCommandTargets.clear()
      recovery.reset()
    },
    pruneDeferredConversationCommands: (sessions) => {
      const activeSessionTargets = new Set(sessions.map((session) => `session:${session.id}`))
      for (const target of deferredConversationCommandTargets) {
        if (target.startsWith('session:') && !activeSessionTargets.has(target))
          deferredConversationCommandTargets.delete(target)
      }
    },
    hasDeferredConversationCommands: (target) => deferredConversationCommandTargets.has(target),
    saveSession: (session, options) => {
      // Commands must be paired with the snapshot visible when the save is admitted. Reading the
      // pending buffer after an older save waits in the queue can attach a newer Message command.
      const submittedOptions = withPendingConversationCommands(session, options)
      const base = acknowledgedSessions.get(session.id)
      return recovery.trackSession(
        `session:${session.id}`,
        () => ({ base, session, options: submittedOptions }),
        () =>
          enqueue(`session:${session.id}`, () => saveSubmittedSession(session, submittedOptions))
      )
    },
    saveSessionWithRecovery: (session, options, recover) => {
      const submittedOptions = withPendingConversationCommands(session, options)
      const base = acknowledgedSessions.get(session.id)
      return recovery.trackSession(
        `session:${session.id}`,
        () => ({ base, session, options: submittedOptions }),
        () =>
          enqueue(`session:${session.id}`, async () => {
            const submitted = structuredClone(session)
            submitted.revision = Math.max(
              sessionRevision(submitted),
              acknowledgedRevisions.get(submitted.id) ?? 0
            )
            try {
              return await saveSubmittedSession(submitted, submittedOptions)
            } catch (error) {
              return recover(error, submitted, (retrySession, retryOptions) =>
                saveSubmittedSession(
                  retrySession,
                  mergeSaveSessionOptions(submittedOptions, retryOptions)
                )
              )
            }
          })
      )
    },
    saveManifest: (request) =>
      recovery.trackManifest(request, () => enqueue('manifest', () => api.saveManifest(request))),
    flush: async (target?: string) => {
      // Runtime/store updates can admit new snapshots while earlier writes are in flight.
      // Keep cadence disabled until every overlapping flush has finished.
      activeFlushes += 1
      try {
        releasePendingLatestCadence()
        for (;;) {
          const draining = queue
          await draining
          await Promise.allSettled([...deferredSaves])
          await recovery.whenIdle()
          if (queue === draining && deferredSaves.size === 0) break
        }
        const failure = target
          ? failedWritesByTarget.has(target)
            ? { done: false, value: failedWritesByTarget.get(target) }
            : { done: true }
          : failedWritesByTarget.values().next()
        if (!failure.done) throw failure.value
        const deferredTarget = target
          ? deferredConversationCommandTargets.has(target)
            ? target
            : undefined
          : deferredConversationCommandTargets.values().next().value
        if (deferredTarget) throw new SessionPersistenceDeferredError(deferredTarget)
        recovery.assertSettled(target)
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
  api: SessionReadApi = window.api.sessions,
  options?: SaveSessionOptions
): Promise<PersistedChatSession> => {
  const target = `session:${session.id}`
  let saveOptions = withPendingConversationCommands(session, options)
  const retained = persistence.recovery.get(target)
  const retainedCommands = retained?.intent?.options?.conversationCommands
  const rejectedCommand = retainedCommands?.length === 1 ? retainedCommands[0] : undefined
  const commands = saveOptions?.conversationCommands
  const command = commands?.length === 1 ? commands[0] : undefined
  if (
    retained?.state === 'failed' &&
    !retained.reviewRequired &&
    retained.intent?.session.projectId === session.projectId &&
    retained.intent.session.runtimeTranscriptOwner === 'main' &&
    session.runtimeTranscriptOwner === 'main' &&
    sessionIntentFields(retained.intent).length === 0 &&
    !saveOptions?.conflictRebaseFields?.length &&
    !saveOptions?.runtimeWriterToken &&
    ((rejectedCommand?.kind === 'rollback-prompt' &&
      command?.kind === 'rollback-prompt' &&
      rejectedCommand.preparationId === command.preparationId &&
      Boolean(rejectedCommand.preserveSubmittedMessage) ===
        Boolean(command.preserveSubmittedMessage)) ||
      (rejectedCommand?.kind === 'prepare-prompt' &&
        command?.kind === 'prepare-prompt' &&
        rejectedCommand.promptMessageId === command.promptMessageId &&
        rejectedCommand.mode === command.mode) ||
      (command?.kind === 'rollback-prompt' &&
        session.promptPreparation?.id === command.preparationId &&
        retainedCommands?.length &&
        retainedCommands.every((pending) => pending.preparationId === command.preparationId) &&
        retainActivePreparationCommands(retainedCommands).length === 0))
  ) {
    saveOptions = {
      ...saveOptions,
      conversationCommands: [
        rejectedCommand?.kind === 'prepare-prompt' || rejectedCommand?.kind === 'rollback-prompt'
          ? rejectedCommand
          : command!
      ]
    }
  } else {
    persistence.recovery.assertSettled(target)
  }
  try {
    const durable = await persistence.saveSessionWithRecovery(
      session,
      saveOptions,
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
              api,
              { bypassCache: true }
            ),
          retry
        )
      }
    )
    if (persistence.hasDeferredConversationCommands(target)) {
      throw new SessionPersistenceDeferredError(target)
    }
    acknowledgeSessionConversationCommands(durable)
    unresolvedSessionRevisionConflictTargets.delete(target)
    return durable
  } catch (error) {
    reportPersistenceError(error, 'session-save', {
      sessionId: session.id,
      projectId: session.projectId
    })
    if (isSessionRevisionConflictError(error)) unresolvedSessionRevisionConflictTargets.add(target)
    throw error
  }
}

const saveSessionFieldsInOrder = (
  session: PersistedChatSession,
  conflictRebaseFields: readonly SessionConflictRebaseField[]
): Promise<PersistedChatSession> =>
  saveSessionInOrder(session, liveSessionPersistence, window.api.sessions, {
    conflictRebaseFields: [...conflictRebaseFields]
  })

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

const retryDeferredSessionPersistence = async (target: string): Promise<void> => {
  if (!target.startsWith('session:')) return
  const sessionId = target.slice('session:'.length)
  const session = useSessionStore
    .getState()
    .sessions.find((candidate) => candidate.id === sessionId)
  if (!session) return
  await saveSessionInOrder(toPersistedSession(session))
}

const flushSessionPersistence = async (target?: string): Promise<void> => {
  try {
    await liveSessionPersistence.flush(target)
  } catch (error) {
    if (!target || !isSessionPersistenceDeferredError(error) || error.target !== target) throw error
    await retryDeferredSessionPersistence(target)
    await liveSessionPersistence.flush(target)
  }
  if (
    target
      ? unresolvedSessionRevisionConflictTargets.has(target)
      : unresolvedSessionRevisionConflictTargets.size > 0
  ) {
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

// A crash between persisting a pending artifact reference and finalizing it strands the file in
// `.pending/<run>/`. The path segment is stable across OSes, so detect it structurally.
const isPendingArtifactPath = (path: string | undefined): path is string =>
  typeof path === 'string' && path.split(/[\\/]/).includes('.pending')

type ArtifactRetrySession = Pick<ChatSession, 'artifacts' | 'conversationGraph' | 'messages'>

const artifactRetryResponseIds = (
  session: ArtifactRetrySession,
  promptMessageId: string
): Set<string> => {
  const messages = session.conversationGraph?.messages ?? session.messages
  if (!messages.some((message) => message.id === promptMessageId && message.role === 'user'))
    return new Set()
  const responseIds = new Set(
    messages
      .filter(
        (message) => message.role === 'agent' && message.responseToMessageId === promptMessageId
      )
      .map(({ id }) => id)
  )
  const activeMessages: readonly PersistedChatMessage[] = session.conversationGraph
    ? resolveActiveConversationMessages(session.conversationGraph)
    : session.messages
  // Untagged legacy replies can only belong to the latest eligible prompt on this branch.
  // A relay or later prompt ends that interval; the turn's own routed replies do not.
  if (latestTurnAnchor(activeMessages)?.id === promptMessageId) {
    for (const message of turnAnchorInterval(activeMessages, promptMessageId)) {
      if (message.role === 'agent' && !message.responseToMessageId) responseIds.add(message.id)
    }
  }
  return responseIds
}

const pendingArtifactRequests = (
  session: ArtifactRetrySession,
  includeNativeVersions = false,
  responseMessageIds?: ReadonlySet<string>
): Array<{ messageId: string; pendingPaths: string[]; artifactVersionIds?: string[] }> => {
  const artifactsById = new Map(
    (session.artifacts ?? []).map((artifact) => [artifact.id, artifact])
  )
  const messages = session.conversationGraph?.messages ?? session.messages
  return messages.flatMap((message) => {
    if (responseMessageIds && !responseMessageIds.has(message.id)) return []
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

const retryPendingArtifactFinalization = async (
  sessionId: string,
  api: ArtifactReconcileApi = window.api.artifacts,
  options: { promptMessageId?: string } = {}
): Promise<void> => {
  const session = useSessionStore
    .getState()
    .sessions.find((candidate) => candidate.id === sessionId)
  if (!session?.projectId) throw new Error('Session not found.')
  clearWorkspaceOperationError(sessionId)
  try {
    const responseMessageIds = options.promptMessageId
      ? artifactRetryResponseIds(session, options.promptMessageId)
      : undefined
    const requests = pendingArtifactRequests(session, true, responseMessageIds)
    if (requests.length === 0)
      throw new Error('No pending Artifact references are available to retry.')
    for (const request of requests) {
      const result = await api.reconcilePendingArtifacts({
        projectId: session.projectId,
        sessionId,
        ...request
      })
      if (!Array.isArray(result)) throw invalidArtifactFinalizationProofError(result.message)
    }
    // Main owns Artifact publication and outcome repair. The command result is only file metadata;
    // refresh its committed Session instead of reconstructing a competing renderer settlement.
    const authority = await loadPersistedSession(
      { projectId: session.projectId, sessionId },
      undefined,
      { bypassCache: true }
    )
    if (!authority) throw new Error('Session not found.')
    useSessionStore.getState().applyDurableSessionProjection({
      source: session,
      session: authority,
      mode: 'runtime-transcript-authority'
    })
    const remainingResponseIds = options.promptMessageId
      ? new Set([
          ...responseMessageIds!,
          ...artifactRetryResponseIds(authority, options.promptMessageId)
        ])
      : undefined
    if (pendingArtifactRequests(authority, false, remainingResponseIds).length > 0) {
      throw new Error('Artifact finalization did not resolve all pending files.')
    }
  } catch (error) {
    reportWorkspaceOperationError(sessionId, error instanceof Error ? error.message : String(error))
    reportPersistenceError(error, 'artifact-reconcile')
    throw error
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
  isCheckingWrites: boolean
  isRetryingWrites: boolean
  writeIssues: readonly SessionWriteIssue[]
  persistenceBlockedSessionIds: readonly string[]
  reportSessionSizeLimit: (sessionId: string) => void
  reviewWriteIssues: () => void
  dismissWriteWarning: () => void
  dismissLoadWarning: () => void
  startNewConversationAfterSizeLimit: () => void
  retryLoad: () => void
  retryWrites: () => void
  discardWrite: (target: string) => Promise<void>
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
  liveSessionPersistence.pruneDeferredConversationCommands(sessions)
  for (const target of targets) {
    if (target.startsWith('session:') && !activeSessionTargets.has(target)) {
      targets.delete(target)
      conflictRebaseFields?.delete(target)
      for (const related of relatedTargets) related.delete(target)
      liveSessionPersistence.clearWriteFailure(target)
    }
  }
}

const reportedPersistenceFailures = new WeakMap<object, Set<string>>()

// Recovery milestones share the reviewed diagnostics bridge, but Main records them separately
// from JavaScript failures. Never send retained snapshots, titles, command payloads or raw errors.
function reportSessionWriteDiagnostic(
  error: unknown,
  identity: Pick<RendererSessionWriteDiagnostics, 'target' | 'sessionId' | 'projectId'>,
  diagnostics: RendererSessionWriteRecoveryDiagnostics
): void {
  try {
    const runtime = useDesktopRuntimeRecoveryStore.getState()
    const code = sessionWriteFailureCode(error)
    window.api?.diagnostics?.reportRendererFailure(
      projectRendererFailure(
        'handled-error',
        error,
        'workspace',
        identity.target === 'session' ? 'session-save' : 'session-manifest-save',
        {
          ...identity,
          code,
          epoch: runtime.epoch,
          phase:
            code === 'desktop-runtime-not-submitted'
              ? 'before-submit'
              : code === 'desktop-runtime-disconnected'
                ? 'result-unknown'
                : 'rejected',
          recovery: {
            ...diagnostics,
            runtimePhase: runtime.phase
          }
        }
      )
    )
  } catch {
    // Logging must not affect save ordering, recovery decisions or quit/send barriers.
  }
}

function reportSessionWriteRecovery(
  write: RetainedSessionWrite,
  diagnostics: RendererSessionWriteRecoveryDiagnostics
): void {
  try {
    const expectedRevision =
      write.intent?.options?.expectedRevision ??
      (write.intent?.base ? sessionRevision(write.intent.base) : undefined)
    reportSessionWriteDiagnostic(
      write.error,
      write.target === 'manifest'
        ? { target: 'manifest' }
        : {
            target: 'session',
            sessionId: write.intent?.session.id ?? write.target.slice('session:'.length),
            projectId: write.intent?.session.projectId
          },
      {
        state: write.state,
        reviewRequired: write.reviewRequired,
        attempt: write.version,
        elapsedMs:
          diagnostics.elapsedMs ?? Math.max(0, Math.round(performance.now() - write.retainedAt)),
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
        commandCount: write.intent?.options?.conversationCommands?.length ?? 0,
        ...diagnostics
      }
    )
  } catch {
    // Collecting optional context is also best-effort when the failed intent was not serializable.
  }
}

function reportSessionWriteIssue(
  issue: SessionWriteIssue,
  diagnostics: RendererSessionWriteRecoveryDiagnostics
): void {
  const retained = liveSessionPersistence.recovery.get(issue.target)
  if (retained) {
    reportSessionWriteRecovery(retained, diagnostics)
    return
  }
  reportSessionWriteDiagnostic(
    {
      code:
        issue.kind === 'size-limit'
          ? 'session-size-limit'
          : issue.kind === 'conflict'
            ? 'session-revision-conflict'
            : 'unknown'
    },
    issue.target === 'manifest'
      ? { target: 'manifest' }
      : { target: 'session', sessionId: issue.sessionId, projectId: issue.projectId },
    { state: issue.state, ...diagnostics }
  )
}

// Retains full diagnostics in the local console while the main-process log receives only a bounded,
// allowlisted phase, error category, and stack fingerprint. Never bridge raw messages or paths.
const reportPersistenceError = (
  error: unknown,
  context: RendererFailureContext = 'session-persistence-unknown',
  identity?: { sessionId?: string; projectId?: string }
): void => {
  console.warn('Session persistence failed', error)
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
    const reported = reportedPersistenceFailures.get(error) ?? new Set<string>()
    const key = `${context}:${identity?.projectId ?? ''}:${identity?.sessionId ?? ''}`
    if (reported.has(key) || (!identity && reported.size > 0)) return
    reported.add(key)
    reportedPersistenceFailures.set(error, reported)
  }
  try {
    window.api.diagnostics?.reportRendererFailure(
      projectRendererFailure(
        'handled-error',
        error,
        'unknown',
        context,
        identity
          ? {
              target: identity.sessionId ? 'session' : 'manifest',
              ...identity,
              code: sessionWriteFailureCode(error),
              epoch: getDesktopRuntimeEpoch(),
              phase:
                sessionWriteFailureCode(error) === 'desktop-runtime-not-submitted'
                  ? 'before-submit'
                  : sessionWriteFailureCode(error) === 'desktop-runtime-disconnected'
                    ? 'result-unknown'
                    : 'rejected'
            }
          : undefined
      )
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
  'Open-Science could not read saved conversation data. Retry to continue.'
const SAFE_SESSION_WRITE_ERROR =
  'Open-Science could not save the latest conversation changes. Retry before closing the app.'
const SESSION_REVISION_CONFLICT_WRITE_ERROR =
  'This conversation changed in another window. Local changes are retained. Review the conversation, then retry or discard the retained changes.'
const SESSION_SIZE_LIMIT_WRITE_ERROR =
  'This conversation exceeded the 256 MiB storage limit. Its current run was stopped. Start a new conversation to keep working. Changes after the last successful save are not durable.'

// Hydrates the in-memory session store from the per-session files loaded by the main process.
const loadPersistedSessions = async (
  api: SessionPersistenceApi,
  shouldHydrate: () => boolean = () => true,
  preferredSelection?: SessionHydrationSelection | (() => SessionHydrationSelection),
  preserveLocalDrafts = false,
  retainedNewSessionIds: ReadonlySet<string> = new Set()
): Promise<LoadAllSessionsResult | ListSessionSummariesResult | undefined> => {
  const previousSessions = preserveLocalDrafts ? useSessionStore.getState().sessions : []
  const restoreLocalDrafts = (): void => {
    if (!preserveLocalDrafts) return
    useSessionStore.setState((state) => {
      const sessions = state.sessions.map((session) => {
        const previous = previousSessions.find((candidate) => candidate.id === session.id)
        if (!previous) return session
        return retainSessionRecoveryDrafts(session, previous)
      })
      for (const previous of previousSessions) {
        if (
          (previous.isPending || retainedNewSessionIds.has(previous.id)) &&
          !sessions.some((session) => session.id === previous.id)
        )
          sessions.push(previous)
      }
      const preferred = currentSelection()?.sessionId
      return {
        sessions,
        ...(preferred && sessions.some((session) => session.id === preferred)
          ? { selectedSessionId: preferred }
          : {})
      }
    })
  }
  const currentSelection = (): SessionHydrationSelection | undefined =>
    typeof preferredSelection === 'function' ? preferredSelection() : preferredSelection
  if (api.list) {
    const result = await api.list()
    if (!shouldHydrate()) return undefined
    const retrySessionId = currentSelection()?.sessionId
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
                api,
                // Recovery must not validate cached content against the previous store revision.
                { bypassCache: true }
              )
            ] as const
        )
      )
    )
    if (!shouldHydrate()) return undefined
    const missing = summariesToHydrate.find((summary) => !hydratedSessions.get(summary.id))
    if (missing) {
      throw new Error(
        'Session JSON requiring startup hydration is missing from the SQLite projection.'
      )
    }
    // The retained workspace remains navigable during a reload. Do not replay the selection from
    // the Retry click over a later user navigation (including an explicitly cleared selection).
    const selection = currentSelection()
    const selected = selection?.sessionId ? hydratedSessions.get(selection.sessionId) : undefined
    useSessionStore
      .getState()
      .hydrateSessionSummaries(result.sessions, selected, result.manifest, selection)
    for (const hydrated of hydratedSessions.values()) {
      if (hydrated && hydrated.id !== selected?.id) {
        useSessionStore.getState().upsertPersistedSession(hydrated)
      }
    }
    restoreLocalDrafts()
    return result
  }

  const result = await api.loadAll()
  if (!shouldHydrate()) return undefined

  // Retry captures live navigation as an explicit tri-state. If the user had no selection, or the
  // selected Session disappeared before recovery completed, do not replay a stale disk manifest or
  // fall through to the globally newest Session from another Project. Passing the selection into
  // hydration applies the sessions and selection atomically for all Zustand subscribers.
  useSessionStore.getState().hydrateSessions(result.sessions, result.manifest, currentSelection())
  restoreLocalDrafts()
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
  compacting: undefined,
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
          api,
          { bypassCache: true }
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
      run: () => Promise<PersistedChatSession | void>
      failureContext: StoreSaverFailureContext
      intent?: () => SessionWriteIntent
      manifest?: SaveSessionManifestRequest
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
        const conversationCommands = pendingSessionConversationCommands(session.id)
        const saveOptions =
          conflictRebaseFields.length > 0 || conversationCommands.length > 0
            ? {
                ...(conflictRebaseFields.length > 0 ? { conflictRebaseFields } : {}),
                ...(conversationCommands.length > 0 ? { conversationCommands } : {})
              }
            : undefined
        let savedAuthority: PersistedChatSession | undefined
        let submittedMetadata: PersistedChatSession | undefined
        const metadata = (source: ChatSession): PersistedChatSession => ({
          id: source.id,
          projectId: source.projectId,
          title: source.title,
          cwd: source.cwd,
          status: source.status,
          createdAt: source.createdAt,
          updatedAt: source.updatedAt,
          pinned: source.pinned,
          messages: []
        })
        let recoveryBase = metadata(previousSession ?? session)
        let recoveryOptions: SaveSessionOptions | undefined = saveOptions
        tasks.push({
          target,
          failureContext: { conflictRebaseFields },
          intent: () => ({
            base: savedAuthority ?? recoveryBase,
            session: submittedMetadata ?? metadata(session),
            options: recoveryOptions
          }),
          run: () =>
            persistence.saveLatestSession(
              target,
              async (coalescedOptions) => {
                const authority = await loadPersistedSession(
                  {
                    projectId: session.projectId,
                    sessionId: session.id
                  },
                  api,
                  { bypassCache: true }
                )
                if (!authority) throw new Error('Session JSON is missing for metadata persistence.')
                savedAuthority = authority
                const fields = new Set(coalescedOptions?.conflictRebaseFields ?? [])
                const candidate: PersistedChatSession = {
                  ...authority,
                  ...(fields.has('title') ? { title: session.title } : {}),
                  ...(fields.has('pinned') ? { pinned: session.pinned } : {}),
                  ...(fields.size > 0
                    ? { updatedAt: Math.max(authority.updatedAt, session.updatedAt) }
                    : {})
                }
                submittedMetadata = candidate
                const durable = coalescedOptions
                  ? await api.saveSession(candidate, coalescedOptions)
                  : await api.saveSession(candidate)
                acknowledgedRevisions.set(session.id, sessionRevision(durable))
                acknowledgedSessions.set(session.id, durable)
                useSessionStore.getState().upsertPersistedSession(durable)
                return durable
              },
              saveOptions,
              undefined,
              {
                base: recoveryBase,
                capture: (options, base) => {
                  recoveryOptions = options
                  if (base) recoveryBase = base
                }
              }
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

      // A reader flush must not write a received snapshot back to the authority. Real user edits
      // differ from the acknowledged snapshot and still follow normal conflict checking.
      if (
        !isRuntimeWriter() &&
        jsonValuesEqual(
          toPersistedSession(session, nextStreamingMessages),
          acknowledgedSessions.has(session.id)
            ? toPersistedSession(hydrateSession(acknowledgedSessions.get(session.id)!))
            : undefined
        )
      )
        continue

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

        const conversationCommands = pendingSessionConversationCommands(session.id)
        const writerOptions =
          conflictRebaseFields.length > 0 ||
          hasUnsavedContextReset ||
          conversationCommands.length > 0
            ? undefined
            : runtimeWriterSaveOptions()
        const saveOptions =
          conflictRebaseFields.length > 0 ||
          writerOptions?.runtimeWriterToken ||
          conversationCommands.length > 0
            ? {
                ...(conflictRebaseFields.length > 0 ? { conflictRebaseFields } : {}),
                ...(writerOptions ?? {}),
                ...(conversationCommands.length > 0 ? { conversationCommands } : {})
              }
            : undefined
        const sourceAuthority = acknowledgedSessions.get(session.id)
        let recoveryOptions = saveOptions
        let submittedAuthority = sourceAuthority
        let submittedSnapshot: PersistedChatSession | undefined
        let rebasedBeforeSave = false
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
          // A queued snapshot can predate newer content on the same Branch too. Rebase
          // against its original authority before borrowing the newer revision number.
          submittedAuthority = acknowledgedSessions.get(session.id)
          if (sourceAuthority && submittedAuthority) {
            const reconciled = reconcileCompletedTaskReply(
              sourceAuthority,
              persisted,
              submittedAuthority
            )
            rebasedBeforeSave = reconciled !== persisted
            persisted = reconciled
          }
          if (
            !selectionIntent &&
            sourceAuthority &&
            submittedAuthority &&
            // Main applies captured user commands and preferences to its current transcript;
            // a stale streaming projection must reach that owner rather than fail a legacy merge.
            submittedAuthority.runtimeTranscriptOwner !== 'main' &&
            (selectedRootBranchId(sourceAuthority) !== selectedRootBranchId(submittedAuthority) ||
              (submittedAuthority.taskRunCommitId &&
                submittedAuthority.taskRunCommitId !== sourceAuthority.taskRunCommitId &&
                sessionRevision(submittedAuthority) > sessionRevision(sourceAuthority)))
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
            rebasedBeforeSave = true
            persisted = rebased
          }
          // Non-Task completions can also overtake an unchanged queued running snapshot.
          if (
            sourceAuthority &&
            submittedAuthority &&
            sessionRevision(submittedAuthority) > sessionRevision(sourceAuthority) &&
            sourceAuthority.status === 'running' &&
            submittedAuthority.status === 'idle' &&
            persisted.status === sourceAuthority.status &&
            sessionFieldValuesEqual('activeRun', persisted.activeRun, sourceAuthority.activeRun)
          ) {
            persisted = {
              ...persisted,
              status: submittedAuthority.status,
              activeRun: submittedAuthority.activeRun
            }
          }
          submittedSnapshot = persisted
          return persisted
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
              (rebasedBeforeSave ||
                recoveredRevisionConflict ||
                (options?.conflictRebaseFields?.length ?? 0) > 0)
                ? 'replace-persisted-if-current'
                : 'merge-upload-identities'
          })
        }

        tasks.push({
          target,
          failureContext: { conflictRebaseFields },
          intent: () => ({
            base: submittedAuthority,
            session: submittedSnapshot ?? toPersistedSession(session, nextStreamingMessages),
            options: recoveryOptions
          }),
          run: isForced
            ? async () => {
                const persisted = observePersistencePhase('session-serialize', serializeSession)
                persisted.revision =
                  acknowledgedRevisions.get(session.id) ?? sessionRevision(persisted)
                let recoveredRevisionConflict = false
                const durableSession = await persistence.saveSessionWithRecovery(
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
                acknowledgedRevisions.set(session.id, sessionRevision(durableSession))
                acknowledgedSessions.set(session.id, durableSession)
                acknowledgeSessionConversationCommands(durableSession)
                observePersistencePhase('session-apply-durable', () =>
                  applyDurableSession(durableSession, saveOptions, recoveredRevisionConflict)
                )
                return durableSession
              }
            : () =>
                persistence.saveLatestSession(
                  target,
                  async (coalescedOptions) => {
                    const persisted = observePersistencePhase('session-serialize', serializeSession)
                    persisted.revision =
                      acknowledgedRevisions.get(session.id) ?? sessionRevision(persisted)
                    let durableSession: PersistedChatSession
                    let recoveredRevisionConflict = false
                    try {
                      durableSession = coalescedOptions
                        ? await api.saveSession(
                            persisted,
                            activePreparationSaveOptions(coalescedOptions)
                          )
                        : await api.saveSession(persisted)
                    } catch (error) {
                      durableSession = await recoverRevisionConflict(
                        error,
                        persisted,
                        submittedAuthority,
                        coalescedOptions,
                        api.saveSession
                      )
                      recoveredRevisionConflict = true
                    }
                    acknowledgedRevisions.set(session.id, sessionRevision(durableSession))
                    acknowledgedSessions.set(session.id, durableSession)
                    acknowledgeSessionConversationCommands(durableSession)
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
                  streamingSessionIds.has(session.id),
                  { capture: (options) => (recoveryOptions = options) }
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
          manifest: { lastSessionId: state.selectedSessionId },
          run: () =>
            persistence.saveManifest({
              lastSessionId: state.selectedSessionId
            })
        })
      }
    }

    for (const id of pendingBranchSelections.keys()) {
      if (!nextById.has(id)) pendingBranchSelections.delete(id)
    }
    previousSessions = nextSessions
    previousSelection = state.selectedSessionId
    previousStreamingMessages = nextStreamingMessages

    const scheduledTasks = tasks.map(({ target, run, failureContext, intent, manifest }) => {
      if (!options?.forceTargets?.has(target) && persistence.recovery.get(target)?.reviewRequired) {
        if (intent) persistence.recovery.retainChanges(target, intent)
        if (manifest) persistence.recovery.retainManifest(manifest)
        return Promise.resolve()
      }
      // Invoke every task now so it takes its place in the shared persistence queue at snapshot time.
      const scheduled = intent
        ? persistence.recovery.trackSession(
            target,
            intent,
            run as () => Promise<PersistedChatSession>
          )
        : run()
      return scheduled.then(
        (result) => {
          observer.onSuccess?.(target)
          return result
        },
        (error: unknown) => {
          if (error instanceof SessionPersistenceGenerationChangedError) return undefined
          const session = nextById.get(target.slice('session:'.length))
          reportPersistenceError(
            error,
            target === 'manifest' ? 'session-manifest-save' : 'session-save',
            session ? { sessionId: session.id, projectId: session.projectId } : {}
          )
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
  const recovery = useDesktopRuntimeRecoveryStore()
  const retainedWriteIssues = useSyncExternalStore(
    liveSessionPersistence.recovery.subscribe,
    liveSessionPersistence.recovery.getSnapshot
  )
  const recoveryLoadEpoch =
    recovery.phase === 'connected' || recovery.phase === 'reconciling'
      ? recovery.epoch
      : -recovery.epoch - 1
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
  const [isRetryingWrites, setIsRetryingWrites] = useState(false)
  const retryingTargets = useRef(new Set<string>())
  const [persistenceBlockedSessionIds, setPersistenceBlockedSessionIds] = useState<
    readonly string[]
  >([])
  const [loadAttempt, setLoadAttempt] = useState(0)
  const retrySelection = useRef<SessionHydrationSelection | undefined>(undefined)
  const terminalWriteFailures = useRef(new Map<string, AcpRuntimeEvent>())
  const [terminalWriteIssues, setTerminalWriteIssues] = useState<readonly SessionWriteIssue[]>([])
  const terminalFailureQuery = useRef(0)
  const terminalObserverMounted = useRef(false)
  const failedWriteTargets = useRef(new Set<string>())
  const failedConflictRebaseFields = useRef(new Map<string, SessionConflictRebaseField[]>())
  const revisionConflictTargets = useRef(new Set<string>())
  const sizeLimitTargets = useRef(new Set<string>())
  const abandonedSizeLimitTargets = useRef(new Set<string>())
  const retryManifestWritePending = useRef(false)
  const saverRef = useRef<StoreSaver | undefined>(undefined)
  const trackedRecoveryTargets = useRef(new Set<string>())
  const previousWriteNotice = useRef<{
    signature: string
    notice: RendererSessionWriteRecoveryDiagnostics['notice']
    issues: readonly SessionWriteIssue[]
  }>({ signature: 'hidden:', notice: 'hidden', issues: [] })
  useEffect(() => {
    const notice = writeError
      ? writeErrorRetryable
        ? 'attention'
        : 'size-limit'
      : retainedWriteIssues.some(({ state }) => state === 'checking')
        ? 'checking'
        : 'hidden'
    const issues = new Map(
      [...retainedWriteIssues, ...terminalWriteIssues].map((issue) => [issue.target, issue])
    )
    const signature = `${notice}:${[...issues.values()]
      .map(({ target, state, kind }) => `${target}:${state}:${kind}`)
      .sort()
      .join(',')}`
    const previous = previousWriteNotice.current
    if (previous.signature === signature) return
    previousWriteNotice.current = {
      signature,
      notice,
      issues: notice === 'hidden' ? [] : [...issues.values()]
    }
    if (notice === 'hidden' && previous.notice === 'hidden') return
    // Record presentation state changes once, including Main-owned terminal failures. A warning's
    // disappearance is useful evidence even when its retained write has already been cleared.
    const affected = new Map(previous.issues.map((issue) => [issue.target, issue]))
    for (const [target, issue] of issues) affected.set(target, issue)
    for (const issue of affected.values()) {
      reportSessionWriteIssue(issue, {
        event: 'notice-changed',
        notice: issues.has(issue.target) ? notice : 'hidden'
      })
    }
    if (affected.size === 0)
      reportSessionWriteDiagnostic(
        undefined,
        { target: 'session' },
        { event: 'notice-changed', notice }
      )
  }, [retainedWriteIssues, terminalWriteIssues, writeError, writeErrorRetryable])

  const presentOutstandingWriteFailures = useCallback((): void => {
    const retained = liveSessionPersistence.recovery.getSnapshot()
    const checking = new Set(
      retained.filter(({ state }) => state === 'checking').map(({ target }) => target)
    )
    if (
      revisionConflictTargets.current.size > 0 ||
      retained.some(({ state, kind }) => state === 'failed' && kind === 'conflict')
    ) {
      setWriteError(translateRef.current(SESSION_REVISION_CONFLICT_WRITE_ERROR))
      setWriteErrorRetryable(true)
      return
    }
    if (
      [...terminalWriteFailures.current.values()].some(
        (event) => event.terminalCommitFailure === 'storage'
      ) ||
      [...failedWriteTargets.current].some(
        (target) =>
          !checking.has(target) &&
          !sizeLimitTargets.current.has(target) &&
          !liveSessionPersistence.recovery.has(target)
      ) ||
      retained.some(({ state, kind }) => state === 'failed' && kind === 'storage')
    ) {
      setWriteError(translateRef.current(SAFE_SESSION_WRITE_ERROR))
      setWriteErrorRetryable(true)
      return
    }
    if (retained.some(({ state, kind }) => state === 'failed' && kind === 'connection')) {
      setWriteError(
        translateRef.current(
          'Some conversation changes could not be confirmed as saved. Review the affected conversations and retry before closing the app.'
        )
      )
      setWriteErrorRetryable(true)
      return
    }
    if (
      [...sizeLimitTargets.current].some(
        (target) => !abandonedSizeLimitTargets.current.has(target)
      ) ||
      retained.some(({ state, kind }) => state === 'failed' && kind === 'size-limit')
    ) {
      setWriteError(translateRef.current(SESSION_SIZE_LIMIT_WRITE_ERROR))
      setWriteErrorRetryable(false)
      return
    }
    setWriteError(undefined)
    setWriteErrorRetryable(true)
  }, [])
  useEffect(() => {
    const next = new Set(retainedWriteIssues.map(({ target }) => target))
    for (const target of trackedRecoveryTargets.current) {
      if (next.has(target)) continue
      failedWriteTargets.current.delete(target)
      failedConflictRebaseFields.current.delete(target)
      revisionConflictTargets.current.delete(target)
      unresolvedSessionRevisionConflictTargets.delete(target)
      if (!abandonedSizeLimitTargets.current.has(target)) sizeLimitTargets.current.delete(target)
      liveSessionPersistence.clearWriteFailure(target)
    }
    trackedRecoveryTargets.current = next
    setPersistenceBlockedSessionIds(
      [...sizeLimitTargets.current].map((target) => target.slice('session:'.length))
    )
    presentOutstandingWriteFailures()
  }, [retainedWriteIssues, presentOutstandingWriteFailures])
  useEffect(() => {
    if (
      !isReady ||
      recovery.phase !== 'connected' ||
      !retainedWriteIssues.some(({ state }) => state === 'checking')
    )
      return
    let current = true
    const epoch = recovery.epoch
    void (async () => {
      // A rejection may cross IPC after reconnection has already finished. It still needs a fresh
      // authoritative read, even though there will be no further runtime-state notification.
      await liveSessionPersistence.flush().catch(() => undefined)
      const transport = await window.api.desktopRuntime?.getState()
      if (transport && (transport.phase !== 'connected' || transport.epoch !== epoch)) return
      const result = await (window.api.sessions.list?.() ?? window.api.sessions.loadAll())
      await liveSessionPersistence.recovery.reconcile(
        ({ session }) =>
          loadPersistedSession({ projectId: session.projectId, sessionId: session.id }, undefined, {
            bypassCache: true
          }),
        { lastSessionId: result.manifest.lastSessionId },
        () => current && desktopRuntimeWritable() && getDesktopRuntimeEpoch() === epoch
      )
    })().catch((error) => {
      if (!current) return
      for (const { target, state } of retainedWriteIssues) {
        const write = liveSessionPersistence.recovery.get(target)
        if (state === 'checking' && write)
          liveSessionPersistence.recovery.fail(target, error, write, 'failed')
      }
    })
    return () => {
      current = false
    }
  }, [isReady, recovery.epoch, recovery.phase, retainedWriteIssues])
  // Main retains the exact failed execution. The global storage alert owns its Retry, while
  // missing records use the existing Session-local unavailable notice.
  const refreshTerminalWriteFailures = useCallback(async (): Promise<void> => {
    const list = window.api.sessions.listRuntimeTerminalFailures
    if (!list) return
    const query = ++terminalFailureQuery.current
    const events = await list()
    if (!terminalObserverMounted.current || query !== terminalFailureQuery.current) return
    const previous = terminalWriteFailures.current
    const next = new Map<string, AcpRuntimeEvent>()
    const unavailable = translateRef.current('This session was deleted or is unavailable.')
    for (const event of events) {
      if (!event.sessionId || !event.terminalScope || !event.promptMessageId) continue
      next.set(event.terminalScope.executionId, event)
      if (event.terminalCommitFailure === 'missing-record') {
        reportWorkspaceOperationError(event.sessionId, unavailable)
      }
    }
    for (const [executionId, event] of previous) {
      if (
        next.has(executionId) ||
        event.terminalCommitFailure !== 'missing-record' ||
        !event.sessionId
      )
        continue
      if (useWorkspaceOperationErrors.getState().errors[event.sessionId] === unavailable) {
        clearWorkspaceOperationError(event.sessionId)
      }
    }
    terminalWriteFailures.current = next
    setTerminalWriteIssues(
      [...next.values()].flatMap((event): SessionWriteIssue[] => {
        if (event.terminalCommitFailure !== 'storage' || !event.sessionId || !event.terminalScope)
          return []
        return [
          {
            target: `session:${event.sessionId}`,
            sessionId: event.sessionId,
            projectId: event.terminalScope.projectId,
            title: useSessionStore.getState().sessions.find(({ id }) => id === event.sessionId)
              ?.title,
            state: 'failed',
            kind: 'storage'
          }
        ]
      })
    )
    presentOutstandingWriteFailures()
    // Exhaustion deliberately has no durable Session write notification. Fetch Main's live
    // interrupted overlay so the renderer releases the run while raw disk still says running.
    const authorities = await Promise.all(
      [...next.values()]
        .filter(
          (event) =>
            ['storage', 'missing-record'].includes(event.terminalCommitFailure ?? '') &&
            Boolean(event.sessionId && event.terminalScope)
        )
        .map(async (event) => {
          const authority = await loadPersistedSession(
            {
              projectId: event.terminalScope!.projectId,
              sessionId: event.sessionId!
            },
            undefined,
            { bypassCache: true }
          )
          return { event, authority }
        })
    )
    if (!terminalObserverMounted.current || query !== terminalFailureQuery.current) return
    for (const { event, authority } of authorities) {
      const source = useSessionStore.getState().sessions.find(({ id }) => id === event.sessionId)
      const scope = event.terminalScope!
      if (
        !source ||
        source.projectId !== scope.projectId ||
        (source.activeRun
          ? source.activeRun.promptMessageId !== event.promptMessageId ||
            source.activeRun.startedAt !== scope.startedAt
          : !authority || source.resumeRecovery?.promptMessageId !== event.promptMessageId)
      )
        continue
      // A local interruption may already have released activeRun. Its matching recovery target
      // still needs Main's storage-failure overlay, or the obsolete Resume notice remains visible.
      // Ordinary sends have no renderer-only Resume segment alias. Match Main's admission
      // instead, and never let an old failed execution release a newer attempt on this prompt.
      const admission = (
        source.runtimeSessionAdmissions ??
        (source.activeRun ? authority?.runtimeSessionAdmissions : undefined)
      )?.findLast((candidate) => candidate.promptMessageId === event.promptMessageId)
      if (
        admission
          ? admission.executionId !== scope.executionId ||
            admission.agentFrameId !== scope.agentFrameId ||
            admission.messageBranchId !== scope.messageBranchId ||
            admission.runtimeSegmentId !== scope.runtimeSegmentId
          : !source.activeRun || event.terminalCommitFailure !== 'missing-record'
      )
        continue
      if (!authority) {
        // Missing Session record (`missing-record`): Main has lost the durable Session record.
        // Release the local composer gate so the existing unavailable-session Operation Error
        // can be acted on; no outcome is synthesized.
        const messageIds = new Set(source.messages.map(({ id }) => id))
        useSessionStore.setState((state) => ({
          sessions: state.sessions.map((candidate) =>
            candidate.id === source.id
              ? {
                  ...candidate,
                  recordProblems: [
                    ...new Set([...(candidate.recordProblems ?? []), 'missing-record' as const])
                  ],
                  status: 'idle',
                  activeRun: undefined,
                  activeRunRuntimeSegmentId: undefined,
                  agentStatus: undefined,
                  awaitingFirstAgentOutput: undefined,
                  agentPromptInFlight: undefined,
                  compacting: undefined,
                  interactionState: undefined,
                  updatedAt: Date.now()
                }
              : candidate
          ),
          streamingMessages: Object.fromEntries(
            Object.entries(state.streamingMessages).filter(
              ([messageId]) => !messageIds.has(messageId)
            )
          )
        }))
        continue
      }
      useSessionStore.getState().applyDurableSessionProjection({
        source,
        session: authority,
        mode: 'runtime-transcript-authority'
      })
    }
  }, [presentOutstandingWriteFailures])
  useEffect(() => {
    let mounted = true
    terminalObserverMounted.current = true
    const seen = new Set<string>()
    const observe = (events: readonly AcpRuntimeEvent[]): void => {
      if (!mounted) return
      const changed = events.some((event) => {
        // Fork/export and other windows can retry the retained result too. Re-read Main's
        // failure registry after its committed terminal publication, never infer success locally.
        const committedTerminal =
          event.publicationOwner === 'main' &&
          (event.kind === 'stop' || event.kind === 'error') &&
          event.terminalScope !== undefined
        if ((!event.terminalCommitFailure && !committedTerminal) || seen.has(event.id)) return false
        seen.add(event.id)
        return true
      })
      if (changed) void refreshTerminalWriteFailures().catch(reportPersistenceError)
    }
    void refreshTerminalWriteFailures().catch(reportPersistenceError)
    const removeEvent = window.api.acp?.onEvent?.(observe)
    const removeState = window.api.acp?.onState?.((snapshot) => observe(snapshot.events ?? []))
    return () => {
      mounted = false
      terminalObserverMounted.current = false
      terminalFailureQuery.current += 1
      removeEvent?.()
      removeState?.()
    }
  }, [refreshTerminalWriteFailures])
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
  const dismissWriteWarning = useCallback(() => {
    const issues = new Map(
      [...liveSessionPersistence.recovery.getSnapshot(), ...terminalWriteIssues].map((issue) => [
        issue.target,
        issue
      ])
    )
    for (const issue of issues.values())
      reportSessionWriteIssue(issue, { event: 'warning-dismissed' })
    setWriteError(undefined)
  }, [terminalWriteIssues])
  const dismissLoadWarning = useCallback(() => setLoadWarning(undefined), [])
  const startNewConversationAfterSizeLimit = useCallback(() => {
    for (const target of sizeLimitTargets.current) {
      abandonedSizeLimitTargets.current.add(target)
      failedWriteTargets.current.delete(target)
      failedConflictRebaseFields.current.delete(target)
      revisionConflictTargets.current.delete(target)
      unresolvedSessionRevisionConflictTargets.delete(target)
      liveSessionPersistence.clearWriteFailure(target)
      liveSessionPersistence.recovery.forget(target)
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
    // A failed refresh must not hide an already loaded snapshot or its recovery actions. Mutation
    // gates still close until an authoritative reload succeeds; first-load hydration stays false.
    setIsLoading(true)
    setIsReady(false)
    setHasCompleteSessionCatalog(false)
    setCanDeleteSessionsAndProjects(false)
    setLoadError(undefined)
    setLoadWarning(undefined)
    setWriteError(undefined)
    setWriteErrorRetryable(true)
    sizeLimitTargets.current.clear()
    setPersistenceBlockedSessionIds([])
    setLoadAttempt((attempt) => attempt + 1)
  }, [isHydrated])
  const retryWrites = useCallback(() => {
    const retained = liveSessionPersistence.recovery
      .getSnapshot()
      .filter(
        ({ target, state, kind }) =>
          state === 'failed' &&
          kind !== 'size-limit' &&
          liveSessionPersistence.recovery.get(target)?.reviewRequired
      )
    if (retained.length > 0) {
      if (retryingTargets.current.size > 0) return
      for (const { target } of retained) retryingTargets.current.add(target)
      setIsRetryingWrites(true)
      void (async () => {
        for (const { target } of retained) {
          const write = liveSessionPersistence.recovery.get(target)
          if (!write) continue
          reportSessionWriteRecovery(write, { event: 'retry-started' })
          if (!desktopRuntimeWritable()) {
            reportSessionWriteRecovery(write, { event: 'retry-skipped', reason: 'runtime-changed' })
            continue
          }
          let reason: RendererSessionWriteRecoveryDiagnostics['reason']
          let actualRevision: number | undefined
          try {
            if (write.manifest) {
              await liveSessionPersistence.saveManifest(write.manifest)
              continue
            }
            const intent = write.intent
            if (!intent) throw new SessionWriteUnconfirmedError()
            const authority = await loadPersistedSession(
              {
                projectId: intent.session.projectId,
                sessionId: intent.session.id
              },
              undefined,
              { bypassCache: true }
            )
            actualRevision = authority?.revision
            if (
              liveSessionPersistence.recovery.get(target) !== write ||
              !desktopRuntimeWritable()
            ) {
              reportSessionWriteRecovery(write, {
                event: 'retry-skipped',
                reason: !desktopRuntimeWritable() ? 'runtime-changed' : 'write-replaced'
              })
              continue
            }
            if (authority && isSessionWriteSatisfied(intent, authority)) {
              acknowledgeSessionConversationCommands(authority)
              liveSessionPersistence.recovery.clear(target, write, {
                reason: 'authority-confirmed',
                ...(actualRevision !== undefined ? { actualRevision } : {})
              })
              liveSessionPersistence.clearWriteFailure(target)
              continue
            }
            // Missing bounded command receipts are not evidence that a command did not run.
            if (intent.options?.conversationCommands?.length) {
              reason = 'missing-command-receipts'
              throw new SessionWriteUnconfirmedError()
            }
            if (!authority && intent.base) {
              reason = 'session-missing'
              throw new SessionWriteUnconfirmedError()
            }
            let candidate =
              authority && intent.base
                ? rebaseSessionAfterRevisionConflict(intent.base, intent.session, authority)
                : authority
                  ? undefined
                  : intent.session
            if (authority?.runtimeTranscriptOwner === 'main' && intent.base) {
              candidate = structuredClone(authority)
              for (const key of sessionIntentFields(intent)) {
                if (
                  !sessionFieldValuesEqual(key, authority[key], intent.session[key]) &&
                  !sessionFieldValuesEqual(key, authority[key], intent.base[key])
                ) {
                  candidate = undefined
                  break
                }
                Object.assign(candidate, { [key]: structuredClone(intent.session[key]) })
              }
            }
            if (!candidate)
              throw new SessionRevisionConflictError(
                sessionRevision(intent.base ?? intent.session),
                sessionRevision(authority ?? intent.session)
              )
            const durable = await liveSessionPersistence.saveSession(candidate, {
              ...intent.options,
              expectedRevision: authority ? sessionRevision(authority) : 0
            })
            const current = useSessionStore.getState().sessions.find(({ id }) => id === durable.id)
            if (current)
              useSessionStore.getState().applyDurableSessionProjection({
                source: current,
                session: durable,
                mode: 'replace-persisted-if-current'
              })
          } catch (error) {
            reportSessionWriteRecovery(
              { ...write, error },
              {
                event: 'retry-failed',
                ...(reason ? { reason } : {}),
                ...(actualRevision !== undefined ? { actualRevision } : {})
              }
            )
            liveSessionPersistence.recovery.fail(target, error, write)
            reportPersistenceError(
              error,
              'session-save',
              write.intent
                ? { sessionId: write.intent.session.id, projectId: write.intent.session.projectId }
                : {}
            )
          }
        }
        presentOutstandingWriteFailures()
      })()
        .catch(reportPersistenceError)
        .finally(() => {
          for (const { target } of retained) retryingTargets.current.delete(target)
          setIsRetryingWrites(false)
        })
    }
    const terminalFailures = [...terminalWriteFailures.current.values()]
    if (terminalFailures.some((event) => event.terminalCommitFailure === 'storage')) {
      void (async () => {
        for (const event of terminalFailures) {
          if (
            event.terminalCommitFailure !== 'storage' ||
            !event.terminalScope ||
            !event.sessionId ||
            !event.promptMessageId
          )
            continue
          try {
            await window.api.sessions.retryRuntimeTerminalCommit({
              projectId: event.terminalScope.projectId,
              sessionId: event.sessionId,
              promptMessageId: event.promptMessageId,
              executionId: event.terminalScope.executionId
            })
          } catch (error) {
            reportPersistenceError(error)
          }
        }
        await refreshTerminalWriteFailures()
      })().catch(reportPersistenceError)
    }
    if (
      [...revisionConflictTargets.current].some(
        (target) => !liveSessionPersistence.recovery.has(target)
      )
    ) {
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

    const forceTargets = new Set(
      [...failedWriteTargets.current].filter(
        (target) =>
          !sizeLimitTargets.current.has(target) &&
          !liveSessionPersistence.recovery.get(target)?.reviewRequired
      )
    )
    if (forceTargets.size === 0) return
    void saver(state, {
      forceTargets,
      conflictRebaseFieldsByTarget: new Map(failedConflictRebaseFields.current)
    }).catch(reportPersistenceError)
  }, [presentOutstandingWriteFailures, refreshTerminalWriteFailures, retryLoad])

  const discardWrite = useCallback(
    async (target: string): Promise<void> => {
      const write = liveSessionPersistence.recovery.get(target)
      if (!write?.intent || write.state === 'checking' || retryingTargets.current.has(target))
        throw new SessionWriteUnconfirmedError()
      reportSessionWriteRecovery(write, { event: 'discard-started' })
      try {
        const { session } = write.intent
        const authority = await loadPersistedSession(
          { projectId: session.projectId, sessionId: session.id },
          undefined,
          { bypassCache: true }
        )
        if (liveSessionPersistence.recovery.get(target) !== write || !desktopRuntimeWritable())
          throw new SessionWriteUnconfirmedError()
        discardSessionConversationIntents(session.id)
        const source = useSessionStore.getState().sessions.find(({ id }) => id === session.id)
        if (source && authority) {
          useSessionStore.getState().applyDurableSessionProjection({
            source,
            session: authority,
            mode: 'replace-persisted-if-current'
          })
        } else if (source) {
          useSessionStore.getState().deleteSession(session.id)
        }
        liveSessionPersistence.recovery.forget(target, 'explicit-discard')
        liveSessionPersistence.clearWriteFailure(target)
        failedWriteTargets.current.delete(target)
        failedConflictRebaseFields.current.delete(target)
        revisionConflictTargets.current.delete(target)
        unresolvedSessionRevisionConflictTargets.delete(target)
        sizeLimitTargets.current.delete(target)
        abandonedSizeLimitTargets.current.delete(target)
        presentOutstandingWriteFailures()
      } catch (error) {
        reportSessionWriteRecovery({ ...write, error }, { event: 'discard-failed' })
        throw error
      }
    },
    [presentOutstandingWriteFailures]
  )

  useEffect(() => {
    const recovery = useDesktopRuntimeRecoveryStore.getState()
    if (recoveryLoadEpoch < 0) {
      liveSessionPersistence.seedAcknowledgedSessions([])
      return
    }
    const recovering = recovery.epoch > 0
    let isMounted = true
    let unsubscribe: (() => void) | undefined
    let activeSaver: StoreSaver | undefined
    saverRef.current = undefined
    const manifestWriteFailed = failedWriteTargets.current.has('manifest')
    failedWriteTargets.current.clear()
    if (manifestWriteFailed || retryManifestWritePending.current)
      failedWriteTargets.current.add('manifest')
    failedConflictRebaseFields.current.clear()
    sizeLimitTargets.current.clear()

    // Loads before subscribing so the initial empty store cannot overwrite disk state.
    const startPersistence = async (): Promise<void> => {
      const preferredSelection = recovering
        ? { sessionId: useSessionStore.getState().selectedSessionId }
        : retrySelection.current
      try {
        if (recovering) {
          // Let old requests settle into the retained registry before replacing their projection.
          await liveSessionPersistence.flush().catch(() => undefined)
          if (!isMounted) return
        }
        const result = await loadPersistedSessions(
          window.api.sessions,
          () => isMounted,
          preferredSelection === undefined
            ? undefined
            : () => ({ sessionId: useSessionStore.getState().selectedSessionId }),
          recovering || liveSessionPersistence.recovery.getSnapshot().length > 0,
          new Set(
            liveSessionPersistence.recovery
              .getSnapshot()
              .flatMap(({ target, sessionId }) =>
                sessionId && !liveSessionPersistence.recovery.get(target)?.intent?.base
                  ? [sessionId]
                  : []
              )
          )
        )
        if (!result || !isMounted) return
        if (recovering || liveSessionPersistence.recovery.getSnapshot().length > 0) {
          await liveSessionPersistence.recovery.reconcile(
            ({ session }) =>
              loadPersistedSession(
                { projectId: session.projectId, sessionId: session.id },
                undefined,
                { bypassCache: true }
              ),
            { lastSessionId: result.manifest.lastSessionId },
            () => isMounted
          )
          if (!isMounted) return
          presentOutstandingWriteFailures()
        }
        unresolvedSessionRevisionConflictTargets.clear()
        revisionConflictTargets.current.clear()
        setIsHydrated(true)
        setLoadError(undefined)
        setLoadWarning(undefined)
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
          setIsReady(false)
          setLoadError(
            result.diagnostics.failure === 'startup-reconciliation-failed'
              ? 'Saved conversations loaded, but storage recovery could not finish. Retry before creating or saving conversations.'
              : 'Some saved conversations could not be read. Retry before creating or saving conversations.'
          )
          setIsLoading(false)
          // Transport recovered; the existing storage notice and write gates own this failure.
          if (recovering) completeDesktopSessionRecovery(recovery.epoch, true)
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
        if (recovering) completeDesktopSessionRecovery(recovery.epoch, false)
        reportPersistenceError(error, 'session-load')
        if (isMounted) {
          setHasCompleteSessionCatalog(false)
          setCanDeleteSessionsAndProjects(false)
          setLoadError(SAFE_SESSION_LOAD_ERROR)
          setIsLoading(false)
        }
        return
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
            if (liveSessionPersistence.recovery.has(target)) {
              presentOutstandingWriteFailures()
              return
            }
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
            }
            if (removedFailedTarget) presentOutstandingWriteFailures()
          }
        },
        liveSessionPersistence
      )
      activeSaver = save
      saverRef.current = save
      let observedSessionIds = new Set(useSessionStore.getState().sessions.map(({ id }) => id))
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

      const onStoreChange = (state: ReturnType<typeof useSessionStore.getState>): void => {
        const nextIds = new Set(state.sessions.map(({ id }) => id))
        for (const id of observedSessionIds) {
          if (!nextIds.has(id)) liveSessionPersistence.recovery.forget(`session:${id}`)
        }
        observedSessionIds = nextIds
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
      }
      unsubscribe = useSessionStore.subscribe((state) => {
        if (desktopRuntimeWritable()) onStoreChange(state)
      })
      // Navigation may change while the retry hydrates another Session's body. That selection
      // happened before this subscription, so start its lazy read without waiting for another edit.
      if (preferredSelection !== undefined) onStoreChange(useSessionStore.getState())

      // Hydration intentionally uses the user's live selection instead of the older disk manifest
      // on retry. Force that tri-state selection (including an explicit empty selection) back to
      // disk before declaring persistence ready, because the saver baseline already contains it.
      if (preferredSelection !== undefined && !recovering) {
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
      // A successful authoritative read releases this transport epoch. A manifest write still
      // owns its storage gate and explicit retry even though the backend connection recovered.
      if (recovering) completeDesktopSessionRecovery(recovery.epoch, true)
      if (retryManifestWritePending.current) {
        presentOutstandingWriteFailures()
        return
      }
      setIsReady(true)
    }

    void startPersistence()

    return () => {
      isMounted = false
      if (saverRef.current === activeSaver) saverRef.current = undefined
      unsubscribe?.()
    }
  }, [loadAttempt, presentOutstandingWriteFailures, recoveryLoadEpoch])

  return {
    isHydrated,
    isLoading,
    isReady: isReady && recovery.phase === 'connected',
    hasCompleteSessionCatalog,
    catalogRecovery,
    canDeleteSessionsAndProjects,
    loadError,
    loadWarning,
    writeError,
    writeErrorRetryable,
    isCheckingWrites: retainedWriteIssues.some(({ state }) => state === 'checking'),
    isRetryingWrites,
    writeIssues: [...retainedWriteIssues, ...terminalWriteIssues].filter(
      (issue, index, all) => all.findIndex(({ target }) => target === issue.target) === index
    ),
    persistenceBlockedSessionIds: [
      ...new Set([
        ...persistenceBlockedSessionIds,
        ...retainedWriteIssues.flatMap(({ sessionId, kind, reviewRequired }) =>
          sessionId && (kind === 'size-limit' || reviewRequired) ? [sessionId] : []
        )
      ])
    ],
    reportSessionSizeLimit,
    reviewWriteIssues: presentOutstandingWriteFailures,
    dismissLoadWarning,
    dismissWriteWarning,
    startNewConversationAfterSizeLimit,
    retryLoad,
    retryWrites,
    discardWrite
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
  retryPendingArtifactFinalization,
  resetSessionContentCacheForTests,
  resetSessionPersistenceWriteFailuresForTests,
  deriveSessionCatalogRecovery,
  deleteSession,
  saveSessionInOrder,
  saveSessionFieldsInOrder,
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
