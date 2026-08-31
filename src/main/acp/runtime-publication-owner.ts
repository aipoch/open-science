import type { AcpPermissionRequest, AcpRuntimeEvent, AcpStateSnapshot } from '../../shared/acp'
import { createLogger } from '../logger'
import type { AcpSessionInteractionOwner } from './session-interaction-owner'
import {
  ACP_RUNTIME_EVENT_RETENTION_LIMIT,
  type AcpRuntimeSnapshotOwner,
  type RuntimeEventInput,
  type RuntimeSnapshotProjection
} from './runtime-snapshot-owner'

// Dev-facing counters for the acp:state window coalescer; a throttled debug summary rides
// the existing logger level gating (debug is dev-only), leaving production unaffected.
const log = createLogger('acp')
let acpStateBroadcastsSent = 0
let acpStateBroadcastsSuppressed = 0
const acpRuntimeEventsPublished = new Map<AcpRuntimeEvent['kind'], number>()

const recordAcpStateBroadcastSent = (snapshot: AcpStateSnapshot): void => {
  acpStateBroadcastsSent += 1
  // Streaming still emits ~one broadcast per renderer presentation tick, so summarize periodically.
  if (acpStateBroadcastsSent % 100 === 0) {
    log.debug('acp:state broadcasts', {
      sent: acpStateBroadcastsSent,
      suppressed: acpStateBroadcastsSuppressed,
      eventKinds: Object.fromEntries(acpRuntimeEventsPublished),
      ...(process.env.NODE_ENV === 'development'
        ? { snapshotChars: JSON.stringify(snapshot).length }
        : {})
    })
  }
}

type AcpRuntimePublicationCallbacks = Readonly<{
  onEvent?: (event: AcpRuntimeEvent) => void
  onPermissionRequest?: (request: AcpPermissionRequest) => void
  onStateChanged?: (snapshot: AcpStateSnapshot) => void
}>

type AcpRuntimePublicationOwnerOptions = Readonly<{
  snapshotOwner: Pick<AcpRuntimeSnapshotOwner, 'appendEvent' | 'nextEventId' | 'snapshot'>
  interactions: Pick<AcpSessionInteractionOwner, 'current'>
  snapshotProjection: () => RuntimeSnapshotProjection
  callbacks: AcpRuntimePublicationCallbacks
  scheduleStatePublication?: (publish: () => void) => () => void
}>

const STATE_PUBLICATION_INTERVAL_MS = 33
// A fast provider can emit more than one retained window before the 33 ms timer runs. Publish
// midway through that window so every prefix chunk reaches subscribers before bounded history can
// evict it, while ordinary streams still receive the same frame-level coalescing.
const MAX_COALESCED_EVENTS = Math.floor(ACP_RUNTIME_EVENT_RETENTION_LIMIT / 2)

const scheduleStatePublication = (publish: () => void): (() => void) => {
  const timer = setTimeout(publish, STATE_PUBLICATION_INTERVAL_MS)
  return () => clearTimeout(timer)
}

const isCoalescibleAssistantStreamEvent = (event: AcpRuntimeEvent): boolean =>
  (event.kind === 'message' || event.kind === 'thought') &&
  event.role === 'assistant' &&
  typeof event.text === 'string' &&
  event.text.length > 0 &&
  !event.image

// Scoping an event with the active prompt id spreads a fresh container. When the source event was
// frozen (the projector deep-freezes its events), re-freeze the copy so the snapshot owner can
// retain it by reference instead of defensively cloning it again.
const preservingFrozen = <Value extends object>(source: Value, copy: Value): Value =>
  Object.isFrozen(source) ? Object.freeze(copy) : copy

// Owns renderer publication order while AcpRuntimeSnapshotOwner remains the sole event/status writer.
// Every projection is read live from the authoritative owners; this owner caches no runtime facts.
class AcpRuntimePublicationOwner {
  private cancelScheduledStatePublication?: () => void
  private coalescedEvents = 0
  private readonly activeToolCallIdsBySession = new Map<string | undefined, Set<string>>()

  constructor(private readonly options: AcpRuntimePublicationOwnerOptions) {}

  getSnapshot(): AcpStateSnapshot {
    return this.options.snapshotOwner.snapshot(this.options.snapshotProjection())
  }

