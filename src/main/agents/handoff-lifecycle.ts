import type {
  HandoffApprovalContext,
  HandoffContinuationContext,
  HandoffLifecycleChange,
  HandoffLifecycleEvent,
  HandoffLifecycleFailure,
  HandoffLifecyclePhase,
  HandoffRetryRequest
} from '../../shared/handoff-lifecycle'
import type { CompletionGateLifecycle } from './completion-gate'

type HandoffLifecycleCoordinatorOptions = {
  onChange?: (change: HandoffLifecycleChange) => void
  retryHandoff?: (
    context: HandoffContinuationContext,
    retryFrom: HandoffLifecycleFailure['retryFrom'],
    onPhase: (phase: HandoffLifecyclePhase) => void
  ) => Promise<void>
}

const handoffKey = (sessionId: string, originatingTurnId: string): string =>
  `${sessionId}\u0000${originatingTurnId}`

// Stores continuation context and projects lifecycle events from the authoritative completion gate.
// It never decides whether a completion can return to the old prompt.
class HandoffLifecycleCoordinator implements CompletionGateLifecycle {
  private readonly eventsBySession = new Map<string, readonly HandoffLifecycleEvent[]>()
  private readonly contextsByTurn = new Map<string, HandoffContinuationContext>()
  private readonly sequenceByTurn = new Map<string, number>()
  private readonly awaitingEventIdByInvocation = new Map<string, string>()

  constructor(private readonly options: HandoffLifecycleCoordinatorOptions = {}) {}

  onAwaitingApproval(context: HandoffApprovalContext): void {
    const event = this.append(context, 'awaiting-approval')
    this.awaitingEventIdByInvocation.set(
      handoffKey(context.sessionId, context.toolInvocationId),
      event.id
    )
  }

  settleApproval(context: HandoffApprovalContext, approved: boolean): void {
    const approvalKey = handoffKey(context.sessionId, context.toolInvocationId)
    const eventId = this.awaitingEventIdByInvocation.get(approvalKey)
    this.awaitingEventIdByInvocation.delete(approvalKey)
    if (approved || !eventId) return

    const current = this.getEvents(context.sessionId)
    const next = current.filter((event) => event.id !== eventId)
    if (next.length === current.length) return
    this.eventsBySession.set(context.sessionId, next)
    this.options.onChange?.({ kind: 'remove', sessionId: context.sessionId, eventIds: [eventId] })
  }

  onCaptured(context: HandoffContinuationContext): void {
    this.awaitingEventIdByInvocation.delete(handoffKey(context.sessionId, context.toolInvocationId))
    this.contextsByTurn.set(handoffKey(context.sessionId, context.originatingTurnId), context)
    this.append(context, 'switching')
  }

  onPhase(context: HandoffContinuationContext, phase: HandoffLifecyclePhase): void {
    this.append(context, phase)
  }

  onFailed(
    context: HandoffContinuationContext,
    retryFrom: HandoffLifecycleFailure['retryFrom']
  ): void {
    this.append(context, 'failed', {
      retryFrom,
      message: 'The approved handoff could not continue.'
    })
  }

  getEvents(sessionId: string): readonly HandoffLifecycleEvent[] {
    return this.eventsBySession.get(sessionId) ?? []
  }

  getContinuationContext(
    sessionId: string,
    originatingTurnId: string
  ): HandoffContinuationContext | undefined {
    return this.contextsByTurn.get(handoffKey(sessionId, originatingTurnId))
  }

  async retry(request: HandoffRetryRequest): Promise<void> {
    const context = this.getContinuationContext(request.sessionId, request.originatingTurnId)
    const latest = [...this.getEvents(request.sessionId)]
      .reverse()
      .find((event) => event.provenance.originatingTurnId === request.originatingTurnId)

    if (!context || latest?.phase !== 'failed' || !latest.failure) {
      throw new Error('The handoff is not in a retryable failed state.')
    }
    if (!this.options.retryHandoff) {
      throw new Error('Handoff retry is not available.')
    }

    let retryFrom = latest.failure.retryFrom
    try {
      await this.options.retryHandoff(context, retryFrom, (phase) => {
        if (phase === 'switching' || phase === 'reconfiguring' || phase === 'continuation-start') {
          retryFrom = phase
        }
        this.append(context, phase)
      })
    } catch (error) {
      this.onFailed(context, retryFrom)
      throw error
    }
  }

  private append(
    context: HandoffContinuationContext | HandoffApprovalContext,
    phase: HandoffLifecyclePhase,
    failure?: HandoffLifecycleFailure
  ): HandoffLifecycleEvent {
    const key = handoffKey(context.sessionId, context.originatingTurnId)
    const sequence = (this.sequenceByTurn.get(key) ?? 0) + 1
    this.sequenceByTurn.set(key, sequence)

    const event: HandoffLifecycleEvent = {
      id: `handoff:${context.sessionId}:${context.originatingTurnId}:${sequence}`,
      sessionId: context.sessionId,
      sequence,
      observedAt: Date.now(),
      phase,
      target: context.target,
      provenance: {
        originatingTurnId: context.originatingTurnId,
        originatingUserMessageId: context.originatingUserMessageId,
        attachmentIds: context.attachmentIds,
        artifactIds: context.artifactIds
      },
      ...(phase === 'continued' && 'completion' in context
        ? {
            continuation: {
              outcome: context.completion.kind,
              switchReadback: context.switchReadback
            }
          }
        : {}),
      ...(failure ? { failure } : {})
    }
    const events = [...(this.eventsBySession.get(context.sessionId) ?? []), event]
    this.eventsBySession.set(context.sessionId, events)
    this.options.onChange?.({ kind: 'upsert', event })
    return event
  }
}

export { HandoffLifecycleCoordinator }
export type { HandoffLifecycleCoordinatorOptions }
