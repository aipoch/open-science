import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type { AcpPromptRequest } from '../../shared/acp'
import {
  getActiveConversationContext,
  type PersistedConversationGraph,
  resolveActiveConversationActivities,
  resolveMessageBranchPath
} from '../../shared/conversation-graph'
import type { ElicitationAnswer, PendingElicitationRequest } from '../../shared/elicitation'
import type { HistoryReplayDescriptor } from '../../shared/history-preamble'
import {
  buildSessionHistoryReplay,
  type SessionHistoryReplay
} from '../../shared/session-history-replay'
import {
  sanitizeSessionReferences,
  type PersistedChatSession
} from '../../shared/session-persistence'
import type { SessionCatalog, SessionMutation } from '../session-persistence/coordinator'
import { validateElicitationAnswers } from './elicitation-owner'

type DurableContinuationSessions = Pick<SessionCatalog, 'loadSessionForContinuation'> &
  Partial<SessionMutation>

type DurableContinuationPreparation = Readonly<{
  provenanceContext: NonNullable<AcpPromptRequest['provenanceContext']>
  memoryEnabled: boolean
  referencedSessions?: AcpPromptRequest['referencedSessions']
  historyReplay?: SessionHistoryReplay
}>

type DurableElicitationContinuationPreparation = Readonly<{
  request: PendingElicitationRequest
  provenanceContext?: DurableContinuationPreparation['provenanceContext']
  memoryEnabled?: boolean
  referencedSessions?: DurableContinuationPreparation['referencedSessions']
  historyReplay?: SessionHistoryReplay
}>

type DurableContinuationReplay = {
  descriptor: HistoryReplayDescriptor
  supportsImageInput: boolean
}

type PublishDurableContinuationSession = (session: PersistedChatSession) => Promise<void> | void

const isActivityVisibleOnBranch = (
  graph: PersistedConversationGraph,
  frameId: string,
  branchId: string,
  activityId: string
): boolean => {
  const candidate = structuredClone(graph)
  const frame = candidate.frames.find((item) => item.id === frameId)
  if (!frame) return false
  candidate.activeFrameId = frame.id
  frame.activeBranchId = branchId
  try {
    return resolveActiveConversationActivities(candidate).activities.some(
      (activity) => activity.id === activityId
    )
  } catch {
    return false
  }
}

class AcpDurableContinuationContextOwner {
  constructor(
    private readonly sessions?: DurableContinuationSessions,
    private readonly publishSessionUpdated?: PublishDurableContinuationSession
  ) {}

  async prepare(input: {
    projectId: string
    sessionId: string
    promptMessageId: string
    replay?: DurableContinuationReplay
  }): Promise<DurableContinuationPreparation> {
    const session = await this.loadSession(input.projectId, input.sessionId)
    return this.prepareFromSession(session, input.promptMessageId, input.replay)
  }

  async prepareElicitation(input: {
    projectId: string
    sessionId: string
    requestId: string
    toolCallId: string
    action: 'accept' | 'decline' | 'cancel'
    answers?: ElicitationAnswer[]
    replacePreviousAnswer?: boolean
    replay?: DurableContinuationReplay
  }): Promise<DurableElicitationContinuationPreparation> {
    const session = await this.loadSession(input.projectId, input.sessionId)
    if (input.replacePreviousAnswer) {
      return this.prepareElicitationRevision(session, input)
    }
    const authority = this.resolvePendingElicitation(session, input)
    const continuation = this.prepareFromSession(session, authority.promptMessageId, input.replay)
    return {
      ...continuation,
      request: this.canonicalRequest(session.id, authority)
    }
  }