  nextEventId(): string {
    return this.options.snapshotOwner.nextEventId()
  }

  pushEvent(event: RuntimeEventInput, onAppended?: () => void): void {
    const interaction = event.sessionId
      ? this.options.interactions.current(event.sessionId)
      : undefined
    const promptMessageId = interaction?.kind === 'prompt' ? interaction.promptMessageId : undefined
    const scopedEvent =
      promptMessageId && !event.promptMessageId
        ? preservingFrozen(event, { ...event, promptMessageId })
        : event
    const runtimeEvent = this.options.snapshotOwner.appendEvent(scopedEvent)
    onAppended?.()
    acpRuntimeEventsPublished.set(
      runtimeEvent.kind,
      (acpRuntimeEventsPublished.get(runtimeEvent.kind) ?? 0) + 1
    )
    this.options.callbacks.onEvent?.(runtimeEvent)
    // Incremental adapters receive every event in order. State is published only by the explicit
    // lifecycle mutations that follow this call; rebuilding the retained window for this event
    // would duplicate the same payload across IPC. Snapshot-only adapters retain the established
    // coalesced-state fallback below.
    if (this.options.callbacks.onEvent) return

    const coalescible = this.isCoalescibleRuntimeEvent(runtimeEvent)
    if (coalescible) {
      this.coalescedEvents += 1
      if (this.coalescedEvents >= MAX_COALESCED_EVENTS) {
        this.emitState()
      } else {
        this.scheduleStatePublication()
      }
    } else {
      this.emitState()
    }
  }

  private isCoalescibleRuntimeEvent(event: AcpRuntimeEvent): boolean {
    if (isCoalescibleAssistantStreamEvent(event)) return true
    if (event.kind === 'stop' || event.kind === 'error') {
      this.activeToolCallIdsBySession.delete(event.sessionId)
      return false
    }
    if (event.kind !== 'tool' || !event.toolCallId) return false

    const activeToolCallIds = this.activeToolCallIdsBySession.get(event.sessionId)
    const wasActive = activeToolCallIds?.has(event.toolCallId) === true
    if (event.status === 'completed' || event.status === 'failed') {
      activeToolCallIds?.delete(event.toolCallId)
      if (activeToolCallIds?.size === 0) {
        this.activeToolCallIdsBySession.delete(event.sessionId)
      }
      return false
    }
    if (activeToolCallIds) {
      activeToolCallIds.add(event.toolCallId)
    } else {
      this.activeToolCallIdsBySession.set(event.sessionId, new Set([event.toolCallId]))
    }

    return (
      wasActive &&
      (event.toolContent !== undefined ||
        event.terminalOutput !== undefined ||
        event.rawOutput !== undefined)
    )
  }

  publishPermissionRequest(request: AcpPermissionRequest): void {
    this.pushEvent({
      kind: 'permission',
      level: 'warning',
      sessionId: request.sessionId,
      permissionRequestId: request.requestId,
      toolCallId: request.toolCallId,
      title: 'Permission requested',
      text: request.title,
      raw: request
    })
    this.options.callbacks.onPermissionRequest?.(request)
    this.emitState()
  }

  emitState(): void {
    this.cancelScheduledPublication()
    this.publishState()
  }

  private publishState(): void {
    this.coalescedEvents = 0
    const onStateChanged = this.options.callbacks.onStateChanged
    if (!onStateChanged) return

    const snapshot = this.getSnapshot()
    recordAcpStateBroadcastSent(snapshot)
    onStateChanged(snapshot)
  }

  cancelPendingStatePublication(): void {
    this.cancelScheduledPublication()
    this.activeToolCallIdsBySession.clear()
  }

  private cancelScheduledPublication(): void {
    this.cancelScheduledStatePublication?.()
    this.cancelScheduledStatePublication = undefined
  }

  private scheduleStatePublication(): void {
    if (this.cancelScheduledStatePublication) {
      acpStateBroadcastsSuppressed += 1
      return
    }

    const schedule = this.options.scheduleStatePublication ?? scheduleStatePublication
    this.cancelScheduledStatePublication = schedule(() => {
      this.cancelScheduledStatePublication = undefined
      this.publishState()
    })
  }
}

export { AcpRuntimePublicationOwner }
export type { AcpRuntimePublicationCallbacks, AcpRuntimePublicationOwnerOptions }
