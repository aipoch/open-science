import {
  projectConversationMessage,
  resolveActiveConversationActivities,
  resolveActiveConversationMessages
} from './conversation-graph'
import { sessionRevision, type PersistedChatSession } from './session-persistence'

const MAIN_OWNED_SESSION_FIELDS = new Set<keyof PersistedChatSession>([
  'revision',
  'taskRunCommitId',
  'taskRunCommitRun',
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
const rebaseMessageCollection = <Item extends { id: string }>(
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

export const projectsCommittedTaskRun = (
  submitted: PersistedChatSession,
  latest: PersistedChatSession
): boolean =>
  Boolean(
    latest.taskRunCommitId &&
    latest.taskRunCommitRun &&
    !latest.activeRun &&
    submitted.activeRun?.promptMessageId === latest.taskRunCommitRun.promptMessageId &&
    submitted.activeRun?.startedAt === latest.taskRunCommitRun.startedAt
  )

export const rebaseSessionAfterRevisionConflict = (
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
  const committedRun = projectsCommittedTaskRun(submitted, latest)
  const mainOwnsStatus =
    committedRun ||
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
      (key === 'status' && mainOwnsStatus) ||
      (committedRun && (key === 'activeRun' || key === 'error' || key === 'errorReportable'))
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
      } else if (key === 'artifacts') {
        const artifacts = rebaseMessageCollection(
          (baseValue as PersistedChatSession['artifacts']) ?? [],
          (submittedValue as PersistedChatSession['artifacts']) ?? [],
          (latestValue as PersistedChatSession['artifacts']) ?? []
        )
        if (!artifacts) return undefined
        rebased.artifacts = artifacts
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
