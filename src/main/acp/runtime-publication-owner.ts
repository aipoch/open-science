import type { AcpPermissionRequest, AcpRuntimeEvent, AcpStateSnapshot } from '../../shared/acp'
import type { AcpSessionInteractionOwner } from './session-interaction-owner'
import type {
  AcpRuntimeSnapshotOwner,
  RuntimeEventInput,
  RuntimeSnapshotProjection
} from './runtime-snapshot-owner'

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

// Owns renderer publication order while AcpRuntimeSnapshotOwner remains the sole event/status writer.
// Every projection is read live from the authoritative owners; this owner caches no runtime facts.
class AcpRuntimePublicationOwner {
  private cancelScheduledStatePublication?: () => void

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
      promptMessageId && !event.promptMessageId ? { ...event, promptMessageId } : event
    const runtimeEvent = this.options.snapshotOwner.appendEvent(scopedEvent)
    onAppended?.()
    this.options.callbacks.onEvent?.(runtimeEvent)
    if (isCoalescibleAssistantTextEvent(runtimeEvent)) {
      this.scheduleStatePublication()
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
    this.options.callbacks.onStateChanged?.(this.getSnapshot())
  }

  cancelPendingStatePublication(): void {
    this.cancelScheduledStatePublication?.()
    this.cancelScheduledStatePublication = undefined
  }

  private scheduleStatePublication(): void {
    if (this.cancelScheduledStatePublication) return

    const schedule = this.options.scheduleStatePublication ?? scheduleStatePublication
    this.cancelScheduledStatePublication = schedule(() => {
      this.cancelScheduledStatePublication = undefined
      this.options.callbacks.onStateChanged?.(this.getSnapshot())
    })
  }
}

export { AcpRuntimePublicationOwner }
export type { AcpRuntimePublicationCallbacks, AcpRuntimePublicationOwnerOptions }
