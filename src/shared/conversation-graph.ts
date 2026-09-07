import type { AgentFrameworkId } from './settings'
import type {
  PersistedActivityGroup,
  PersistedChatMessage,
  PersistedToolActivity
} from './session-persistence'
import { parseNestedDelegateInvocationId } from './delegated-caller-source'

export type PersistedRuntimeSegment = {
  id: string
  agentFrameId: string
  // Historical evidence may outlive the runtime's current framework registry.
  frameworkId: string
  providerId?: string
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
  forkActivityId?: string
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
  providerId?: string
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
        providerId: seed.providerId,
        backendId: seed.backendId,
        model: seed.model,
        startedAt: seed.createdAt
      }
    ]
  }
}

const indexById = <T extends { id: string }>(items: readonly T[]): Map<string, T> =>
  new Map(items.map((item) => [item.id, item]))

type TreeInterval = { start: number; end: number }

const indexTreeAncestry = <T extends { id: string }>(
  roots: readonly T[],
  children: ReadonlyMap<string, readonly T[]>
): Map<string, TreeInterval> => {
  const ancestry = new Map<string, TreeInterval>()
  let sequence = 0
  for (const root of roots) {
    const stack: Array<{ item: T; exiting: boolean }> = [{ item: root, exiting: false }]
    while (stack.length > 0) {
      const { item, exiting } = stack.pop()!
      if (exiting) {
        ancestry.get(item.id)!.end = sequence
        sequence += 1
        continue
      }
      if (ancestry.has(item.id)) continue
      ancestry.set(item.id, { start: sequence, end: -1 })
      sequence += 1
      stack.push({ item, exiting: true })
      const descendants = children.get(item.id) ?? []
      for (let index = descendants.length - 1; index >= 0; index -= 1) {
        stack.push({ item: descendants[index], exiting: false })
      }
    }
  }
  return ancestry
}

const isTreeAncestor = (
  ancestry: ReadonlyMap<string, TreeInterval>,
  ancestorId: string,
  descendantId: string
): boolean => {
  const ancestor = ancestry.get(ancestorId)
  const descendant = ancestry.get(descendantId)
  return Boolean(
    ancestor && descendant && ancestor.start <= descendant.start && ancestor.end >= descendant.end
  )
}

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
  const frame = graph.frames.find((candidate) => candidate.id === graph.activeFrameId)
  const activeBranch = frame
    ? graph.branches.find((candidate) => candidate.id === frame.activeBranchId)
    : undefined
  if (!activeBranch) throw new Error('Active Message Branch not found.')
  const branchesById = indexById(graph.branches)
  const branchAncestry: PersistedMessageBranch[] = []
  let branch: PersistedMessageBranch | undefined = activeBranch
  while (branch) {
    branchAncestry.unshift(branch)
    branch = branch.parentBranchId ? branchesById.get(branch.parentBranchId) : undefined
  }
  const branchIndexes = new Map(branchAncestry.map((candidate, index) => [candidate.id, index]))
  const isLegacyCompatibleBranch = (branchId: string): boolean => {
    let candidate = branchesById.get(branchId)
    while (candidate) {
      if (candidate.forkActivityId && !branchIndexes.has(candidate.id)) return false
      candidate = candidate.parentBranchId ? branchesById.get(candidate.parentBranchId) : undefined
    }
    return true
  }
  const activitiesById = indexById(graph.activities)
  const isAtOrAfter = (
    activity: Pick<PersistedToolActivity, 'createdAt' | 'sortIndex'>,
    cutoff: Pick<PersistedToolActivity, 'createdAt' | 'sortIndex'>
  ): boolean =>
    activity.createdAt > cutoff.createdAt ||
    (activity.createdAt === cutoff.createdAt && activity.sortIndex >= cutoff.sortIndex)
  const isActivityVisible = (activity: PersistedBranchActivity): boolean => {
    const branchIndex = branchIndexes.get(activity.messageBranchId)
    if (!messageIds.has(activity.promptMessageId)) return false
    // Older schema-v1 graphs were synchronized by moving shared activities to whichever Branch was
    // active at save time. Preserve that prompt-based visibility unless an explicit Activity cutoff
    // proves the off-path Branch is a revised-answer continuation.
    if (branchIndex === undefined) return isLegacyCompatibleBranch(activity.messageBranchId)
    return branchAncestry.slice(branchIndex + 1).every((descendant) => {
      const cutoff = descendant.forkActivityId
        ? activitiesById.get(descendant.forkActivityId)
        : undefined
      return !cutoff || !isAtOrAfter(activity, cutoff)
    })
  }
  const visibleBranchActivities = graph.activities.filter(isActivityVisible)
  const visibleActivityIds = new Set(visibleBranchActivities.map((activity) => activity.id))
  const activities = visibleBranchActivities.map(
    ({ agentFrameId, messageBranchId, promptMessageId, runtimeSegmentId, ...activity }) => {
      void agentFrameId
      void messageBranchId
      void promptMessageId
      void runtimeSegmentId
      return activity
    }
  )
  const activityGroups = graph.activityGroups.flatMap(
    ({ agentFrameId, messageBranchId, promptMessageId, ...group }): PersistedActivityGroup[] => {
      if (
        !messageIds.has(promptMessageId) ||
        (!branchIndexes.has(messageBranchId) && !isLegacyCompatibleBranch(messageBranchId))
      ) {
        return []
      }
      const activityIds = group.activityIds.filter((id) => visibleActivityIds.has(id))
      if (group.activityIds.length > 0 && activityIds.length === 0) return []
      void agentFrameId
      void messageBranchId
      void promptMessageId
      return [{ ...group, activityIds }]
    }
  )
  return { activities, activityGroups }
}

