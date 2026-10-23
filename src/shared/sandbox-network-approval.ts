import type { AcpPermissionRequest } from './acp-permission-contract'
import {
  resolveActiveConversationMessages,
  type PersistedConversationGraph
} from './conversation-graph'

// A destination decision is authority for one execution, never a replayable shell command.
export type SandboxNetworkApproval = Readonly<{
  version: 1
  kind: 'sandbox-network'
  state: 'pending' | 'continuing'
  decision?: 'always-allow'
  requestId: string
  sessionId: string
  executionId: string
  commandFingerprint: string
  hostname: string
  port: number
  runtime: 'bash'
  originatingPromptMessageId: string
  agentFrameId: string
  messageBranchId: string
  createdAt: number
}>

export const sandboxNetworkApprovalRequest = (
  approval: SandboxNetworkApproval,
  restored = false
): AcpPermissionRequest => ({
  requestId: approval.requestId,
  sessionId: approval.sessionId,
  toolCallId: `app-approval:${approval.requestId}`,
  appOwned: true,
  durable: true,
  providerToolName: 'Open-Science',
  title: `Connect to ${approval.hostname}?`,
  rawInput: {
    notebookNetworkApproval: {
      hostname: approval.hostname,
      port: approval.port,
      runtime: approval.runtime,
      ...(restored ? { retryRequired: true } : {})
    }
  },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once', scope: 'once' },
    { optionId: 'always-allow', name: 'Global', kind: 'allow_always', scope: 'global' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
  ]
})

type NetworkApprovalSession = Readonly<{
  id?: string
  conversationGraph?: PersistedConversationGraph
  runtimeContext?: { networkApprovals?: readonly SandboxNetworkApproval[] }
}>

export const activeSandboxNetworkApprovals = (
  session: NetworkApprovalSession
): readonly SandboxNetworkApproval[] => {
  const graph = session.conversationGraph
  const frame = graph?.frames.find(({ id }) => id === graph.activeFrameId)
  if (!graph || !frame) return []
  const messages = resolveActiveConversationMessages(graph)
  return (session.runtimeContext?.networkApprovals ?? []).filter(
    (approval) =>
      approval.sessionId === session.id &&
      approval.agentFrameId === frame.id &&
      approval.messageBranchId === frame.activeBranchId &&
      messages.some(({ id, role }) => id === approval.originatingPromptMessageId && role === 'user')
  )
}

export const hasPendingSandboxNetworkApproval = (session: NetworkApprovalSession): boolean =>
  activeSandboxNetworkApprovals(session).some(({ state }) => state === 'pending')