  private resolvePendingElicitation(
    session: PersistedChatSession,
    input: Pick<
      Parameters<AcpDurableContinuationContextOwner['prepareElicitation']>[0],
      'requestId' | 'toolCallId'
    >
  ): {
    activityId: string
    message: string
    fields: PendingElicitationRequest['fields']
    durable: NonNullable<PendingElicitationRequest['durable']>
    promptMessageId: string
  } {
    const graph = session.conversationGraph
    if (!graph || session.status !== 'waiting-for-user') {
      throw new Error('Durable elicitation no longer matches the pending Session activity.')
    }
    const visible = resolveActiveConversationActivities(graph).activities.filter(
      (activity) =>
        activity.elicitation?.state === 'pending' &&
        activity.elicitation.durable?.kind === 'agent-user-choice' &&
        activity.elicitation.durable.requestId === input.requestId
    )
    const activity =
      visible.length === 1 && visible[0].id === input.toolCallId ? visible[0] : undefined
    const graphActivity = activity
      ? graph.activities.find((candidate) => candidate.id === activity.id)
      : undefined
    const flatMatches = activity
      ? (session.activities ?? []).filter((candidate) => candidate.id === activity.id)
      : []
    const flatActivity = flatMatches.length === 1 ? flatMatches[0] : undefined
    if (
      !activity ||
      !graphActivity ||
      !flatActivity ||
      !isDeepStrictEqual(flatActivity.elicitation, activity.elicitation) ||
      (flatActivity.promptMessageId !== undefined &&
        flatActivity.promptMessageId !== graphActivity.promptMessageId) ||
      flatActivity.title !== activity.title ||
      flatActivity.status !== activity.status ||
      flatActivity.sortIndex !== activity.sortIndex
    ) {
      throw new Error('Durable elicitation no longer matches the pending Session activity.')
    }
    const projection = graphActivity.elicitation!
    const durable = projection.durable!
    const promptMessageId = graphActivity.promptMessageId
    if (durable.promptMessageId && durable.promptMessageId !== promptMessageId) {
      throw new Error('Durable elicitation has inconsistent prompt authority.')
    }
    return {
      activityId: graphActivity.id,
      message: projection.message,
      fields: projection.fields,
      durable,
      promptMessageId
    }
  }

  private async prepareElicitationRevision(
    session: PersistedChatSession,
    input: Parameters<AcpDurableContinuationContextOwner['prepareElicitation']>[0]
  ): Promise<DurableElicitationContinuationPreparation> {
    const authority = this.resolveElicitationRevision(session, input.requestId)
    const toolCallId = `ask-user-question-revision-${randomUUID()}`
    const originalRequest = this.canonicalRequest(session.id, {
      ...authority,
      activityId: toolCallId
    })
    if (input.action === 'cancel') return { request: originalRequest }
    const answers =
      input.action === 'accept'
        ? validateElicitationAnswers(originalRequest, input.answers)
        : undefined
    if (!this.sessions?.appendUserMessageToInteraction) {
      throw new Error('Durable elicitation revision authority is not available.')
    }
    const message = await this.sessions.appendUserMessageToInteraction({
      projectId: input.projectId,
      sessionId: input.sessionId,
      interactionId: authority.interactionId,
      content: this.revisionPromptContent(originalRequest, input.action, answers),
      beforePersist: (latest) => {
        const current = this.resolveElicitationRevision(latest, input.requestId)
        if (!isDeepStrictEqual(current, authority)) {
          throw new Error('Durable elicitation revision authority changed before commit.')
        }
      }
    })
    const continuedSession = await this.loadSession(input.projectId, input.sessionId)
    const continuation = this.prepareFromSession(continuedSession, message.id, input.replay)
    await this.publishSessionUpdated?.(structuredClone(continuedSession))
    return {
      ...continuation,
      request: {
        ...originalRequest,
        durable: { ...originalRequest.durable!, promptMessageId: message.id }
      }
    }
  }

  private resolveElicitationRevision(
    session: PersistedChatSession,
    requestId: string
  ): {
    activityId: string
    branchId: string
    interactionId: string
    message: string
    fields: PendingElicitationRequest['fields']
    durable: NonNullable<PendingElicitationRequest['durable']>
    promptMessageId: string
  } {
    const graph = session.conversationGraph
    const frame = graph?.frames.find((candidate) => candidate.id === graph.activeFrameId)
    const branch = graph?.branches.find((candidate) => candidate.id === frame?.activeBranchId)
    const parentBranch = graph?.branches.find(
      (candidate) => candidate.id === branch?.parentBranchId
    )
    const activity = branch?.forkActivityId
      ? graph?.activities.find((candidate) => candidate.id === branch.forkActivityId)
      : undefined
    const projection = activity?.elicitation
    const durable = projection?.durable
    const parentPath = graph && parentBranch ? resolveMessageBranchPath(graph, parentBranch.id) : []
    const prompt = activity
      ? parentPath.find((candidate) => candidate.id === activity.promptMessageId)
      : undefined
    const runtimeSegment = activity
      ? graph?.runtimeSegments.find((candidate) => candidate.id === activity.runtimeSegmentId)
      : undefined
    const activityVisibleOnParent =
      graph && frame && parentBranch && activity
        ? isActivityVisibleOnBranch(graph, frame.id, parentBranch.id, activity.id)
        : false
    if (
      !graph ||
      session.status !== 'idle' ||
      !frame ||
      !branch?.forkActivityId ||
      !branch.forkMessageId ||
      branch.headMessageId !== branch.forkMessageId ||
      !parentBranch ||
      parentBranch.agentFrameId !== frame.id ||
      !activity ||
      activity.agentFrameId !== frame.id ||
      !activityVisibleOnParent ||
      !prompt ||
      prompt.role !== 'user' ||
      prompt.status !== 'complete' ||
      prompt.agentFrameId !== frame.id ||
      prompt.runtimeSegmentId !== activity.runtimeSegmentId ||
      !runtimeSegment ||
      runtimeSegment.agentFrameId !== frame.id ||
      projection?.state !== 'answered' ||
      durable?.kind !== 'agent-user-choice' ||
      durable.requestId !== requestId ||
      durable.promptMessageId !== activity.promptMessageId ||
      (session.activities ?? []).some((candidate) => candidate.id === activity.id)
    ) {
      throw new Error('Durable elicitation revision no longer matches the active Session Branch.')
    }
    return {
      activityId: activity.id,
      branchId: branch.id,
      interactionId: branch.forkMessageId,
      message: projection.message,
      fields: projection.fields,
      durable,
      promptMessageId: activity.promptMessageId
    }
  }

