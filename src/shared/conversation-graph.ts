import type { AgentFrameworkId } from './settings'
import type {
  PersistedActivityGroup,
  PersistedChatMessage,
  PersistedToolActivity
} from './session-persistence'

export type PersistedRuntimeSegment = {
  id: string
  agentFrameId: string
  frameworkId: AgentFrameworkId
  backendId?: string
  agentName?: string
  model?: string
  startedAt: number
  endedAt?: number
}

export type PersistedMessageNode = PersistedChatMessage & {
  agentFrameId: string
  introducedOnBranchId: string
  parentMessageId?: string
  revisionRootMessageId?: string
  supersedesMessageId?: string
  runtimeSegmentId?: string
}

export type PersistedBranchActivity = PersistedToolActivity & {
  agentFrameId: string
  messageBranchId: string
  promptMessageId: string
  runtimeSegmentId: string
}

export type PersistedBranchActivityGroup = PersistedActivityGroup & {
  agentFrameId: string
  messageBranchId: string
  promptMessageId: string
}

export type PersistedMessageBranch = {
  id: string
  agentFrameId: string
  parentBranchId?: string
  forkMessageId?: string
  supersededMessageId?: string
  headMessageId?: string
  createdAt: number
  updatedAt: number
}

export type PersistedAgentFrame = {
  id: string
  parentFrameId?: string
  originMessageId?: string
  originBindingState: 'root' | 'validated' | 'legacy-unavailable'
  kind: 'root' | 'reviewer' | 'delegate' | 'compatibility'
  agentName?: string
  delegateName?: string
  status: 'running' | 'completed' | 'cancelled' | 'error'
  activeBranchId: string
  linkedReviewId?: string
  createdAt: number
  completedAt?: number
}

export type PersistedConversationGraph = {
  schemaVersion: 1
  rootFrameId: string
  activeFrameId: string
  frames: PersistedAgentFrame[]
  branches: PersistedMessageBranch[]
  messages: PersistedMessageNode[]
  activities: PersistedBranchActivity[]
  activityGroups: PersistedBranchActivityGroup[]
  runtimeSegments: PersistedRuntimeSegment[]
}

export type ConversationGraphSeed = {
  sessionId: string
  messages: PersistedChatMessage[]
  frameworkId?: AgentFrameworkId
  backendId?: string
  model?: string
  createdAt: number
  updatedAt: number
}

const graphId = (kind: string, sessionId: string): string => `${kind}-${sessionId}`

export const createLinearConversationGraph = (
  seed: ConversationGraphSeed
): PersistedConversationGraph => {
  const rootFrameId = graphId('root-frame', seed.sessionId)
  const branchId = graphId('message-branch', seed.sessionId)
  const runtimeSegmentId = graphId('runtime-segment', seed.sessionId)
  const messages = seed.messages.map((message, index): PersistedMessageNode => ({
    ...message,
    agentFrameId: rootFrameId,
    introducedOnBranchId: branchId,
    ...(index > 0 ? { parentMessageId: seed.messages[index - 1].id } : {}),
    ...(message.role === 'user' ? { revisionRootMessageId: message.id } : {}),
    runtimeSegmentId
  }))

  return {
    schemaVersion: 1,
    rootFrameId,
    activeFrameId: rootFrameId,
    frames: [
      {
        id: rootFrameId,
        originBindingState: 'root',
        kind: 'root',
        status: 'completed',
        activeBranchId: branchId,
        createdAt: seed.createdAt,
        completedAt: seed.updatedAt
      }
    ],
    branches: [
      {
        id: branchId,
        agentFrameId: rootFrameId,
        headMessageId: messages.at(-1)?.id,
        createdAt: seed.createdAt,
        updatedAt: seed.updatedAt
      }
    ],
    messages,
    activities: [],
    activityGroups: [],
    runtimeSegments: [
      {
        id: runtimeSegmentId,
        agentFrameId: rootFrameId,
        frameworkId: seed.frameworkId ?? 'claude-code',
        backendId: seed.backendId,
        model: seed.model,
        startedAt: seed.createdAt
      }
    ]
  }
}

const indexById = <T extends { id: string }>(items: readonly T[]): Map<string, T> =>
  new Map(items.map((item) => [item.id, item]))

