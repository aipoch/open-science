import {
  type PersistedConversationGraph,
  type PersistedAgentFrame,
  type PersistedMessageBranch,
  type PersistedMessageNode,
  type PersistedRuntimeSegment,
  type PersistedBranchActivity,
  type PersistedBranchActivityGroup,
  validateConversationGraph,
  materializeNestedDelegateActivities
} from '../conversation-graph'
import { isRecord, asString, asNumber } from './primitives'
import { sanitizeMessage } from './message-codec'
import { normalizeMessageAfterRestore, normalizeActivityGroupAfterRestore } from './restore'
import { sanitizeToolActivity, sanitizeActivityGroup } from './tool-activity'

export const sanitizeConversationGraph = (
  value: unknown,
  options: { preserveLegacyUploadPaths?: boolean; preserveRuntimeState?: boolean } = {}
): PersistedConversationGraph | undefined => {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined
  const rootFrameId = asString(value.rootFrameId)
  const activeFrameId = asString(value.activeFrameId)
  if (!rootFrameId || !activeFrameId) return undefined

  const frames = Array.isArray(value.frames)
    ? value.frames.flatMap((candidate): PersistedAgentFrame[] => {
        if (!isRecord(candidate)) return []
        const id = asString(candidate.id)
        const activeBranchId = asString(candidate.activeBranchId)
        const kind = asString(candidate.kind) as PersistedAgentFrame['kind'] | undefined
        const originBindingState = asString(candidate.originBindingState) as
          PersistedAgentFrame['originBindingState'] | undefined
        const status = asString(candidate.status) as PersistedAgentFrame['status'] | undefined
        const createdAt = asNumber(candidate.createdAt)
        if (
          !id ||
          !activeBranchId ||
          !kind ||
          !['root', 'reviewer', 'delegate', 'compatibility'].includes(kind) ||
          !originBindingState ||
          !['root', 'validated', 'legacy-unavailable'].includes(originBindingState) ||
          !status ||
          !['running', 'completed', 'cancelled', 'error'].includes(status) ||
          createdAt === undefined
        ) {
          return []
        }
        return [
          {
            id,
            activeBranchId,
            kind,
            originBindingState,
            status,
            createdAt,
            ...(asString(candidate.parentFrameId)
              ? { parentFrameId: asString(candidate.parentFrameId) }
              : {}),
            ...(asString(candidate.originMessageId)
              ? { originMessageId: asString(candidate.originMessageId) }
              : {}),
            ...(asString(candidate.agentName) ? { agentName: asString(candidate.agentName) } : {}),
            ...(asString(candidate.delegateName)
              ? { delegateName: asString(candidate.delegateName) }
              : {}),
            ...(asString(candidate.linkedReviewId)
              ? { linkedReviewId: asString(candidate.linkedReviewId) }
              : {}),
            ...(asNumber(candidate.completedAt) !== undefined
              ? { completedAt: asNumber(candidate.completedAt) }
              : {})
          }
        ]
      })
    : []
  const branches = Array.isArray(value.branches)
    ? value.branches.flatMap((candidate): PersistedMessageBranch[] => {
        if (!isRecord(candidate)) return []
        const id = asString(candidate.id)
        const agentFrameId = asString(candidate.agentFrameId)
        const createdAt = asNumber(candidate.createdAt)
        const updatedAt = asNumber(candidate.updatedAt)
        if (!id || !agentFrameId || createdAt === undefined || updatedAt === undefined) return []
        return [
          {
            id,
            agentFrameId,
            createdAt,
            updatedAt,
            ...(asString(candidate.parentBranchId)
              ? { parentBranchId: asString(candidate.parentBranchId) }
              : {}),
            ...(asString(candidate.forkMessageId)
              ? { forkMessageId: asString(candidate.forkMessageId) }
              : {}),
            ...(asString(candidate.forkActivityId)
              ? { forkActivityId: asString(candidate.forkActivityId) }
              : {}),
            ...(asString(candidate.supersededMessageId)
              ? { supersededMessageId: asString(candidate.supersededMessageId) }
              : {}),
            ...(asString(candidate.headMessageId)
              ? { headMessageId: asString(candidate.headMessageId) }
              : {}),
            ...(asString(candidate.workspaceCheckpointId)
              ? { workspaceCheckpointId: asString(candidate.workspaceCheckpointId) }
              : {})
          }
        ]
      })
    : []
  const messages = Array.isArray(value.messages)
    ? value.messages.flatMap((candidate): PersistedMessageNode[] => {
        if (!isRecord(candidate)) return []
        const message = sanitizeMessage(candidate, options)
        const agentFrameId = asString(candidate.agentFrameId)
        const introducedOnBranchId = asString(candidate.introducedOnBranchId)
        if (!message || !agentFrameId || !introducedOnBranchId) return []
        return [
          {
            ...(options.preserveRuntimeState ? message : normalizeMessageAfterRestore(message)),
            agentFrameId,
            introducedOnBranchId,
            ...(asString(candidate.parentMessageId)
              ? { parentMessageId: asString(candidate.parentMessageId) }
              : {}),
            ...(asString(candidate.revisionRootMessageId)
              ? { revisionRootMessageId: asString(candidate.revisionRootMessageId) }
              : {}),
            ...(asString(candidate.supersedesMessageId)
              ? { supersedesMessageId: asString(candidate.supersedesMessageId) }
              : {}),
            ...(asString(candidate.runtimeSegmentId)
              ? { runtimeSegmentId: asString(candidate.runtimeSegmentId) }
              : {})
          }
        ]
      })
    : []
  const runtimeSegments = Array.isArray(value.runtimeSegments)
    ? value.runtimeSegments.flatMap((candidate): PersistedRuntimeSegment[] => {
        if (!isRecord(candidate)) return []
        const id = asString(candidate.id)
        const agentFrameId = asString(candidate.agentFrameId)
        const frameworkId = asString(candidate.frameworkId)
        const startedAt = asNumber(candidate.startedAt)
        if (!id || !agentFrameId || !frameworkId || startedAt === undefined) {
          return []
        }
        return [
          {
            id,
            agentFrameId,
            frameworkId,
            startedAt,
            ...(asString(candidate.providerId)
              ? { providerId: asString(candidate.providerId) }
              : {}),
            ...(asString(candidate.backendId) ? { backendId: asString(candidate.backendId) } : {}),
            ...(asString(candidate.agentName) ? { agentName: asString(candidate.agentName) } : {}),
            ...(asString(candidate.model) ? { model: asString(candidate.model) } : {}),
            ...(asNumber(candidate.endedAt) !== undefined
              ? { endedAt: asNumber(candidate.endedAt) }
              : {})
          }
        ]
      })
    : []
  const activities = Array.isArray(value.activities)
    ? value.activities.flatMap((candidate): PersistedBranchActivity[] => {
        if (!isRecord(candidate)) return []
        const activity = sanitizeToolActivity(candidate)
        const agentFrameId = asString(candidate.agentFrameId)
        const messageBranchId = asString(candidate.messageBranchId)
        const promptMessageId = asString(candidate.promptMessageId)
        const runtimeSegmentId = asString(candidate.runtimeSegmentId)
        return activity && agentFrameId && messageBranchId && promptMessageId && runtimeSegmentId
          ? [
              {
                ...activity,
                agentFrameId,
                messageBranchId,
                promptMessageId,
                runtimeSegmentId
              }
            ]
          : []
      })
    : []
  const activityGroups = Array.isArray(value.activityGroups)
    ? value.activityGroups.flatMap((candidate): PersistedBranchActivityGroup[] => {
        if (!isRecord(candidate)) return []
        const group = sanitizeActivityGroup(candidate)
        const agentFrameId = asString(candidate.agentFrameId)
        const messageBranchId = asString(candidate.messageBranchId)
        const promptMessageId = asString(candidate.promptMessageId)
        return group && agentFrameId && messageBranchId && promptMessageId
          ? [
              {
                ...(options.preserveRuntimeState
                  ? group
                  : normalizeActivityGroupAfterRestore(group)),
                agentFrameId,
                messageBranchId,
                promptMessageId
              }
            ]
          : []
      })
    : []
  const graph: PersistedConversationGraph = {
    schemaVersion: 1,
    rootFrameId,
    activeFrameId,
    frames,
    branches,
    messages,
    activities,
    activityGroups,
    runtimeSegments
  }
  try {
    validateConversationGraph(graph)
    return materializeNestedDelegateActivities(graph)
  } catch {
    return undefined
  }
}
