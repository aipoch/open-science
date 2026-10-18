import type { PersistedBranchActivity } from './conversation-graph'

type RuntimeToolScope = Pick<
  PersistedBranchActivity,
  'agentFrameId' | 'messageBranchId' | 'promptMessageId' | 'runtimeSegmentId'
>

// Codex startup ids identify a server, not a globally unique invocation. Main and renderer
// must use the same activity identity before and after the durable projection arrives.
export const resolveRuntimeToolActivityId = (
  providerToolCallId: string,
  scope: RuntimeToolScope,
  activities: readonly PersistedBranchActivity[]
): string => {
  if (!providerToolCallId.startsWith('mcp_startup.')) return providerToolCallId
  const id = `runtime-mcp-startup:${JSON.stringify([
    scope.agentFrameId,
    scope.messageBranchId,
    scope.promptMessageId,
    scope.runtimeSegmentId,
    providerToolCallId
  ])}`
  if (activities.some((activity) => activity.id === id)) return id
  // Keep historical references intact, but never reuse a legacy id from another scope.
  return activities.some(
    (activity) =>
      activity.id === providerToolCallId &&
      activity.agentFrameId === scope.agentFrameId &&
      activity.messageBranchId === scope.messageBranchId &&
      activity.promptMessageId === scope.promptMessageId &&
      activity.runtimeSegmentId === scope.runtimeSegmentId
  )
    ? providerToolCallId
    : id
}
