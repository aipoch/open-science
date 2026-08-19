import {
  MAX_ACP_RUNTIME_EVENTS,
  type AcpRuntimeEvent,
  type AcpStateSnapshot
} from '../../../../shared/acp'

type RuntimeEventSnapshotContext = AcpStateSnapshot
type RuntimeEventListener = (
  events: readonly AcpRuntimeEvent[],
  snapshot?: RuntimeEventSnapshotContext
) => void
type RuntimeEventSubscriptionOwner = {
  observeEvent: (event: AcpRuntimeEvent) => void
  observeInitialSnapshot: (
    events: readonly AcpRuntimeEvent[],
    snapshot?: RuntimeEventSnapshotContext
  ) => void
  observeSnapshot: (
    events: readonly AcpRuntimeEvent[],
    snapshot?: RuntimeEventSnapshotContext
  ) => void
  subscribe: (listener: RuntimeEventListener) => () => void
  currentEvents: () => readonly AcpRuntimeEvent[]
}

// Keeps incremental delivery outside React state. The initial pull is a barrier: events arriving
// while it is in flight are queued after the snapshot, then every mounted subscriber receives new
// events synchronously so a bounded presentation window can never discard an unaccepted prefix.
const createRuntimeEventSubscriptionOwner = (): RuntimeEventSubscriptionOwner => {
  const listeners = new Set<RuntimeEventListener>()
  const retainedEvents: AcpRuntimeEvent[] = []
  const retainedEventIds = new Set<string>()
  const pendingInitialEvents = new Map<string, AcpRuntimeEvent>()
  const directEventsSinceSnapshot = new Map<string, number>()
  let previousSnapshotEventIds = new Set<string>()
  let initialized = false
  let hasSubscribed = false
  let preserveInitialReplay = false
  let arrivalSequence = 0

  const capRetainedEvents = (): void => {
    if (preserveInitialReplay || retainedEvents.length <= MAX_ACP_RUNTIME_EVENTS) return
    const removed = retainedEvents.splice(0, retainedEvents.length - MAX_ACP_RUNTIME_EVENTS)
    for (const event of removed) retainedEventIds.delete(event.id)
  }

  const retain = (events: readonly AcpRuntimeEvent[]): void => {
    for (const event of events) {
      if (retainedEventIds.has(event.id)) continue
      retainedEvents.push(event)
      retainedEventIds.add(event.id)
    }
    capRetainedEvents()
  }

  const publish = (
    events: readonly AcpRuntimeEvent[],
    snapshot?: RuntimeEventSnapshotContext
  ): void => {
    if (events.length === 0) return
    for (const listener of listeners) listener(events, snapshot)
  }

  const reconcileDirectEvents = (events: readonly AcpRuntimeEvent[]): void => {
    let confirmedArrival = 0
    for (const event of events) {
      confirmedArrival = Math.max(confirmedArrival, directEventsSinceSnapshot.get(event.id) ?? 0)
    }
    if (confirmedArrival === 0) return
    for (const [eventId, sequence] of directEventsSinceSnapshot) {
      if (sequence <= confirmedArrival) directEventsSinceSnapshot.delete(eventId)
    }
  }

  const unseenSnapshotEvents = (events: readonly AcpRuntimeEvent[]): AcpRuntimeEvent[] =>
    events.filter(
      (event) =>
        !retainedEventIds.has(event.id) &&
        !previousSnapshotEventIds.has(event.id) &&
        !pendingInitialEvents.has(event.id) &&
        !directEventsSinceSnapshot.has(event.id)
    )

  const mergeInitialEvents = (
    snapshotEvents: readonly AcpRuntimeEvent[],
    pendingEvents: readonly AcpRuntimeEvent[]
  ): AcpRuntimeEvent[] => {
    const pendingIndexes = new Map(pendingEvents.map((event, index) => [event.id, index]))
    const merged: AcpRuntimeEvent[] = []
    let pendingIndex = 0

    for (const snapshotEvent of snapshotEvents) {
      const overlapIndex = pendingIndexes.get(snapshotEvent.id)
      if (overlapIndex === undefined) {
        merged.push(snapshotEvent)
      } else if (overlapIndex >= pendingIndex) {
        merged.push(...pendingEvents.slice(pendingIndex, overlapIndex + 1))
        pendingIndex = overlapIndex + 1
      }
    }
    merged.push(...pendingEvents.slice(pendingIndex))
    return merged
  }

  const observeSnapshot = (
    events: readonly AcpRuntimeEvent[],
    snapshot?: RuntimeEventSnapshotContext
  ): void => {
    if (!initialized) {
      initialized = true
      const snapshotEventIds = new Set(events.map((event) => event.id))
      const pendingEvents = [...pendingInitialEvents.values()]
      const initialEvents = mergeInitialEvents(events, pendingEvents)
      preserveInitialReplay = !hasSubscribed && pendingEvents.length > 0
      reconcileDirectEvents(events)
      previousSnapshotEventIds = snapshotEventIds
      pendingInitialEvents.clear()
      retain(initialEvents)
      publish(initialEvents, snapshot)
      return
    }

    const unseen = unseenSnapshotEvents(events)
    reconcileDirectEvents(events)
    previousSnapshotEventIds = new Set(events.map((event) => event.id))
    retain(unseen)
    publish(unseen, snapshot)
  }

  return {
    observeEvent(event: AcpRuntimeEvent): void {
      if (
        retainedEventIds.has(event.id) ||
        pendingInitialEvents.has(event.id) ||
        directEventsSinceSnapshot.has(event.id)
      ) {
        return
      }
      arrivalSequence += 1
      directEventsSinceSnapshot.set(event.id, arrivalSequence)
      if (!initialized) {
        pendingInitialEvents.set(event.id, event)
        return
      }
      retain([event])
      publish([event])
    },
    observeInitialSnapshot(
      events: readonly AcpRuntimeEvent[],
      snapshot?: RuntimeEventSnapshotContext
    ): void {
      observeSnapshot(events, snapshot)
    },
    observeSnapshot,
    subscribe(listener: RuntimeEventListener): () => void {
      listeners.add(listener)
      if (!hasSubscribed) {
        hasSubscribed = true
        if (initialized) publish(retainedEvents)
        preserveInitialReplay = false
        capRetainedEvents()
      } else if (initialized && retainedEvents.length > 0) {
        listener(retainedEvents)
      }
      return () => listeners.delete(listener)
    },
    currentEvents(): readonly AcpRuntimeEvent[] {
      return retainedEvents
    }
  }
}

export { createRuntimeEventSubscriptionOwner }
export type { RuntimeEventListener, RuntimeEventSnapshotContext }
