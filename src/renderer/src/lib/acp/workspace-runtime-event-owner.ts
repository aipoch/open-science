import {
  ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_REARM_FAILED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE,
  MAX_ACP_RUNTIME_EVENTS,
  isDurableAgentUserChoiceRequest,
  type AcpConnectionStatus,
  type AcpContextUsage,
  type AcpPermissionRequest,
  type AcpRuntimeEvent,
  type AcpSessionAgentTarget,
  type AcpStateSnapshot,
  type PendingElicitationRequest
} from '../../../../shared/acp'
import { useCallback, useEffect, useRef } from 'react'
import type { HistoryReplayDescriptor } from '../../../../shared/history-preamble'
import { useSessionStore } from '../../stores/session-store'
import {
  acceptAcpRuntimeSnapshotRevision,
  resetAcpRuntimeSnapshotRevisionForTests
} from './runtime-snapshot-revision-owner'
import { isBufferableAssistantTextEvent } from './chat-events'
import { applyWorkspaceRuntimeEvent, applyWorkspaceRuntimeEventBatch } from './workspace-events'
import {
  createWorkspaceRuntimePresentationBuffer,
  liveWorkspaceRuntimePresentation,
  type WorkspacePresentationLane,
  type WorkspaceRuntimePresentation
} from './workspace-runtime-presentation-buffer'

// Snapshot projections retain only transition edges; durable chat facts remain in Session Store.
const pendingPermissionSessionIds = new Set<string>()
const pendingElicitationSessionIds = new Set<string>()
const firstOutputWaitingSessionIds = new Set<string>()

type RuntimeEventApplier = (event: AcpRuntimeEvent) => Promise<boolean>
type RuntimeEventBatchApplier = (events: AcpRuntimeEvent[]) => Promise<boolean>
type WorkspaceRuntimeEventProcessorOptions = {
  applyEventBatch?: RuntimeEventBatchApplier
  presentation?: WorkspaceRuntimePresentation
}
type WorkspacePermissionLifecycleEvent = AcpRuntimeEvent & { permissionRequestId: string }
type WorkspacePermissionLifecycleObserver = {
  shouldApply: (event: WorkspacePermissionLifecycleEvent) => boolean
  onApplied: (event: WorkspacePermissionLifecycleEvent) => void
}

type WorkspaceRuntimeEventProcessor = {
  process: (events: AcpRuntimeEvent[]) => Promise<void>
  processIncremental: (events: readonly AcpRuntimeEvent[]) => Promise<void>
  drain: (sessionId?: string) => Promise<void>
}
type WorkspaceRuntimeEventSnapshot = Pick<
  AcpStateSnapshot,
  'agentPromptInFlightSessionIds' | 'events' | 'revision'
>

const processVisibleWorkspaceRuntimeEvents = async (
  events: AcpRuntimeEvent[],
  processedEventIds: Set<string>,
  applyEvent: RuntimeEventApplier = applyWorkspaceRuntimeEvent,
  processingEventIds = new Set<string>(),
  options: {
    applyEventBatch?: RuntimeEventBatchApplier
    retainedEvents?: AcpRuntimeEvent[]
  } = {}
): Promise<void> => {
  // Runtime snapshots are bounded, so forget ids that can no longer be replayed from the source list.
  const visibleEventIds = new Set((options.retainedEvents ?? events).map((event) => event.id))

  for (const eventId of processedEventIds) {
    if (!visibleEventIds.has(eventId)) processedEventIds.delete(eventId)
  }

  for (const eventId of processingEventIds) {
    if (!visibleEventIds.has(eventId)) processingEventIds.delete(eventId)
  }

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (processedEventIds.has(event.id) || processingEventIds.has(event.id)) continue

    const batch = [event]
    if (options.applyEventBatch && isBufferableAssistantTextEvent(event)) {
      for (let candidateIndex = index + 1; candidateIndex < events.length; candidateIndex += 1) {
        const candidate = events[candidateIndex]
        if (!isBufferableAssistantTextEvent(candidate) || candidate.sessionId !== event.sessionId) {
          break
        }
        index = candidateIndex
        if (!processedEventIds.has(candidate.id) && !processingEventIds.has(candidate.id)) {
          batch.push(candidate)
        }
      }
    }

    for (const candidate of batch) processingEventIds.add(candidate.id)
    try {
      // Apply visible events sequentially so message chunks and artifact finalization stay ordered.
      if (batch.length > 1 && options.applyEventBatch) {
        await options.applyEventBatch(batch)
      } else {
        await applyEvent(event)
      }
      for (const candidate of batch) processedEventIds.add(candidate.id)
    } catch {
      // Artifact finalization errors are recorded by the adapter before throwing.
      // Keeping this id unprocessed lets the same visible runtime event retry.
      continue
    } finally {
      for (const candidate of batch) processingEventIds.delete(candidate.id)
    }
  }
}