export const resolveMessageBranchPath = (
  graph: PersistedConversationGraph,
  branchId: string
): PersistedMessageNode[] => {
  const branch = graph.branches.find((candidate) => candidate.id === branchId)
  if (!branch) throw new Error(`Conversation branch not found: ${branchId}`)
  const messages = indexById(graph.messages)
  const reversePath: PersistedMessageNode[] = []
  const seen = new Set<string>()
  let currentId = branch.headMessageId

  while (currentId) {
    if (seen.has(currentId)) throw new Error('Conversation message graph contains a cycle.')
    seen.add(currentId)
    const message = messages.get(currentId)
    if (!message || message.agentFrameId !== branch.agentFrameId) {
      throw new Error(`Conversation branch references an invalid message: ${currentId}`)
    }
    reversePath.push(message)
    currentId = message.parentMessageId
  }

  return reversePath.reverse()
}

export const resolveActiveConversationMessages = (
  graph: PersistedConversationGraph
): PersistedMessageNode[] => {
  const frame = graph.frames.find((candidate) => candidate.id === graph.activeFrameId)
  if (!frame) throw new Error(`Active Agent Frame not found: ${graph.activeFrameId}`)
  return resolveMessageBranchPath(graph, frame.activeBranchId)
}

export const projectConversationMessage = (node: PersistedMessageNode): PersistedChatMessage => {
  const {
    agentFrameId,
    introducedOnBranchId,
    parentMessageId,
    revisionRootMessageId,
    supersedesMessageId,
    runtimeSegmentId,
    ...message
  } = node
  void agentFrameId
  void introducedOnBranchId
  void parentMessageId
  void revisionRootMessageId
  void supersedesMessageId
  void runtimeSegmentId
  return message
}

export const resolveActiveConversationActivities = (
  graph: PersistedConversationGraph
): { activities: PersistedToolActivity[]; activityGroups: PersistedActivityGroup[] } => {
  const messageIds = new Set(resolveActiveConversationMessages(graph).map((message) => message.id))
  const activities = graph.activities
    .filter((activity) => messageIds.has(activity.promptMessageId))
    .map(({ agentFrameId, messageBranchId, promptMessageId, runtimeSegmentId, ...activity }) => {
      void agentFrameId
      void messageBranchId
      void promptMessageId
      void runtimeSegmentId
      return activity
    })
  const activityGroups = graph.activityGroups
    .filter((group) => messageIds.has(group.promptMessageId))
    .map(({ agentFrameId, messageBranchId, promptMessageId, ...group }) => {
      void agentFrameId
      void messageBranchId
      void promptMessageId
      return group
    })
  return { activities, activityGroups }
}

