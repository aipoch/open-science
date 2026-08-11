import {
  resolveMessageBranchPath,
  validateConversationGraph,
  type PersistedConversationGraph,
  type PersistedMessageNode
} from './conversation-graph'
import type { PersistedChatSession } from './session-persistence'

type RootArtifactPlacement = Readonly<{
  rootMessageId: string
  toolInvocationId: string
  artifactVersionId: string
  ownerMessageId: string
  childPromptMessageId: string
  childFrameId: string
}>

type ArtifactVisibilityDiagnostic = Readonly<{
  code:
    | 'invalid-conversation-graph'
    | 'invalid-root-branch'
    | 'caller-message-not-on-root-branch'
    | 'caller-invocation-not-on-root-turn'
    | 'owner-without-child-prompt'
    | 'legacy-source-unavailable'
  messageId?: string
  childFrameId?: string
}>

type RootArtifactVisibilityProjection = Readonly<{
  placements: readonly RootArtifactPlacement[]
  diagnostics: readonly ArtifactVisibilityDiagnostic[]
}>

const promptForOwner = (
  graph: PersistedConversationGraph,
  owner: PersistedMessageNode
): PersistedMessageNode | undefined => {
  const messages = new Map(graph.messages.map((message) => [message.id, message]))
  const direct = owner.responseToMessageId ? messages.get(owner.responseToMessageId) : undefined
  if (direct && (direct.role !== 'user' || direct.agentFrameId !== owner.agentFrameId)) {
    return undefined
  }
  const seen = new Set<string>()
  let currentId = owner.parentMessageId
  while (currentId) {
    if (seen.has(currentId)) return undefined
    seen.add(currentId)
    const current = messages.get(currentId)
    if (!current || current.agentFrameId !== owner.agentFrameId) return undefined
    if (current.role === 'user') return direct && current.id !== direct.id ? undefined : current
    currentId = current.parentMessageId
  }
  return undefined
}

const sourceForPrompt = (
  graph: PersistedConversationGraph,
  prompt: PersistedMessageNode
): Readonly<{ rootMessageId: string; toolInvocationId: string }> | undefined => {
  if (prompt.delegatedCallerSource) {
    return {
      rootMessageId: prompt.delegatedCallerSource.rootMessageId,
      toolInvocationId: prompt.delegatedCallerSource.toolInvocationId
    }
  }
  const frame = graph.frames.find(({ id }) => id === prompt.agentFrameId)
  if (!frame || frame.originBindingState !== 'validated' || frame.originMessageId === undefined) {
    return undefined
  }
  const framePrompts = graph.messages
    .filter((message) => message.agentFrameId === frame.id && message.role === 'user')
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  if (framePrompts[0]?.id !== prompt.id) return undefined
  const hasExactFrameReceipt = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const receipt = value as Record<string, unknown>
    if (receipt.frameId === frame.id) return true
    return (
      Array.isArray(receipt.children) &&
      receipt.children.some(
        (child) =>
          child !== null &&
          typeof child === 'object' &&
          !Array.isArray(child) &&
          (child as Record<string, unknown>).frameId === frame.id
      )
    )
  }
  const candidates = graph.activities.filter(
    (activity) =>
      activity.agentFrameId === graph.rootFrameId &&
      activity.promptMessageId === frame.originMessageId &&
      activity.status === 'completed' &&
      hasExactFrameReceipt(activity.rawOutput)
  )
  return candidates.length === 1
    ? { rootMessageId: frame.originMessageId, toolInvocationId: candidates[0].id }
    : undefined
}