const createWorkspaceRuntimeEventProcessor = (
  applyEvent: RuntimeEventApplier = applyWorkspaceRuntimeEvent,
  options: WorkspaceRuntimeEventProcessorOptions = {}
): WorkspaceRuntimeEventProcessor => {
  type EventLane = {
    acceptedEvents: Map<string, AcpRuntimeEvent>
    failedEventIds: Set<string>
    processedEventIds: Set<string>
    processingEventIds: Set<string>
    drainInFlight?: Promise<void>
    drainAgain: boolean
    presentation: WorkspacePresentationLane
  }

  const unscopedEventLane = Symbol('unscoped-workspace-runtime-events')
  const eventLanes = new Map<string | symbol, EventLane>()
  const presentationBuffer = createWorkspaceRuntimePresentationBuffer(options.presentation)
  let latestEventsById = new Map<string, AcpRuntimeEvent>()
  let acceptedEventVersion = 0

  const getEventLaneKey = (event: AcpRuntimeEvent): string | symbol =>
    event.sessionId ?? unscopedEventLane

  const getEventLane = (laneKey: string | symbol): EventLane => {
    let lane = eventLanes.get(laneKey)
    if (!lane) {
      lane = {
        acceptedEvents: new Map<string, AcpRuntimeEvent>(),
        failedEventIds: new Set<string>(),
        processedEventIds: new Set<string>(),
        processingEventIds: new Set<string>(),
        drainAgain: false,
        presentation: presentationBuffer.createLane()
      }
      eventLanes.set(laneKey, lane)
    }

    return lane
  }

  const releaseProcessedEvent = (lane: EventLane, eventId: string): void => {
    if (latestEventsById.has(eventId) || !lane.processedEventIds.has(eventId)) return
    lane.acceptedEvents.delete(eventId)
    lane.failedEventIds.delete(eventId)
    lane.processedEventIds.delete(eventId)
    lane.processingEventIds.delete(eventId)
  }

  const cleanEventLane = (laneKey: string | symbol, lane: EventLane): void => {
    for (const eventId of lane.acceptedEvents.keys()) releaseProcessedEvent(lane, eventId)
    if (lane.acceptedEvents.size === 0 && !lane.drainInFlight) eventLanes.delete(laneKey)
  }

  const releaseEvictedEvent = (event: AcpRuntimeEvent): void => {
    const laneKey = getEventLaneKey(event)
    const lane = eventLanes.get(laneKey)
    if (!lane) return
    releaseProcessedEvent(lane, event.id)
    if (lane.acceptedEvents.size === 0 && !lane.drainInFlight) eventLanes.delete(laneKey)
  }

  const pendingLaneEvents = (lane: EventLane): AcpRuntimeEvent[] =>
    [...lane.acceptedEvents.values()].filter(
      (event) => !lane.processedEventIds.has(event.id) && !lane.processingEventIds.has(event.id)
    )

  const drainLane = async (laneKey: string | symbol): Promise<void> => {
    const lane = getEventLane(laneKey)

    if (lane.drainInFlight) {
      lane.drainAgain = true
      return lane.drainInFlight
    }

    lane.drainInFlight = (async () => {
      do {
        lane.drainAgain = false
        const pendingBeforeWait = pendingLaneEvents(lane)
        await presentationBuffer.prepare(lane.presentation, pendingBeforeWait)
        const selectedEvents = presentationBuffer.select(lane.presentation, pendingLaneEvents(lane))
        if (selectedEvents.length === 0) continue

        await processVisibleWorkspaceRuntimeEvents(
          selectedEvents,
          lane.processedEventIds,
          async (event) => {
            const hadFailed = lane.failedEventIds.has(event.id)
            try {
              const applied = await applyEvent(event)
              lane.failedEventIds.delete(event.id)
              return applied
            } catch (error) {
              const isVisible = latestEventsById.has(event.id)
              if (hadFailed && !isVisible) {
                lane.acceptedEvents.delete(event.id)
                lane.failedEventIds.delete(event.id)
              } else {
                lane.failedEventIds.add(event.id)
              }
              throw error
            }
          },
          lane.processingEventIds,
          {
            applyEventBatch: options.applyEventBatch,
            retainedEvents: [...lane.acceptedEvents.values()]
          }
        )
        const madeProgress = selectedEvents.some((event) => lane.processedEventIds.has(event.id))
        for (const event of selectedEvents) releaseProcessedEvent(lane, event.id)
        const hasPending = pendingLaneEvents(lane).length > 0
        if (madeProgress) {
          presentationBuffer.recordProgress(lane.presentation, selectedEvents, hasPending)
          if (hasPending) lane.drainAgain = true
        }
      } while (lane.drainAgain)
    })()

    try {
      await lane.drainInFlight
    } finally {
      lane.drainInFlight = undefined
      if (lane.acceptedEvents.size === 0) eventLanes.delete(laneKey)
    }
  }

  const acceptEvents = (
    events: readonly AcpRuntimeEvent[],
    replaceLatestEvents: boolean
  ): Promise<void> => {
    const evictedEvents: AcpRuntimeEvent[] = []
    if (replaceLatestEvents) {
      latestEventsById = new Map(events.map((event) => [event.id, event]))
    } else {
      for (const event of events) {
        if (!latestEventsById.has(event.id)) {
          latestEventsById.set(event.id, event)
        }
      }
      while (latestEventsById.size > MAX_ACP_RUNTIME_EVENTS) {
        const oldest = latestEventsById.entries().next().value as
          [string, AcpRuntimeEvent] | undefined
        if (!oldest) break
        latestEventsById.delete(oldest[0])
        evictedEvents.push(oldest[1])
      }
    }
    const visibleLaneKeys = new Set<string | symbol>()

    for (const event of events) {
      const laneKey = getEventLaneKey(event)
      const lane = getEventLane(laneKey)
      visibleLaneKeys.add(laneKey)

      if (
        !lane.processedEventIds.has(event.id) &&
        !lane.processingEventIds.has(event.id) &&
        !lane.acceptedEvents.has(event.id)
      ) {
        // A bounded source snapshot may evict this event before a slow predecessor finishes.
        lane.acceptedEvents.set(event.id, event)
        acceptedEventVersion += 1
        presentationBuffer.forceOnAccepted(lane.presentation, event)
      }
    }

    // Keep processed markers through admission so an oversized batch cannot re-admit an event that
    // this same retention update evicted. Once every batch item has been classified, targeted cleanup
    // can safely release the evicted lane state.
    for (const event of evictedEvents) releaseEvictedEvent(event)

    if (replaceLatestEvents) {
      for (const [laneKey, lane] of eventLanes) cleanEventLane(laneKey, lane)
    }

    const drains = [...visibleLaneKeys].map((laneKey) => drainLane(laneKey))
    for (const [laneKey, lane] of eventLanes) {
      if (!visibleLaneKeys.has(laneKey) && lane.acceptedEvents.size > 0) void drainLane(laneKey)
    }

    return Promise.all(drains).then(() => undefined)
  }

  return {
    process: (events) => acceptEvents(events, true),
    processIncremental: (events) => acceptEvents(events, false),
    drain: async (sessionId) => {
      if (sessionId !== undefined) {
        const lane = eventLanes.get(sessionId)
        if (lane) {
          presentationBuffer.force(lane.presentation)
          await drainLane(sessionId)
        }
        return
      }

      let drainedVersion: number
      do {
        drainedVersion = acceptedEventVersion
        for (const lane of eventLanes.values()) {
          presentationBuffer.force(lane.presentation)
        }
        await Promise.all([...eventLanes.keys()].map((laneKey) => drainLane(laneKey)))
      } while (drainedVersion !== acceptedEventVersion)
    }
  }
}