export const validateConversationGraph = (graph: PersistedConversationGraph): void => {
  if (graph.schemaVersion !== 1) throw new Error('Unsupported conversation graph version.')
  const frames = indexById(graph.frames)
  const branches = indexById(graph.branches)
  const messages = indexById(graph.messages)
  if (frames.size !== graph.frames.length || branches.size !== graph.branches.length) {
    throw new Error('Conversation graph contains duplicate ids.')
  }
  if (messages.size !== graph.messages.length || !frames.has(graph.rootFrameId)) {
    throw new Error('Conversation graph contains duplicate or missing root data.')
  }
  if (!frames.has(graph.activeFrameId))
    throw new Error('Conversation graph active Frame is invalid.')

  for (const frame of graph.frames) {
    const seen = new Set<string>()
    let current: PersistedAgentFrame | undefined = frame
    while (current?.parentFrameId) {
      if (seen.has(current.id)) throw new Error('Agent Frame graph contains a cycle.')
      seen.add(current.id)
      current = frames.get(current.parentFrameId)
      if (!current) throw new Error('Agent Frame parent is missing.')
    }
    if (current?.id !== graph.rootFrameId) throw new Error('Agent Frame is detached from root.')
    const branch = branches.get(frame.activeBranchId)
    if (!branch || branch.agentFrameId !== frame.id) {
      throw new Error('Agent Frame active Branch is invalid.')
    }
  }

  for (const branch of graph.branches) {
    if (!frames.has(branch.agentFrameId)) throw new Error('Message Branch Frame is missing.')
    const seenBranches = new Set<string>()
    let currentBranch: PersistedMessageBranch | undefined = branch
    while (currentBranch?.parentBranchId) {
      if (seenBranches.has(currentBranch.id)) {
        throw new Error('Message Branch graph contains a cycle.')
      }
      seenBranches.add(currentBranch.id)
      currentBranch = branches.get(currentBranch.parentBranchId)
      if (!currentBranch || currentBranch.agentFrameId !== branch.agentFrameId) {
        throw new Error('Message Branch parent is invalid.')
      }
    }
    if (branch.parentBranchId) {
      const parent = branches.get(branch.parentBranchId)
      if (!parent || parent.agentFrameId !== branch.agentFrameId) {
        throw new Error('Message Branch parent is invalid.')
      }
    }
    const path = resolveMessageBranchPath(graph, branch.id)
    const ids = new Set(path.map((message) => message.id))
    if (branch.forkMessageId && !ids.has(branch.forkMessageId)) {
      throw new Error('Message Branch fork is not on its path.')
    }
  }

  const runtimeSegments = indexById(graph.runtimeSegments)
  if (runtimeSegments.size !== graph.runtimeSegments.length) {
    throw new Error('Conversation graph contains duplicate Runtime Segment ids.')
  }
  for (const segment of graph.runtimeSegments) {
    if (!frames.has(segment.agentFrameId)) {
      throw new Error('Runtime Segment Agent Frame is missing.')
    }
  }
  for (const message of graph.messages) {
    const introducedOnBranch = branches.get(message.introducedOnBranchId)
    if (!introducedOnBranch || introducedOnBranch.agentFrameId !== message.agentFrameId) {
      throw new Error('Message introduction Branch is invalid.')
    }
    if (message.runtimeSegmentId) {
      const segment = runtimeSegments.get(message.runtimeSegmentId)
      if (!segment || segment.agentFrameId !== message.agentFrameId) {
        throw new Error('Message Runtime Segment is invalid.')
      }
    }
  }
}

export const synchronizeActiveConversationMessages = (
  graph: PersistedConversationGraph,
  projection: PersistedChatMessage[],
  updatedAt: number
): PersistedConversationGraph => {
  const next = structuredClone(graph)
  const frame = next.frames.find((candidate) => candidate.id === next.activeFrameId)
  if (!frame) throw new Error('Active Agent Frame not found.')
  const branch = next.branches.find((candidate) => candidate.id === frame.activeBranchId)
  if (!branch) throw new Error('Active Message Branch not found.')
  const runtimeSegmentId = next.runtimeSegments
    .filter((segment) => segment.agentFrameId === frame.id)
    .at(-1)?.id
  const existing = indexById(next.messages)
  const activePath = resolveMessageBranchPath(next, branch.id)
  const activeIds = new Set(activePath.map((message) => message.id))
  let appendParentMessageId = branch.headMessageId
  let appended = false

  for (const message of projection) {
    const known = existing.get(message.id)
    if (known && !activeIds.has(message.id)) {
      throw new Error(`Message ${message.id} belongs to another conversation Branch.`)
    }
    if (known) {
      // The graph owns path structure and wins ties. The flat projection may advance mutable message
      // payload after a renderer event, but a stale/equal projection must never reparent, truncate, or
      // overwrite the canonical node during persistence.
      if (message.updatedAt > known.updatedAt) Object.assign(known, message)
      continue
    }
    const node: PersistedMessageNode = {
      ...message,
      agentFrameId: frame.id,
      introducedOnBranchId: branch.id,
      parentMessageId: appendParentMessageId,
      ...(message.role === 'user'
        ? branch.supersededMessageId && appendParentMessageId === branch.forkMessageId
          ? {
              revisionRootMessageId:
                existing.get(branch.supersededMessageId)?.revisionRootMessageId ??
                branch.supersededMessageId,
              supersedesMessageId: branch.supersededMessageId
            }
          : { revisionRootMessageId: message.id }
        : {}),
      runtimeSegmentId
    }
    next.messages.push(node)
    existing.set(node.id, node)
    activeIds.add(node.id)
    appendParentMessageId = message.id
    appended = true
  }

  if (appended) branch.headMessageId = appendParentMessageId
  branch.updatedAt = updatedAt
  validateConversationGraph(next)
  return next
}

