import { type PermissionProfileId } from '../../shared/permission-profiles'
import { createSessionBranchSource } from '../../shared/session-branch-source'
import {
  SESSION_DETAILS_TITLE_MAX_LENGTH,
  latestOutcomePrompt,
  resolveTurnOutcome,
  type PersistedChatMessage,
  type PersistedChatSession
} from '../../shared/session-persistence'

export const nextForkTitle = (sourceTitle: string, existingTitles: readonly string[]): string => {
  const titles = new Set(existingTitles)
  for (let index = 2; ; index += 1) {
    const suffix = `(${index})`
    const limit = SESSION_DETAILS_TITLE_MAX_LENGTH - suffix.length
    let prefix = sourceTitle
    if (prefix.length > limit) {
      let end = 0
      // Keep UTF-16 length within the shared limit without splitting a visible character.
      for (const { index, segment } of new Intl.Segmenter(undefined, {
        granularity: 'grapheme'
      }).segment(sourceTitle)) {
        if (index + segment.length > limit) break
        end = index + segment.length
      }
      prefix = sourceTitle.slice(0, end)
    }
    const title = `${prefix}${suffix}`
    if (!titles.has(title)) return title
  }
}

// Fork clears the source's live status, error and recovery fields, so a legacy failed latest turn
// would otherwise lose its failure. Persist it on the copied Message to keep it as history.
// Interrupted/cancelled legacy turns have no historical presentation and stay unmaterialized.
// The Artifact publication retry is dropped: it targets the source's pending files, not the copies.
const withLegacyFailedOutcome = <T extends PersistedChatMessage>(
  copiedMessages: readonly T[],
  sourceMessages: readonly PersistedChatMessage[],
  anchorId: string,
  outcome: PersistedChatMessage['turnOutcome']
): T[] => {
  const index = sourceMessages.findIndex((message) => message.id === anchorId)
  return copiedMessages.map((message, copiedIndex) =>
    copiedIndex === index ? { ...message, turnOutcome: outcome } : message
  )
}

// The package copier owns data identities and evidence; this policy owns the new Session's
// execution state. Historical operations stay historical and never acquire live handles.
export const createForkSession = (
  copied: PersistedChatSession,
  source: PersistedChatSession,
  permissionProfile: PermissionProfileId,
  title: string
): PersistedChatSession => {
  const now = Date.now()
  const anchor = latestOutcomePrompt(source)
  const legacyOutcome =
    anchor && !anchor.turnOutcome ? resolveTurnOutcome(source, anchor.id) : undefined
  if (anchor && legacyOutcome?.kind === 'failed') {
    const failure: PersistedChatMessage['turnOutcome'] = {
      kind: 'failed',
      settledAt: legacyOutcome.settledAt,
      error: legacyOutcome.error,
      errorReportable: legacyOutcome.errorReportable
    }
    copied.messages = withLegacyFailedOutcome(copied.messages, source.messages, anchor.id, failure)
    if (copied.conversationGraph && source.conversationGraph)
      copied.conversationGraph.messages = withLegacyFailedOutcome(
        copied.conversationGraph.messages,
        source.conversationGraph.messages,
        anchor.id,
        failure
      )
  }
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
    researchMembership: undefined,
    packageOrigin: undefined,
    forkOrigin: copied.packageOrigin,
    forkHeadMessageId:
      createSessionBranchSource(copied).headMessageId ?? copied.messages.at(-1)?.id,
    title,
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
    promptPreparation: undefined,
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
