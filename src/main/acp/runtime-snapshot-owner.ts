import type { AcpRuntimeEvent, AcpStateSnapshot } from '../../shared/acp'
import { getAcpRuntimeEventImage, MAX_ACP_SESSION_IMAGE_BYTES } from '../../shared/acp'

const MAX_EVENTS = 500

type RuntimeSnapshotFields = Pick<AcpStateSnapshot, 'status' | 'cwd' | 'error' | 'events'>
type RuntimeSnapshotProjection = Omit<AcpStateSnapshot, keyof RuntimeSnapshotFields>
type RuntimeEventInput = Omit<AcpRuntimeEvent, 'id' | 'timestamp'> & Partial<AcpRuntimeEvent>

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
    if (image && event.sessionId) {
      const retainedBytes = this.retainedEvents
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

    const runtimeEvent: AcpRuntimeEvent = {
      id: event.id ?? this.nextEventId(),
      timestamp: event.timestamp ?? Date.now(),
      level: event.level ?? 'info',
      kind: event.kind,
      compactionReason: event.compactionReason,
      recoverable: event.recoverable,
      providerError: event.providerError,
      turnUsage: event.turnUsage,
      sessionId: event.sessionId,
      messageId: event.messageId,
      role: event.role,
      text,
      image,
      title: event.title,
      status: event.status,
      toolCallId: event.toolCallId,
      providerToolName: event.providerToolName,
      toolKind: event.toolKind,
      toolContent: event.toolContent,
      toolLocations: event.toolLocations,
      rawInput: event.rawInput,
      rawOutput: event.rawOutput,
      runId: event.runId,
      promptMessageId: event.promptMessageId,
      artifactSessionId: event.artifactSessionId,
      artifactClaimId: event.artifactClaimId,
      artifacts: event.artifacts,
      planProjection: event.planProjection,
      raw
    }

    this.retainedEvents = [...this.retainedEvents, cloneEvent(runtimeEvent)].slice(-MAX_EVENTS)
    return runtimeEvent
  }

  snapshot(projection: RuntimeSnapshotProjection): AcpStateSnapshot {
    return structuredClone({
      status: this.connectionStatus,
      cwd: this.workingDirectory,
      error: this.currentError,
      events: this.retainedEvents,
      ...projection
    })
  }
}

export { AcpRuntimeSnapshotOwner }
export type { RuntimeEventInput, RuntimeSnapshotFields, RuntimeSnapshotProjection }