export const synchronizeActiveConversationActivities = (
  graph: PersistedConversationGraph,
  activities: PersistedToolActivity[],
  activityGroups: PersistedActivityGroup[]
): PersistedConversationGraph => {
  const next = structuredClone(graph)
  const frame = next.frames.find((candidate) => candidate.id === next.activeFrameId)
  if (!frame) throw new Error('Active Agent Frame not found.')
  const branch = next.branches.find((candidate) => candidate.id === frame.activeBranchId)
  if (!branch) throw new Error('Active Message Branch not found.')
  const path = resolveMessageBranchPath(next, branch.id)
  const userMessages = path.filter((message) => message.role === 'user')
  const promptForTime = (createdAt: number): PersistedMessageNode | undefined =>
    userMessages.filter((message) => message.createdAt <= createdAt).at(-1) ?? userMessages.at(-1)
  const byActivityId = indexById(next.activities)

  for (const activity of activities) {
    const prompt = promptForTime(activity.createdAt)
    if (!prompt) continue
    const runtimeSegmentId =
      prompt.runtimeSegmentId ??
      next.runtimeSegments.filter((segment) => segment.agentFrameId === frame.id).at(-1)?.id
    if (!runtimeSegmentId) continue
    const scoped: PersistedBranchActivity = {
      ...activity,
      agentFrameId: frame.id,
      messageBranchId: branch.id,
      promptMessageId: prompt.id,
      runtimeSegmentId
    }
    const existing = byActivityId.get(activity.id)
    if (existing) Object.assign(existing, scoped)
    else {
      next.activities.push(scoped)
      byActivityId.set(scoped.id, scoped)
    }
  }

  const byGroupId = indexById(next.activityGroups)
  for (const group of activityGroups) {
    const firstActivity = group.activityIds
      .map((id) => byActivityId.get(id))
      .find((activity) => activity !== undefined)
    const prompt = firstActivity
      ? path.find((message) => message.id === firstActivity.promptMessageId)
      : promptForTime(group.createdAt)
    if (!prompt) continue
    const scoped: PersistedBranchActivityGroup = {
      ...group,
      agentFrameId: frame.id,
      messageBranchId: branch.id,
      promptMessageId: prompt.id
    }
    const existing = byGroupId.get(group.id)
    if (existing) Object.assign(existing, scoped)
    else {
      next.activityGroups.push(scoped)
      byGroupId.set(scoped.id, scoped)
    }
  }
  return next
}

export const forkEditedConversationMessage = (
  graph: PersistedConversationGraph,
  messageId: string,
  branchId: string,
  now: number
): PersistedConversationGraph => {
  const next = structuredClone(graph)
  const frame = next.frames.find((candidate) => candidate.id === next.activeFrameId)
  if (!frame) throw new Error('Active Agent Frame not found.')
  const parentBranch = next.branches.find((candidate) => candidate.id === frame.activeBranchId)
  if (!parentBranch) throw new Error('Active Message Branch not found.')
  const path = resolveMessageBranchPath(next, parentBranch.id)
  const target = path.find((message) => message.id === messageId)
  if (!target || target.role !== 'user')
    throw new Error('Only an active user Message can be edited.')
  if (next.branches.some((branch) => branch.id === branchId)) {
    throw new Error(`Conversation Branch already exists: ${branchId}`)
  }

  next.branches.push({
    id: branchId,
    agentFrameId: frame.id,
    parentBranchId: parentBranch.id,
    forkMessageId: target.parentMessageId,
    supersededMessageId: target.id,
    headMessageId: target.parentMessageId,
    createdAt: now,
    updatedAt: now
  })
  frame.activeBranchId = branchId
  validateConversationGraph(next)
  return next
}

