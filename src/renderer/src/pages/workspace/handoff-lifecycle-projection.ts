import type {
  HandoffContinuationSummary,
  HandoffLifecycleEvent,
  HandoffLifecycleFailure,
  HandoffLifecyclePhase,
  HandoffTarget
} from '../../../../shared/handoff-lifecycle'

export type HandoffTranscriptProjection = {
  id: string
  sessionId: string
  originatingTurnId: string
  originatingUserMessageId: string
  // The initial event anchors one mutable lifecycle row in the existing transcript timeline.
  timelineAt: number
  phase: HandoffLifecyclePhase
  target: HandoffTarget
  provenance: Pick<HandoffLifecycleEvent['provenance'], 'attachmentIds' | 'artifactIds'>
  continuation?: HandoffContinuationSummary
  failure?: HandoffLifecycleFailure
}

type ProjectedHandoff = HandoffTranscriptProjection & { latestSequence: number }

// Groups every lifecycle update under one original user turn. The renderer projects the coordinator
// feed without manufacturing a second user message, mutating the captured context, or re-emitting
// pre-handoff assistant text.
const projectHandoffLifecycle = (
  events: readonly HandoffLifecycleEvent[]
): HandoffTranscriptProjection[] => {
  const handoffsByTurn = new Map<string, ProjectedHandoff>()

  for (const event of events) {
    const key = `${event.sessionId}\u0000${event.provenance.originatingTurnId}`
    const current = handoffsByTurn.get(key)

    if (current && current.latestSequence >= event.sequence) continue

    handoffsByTurn.set(key, {
      id: `handoff:${event.sessionId}:${event.provenance.originatingTurnId}`,
      sessionId: event.sessionId,
      originatingTurnId: event.provenance.originatingTurnId,
      originatingUserMessageId: event.provenance.originatingUserMessageId,
      timelineAt: current?.timelineAt ?? event.observedAt,
      phase: event.phase,
      target: event.target,
      provenance: {
        attachmentIds: event.provenance.attachmentIds,
        artifactIds: event.provenance.artifactIds
      },
      ...(event.continuation ? { continuation: event.continuation } : {}),
      ...(event.failure ? { failure: event.failure } : {}),
      latestSequence: event.sequence
    })
  }

  const projections: HandoffTranscriptProjection[] = []
  for (const handoff of Array.from(handoffsByTurn.values()).sort(
    (left, right) => left.timelineAt - right.timelineAt || left.id.localeCompare(right.id)
  )) {
    projections.push({
      id: handoff.id,
      sessionId: handoff.sessionId,
      originatingTurnId: handoff.originatingTurnId,
      originatingUserMessageId: handoff.originatingUserMessageId,
      timelineAt: handoff.timelineAt,
      phase: handoff.phase,
      target: handoff.target,
      provenance: handoff.provenance,
      ...(handoff.continuation ? { continuation: handoff.continuation } : {}),
      ...(handoff.failure ? { failure: handoff.failure } : {})
    })
  }

  return projections
}

export { projectHandoffLifecycle }