export const validateConversationGraph = (graph: PersistedConversationGraph): void => {
  if (graph.schemaVersion !== 1) throw new Error('Unsupported conversation graph version.')
  const frames = indexById(graph.frames)
  const branches = indexById(graph.branches)
  const messages = indexById(graph.messages)
  const activities = indexById(graph.activities)
  const activityGroups = indexById(graph.activityGroups)
  const runtimeSegments = indexById(graph.runtimeSegments)
  if (frames.size !== graph.frames.length || branches.size !== graph.branches.length) {
    throw new Error('Conversation graph contains duplicate ids.')
  }
  if (
    messages.size !== graph.messages.length ||
    activities.size !== graph.activities.length ||
    !frames.has(graph.rootFrameId)
  ) {
    throw new Error('Conversation graph contains duplicate or missing root data.')
  }
  if (!frames.has(graph.activeFrameId))
    throw new Error('Conversation graph active Frame is invalid.')
  const rootFrame = frames.get(graph.rootFrameId)!
  if (
    rootFrame.kind !== 'root' ||
    rootFrame.originBindingState !== 'root' ||
    rootFrame.parentFrameId ||
    rootFrame.originMessageId
  ) {
    throw new Error('Conversation root Frame is invalid.')
  }
  if (activityGroups.size !== graph.activityGroups.length) {
    throw new Error('Conversation graph contains duplicate Activity Group ids.')
  }
  const activityIdsByGroupId = new Map(
    graph.activityGroups.map((group) => [group.id, new Set(group.activityIds)])
  )
  if (runtimeSegments.size !== graph.runtimeSegments.length) {
    throw new Error('Conversation graph contains duplicate Runtime Segment ids.')
  }

  const frameChildren = new Map<string, PersistedAgentFrame[]>()
  for (const frame of graph.frames) {
    const branch = branches.get(frame.activeBranchId)
    if (!branch || branch.agentFrameId !== frame.id) {
      throw new Error('Agent Frame active Branch is invalid.')
    }
    if (frame.id === graph.rootFrameId) continue
    if (frame.kind === 'root' || frame.originBindingState === 'root') {
      throw new Error('Non-root Agent Frame is invalid.')
    }
    if (!frame.parentFrameId) throw new Error('Agent Frame is detached from root.')
    if (
      (frame.originBindingState === 'validated' && !frame.originMessageId) ||
      (frame.originBindingState === 'legacy-unavailable' && frame.originMessageId)
    ) {
      throw new Error('Agent Frame origin Message is invalid.')
    }
    const parent = frames.get(frame.parentFrameId)
    if (!parent) throw new Error('Agent Frame parent is missing.')
    const children = frameChildren.get(parent.id)
    if (children) children.push(frame)
    else frameChildren.set(parent.id, [frame])
  }
  const frameAncestry = indexTreeAncestry([rootFrame], frameChildren)
  if (frameAncestry.size !== graph.frames.length) {
    throw new Error('Agent Frame graph contains a cycle.')
  }

  const branchChildren = new Map<string, PersistedMessageBranch[]>()
  const branchRoots: PersistedMessageBranch[] = []
  for (const branch of graph.branches) {
    if (!frames.has(branch.agentFrameId)) throw new Error('Message Branch Frame is missing.')
    if (branch.parentBranchId) {
      const parent = branches.get(branch.parentBranchId)
      if (!parent || parent.agentFrameId !== branch.agentFrameId) {
        throw new Error('Message Branch parent is invalid.')
      }
      const children = branchChildren.get(parent.id)
      if (children) children.push(branch)
      else branchChildren.set(parent.id, [branch])
    } else {
      branchRoots.push(branch)
    }
  }
  const branchAncestry = indexTreeAncestry(branchRoots, branchChildren)
  if (branchAncestry.size !== graph.branches.length) {
    throw new Error('Message Branch graph contains a cycle.')
  }

  for (const segment of graph.runtimeSegments) {
    if (!frames.has(segment.agentFrameId)) {
      throw new Error('Runtime Segment Agent Frame is missing.')
    }
  }

  const messageChildren = new Map<string, PersistedMessageNode[]>()
  const messageRoots: PersistedMessageNode[] = []
  const branchEntryMessages = new Map<string, PersistedMessageNode[]>()
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
    if (message.parentMessageId) {
      const parent = messages.get(message.parentMessageId)
      if (!parent || parent.agentFrameId !== message.agentFrameId) {
        throw new Error('Conversation Message parent is invalid.')
      }
      if (
        !isTreeAncestor(branchAncestry, parent.introducedOnBranchId, message.introducedOnBranchId)
      ) {
        throw new Error('Message introduction Branch is not on the containing Branch path.')
      }
      const children = messageChildren.get(parent.id)
      if (children) children.push(message)
      else messageChildren.set(parent.id, [message])
    } else {
      messageRoots.push(message)
    }
    const parent = message.parentMessageId ? messages.get(message.parentMessageId) : undefined
    if (!parent || parent.introducedOnBranchId !== message.introducedOnBranchId) {
      const entries = branchEntryMessages.get(message.introducedOnBranchId)
      if (entries) entries.push(message)
      else branchEntryMessages.set(message.introducedOnBranchId, [message])
    }
  }
  const messageAncestry = indexTreeAncestry(messageRoots, messageChildren)
  if (messageAncestry.size !== graph.messages.length) {
    throw new Error('Conversation message graph contains a cycle.')
  }

  const branchHeads = new Map<string, PersistedMessageNode | undefined>()
  const reachableMessages = new Set<string>()
  for (const branch of graph.branches) {
    const head = branch.headMessageId ? messages.get(branch.headMessageId) : undefined
    if (branch.headMessageId && (!head || head.agentFrameId !== branch.agentFrameId)) {
      throw new Error(`Conversation branch references an invalid message: ${branch.headMessageId}`)
    }
    branchHeads.set(branch.id, head)
    if (head && !isTreeAncestor(branchAncestry, head.introducedOnBranchId, branch.id)) {
      throw new Error('Message introduction Branch is not on the containing Branch path.')
    }
    const parentBranch = branch.parentBranchId ? branches.get(branch.parentBranchId) : undefined
    if ((branch.forkMessageId || branch.forkActivityId) && !parentBranch) {
      throw new Error('Message Branch fork requires a parent Branch.')
    }
    const parentHead = parentBranch?.headMessageId
      ? messages.get(parentBranch.headMessageId)
      : undefined
    if (branch.forkMessageId) {
      const fork = messages.get(branch.forkMessageId)
      if (
        !head ||
        !fork ||
        fork.agentFrameId !== branch.agentFrameId ||
        !isTreeAncestor(messageAncestry, fork.id, head.id)
      ) {
        throw new Error('Message Branch fork is not on its path.')
      }
      if (
        !parentBranch ||
        !parentHead ||
        !isTreeAncestor(messageAncestry, fork.id, parentHead.id) ||
        !isTreeAncestor(branchAncestry, fork.introducedOnBranchId, parentBranch.id)
      ) {
        throw new Error('Message Branch fork is not on its parent path.')
      }
    }
    if (branch.forkActivityId) {
      const activity = activities.get(branch.forkActivityId)
      if (!activity) throw new Error('Message Branch Activity fork is missing.')
      if (
        !head ||
        activity.agentFrameId !== branch.agentFrameId ||
        !isTreeAncestor(messageAncestry, activity.promptMessageId, head.id) ||
        !isTreeAncestor(branchAncestry, activity.messageBranchId, branch.id)
      ) {
        throw new Error('Message Branch Activity fork is not on its path.')
      }
      if (
        !parentBranch ||
        !parentHead ||
        !isTreeAncestor(messageAncestry, activity.promptMessageId, parentHead.id) ||
        !isTreeAncestor(branchAncestry, activity.messageBranchId, parentBranch.id)
      ) {
        throw new Error('Message Branch Activity fork is not on its parent path.')
      }
    }
    if (branch.supersededMessageId) {
      const superseded = messages.get(branch.supersededMessageId)
      if (
        !parentBranch ||
        !parentHead ||
        !superseded ||
        superseded.agentFrameId !== branch.agentFrameId ||
        superseded.parentMessageId !== branch.forkMessageId ||
        !isTreeAncestor(messageAncestry, superseded.id, parentHead.id)
      ) {
        throw new Error('Message revision chain is invalid.')
      }
      if (superseded.role === 'user' && branch.headMessageId !== branch.forkMessageId) {
        const replacement = branchEntryMessages
          .get(branch.id)
          ?.find((message) => message.parentMessageId === branch.forkMessageId)
        if (
          !replacement ||
          replacement.role !== 'user' ||
          replacement.supersedesMessageId !== superseded.id
        ) {
          throw new Error('Message revision chain is invalid.')
        }
      }
    }
    let current = head
    while (current && !reachableMessages.has(current.id)) {
      reachableMessages.add(current.id)
      current = current.parentMessageId ? messages.get(current.parentMessageId) : undefined
    }
  }
  if (reachableMessages.size !== graph.messages.length) {
    const unreachable = graph.messages.find((message) => !reachableMessages.has(message.id))
    throw new Error(`Conversation Message is not reachable from any Branch: ${unreachable?.id}`)
  }

  for (const frame of graph.frames) {
    if (frame.id === graph.rootFrameId || frame.originBindingState !== 'validated') continue
    const origin = frame.originMessageId ? messages.get(frame.originMessageId) : undefined
    if (!origin || origin.agentFrameId !== frame.parentFrameId) {
      throw new Error('Agent Frame origin Message is invalid.')
    }
  }

  let activeFrame = frames.get(graph.activeFrameId)!
  while (activeFrame.parentFrameId) {
    const parent = frames.get(activeFrame.parentFrameId)!
    const origin = activeFrame.originMessageId
      ? messages.get(activeFrame.originMessageId)
      : undefined
    const parentHead = branchHeads.get(parent.activeBranchId)
    if (
      activeFrame.originBindingState !== 'validated' ||
      !origin ||
      !parentHead ||
      !isTreeAncestor(messageAncestry, origin.id, parentHead.id)
    ) {
      throw new Error('Active Agent Frame origin is not on its parent current Branch.')
    }
    activeFrame = parent
  }

  for (const message of graph.messages) {
    if (message.responseToMessageId) {
      const target = messages.get(message.responseToMessageId)
      if (
        !target ||
        target.id === message.id ||
        target.agentFrameId !== message.agentFrameId ||
        !isTreeAncestor(messageAncestry, target.id, message.id) ||
        (message.role === 'agent' && target.role !== 'user')
      ) {
        throw new Error('Message response target is invalid.')
      }
    }
    if (message.revisionRootMessageId) {
      const root = messages.get(message.revisionRootMessageId)
      if (
        message.role !== 'user' ||
        !root ||
        root.role !== 'user' ||
        root.agentFrameId !== message.agentFrameId ||
        (!message.supersedesMessageId && root.id !== message.id)
      ) {
        throw new Error('Message revision root is invalid.')
      }
    }
    if (message.supersedesMessageId) {
      const superseded = messages.get(message.supersedesMessageId)
      const branch = branches.get(message.introducedOnBranchId)
      if (
        message.role !== 'user' ||
        !superseded ||
        superseded.role !== 'user' ||
        superseded.agentFrameId !== message.agentFrameId ||
        branch?.supersededMessageId !== superseded.id ||
        message.revisionRootMessageId !== (superseded.revisionRootMessageId ?? superseded.id)
      ) {
        throw new Error('Message revision chain is invalid.')
      }
    }
  }

  for (const group of graph.activityGroups) {
    const branch = branches.get(group.messageBranchId)
    if (!branch || branch.agentFrameId !== group.agentFrameId) {
      throw new Error('Activity Group Branch is invalid.')
    }
    const prompt = messages.get(group.promptMessageId)
    if (
      !prompt ||
      prompt.role !== 'user' ||
      prompt.agentFrameId !== group.agentFrameId ||
      !branchHeads.get(branch.id) ||
      !isTreeAncestor(messageAncestry, prompt.id, branchHeads.get(branch.id)!.id)
    ) {
      throw new Error('Activity Group Prompt Message is invalid.')
    }
    if (group.activityIds.some((id) => !activities.has(id))) {
      throw new Error('Activity Group member is invalid.')
    }
  }

  for (const activity of graph.activities) {
    const branch = branches.get(activity.messageBranchId)
    if (!branch || branch.agentFrameId !== activity.agentFrameId) {
      throw new Error('Activity Branch is invalid.')
    }
    const prompt = messages.get(activity.promptMessageId)
    if (
      !prompt ||
      prompt.role !== 'user' ||
      prompt.agentFrameId !== activity.agentFrameId ||
      !branchHeads.get(branch.id) ||
      !isTreeAncestor(messageAncestry, prompt.id, branchHeads.get(branch.id)!.id)
    ) {
      throw new Error('Activity Prompt Message is invalid.')
    }
    const segment = runtimeSegments.get(activity.runtimeSegmentId)
    if (!segment || segment.agentFrameId !== activity.agentFrameId) {
      throw new Error('Activity Runtime Segment is invalid.')
    }
    if (activity.activityGroupId) {
      const group = activityGroups.get(activity.activityGroupId)
      if (
        !group ||
        group.agentFrameId !== activity.agentFrameId ||
        group.messageBranchId !== activity.messageBranchId ||
        group.promptMessageId !== activity.promptMessageId ||
        !activityIdsByGroupId.get(group.id)!.has(activity.id)
      ) {
        throw new Error('Activity Group membership is invalid.')
      }
    }
  }

  for (const group of graph.activityGroups) {
    if (
      group.activityIds.some((id) => {
        const activity = activities.get(id)
        return (
          activity?.activityGroupId !== group.id ||
          activity.agentFrameId !== group.agentFrameId ||
          activity.messageBranchId !== group.messageBranchId ||
          activity.promptMessageId !== group.promptMessageId
        )
      })
    ) {
      throw new Error('Activity Group member is invalid.')
    }
  }
}