export const activateConversationBranch = (
  graph: PersistedConversationGraph,
  branchId: string
): PersistedConversationGraph => {
  const next = structuredClone(graph)
  const branch = next.branches.find((candidate) => candidate.id === branchId)
  if (!branch) throw new Error(`Conversation Branch not found: ${branchId}`)
  const frame = next.frames.find((candidate) => candidate.id === branch.agentFrameId)
  if (!frame) throw new Error('Conversation Branch Agent Frame not found.')
  const previouslyActiveFrame = next.frames.find((candidate) => candidate.id === next.activeFrameId)
  frame.activeBranchId = branchId

  // Preserve an active descendant Frame only while every validated origin remains on the newly
  // selected parent path. When a Message revision hides that child, select its nearest visible
  // ancestor instead of jumping to an unrelated Frame or leaving activeFrameId invalid for the UI.
  const framesById = indexById(next.frames)
  const ancestry: PersistedAgentFrame[] = []
  let cursor = previouslyActiveFrame
  while (cursor) {
    ancestry.unshift(cursor)
    if (cursor.id === frame.id) break
    cursor = cursor.parentFrameId ? framesById.get(cursor.parentFrameId) : undefined
  }
  if (ancestry[0]?.id !== frame.id) {
    next.activeFrameId = frame.id
  } else {
    let deepestVisible = frame
    for (const child of ancestry.slice(1)) {
      const parentPathIds = new Set(
        resolveMessageBranchPath(next, deepestVisible.activeBranchId).map((message) => message.id)
      )
      if (
        child.parentFrameId !== deepestVisible.id ||
        child.originBindingState !== 'validated' ||
        !child.originMessageId ||
        !parentPathIds.has(child.originMessageId)
      ) {
        break
      }
      deepestVisible = child
    }
    next.activeFrameId = deepestVisible.id
  }
  validateConversationGraph(next)
  return next
}

export const ensureConversationRuntimeSegment = (
  graph: PersistedConversationGraph,
  input: {
    id: string
    frameworkId: AgentFrameworkId
    backendId?: string
    model?: string
    startedAt: number
  }
): PersistedConversationGraph => {
  const next = structuredClone(graph)
  const frame = next.frames.find((candidate) => candidate.id === next.activeFrameId)
  if (!frame) throw new Error('Active Agent Frame not found.')
  const current = next.runtimeSegments.filter((segment) => segment.agentFrameId === frame.id).at(-1)
  if (
    current &&
    current.frameworkId === input.frameworkId &&
    current.backendId === input.backendId &&
    current.model === input.model
  ) {
    return next
  }
  if (current && current.endedAt === undefined) current.endedAt = input.startedAt
  next.runtimeSegments.push({
    id: input.id,
    agentFrameId: frame.id,
    frameworkId: input.frameworkId,
    backendId: input.backendId,
    model: input.model,
    startedAt: input.startedAt
  })
  return next
}

export const getActiveConversationContext = (
  graph: PersistedConversationGraph,
  promptMessageId: string
): {
  promptMessageId: string
  rootFrameId: string
  agentFrameId: string
  messageBranchId: string
  messageBranchAncestry: string[]
  messageAncestry: string[]
  runtimeSegmentId: string
} => {
  const frame = graph.frames.find((candidate) => candidate.id === graph.activeFrameId)
  if (!frame) throw new Error('Active Agent Frame not found.')
  const branch = graph.branches.find((candidate) => candidate.id === frame.activeBranchId)
  const runtimeSegment = graph.runtimeSegments
    .filter((segment) => segment.agentFrameId === frame.id)
    .at(-1)
  if (!branch || !runtimeSegment) throw new Error('Conversation execution context is incomplete.')
  const branchesById = indexById(graph.branches)
  const messageBranchAncestry: string[] = []
  let cursor: PersistedMessageBranch | undefined = branch
  while (cursor) {
    messageBranchAncestry.unshift(cursor.id)
    cursor = cursor.parentBranchId ? branchesById.get(cursor.parentBranchId) : undefined
  }
  const messageAncestry = resolveMessageBranchPath(graph, branch.id).map((message) => message.id)
  // The renderer normally synchronizes the just-appended prompt into the graph before asking for
  // context. Keep direct/legacy callers safe when they bind the prompt one step earlier.
  if (!messageAncestry.includes(promptMessageId)) messageAncestry.push(promptMessageId)
  return {
    promptMessageId,
    rootFrameId: graph.rootFrameId,
    agentFrameId: frame.id,
    messageBranchId: branch.id,
    messageBranchAncestry,
    messageAncestry,
    runtimeSegmentId: runtimeSegment.id
  }
}