const permissionLifecycleEventTitles = new Set([
  ACP_RESTORED_PERMISSION_REARMED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_SETTLED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_CLEAR_FAILED_EVENT_TITLE,
  ACP_RESTORED_PERMISSION_REARM_FAILED_EVENT_TITLE
])
const permissionLifecycleObservers = new Set<WorkspacePermissionLifecycleObserver>()

const isWorkspacePermissionLifecycleEvent = (
  event: AcpRuntimeEvent
): event is AcpRuntimeEvent & { permissionRequestId: string } =>
  event.kind === 'permission' &&
  typeof event.permissionRequestId === 'string' &&
  permissionLifecycleEventTitles.has(event.title ?? '')

const subscribeWorkspacePermissionLifecycle = (
  observer: WorkspacePermissionLifecycleObserver
): (() => void) => {
  permissionLifecycleObservers.add(observer)
  return () => permissionLifecycleObservers.delete(observer)
}

const liveWorkspaceRuntimeEventProcessor = createWorkspaceRuntimeEventProcessor(
  async (event) => {
    const permissionLifecycleEvent = isWorkspacePermissionLifecycleEvent(event) ? event : undefined
    if (
      permissionLifecycleEvent &&
      [...permissionLifecycleObservers].some(
        (observer) => !observer.shouldApply(permissionLifecycleEvent)
      )
    ) {
      return true
    }
    const applied = await applyWorkspaceRuntimeEvent(event)
    if (applied && permissionLifecycleEvent) {
      for (const observer of permissionLifecycleObservers) {
        observer.onApplied(permissionLifecycleEvent)
      }
    }
    return applied
  },
  {
    applyEventBatch: applyWorkspaceRuntimeEventBatch,
    presentation: liveWorkspaceRuntimePresentation
  }
)

