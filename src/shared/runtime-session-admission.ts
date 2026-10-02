import type { PersistedChatSession, PersistedRuntimeSessionAdmission } from './session-persistence'

// Passed only along Main's internal continuation boundary, never in an ACP request body.
export type SettlementAdmission = Readonly<{
  batchId: string
  projectId: string
  sessionId: string
  rootFrameId: string
  originatingPromptId: string
  rootBranchId: string
  rootBranchRevision: string
  promptRuntimeSegmentId: string
  items: readonly Readonly<{
    frameId: string
    attemptId: string
    status: 'completed' | 'cancelled' | 'error'
  }>[]
}>

export class SettlementAdmissionError extends Error {
  constructor(
    readonly reason: string,
    readonly disposition: 'retry' | 'deferred' | 'invalidated',
    cause?: unknown
  ) {
    super(
      `Settlement admission ${disposition}: ${reason}`,
      cause === undefined ? undefined : { cause }
    )
    this.name = 'SettlementAdmissionError'
  }
}

// The Session's Main-owned admission proves that this execution path may retain a prompt from an
// older Segment. Execution ids differ across legitimate continuations, so match the durable path.
export const hasDurableRuntimeSessionAdmission = (
  session: PersistedChatSession,
  context: Pick<
    PersistedRuntimeSessionAdmission,
    'rootFrameId' | 'agentFrameId' | 'messageBranchId' | 'runtimeSegmentId' | 'promptMessageId'
  >,
  promptRuntimeSegmentId: string
): boolean =>
  session.runtimeTranscriptOwner === 'main' &&
  session.runtimeSessionAdmissions?.some(
    (admission) =>
      admission.rootFrameId === context.rootFrameId &&
      admission.agentFrameId === context.agentFrameId &&
      admission.messageBranchId === context.messageBranchId &&
      admission.runtimeSegmentId === context.runtimeSegmentId &&
      admission.promptMessageId === context.promptMessageId &&
      admission.promptRuntimeSegmentId === promptRuntimeSegmentId
  ) === true
