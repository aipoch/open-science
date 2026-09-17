import { type PermissionProfileId } from '../../shared/permission-profiles'
import { createSessionBranchSource } from '../../shared/session-branch-source'
import {
  SESSION_DETAILS_TITLE_MAX_LENGTH,
  type PersistedChatSession
} from '../../shared/session-persistence'

// The package copier owns data identities and evidence; this policy owns the new Session's
// execution state. Historical operations stay historical and never acquire live handles.
export const createForkSession = (
  copied: PersistedChatSession,
  source: PersistedChatSession,
  permissionProfile: PermissionProfileId
): PersistedChatSession => {
  const now = Date.now()
  const graph = copied.conversationGraph
  if (graph) {
    graph.messages = graph.messages.map((message, index) => ({
      ...message,
      streamId: undefined,
      eventIds: [],
      usageOrigin: source.conversationGraph?.messages[index]?.usageOrigin ?? {
        sessionId: source.id,
        messageId: source.conversationGraph?.messages[index]?.id ?? message.id
      }
    }))
  }
  return {
    ...copied,
    packageOrigin: undefined,
    forkOrigin: copied.packageOrigin,
    title: `${source.title.slice(0, SESSION_DETAILS_TITLE_MAX_LENGTH - 7)} (Fork)`,
    description: source.description,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    archivedAt: undefined,
    branchSource: createSessionBranchSource(source),
    sessionDetailsGeneration: undefined,
    sessionDetailsGenerationEligible: undefined,
    // Imported configurations belong to another installation. Use the receiving app's model
    // defaults; local forks keep the user's desired model configuration.
    cwd: source.packageOrigin ? '' : source.cwd,
    agentFrameworkId: source.packageOrigin ? undefined : source.agentFrameworkId,
    agentBackendId: source.packageOrigin ? undefined : source.agentBackendId,
    agentModel: source.packageOrigin ? undefined : source.agentModel,
    agentConfiguration: source.packageOrigin ? undefined : source.agentConfiguration,
    permissionProfile,
    memoryEnabled: source.packageOrigin ? true : source.memoryEnabled,
    delegationPolicy: source.packageOrigin ? 'allow' : source.delegationPolicy,
    autoReviewEnabled: source.packageOrigin ? false : source.autoReviewEnabled,
    enabledComputeHosts: source.packageOrigin ? [] : source.enabledComputeHosts,
    selectedComputeHosts: source.packageOrigin ? [] : source.selectedComputeHosts,
    computeConcurrencyLimit: source.packageOrigin ? undefined : source.computeConcurrencyLimit,
    specialistId: source.packageOrigin ? undefined : source.specialistId,
    providerSessionId: undefined,
    providerContinuityToken: undefined,
    status: 'idle',
    activeRun: undefined,
    resumeRecovery: undefined,
    taskRunCommitId: undefined,
    error: undefined,
    errorReportable: undefined,
    artifactErrorEventIds: undefined,
    contextUsage: undefined,
    pendingHistoryReplay: { kind: 'all' },
    branchContextResetRequired: true,
    runtimeContext: copied.runtimeContext
      ? {
          ...copied.runtimeContext,
          revision: 0,
          permission: undefined,
          sideChat: undefined,
          sideChats: undefined,
          sideChatRelays: undefined,
          plan: copied.runtimeContext.plan
            ? { ...copied.runtimeContext.plan, delivery: undefined }
            : undefined
        }
      : undefined
  }
}

export class ForkRecoveryRequiredError extends Error {
  constructor(
    readonly recovery: {
      projectId: string
      sessionId: string
      operationId: string
      outcome: 'committed' | 'unconfirmed'
    },
    cause: unknown
  ) {
    super('Fork publication requires recovery.', { cause })
  }
}
