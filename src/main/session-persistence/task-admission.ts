import { ensureConversationRuntimeSegment } from '../../shared/conversation-graph'
import {
  materializeSessionConversationGraph,
  type BindTaskSessionRequest,
  type PersistedChatSession
} from '../../shared/session-persistence'

export const rebaseTaskSessionBinding = (
  latest: PersistedChatSession,
  { session, contextReset }: BindTaskSessionRequest
): PersistedChatSession => ({
  ...latest,
  cwd: session.cwd,
  permissionProfile: session.permissionProfile,
  agentFrameworkId: session.agentFrameworkId,
  agentBackendId: session.agentBackendId,
  providerSessionId: session.providerSessionId,
  providerContinuityToken: session.providerContinuityToken,
  agentConfiguration: session.agentConfiguration,
  ...(contextReset && !latest.pendingHistoryReplay
    ? { pendingHistoryReplay: { kind: 'all' } as const }
    : {}),
  updatedAt: Math.max(latest.updatedAt + 1, session.updatedAt)
})

export const rebaseTaskTurnOntoLatestSession = (
  latest: PersistedChatSession,
  prepared: PersistedChatSession,
  contextReset: boolean
): PersistedChatSession => {
  const activeRun = prepared.activeRun
  const promptMessageId = activeRun?.promptMessageId
  const userMessage = prepared.messages.find((message) => message.id === promptMessageId)
  if (!activeRun || !userMessage) {
    throw new Error('Task prompt admission is missing its prepared user message.')
  }

  let rebased: PersistedChatSession = {
    ...latest,
    cwd: prepared.cwd,
    status: 'running',
    permissionProfile: prepared.permissionProfile,
    autoReviewEnabled: prepared.autoReviewEnabled,
    delegationPolicy: prepared.delegationPolicy,
    specialistId: prepared.specialistId,
    agentFrameworkId: prepared.agentFrameworkId,
    agentBackendId: prepared.agentBackendId,
    providerSessionId: prepared.providerSessionId,
    providerContinuityToken: prepared.providerContinuityToken,
    agentConfiguration: prepared.agentConfiguration,
    messages: [...latest.messages.filter((message) => message.id !== userMessage.id), userMessage],
    activeRun,
    error: undefined,
    updatedAt: prepared.updatedAt
  }
  delete rebased.resumeRecovery

  const currentGraph = materializeSessionConversationGraph(latest).conversationGraph
  const graphWithRuntime = ensureConversationRuntimeSegment(currentGraph, {
    id: `runtime-segment-${promptMessageId}`,
    frameworkId: rebased.agentFrameworkId ?? 'claude-code',
    providerId: rebased.agentConfiguration?.providerId,
    backendId: rebased.agentBackendId,
    model: rebased.agentModel,
    startedAt: activeRun.startedAt,
    forceNew: contextReset
  })
  if (graphWithRuntime.runtimeSegments.length !== currentGraph.runtimeSegments.length) {
    rebased = materializeSessionConversationGraph({
      ...rebased,
      conversationGraph: graphWithRuntime
    })
  }
  return rebased
}