// Projects runtime foreground ownership and its initial silent gap into renderer-only state. Unknown
// ids belong to background/runtime-only sessions; repeated snapshots must not restart the gap timer.
const syncWorkspaceAgentFirstOutputState = (sessionIds: string[]): void => {
  const nextSessionIds = new Set(sessionIds)
  const store = useSessionStore.getState()
  const workspaceSessionIds = new Set(store.sessions.map((session) => session.id))

  for (const sessionId of nextSessionIds) {
    if (!workspaceSessionIds.has(sessionId) || firstOutputWaitingSessionIds.has(sessionId)) continue
    store.setAgentPromptInFlight(sessionId, true)
    store.setAwaitingFirstAgentOutput(sessionId, true)
    firstOutputWaitingSessionIds.add(sessionId)
  }

  for (const sessionId of firstOutputWaitingSessionIds) {
    if (nextSessionIds.has(sessionId)) continue
    store.setAgentPromptInFlight(sessionId, false)
    store.setAwaitingFirstAgentOutput(sessionId, false)
    firstOutputWaitingSessionIds.delete(sessionId)
  }
}

// Keeps store permission state aligned with the runtime's current pending request set.
const syncWorkspacePermissionState = (requests: AcpPermissionRequest[]): void => {
  const nextSessionIds = new Set(requests.map((request) => request.sessionId))
  const store = useSessionStore.getState()
  for (const session of store.sessions) {
    if (session.runtimeContext?.permission?.state === 'pending') {
      nextSessionIds.add(session.id)
    }
  }

  for (const sessionId of nextSessionIds) {
    store.setPermissionPending(sessionId)
  }

  for (const sessionId of pendingPermissionSessionIds) {
    if (!nextSessionIds.has(sessionId)) store.clearPermissionPending(sessionId)
  }

  pendingPermissionSessionIds.clear()
  for (const sessionId of nextSessionIds) pendingPermissionSessionIds.add(sessionId)
}

