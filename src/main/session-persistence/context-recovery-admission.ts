import type { AcpPromptRequest } from '../../shared/acp'
import { resolveMessageBranchPath } from '../../shared/conversation-graph'
import {
  recoverySourceBranch,
  type PersistedChatSession,
  type SessionContextRecoveryRecord
} from '../../shared/session-persistence'

/** Re-arm precisely the failed user turn under Main's durable recovery receipt. The original
 * message and all previous execution segments remain immutable historical evidence. */
export const admitContextRecoveryContinuation = (
  session: PersistedChatSession,
  request: AcpPromptRequest,
  now: number
): { session: PersistedChatSession; request: AcpPromptRequest } => {
  const record = session.runtimeContext?.contextRecovery
  const graph = session.conversationGraph
  const frame = graph?.frames.find(({ id }) => id === graph.activeFrameId)
  const promptId = request.provenanceContext?.promptMessageId
  const prompt = graph?.messages.find(({ id }) => id === promptId)
  if (
    !record ||
    record.phase !== 'continuing' ||
    record.sourceBranch !== recoverySourceBranch(session) ||
    !graph ||
    !frame ||
    !prompt ||
    prompt.role !== 'user' ||
    session.activeRun ||
    (record.failedPromptMessageId && record.failedPromptMessageId !== prompt.id) ||
    !resolveMessageBranchPath(graph, frame.activeBranchId).some(({ id }) => id === prompt.id) ||
    !prompt.runtimeSegmentId
  )
    throw new Error('Recovery continuation no longer owns the failed conversation turn.')
  const runtimeSegmentId = `context-recovery-${record.id}`
  if (graph.runtimeSegments.some(({ id }) => id === runtimeSegmentId)) {
    throw new Error(
      'Recovery continuation has already been admitted; its outcome must be verified.'
    )
  }
  const startedAt = Math.max(
    now,
    (session.runtimeTranscriptLastRun?.startedAt ?? 0) + 1,
    ...graph.runtimeSegments.map(({ startedAt }) => startedAt + 1)
  )
  const provenanceContext = {
    promptMessageId: prompt.id,
    agentFrameId: frame.id,
    messageBranchId: frame.activeBranchId,
    runtimeSegmentId
  }
  return {
    request: { ...request, provenanceContext },
    session: {
      ...session,
      status: 'running',
      error: undefined,
      errorReportable: undefined,
      activeRun: { promptMessageId: prompt.id, startedAt },
      runtimeTranscriptOwner: 'main',
      runtimeSessionAdmissions: [
        ...(session.runtimeSessionAdmissions ?? []),
        {
          executionId: runtimeSegmentId,
          ...provenanceContext,
          rootFrameId: graph.rootFrameId,
          promptRuntimeSegmentId: prompt.runtimeSegmentId
        }
      ],
      conversationGraph: {
        ...graph,
        runtimeSegments: [
          ...graph.runtimeSegments,
          {
            id: runtimeSegmentId,
            agentFrameId: frame.id,
            frameworkId: 'opencode',
            providerId: session.agentConfiguration?.providerId,
            model: session.agentModel,
            startedAt
          }
        ]
      }
    }
  }
}

export const abandonContextRecoveryAdmission = (
  session: PersistedChatSession
): PersistedChatSession => {
  const record = session.runtimeContext?.contextRecovery
  if (!record || record.phase !== 'continuing') return session
  const id = `context-recovery-${record.id}`
  if (
    !session.runtimeSessionAdmissions?.some(({ executionId }) => executionId === id) ||
    session.activeRun?.promptMessageId !== record.failedPromptMessageId
  )
    return session
  return {
    ...session,
    activeRun: undefined,
    status: 'error',
    runtimeSessionAdmissions: session.runtimeSessionAdmissions.filter(
      ({ executionId }) => executionId !== id
    ),
    conversationGraph: session.conversationGraph
      ? {
          ...session.conversationGraph,
          runtimeSegments: session.conversationGraph.runtimeSegments.filter(
            (segment) => segment.id !== id
          )
        }
      : undefined
  }
}

// Called inside the Session mutation queue. The first write compares the previously observed
// episode (null means absent); every later callback compares its own episode, including binding
// commits. A timed-out provider callback must never overwrite a successor's durable authority.
export const updateContextRecoveryRecord = (
  session: PersistedChatSession,
  record: SessionContextRecoveryRecord,
  expectedRecoveryId: string | null,
  providerSessionId?: string
): PersistedChatSession => {
  if ((session.runtimeContext?.contextRecovery?.id ?? null) !== expectedRecoveryId) {
    throw new Error('Context recovery was superseded by another recovery episode.')
  }
  if (providerSessionId && recoverySourceBranch(session) !== record.sourceBranch) {
    throw new Error('The conversation branch changed before the recovery binding committed.')
  }
  return {
    ...session,
    ...(providerSessionId ? { providerSessionId } : {}),
    ...(record.phase === 'ready' && !session.activeRun
      ? { status: 'idle' as const, error: undefined, errorReportable: undefined }
      : {}),
    runtimeContext: {
      ...session.runtimeContext,
      version: 1,
      revision: (session.runtimeContext?.revision ?? 0) + 1,
      contextRecovery: record
    }
  }
}
