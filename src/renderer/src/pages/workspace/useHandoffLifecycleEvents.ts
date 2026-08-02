import { useCallback, useEffect, useSyncExternalStore } from 'react'

import type {
  HandoffLifecycleEvent,
  HandoffLifecycleEventSource
} from '../../../../shared/handoff-lifecycle'

const EMPTY_EVENTS: readonly HandoffLifecycleEvent[] = []

// Subscribes to an app-owned snapshot stream. This read model intentionally has no action callbacks:
// an absent, delayed, or stale renderer subscription cannot grant the old prompt permission to run.
const useHandoffLifecycleEvents = (
  source: HandoffLifecycleEventSource | undefined,
  sessionId: string | undefined
): readonly HandoffLifecycleEvent[] => {
  useEffect(() => {
    if (source?.load && sessionId) void source.load(sessionId)
  }, [sessionId, source])

  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      source && sessionId ? source.subscribe(listener) : () => {},
    [sessionId, source]
  )
  const getSnapshot = useCallback(
    (): readonly HandoffLifecycleEvent[] =>
      source && sessionId ? source.getEvents(sessionId) : EMPTY_EVENTS,
    [sessionId, source]
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export { useHandoffLifecycleEvents }