// Keeps Session status aligned with app-owned questions independently of Agent execution state.
// A Session already waiting on a durable question remains authoritative while its runtime is
// detached; requiring the waiting status prevents a stale pending activity from re-arming after
// its answer has synchronously returned the Session to running.
const syncWorkspaceElicitationState = (requests: PendingElicitationRequest[]): void => {
  const store = useSessionStore.getState()
  const nextSessionIds = new Set(
    requests.filter(isDurableAgentUserChoiceRequest).map((request) => request.sessionId)
  )
  for (const session of store.sessions) {
    if (
      (session.status === 'waiting-for-user' || session.status === 'waiting-permission') &&
      session.interactionState?.elicitation !== false &&
      session.activities?.some(
        (activity) =>
          activity.elicitation?.state === 'pending' &&
          activity.elicitation.durable?.kind === 'agent-user-choice'
      )
    ) {
      nextSessionIds.add(session.id)
    }
  }

  for (const sessionId of nextSessionIds) {
    store.setElicitationPending(sessionId, true)
  }

  for (const sessionId of pendingElicitationSessionIds) {
    if (!nextSessionIds.has(sessionId)) store.setElicitationPending(sessionId, false)
  }

  pendingElicitationSessionIds.clear()
  for (const sessionId of nextSessionIds) pendingElicitationSessionIds.add(sessionId)
}

const syncWorkspaceInteractionState = (
  snapshot: Pick<
    AcpStateSnapshot,
    'agentPromptInFlightSessionIds' | 'pendingElicitations' | 'pendingPermissions'
  >
): void => {
  syncWorkspaceAgentFirstOutputState(snapshot.agentPromptInFlightSessionIds ?? [])
  syncWorkspaceElicitationState(snapshot.pendingElicitations ?? [])
  syncWorkspacePermissionState(snapshot.pendingPermissions)
}

const resetWorkspaceRuntimeEventOwnerForTests = (): void => {
  pendingPermissionSessionIds.clear()
  pendingElicitationSessionIds.clear()
  firstOutputWaitingSessionIds.clear()
  resetAcpRuntimeSnapshotRevisionForTests()
}

// Accepts Main snapshots once in construction order. This gate is shared by React subscription and
// quit-persistence pulls so a delayed older snapshot cannot replay stale lifecycle authority.
const acceptWorkspaceRuntimeSnapshot = (snapshot: Pick<AcpStateSnapshot, 'revision'>): boolean => {
  return acceptAcpRuntimeSnapshotRevision(snapshot)
}

const ingestWorkspaceRuntimeSnapshot = async (
  snapshot: WorkspaceRuntimeEventSnapshot,
  syncFirstOutput: boolean
): Promise<boolean> => {
  if (!acceptWorkspaceRuntimeSnapshot(snapshot)) return false
  if (syncFirstOutput) {
    syncWorkspaceAgentFirstOutputState(snapshot.agentPromptInFlightSessionIds ?? [])
  }
  await liveWorkspaceRuntimeEventProcessor.process(snapshot.events)
  return true
}

// Publishes prompt ownership before applying the same snapshot's events so first output can only
// clear, never re-arm, the renderer waiting state.
const processWorkspaceRuntimeEvents = (snapshot: WorkspaceRuntimeEventSnapshot): Promise<boolean> =>
  ingestWorkspaceRuntimeSnapshot(snapshot, true)

// Accepts live IPC events immediately, outside React state. The processor copies each event into
// its per-session lane before returning, so later snapshot-window eviction cannot drop a prefix
// while asynchronous presentation or persistence is still draining.
const processIncrementalWorkspaceRuntimeEvents = (
  events: readonly AcpRuntimeEvent[]
): Promise<void> => liveWorkspaceRuntimeEventProcessor.processIncremental(events)

