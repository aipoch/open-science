import type { AcpRuntimeEvent, AcpRuntimeEventInput, AcpStateSnapshot } from '../../shared/acp'
import {
  getAcpRuntimeEventImage,
  MAX_ACP_RUNTIME_EVENTS,
  MAX_ACP_SESSION_IMAGE_BYTES
} from '../../shared/acp'
import { capToolDetailText, sanitizeToolContent } from '../../shared/tool-detail-sanitizer'

const ACP_RUNTIME_EVENT_RETENTION_LIMIT = MAX_ACP_RUNTIME_EVENTS
// Amortized eviction: trim only after a full cap of slack accumulates, so steady-state appends are
// a plain push instead of an O(n) array rebuild per event. Reads always go through the last
// ACP_RUNTIME_EVENT_RETENTION_LIMIT window, keeping the observable retention bound exact.
const EVENT_TRIM_THRESHOLD = ACP_RUNTIME_EVENT_RETENTION_LIMIT * 2

type RuntimeSnapshotFields = Pick<AcpStateSnapshot, 'status' | 'cwd' | 'error' | 'events'>
type RuntimeSnapshotProjection = Omit<AcpStateSnapshot, keyof RuntimeSnapshotFields>
type RuntimeEventInput = AcpRuntimeEventInput

const cloneEvent = (event: AcpRuntimeEvent): AcpRuntimeEvent => structuredClone(event)

// Owns the small, runtime-wide portion of the renderer snapshot. Publishing remains the runtime's
// responsibility: commands mutate synchronously and callers decide when callbacks must observe them.
class AcpRuntimeSnapshotOwner {
  private connectionStatus: AcpStateSnapshot['status'] = 'idle'
  private workingDirectory: string
  private currentError: string | undefined
  private retainedEvents: AcpRuntimeEvent[] = []
  private eventSequence = 0

  constructor(cwd: string) {
    this.workingDirectory = cwd
  }

  get status(): AcpStateSnapshot['status'] {
    return this.connectionStatus
  }

  get cwd(): string {
    return this.workingDirectory
  }

  get error(): string | undefined {
    return this.currentError
  }

  transitionStatus(status: AcpStateSnapshot['status']): void {
    this.connectionStatus = status
  }

  updateCwd(cwd: string): void {
    this.workingDirectory = cwd
  }

  updateError(error: string | undefined): void {
    this.currentError = error
  }

  nextEventId(): string {
    this.eventSequence += 1
    return `acp-event-${this.eventSequence}`
  }

  appendEvent(event: RuntimeEventInput): AcpRuntimeEvent {
    let image = event.image
    let raw = event.raw
    let text = event.text
    const toolContent = sanitizeToolContent(event.toolContent) as
      AcpRuntimeEvent['toolContent'] | undefined
    const terminalOutput = event.terminalOutput
      ? capToolDetailText(event.terminalOutput)
      : undefined
    if (image && event.sessionId) {
      const retainedBytes = this.retainedWindow()
        .filter((candidate) => candidate.sessionId === event.sessionId)
        .reduce(
          (total, candidate) => total + (getAcpRuntimeEventImage(candidate)?.byteLength ?? 0),
          0
        )
      if (retainedBytes + image.byteLength > MAX_ACP_SESSION_IMAGE_BYTES) {
        image = undefined
        raw = undefined
        text = 'Agent image omitted because the session image budget was reached.'
      }
    }

    // Preserve the normalized event shape as it evolves. Explicitly override the owned identity,
    // timestamp, defaults, and bounded image/raw fields so future presentation metadata cannot be
    // silently dropped by a second hand-maintained projection list.
    const runtimeEvent = {
      ...event,
      id: event.id ?? this.nextEventId(),
      timestamp: event.timestamp ?? Date.now(),
      level: event.level ?? 'info',
      text,
      image,
      toolContent,
      terminalOutput,
      promptMessageId: event.promptMessageId,
      raw
    } as AcpRuntimeEvent

    // Deeply frozen inputs (the session-update projector deep-freezes every event it emits) are
    // immutable, so ownership transfers and the retained history can share them; anything else
    // gets a defensive clone so later caller mutation cannot rewrite history.
    this.retainedEvents.push(Object.isFrozen(event) ? runtimeEvent : cloneEvent(runtimeEvent))
    if (this.retainedEvents.length > EVENT_TRIM_THRESHOLD) {
      this.retainedEvents = this.retainedEvents.slice(-ACP_RUNTIME_EVENT_RETENTION_LIMIT)
    }
    return runtimeEvent
  }

  // The retained array may carry up to a cap of trim slack; every reader sees exactly the last
  // ACP_RUNTIME_EVENT_RETENTION_LIMIT entries, in append order.
  private retainedWindow(): AcpRuntimeEvent[] {
    return this.retainedEvents.length > ACP_RUNTIME_EVENT_RETENTION_LIMIT
      ? this.retainedEvents.slice(-ACP_RUNTIME_EVENT_RETENTION_LIMIT)
      : this.retainedEvents
  }

  snapshot(projection: RuntimeSnapshotProjection): AcpStateSnapshot {
    return structuredClone({
      status: this.connectionStatus,
      cwd: this.workingDirectory,
      error: this.currentError,
      events: this.retainedWindow(),
      ...projection
    })
  }
}

export { ACP_RUNTIME_EVENT_RETENTION_LIMIT, AcpRuntimeSnapshotOwner }
export type { RuntimeEventInput, RuntimeSnapshotFields, RuntimeSnapshotProjection }