// A host.delegate call runs inside a Notebook control invocation, so ACP persists only the outer
// repl_execute Tool activity. The authenticated Notebook bridge gives each nested delegation its own
// stable identity; materialize that identity as a root activity so durable caller attribution and the
// root transcript share one exact anchor. Existing direct ACP activities always win unchanged.
export const materializeNestedDelegateActivities = (
  graph: PersistedConversationGraph
): PersistedConversationGraph => {
  validateConversationGraph(graph)
  const activityIds = new Set(graph.activities.map(({ id }) => id))
  const messages = indexById(graph.messages)
  const frames = indexById(graph.frames)
  const branches = indexById(graph.branches)
  const candidates = new Map<
    string,
    {
      sourceMessage: PersistedMessageNode
      prompts: PersistedMessageNode[]
      controlInvocationId: string
      delegationCallId: string
    }
  >()

  for (const prompt of [...graph.messages].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  )) {
    const source = prompt.delegatedCallerSource
    if (!source || activityIds.has(source.toolInvocationId) || prompt.role !== 'user') continue
    const nested = parseNestedDelegateInvocationId(source.toolInvocationId)
    const frame = frames.get(prompt.agentFrameId)
    const sourceMessage = messages.get(source.rootMessageId)
    const sourceBranch = sourceMessage
      ? branches.get(sourceMessage.introducedOnBranchId)
      : undefined
    if (
      !nested ||
      !frame ||
      frame.kind !== 'delegate' ||
      frame.parentFrameId !== graph.rootFrameId ||
      !sourceMessage ||
      sourceMessage.role !== 'user' ||
      sourceMessage.agentFrameId !== graph.rootFrameId ||
      !sourceMessage.runtimeSegmentId ||
      !sourceBranch ||
      sourceBranch.agentFrameId !== graph.rootFrameId ||
      !resolveMessageBranchPath(graph, sourceBranch.id).some(({ id }) => id === sourceMessage.id)
    ) {
      continue
    }
    const candidate = candidates.get(source.toolInvocationId)
    if (candidate) {
      if (candidate.sourceMessage.id !== sourceMessage.id) {
        candidates.delete(source.toolInvocationId)
        activityIds.add(source.toolInvocationId)
        continue
      }
      candidate.prompts.push(prompt)
      continue
    }
    candidates.set(source.toolInvocationId, {
      sourceMessage,
      prompts: [prompt],
      ...nested
    })
  }

  if (candidates.size === 0) return graph
  const nextSortIndex = new Map<string, number>()
  for (const activity of graph.activities) {
    nextSortIndex.set(
      activity.promptMessageId,
      Math.max(nextSortIndex.get(activity.promptMessageId) ?? -1, activity.sortIndex)
    )
  }
  const activities = [...graph.activities]
  for (const [id, candidate] of [...candidates].sort(
    (left, right) =>
      Math.min(...left[1].prompts.map(({ createdAt }) => createdAt)) -
        Math.min(...right[1].prompts.map(({ createdAt }) => createdAt)) ||
      left[0].localeCompare(right[0])
  )) {
    const sourceMessage = candidate.sourceMessage
    const sortIndex = (nextSortIndex.get(sourceMessage.id) ?? -1) + 1
    nextSortIndex.set(sourceMessage.id, sortIndex)
    const createdAt = Math.min(...candidate.prompts.map(({ createdAt }) => createdAt))
    activities.push({
      id,
      kind: 'tool',
      title: 'Delegate subagent',
      status: 'completed',
      sortIndex,
      eventIds: [],
      providerToolName: 'host.delegate',
      toolKind: 'other',
      rawInput: {
        controlInvocationId: candidate.controlInvocationId,
        delegationCallId: candidate.delegationCallId
      },
      rawOutput: {
        children: candidate.prompts
          .map(({ agentFrameId }) => agentFrameId)
          .filter((frameId, index, all) => all.indexOf(frameId) === index)
          .sort()
          .map((frameId) => ({ frameId }))
      },
      createdAt,
      updatedAt: createdAt,
      agentFrameId: graph.rootFrameId,
      messageBranchId: sourceMessage.introducedOnBranchId,
      promptMessageId: sourceMessage.id,
      runtimeSegmentId: sourceMessage.runtimeSegmentId!
    })
  }
  const next = { ...graph, activities }
  validateConversationGraph(next)
  return next
}