type WorkspaceRuntimeEventIngestRuntime = {
  state: AcpStateSnapshot
  subscribeRuntimeEvents?: (
    listener: (events: readonly AcpRuntimeEvent[], snapshot?: AcpStateSnapshot) => void
  ) => () => void
}
type WorkspaceRuntimeEventLifecycleOptions = {
  supportsImageRelay?: boolean
  getAgentTarget: (sessionId: string) => AcpSessionAgentTarget | undefined
  getSupportsImageInput: (sessionId: string) => boolean | undefined
  getHistoryReplayDescriptor: (sessionId: string) => HistoryReplayDescriptor
}
const EMPTY_AGENT_PROMPT_IN_FLIGHT_SESSION_IDS: string[] = []

// Characterization fixtures can still present the legacy snapshot-only seam. Production
// useAcpRuntime always supplies this subscription, including when an older Main lacks onEvent.
const useWorkspaceRuntimeEventIngest = <Runtime extends WorkspaceRuntimeEventIngestRuntime>(
  runtime: Runtime,
  processLifecycleEvents: (
    runtime: Runtime,
    events: AcpRuntimeEvent[],
    options: WorkspaceRuntimeEventLifecycleOptions
  ) => void,
  supportsImageRelay: boolean | undefined,
  getAgentTarget: (sessionId: string) => AcpSessionAgentTarget | undefined,
  getSupportsImageInput: (sessionId: string) => boolean | undefined,
  getHistoryReplayDescriptor: (sessionId: string) => HistoryReplayDescriptor
): boolean => {
  const subscribeRuntimeEvents = runtime.subscribeRuntimeEvents
  const runtimeRef = useRef(runtime)
  const optionsRef = useRef({
    supportsImageRelay,
    getAgentTarget,
    getSupportsImageInput,
    getHistoryReplayDescriptor
  })
  const agentPromptInFlightSessionIds =
    runtime.state.agentPromptInFlightSessionIds ?? EMPTY_AGENT_PROMPT_IN_FLIGHT_SESSION_IDS

  useEffect(() => {
    runtimeRef.current = runtime
    optionsRef.current = {
      supportsImageRelay,
      getAgentTarget,
      getSupportsImageInput,
      getHistoryReplayDescriptor
    }
  }, [
    getAgentTarget,
    getHistoryReplayDescriptor,
    getSupportsImageInput,
    runtime,
    supportsImageRelay
  ])

  useEffect(() => {
    if (!subscribeRuntimeEvents) return
    return subscribeRuntimeEvents((events, snapshot) => {
      const currentRuntime = runtimeRef.current
      const eventRuntime = snapshot ? { ...currentRuntime, state: snapshot } : currentRuntime
      const acceptedEvents = [...events]
      syncWorkspaceAgentFirstOutputState(eventRuntime.state.agentPromptInFlightSessionIds ?? [])
      processLifecycleEvents(eventRuntime, acceptedEvents, optionsRef.current)
      void processIncrementalWorkspaceRuntimeEvents(acceptedEvents)
    })
  }, [processLifecycleEvents, subscribeRuntimeEvents])

  useEffect(() => {
    if (!subscribeRuntimeEvents) return
    syncWorkspaceAgentFirstOutputState(agentPromptInFlightSessionIds)
  }, [agentPromptInFlightSessionIds, subscribeRuntimeEvents])

  return Boolean(subscribeRuntimeEvents)
}

// Flags sessions with a live Agent operation as disconnected on a transition into a dropped
// connection state. Durable permission waits are intentionally quiescent: their provider RPC can
// disappear while the persisted card remains actionable after a later resume.
const markRunningSessionsDisconnectedOnDrop = (
  previousStatus: AcpConnectionStatus,
  currentStatus: AcpConnectionStatus,
  previousSessionStatuses: Partial<Record<string, AcpConnectionStatus>> = {},
  currentSessionStatuses: Partial<Record<string, AcpConnectionStatus>> = {},
  durablePermissionSessionIds: ReadonlySet<string> = new Set()
): void => {
  const { sessions, markDisconnected } = useSessionStore.getState()

  for (const session of sessions) {
    const isPermissionWait = session.status === 'waiting-permission'
    const isDurablePermissionWait = isPermissionWait && durablePermissionSessionIds.has(session.id)
    if (session.status !== 'running' && !isPermissionWait && !session.compacting) {
      continue
    }

    if (isDurablePermissionWait) continue

    const previousOwnedStatus = previousSessionStatuses[session.id]
    const currentOwnedStatus = currentSessionStatuses[session.id]
    const hasOwningRuntimeStatus =
      previousOwnedStatus !== undefined || currentOwnedStatus !== undefined
    const previous = hasOwningRuntimeStatus
      ? (previousOwnedStatus ?? currentOwnedStatus ?? previousStatus)
      : previousStatus
    const current = hasOwningRuntimeStatus
      ? (currentOwnedStatus ?? previousOwnedStatus ?? currentStatus)
      : currentStatus
    const droppedNow =
      (current === 'closed' || current === 'error') && previous !== 'closed' && previous !== 'error'

    if (droppedNow) markDisconnected(session.id)
  }
}

