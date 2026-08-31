import { randomUUID } from 'node:crypto'

import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { SessionRuntimeContextRevisionConflictError } from '../session-persistence/coordinator'
import type { AttemptAgentEvent, DelegatedWorkRecordCommands, SessionKey } from './session-records'
import type {
  AuthenticatedDelegateCaller,
  DelegatedWorkDurableRecords,
  DurableSnapshot
} from './durable-delegated-work'
import type { StructuredOutputEvidence } from './structured-output'

type SessionRecordAdapterOptions = Readonly<{
  commands: DelegatedWorkRecordCommands
  readSession(key: SessionKey): Promise<PersistedChatSession | undefined>
  frameworkId: Parameters<DelegatedWorkRecordCommands['startAttemptRuntime']>[1]['frameworkId']
  createId?: (kind: 'branch') => string
  onRecordsChanged?: () => void
}>

const createSessionDelegatedWorkRecords = (
  options: SessionRecordAdapterOptions,
  key: SessionKey
): DelegatedWorkDurableRecords => {
  const createId = options.createId ?? ((kind: string) => `${kind}-${randomUUID()}`)
  const load = async (): Promise<PersistedChatSession> => {
    const session = await options.readSession(key)
    if (!session) throw new Error('Delegated Work Session is not durable.')
    return session
  }
  const revision = async (): Promise<number> => (await load()).runtimeContext?.revision ?? 0
  let mutationTail: Promise<void> = Promise.resolve()
  const mutate = <Result>(
    operation: (expectedRevision: number) => Promise<Result>
  ): Promise<Result> => {
    const pending = mutationTail.then(async () => {
      for (let retries = 0; ; retries += 1) {
        try {
          const result = await operation(await revision())
          try {
            options.onRecordsChanged?.()
          } catch {
            // The mutation is already durable. Projection notification failures must not make the
            // caller observe a false write failure or retry the committed operation.
          }
          return result
        } catch (error) {
          if (!(error instanceof SessionRuntimeContextRevisionConflictError) || retries >= 2) {
            throw error
          }
        }
      }
    })
    mutationTail = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  return {
    async admitChildren(input) {
      return mutate((expectedRevision) =>
        options.commands.createChildren(key, {
          expectedRevision,
          parentFrameId: input.caller.frameId,
          originMessageId: input.caller.originMessageId,
          children: input.children.map((child) => ({
            frameId: child.frameId,
            branchId: createId('branch'),
            messageId: child.userMessageId,
            attemptId: child.attemptId,
            task: child.request.task,
            name: child.name,
            inputs: child.request.inputs,
            resolvedAgent: child.resolvedAgent,
            ...(child.executionModel ? { executionModel: child.executionModel } : {}),
            startedAt: child.startedAt,
            callerSource: {
              rootMessageId: input.caller.originMessageId,
              toolInvocationId: input.caller.toolInvocationId
            },
            initiatingTurnMessageId: input.caller.originMessageId,
            ...(child.structuredOutputEvidence
              ? { structuredOutputEvidence: child.structuredOutputEvidence }
              : {})
          }))
        })
      )
    },
    async continueChild(input) {
      await mutate((expectedRevision) =>
        options.commands.startContinuationAttempt(key, {
          expectedRevision,
          frameId: input.frameId,
          previousAttemptId: input.previousAttemptId,
          attemptId: input.attemptId,
          messageId: input.userMessageId,
          message: input.message,
          resolvedAgent: input.resolvedAgent,
          ...(input.executionModel ? { executionModel: input.executionModel } : {}),
          startedAt: input.startedAt,
          callerSource: input.callerSource,
          initiatingTurnMessageId: input.initiatingTurnMessageId,
          messageCommand: input.messageCommand
        })
      )
    },
    async admitQuestion(request) {
      return mutate((expectedRevision) =>
        options.commands.admitQuestion(key, { expectedRevision, request })
      )
    },
    async updateQuestionDraft(requestId, draftAnswers, questionIndex) {
      await mutate((expectedRevision) =>
        options.commands.updateQuestionDraft(key, {
          expectedRevision,
          requestId,
          draftAnswers,
          questionIndex
        })
      )
    },
    async confirmQuestion(input) {
      await mutate((expectedRevision) =>
        options.commands.confirmQuestion(key, {
          expectedRevision,
          requestId: input.requestId,
          frameId: input.frameId,
          previousAttemptId: input.previousAttemptId,
          attemptId: input.attemptId,
          messageId: input.userMessageId,
          message: input.message,
          answers: input.answers,
          resolvedAgent: input.resolvedAgent,
          executionModel: input.executionModel,
          startedAt: input.startedAt,
          initiatingTurnMessageId: input.initiatingTurnMessageId
        })
      )
    },
    async cancelQuestions(frameId, endedAt, reason) {
      await mutate((expectedRevision) =>
        options.commands.cancelQuestions(key, {
          expectedRevision,
          frameId,
          endedAt,
          reason
        })
      )
    },
    async startRuntime(frameId, attemptId, runtimeSegmentId) {
      const attempt = (await load()).runtimeContext?.delegatedWork?.records
        .find((record) => record.agentFrameId === frameId)
        ?.attempts.find((candidate) => candidate.id === attemptId)
      await mutate((expectedRevision) =>
        options.commands.startAttemptRuntime(key, {
          expectedRevision,
          frameId,
          attemptId,
          runtimeSegmentId,
          frameworkId: attempt?.executionModel?.frameworkId ?? options.frameworkId,
          ...(attempt?.executionModel?.providerId
            ? { providerId: attempt.executionModel.providerId }
            : {}),
          ...(attempt?.executionModel
            ? {
                backendId: attempt.executionModel.backendId,
                model: attempt.executionModel.model
              }
            : {}),
          ...(attempt?.resolvedAgent.kind === 'specialist'
            ? { agentName: attempt.resolvedAgent.displayName }
            : {}),
          startedAt: attempt?.startedAt ?? Date.now()
        })
      )
      const session = await load()
      const graph = materializeSessionConversationGraph(session).conversationGraph
      const frame = graph?.frames.find((candidate) => candidate.id === frameId)
      const branch = graph?.branches.find((candidate) => candidate.id === frame?.activeBranchId)
      const promptMessage = graph?.messages.find(
        (message) => message.id === branch?.headMessageId && message.role === 'user'
      )
      if (!graph || !frame || !branch || !promptMessage) {
        throw new Error('Delegated runtime has no current Frame, Branch, or prompt Message.')
      }
      return {
        rootFrameId: graph.rootFrameId,
        messageBranchId: branch.id,
        promptMessageId: promptMessage.id,
        runtimeSegmentId
      }
    },
    async stageTerminalMessage(frameId, attemptId, message) {
      const attempt = (await load()).runtimeContext?.delegatedWork?.records
        .find((record) => record.agentFrameId === frameId)
        ?.attempts.find((candidate) => candidate.id === attemptId)
      await mutate((expectedRevision) =>
        options.commands.applyAgentEvent(key, {
          expectedRevision,
          frameId,
          attemptId,
          event: {
            kind: 'message',
            runtimeSegmentId: attempt?.runtimeSegmentIds.at(-1) ?? '',
            message: {
              id: message.id,
              role: 'agent',
              content: message.content,
              responseToMessageId: message.responseToMessageId,
              status: message.status ?? 'complete',
              eventIds: [...(message.eventIds ?? [])],
              images: message.images?.map((image) => ({ ...image })),
              turnUsage: message.turnUsage ? { ...message.turnUsage } : undefined,
              modelCallUsage: message.modelCallUsage?.map((call) => ({ ...call })),
              turnUsageUnavailable: message.turnUsageUnavailable,
              createdAt: message.createdAt,
              completedAt: message.completedAt ?? message.updatedAt ?? message.createdAt,
              updatedAt: message.updatedAt ?? message.createdAt
            }
          }
        })
      )
    },
    async stageTerminalActivities(
      frameId,
      attemptId,
      runtimeSegmentId,
      activities,
      activityGroups
    ) {
      const events: AttemptAgentEvent[] = []
      for (const activity of activities) {
        if (!activity.promptMessageId) continue
        events.push({
          kind: 'activity',
          runtimeSegmentId,
          promptMessageId: activity.promptMessageId,
          activity
        })
      }
      for (const activityGroup of activityGroups) {
        if (!activityGroup.promptMessageId) continue
        events.push({
          kind: 'activity-group',
          promptMessageId: activityGroup.promptMessageId,
          activityGroup
        })
      }
      if (events.length === 0) return
      await mutate((expectedRevision) =>
        options.commands.applyAgentEvent(key, {
          expectedRevision,
          frameId,
          attemptId,
          event: events
        })
      )
    },
    async terminalize(input) {
      if (input.status === 'completed') {
        const session = await load()
        const messageExists = session.conversationGraph?.messages.some(
          (message) => message.id === input.terminalMessage.id
        )
        const attempt = session.runtimeContext?.delegatedWork?.records
          .find((record) => record.agentFrameId === input.frameId)
          ?.attempts.find((candidate) => candidate.id === input.attemptId)
        if (!messageExists) {
          await mutate((expectedRevision) =>
            options.commands.applyAgentEvent(key, {
              expectedRevision,
              frameId: input.frameId,
              attemptId: input.attemptId,
              event: {
                kind: 'message',
                runtimeSegmentId: attempt?.runtimeSegmentIds.at(-1) ?? '',
                message: {
                  id: input.terminalMessage.id,
                  role: 'agent',
                  content: input.terminalMessage.content,
                  responseToMessageId: input.terminalMessage.responseToMessageId,
                  status: input.terminalMessage.status ?? 'complete',
                  eventIds: [...(input.terminalMessage.eventIds ?? [])],
                  images: input.terminalMessage.images?.map((image) => ({ ...image })),
                  turnUsage: input.terminalMessage.turnUsage
                    ? { ...input.terminalMessage.turnUsage }
                    : undefined,
                  modelCallUsage: input.terminalMessage.modelCallUsage?.map((call) => ({
                    ...call
                  })),
                  turnUsageUnavailable: input.terminalMessage.turnUsageUnavailable,
                  createdAt: input.terminalMessage.createdAt,
                  completedAt:
                    input.terminalMessage.completedAt ??
                    input.terminalMessage.updatedAt ??
                    input.terminalMessage.createdAt,
                  updatedAt: input.terminalMessage.updatedAt ?? input.terminalMessage.createdAt
                }
              }
            })
          )
        }
      }
      await mutate((expectedRevision) =>
        options.commands.transitionAttempt(key, {
          expectedRevision,
          frameId: input.frameId,
          attemptId: input.attemptId,
          status: input.status,
          endedAt: input.endedAt,
          ...(input.status === 'completed'
            ? { terminalMessageId: input.terminalMessage.id }
            : input.status === 'cancelled'
              ? { cancellationReason: input.cancellationReason }
              : { error: input.error })
        })
      )
    },
    async admitMessage(command) {
      return mutate((expectedRevision) =>
        options.commands.admitMessageCommand(key, { expectedRevision, command })
      )
    },
    async markMessageDispatchStarted(
      messageId,
      dispatchStartedAt,
      dispatchEpoch,
      rootBranchId,
      rootBranchRevision
    ) {
      return mutate((expectedRevision) =>
        options.commands.startMessageDispatch(key, {
          expectedRevision,
          messageId,
          dispatchStartedAt,
          dispatchEpoch,
          rootBranchId,
          rootBranchRevision
        })
      )
    },
    async settleMessage(messageId, receipt) {
      return mutate((expectedRevision) =>
        options.commands.settleMessage(key, { expectedRevision, messageId, receipt })
      )
    },
    async acknowledgeUncertain(messageId) {
      return mutate((expectedRevision) =>
        options.commands.acknowledgeUncertainMessage(key, { expectedRevision, messageId })
      )
    },
    async startPendingTurn(
      frameId,
      attemptId,
      pendingMessageId,
      promptMessageId,
      runtimeSegmentId
    ) {
      const snapshot = await load()
      const pending = snapshot.runtimeContext?.delegatedWork?.messageCommands?.find(
        ({ messageId }) => messageId === pendingMessageId
      )
      const attempt = snapshot.runtimeContext?.delegatedWork?.records
        .find((record) => record.agentFrameId === frameId)
        ?.attempts.find((candidate) => candidate.id === attemptId)
      await mutate((expectedRevision) =>
        options.commands.startPendingMessageTurn(key, {
          expectedRevision,
          frameId,
          attemptId,
          pendingMessageId,
          promptMessageId,
          runtimeSegmentId,
          frameworkId: options.frameworkId,
          ...(attempt?.executionModel?.providerId
            ? { providerId: attempt.executionModel.providerId }
            : {}),
          startedAt: pending?.queuedAt ?? Date.now()
        })
      )
      const session = await load()
      const graph = materializeSessionConversationGraph(session).conversationGraph
      const frame = graph?.frames.find(({ id }) => id === frameId)
      const branch = graph?.branches.find(({ id }) => id === frame?.activeBranchId)
      if (!graph || !frame || !branch) throw new Error('Pending child Turn is not durable.')
      return {
        rootFrameId: graph.rootFrameId,
        messageBranchId: branch.id,
        promptMessageId,
        runtimeSegmentId
      }
    },
    async completeTurn(frameId, attemptId, runtimeSegmentId, endedAt) {
      await mutate((expectedRevision) =>
        options.commands.completeChildTurn(key, {
          expectedRevision,
          frameId,
          attemptId,
          runtimeSegmentId,
          endedAt
        })
      )
    },
    async submitOutput(frameId, attemptId, schemaDigest, value, acceptedAt) {
      return mutate((expectedRevision) =>
        options.commands.submitStructuredOutput(key, {
          expectedRevision,
          frameId,
          attemptId,
          schemaDigest,
          value,
          acceptedAt
        })
      )
    },
    async snapshot(): Promise<DurableSnapshot> {
      const session = await load()
      const graph = materializeSessionConversationGraph(session).conversationGraph
      if (!graph) throw new Error('Delegated Work Session has no Conversation Graph.')
      const records = session.runtimeContext?.delegatedWork?.records ?? []
      const rootMessages = resolveActiveConversationMessages({
        ...graph,
        activeFrameId: graph.rootFrameId
      })
      const rootFrame = graph.frames.find(({ id }) => id === graph.rootFrameId)
      const rootBranch = graph.branches.find(({ id }) => id === rootFrame?.activeBranchId)
      if (!rootBranch) throw new Error('Delegated Work Session has no active root Branch.')
      return {
        session: key,
        rootFrameId: graph.rootFrameId,
        rootBranchId: rootBranch.id,
        rootBranchRevision: `${rootBranch.id}:${rootBranch.createdAt}`,
        originMessageIds: rootMessages.map((message) => message.id),
        records: records.flatMap((record) => {
          const frame = graph.frames.find((candidate) => candidate.id === record.agentFrameId)
          const firstMessage = graph.messages.find(
            (message) => message.agentFrameId === record.agentFrameId && message.role === 'user'
          )
          if (!frame || !firstMessage) return []
          return [
            {
              frameId: frame.id,
              parentFrameId: frame.parentFrameId ?? '',
              originMessageId: frame.originMessageId ?? '',
              originBindingState:
                frame.originBindingState === 'validated' ? 'validated' : 'legacy-unavailable',
              title: frame.delegateName ?? frame.agentName ?? frame.id,
              task: firstMessage.delegatedTask ?? firstMessage.content,
              outputSchema: firstMessage.structuredOutputEvidence?.schema as
                import('./structured-output').JsonSchema | undefined,
              inputs: firstMessage.delegatedInputVersionIds ?? [],
              messageBranchId: frame.activeBranchId,
              attempts: record.attempts.map((attempt) => ({
                ...attempt,
                resolvedAgent: structuredClone(attempt.resolvedAgent),
                ...(attempt.executionModel
                  ? { executionModel: structuredClone(attempt.executionModel) }
                  : {}),
                runtimeSegmentIds: [...attempt.runtimeSegmentIds]
              }))
            }
          ]
        }),
        messages: graph.messages
          .filter((message) => graph.frames.some((frame) => frame.id === message.agentFrameId))
          .map((message) => ({
            id: message.id,
            frameId: message.agentFrameId,
            role: message.role === 'agent' ? 'assistant' : 'user',
            content: message.content,
            responseToMessageId: message.responseToMessageId,
            runtimeSegmentId: message.runtimeSegmentId,
            createdAt: message.createdAt,
            ...(message.structuredOutputEvidence
              ? {
                  structuredOutputEvidence: structuredClone(
                    message.structuredOutputEvidence
                  ) as StructuredOutputEvidence
                }
              : {}),
            ...(message.structuredOutputEvidenceInvalid
              ? { structuredOutputEvidenceInvalid: true as const }
              : {})
          })),
        messageCommands: structuredClone(
          session.runtimeContext?.delegatedWork?.messageCommands ?? []
        ),
        ...(session.runtimeContext?.delegatedWork?.messageCommandsQuarantine !== undefined
          ? { messageCommandsQuarantined: true as const }
          : {}),
        questionRequests: structuredClone(
          session.runtimeContext?.delegatedWork?.questionRequests ?? []
        ),
        ...(session.runtimeContext?.delegatedWork?.questionRequestsQuarantine !== undefined
          ? { questionRequestsQuarantined: true as const }
          : {})
      }
    }
  }
}

const assertAuthenticatedRootCaller = async (
  records: DelegatedWorkDurableRecords,
  caller: AuthenticatedDelegateCaller
): Promise<void> => {
  const snapshot = await records.snapshot()
  if (
    caller.role !== 'main' ||
    caller.frameId !== snapshot.rootFrameId ||
    !snapshot.originMessageIds.includes(caller.originMessageId)
  ) {
    throw new Error('Delegation caller is outside the authenticated active root conversation.')
  }
}

export { assertAuthenticatedRootCaller, createSessionDelegatedWorkRecords }
export type { SessionRecordAdapterOptions }
