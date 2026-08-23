import type { TFunction } from 'i18next'

import type { AcpPermissionRequest } from '../../../../shared/acp'
import {
  projectConversationMessage,
  resolveMessageBranchPath,
  type PersistedAgentFrame
} from '../../../../shared/conversation-graph'
import {
  projectActiveRootDelegatedFrames,
  resolveActiveRootMessageIds
} from '../../../../shared/delegated-work-projection'
import type {
  DelegatedMessageCommand,
  DelegatedQuestionRequest,
  DelegatedWorkAttemptRecord,
  PersistedChatMessage,
  PersistedChatSession
} from '../../../../shared/session-persistence'
import type { AgentFrameworkId, AgentFrameworkView } from '../../../../shared/settings'

type SubagentRawStatus = PersistedAgentFrame['status'] | 'awaiting_user'

type SessionSubagentChild = Readonly<{
  frameId: string
  title: string
  agentLabel: string
  status: SubagentRawStatus
  originUnavailable: boolean
  awaitingPermission?: boolean
}>

type SessionSubagentProjection = Readonly<{
  runningCount: number
  children: readonly SessionSubagentChild[]
}>

type SubagentFrameProjection = Readonly<{
  frameId: string
  title: string
  agentLabel: string
  status: SubagentRawStatus
  originUnavailable: boolean
  attempt?: DelegatedWorkAttemptRecord
  messages: readonly PersistedChatMessage[]
}>

type InlineParentMessageProjection = Readonly<{
  messageId: string
  promptMessageId?: string
  sourceFrameId: string
  sourceName: string
  kind: DelegatedMessageCommand['kind']
  text: string
  queuedAt: number
}>

type DelegatedWorkAvailability =
  Readonly<{ available: true }> | Readonly<{ available: false; title: string; description: string }>

const latestAttempt = (
  session: PersistedChatSession,
  frameId: string
): DelegatedWorkAttemptRecord | undefined =>
  session.runtimeContext?.delegatedWork?.records
    .find((record) => record.agentFrameId === frameId)
    ?.attempts.at(-1)

const readableNameForFrame = (frame: PersistedAgentFrame): string | undefined =>
  frame.delegateName?.trim() || frame.agentName?.trim() || undefined

const titleForFrame = (frame: PersistedAgentFrame): string =>
  readableNameForFrame(frame) ?? `Subagent ${frame.id}`
const inlineSourceNameForFrame = (frame: PersistedAgentFrame): string =>
  readableNameForFrame(frame) ?? 'Subagent'

const agentLabelForFrame = (session: PersistedChatSession, frame: PersistedAgentFrame): string => {
  const resolved = latestAttempt(session, frame.id)?.resolvedAgent
  if (resolved?.kind === 'specialist') return resolved.displayName
  return frame.agentName?.trim() || 'Main Agent'
}

const projectSessionSubagents = (
  session: PersistedChatSession | undefined,
  permissions: readonly AcpPermissionRequest[]
): SessionSubagentProjection => {
  const graph = session?.conversationGraph
  if (!session || !graph) return { runningCount: 0, children: [] }
  const children = projectActiveRootDelegatedFrames(session).map((frame): SessionSubagentChild => {
    const attempt = latestAttempt(session, frame.id)
    const awaitingPermission =
      frame.status === 'running' &&
      permissions.some(
        (permission) =>
          permission.sessionId === session.id &&
          permission.delegated?.frameId === frame.id &&
          (!attempt || permission.delegated.attemptId === attempt.id)
      )
    const awaitingUser = session.runtimeContext?.delegatedWork?.questionRequests?.some(
      (request) => request.sourceFrameId === frame.id && request.status === 'pending'
    )
    return {
      frameId: frame.id,
      title: titleForFrame(frame),
      agentLabel: agentLabelForFrame(session, frame),
      status: awaitingUser ? 'awaiting_user' : frame.status,
      originUnavailable: frame.originBindingState === 'legacy-unavailable',
      ...(awaitingPermission ? { awaitingPermission: true } : {})
    }
  })

  return {
    runningCount: children.filter(
      ({ status }) => status === 'running' || status === 'awaiting_user'
    ).length,
    children
  }
}

const projectAnswerableDelegatedQuestions = (
  session: PersistedChatSession | undefined
): readonly DelegatedQuestionRequest[] => {
  const graph = session?.conversationGraph
  const owner = session?.runtimeContext?.delegatedWork
  if (!graph || !owner?.questionRequests || owner.questionRequestsQuarantine !== undefined) {
    return []
  }
  const root = graph.frames.find((frame) => frame.id === graph.rootFrameId && frame.kind === 'root')
  const activeRootMessageIds = resolveActiveRootMessageIds(graph)
  if (!root || !activeRootMessageIds) return []
  const eligible = owner.questionRequests.filter((request) => {
    if (
      request.status !== 'pending' ||
      request.rootBranchId !== root.activeBranchId ||
      !activeRootMessageIds.has(request.rootOriginMessageId)
    ) {
      return false
    }
    const source = graph.frames.find((frame) => frame.id === request.sourceFrameId)
    return Boolean(
      source &&
      source.kind === 'delegate' &&
      source.parentFrameId === root.id &&
      source.originBindingState === 'validated' &&
      source.originMessageId === request.rootOriginMessageId &&
      source.activeBranchId === request.sourceMessageBranchId &&
      (source.delegateName?.trim() || source.agentName?.trim()) === request.sourceName
    )
  })
  const useFallbackOrder = eligible.some((request) => request.sequence === undefined)
  return eligible.toSorted((left, right) => {
    const sequenceOrder = useFallbackOrder ? 0 : left.sequence! - right.sequence!
    return (
      sequenceOrder || left.askedAt - right.askedAt || left.requestId.localeCompare(right.requestId)
    )
  })
}