const projectRootArtifactVisibility = (
  session: PersistedChatSession,
  rootBranchId: string
): RootArtifactVisibilityProjection => {
  const graph = session.conversationGraph
  const diagnostics: ArtifactVisibilityDiagnostic[] = []
  if (!graph) return { placements: [], diagnostics: [{ code: 'invalid-conversation-graph' }] }
  try {
    validateConversationGraph(graph)
  } catch {
    return { placements: [], diagnostics: [{ code: 'invalid-conversation-graph' }] }
  }
  const rootBranch = graph.branches.find(
    (branch) => branch.id === rootBranchId && branch.agentFrameId === graph.rootFrameId
  )
  if (!rootBranch) return { placements: [], diagnostics: [{ code: 'invalid-root-branch' }] }
  const rootPath = resolveMessageBranchPath(graph, rootBranch.id)
  const rootMessages = new Set(rootPath.map(({ id }) => id))
  const rootBranchLineage = new Set<string>()
  let lineageBranch: typeof rootBranch | undefined = rootBranch
  while (lineageBranch) {
    rootBranchLineage.add(lineageBranch.id)
    lineageBranch = lineageBranch.parentBranchId
      ? graph.branches.find(({ id }) => id === lineageBranch!.parentBranchId)
      : undefined
  }
  const placementKeys = new Set<string>()
  const placements: RootArtifactPlacement[] = []

  const owners = graph.messages
    .filter(
      (message) =>
        message.role === 'agent' &&
        message.status === 'complete' &&
        message.agentFrameId !== graph.rootFrameId &&
        (message.artifactIds?.length ?? 0) > 0
    )
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  for (const owner of owners) {
    const prompt = promptForOwner(graph, owner)
    const sameHistoricalBranch = prompt
      ? graph.branches
          .filter(({ agentFrameId }) => agentFrameId === owner.agentFrameId)
          .some((branch) => {
            const ids = new Set(resolveMessageBranchPath(graph, branch.id).map(({ id }) => id))
            return ids.has(prompt.id) && ids.has(owner.id)
          })
      : false
    if (!prompt || !sameHistoricalBranch) {
      diagnostics.push({
        code: 'owner-without-child-prompt',
        messageId: owner.id,
        childFrameId: owner.agentFrameId
      })
      continue
    }
    const source = sourceForPrompt(graph, prompt)
    if (!source) {
      diagnostics.push({
        code: 'legacy-source-unavailable',
        messageId: prompt.id,
        childFrameId: prompt.agentFrameId
      })
      continue
    }
    if (!rootMessages.has(source.rootMessageId)) {
      diagnostics.push({
        code: 'caller-message-not-on-root-branch',
        messageId: source.rootMessageId,
        childFrameId: prompt.agentFrameId
      })
      continue
    }
    const invocation = graph.activities.find(
      (activity) =>
        activity.id === source.toolInvocationId &&
        activity.agentFrameId === graph.rootFrameId &&
        rootBranchLineage.has(activity.messageBranchId) &&
        activity.promptMessageId === source.rootMessageId
    )
    if (!invocation) {
      diagnostics.push({
        code: 'caller-invocation-not-on-root-turn',
        messageId: source.rootMessageId,
        childFrameId: prompt.agentFrameId
      })
      continue
    }
    for (const artifactVersionId of owner.artifactIds ?? []) {
      const key = `${source.rootMessageId}\u0000${source.toolInvocationId}\u0000${artifactVersionId}`
      if (placementKeys.has(key)) continue
      placementKeys.add(key)
      placements.push({
        rootMessageId: source.rootMessageId,
        toolInvocationId: source.toolInvocationId,
        artifactVersionId,
        ownerMessageId: owner.id,
        childPromptMessageId: prompt.id,
        childFrameId: prompt.agentFrameId
      })
    }
  }
  const rootOrder = new Map(rootPath.map((message, index) => [message.id, index]))
  const invocationOrder = new Map(
    graph.activities.map((activity) => [activity.id, activity.sortIndex])
  )
  placements.sort(
    (left, right) =>
      (rootOrder.get(left.rootMessageId) ?? Number.MAX_SAFE_INTEGER) -
        (rootOrder.get(right.rootMessageId) ?? Number.MAX_SAFE_INTEGER) ||
      (invocationOrder.get(left.toolInvocationId) ?? Number.MAX_SAFE_INTEGER) -
        (invocationOrder.get(right.toolInvocationId) ?? Number.MAX_SAFE_INTEGER) ||
      left.ownerMessageId.localeCompare(right.ownerMessageId) ||
      left.artifactVersionId.localeCompare(right.artifactVersionId)
  )
  return { placements, diagnostics }
}

export { projectRootArtifactVisibility }
export type {
  ArtifactVisibilityDiagnostic,
  RootArtifactPlacement,
  RootArtifactVisibilityProjection
}