  private canonicalRequest(
    sessionId: string,
    authority: {
      activityId: string
      message: string
      fields: PendingElicitationRequest['fields']
      durable: NonNullable<PendingElicitationRequest['durable']>
      promptMessageId: string
    }
  ): PendingElicitationRequest {
    return {
      requestId: authority.durable.requestId,
      sessionId,
      toolCallId: authority.activityId,
      message: authority.message,
      fields: structuredClone(authority.fields),
      durable: { ...structuredClone(authority.durable), promptMessageId: authority.promptMessageId }
    }
  }

  private revisionPromptContent(
    request: PendingElicitationRequest,
    action: 'accept' | 'decline',
    answers?: ElicitationAnswer[]
  ): string {
    if (action === 'decline')
      return 'The user revised the previous structured answer by declining it.'
    const fields = new Map(request.fields.map((field) => [field.id, field]))
    const lines = (answers ?? []).map((answer) => {
      const value = Array.isArray(answer.value) ? answer.value.join(', ') : String(answer.value)
      return `${fields.get(answer.fieldId)?.label ?? answer.fieldId}: ${value}`
    })
    return ['The user revised the previous structured answer:', ...lines].join('\n')
  }

  private async loadSession(projectId: string, sessionId: string): Promise<PersistedChatSession> {
    if (!this.sessions) throw new Error('Durable continuation Session authority is not available.')
    const session = await this.sessions.loadSessionForContinuation(projectId, sessionId)
    if (session.id !== sessionId || session.projectId !== projectId) {
      throw new Error('Durable continuation Session identity does not match its authority.')
    }
    return session
  }

  private prepareFromSession(
    session: PersistedChatSession,
    promptMessageId: string,
    replay?: DurableContinuationReplay
  ): DurableContinuationPreparation {
    const graph = session.conversationGraph
    const activeFrame = graph?.frames.find((frame) => frame.id === graph.activeFrameId)
    const activeBranch = graph?.branches.find((branch) => branch.id === activeFrame?.activeBranchId)
    const prompt =
      graph && activeFrame
        ? resolveMessageBranchPath(graph, activeFrame.activeBranchId).find(
            (message) => message.id === promptMessageId
          )
        : undefined
    if (
      !graph ||
      !activeFrame ||
      !activeBranch ||
      prompt?.role !== 'user' ||
      prompt.status !== 'complete' ||
      prompt.agentFrameId !== activeFrame.id ||
      prompt.introducedOnBranchId !== activeBranch.id ||
      !prompt.runtimeSegmentId
    ) {
      throw new Error('Durable continuation no longer matches the active Message Branch.')
    }

    const referencedSessions = sanitizeSessionReferences(prompt.parts)
    return {
      provenanceContext: getActiveConversationContext(graph, promptMessageId),
      memoryEnabled: session.memoryEnabled !== false,
      ...(referencedSessions.length > 0 ? { referencedSessions } : {}),
      ...(replay
        ? {
            historyReplay: buildSessionHistoryReplay(
              session.messages,
              replay.descriptor,
              session.projectId,
              replay.supportsImageInput
            )
          }
        : {})
    }
  }
}

export { AcpDurableContinuationContextOwner }
export type {
  DurableContinuationPreparation,
  DurableContinuationSessions,
  DurableElicitationContinuationPreparation
}
