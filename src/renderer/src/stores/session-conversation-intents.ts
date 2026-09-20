import { projectConversationMessage } from '../../../shared/conversation-graph'
import type { SessionConversationCommand } from '../../../shared/session-conversation-command'
import type { PersistedChatSession } from '../../../shared/session-persistence'

const pendingBySession = new Map<string, SessionConversationCommand[]>()
const authorityRootBranchBySessionId = new Map<string, string>()

const commandId = (): string => `renderer-conversation-${crypto.randomUUID()}`

const appendPending = (sessionId: string, commands: SessionConversationCommand[]): void => {
  if (commands.length === 0) return
  pendingBySession.set(sessionId, [...(pendingBySession.get(sessionId) ?? []), ...commands])
}

export const captureSessionConversationIntents = (
  before: PersistedChatSession | undefined,
  after: PersistedChatSession | undefined
): void => {
  if (!before || !after || before.runtimeTranscriptOwner !== 'main' || !after.conversationGraph)
    return
  const previous = before.conversationGraph
  if (!previous) return
  const next = after.conversationGraph
  const commands: SessionConversationCommand[] = []
  const previousRoot = previous.frames.find(({ id }) => id === previous.rootFrameId)
  const authorityRootBranchId = authorityRootBranchBySessionId.get(before.id)
  const previousBranchIds = new Set(previous.branches.map(({ id }) => id))
  for (const branch of next.branches) {
    if (previousBranchIds.has(branch.id) || !branch.parentBranchId) continue
    if (branch.forkActivityId && branch.forkMessageId) {
      commands.push({
        id: commandId(),
        kind: 'fork-activity',
        timestamp: branch.createdAt,
        branchId: branch.id,
        parentBranchId: branch.parentBranchId,
        messageId: branch.forkMessageId,
        activityId: branch.forkActivityId
      })
    } else if (branch.supersededMessageId) {
      commands.push({
        id: commandId(),
        kind: 'fork-message',
        timestamp: branch.createdAt,
        branchId: branch.id,
        parentBranchId: branch.parentBranchId,
        messageId: branch.supersededMessageId
      })
    }
  }
  const previousSegmentIds = new Set(previous.runtimeSegments.map(({ id }) => id))
  for (const segment of next.runtimeSegments) {
    if (!previousSegmentIds.has(segment.id)) {
      commands.push({
        id: commandId(),
        kind: 'open-segment',
        timestamp: segment.startedAt,
        segment
      })
    }
  }
  const previousMessageIds = new Set(previous.messages.map(({ id }) => id))
  for (const message of next.messages) {
    if (message.role !== 'user' || previousMessageIds.has(message.id)) continue
    commands.push({
      id: commandId(),
      kind: 'append-user',
      timestamp: message.createdAt,
      branchId: message.introducedOnBranchId,
      parentMessageId: message.parentMessageId,
      message: projectConversationMessage(message)
    })
  }
  const nextRoot = next.frames.find(({ id }) => id === next.rootFrameId)
  if (previousRoot && nextRoot && previousRoot.activeBranchId !== nextRoot.activeBranchId) {
    commands.push({
      id: commandId(),
      kind: 'select-branch',
      timestamp: after.updatedAt,
      branchId: nextRoot.activeBranchId,
      previousBranchId: previousRoot.activeBranchId
    })
  }
  if (
    after.activeRun &&
    (!before.activeRun ||
      before.activeRun.promptMessageId !== after.activeRun.promptMessageId ||
      before.activeRun.startedAt !== after.activeRun.startedAt)
  ) {
    commands.push({
      id: commandId(),
      kind: 'start-run',
      timestamp: after.activeRun.startedAt,
      run: after.activeRun
    })
  }
  if (
    commands.length > 0 &&
    previousRoot &&
    authorityRootBranchId &&
    authorityRootBranchId !== previousRoot.activeBranchId
  ) {
    commands.unshift({
      id: commandId(),
      kind: 'select-branch',
      timestamp: after.updatedAt,
      branchId: previousRoot.activeBranchId,
      previousBranchId: authorityRootBranchId
    })
  }
  appendPending(after.id, commands)
}

export const recordSessionConversationAuthority = (
  session: PersistedChatSession,
  authority: PersistedChatSession
): void => {
  const graph = authority.conversationGraph
  const root = graph?.frames.find(({ id }) => id === graph.rootFrameId)
  if (root) authorityRootBranchBySessionId.set(session.id, root.activeBranchId)
}

export const pendingSessionConversationCommands = (
  sessionId: string
): SessionConversationCommand[] => [...(pendingBySession.get(sessionId) ?? [])]

export const acknowledgeSessionConversationCommands = (session: PersistedChatSession): void => {
  const pending = pendingBySession.get(session.id)
  if (!pending) return
  const acknowledged = new Set(session.runtimeConversationCommandIds ?? [])
  const retained = pending.filter((command) => !acknowledged.has(command.id))
  if (retained.length > 0) pendingBySession.set(session.id, retained)
  else pendingBySession.delete(session.id)
}

export const resetSessionConversationIntentsForTests = (): void => {
  pendingBySession.clear()
  authorityRootBranchBySessionId.clear()
}