// Copies live context usage into the durable Session. Missing usage clears only attached sessions.
const syncWorkspaceContextUsage = (
  sessionIds: readonly string[],
  contextUsageBySession: Record<string, AcpContextUsage>
): void => {
  const { setContextUsage } = useSessionStore.getState()
  for (const sessionId of sessionIds) setContextUsage(sessionId, contextUsageBySession[sessionId])
}

const refreshDelegatedWorkSessions = async (
  sessionIds: readonly string[],
  isCancelled: () => boolean = () => false
): Promise<void> => {
  const liveSessionIds = new Set(sessionIds)
  const requests = useSessionStore
    .getState()
    .sessions.filter((session) => liveSessionIds.has(session.id))
    .map(({ id: sessionId, projectId }) => ({ projectId, sessionId }))
  const sessions = await Promise.all(
    requests.map((request) => window.api.sessions.loadOne(request))
  )
  if (isCancelled()) return
  for (const session of sessions) {
    if (session?.runtimeContext?.delegatedWork) {
      useSessionStore.getState().upsertPersistedSession(session)
    }
  }
}

const drainWorkspaceRuntimeEventsForPersistence = async (
  sessionId?: string,
  reconcileRuntimeSnapshot?: (snapshot: AcpStateSnapshot) => void
): Promise<void> => {
  const snapshot = await window.api.acp.getState()
  const accepted = await ingestWorkspaceRuntimeSnapshot(snapshot, false)
  await liveWorkspaceRuntimeEventProcessor.drain(sessionId)
  if (accepted) syncWorkspaceContextUsage(snapshot.sessionIds, snapshot.contextUsageBySession)
  // A versioned persistence drain shares the global revision watermark with the live React
  // projection. Reconcile the same accepted snapshot so the drain cannot strand that projection
  // behind it. Legacy unversioned pulls have no ordering proof and must not overwrite live state.
  if (accepted && snapshot.revision !== undefined) reconcileRuntimeSnapshot?.(snapshot)
}

const useWorkspaceRuntimeEventDrain = (
  reconcileRuntimeSnapshot: (snapshot: AcpStateSnapshot) => void
): ((sessionId?: string) => Promise<void>) =>
  useCallback(
    (sessionId?: string) =>
      drainWorkspaceRuntimeEventsForPersistence(sessionId, reconcileRuntimeSnapshot),
    [reconcileRuntimeSnapshot]
  )

export {
  createWorkspaceRuntimeEventProcessor,
  drainWorkspaceRuntimeEventsForPersistence,
  markRunningSessionsDisconnectedOnDrop,
  processIncrementalWorkspaceRuntimeEvents,
  processVisibleWorkspaceRuntimeEvents,
  processWorkspaceRuntimeEvents,
  refreshDelegatedWorkSessions,
  resetWorkspaceRuntimeEventOwnerForTests,
  subscribeWorkspacePermissionLifecycle,
  syncWorkspaceAgentFirstOutputState,
  syncWorkspaceContextUsage,
  syncWorkspaceElicitationState,
  syncWorkspaceInteractionState,
  syncWorkspacePermissionState,
  useWorkspaceRuntimeEventDrain,
  useWorkspaceRuntimeEventIngest
}
