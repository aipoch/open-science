import type { PersistedChatSession, PersistedRuntimeSessionAdmission } from './session-persistence'

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