export const synchronizeActiveConversationMessages = (
  graph: PersistedConversationGraph,
  projection: PersistedChatMessage[],
  updatedAt: number,
  responseRuntimeSegmentId?: string
): PersistedConversationGraph => {
  const next = structuredClone(graph)
  const frame = next.frames.find((candidate) => candidate.id === next.activeFrameId)
  if (!frame) throw new Error('Active Agent Frame not found.')
  const branch = next.branches.find((candidate) => candidate.id === frame.activeBranchId)
  if (!branch) throw new Error('Active Message Branch not found.')
  const activeRuntimeSegmentId = next.runtimeSegments
    .filter((segment) => segment.agentFrameId === frame.id)
    .at(-1)?.id
  const responseRuntimeSegment = responseRuntimeSegmentId
    ? next.runtimeSegments.find((segment) => segment.id === responseRuntimeSegmentId)
    : undefined
  if (responseRuntimeSegmentId && responseRuntimeSegment?.agentFrameId !== frame.id) {
    throw new Error('Response Runtime Segment is not owned by the active Agent Frame.')
  }
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
    const runtimeSegmentId =
      message.role === 'agent' && message.responseToMessageId
        ? (responseRuntimeSegmentId ??
          existing.get(message.responseToMessageId)?.runtimeSegmentId ??
          activeRuntimeSegmentId)
        : activeRuntimeSegmentId
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
  activityGroups: PersistedActivityGroup[],
  responseRuntimeSegmentId?: string
): PersistedConversationGraph => {
  const next = structuredClone(graph)
  const frame = next.frames.find((candidate) => candidate.id === next.activeFrameId)
  if (!frame) throw new Error('Active Agent Frame not found.')
  const branch = next.branches.find((candidate) => candidate.id === frame.activeBranchId)
  if (!branch) throw new Error('Active Message Branch not found.')
  const responseRuntimeSegment = responseRuntimeSegmentId
    ? next.runtimeSegments.find((segment) => segment.id === responseRuntimeSegmentId)
    : undefined
  if (responseRuntimeSegmentId && responseRuntimeSegment?.agentFrameId !== frame.id) {
    throw new Error('Activity Runtime Segment is not owned by the active Agent Frame.')
  }
  const path = resolveMessageBranchPath(next, branch.id)
  const userMessages = path.filter((message) => message.role === 'user')
  const promptForTime = (createdAt: number): PersistedMessageNode | undefined =>
    userMessages.filter((message) => message.createdAt <= createdAt).at(-1) ?? userMessages.at(-1)
  const byActivityId = indexById(next.activities)

  for (const activity of activities) {
    const prompt = activity.promptMessageId
      ? userMessages.find((message) => message.id === activity.promptMessageId)
      : promptForTime(activity.createdAt)
    if (!prompt) continue
    const existing = byActivityId.get(activity.id)
    const runtimeSegmentId =
      existing?.runtimeSegmentId ??
      responseRuntimeSegmentId ??
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
    if (existing) {
      const { agentFrameId, messageBranchId, promptMessageId, runtimeSegmentId } = existing
      Object.assign(existing, scoped, {
        agentFrameId,
        messageBranchId,
        promptMessageId,
        runtimeSegmentId
      })
    } else {
      next.activities.push(scoped)
      byActivityId.set(scoped.id, scoped)
    }
  }

  const byGroupId = indexById(next.activityGroups)
  for (const group of activityGroups) {
    const firstActivity = group.activityIds
      .map((id) => byActivityId.get(id))
      .find((activity) => activity !== undefined)
    const prompt = group.promptMessageId
      ? userMessages.find((message) => message.id === group.promptMessageId)
      : firstActivity
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
    if (existing) {
      const { agentFrameId, messageBranchId, promptMessageId } = existing
      Object.assign(existing, scoped, { agentFrameId, messageBranchId, promptMessageId })
    } else {
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

// Starts a sibling continuation after an existing active-path Message and before the selected
// Activity. Structured-answer edits retain the shared transcript while keeping the old question and
// downstream answer on the parent Branch.
export const forkConversationAfterActivity = (
  graph: PersistedConversationGraph,
  messageId: string,
  activityId: string,
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
  if (!target) throw new Error('Conversation Branch fork Message is not on the active path.')
  const activity = next.activities.find(
    (candidate) =>
      candidate.id === activityId &&
      path.some((message) => message.id === candidate.promptMessageId)
  )
  if (
    !activity ||
    !resolveActiveConversationActivities(next).activities.some(
      (candidate) => candidate.id === activity.id
    )
  ) {
    throw new Error('Conversation Branch fork Activity is not on the active path.')
  }
  if (next.branches.some((branch) => branch.id === branchId)) {
    throw new Error(`Conversation Branch already exists: ${branchId}`)
  }

  next.branches.push({
    id: branchId,
    agentFrameId: frame.id,
    parentBranchId: parentBranch.id,
    forkMessageId: target.id,
    forkActivityId: activity.id,
    headMessageId: target.id,
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
    providerId?: string
    backendId?: string
    model?: string
    startedAt: number
    forceNew?: boolean
  }
): PersistedConversationGraph => {
  const next = structuredClone(graph)
  const frame = next.frames.find((candidate) => candidate.id === next.activeFrameId)
  if (!frame) throw new Error('Active Agent Frame not found.')
  const current = next.runtimeSegments.filter((segment) => segment.agentFrameId === frame.id).at(-1)
  if (
    !input.forceNew &&
    current &&
    current.frameworkId === input.frameworkId &&
    current.providerId === input.providerId &&
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
    providerId: input.providerId,
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
  if (!branch) throw new Error('Conversation execution context is incomplete.')
  const path = resolveMessageBranchPath(graph, branch.id)
  const prompt = path.find((message) => message.id === promptMessageId)
  // A later runtime switch may already have opened a Segment; durable provenance still follows the
  // Segment that owns this prompt rather than whichever Segment happens to be newest.
  const runtimeSegment = prompt?.runtimeSegmentId
    ? graph.runtimeSegments.find((segment) => segment.id === prompt.runtimeSegmentId)
    : graph.runtimeSegments.filter((segment) => segment.agentFrameId === frame.id).at(-1)
  if (!runtimeSegment) throw new Error('Conversation execution context is incomplete.')
  const branchesById = indexById(graph.branches)
  const messageBranchAncestry: string[] = []
  let cursor: PersistedMessageBranch | undefined = branch
  while (cursor) {
    messageBranchAncestry.unshift(cursor.id)
    cursor = cursor.parentBranchId ? branchesById.get(cursor.parentBranchId) : undefined
  }
  const messageAncestry = path.map((message) => message.id)
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
