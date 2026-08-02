import type {
  HandoffLifecycleEvent,
  HandoffLifecycleEventSource,
  HandoffRetryRequest,
  HandoffTarget
} from '../../../../shared/handoff-lifecycle'
import type {
  CompletionHandoffLifecycleEvent,
  CompletionHandoffCommand
} from '../../../../shared/specialist'

type HandoffLifecycleApi = {
  getHandoffEvents(sessionId: string): Promise<readonly CompletionHandoffLifecycleEvent[]>
  retryHandoff(request: CompletionHandoffCommand): Promise<unknown>
  onHandoffLifecycleEvent(listener: (event: CompletionHandoffLifecycleEvent) => void): () => void
}

// `useSyncExternalStore` requires an unchanged snapshot to keep the same reference. Sessions with
// no handoffs are common, so they must share this empty snapshot instead of allocating `[]` per read.
const EMPTY_EVENTS: readonly HandoffLifecycleEvent[] = []

const targetFromReadback = (readback: unknown, fallback: string | null): HandoffTarget => {
  if (readback && typeof readback === 'object' && 'binding' in readback) {
    const binding = readback.binding
    if (binding && typeof binding === 'object' && 'targetName' in binding) {
      const targetName = binding.targetName
      if (targetName === null) return { kind: 'main' }
      if (typeof targetName === 'string') return { kind: 'specialist', name: targetName }
    }
  }
  return fallback === null ? { kind: 'main' } : { kind: 'specialist', name: fallback }
}

const toHandoffEvent = (event: CompletionHandoffLifecycleEvent): HandoffLifecycleEvent => ({
  id: event.id,
  sessionId: event.sessionId,
  sequence: event.sequence,
  observedAt: event.observedAt,
  phase: event.phase,
  target: event.target === null ? { kind: 'main' } : { kind: 'specialist', name: event.target },
  provenance: {
    originatingTurnId: event.provenance.originatingTurnId,
    originatingUserMessageId:
      event.provenance.originatingUserMessageId ?? event.provenance.originatingTurnId,
    attachmentIds: event.provenance.attachmentIds,
    artifactIds: event.provenance.artifactIds
  },
  ...(event.continuation?.outcome === 'returned' || event.continuation?.outcome === 'threw'
    ? {
        continuation: {
          outcome: event.continuation.outcome,
          switchReadback: {
            target: targetFromReadback(event.continuation.switchReadback, event.target)
          }
        }
      }
    : {}),
  ...(event.failure ? { failure: event.failure } : {})
})

const sameEvents = (
  left: readonly HandoffLifecycleEvent[],
  right: readonly HandoffLifecycleEvent[]
): boolean =>
  left.length === right.length &&
  left.every(
    (event, index) =>
      event.id === right[index]?.id &&
      event.sequence === right[index]?.sequence &&
      event.phase === right[index]?.phase
  )

// Retained IPC snapshots close the gap before subscription; changed events keep the transcript live.
// The only renderer command is a retry intent. Main remains responsible for validating it.
class IpcHandoffLifecycleClient implements HandoffLifecycleEventSource {
  private readonly eventsBySession = new Map<string, readonly HandoffLifecycleEvent[]>()
  private readonly listeners = new Set<() => void>()
  private stopChangedListener: (() => void) | undefined

  constructor(private readonly getApi: () => HandoffLifecycleApi | undefined) {}

  getEvents(sessionId: string): readonly HandoffLifecycleEvent[] {
    return this.eventsBySession.get(sessionId) ?? EMPTY_EVENTS
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    this.ensureChangedListener()

    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.stopChangedListener?.()
        this.stopChangedListener = undefined
      }
    }
  }

  async load(sessionId: string): Promise<void> {
    const api = this.getApi()
    if (!api) return

    const retained = await api.getHandoffEvents(sessionId)
    this.merge(sessionId, retained.map(toHandoffEvent))
  }

  async retry(request: HandoffRetryRequest): Promise<void> {
    const api = this.getApi()
    if (!api) throw new Error('Handoff lifecycle API is unavailable')
    const event = [...this.getEvents(request.sessionId)]
      .reverse()
      .find((candidate) => candidate.provenance.originatingTurnId === request.originatingTurnId)
    if (!event) throw new Error('The handoff is no longer available.')
    await api.retryHandoff({ id: event.id, sessionId: request.sessionId })
  }

  private ensureChangedListener(): void {
    if (this.stopChangedListener) return
    const api = this.getApi()
    if (!api) return
    this.stopChangedListener = api.onHandoffLifecycleEvent((event) => {
      if (event.removed) {
        this.remove(event.sessionId, event.id)
        return
      }
      this.merge(event.sessionId, [toHandoffEvent(event)])
    })
  }

  private merge(sessionId: string, incoming: readonly HandoffLifecycleEvent[]): void {
    const current = this.getEvents(sessionId)
    const byId = new Map(current.map((event) => [event.id, event]))
    for (const event of incoming) byId.set(event.id, event)
    const next = Array.from(byId.values()).sort((left, right) => left.sequence - right.sequence)
    if (sameEvents(current, next)) return

    this.eventsBySession.set(sessionId, next)
    for (const listener of this.listeners) listener()
  }

  private remove(sessionId: string, id: string): void {
    const current = this.getEvents(sessionId)
    const next = current.filter((event) => event.id !== id)
    if (sameEvents(current, next)) return
    this.eventsBySession.set(sessionId, next)
    for (const listener of this.listeners) listener()
  }
}

const workspaceHandoffLifecycleClient = new IpcHandoffLifecycleClient(() => window.api?.specialist)

export { IpcHandoffLifecycleClient, workspaceHandoffLifecycleClient }
