import type { AgentFrameworkId } from './settings'
import type { PersistedChatMessage, PersistedMessageRole } from './session-persistence'
import {
  resolveMessageBranchPath,
  validateConversationGraph,
  type PersistedAgentFrame,
  type PersistedConversationGraph,
  type PersistedMessageBranch,
  type PersistedMessageNode
} from './conversation-graph'

const MAX_CONTENT_BLOCK_LENGTH = 16_000
const MAX_MESSAGE_LENGTH = 64_000

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const asTimestamp = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

const clip = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}\n…[truncated]`

const sanitizeContentBlock = (value: unknown): string => {
  if (typeof value === 'string') return clip(value, MAX_CONTENT_BLOCK_LENGTH)
  const block = asRecord(value)
  if (!block) return '[Unsupported content omitted]'
  const type = asString(block.type) ?? 'unknown'
  if (type === 'text') return clip(asString(block.text) ?? '', MAX_CONTENT_BLOCK_LENGTH)
  if (type === 'thinking') {
    return `[Thinking]\n${clip(asString(block.thinking) ?? '', MAX_CONTENT_BLOCK_LENGTH)}`
  }
  if (type === 'tool_use') {
    const name = asString(block.name) ?? 'tool'
    const serialized = clip(JSON.stringify(block.input ?? {}), MAX_CONTENT_BLOCK_LENGTH)
    return `[Tool use: ${name}]\n${serialized}`
  }
  if (type === 'tool_result') {
    const content =
      typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? null)
    return `[Tool result]\n${clip(content, MAX_CONTENT_BLOCK_LENGTH)}`
  }
  return `[Unsupported ${type} content omitted]`
}

const sanitizeExternalMessage = (
  value: unknown,
  frameId: string,
  branchId: string,
  runtimeSegmentId: string,
  index: number,
  createdAt: number
): PersistedMessageNode => {
  const message = asRecord(value)
  const id = asString(message?._uuid)
  const externalRole = asString(message?.role)
  const role: PersistedMessageRole = externalRole === 'assistant' ? 'agent' : 'user'
  if (!message || !id || (externalRole !== 'user' && externalRole !== 'assistant')) {
    throw new Error('External conversation Message identity or role is invalid.')
  }
  const blocks = Array.isArray(message.content) ? message.content : [message.content]
  const content = clip(
    blocks.map(sanitizeContentBlock).filter(Boolean).join('\n\n'),
    MAX_MESSAGE_LENGTH
  )
  const timestamp = createdAt + index
  const projected: PersistedChatMessage = {
    id,
    role,
    content,
    status: 'complete',
    eventIds: [],
    createdAt: timestamp,
    updatedAt: timestamp
  }
  return {
    ...projected,
    agentFrameId: frameId,
    introducedOnBranchId: branchId,
    ...(role === 'user' ? { revisionRootMessageId: id } : {}),
    runtimeSegmentId
  }
}

const sameMessage = (left: PersistedMessageNode, right: PersistedMessageNode): boolean =>
  left.agentFrameId === right.agentFrameId &&
  left.role === right.role &&
  left.content === right.content

const frameStatus = (value: unknown): PersistedAgentFrame['status'] => {
  if (value === 'completed') return 'completed'
  if (value === 'cancelled') return 'cancelled'
  if (value === 'error' || value === 'failed') return 'error'
  return 'running'
}

const importExternalConversationGraph = (
  value: unknown,
  options: { frameworkId?: AgentFrameworkId } = {}
): PersistedConversationGraph => {
  const external = asRecord(value)
  const rootFrameId = asString(external?.root_frame_id)
  const externalFrames = Array.isArray(external?.frames) ? external.frames : []
  if (!external || !rootFrameId || externalFrames.length === 0) {
    throw new Error('External conversation export is incomplete.')
  }
  const rawFrames = externalFrames.map((candidate) => {
    const frame = asRecord(candidate)
    const id = asString(frame?.id)
    if (!frame || !id) throw new Error('External Agent Frame identity is invalid.')
    return { frame, id }
  })
  const frameIds = new Set(rawFrames.map(({ id }) => id))
  if (frameIds.size !== rawFrames.length || !frameIds.has(rootFrameId)) {
    throw new Error('External Agent Frame ids are duplicated or the root is missing.')
  }

  const frames: PersistedAgentFrame[] = []
  const branches: PersistedMessageBranch[] = []
  const messages: PersistedMessageNode[] = []
  const messagesById = new Map<string, PersistedMessageNode>()
  const runtimeSegments: PersistedConversationGraph['runtimeSegments'] = []

  for (const { frame: rawFrame, id: frameId } of rawFrames) {
    const parentFrameId = asString(rawFrame.parent_frame_id)
    if (frameId === rootFrameId ? parentFrameId !== undefined : !parentFrameId) {
      throw new Error('External Agent Frame parent relationship is invalid.')
    }
    if (parentFrameId && !frameIds.has(parentFrameId)) {
      throw new Error('External Agent Frame parent is missing.')
    }
    const createdAt = asTimestamp(rawFrame.created_at, 0)
    const runtimeSegmentId = `external-runtime-${frameId}`
    const context = asRecord(rawFrame.context_metadata)
    const branchMeta = asRecord(context?.branch_meta)
    const rawBranches = asRecord(branchMeta?.branches)
    const declaredActiveBranchId = asString(branchMeta?.active_branch_id)
    const frameProjection = Array.isArray(rawFrame.messages) ? rawFrame.messages : []
    const branchDefinitions = rawBranches
      ? Object.entries(rawBranches).map(([id, definition]) => {
          const parsed = asRecord(definition)
          if (!parsed) throw new Error('External Message Branch definition is invalid.')
          return { id, definition: parsed }
        })
      : [
          {
            id: `external-branch-${frameId}`,
            definition: { parent_id: null, fork_point: null, messages: frameProjection }
          }
        ]
    const activeBranchId = declaredActiveBranchId ?? branchDefinitions[0]?.id
    if (!activeBranchId || !branchDefinitions.some((branch) => branch.id === activeBranchId)) {
      throw new Error('External Agent Frame active Branch is invalid.')
    }

    const pending = new Map(branchDefinitions.map((branch) => [branch.id, branch]))
    const frameBranchPaths = new Map<string, PersistedMessageNode[]>()
    while (pending.size > 0) {
      let progressed = false
      for (const [branchId, { definition }] of [...pending]) {
        const parentBranchId = asString(definition.parent_id)
        if (parentBranchId && pending.has(parentBranchId)) continue
        const parentPath = parentBranchId ? frameBranchPaths.get(parentBranchId) : undefined
        if (parentBranchId && !parentPath) {
          throw new Error('External Message Branch parent is missing or cyclic.')
        }
        const forkPointValue = definition.fork_point
        const forkPoint = parentBranchId ? Number(forkPointValue) : 0
        if (
          parentBranchId &&
          (!Number.isInteger(forkPoint) || forkPoint < 0 || forkPoint > parentPath!.length)
        ) {
          throw new Error('External Message Branch fork_point is out of bounds.')
        }
        let rawMessages = Array.isArray(definition.messages) ? definition.messages : []
        if (rawMessages.length === 0 && branchId === activeBranchId) rawMessages = frameProjection
        const sanitized = rawMessages.map((message, index) =>
          sanitizeExternalMessage(message, frameId, branchId, runtimeSegmentId, index, createdAt)
        )
        if (parentPath) {
          if (sanitized.length < forkPoint) {
            throw new Error('External active Branch projection is shorter than fork_point.')
          }
          for (let index = 0; index < forkPoint; index += 1) {
            if (
              sanitized[index]?.id !== parentPath[index]?.id ||
              !sameMessage(sanitized[index]!, parentPath[index]!)
            ) {
              throw new Error('External Message Branch shared prefix does not match its parent.')
            }
          }
        }
        const shared = parentPath?.slice(0, forkPoint) ?? []
        const suffix = sanitized.slice(parentPath ? forkPoint : 0)
        let parentMessageId = shared.at(-1)?.id
        for (const node of suffix) {
          const existing = messagesById.get(node.id)
          if (existing) {
            throw new Error(
              `External Message UUID is reused outside its validated shared prefix: ${node.id}`
            )
          }
          node.parentMessageId = parentMessageId
          if (node.role === 'user' && parentPath && parentMessageId === shared.at(-1)?.id) {
            const superseded = parentPath[forkPoint]
            if (superseded?.role === 'user') {
              node.revisionRootMessageId = superseded.revisionRootMessageId ?? superseded.id
              node.supersedesMessageId = superseded.id
            }
          }
          messages.push(node)
          messagesById.set(node.id, node)
          parentMessageId = node.id
        }
        const path = [...shared, ...suffix.map((node) => messagesById.get(node.id)!)]
        frameBranchPaths.set(branchId, path)
        branches.push({
          id: branchId,
          agentFrameId: frameId,
          ...(parentBranchId ? { parentBranchId } : {}),
          ...(parentPath && forkPoint > 0 ? { forkMessageId: parentPath[forkPoint - 1]?.id } : {}),
          ...(parentPath?.[forkPoint] ? { supersededMessageId: parentPath[forkPoint]!.id } : {}),
          ...(path.at(-1) ? { headMessageId: path.at(-1)!.id } : {}),
          createdAt: asTimestamp(definition.created_at, createdAt),
          updatedAt: asTimestamp(definition.updated_at, createdAt)
        })
        pending.delete(branchId)
        progressed = true
      }
      if (!progressed) throw new Error('External Message Branch graph contains a cycle.')
    }

    const agentName = asString(rawFrame.agent_name)
    frames.push({
      id: frameId,
      ...(parentFrameId ? { parentFrameId } : {}),
      originBindingState: frameId === rootFrameId ? 'root' : 'legacy-unavailable',
      kind:
        frameId === rootFrameId
          ? 'root'
          : agentName?.toLocaleLowerCase('und') === 'reviewer'
            ? 'reviewer'
            : 'delegate',
      ...(agentName ? { agentName } : {}),
      ...(asString(rawFrame.delegate_name)
        ? { delegateName: asString(rawFrame.delegate_name) }
        : {}),
      status: frameStatus(rawFrame.status),
      activeBranchId,
      createdAt,
      ...(rawFrame.completed_at
        ? { completedAt: asTimestamp(rawFrame.completed_at, createdAt) }
        : {})
    })
    runtimeSegments.push({
      id: runtimeSegmentId,
      agentFrameId: frameId,
      frameworkId: options.frameworkId ?? 'claude-code',
      agentName,
      model: asString(context?.model),
      startedAt: createdAt,
      ...(rawFrame.completed_at ? { endedAt: asTimestamp(rawFrame.completed_at, createdAt) } : {})
    })
  }

  const graph: PersistedConversationGraph = {
    schemaVersion: 1,
    rootFrameId,
    activeFrameId: rootFrameId,
    frames,
    branches,
    messages,
    activities: [],
    activityGroups: [],
    runtimeSegments
  }
  validateConversationGraph(graph)
  // Resolve each active projection once so an invalid head/cross-Frame reference fails import now.
  for (const frame of frames) resolveMessageBranchPath(graph, frame.activeBranchId)
  return graph
}

export { importExternalConversationGraph }
