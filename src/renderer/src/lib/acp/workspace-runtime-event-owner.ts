import {
  isDurableAgentUserChoiceRequest,
  type AcpConnectionStatus,
  type AcpContextUsage,
  type AcpPermissionRequest,
  type AcpRuntimeEvent,
  type AcpStateSnapshot,
  type PendingElicitationRequest
} from '../../../../shared/acp'
import { useSessionStore } from '../../stores/session-store'
import { applyWorkspaceRuntimeEvent } from './workspace-events'

// Snapshot projections retain only transition edges; durable chat facts remain in Session Store.
const pendingPermissionSessionIds = new Set<string>()
const pendingElicitationSessionIds = new Set<string>()
const firstOutputWaitingSessionIds = new Set<string>()

type RuntimeEventApplier = (event: AcpRuntimeEvent) => Promise<boolean>

type WorkspaceRuntimeEventProcessor = {
  process: (events: AcpRuntimeEvent[]) => Promise<void>
  drain: (sessionId?: string) => Promise<void>
}

const processVisibleWorkspaceRuntimeEvents = async (
  events: AcpRuntimeEvent[],
  processedEventIds: Set<string>,
  applyEvent: RuntimeEventApplier = applyWorkspaceRuntimeEvent,
  processingEventIds = new Set<string>()
): Promise<void> => {
  // Runtime snapshots are bounded, so forget ids that can no longer be replayed from the source list.
  const visibleEventIds = new Set(events.map((event) => event.id))

  for (const eventId of processedEventIds) {
    if (!visibleEventIds.has(eventId)) processedEventIds.delete(eventId)
  }

  for (const eventId of processingEventIds) {
    if (!visibleEventIds.has(eventId)) processingEventIds.delete(eventId)
  }

  for (const event of events) {
    if (processedEventIds.has(event.id) || processingEventIds.has(event.id)) continue

    processingEventIds.add(event.id)
    try {
      // Apply visible events sequentially so message chunks and artifact finalization stay ordered.
      await applyEvent(event)
      processedEventIds.add(event.id)
    } catch {
      // Artifact finalization errors are recorded by the adapter before throwing.
      // Keeping this id unprocessed lets the same visible runtime event retry.
      continue
    } finally {
      processingEventIds.delete(event.id)
    }
  }
}

