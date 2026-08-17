import type { AcpPermissionRequest, AcpRuntimeEvent, AcpStateSnapshot } from '../../shared/acp'
import { createLogger } from '../logger'
import type { AcpSessionInteractionOwner } from './session-interaction-owner'
import {
  ACP_RUNTIME_EVENT_RETENTION_LIMIT,
  type AcpRuntimeSnapshotOwner,
  type RuntimeEventInput,
  type RuntimeSnapshotProjection
} from './runtime-snapshot-owner'

// Dev-facing counters for the acp:state trailing-edge coalescer; a throttled debug summary rides
// the existing logger level gating (debug is dev-only), leaving production unaffected.
const log = createLogger('acp')
let acpStateBroadcastsSent = 0
let acpStateBroadcastsSuppressed = 0

const recordAcpStateBroadcastSent = (): void => {
  acpStateBroadcastsSent += 1
  // Streaming still emits ~one broadcast per frame, so log a periodic summary instead.
  if (acpStateBroadcastsSent % 100 === 0) {
    log.debug('acp:state broadcasts', {
      sent: acpStateBroadcastsSent,
      suppressed: acpStateBroadcastsSuppressed
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

const STATE_PUBLICATION_INTERVAL_MS = 16
// A fast provider can emit more than one retained window before the 16 ms timer runs. Publish
// midway through that window so every prefix chunk reaches subscribers before bounded history can
// evict it, while ordinary streams still receive the same frame-level coalescing.
const MAX_COALESCED_ASSISTANT_TEXT_EVENTS = Math.floor(ACP_RUNTIME_EVENT_RETENTION_LIMIT / 2)

const scheduleStatePublication = (publish: () => void): (() => void) => {
  const timer = setTimeout(publish, STATE_PUBLICATION_INTERVAL_MS)
  return () => clearTimeout(timer)
}

const isCoalescibleAssistantTextEvent = (event: AcpRuntimeEvent): boolean =>
  event.kind === 'message' &&
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
  private coalescedAssistantTextEvents = 0

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
    this.options.callbacks.onEvent?.(runtimeEvent)
    if (isCoalescibleAssistantTextEvent(runtimeEvent)) {
      this.coalescedAssistantTextEvents += 1
      if (this.coalescedAssistantTextEvents >= MAX_COALESCED_ASSISTANT_TEXT_EVENTS) {
        this.emitState()
      } else {
        this.scheduleStatePublication()
      }
    } else {
      this.emitState()
    }
  }

  publishPermissionRequest(request: AcpPermissionRequest): void {
    this.pushEvent({
      kind: 'permission',
      level: 'warning',
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      title: 'Permission requested',
      text: request.title,
      raw: request
    })
    this.options.callbacks.onPermissionRequest?.(request)
    this.emitState()
  }

  emitState(): void {
    this.cancelPendingStatePublication()
    this.publishState()
  }

  private publishState(): void {
    this.coalescedAssistantTextEvents = 0
    recordAcpStateBroadcastSent()
    this.options.callbacks.onStateChanged?.(this.getSnapshot())
  }

  cancelPendingStatePublication(): void {
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