const hasAnswerableDelegatedQuestion = (session: PersistedChatSession | undefined): boolean =>
  projectAnswerableDelegatedQuestions(session).length > 0

const projectDelegatedQuestionQueue = (
  session: PersistedChatSession | undefined
): readonly DelegatedQuestionRequest[] => {
  const graph = session?.conversationGraph
  if (!graph || graph.activeFrameId !== graph.rootFrameId) return []
  return projectAnswerableDelegatedQuestions(session)
}

const projectInlineParentMessages = (
  session: PersistedChatSession | undefined
): readonly InlineParentMessageProjection[] => {
  const graph = session?.conversationGraph
  const commands = session?.runtimeContext?.delegatedWork?.messageCommands
  if (!graph || !commands) return []
  if (graph.activeFrameId !== graph.rootFrameId) return []
  const root = graph.frames.find((frame) => frame.id === graph.rootFrameId && frame.kind === 'root')
  if (!root) return []
  const activeRootMessageIds = resolveActiveRootMessageIds(graph)
  if (!activeRootMessageIds) return []

  const projectedByMessageId = new Map<string, InlineParentMessageProjection>()
  for (const command of commands) {
    if (
      command.direction !== 'to_parent' ||
      command.disposition !== 'message' ||
      command.rootBranchId !== root.activeBranchId ||
      command.targetFrameId !== root.id
    ) {
      continue
    }
    const source = graph.frames.find(
      (frame) =>
        frame.id === command.sourceFrameId &&
        frame.kind === 'delegate' &&
        frame.parentFrameId === root.id &&
        frame.originBindingState === 'validated' &&
        Boolean(frame.originMessageId && activeRootMessageIds.has(frame.originMessageId))
    )
    if (!source) continue

    projectedByMessageId.set(command.messageId, {
      messageId: command.messageId,
      promptMessageId: command.rootOriginMessageId,
      sourceFrameId: source.id,
      sourceName: inlineSourceNameForFrame(source),
      kind: command.kind,
      text: command.text,
      queuedAt: command.queuedAt
    })
  }

  return [...projectedByMessageId.values()].sort(
    (left, right) => left.queuedAt - right.queuedAt || left.messageId.localeCompare(right.messageId)
  )
}

const selectSubagentFrame = (
  session: PersistedChatSession | undefined,
  frameId: string
): SubagentFrameProjection | undefined => {
  const graph = session?.conversationGraph
  if (!session || !graph) return undefined
  const frame = graph.frames.find(
    (candidate) =>
      candidate.id === frameId &&
      candidate.kind === 'delegate' &&
      candidate.parentFrameId === graph.rootFrameId
  )
  if (!frame) return undefined

  let messages: PersistedChatMessage[]
  try {
    messages = resolveMessageBranchPath(graph, frame.activeBranchId).map(projectConversationMessage)
  } catch {
    return undefined
  }

  return {
    frameId,
    title: titleForFrame(frame),
    agentLabel: agentLabelForFrame(session, frame),
    status: session.runtimeContext?.delegatedWork?.questionRequests?.some(
      (request) => request.sourceFrameId === frameId && request.status === 'pending'
    )
      ? 'awaiting_user'
      : frame.status,
    originUnavailable: frame.originBindingState === 'legacy-unavailable',
    attempt: latestAttempt(session, frameId),
    messages
  }
}

// Takes `t` rather than reaching for the i18next singleton, keeping it a pure function of
// (input, locale) — the same shape as the other view describers in this codebase.
const resolveDelegatedWorkAvailability = (
  frameworkId: AgentFrameworkId,
  frameworks: readonly AgentFrameworkView[],
  t: TFunction
): DelegatedWorkAvailability => {
  const framework = frameworks.find(({ id }) => id === frameworkId)
  if (framework?.supportsDelegatedWork === true) return { available: true }

  return {
    available: false,
    // The framework's display name is vendor copy and interpolates unchanged.
    title: t('Subagents unavailable for {{name}}', {
      name: framework?.displayName ?? frameworkId
    }),
    description: t(
      'Choose a certified agent framework in Settings before asking the Main Agent to delegate work.'
    )
  }
}

export {
  hasAnswerableDelegatedQuestion,
  projectInlineParentMessages,
  projectDelegatedQuestionQueue,
  projectSessionSubagents,
  resolveActiveRootMessageIds,
  resolveDelegatedWorkAvailability,
  selectSubagentFrame
}
export type {
  DelegatedWorkAvailability,
  InlineParentMessageProjection,
  SessionSubagentChild,
  SessionSubagentProjection,
  SubagentFrameProjection,
  SubagentRawStatus
}