const createWorkspaceRuntimeEventProcessor = (
  applyEvent: RuntimeEventApplier = applyWorkspaceRuntimeEvent
): WorkspaceRuntimeEventProcessor => {
  type EventLane = {
    acceptedEvents: Map<string, AcpRuntimeEvent>
    failedEventIds: Set<string>
    processedEventIds: Set<string>
    processingEventIds: Set<string>
    drainInFlight?: Promise<void>
    drainAgain: boolean
  }

  const unscopedEventLane = Symbol('unscoped-workspace-runtime-events')
  const eventLanes = new Map<string | symbol, EventLane>()
  let latestEvents: AcpRuntimeEvent[] = []
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
        drainAgain: false
      }
      eventLanes.set(laneKey, lane)
    }

    return lane
  }

  const cleanEventLane = (laneKey: string | symbol, lane: EventLane): void => {
    const visibleEventIds = new Set(
      latestEvents.filter((event) => getEventLaneKey(event) === laneKey).map((event) => event.id)
    )

    for (const eventId of lane.acceptedEvents.keys()) {
      if (!visibleEventIds.has(eventId) && lane.processedEventIds.has(eventId)) {
        lane.acceptedEvents.delete(eventId)
        lane.failedEventIds.delete(eventId)
        lane.processedEventIds.delete(eventId)
        lane.processingEventIds.delete(eventId)
      }
    }

    if (lane.acceptedEvents.size === 0 && !lane.drainInFlight) eventLanes.delete(laneKey)
  }

  const drainLane = async (laneKey: string | symbol): Promise<void> => {
    const lane = getEventLane(laneKey)

    if (lane.drainInFlight) {
      lane.drainAgain = true
      return lane.drainInFlight
    }

    lane.drainInFlight = (async () => {
      do {
        lane.drainAgain = false
        await processVisibleWorkspaceRuntimeEvents(
          [...lane.acceptedEvents.values()],
          lane.processedEventIds,
          async (event) => {
            const hadFailed = lane.failedEventIds.has(event.id)
            try {
              const applied = await applyEvent(event)
              lane.failedEventIds.delete(event.id)
              return applied
            } catch (error) {
              const isVisible = latestEvents.some(
                (candidate) => candidate.id === event.id && getEventLaneKey(candidate) === laneKey
              )
              if (hadFailed && !isVisible) {
                lane.acceptedEvents.delete(event.id)
                lane.failedEventIds.delete(event.id)
              } else {
                lane.failedEventIds.add(event.id)
              }
              throw error
            }
          },
          lane.processingEventIds
        )
      } while (lane.drainAgain)
    })()

    try {
      await lane.drainInFlight
    } finally {
      lane.drainInFlight = undefined
      cleanEventLane(laneKey, lane)
    }
  }

  return {
    process: (events) => {
      latestEvents = events
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
        }
      }

      for (const [laneKey, lane] of eventLanes) cleanEventLane(laneKey, lane)

      const drains = [...visibleLaneKeys].map((laneKey) => drainLane(laneKey))
      for (const [laneKey, lane] of eventLanes) {
        if (!visibleLaneKeys.has(laneKey) && lane.acceptedEvents.size > 0) void drainLane(laneKey)
      }

      return Promise.all(drains).then(() => undefined)
    },
    drain: async (sessionId) => {
      if (sessionId !== undefined) {
        if (eventLanes.has(sessionId)) await drainLane(sessionId)
        return
      }

      let drainedVersion: number
      do {
        drainedVersion = acceptedEventVersion
        await Promise.all([...eventLanes.keys()].map((laneKey) => drainLane(laneKey)))
      } while (drainedVersion !== acceptedEventVersion)
    }
  }
}

const liveWorkspaceRuntimeEventProcessor = createWorkspaceRuntimeEventProcessor()

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
      session.status === 'waiting-for-user' &&
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
  syncWorkspacePermissionState(snapshot.pendingPermissions)
  syncWorkspaceElicitationState(snapshot.pendingElicitations ?? [])
}

const resetWorkspaceRuntimeEventOwnerForTests = (): void => {
  pendingPermissionSessionIds.clear()
  pendingElicitationSessionIds.clear()
  firstOutputWaitingSessionIds.clear()
}

// Publishes prompt ownership before applying the same snapshot's events so first output can only
// clear, never re-arm, the renderer waiting state.
const processWorkspaceRuntimeEvents = (
  events: AcpRuntimeEvent[],
  agentPromptInFlightSessionIds: string[]
): Promise<void> => {
  syncWorkspaceAgentFirstOutputState(agentPromptInFlightSessionIds)
  return liveWorkspaceRuntimeEventProcessor.process(events)
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

const drainWorkspaceRuntimeEventsForPersistence = async (sessionId?: string): Promise<void> => {
  const snapshot = await window.api.acp.getState()
  void liveWorkspaceRuntimeEventProcessor.process(snapshot.events)
  await liveWorkspaceRuntimeEventProcessor.drain(sessionId)
  syncWorkspaceContextUsage(snapshot.sessionIds, snapshot.contextUsageBySession)
}

export {
  createWorkspaceRuntimeEventProcessor,
  drainWorkspaceRuntimeEventsForPersistence,
  markRunningSessionsDisconnectedOnDrop,
  processVisibleWorkspaceRuntimeEvents,
  processWorkspaceRuntimeEvents,
  resetWorkspaceRuntimeEventOwnerForTests,
  syncWorkspaceAgentFirstOutputState,
  syncWorkspaceContextUsage,
  syncWorkspaceElicitationState,
  syncWorkspaceInteractionState,
  syncWorkspacePermissionState
}
