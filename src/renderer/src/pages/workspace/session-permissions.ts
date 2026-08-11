import type { AcpPermissionRequest } from '../../../../shared/acp'
import type { PersistedConversationGraph } from '../../../../shared/conversation-graph'
import { resolveActiveRootMessageIds } from './subagent-release-projection'

// Limits visible permission controls to the conversation currently on screen.
const getVisiblePermissionRequests = (
  pendingPermissions: AcpPermissionRequest[],
  activeSessionId: string | undefined,
  conversationGraph?: PersistedConversationGraph
): AcpPermissionRequest[] => {
  if (!activeSessionId) return []

  // A malformed graph cannot safely authorize a delegated response. Preserve root permission
  // visibility, but fail closed for every delegated card until the durable graph is repaired.
  const activeRootMessageIds = conversationGraph
    ? resolveActiveRootMessageIds(conversationGraph)
    : undefined
  return pendingPermissions.filter((request) => {
    if (request.sessionId !== activeSessionId) return false
    if (!request.delegated) return true
    const child = conversationGraph?.frames.find((frame) => frame.id === request.delegated?.frameId)
    return (
      child?.originBindingState === 'validated' &&
      Boolean(child.originMessageId && activeRootMessageIds?.has(child.originMessageId))
    )
  })
}

const hasBlockingRootPermissionRequest = (
  pendingPermissions: readonly AcpPermissionRequest[],
  activeSessionId: string | undefined
): boolean =>
  Boolean(
    activeSessionId &&
    pendingPermissions.some(
      (request) => request.sessionId === activeSessionId && request.delegated === undefined
    )
  )

export { getVisiblePermissionRequests, hasBlockingRootPermissionRequest }
